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
