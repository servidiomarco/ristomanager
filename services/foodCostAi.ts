// Food cost — bozza della scheda tecnica scritta dall'AI.
//
// Dal nome e dalla descrizione di un piatto (o di un semilavorato) il modello
// propone ingredienti e grammature nette, pescando dagli ingredienti che il
// ristorante ha già. È una PROPOSTA: l'editor la mostra, lo chef corregge e
// salva, e solo allora diventa una scheda. Qui non si scrive niente, e i
// conti restano quelli di utils/foodCost.ts — il modello non dà mai un costo.
//
// Una chiamata può portare più richieste (le bozze in blocco); l'elenco degli
// ingredienti sta nel system, in cache, perché è lo stesso per ogni lotto.
//
// Gira sul backend: la chiave non attraversa mai il browser.

import Anthropic from '@anthropic-ai/sdk';
import type { UnitaCosto } from '../utils/foodCost.js';

export const FOOD_COST_AI_MODEL = 'claude-opus-5-5';
// Una scheda sono poche righe; il ragionamento attinge allo stesso budget.
// Il tetto resta sotto quello che l'SDK accetta senza streaming (circa 21
// mila token: oltre, rifiuta la chiamata prima di farla).
const TOKEN_PER_SCHEDA = 3000;
const TOKEN_MASSIMI = 16_000;
// Riconoscere un ingrediente con un altro nome chiede attenzione, non un
// ragionamento lungo: lo sforzo scritto per esteso perché non cambi sotto i
// piedi con il prossimo modello.
const SFORZO = 'medium' as const;
const RIGHE_MASSIME = 40;
const AVVISI_MASSIMI = 10;
// Oltre questi numeri per porzione è un errore di unità (kg scritti come g),
// non una ricetta.
const MAX_PESO_PORZIONE = 5000;
const MAX_PEZZI_PORZIONE = 100;
// Un lotto di semilavorato: la pentola di ragù, non il magazzino.
const MAX_PESO_LOTTO = 200_000;
const MAX_PEZZI_LOTTO = 5000;

export interface IngredienteAi {
    id: number;
    nome: string;
    area: string;
    unitaCosto: UnitaCosto | null;
    isPreparazione: boolean;
}

export interface EsempioScheda {
    nome: string;
    categoria: string | null;
    porzioni: number;
    righe: { ingrediente: string; quantita: number; unita: 'g' | 'ml' | 'pz' }[];
}

export type RichiestaBozza =
    | {
        chiave: string;
        tipo: 'piatto';
        nome: string;
        descrizione: string | null;
        categoria: string | null;
        prezzo: number;
        alPeso: boolean;
        porzioni: number;
        componenti: string[];
    }
    | {
        chiave: string;
        tipo: 'semilavorato';
        productId: number;
        nome: string;
        unitaCosto: UnitaCosto | null;
    };

export interface RigaBozza {
    /** L'ingrediente del ristorante, o null per uno nuovo da creare. */
    productId: number | null;
    /** Il nome proposto per l'ingrediente nuovo. */
    nomeNuovo: string | null;
    /** L'unità di costo che la quantità presuppone: kg → g, l → ml, pz → pz. */
    unita: UnitaCosto;
    quantita: number;
    nota: string | null;
}

export interface BozzaScheda {
    righe: RigaBozza[];
    /** Solo per i semilavorati: quanto rende il lotto, nell'unità di resaUnita. */
    resaQuantita: number | null;
    resaUnita: UnitaCosto | null;
    avvisi: string[];
}

export interface FoodCostAiUsage {
    model: string;
    promptTokens: number;
    outputTokens: number;
}

export class FoodCostAiError extends Error {
    constructor(message: string, public readonly kind: 'not_configured' | 'refused' | 'upstream') {
        super(message);
        this.name = 'FoodCostAiError';
    }
}

export function isFoodCostAiConfigured(): boolean {
    return Boolean((process.env.ANTHROPIC_API_KEY || '').trim());
}

const DA_QUANTITA: Record<string, UnitaCosto> = { g: 'kg', ml: 'l', pz: 'pz' };
const A_QUANTITA: Record<UnitaCosto, 'g' | 'ml' | 'pz'> = { kg: 'g', l: 'ml', pz: 'pz' };

/** Confronto senza maiuscole né accenti: «pomodoro» trova «Pomodóro». */
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const text = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s ? s.slice(0, max) : null;
};

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

// Con l'output strutturato il JSON arriva sempre valido e completo: la forma è
// garantita, il contenuto lo ripulisce normalizzaBozza.
const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        schede: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    chiave: { type: 'string' },
                    righe: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                ingrediente_id: nullable({ type: 'integer' }),
                                nuovo_ingrediente: nullable({ type: 'string' }),
                                unita: { type: 'string', enum: ['g', 'ml', 'pz'] },
                                quantita: { type: 'number' },
                                nota: nullable({ type: 'string' }),
                            },
                            required: ['ingrediente_id', 'nuovo_ingrediente', 'unita', 'quantita', 'nota'],
                        },
                    },
                    resa_quantita: nullable({ type: 'number' }),
                    resa_unita: nullable({ type: 'string', enum: ['g', 'ml', 'pz'] }),
                    avvisi: { type: 'array', items: { type: 'string' } },
                },
                required: ['chiave', 'righe', 'resa_quantita', 'resa_unita', 'avvisi'],
            },
        },
    },
    required: ['schede'],
};

const ISTRUZIONI = `Sei lo chef di un ristorante italiano e scrivi le schede tecniche (distinte base) dei piatti, per calcolarne il food cost. Il costo lo calcola il programma: tu scrivi solo ingredienti e quantità.

REGOLE:
- Quantità NETTE: quello che finisce nel piatto dopo pulizia e scarti. Lo scarto lo applica già il programma con la resa dell'ingrediente.
- Unità: g per ciò che si pesa, ml per i liquidi, pz per ciò che si conta (uova, bottiglie). Se l'ingrediente ha già un'unità di costo, usa la sua: kg → g, l → ml, pz → pz.
- Usa gli ingredienti dell'elenco, citati per ingrediente_id, ogni volta che corrispondono, anche se il nome è diverso («pelati» è «Pomodori pelati»). Mai id che non sono nell'elenco.
- Se un ingrediente manca, proponilo in nuovo_ingrediente con ingrediente_id null e un nome breve e generico da magazzino: «Guanciale», non «Guanciale di Amatrice DOP 1 kg».
- I semilavorati dell'elenco (ragù, fondi, besciamella, impasti) si usano come un ingrediente quando il piatto li contiene.
- Acqua e sale restano fuori, senza dirlo negli avvisi. Spezie, erbe, olio e grassi di cottura si contano, con la loro dose anche se piccola.
- Piatto: quantità per il numero di porzioni indicato. Venduto al peso: quantità per 1 kg di prodotto venduto.
- Semilavorato: la ricetta di un lotto tipico per la cucina di un ristorante, e in resa_quantita e resa_unita quanto rende il lotto (in g, ml o pz). Per un piatto resa_quantita e resa_unita sono null.
- Prodotti comprati già finiti (acqua, bibite, vino, birra, caffè, dolci confezionati): nessuna riga, e un avviso che suggerisce di scrivere il costo a mano.
- Se il nome non basta a capire la ricetta, scrivi la versione più tipica e dillo negli avvisi.
- Le schede già fatte dal ristorante, se ci sono, dicono le sue grammature: seguile.
- avvisi: note brevi in italiano, solo quando servono. nota della riga: solo se aiuta («per la mantecatura»).
- Una scheda per ogni richiesta, con la stessa chiave.`;

function buildSystem(ingredienti: IngredienteAi[], esempi: EsempioScheda[]): Anthropic.Beta.BetaTextBlockParam[] {
    const elenco = ingredienti.map(i => JSON.stringify({
        id: i.id,
        nome: i.nome,
        area: i.area,
        ...(i.unitaCosto ? { unita_costo: i.unitaCosto } : {}),
        ...(i.isPreparazione ? { semilavorato: true } : {}),
    })).join('\n');
    const blocchi: Anthropic.Beta.BetaTextBlockParam[] = [{
        type: 'text',
        text: `${ISTRUZIONI}\n\nINGREDIENTI DEL RISTORANTE (uno per riga):\n${elenco || '(nessuno: proponi tutti gli ingredienti come nuovi)'}`,
    }];
    if (esempi.length > 0) {
        blocchi.push({
            type: 'text',
            text: `SCHEDE GIÀ FATTE DAL RISTORANTE:\n${esempi.map(e => JSON.stringify(e)).join('\n')}`,
        });
    }
    // Il punto di cache sull'ultimo blocco fisso: le bozze in blocco mandano
    // lo stesso system a ogni lotto e lo pagano una volta.
    blocchi[blocchi.length - 1].cache_control = { type: 'ephemeral' };
    return blocchi;
}

const richiestaPerModello = (r: RichiestaBozza) => r.tipo === 'piatto'
    ? {
        chiave: r.chiave,
        tipo: 'piatto',
        nome: r.nome,
        ...(r.descrizione ? { descrizione: r.descrizione } : {}),
        ...(r.categoria ? { categoria: r.categoria } : {}),
        ...(r.prezzo > 0 ? { prezzo_euro: r.prezzo } : {}),
        ...(r.alPeso ? { venduto_al_peso: true } : { porzioni: r.porzioni }),
        ...(r.componenti.length > 0 ? { ingredienti_dichiarati_nel_menu: r.componenti } : {}),
    }
    : {
        chiave: r.chiave,
        tipo: 'semilavorato',
        nome: r.nome,
        ...(r.unitaCosto ? { si_usa_a: A_QUANTITA[r.unitaCosto] } : {}),
    };

export interface ObiettivoBozza {
    tipo: 'piatto' | 'semilavorato';
    /** Porzioni della ricetta (per il piatto al peso vale 1). */
    porzioni: number;
    /** Il semilavorato stesso: non può stare nella sua ricetta. */
    escluso?: number | null;
}

/** La scheda del modello, ripulita: solo ingredienti del ristorante o nuovi
 *  con un nome, unità coerenti, quantità plausibili, niente doppioni. Quello
 *  che si scarta per un motivo che lo chef deve sapere diventa un avviso. */
export function normalizzaBozza(raw: any, ingredienti: IngredienteAi[], obiettivo: ObiettivoBozza): BozzaScheda {
    const perId = new Map(ingredienti.map(i => [i.id, i]));
    const perNome = new Map<string, IngredienteAi>();
    for (const i of ingredienti) if (!perNome.has(norm(i.nome))) perNome.set(norm(i.nome), i);
    const lotto = obiettivo.tipo === 'semilavorato';
    const porzioni = Math.max(1, Math.round(obiettivo.porzioni) || 1);
    const maxPeso = lotto ? MAX_PESO_LOTTO : MAX_PESO_PORZIONE * porzioni;
    const maxPezzi = lotto ? MAX_PEZZI_LOTTO : MAX_PEZZI_PORZIONE * porzioni;

    const avvisi: string[] = (Array.isArray(raw?.avvisi) ? raw.avvisi : [])
        .map((a: unknown) => text(a, 300))
        .filter((a: string | null): a is string => !!a);
    const righe: RigaBozza[] = [];
    const visti = new Set<string>();

    for (const r of Array.isArray(raw?.righe) ? raw.righe : []) {
        const unita = DA_QUANTITA[r?.unita as string];
        const quantita = typeof r?.quantita === 'number' ? r.quantita : Number.NaN;
        if (!unita || !Number.isFinite(quantita) || quantita <= 0) continue;

        let ing: IngredienteAi | undefined = Number.isInteger(r?.ingrediente_id) ? perId.get(r.ingrediente_id) : undefined;
        const nomeNuovo = ing ? null : text(r?.nuovo_ingrediente, 255);
        // Un «nuovo» che c'è già col suo nome è quello: niente doppioni in magazzino.
        if (!ing && nomeNuovo) ing = perNome.get(norm(nomeNuovo));
        if (!ing && !nomeNuovo) continue;
        if (ing && obiettivo.escluso != null && ing.id === obiettivo.escluso) continue;

        const nome = ing?.nome ?? nomeNuovo!;
        if (ing?.unitaCosto && ing.unitaCosto !== unita) {
            avvisi.push(`${nome}: proposto in ${A_QUANTITA[unita]} ma si conta a ${ing.unitaCosto}, da aggiungere a mano`);
            continue;
        }
        if (quantita > (unita === 'pz' ? maxPezzi : maxPeso)) continue;

        const chiave = ing ? `id:${ing.id}` : `nuovo:${norm(nome)}`;
        if (visti.has(chiave)) continue;
        visti.add(chiave);
        righe.push({
            productId: ing?.id ?? null,
            nomeNuovo: ing ? null : nomeNuovo,
            unita,
            quantita: Math.round(quantita * 1000) / 1000,
            nota: text(r?.nota, 200),
        });
        if (righe.length >= RIGHE_MASSIME) break;
    }

    let resaQuantita: number | null = null;
    let resaUnita: UnitaCosto | null = null;
    if (lotto && typeof raw?.resa_quantita === 'number' && raw.resa_quantita > 0 && raw.resa_quantita <= 10_000_000) {
        resaQuantita = Math.round(raw.resa_quantita * 1000) / 1000;
        resaUnita = DA_QUANTITA[raw?.resa_unita as string] ?? null;
    }
    return { righe, resaQuantita, resaUnita, avvisi: avvisi.slice(0, AVVISI_MASSIMI) };
}

/**
 * Le bozze per un lotto di richieste. Ritorna una mappa chiave → bozza; una
 * richiesta che il modello salta non compare.
 */
export async function proponiSchede(
    richieste: RichiestaBozza[],
    contesto: { ingredienti: IngredienteAi[]; esempi: EsempioScheda[] },
    onUsage?: (u: FoodCostAiUsage) => void,
): Promise<Map<string, BozzaScheda>> {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) throw new FoodCostAiError('ANTHROPIC_API_KEY non configurata sul backend', 'not_configured');
    if (richieste.length === 0) return new Map();

    let response: Anthropic.Beta.BetaMessage;
    try {
        const client = new Anthropic({ apiKey });
        response = await client.beta.messages.create({
            model: FOOD_COST_AI_MODEL,
            max_tokens: Math.min(TOKEN_MASSIMI, TOKEN_PER_SCHEDA * richieste.length),
            // Se il modello rifiuta, la richiesta passa da sola al modello di
            // ripiego scelto dal server, come per la lettura delle bolle.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: SFORZO, format: { type: 'json_schema', schema: SCHEMA } },
            system: buildSystem(contesto.ingredienti, contesto.esempi),
            messages: [{
                role: 'user',
                content: `Scrivi le schede per queste richieste:\n${JSON.stringify(richieste.map(richiestaPerModello))}`,
            }],
        });
    } catch (err: any) {
        throw new FoodCostAiError(err?.message || 'Errore dal modello', 'upstream');
    }

    // I token si pagano anche quando la risposta non serve: prima di tutto.
    // ai_token_usage ha un solo contatore di input a tariffa piena: qui va il
    // suo equivalente di costo (scrittura in cache 1,25×, lettura 0,05× su
    // Opus 5.5), come fa l'assistente Aiuto.
    if (onUsage) {
        const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
        const cacheRead = response.usage.cache_read_input_tokens ?? 0;
        onUsage({
            model: response.model || FOOD_COST_AI_MODEL,
            promptTokens: (response.usage.input_tokens ?? 0) + Math.round(cacheWrite * 1.25) + Math.round(cacheRead * 0.05),
            outputTokens: response.usage.output_tokens ?? 0,
        });
    }

    if (response.stop_reason === 'refusal') {
        throw new FoodCostAiError('Il modello non ha scritto la scheda', 'refused');
    }
    if (response.stop_reason === 'max_tokens') {
        throw new FoodCostAiError('Risposta del modello troncata', 'upstream');
    }
    const json = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();
    let parsed: any;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new FoodCostAiError('Risposta del modello non leggibile', 'upstream');
    }

    const perChiave = new Map(richieste.map(r => [r.chiave, r]));
    const out = new Map<string, BozzaScheda>();
    for (const s of Array.isArray(parsed?.schede) ? parsed.schede : []) {
        const richiesta = perChiave.get(String(s?.chiave ?? ''));
        if (!richiesta || out.has(richiesta.chiave)) continue;
        out.set(richiesta.chiave, normalizzaBozza(s, contesto.ingredienti, richiesta.tipo === 'piatto'
            ? { tipo: 'piatto', porzioni: richiesta.alPeso ? 1 : richiesta.porzioni }
            : { tipo: 'semilavorato', porzioni: 1, escluso: richiesta.productId }));
    }
    return out;
}
