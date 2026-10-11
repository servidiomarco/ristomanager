// Fonte di una prenotazione (reservations.source) vista dalle regole del
// ristorante. Il form pubblico ha sempre scritto 'GOOGLE' — il nome viene
// dal primo link, quello di Google Business — e le prenotazioni dal sito
// avranno la loro fonte 'WEB' per distinguerle in Reportistica. Le policy
// (canali di risposta, blacklist) restano una sola per il web: le
// impostazioni salvate dai ristoranti hanno la chiave 'GOOGLE', e una fonte
// nuova senza regola cadrebbe su MANUAL, con WhatsApp al posto dell'email.
// Nessun import: il file è condiviso fra server (ESM) e SPA.

export type PolicySource = 'GOOGLE' | 'VOICE' | 'WHATSAPP' | 'MANUAL';

/** Prenotazione arrivata dal form pubblico, con la fonte vecchia o nuova. */
export const isWebSource = (source: unknown): boolean =>
    source === 'WEB' || source === 'GOOGLE';

/** La chiave delle policy per una fonte; fonte ignota o vuota → MANUAL. */
export function policySourceOf(source: unknown): PolicySource {
    if (isWebSource(source)) return 'GOOGLE';
    if (source === 'VOICE' || source === 'WHATSAPP') return source;
    return 'MANUAL';
}
