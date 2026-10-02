/* «Il tuo turno è cambiato»: come si legge il giorno di una persona e come si
 * racconta il cambio.
 *
 * La lettura è quella della griglia turni (slotState in StaffManagement.tsx):
 * una riga esplicita vince sempre; poi un'assenza; poi il riposo settimanale;
 * poi la presenza automatica dei contratti Fisso e Stagionale dentro il
 * periodo di assunzione. Se le due regole divergono, l'avviso direbbe un
 * turno diverso da quello che il responsabile vede sullo schermo.
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

const weekdayOf = (date: string): number =>
    new Date(`${date}T00:00:00Z`).getUTCDay();

/** Il giorno di una persona in una parola o due: «pranzo e cena», «cena»,
 *  «riposo», «malattia», «nessun turno». */
export function shiftDayLabel(
    staff: ShiftDayStaff,
    date: string,
    shifts: ShiftDayRow[],
    timeOffs: ShiftDayTimeOff[],
): string {
    const auto = (staff.staffType === 'FISSO' || staff.staffType === 'STAGIONALE')
        && (!staff.hireDate || date >= staff.hireDate)
        && (!staff.contractEndDate || date <= staff.contractEndDate);
    const restDay = staff.weeklyRestDay !== null && weekdayOf(date) === staff.weeklyRestDay;
    let offType: string | null = null;

    const onDuty = (shift: ShiftCode): boolean => {
        const explicit = shifts.find(s => s.date === date && s.shift === shift);
        if (explicit) return explicit.present;
        const off = timeOffs.find(t => date >= t.startDate && date <= t.endDate && (t.shift == null || t.shift === shift));
        if (off) { offType = off.type; return false; }
        if (restDay) return false;
        return auto;
    };

    const lunch = onDuty('LUNCH');
    const dinner = onDuty('DINNER');
    if (lunch && dinner) return 'pranzo e cena';
    if (lunch) return 'pranzo';
    if (dinner) return 'cena';
    if (offType) return TIME_OFF_LABEL[offType] ?? 'assenza';
    if (restDay || auto) return 'riposo';
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
