// Helpers for reading reservation_time consistently in Europe/Rome, regardless
// of the viewer's browser timezone.
//
// The DB column is `timestamptz`. After the write path fix (db.ts pool session
// TZ = Europe/Rome) each reservation is stored as the correct UTC instant, and
// node-pg serializes it back to an ISO string with a `Z` suffix. Splitting on
// 'T' or matching the raw ISO time no longer yields the wall-clock value the
// user typed — we have to convert into Europe/Rome first. These helpers are
// timezone-explicit so they behave the same for a viewer in Milan, in New
// York, or in a headless Node context.

const ROME = 'Europe/Rome';

// Instantiate the formatters once at module load. `toLocaleDateString` /
// `toLocaleTimeString` build a fresh Intl.DateTimeFormat on every call, and
// that constructor is orders of magnitude slower than the format() call
// itself. These helpers get invoked ~50–200 times per render in the
// reservation list, so caching the formatters removes the per-keystroke
// lag observed while typing in the reservation form modal.
const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: ROME });
const timeFmt = new Intl.DateTimeFormat('it-IT', {
    timeZone: ROME,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});

/* Le stesse due letture su un fuso qualsiasi.
 *
 * I formatter si costruiscono una volta per fuso e restano in cache: il
 * costruttore di Intl.DateTimeFormat è ordini di grandezza più lento della
 * format(), ed è la ragione per cui i due formatter di Roma stanno in cima a
 * questo file. Una Map li conserva senza perdere quel guadagno quando i fusi
 * diventano più di uno.
 *
 * getRomeDatePart e getRomeTimePart restano: sono chiamate in ventisei file e
 * il fuso di casa non cambia. Queste servono a chi SA di quale ristorante sta
 * leggendo l'orologio. */
const dateFmtByTz = new Map<string, Intl.DateTimeFormat>([[ROME, dateFmt]]);
const timeFmtByTz = new Map<string, Intl.DateTimeFormat>([[ROME, timeFmt]]);

const dateFmtFor = (tz: string): Intl.DateTimeFormat => {
    let f = dateFmtByTz.get(tz);
    if (!f) {
        try {
            f = new Intl.DateTimeFormat('sv-SE', { timeZone: tz });
        } catch {
            f = dateFmt;   // un fuso inventato non deve far esplodere una lista
        }
        dateFmtByTz.set(tz, f);
    }
    return f;
};

const timeFmtFor = (tz: string): Intl.DateTimeFormat => {
    let f = timeFmtByTz.get(tz);
    if (!f) {
        try {
            f = new Intl.DateTimeFormat('it-IT', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
        } catch {
            f = timeFmt;
        }
        timeFmtByTz.set(tz, f);
    }
    return f;
};

/** YYYY-MM-DD nel fuso dato. */
export const getDatePartInTz = (iso: string | Date | null | undefined, tz: string): string => {
    if (!iso) return '';
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return dateFmtFor(tz).format(d);
};

/** HH:MM (24h) nel fuso dato. */
export const getTimePartInTz = (iso: string | Date | null | undefined, tz: string): string => {
    if (!iso) return '';
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return timeFmtFor(tz).format(d);
};

// Returns YYYY-MM-DD in Europe/Rome. `sv-SE` locale renders dates in ISO order
// which matches the string format used everywhere else in the app
// (selectedDate, event dates, filter comparisons).
export const getRomeDatePart = (iso: string | Date | null | undefined): string => {
    if (!iso) return '';
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return dateFmt.format(d);
};

// Returns HH:MM in Europe/Rome (24h, zero-padded). Used by the palette and
// anywhere the wall-clock hour is displayed.
export const getRomeTimePart = (iso: string | Date | null | undefined): string => {
    if (!iso) return '';
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return timeFmt.format(d);
};

/* Il servizio «di adesso», come lo intende il server (resolveService in
 * server.ts): il giorno di servizio comincia alle 05:00 del ristorante e la
 * cena alle 17:00. Prima delle 5 si è ancora nella cena di ieri: la data del
 * servizio non è la data dell'orologio, e una cena che finisce all'una
 * appartiene al giorno prima.
 *
 * L'ora si legge nel fuso del ristorante, mai in quello del dispositivo: un
 * portatile rimasto su un altro fuso deve vedere il servizio del locale. Il
 * fuso arriva esplicito per la stessa ragione di getDatePartInTz (questo file
 * lo compila anche il server, dove ogni richiesta è di un tenant diverso); il
 * frontend passa quello della sessione da displayTime.ts. Niente import qui.
 *
 * Le soglie sono le stesse del server: se cambiano, cambiano in tutti e due i
 * posti. tests/unit/currentService.test.ts confronta questa lettura con la
 * formula del server, ora per ora. */
export const SERVICE_DAY_START_HOUR = 5;
export const DINNER_START_HOUR = 17;

// Un formatter dell'ora per fuso, in cache come gli altri due. 'h23' come sul
// server: l'ora va letta da 00 a 23, e a mezzanotte 'h12' darebbe «12 a.m.»,
// 'h24' darebbe «24».
const hourFmt = new Intl.DateTimeFormat('en-CA', { timeZone: ROME, hour: '2-digit', hourCycle: 'h23' });
const hourFmtByTz = new Map<string, Intl.DateTimeFormat>([[ROME, hourFmt]]);

const hourFmtFor = (tz: string): Intl.DateTimeFormat => {
    let f = hourFmtByTz.get(tz);
    if (!f) {
        try {
            f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' });
        } catch {
            f = hourFmt;   // come la data: un fuso inventato ricade su Roma, non esplode
        }
        hourFmtByTz.set(tz, f);
    }
    return f;
};

/** Il servizio in corso all'istante `at` nel fuso `tz`: la data del servizio,
 *  il turno e `anchor`, un Date DENTRO quel giorno di servizio da dare a
 *  setGlobalDate (alle 00:30 punta alla sera di ieri). */
export const currentServiceInTz = (at: Date, tz: string): { date: string; shift: 'LUNCH' | 'DINNER'; anchor: Date } => {
    const hour = Number(hourFmtFor(tz).formatToParts(at).find((p) => p.type === 'hour')?.value ?? '');
    const date = getDatePartInTz(at, tz);
    if (hour < SERVICE_DAY_START_HOUR) {
        // Notte fonda: siamo ancora nella cena di ieri. Il giorno prima si
        // conta sul calendario, come fa il server; l'ancora torna indietro di
        // sei ore, che da qualunque ora fra le 00:00 e le 04:59 portano alla
        // sera di ieri, anche nelle notti del cambio d'ora.
        const ieri = new Date(`${date}T12:00:00Z`);
        ieri.setUTCDate(ieri.getUTCDate() - 1);
        return { date: ieri.toISOString().slice(0, 10), shift: 'DINNER', anchor: new Date(at.getTime() - 6 * 3600 * 1000) };
    }
    return { date, shift: hour < DINNER_START_HOUR ? 'LUNCH' : 'DINNER', anchor: at };
};

/** Il giorno di servizio di un istante nel fuso `tz`: un walk-in delle 00:30 è
 *  della cena di ieri. Vuoto per un istante mancante o illeggibile, come
 *  getDatePartInTz. */
export const serviceDayInTz = (iso: string | Date | null | undefined, tz: string): string => {
    if (!iso) return '';
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return currentServiceInTz(d, tz).date;
};
