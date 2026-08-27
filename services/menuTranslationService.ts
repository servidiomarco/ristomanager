// Traduzioni del menu digitale — batch via Claude (stessa integrazione e
// stessa chiave di aiReplyService: ANTHROPIC_API_KEY su Railway, mai sul
// client). La cassa non ha testi in lingua (DescrizioneInLingua vuota,
// verificato 27/08): le traduzioni vivono nel CRM (dishes.translations e le
// categorie in app_settings) e il sync del menu non le tocca.
//
// Regole di traduzione: un menu si traduce senza inventare — i nomi propri e
// le specialità locali ('Nduja, Silana, MPacchiuse) restano riconoscibili,
// al massimo con una glossa breve. Output JSON rigido, id per id: una voce
// non tradotta si salta, non si riempie a fantasia.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';
// Le voci sono corte: un lotto grande sta comodo in un giro solo, ma si
// spezza per non far durare la singola risposta più del necessario.
const LOTTO = 60;

export const MENU_LANGS = ['en', 'fr', 'de'] as const;
export type MenuLang = (typeof MENU_LANGS)[number];

const LANG_LABEL: Record<MenuLang, string> = { en: 'inglese', fr: 'francese', de: 'tedesco' };

export interface VoceDaTradurre {
    id: string;
    name: string;
    description?: string | null;
}

export interface VoceTradotta {
    name: string;
    description?: string;
}

export function isMenuTranslationConfigured(): boolean {
    return Boolean((process.env.ANTHROPIC_API_KEY || '').trim());
}

function buildSystem(lang: MenuLang): string {
    return [
        `Traduci in ${LANG_LABEL[lang]} le voci di un menu di un ristorante calabrese.`,
        `Regole:`,
        `- I nomi propri, i marchi e le specialità locali restano in italiano ('Nduja, Caciocavallo, Tartufo di Pizzo…); se utile aggiungi una glossa brevissima tra parentesi.`,
        `- Traduzione asciutta da menu, senza inventare ingredienti o dettagli non presenti.`,
        `- Rispondi SOLO con un array JSON: [{"id": "...", "name": "...", "description": "..."}]. Il campo description solo se la voce lo aveva. Nessun testo fuori dal JSON.`,
    ].join('\n');
}

/**
 * Traduce un elenco di voci (piatti o categorie) nella lingua indicata.
 * Ritorna una mappa id → traduzione; le voci che il modello salta o
 * restituisce malformate semplicemente non compaiono nella mappa.
 */
export async function translateMenuEntries(
    voci: VoceDaTradurre[],
    lang: MenuLang,
    onUsage?: (tokens: number) => void,
): Promise<Map<string, VoceTradotta>> {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY non configurata sul backend');
    const client = new Anthropic({ apiKey });
    const out = new Map<string, VoceTradotta>();

    for (let i = 0; i < voci.length; i += LOTTO) {
        const lotto = voci.slice(i, i + LOTTO);
        const payload = lotto.map((v) => ({
            id: v.id,
            name: v.name,
            ...(String(v.description ?? '').trim() ? { description: String(v.description).trim() } : {}),
        }));
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: 8_000,
            output_config: { effort: 'low' },
            system: buildSystem(lang),
            messages: [{ role: 'user', content: JSON.stringify(payload) }],
        });
        onUsage?.((response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0));
        const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('');
        const jsonText = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
        let parsed: unknown;
        try {
            parsed = JSON.parse(jsonText);
        } catch {
            throw new Error(`Risposta del modello non parsabile (lotto ${i / LOTTO + 1}, ${lang})`);
        }
        if (!Array.isArray(parsed)) continue;
        for (const row of parsed) {
            const id = String((row as any)?.id ?? '');
            const name = String((row as any)?.name ?? '').trim();
            if (!id || !name) continue;
            const description = String((row as any)?.description ?? '').trim();
            out.set(id, description ? { name, description } : { name });
        }
    }
    return out;
}
