/* Numeri di telefono in forma internazionale.
 *
 * Il CRM è nato in un ristorante italiano, quindi «un numero senza prefisso è
 * italiano» era una verità: 3331234567 diventa +393331234567 e Twilio lo
 * accetta. Per un locale a Londra la stessa regola è un errore — quel numero
 * lì è britannico, e spedito col +39 non arriva a nessuno.
 *
 * Qui la regola diventa «un numero senza prefisso è del paese del
 * ristorante». Il prefisso di casa arriva da tenantLocale; con l'Italia il
 * risultato è identico a prima.
 *
 * Importato sia dal server (regola .js) sia, in prospettiva, dal frontend.
 */

/** Cifre del numero, senza spazi, trattini, parentesi o '+'. */
const digitsOf = (input: string): string => String(input ?? '').replace(/\D/g, '');

/**
 * Numero in E.164 ('+' e sole cifre), interpretando la forma locale secondo
 * il paese del ristorante.
 *
 * - '00…' è la forma internazionale scritta all'europea → diventa '+…'.
 * - Un numero che comincia già col prefisso di casa ed è abbastanza lungo si
 *   considera completo.
 * - Il resto è un numero locale: prende il prefisso di casa. Lo zero iniziale
 *   dei fissi si toglie dove è un «trunk prefix» (Regno Unito, Francia,
 *   Germania, Svizzera…), NON in Italia, dove fa parte del numero: 06 di Roma
 *   è 0039 06…, mentre Londra 020 è +44 20.
 */
export function normalizePhoneE164(input: string, dialCode: string = '39'): string {
    if (!input) return '';
    const digits = digitsOf(input);
    if (!digits) return '';
    const prefix = digitsOf(dialCode) || '39';

    // Un '+' scritto dall'utente dice già tutto: il numero è internazionale
    // com'è. Senza questo controllo un +44 salvato a mano si vedrebbe
    // anteporre il prefisso di casa e diventerebbe inviabile.
    if (String(input).trim().startsWith('+')) return '+' + digits;
    if (digits.startsWith('00')) return '+' + digits.slice(2);
    // Già col prefisso di casa — ma la soglia conta: i cellulari italiani che
    // cominciano per 39 (392, 393…) sono comunissimi, e un 3912345678 è un
    // numero LOCALE, non un +39 12345678. Servono almeno 9 cifre dopo il
    // prefisso perché sia davvero un numero già internazionale: per l'Italia
    // fa 11 cifre, la stessa soglia della funzione storica.
    if (digits.startsWith(prefix) && digits.length >= prefix.length + 9) return '+' + digits;

    const senzaTrunk = TRUNK_ZERO_COUNTRIES.has(prefix) && digits.startsWith('0')
        ? digits.replace(/^0+/, '')
        : digits;
    return '+' + prefix + senzaTrunk;
}

/* Paesi dove lo zero iniziale è un prefisso interurbano da togliere in forma
 * internazionale. L'Italia NON c'è: lo zero dei fissi italiani fa parte del
 * numero e toglierlo romperebbe ogni telefono di rete fissa. */
const TRUNK_ZERO_COUNTRIES = new Set(['44', '33', '49', '41', '34', '353']);

/**
 * Compatibilità: il comportamento storico, cioè l'Italia. Resta per i punti
 * che non conoscono (ancora) il ristorante — e come documentazione del fatto
 * che «italiano» era un'assunzione, non una legge di natura.
 */
export function normalizeItalianPhone(input: string): string {
    return normalizePhoneE164(input, '39');
}
