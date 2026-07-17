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

// Returns YYYY-MM-DD in Europe/Rome. `sv-SE` locale renders dates in ISO order
// which matches the string format used everywhere else in the app
// (selectedDate, event dates, filter comparisons).
export const getRomeDatePart = (iso: string | Date | null | undefined): string => {
    if (!iso) return '';
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('sv-SE', { timeZone: ROME });
};

// Returns HH:MM in Europe/Rome (24h, zero-padded). Used by the palette and
// anywhere the wall-clock hour is displayed.
export const getRomeTimePart = (iso: string | Date | null | undefined): string => {
    if (!iso) return '';
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('it-IT', {
        timeZone: ROME,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
};
