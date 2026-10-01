// Chiave Anthropic rifiutata (revocata o sostituita nella Console): l'API
// risponde 401 authentication_error a ogni chiamata. Il 01/10/2026 la chiave
// su Railway era diventata invalida e ogni funzione AI rispondeva solo
// «Internal server error» — nessuno poteva capire che bastava aggiornarla.
//
// I servizi AI rilanciano l'errore dell'SDK avvolto nel proprio (kind
// 'upstream', stesso message), quindi lo si riconosce anche dal testo: il
// message dell'SDK contiene il corpo JSON della risposta.

export const AI_KEY_INVALID = 'ai_key_invalid';

export const AI_KEY_INVALID_MESSAGE = 'Chiave AI non valida: va aggiornata sul server (ANTHROPIC_API_KEY).';

export function isAiKeyInvalid(err: unknown): boolean {
    const e = err as { status?: unknown; message?: unknown } | null | undefined;
    const message = String(e?.message ?? '');
    if (e?.status === 401 && /authentication/i.test(message)) return true;
    return /authentication_error|invalid x-api-key|api key is invalid/i.test(message);
}
