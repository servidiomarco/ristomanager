import { currentServiceInTz, getDatePartInTz, getTimePartInTz, serviceDayInTz } from './reservationTime';

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

// La data di un Date letta coi getter del dispositivo, come la leggono la
// testata di App e le viste che usano formatLocalDate.
const deviceDatePart = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Il servizio di adesso all'ora del ristorante, non del dispositivo: data,
 *  turno e `anchor`, un Date dentro quel giorno di servizio da dare a
 *  setGlobalDate (vedi currentServiceInTz).
 *
 *  L'ancora deve cadere in quel giorno in TUTTE e due le letture che App fa
 *  di globalDate: coi getter del dispositivo (testata, piantina,
 *  prenotazioni, accoglienza, dashboard) e con datePart nel fuso del
 *  ristorante (cassa, cucina, pagamenti, comande). Sul dispositivo del locale
 *  coincidono, e l'ancora resta quella di currentServiceInTz. Su un portatile
 *  rimasto in un altro fuso no: alle 22:30 di Roma un Mac a Dubai è già a
 *  domani, e con l'istante come ancora la testata salterebbe alla cena di
 *  domani mentre la cassa resta su stasera. Lì l'ancora diventa il
 *  mezzogiorno locale della data del servizio, che cade nel giorno giusto in
 *  tutte e due le letture finché i fusi distano meno di 12 ore; oltre, resta
 *  quella del ristorante.
 *
 *  App la chiama anche prima del login, per lo stato iniziale: lì vale il
 *  fuso di default, e App rifà il conto quando arriva quello del ristorante. */
export const currentService = (at: Date = new Date()): ReturnType<typeof currentServiceInTz> => {
    const s = currentServiceInTz(at, sessionTz);
    if (deviceDatePart(s.anchor) === s.date) return s;
    const [y, m, d] = s.date.split('-').map(Number);
    const mezzogiorno = new Date(y, m - 1, d, 12);
    return getDatePartInTz(mezzogiorno, sessionTz) === s.date ? { ...s, anchor: mezzogiorno } : s;
};

/** Il giorno di servizio di un istante: un walk-in delle 00:30 è della cena
 *  di ieri. */
export const serviceDayOf = (iso: string | Date | null | undefined): string =>
    serviceDayInTz(iso, sessionTz);
