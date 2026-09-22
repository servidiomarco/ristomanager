import { formatMoneyMinor, formatMoneyUnits, currencySymbol } from './money';
import { displayLocale } from './formatLocale';

/* Gli importi come li scrive il ristorante che sta guardando — SOLO FRONTEND.
 *
 * Gemello di utils/displayTime.ts, e per la stessa ragione: `utils/money.ts`
 * lo importa anche il server, dove ogni richiesta è di un tenant diverso e
 * una valuta «corrente» a livello di modulo sarebbe la valuta di chiunque
 * abbia fatto l'ultima richiesta. Lì la valuta si passa esplicita e basta.
 *
 * Nel browser è l'opposto: una scheda è un tenant solo. Tenerla qui evita di
 * passarla per una quarantina di punti di chiamata, che è il genere di
 * threading in cui si dimentica un posto e nessuno se ne accorge.
 *
 * La imposta AuthContext appena conosce l'utente. Finché non è impostata vale
 * l'euro, che è dove l'applicazione ha sempre vissuto.
 */
const DEFAULT_CURRENCY = 'EUR';
let sessionCur = DEFAULT_CURRENCY;

/** Da chiamare quando si sa di quale ristorante è la sessione. */
export const setSessionCurrency = (currency: string | null | undefined): void => {
    sessionCur = (currency && String(currency).trim().toUpperCase()) || DEFAULT_CURRENCY;
};

/** La valuta della sessione, per chi deve passarla a Intl da sé. */
export const sessionCurrency = (): string => sessionCur;

/* Due rese, di proposito.
 *
 * `money()` scrive «€ 15,00»: simbolo davanti, composto a mano. È la resa dei
 * messaggi al cliente e della maggior parte delle schermate, ed è identica al
 * carattere a quella del server (stessa tabella in utils/money.ts).
 *
 * `moneyIntl()` scrive «15,00 €»: simbolo in coda, come lo vuole Intl per
 * l'italiano. La usano i punti che già la usavano — compensi, expediter,
 * reportistica, comande — e cambiarli sarebbe un ritocco grafico che nessuno
 * ha chiesto. Per un cliente inglese le due rese convergono, perché en-GB
 * mette il simbolo davanti anche in Intl.
 */

/** «€ 15,00» — simbolo davanti. Prende i centesimi. */
export const money = (cents: number): string => formatMoneyMinor(cents, sessionCur);

/** «€ 15,00» da un importo già in unità: prezzi dei piatti e dei banchetti. */
export const moneyUnits = (amount: number | string | null | undefined): string =>
    formatMoneyUnits(amount, sessionCur);

/** «15,00 €» in italiano, «£15.00» in inglese. Prende le UNITÀ, non i centesimi. */
export const moneyIntl = (amount: number, options?: Intl.NumberFormatOptions): string =>
    amount.toLocaleString(displayLocale(), { style: 'currency', currency: sessionCur, ...options });

/** Il simbolo da solo: prefissi dei campi importo, etichette, intestazioni. */
export const moneySymbol = (): string => currencySymbol(sessionCur);
