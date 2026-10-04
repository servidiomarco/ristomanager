/* «Il tuo turno è cambiato»: come si legge il giorno di una persona e come si
 * racconta il cambio.
 *
 * La lettura è quella della griglia turni (slotState in StaffManagement.tsx):
 * una riga esplicita vince sempre; poi un'assenza; poi il riposo settimanale;
 * poi la presenza automatica dei contratti Fisso e Stagionale dentro il
 * periodo di assunzione. Se le due regole divergono, l'avviso direbbe un
 * turno diverso da quello che il responsabile vede sullo schermo. La stessa
 * lettura, isOnDuty, dice al server chi è di turno (GET /staff/presence, i
 * camerieri della Sala dal vivo): una regola sola invece di tre copie.
 *
 * Vive in utils/ perché è pura: il server la usa per l'avviso, i test la
 * verificano senza passare dalla coda con ritardo.
 */

export type ShiftCode = 'LUNCH' | 'DINNER';

export interface ShiftDayStaff {
    staffType: string;               // FISSO | STAGIONALE | EXTRA
    weeklyRestDay: number | null;    // 0 = domenica, come Date.getDay
    hireDate: string | null;         // YYYY-MM-DD
    contractEndDate: string | null;  // YYYY-MM-DD
}

export interface ShiftDayRow {
    date: string;
    shift: string;
    present: boolean;
}

export interface ShiftDayTimeOff {
    startDate: string;
    endDate: string;
    shift: string | null;
    type: string;                    // RIPOSO | VACANZA | MALATTIA | PERMESSO
}

const TIME_OFF_LABEL: Record<string, string> = {
    RIPOSO: 'riposo',
    VACANZA: 'ferie',
    MALATTIA: 'malattia',
    PERMESSO: 'permesso',
};

// Il giorno della settimana della data in sé (0 = domenica), letto in UTC:
// il fuso del server o del dispositivo non lo sposta mai a ieri.
const weekdayOf = (date: string): number =>
    new Date(`${date}T00:00:00Z`).getUTCDay();

/** Il contratto mette la persona in servizio da sola: Fisso e Stagionale,
 *  dentro il periodo di assunzione (una data che manca è un confine aperto). */
const implicitlyOnDuty = (staff: ShiftDayStaff, date: string): boolean =>
    (staff.staffType === 'FISSO' || staff.staffType === 'STAGIONALE')
    && (!staff.hireDate || date >= staff.hireDate)
    && (!staff.contractEndDate || date <= staff.contractEndDate);

const isRestDay = (staff: ShiftDayStaff, date: string): boolean =>
    staff.weeklyRestDay !== null && weekdayOf(date) === staff.weeklyRestDay;

const explicitRow = (shifts: readonly ShiftDayRow[], date: string, shift: ShiftCode): ShiftDayRow | undefined =>
    shifts.find(s => s.date === date && s.shift === shift);

const coveringTimeOff = (timeOffs: readonly ShiftDayTimeOff[], date: string, shift: ShiftCode): ShiftDayTimeOff | undefined =>
    timeOffs.find(t => date >= t.startDate && date <= t.endDate && (t.shift == null || t.shift === shift));

/** Una persona è in servizio in quel turno di quel giorno: la lettura della
 *  griglia turni (slotState). La riga esplicita vince sempre (presente o
 *  assente); poi un'assenza che copre il giorno intero o quel turno; poi il
 *  riposo settimanale; poi la presenza implicita di Fisso e Stagionale nel
 *  periodo di contratto. Chi è inattivo lo esclude chi chiama. */
export function isOnDuty(
    staff: ShiftDayStaff,
    date: string,
    shift: ShiftCode,
    shifts: readonly ShiftDayRow[],
    timeOffs: readonly ShiftDayTimeOff[],
): boolean {
    const explicit = explicitRow(shifts, date, shift);
    if (explicit) return explicit.present;
    if (coveringTimeOff(timeOffs, date, shift)) return false;
    if (isRestDay(staff, date)) return false;
    return implicitlyOnDuty(staff, date);
}

/** Il giorno di una persona in una parola o due: «pranzo e cena», «cena»,
 *  «riposo», «malattia», «nessun turno». */
export function shiftDayLabel(
    staff: ShiftDayStaff,
    date: string,
    shifts: readonly ShiftDayRow[],
    timeOffs: readonly ShiftDayTimeOff[],
): string {
    const lunch = isOnDuty(staff, date, 'LUNCH', shifts, timeOffs);
    const dinner = isOnDuty(staff, date, 'DINNER', shifts, timeOffs);
    if (lunch && dinner) return 'pranzo e cena';
    if (lunch) return 'pranzo';
    if (dinner) return 'cena';
    // Il nome dell'assenza che ha deciso un turno (senza riga esplicita), la
    // cena sopra il pranzo: quando il giorno è fermo, è lei a dire perché.
    let offType: string | null = null;
    for (const shift of ['LUNCH', 'DINNER'] as const) {
        if (explicitRow(shifts, date, shift)) continue;
        const off = coveringTimeOff(timeOffs, date, shift);
        if (off) offType = off.type;
    }
    if (offType) return TIME_OFF_LABEL[offType] ?? 'assenza';
    if (isRestDay(staff, date) || implicitlyOnDuty(staff, date)) return 'riposo';
    return 'nessun turno';
}

export interface ShiftDayChange {
    date: string;
    before: string;
    after: string;
}

const dayFormat = new Intl.DateTimeFormat('it-IT', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
});

/** «ven 3 ott: cena → riposo · sab 4 ott: riposo → pranzo e cena». Oltre
 *  quattro giorni il resto si conta: la notifica si legge sul blocco schermo. */
export function describeShiftChanges(changes: ShiftDayChange[]): string {
    const sorted = [...changes].sort((a, b) => a.date.localeCompare(b.date));
    const parts = sorted.slice(0, 4).map(c =>
        `${dayFormat.format(new Date(`${c.date}T00:00:00Z`)).replace(/\./g, '')}: ${c.before} → ${c.after}`);
    const rest = sorted.length - 4;
    if (rest > 0) parts.push(rest === 1 ? 'e un altro giorno' : `e altri ${rest} giorni`);
    return parts.join(' · ');
}
