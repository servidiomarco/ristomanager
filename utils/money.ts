/* Importi, scritti come li scrive il paese del ristorante.
 *
 * Vive in utils/ perché lo importano tutt'e due i lati: il server per i
 * messaggi al cliente e i log, il frontend per le schermate e i fogli di
 * stampa. Una seconda copia della tabella divergerebbe al primo listino
 * nuovo, e la divergenza si vedrebbe su un conto.
 *
 * Per l'euro l'uscita è IDENTICA a quella di sempre — «€ 15,00», simbolo
 * davanti e virgola decimale: è la stringa che i clienti italiani leggono da
 * due anni in SMS, WhatsApp ed email, e non deve cambiare di un carattere.
 * Per questo la composizione resta a mano invece di passare a
 * Intl.NumberFormat, che per l'italiano produrrebbe «15,00 €» (simbolo in
 * coda) e cambierebbe ogni messaggio già in produzione.
 *
 * Le altre monete seguono la loro convenzione: simbolo attaccato e punto
 * decimale per sterlina e dollaro, codice davanti dove un simbolo non c'è.
 * La whitelist è la stessa del CHECK su tenants.currency — tutte monete a due
 * decimali, perché l'applicazione conta in centesimi da sempre.
 */
export const MONEY_FORMAT: Record<string, { symbol: string; decimal: ',' | '.'; spaced: boolean }> = {
    EUR: { symbol: '€',   decimal: ',', spaced: true },
    GBP: { symbol: '£',   decimal: '.', spaced: false },
    USD: { symbol: '$',   decimal: '.', spaced: false },
    CHF: { symbol: 'CHF', decimal: '.', spaced: true },
    AED: { symbol: 'AED', decimal: '.', spaced: true },
};

/** Un importo in centesimi. Una valuta sconosciuta esce col suo codice
 *  davanti invece di sparire: meglio «XYZ 15.00» di un numero nudo. */
export function formatMoneyMinor(cents: number, currency: string = 'EUR'): string {
    const code = String(currency || 'EUR').toUpperCase();
    const fmt = MONEY_FORMAT[code] ?? { symbol: code, decimal: '.' as const, spaced: true };
    const amount = (cents / 100).toFixed(2).replace('.', fmt.decimal);
    return `${fmt.symbol}${fmt.spaced ? ' ' : ''}${amount}`;
}

/** Come sopra, ma l'importo arriva già in unità invece che in centesimi —
 *  i prezzi dei banchetti e dei piatti si portano dietro dei numeri decimali
 *  dal database, e passare per i centesimi introdurrebbe un arrotondamento
 *  dove oggi non ce n'è. */
export function formatMoneyUnits(amount: number | string | null | undefined, currency: string = 'EUR'): string {
    const code = String(currency || 'EUR').toUpperCase();
    const fmt = MONEY_FORMAT[code] ?? { symbol: code, decimal: '.' as const, spaced: true };
    const value = (Number(amount ?? 0) || 0).toFixed(2).replace('.', fmt.decimal);
    return `${fmt.symbol}${fmt.spaced ? ' ' : ''}${value}`;
}

/** Il simbolo da solo, per le etichette che l'importo lo scrivono da sé
 *  (intestazioni di colonna, campi prezzo, «/persona»). */
export function currencySymbol(currency: string = 'EUR'): string {
    const code = String(currency || 'EUR').toUpperCase();
    return MONEY_FORMAT[code]?.symbol ?? code;
}
