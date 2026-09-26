// Piano ferie: la logica pura, condivisa fra server (saldi, proposta,
// validazione delle richieste) e client (il conteggio dei giorni mentre il
// dipendente sceglie le date). Nessun import, così gira identica nei due
// mondi e i due numeri non possono divergere.
//
// Le date sono stringhe YYYY-MM-DD e l'aritmetica passa da Date.UTC: il
// giorno di calendario non deve mai attraversare un fuso (il cambio d'ora
// di fine ottobre spostava di un giorno un ciclo fatto con setDate locale).

export type LeaveCategory = 'SALA' | 'CUCINA';
export type LeaveService = 'LUNCH' | 'DINNER';
export type LeavePriority = 'FIRST_COME' | 'FEWEST_DAYS';

export const LEAVE_CATEGORIES: LeaveCategory[] = ['SALA', 'CUCINA'];
export const LEAVE_SERVICES: LeaveService[] = ['LUNCH', 'DINNER'];

// Una richiesta più lunga è quasi certamente un errore di data (un anno
// scritto male), non ferie: il cap protegge anche i cicli qui sotto.
export const MAX_LEAVE_SPAN_DAYS = 62;

export interface LeaveStaff {
    id: string;
    category: LeaveCategory;
    staffType: 'FISSO' | 'STAGIONALE' | 'EXTRA';
    weeklyRestDay: number | null;
    hireDate: string | null;
    contractEndDate: string | null;
    isActive: boolean;
}

export interface LeaveShiftRow {
    staffId: string;
    date: string;
    shift: LeaveService;
    present: boolean;
}

export interface LeaveAbsence {
    staffId: string;
    startDate: string;
    endDate: string;
    shift: LeaveService | null; // null = giornata intera
}

export interface LeaveRequestLike {
    id: string;
    staffId: string;
    startDate: string;
    endDate: string;
    createdAt: string;
}

/** Quando il ristorante lavora. `weekly` per giorno della settimana
 *  (0 = domenica, come Date.getDay); un giorno senza orari configurati
 *  conta come aperto — meglio una copertura prudente che un buco. */
export interface OpeningCalendar {
    weekly: Partial<Record<number, Record<LeaveService, boolean>>>;
    closures: Array<{ date: string; shift: LeaveService | null }>;
}

export type CoverageMinimums = Record<LeaveCategory, Record<LeaveService, number>>;

export type ServiceOpen = (date: string, service: LeaveService) => boolean;

// ── Date ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

const toUtc = (d: string): number =>
    Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));

const fromUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Una data vera, non solo una stringa della forma giusta: «2026-02-30» no. */
export const isIsoDay = (s: unknown): s is string =>
    typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUtc(toUtc(s)) === s;

export const weekdayOf = (date: string): number => new Date(toUtc(date)).getUTCDay();

export const addIsoDays = (date: string, n: number): string => fromUtc(toUtc(date) + n * DAY_MS);

/** Giorni di calendario da start a end compresi. Vuoto se l'ordine è
 *  sbagliato; troncato a 400 per non girare all'infinito su input sporco. */
export const eachIsoDay = (start: string, end: string): string[] => {
    const out: string[] = [];
    const last = toUtc(end);
    for (let t = toUtc(start); t <= last && out.length < 400; t += DAY_MS) out.push(fromUtc(t));
    return out;
};

export const spanDays = (start: string, end: string): number =>
    Math.round((toUtc(end) - toUtc(start)) / DAY_MS) + 1;

// ── Calendario del ristorante ───────────────────────────────────────────

export const makeServiceOpen = (cal: OpeningCalendar): ServiceOpen => {
    const closedDay = new Set<string>();
    const closedService = new Set<string>();
    for (const c of cal.closures) {
        if (c.shift) closedService.add(`${c.date}|${c.shift}`);
        else closedDay.add(c.date);
    }
    return (date, service) => {
        if (closedDay.has(date) || closedService.has(`${date}|${service}`)) return false;
        const w = cal.weekly[weekdayOf(date)];
        return w ? w[service] : true;
    };
};

// ── Conteggio dei giorni ────────────────────────────────────────────────

/** Quanto costa ogni giorno di un'assenza sul monte ferie: i giorni in cui
 *  la persona avrebbe lavorato. Il riposo settimanale e i giorni in cui il
 *  ristorante è chiuso a pranzo E a cena non si pagano; un'assenza su un
 *  solo servizio vale mezza giornata, se quel servizio è aperto. */
export const leaveDayWeights = (
    restDay: number | null,
    start: string,
    end: string,
    isOpen: ServiceOpen,
    shift: LeaveService | null = null,
): Array<{ date: string; weight: number }> => {
    const out: Array<{ date: string; weight: number }> = [];
    for (const date of eachIsoDay(start, end)) {
        if (restDay !== null && restDay !== undefined && weekdayOf(date) === restDay) continue;
        if (shift) {
            if (isOpen(date, shift)) out.push({ date, weight: 0.5 });
        } else if (isOpen(date, 'LUNCH') || isOpen(date, 'DINNER')) {
            out.push({ date, weight: 1 });
        }
    }
    return out;
};

export const countLeaveDays = (
    restDay: number | null,
    start: string,
    end: string,
    isOpen: ServiceOpen,
    shift: LeaveService | null = null,
): number => leaveDayWeights(restDay, start, end, isOpen, shift).reduce((n, d) => n + d.weight, 0);

/** Lo stesso conteggio, diviso per anno solare: una richiesta dal 28
 *  dicembre al 3 gennaio pesa su due monti diversi. */
export const leaveDaysByYear = (
    restDay: number | null,
    start: string,
    end: string,
    isOpen: ServiceOpen,
    shift: LeaveService | null = null,
): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const d of leaveDayWeights(restDay, start, end, isOpen, shift)) {
        const y = d.date.slice(0, 4);
        out[y] = (out[y] ?? 0) + d.weight;
    }
    return out;
};

// ── Chi è in servizio ───────────────────────────────────────────────────

/** Stessa semantica di GET /staff/presence: un'assenza toglie dal turno,
 *  un turno esplicito decide, altrimenti il FISSO è in servizio nel periodo
 *  di contratto tranne il giorno di riposo; STAGIONALE ed EXTRA solo coi
 *  turni inseriti. Sul futuro lontano quindi la copertura conta i fissi
 *  più i turni già messi in calendario — è l'informazione che esiste. */
export const makeDutyIndex = (shifts: LeaveShiftRow[], absences: LeaveAbsence[]) => {
    const explicit = new Map<string, boolean>();
    for (const s of shifts) explicit.set(`${s.staffId}|${s.date}|${s.shift}`, s.present);
    const offDay = new Set<string>();
    const offService = new Set<string>();
    for (const a of absences) {
        for (const date of eachIsoDay(a.startDate, a.endDate)) {
            if (a.shift) offService.add(`${a.staffId}|${date}|${a.shift}`);
            else offDay.add(`${a.staffId}|${date}`);
        }
    }
    return (s: LeaveStaff, date: string, service: LeaveService): boolean => {
        if (!s.isActive) return false;
        if (offDay.has(`${s.id}|${date}`) || offService.has(`${s.id}|${date}|${service}`)) return false;
        const e = explicit.get(`${s.id}|${date}|${service}`);
        if (e !== undefined) return e;
        if (s.staffType !== 'FISSO') return false;
        if (s.weeklyRestDay !== null && s.weeklyRestDay !== undefined && weekdayOf(date) === s.weeklyRestDay) return false;
        if (s.hireDate && s.hireDate > date) return false;
        if (s.contractEndDate && s.contractEndDate < date) return false;
        return true;
    };
};

// ── Copertura giorno per giorno ─────────────────────────────────────────

/** Per ogni giorno da `from`, reparto e servizio: quante persone sono in
 *  servizio (-1 = ristorante chiuso) e quante ne mancherebbero se si
 *  approvasse tutto ciò che è in attesa. Array paralleli invece di un
 *  oggetto per giorno: un anno intero viaggia in pochi KB. */
export interface CoverageTimeline {
    from: string;
    onDuty: Record<LeaveCategory, Record<LeaveService, number[]>>;
    pendingLoss: Record<LeaveCategory, Record<LeaveService, number[]>>;
}

export const coverageTimeline = (input: {
    staff: LeaveStaff[];
    shifts: LeaveShiftRow[];
    absences: LeaveAbsence[];
    pending: LeaveRequestLike[];
    isOpen: ServiceOpen;
    from: string;
    to: string;
}): CoverageTimeline => {
    const isOnDuty = makeDutyIndex(input.shifts, input.absences);
    const byId = new Map(input.staff.map(s => [s.id, s]));
    const pendingOff = new Map<string, Set<string>>(); // date → staffId in attesa
    for (const r of input.pending) {
        for (const date of eachIsoDay(r.startDate, r.endDate)) {
            let set = pendingOff.get(date);
            if (!set) pendingOff.set(date, set = new Set());
            set.add(r.staffId);
        }
    }
    const empty = () => ({ LUNCH: [] as number[], DINNER: [] as number[] });
    const onDuty = { SALA: empty(), CUCINA: empty() };
    const pendingLoss = { SALA: empty(), CUCINA: empty() };
    for (const date of eachIsoDay(input.from, input.to)) {
        const off = pendingOff.get(date);
        for (const service of LEAVE_SERVICES) {
            const open = input.isOpen(date, service);
            for (const cat of LEAVE_CATEGORIES) {
                if (!open) {
                    onDuty[cat][service].push(-1);
                    pendingLoss[cat][service].push(0);
                    continue;
                }
                let n = 0;
                for (const s of input.staff) if (s.category === cat && isOnDuty(s, date, service)) n++;
                let loss = 0;
                if (off) {
                    for (const id of off) {
                        const s = byId.get(id);
                        if (s && s.category === cat && isOnDuty(s, date, service)) loss++;
                    }
                }
                onDuty[cat][service].push(n);
                pendingLoss[cat][service].push(loss);
            }
        }
    }
    return { from: input.from, onDuty, pendingLoss };
};

// ── Proposta automatica ─────────────────────────────────────────────────

export type ProposalReason =
    | { kind: 'COVERAGE'; date: string; service: LeaveService; category: LeaveCategory; left: number; min: number }
    | { kind: 'BALANCE'; year: string; over: number };

export interface ProposalItem {
    requestId: string;
    verdict: 'APPROVE' | 'REJECT';
    days: number;
    reasons: ProposalReason[];
}

// Bastano i primi giorni scoperti per capire perché: la lista completa di
// un mese sotto soglia non aggiunge niente a chi deve decidere.
const MAX_COVERAGE_REASONS = 5;

/** Decide, richiesta per richiesta, quali si possono accogliere senza
 *  scendere sotto la copertura minima e senza sforare il monte ferie.
 *  Greedy nell'ordine di priorità: chi viene prima ottiene le date, chi
 *  viene dopo trova la copertura già ridotta dalle richieste accolte. Non
 *  spezza le richieste: accogliere metà ferie è una trattativa, non un
 *  calcolo. */
export const proposeLeavePlan = (input: {
    staff: LeaveStaff[];
    shifts: LeaveShiftRow[];
    absences: LeaveAbsence[];          // solo quelle già in calendario
    pending: LeaveRequestLike[];
    minimums: CoverageMinimums;
    isOpen: ServiceOpen;
    priority: LeavePriority;
    entitlement: (staffId: string) => number | null;
    usedDays: (staffId: string, year: string) => number;
}): ProposalItem[] => {
    const isOnDuty = makeDutyIndex(input.shifts, input.absences);
    const byId = new Map(input.staff.map(s => [s.id, s]));

    const countCache = new Map<string, number>();
    const baseCount = (date: string, service: LeaveService, cat: LeaveCategory): number => {
        const key = `${date}|${service}|${cat}`;
        let n = countCache.get(key);
        if (n === undefined) {
            n = 0;
            for (const s of input.staff) if (s.category === cat && isOnDuty(s, date, service)) n++;
            countCache.set(key, n);
        }
        return n;
    };

    const ordered = [...input.pending].sort((a, b) => {
        if (input.priority === 'FEWEST_DAYS') {
            const ua = input.usedDays(a.staffId, a.startDate.slice(0, 4));
            const ub = input.usedDays(b.staffId, b.startDate.slice(0, 4));
            if (ua !== ub) return ua - ub;
        }
        return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });

    // Persone già tolte dalle richieste accolte finora, per giorno e servizio,
    // e giorni già impegnati sul monte di ciascuno.
    const acceptedLoss = new Map<string, number>();
    const acceptedDays = new Map<string, number>(); // `${staffId}|${year}`
    const acceptedOff = new Set<string>();           // `${staffId}|${date}`

    const out: ProposalItem[] = [];
    for (const r of ordered) {
        const s = byId.get(r.staffId);
        if (!s) continue;
        const weights = leaveDayWeights(s.weeklyRestDay, r.startDate, r.endDate, input.isOpen);
        const days = weights.reduce((n, d) => n + d.weight, 0);
        const reasons: ProposalReason[] = [];

        const touched: string[] = [];
        for (const date of eachIsoDay(r.startDate, r.endDate)) {
            if (acceptedOff.has(`${s.id}|${date}`)) continue;
            for (const service of LEAVE_SERVICES) {
                if (!input.isOpen(date, service) || !isOnDuty(s, date, service)) continue;
                const key = `${date}|${service}|${s.category}`;
                touched.push(key);
                const min = input.minimums[s.category][service];
                if (min <= 0) continue;
                const left = baseCount(date, service, s.category) - (acceptedLoss.get(key) ?? 0) - 1;
                if (left < min && reasons.length < MAX_COVERAGE_REASONS) {
                    reasons.push({ kind: 'COVERAGE', date, service, category: s.category, left: Math.max(0, left), min });
                }
            }
        }

        const ent = input.entitlement(s.id);
        const byYear: Record<string, number> = {};
        for (const d of weights) byYear[d.date.slice(0, 4)] = (byYear[d.date.slice(0, 4)] ?? 0) + d.weight;
        if (ent !== null) {
            for (const [year, need] of Object.entries(byYear)) {
                const used = input.usedDays(s.id, year) + (acceptedDays.get(`${s.id}|${year}`) ?? 0);
                const over = used + need - ent;
                if (over > 1e-9) reasons.push({ kind: 'BALANCE', year, over: Math.round(over * 2) / 2 });
            }
        }

        const verdict = reasons.length === 0 ? 'APPROVE' : 'REJECT';
        if (verdict === 'APPROVE') {
            for (const key of touched) acceptedLoss.set(key, (acceptedLoss.get(key) ?? 0) + 1);
            for (const date of eachIsoDay(r.startDate, r.endDate)) acceptedOff.add(`${s.id}|${date}`);
            for (const [year, need] of Object.entries(byYear)) {
                acceptedDays.set(`${s.id}|${year}`, (acceptedDays.get(`${s.id}|${year}`) ?? 0) + need);
            }
        }
        out.push({ requestId: r.id, verdict, days, reasons });
    }
    return out;
};
