// Abbinamenti vino–piatto — batch via Claude (stessa integrazione e stessa
// chiave di menuTranslationService: ANTHROPIC_API_KEY su Railway, mai sul
// client). L'AI PROPONE soltanto: quello che palmare e menu pubblico
// mostrano è ciò che il ristoratore salva in scheda piatto — il modello non
// parla mai direttamente al cameriere o al cliente.
//
// Regole: si abbina SOLO dai vini in carta (id passati qui dentro, validati
// al ritorno — un id inventato si scarta); al massimo tre vini per piatto,
// dal più adatto. Output JSON rigido, id per id: un piatto che il modello
// salta semplicemente non compare nella mappa.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';
// Un piatto per riga con nome e descrizione: lotti più piccoli della
// traduzione, il modello deve ragionare sull'accoppiata, non trascrivere.
const LOTTO = 25;

export interface VinoInCarta {
    id: number;
    name: string;
    category?: string | null;
    description?: string | null;
}

export interface PiattoDaAbbinare {
    id: number;
    name: string;
    category?: string | null;
    description?: string | null;
}

export function isWinePairingConfigured(): boolean {
    return Boolean((process.env.ANTHROPIC_API_KEY || '').trim());
}

function buildSystem(vini: VinoInCarta[]): string {
    const carta = vini.map(v => ({
        id: v.id,
        name: v.name,
        ...(v.category ? { category: v.category } : {}),
        ...(String(v.description ?? '').trim() ? { description: String(v.description).trim() } : {}),
    }));
    return [
        `Sei il sommelier di un ristorante calabrese. Abbina i piatti ai vini DELLA CARTA qui sotto.`,
        `Carta dei vini (JSON): ${JSON.stringify(carta)}`,
        `Regole:`,
        `- Solo vini di questa carta, citati per id. Mai id inventati.`,
        `- Da 1 a 3 vini per piatto, in ordine dal più adatto. Se nessun vino della carta si abbina davvero, ometti il piatto.`,
        `- Criteri concreti: struttura del piatto, cottura, grassezza, territorio (i vini calabresi sui piatti della tradizione quando reggono l'abbinamento).`,
        `- Rispondi SOLO con un array JSON: [{"dish_id": 1, "wine_dish_ids": [2, 3]}]. Nessun testo fuori dal JSON.`,
    ].join('\n');
}

/**
 * Propone gli abbinamenti per un elenco di piatti, pescando solo dai vini
 * passati. Ritorna una mappa dish_id → wine_dish_ids (max 3, validati sulla
 * carta); i piatti saltati o malformati non compaiono nella mappa.
 */
export async function suggestWinePairings(
    piatti: PiattoDaAbbinare[],
    vini: VinoInCarta[],
    onUsage?: (promptTokens: number, outputTokens: number) => void,
): Promise<Map<number, number[]>> {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY non configurata sul backend');
    if (vini.length === 0) return new Map();
    const client = new Anthropic({ apiKey });
    const wineIds = new Set(vini.map(v => v.id));
    const out = new Map<number, number[]>();

    for (let i = 0; i < piatti.length; i += LOTTO) {
        const lotto = piatti.slice(i, i + LOTTO);
        const payload = lotto.map(p => ({
            id: p.id,
            name: p.name,
            ...(p.category ? { category: p.category } : {}),
            ...(String(p.description ?? '').trim() ? { description: String(p.description).trim() } : {}),
        }));
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: 8_000,
            output_config: { effort: 'low' },
            system: buildSystem(vini),
            messages: [{ role: 'user', content: JSON.stringify(payload) }],
        });
        onUsage?.(response.usage.input_tokens ?? 0, response.usage.output_tokens ?? 0);
        const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join('');
        const jsonText = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
        let parsed: unknown;
        try {
            parsed = JSON.parse(jsonText);
        } catch {
            throw new Error(`Risposta del modello non parsabile (lotto ${i / LOTTO + 1})`);
        }
        if (!Array.isArray(parsed)) continue;
        for (const row of parsed) {
            const dishId = Number((row as any)?.dish_id);
            const raw = (row as any)?.wine_dish_ids;
            if (!Number.isFinite(dishId) || !Array.isArray(raw)) continue;
            // La validazione è la difesa: solo id che stanno davvero in
            // carta, dedupe, tetto a 3 — un'allucinazione non arriva al form.
            const ids = [...new Set(raw.map(Number).filter(n => wineIds.has(n)))].slice(0, 3);
            if (ids.length > 0) out.set(dishId, ids);
        }
    }
    return out;
}
