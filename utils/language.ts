// Card dev board #32 — lingua ospite: rilevamento condiviso fra i canali.
// Fondazione: normalizza e rileva SOLO il codice lingua da salvare (es. 'it',
// 'en'). Nessuna traduzione vive qui — arriva nelle card successive.

/**
 * Riduce un codice lingua qualunque (BCP-47 incluso, es. "en-US") al
 * sottocodice ISO 639-1 di due lettere che il resto del sistema salva
 * ("en"). Ritorna null se l'input non è un codice lingua riconoscibile.
 */
export function normalizeLanguageCode(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim().toLowerCase();
    if (!trimmed) return null;
    const base = trimmed.slice(0, 2);
    return /^[a-z]{2}$/.test(base) ? base : null;
}

/**
 * Euristica iniziale (card #32) per i messaggi WhatsApp inbound: un numero
 * che non porta il prefisso italiano è quasi sempre un ospite straniero, e
 * l'agente Sofia/Vonage/Twilio parla solo italiano o inglese oggi — quindi
 * 'en' è la scelta di default finché non arriveranno altre lingue. Un
 * numero locale (10 cifre, nessun prefisso internazionale) resta italiano.
 */
export function detectLanguageFromPhonePrefix(phone: string | null | undefined): 'it' | 'en' {
    const digits = String(phone ?? '').replace(/\D/g, '');
    const national = digits.startsWith('00') ? digits.slice(2) : digits;
    if (!national || national.startsWith('39') || national.length <= 10) return 'it';
    return 'en';
}
