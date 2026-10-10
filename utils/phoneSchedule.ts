// Chi risponde adesso (docs/telefono-piano.md, Fase 3): la regola di base,
// le fasce orarie e l'interruttore rapido «risponde Sofia / il locale
// adesso». Funzioni pure, usate dal server per decidere lo squillo e dalla
// testata del CRM per mostrare lo stato: le due non possono divergere.
// Nessun import: il file è condiviso fra server (ESM) e SPA.

export type PhoneAnswerMode = 'solo_sofia' | 'prima_locale';

/** Una fascia: nei giorni indicati (1 = lunedì … 7 = domenica), dalle
 *  start alle end, vale il suo mode. Se end < start la fascia passa la
 *  mezzanotte e il pezzo dopo le 00:00 appartiene al giorno di partenza. */
export interface PhoneRoutingSlot {
    days: number[];
    start: string;
    end: string;
    mode: PhoneAnswerMode;
}

/** L'interruttore rapido: vale fino a `until` (ISO), poi torna la regola. */
export interface PhoneRoutingOverride {
    mode: PhoneAnswerMode;
    until: string;
}

export interface EffectivePhoneMode {
    mode: PhoneAnswerMode;
    source: 'override' | 'slot' | 'base';
    /** Quando cambia da sola (fine dell'interruttore o della fascia). */
    until: string | null;
}

export const PHONE_SLOTS_MAX = 8;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isHHMM = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v);
const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();
const fmtFor = (tz: string): Intl.DateTimeFormat => {
    let f = fmtCache.get(tz);
    if (!f) {
        try {
            f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        } catch {
            f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        }
        fmtCache.set(tz, f);
    }
    return f;
};

/** Giorno della settimana (1–7) e minuti dalla mezzanotte, nel fuso del locale. */
export const wallClock = (now: Date, tz: string): { day: number; minutes: number } => {
    const parts = fmtFor(tz).formatToParts(now);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return { day: WEEKDAYS[get('weekday')] ?? 1, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
};

const prevDay = (day: number): number => (day === 1 ? 7 : day - 1);

/** Minuti che mancano alla fine della fascia, se adesso ci siamo dentro. */
const minutesLeftInSlot = (slot: PhoneRoutingSlot, day: number, minutes: number): number | null => {
    const s = toMinutes(slot.start);
    const e = toMinutes(slot.end);
    if (s < e) {
        return slot.days.includes(day) && minutes >= s && minutes < e ? e - minutes : null;
    }
    if (slot.days.includes(day) && minutes >= s) return 24 * 60 - minutes + e;
    if (slot.days.includes(prevDay(day)) && minutes < e) return e - minutes;
    return null;
};

const plusMinutes = (now: Date, minutes: number): string =>
    new Date(Math.floor(now.getTime() / 60_000) * 60_000 + minutes * 60_000).toISOString();

/** Chi risponde adesso: l'interruttore se non è scaduto, poi la prima
 *  fascia che contiene questo momento, poi la regola di base. */
export const effectivePhoneMode = (
    routing: { mode: PhoneAnswerMode; slots?: PhoneRoutingSlot[]; override?: PhoneRoutingOverride | null },
    now: Date,
    tz: string,
): EffectivePhoneMode => {
    const o = routing.override;
    if (o && Date.parse(o.until) > now.getTime()) return { mode: o.mode, source: 'override', until: o.until };
    const { day, minutes } = wallClock(now, tz);
    for (const slot of routing.slots ?? []) {
        const left = minutesLeftInSlot(slot, day, minutes);
        if (left != null) return { mode: slot.mode, source: 'slot', until: plusMinutes(now, left) };
    }
    return { mode: routing.mode, source: 'base', until: null };
};

/** «Fino a stanotte»: le 4 del mattino dopo, quando il servizio è finito. */
export const untilTonight = (now: Date, tz: string): string => {
    const { minutes } = wallClock(now, tz);
    const left = (4 * 60 - minutes + 24 * 60) % (24 * 60) || 24 * 60;
    return plusMinutes(now, left);
};

/** Una fascia ben fatta, normalizzata (giorni unici e ordinati), o null. */
export const parsePhoneSlot = (raw: any): PhoneRoutingSlot | null => {
    if (!raw || typeof raw !== 'object') return null;
    const days = Array.isArray(raw.days)
        ? [...new Set(raw.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 1 && d <= 7))].sort() as number[]
        : [];
    if (days.length === 0 || !isHHMM(raw.start) || !isHHMM(raw.end) || raw.start === raw.end) return null;
    if (raw.mode !== 'solo_sofia' && raw.mode !== 'prima_locale') return null;
    return { days, start: raw.start, end: raw.end, mode: raw.mode };
};
