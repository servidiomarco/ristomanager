import { getDatePartInTz, getTimePartInTz } from './reservationTime';

/* Data e ora come le vede il ristorante che sta guardando — SOLO FRONTEND.
 *
 * Perché un modulo a sé invece di aggiungere il fuso a reservationTime.ts:
 * quel file lo importa anche il server, dove ogni richiesta può appartenere a
 * un tenant diverso e un fuso «corrente» a livello di modulo sarebbe il fuso
 * di chiunque abbia fatto l'ultima richiesta. Lì il fuso si passa esplicito
 * (getDatePartInTz / getTimePartInTz) e nient'altro.
 *
 * Nel browser la situazione è l'opposta: una scheda è un tenant solo, per
 * tutta la sessione. Tenere il fuso qui evita di passarlo attraverso
 * centoventi punti di chiamata in ventisette file, che è il genere di
 * threading in cui si dimentica un posto e nessuno se ne accorge.
 *
 * Lo imposta AuthContext appena conosce l'utente, e App.tsx monta le viste
 * solo dopo il login (prima c'è LoginPage): quando questi formatter vengono
 * chiamati per la prima volta il fuso è già quello giusto. Finché non è
 * impostato vale Europe/Rome, che è dove l'applicazione ha sempre vissuto.
 */
const DEFAULT_TZ = 'Europe/Rome';
let sessionTz = DEFAULT_TZ;

/** Da chiamare quando si sa di quale ristorante è la sessione. */
export const setSessionTimeZone = (tz: string | null | undefined): void => {
    sessionTz = (tz && String(tz).trim()) || DEFAULT_TZ;
};

/** Il fuso della sessione, per chi deve passarlo a Intl da sé. */
export const sessionTimeZone = (): string => sessionTz;

/** YYYY-MM-DD nel fuso del ristorante. */
export const datePart = (iso: string | Date | null | undefined): string =>
    getDatePartInTz(iso, sessionTz);

/** HH:MM (24h) nel fuso del ristorante. */
export const timePart = (iso: string | Date | null | undefined): string =>
    getTimePartInTz(iso, sessionTz);
