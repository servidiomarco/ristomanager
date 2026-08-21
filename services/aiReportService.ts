// Report della dashboard: una lettura in italiano dell'andamento del locale.
//
// La versione precedente (Gemini, lato browser) mandava al modello dieci
// prenotazioni grezze in JSON e chiedeva "consigli da consulente": produceva
// paragrafi generici che andavano bene per qualsiasi ristorante, cioè per
// nessuno. Qui il calcolo lo fa Postgres e il modello riceve solo numeri già
// aggregati e confrontati col periodo precedente — il suo lavoro è spiegarli,
// non indovinarli.
//
// Gira sul backend: la chiave non attraversa mai il browser.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';
// Il report è lungo qualche paragrafo, ma il ragionamento attinge allo stesso
// budget: stretto qui significa troncare a metà frase.
const MAX_TOKEN = 4096;
// Sforzo medio: qui si tratta di leggere numeri e trovare quello che conta,
// non di scegliere fra strumenti. Vale la spesa in più rispetto a "low".
const SFORZO = 'medium' as const;

export interface ReportPeriodo {
    prenotazioni: number;
    coperti: number;
    bambini: number;
    cancellate: number;
    no_show: number;
}

export interface ReportData {
    giorni: number;
    periodo: ReportPeriodo;
    precedente: ReportPeriodo;
    /** Coperti per giorno della settimana, 0 = domenica. */
    per_giorno: Array<{ giorno: number; prenotazioni: number; coperti: number }>;
    /** Coperti per ora di arrivo. */
    per_ora: Array<{ ora: number; prenotazioni: number; coperti: number }>;
    per_canale: Array<{ canale: string; prenotazioni: number }>;
    per_sala: Array<{ sala: string; prenotazioni: number; coperti: number }>;
    posti_totali: number;
    restaurantName?: string;
}

export interface ReportUsage {
    model: string;
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
}

export class AiReportError extends Error {
    constructor(message: string, public readonly kind: 'not_configured' | 'no_data' | 'upstream') {
        super(message);
        this.name = 'AiReportError';
    }
}

export function isReportConfigured(): boolean {
    return Boolean((process.env.ANTHROPIC_API_KEY || '').trim());
}

const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

const variazione = (ora: number, prima: number): string => {
    if (prima === 0) return ora === 0 ? 'invariato' : 'nessun dato nel periodo precedente';
    const pct = Math.round(((ora - prima) / prima) * 100);
    return `${pct >= 0 ? '+' : ''}${pct}% rispetto ai ${prima}`;
};

function buildPrompt(d: ReportData): string {
    const p = d.periodo, q = d.precedente;
    const occupazione = d.posti_totali > 0
        ? Math.round((p.coperti / (d.posti_totali * d.giorni * 2)) * 100)
        : null;

    return `PERIODO: ultimi ${d.giorni} giorni.

VOLUMI
- Prenotazioni: ${p.prenotazioni} (${variazione(p.prenotazioni, q.prenotazioni)})
- Coperti: ${p.coperti} (${variazione(p.coperti, q.coperti)})
- Di cui bambini: ${p.bambini}
- Media coperti per prenotazione: ${p.prenotazioni ? (p.coperti / p.prenotazioni).toFixed(1) : '0'}
${occupazione !== null ? `- Riempimento stimato: ${occupazione}% dei posti disponibili (${d.posti_totali} coperti × ${d.giorni} giorni × 2 turni)` : ''}

MANCATE PRESENZE
- Cancellate: ${p.cancellate} (${variazione(p.cancellate, q.cancellate)})
- No-show: ${p.no_show} (${variazione(p.no_show, q.no_show)})

COPERTI PER GIORNO DELLA SETTIMANA
${d.per_giorno.map(g => `- ${GIORNI[g.giorno]}: ${g.coperti} coperti in ${g.prenotazioni} prenotazioni`).join('\n')}

COPERTI PER ORA DI ARRIVO
${d.per_ora.map(o => `- ${String(o.ora).padStart(2, '0')}:00 → ${o.coperti} coperti (${o.prenotazioni} prenotazioni)`).join('\n')}

CANALE DI PRENOTAZIONE
${d.per_canale.map(c => `- ${c.canale}: ${c.prenotazioni}`).join('\n')}

SALE
${d.per_sala.map(s => `- ${s.sala}: ${s.coperti} coperti in ${s.prenotazioni} prenotazioni`).join('\n')}`;
}

const SYSTEM = (nome: string) => `Scrivi il report di andamento per chi gestisce il ristorante "${nome}". Legge dal telefono, fra un servizio e l'altro.

COSA DEVE USCIRNE, in Markdown, massimo 250 parole:
- **In sintesi**: due o tre frasi su come sta andando. La prima frase risponde a "come stiamo andando?", non fa da introduzione.
- **Da guardare**: da due a quattro punti elenco, ognuno ancorato a un numero preciso dei dati.
- **Cosa proverei**: una o due azioni concrete, che si possano fare la settimana prossima.

REGOLE:
- Usa SOLO i numeri che ti vengono dati. Non stimare, non arrotondare a caso, non inventare confronti che non ci sono.
- Cita il numero quando fai un'affermazione: "il venerdì porta 180 coperti contro i 90 del martedì", non "il weekend va meglio".
- Se un dato non permette una conclusione, dillo invece di riempire lo spazio.
- Niente complimenti allo staff, niente frasi motivazionali, niente "in conclusione". Chi legge vuole sapere cosa succede e cosa fare.
- Italiano, dando del tu.`;

export async function generateDashboardReport(
    data: ReportData,
    onUsage?: (u: ReportUsage) => void
): Promise<string> {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) throw new AiReportError('ANTHROPIC_API_KEY non configurata sul backend', 'not_configured');
    if (data.periodo.prenotazioni === 0) {
        throw new AiReportError('Nessuna prenotazione nel periodo: non c\'è niente da analizzare', 'no_data');
    }

    let response: Anthropic.Message;
    try {
        const client = new Anthropic({ apiKey });
        response = await client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKEN,
            output_config: { effort: SFORZO },
            system: SYSTEM(data.restaurantName || 'il ristorante'),
            messages: [{ role: 'user', content: buildPrompt(data) }],
        });
    } catch (err: any) {
        throw new AiReportError(err?.message || 'Errore dal modello', 'upstream');
    }

    if (onUsage) {
        onUsage({
            model: MODEL,
            promptTokens: response.usage.input_tokens ?? 0,
            outputTokens: response.usage.output_tokens ?? 0,
            totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
        });
    }

    if (response.stop_reason === 'refusal') {
        throw new AiReportError('Il modello ha rifiutato di generare il report', 'upstream');
    }

    const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();
    if (!text) throw new AiReportError('Il modello non ha prodotto testo', 'upstream');
    return text;
}
