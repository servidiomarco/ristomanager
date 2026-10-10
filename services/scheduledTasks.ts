/* Attività programmate — le attività che il ristorante si fa creare da solo
   in Attività: «Ordinare merce» qualche giorno prima di ogni banchetto, il
   pane la sera prima, la pulizia della cappa ogni lunedì.

   Fino all'ottobre 2026 erano scritte nel codice: tre promemoria fissi per
   ogni banchetto (72/48/24 h prima, alla Cucina, testo e priorità in
   server.ts) e il «Promemoria pane» con la sua formula. Ora ogni attività è
   una riga di scheduled_tasks che il ristorante crea, cambia ed elimina da
   Impostazioni › Attività programmate; quelle di prima sono diventate righe
   come le altre (migration attivita-programmate).

   Tre tipi:
   - BANQUET   — per ogni banchetto, `days_before` giorni prima, all'ora
                 `schedule_time`. I banchetti dello stesso giorno finiscono
                 nella stessa attività (linked_banquet_ids), come prima.
   - RECURRING — ogni giorno / i giorni della settimana / un giorno del mese.
   - ONE_OFF   — una data, poi la riga si spegne.

   L'attività nasce all'ora stabilita, non quando si salva il banchetto: prima
   «Ordinare merce» per un banchetto di maggio stava in Attività da settembre,
   e la cucina la spuntava mesi prima. Il banchetto inserito in ritardo (il
   giorno stabilito è già passato) la fa nascere subito.

   Titolo e descrizione sono modelli: {data}, {coperti}, {quantità} e
   {banchetti} si riempiono quando l'attività nasce (renderTaskTemplate). */
import express from 'express';
import type { Request } from 'express';
import { queryWithRetry } from '../db.js';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';
import { canAssignToRole } from '../auth/permissions.js';
import { UserRole } from '../types.js';
import { getTenantLocale } from './tenantLocale.js';

export type ScheduledTaskKind = 'BANQUET' | 'RECURRING' | 'ONE_OFF';
export type ScheduledTaskFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type ScheduledTaskScope = 'ALL' | 'CONFIRMED';
export type ScheduledTaskPriority = 'LOW' | 'MEDIUM' | 'HIGH';

export const SCHEDULED_TASK_TEAMS = ['OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'KITCHEN', 'CASSA'] as const;
export const SCHEDULED_TASK_CATEGORIES = ['GENERAL', 'RESERVATION', 'INVENTORY', 'STAFF', 'MAINTENANCE', 'EVENT'] as const;
const WEEKDAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** I limiti del modulo, condivisi con i test. */
export const SCHEDULED_TASK_LIMITS = {
    titleMax: 200,
    descriptionMax: 1000,
    daysBeforeMax: 60,
    dueInDaysMax: 30,
    coversPerUnitMax: 1000,
} as const;

export interface ScheduledTaskInput {
    title: string;
    description: string | null;
    kind: ScheduledTaskKind;
    days_before: number | null;
    banquet_scope: ScheduledTaskScope;
    frequency: ScheduledTaskFrequency | null;
    weekdays: string[] | null;
    month_day: number | null;
    schedule_date: string | null;
    schedule_time: string;
    due_in_days: number;
    covers_per_unit: number | null;
    assigned_team: string;
    priority: ScheduledTaskPriority;
    category: string;
    active: boolean;
}

export interface ScheduledTask extends ScheduledTaskInput {
    id: number;
    tenant_id: number;
    released_through: string | null;
    last_run_at: Date | string | null;
}

/** Le colonne di todos come le leggono il client e i socket (stessa forma di
 *  GET /todos). Sta qui perché la usano anche le rotte di server.ts. */
export const TODO_FULL_SELECT = `
    id,
    title,
    description,
    completed,
    priority,
    category,
    TO_CHAR(due_date, 'YYYY-MM-DD') as "dueDate",
    created_at as "createdAt",
    completed_at as "completedAt",
    linked_reservation_id as "linkedReservationId",
    linked_banquet_ids as "linkedBanquetIds",
    banquet_reminder_hours as "banquetReminderHours",
    auto_kind as "autoKind",
    scheduled_task_id as "scheduledTaskId",
    assigned_to_user_id as "assignedToUserId",
    assigned_to_user_name as "assignedToUserName",
    assigned_to_team as "assignedToTeam",
    created_by_user_id as "createdByUserId",
    created_by_user_name as "createdByUserName"
`;

const TASK_SELECT = `
    id, tenant_id, title, description, kind, days_before, banquet_scope, frequency,
    weekdays, month_day, TO_CHAR(schedule_date, 'YYYY-MM-DD') AS schedule_date,
    schedule_time, due_in_days, covers_per_unit, assigned_team, priority, category,
    active, TO_CHAR(released_through, 'YYYY-MM-DD') AS released_through,
    last_run_at, created_at, updated_at
`;

// ── Funzioni pure ───────────────────────────────────────────────────────────

const isIsoDate = (v: unknown): v is string =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

const isInt = (v: unknown, min: number, max: number): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Valida il corpo di POST/PUT. tenant_id non arriva mai dal client. */
export function normalizeScheduledTaskPayload(body: any):
    { ok: true; data: ScheduledTaskInput } | { ok: false; error: string } {
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) return { ok: false, error: 'Il titolo è obbligatorio' };
    if (title.length > SCHEDULED_TASK_LIMITS.titleMax) return { ok: false, error: 'Titolo troppo lungo' };

    const rawDescription = typeof body?.description === 'string' ? body.description.trim() : '';
    if (rawDescription.length > SCHEDULED_TASK_LIMITS.descriptionMax) return { ok: false, error: 'Descrizione troppo lunga' };
    const description = rawDescription || null;

    const kind = body?.kind;
    if (kind !== 'BANQUET' && kind !== 'RECURRING' && kind !== 'ONE_OFF') return { ok: false, error: 'Tipo non valido' };

    const schedule_time = typeof body?.schedule_time === 'string' ? body.schedule_time : '';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule_time)) return { ok: false, error: 'Orario non valido (HH:MM)' };

    let days_before: number | null = null;
    let banquet_scope: ScheduledTaskScope = 'ALL';
    let frequency: ScheduledTaskFrequency | null = null;
    let weekdays: string[] | null = null;
    let month_day: number | null = null;
    let schedule_date: string | null = null;
    let due_in_days = 0;

    if (kind === 'BANQUET') {
        if (!isInt(body?.days_before, 0, SCHEDULED_TASK_LIMITS.daysBeforeMax)) {
            return { ok: false, error: `Giorni prima del banchetto: da 0 a ${SCHEDULED_TASK_LIMITS.daysBeforeMax}` };
        }
        days_before = body.days_before;
        if (body?.banquet_scope !== undefined && body.banquet_scope !== 'ALL' && body.banquet_scope !== 'CONFIRMED') {
            return { ok: false, error: 'Banchetti non validi' };
        }
        banquet_scope = body?.banquet_scope === 'CONFIRMED' ? 'CONFIRMED' : 'ALL';
    } else {
        if (body?.due_in_days !== undefined && body?.due_in_days !== null) {
            if (!isInt(body.due_in_days, 0, SCHEDULED_TASK_LIMITS.dueInDaysMax)) {
                return { ok: false, error: `Scadenza: da 0 a ${SCHEDULED_TASK_LIMITS.dueInDaysMax} giorni` };
            }
            due_in_days = body.due_in_days;
        }
        if (kind === 'ONE_OFF') {
            if (!isIsoDate(body?.schedule_date)) return { ok: false, error: 'Data non valida' };
            schedule_date = body.schedule_date;
        } else {
            frequency = body?.frequency;
            if (frequency !== 'DAILY' && frequency !== 'WEEKLY' && frequency !== 'MONTHLY') {
                return { ok: false, error: 'Frequenza non valida' };
            }
            if (frequency === 'WEEKLY') {
                const days: string[] = Array.isArray(body?.weekdays)
                    ? Array.from(new Set(body.weekdays.map((d: unknown) => String(d).toUpperCase())))
                    : [];
                if (days.length === 0 || days.some(d => !WEEKDAY_CODES.includes(d))) {
                    return { ok: false, error: 'Scegli almeno un giorno della settimana' };
                }
                weekdays = WEEKDAY_CODES.filter(d => days.includes(d));
            }
            if (frequency === 'MONTHLY') {
                if (!isInt(body?.month_day, 1, 28)) return { ok: false, error: 'Giorno del mese: da 1 a 28' };
                month_day = body.month_day;
            }
        }
    }

    let covers_per_unit: number | null = null;
    if (body?.covers_per_unit !== undefined && body?.covers_per_unit !== null) {
        if (!isInt(body.covers_per_unit, 1, SCHEDULED_TASK_LIMITS.coversPerUnitMax)) {
            return { ok: false, error: `Coperti per unità: da 1 a ${SCHEDULED_TASK_LIMITS.coversPerUnitMax}` };
        }
        covers_per_unit = body.covers_per_unit;
    }

    const assigned_team = typeof body?.assigned_team === 'string' ? body.assigned_team.toUpperCase() : '';
    if (!(SCHEDULED_TASK_TEAMS as readonly string[]).includes(assigned_team)) return { ok: false, error: 'Squadra non valida' };

    const priority = body?.priority ?? 'MEDIUM';
    if (priority !== 'LOW' && priority !== 'MEDIUM' && priority !== 'HIGH') return { ok: false, error: 'Priorità non valida' };

    const category = body?.category ?? 'GENERAL';
    if (!(SCHEDULED_TASK_CATEGORIES as readonly string[]).includes(category)) return { ok: false, error: 'Categoria non valida' };

    const active = body?.active === undefined ? true : body.active === true;

    return {
        ok: true,
        data: {
            title, description, kind, days_before, banquet_scope, frequency, weekdays, month_day,
            schedule_date, schedule_time, due_in_days, covers_per_unit, assigned_team, priority, category, active,
        },
    };
}

export const addDaysIso = (iso: string, days: number): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().substring(0, 10);
};

/** «7 novembre 2026»: i modelli sono scritti in italiano dal ristorante. */
export const formatDateLongIt = (iso: string): string => {
    try {
        return new Date(`${iso}T00:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    } catch { return iso; }
};

/** Quanto ordinare: una unità ogni `perUnit` coperti, arrotondando in su.
 *  Il pane di prima era 1 kg ogni 10 coperti, con almeno 1 kg se c'è
 *  qualcuno; a sala vuota 0. Senza regola, una unità a coperto. */
export const quantityForCovers = (covers: number, perUnit: number | null): number =>
    covers <= 0 ? 0 : Math.max(1, Math.ceil(covers / (perUnit && perUnit > 0 ? perUnit : 1)));

export interface TemplateVars {
    data: string;      // YYYY-MM-DD
    coperti: number;
    banchetti: string[];
    perUnit: number | null;
}

/** Riempie {data}, {coperti}, {quantità} (anche senza accento) e
 *  {banchetti}. Le graffe con altro dentro restano come sono. */
export const renderTaskTemplate = (template: string, vars: TemplateVars): string =>
    template.replace(/\{\s*(data|coperti|quantit[aà]|banchetti)\s*\}/gi, (_m, key: string) => {
        const k = key.toLowerCase();
        if (k === 'data') return formatDateLongIt(vars.data);
        if (k === 'coperti') return String(vars.coperti);
        if (k === 'banchetti') return vars.banchetti.join(', ');
        return String(quantityForCovers(vars.coperti, vars.perUnit));
    });

export interface LocalNow { date: string; time: string; dow: number }

/** Giorno, ora e giorno della settimana sull'orologio del ristorante. */
export const localNow = (at: Date, tz: string): LocalNow => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(at);
    const get = (t: string) => parts.find(p => p.type === t)?.value || '00';
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    // Intl a volte scrive la mezzanotte come «24»: è l'ora 00 dello stesso giorno.
    const hour = get('hour') === '24' ? '00' : get('hour');
    return { date, time: `${hour}:${get('minute')}`, dow: new Date(`${date}T00:00:00Z`).getUTCDay() };
};

/** L'ultimo giorno stabilito già scoccato: oggi se l'ora è passata, se no ieri. */
export const releasedThroughNow = (now: LocalNow, scheduleTime: string): string =>
    now.time >= scheduleTime ? now.date : addDaysIso(now.date, -1);

/** Un'attività a calendario (RECURRING / ONE_OFF) va creata adesso? Stessa
 *  regola dei promemoria: ora passata, giorno giusto, non già fatta oggi. */
export function isTimedTaskDue(task: Pick<ScheduledTask, 'kind' | 'frequency' | 'weekdays' | 'month_day' | 'schedule_date' | 'schedule_time'>,
    now: LocalNow, lastRunDate: string | null): boolean {
    if (task.kind === 'BANQUET') return false;
    if (now.time < task.schedule_time) return false;
    if (lastRunDate === now.date) return false;
    if (task.kind === 'ONE_OFF') return task.schedule_date === now.date;
    if (task.frequency === 'DAILY') return true;
    if (task.frequency === 'WEEKLY') return (task.weekdays || []).includes(WEEKDAY_CODES[now.dow]);
    if (task.frequency === 'MONTHLY') return task.month_day === Number(now.date.slice(8, 10));
    return false;
}

/** Le finestre della stessa attività: «Ordinare merce» 72, 48 e 24 ore
 *  prima sono tre righe con squadra, categoria e descrizione uguali. Senza
 *  descrizione una riga fa famiglia a sé: meglio un promemoria in più che
 *  saltare un'attività diversa. */
export const banquetTaskFamily = (t: Pick<ScheduledTask, 'id' | 'assigned_team' | 'category' | 'description'>): string => {
    const d = (t.description || '').trim();
    return d ? `${t.assigned_team}|${t.category}|${d}` : `#${t.id}`;
};

/** Banchetto arrivato in ritardo: una finestra già passata (giorno
 *  stabilito prima di oggi) non compare se un'altra finestra della stessa
 *  attività, più vicina all'evento, è già scoccata o scocca oggi — compare
 *  solo l'ultima. Prima un banchetto inserito il giorno prima faceva
 *  nascere 72h e 48h già scadute insieme alla 24h. */
export function isSupersededWindow(
    task: Pick<ScheduledTask, 'id' | 'assigned_team' | 'category' | 'description' | 'days_before' | 'banquet_scope'>,
    banquet: { event_date: string; status: string },
    family: Pick<ScheduledTask, 'id' | 'assigned_team' | 'category' | 'description' | 'days_before' | 'banquet_scope'>[],
    today: string,
): boolean {
    const days = task.days_before ?? 0;
    if (addDaysIso(banquet.event_date, -days) >= today) return false;
    const key = banquetTaskFamily(task);
    return family.some(o => o.id !== task.id
        && banquetTaskFamily(o) === key
        && eligible(o, banquet)
        && (o.days_before ?? 0) < days
        && addDaysIso(banquet.event_date, -(o.days_before ?? 0)) <= today);
}

// ── Database ───────────────────────────────────────────────────────────────

export interface ScheduledTaskPush {
    category: 'system';
    title: string;
    body: string;
    url: string;
    tag: string;
}

export interface ScheduledTaskDeps {
    pushToRoles: (tenantId: number, roles: string[], push: ScheduledTaskPush) => Promise<unknown>;
    markNotificationsRead: (tenantId: number, tags: string[]) => Promise<void>;
    broadcast: (tenantId: number, event: string, data: unknown) => void;
}

const tenantTimezone = async (tenantId: number): Promise<string> => (await getTenantLocale(tenantId)).timezone;

interface BanquetRow { id: number; name: string; guests: number | null; event_date: string; status: string }

const eligible = (task: Pick<ScheduledTask, 'banquet_scope'>, b: Pick<BanquetRow, 'status'>): boolean =>
    task.banquet_scope !== 'CONFIRMED' || b.status === 'CONFIRMED';

const loadBanquetsByIds = async (tenantId: number, ids: number[]): Promise<BanquetRow[]> => {
    if (ids.length === 0) return [];
    const r = await queryWithRetry(
        `SELECT id, name, guests, TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date, status
           FROM banquet_menus WHERE tenant_id = $1 AND id = ANY($2::int[]) ORDER BY id`,
        [tenantId, ids]
    );
    return r.rows;
};

const banquetVars = (task: ScheduledTask, eventDate: string, banquets: BanquetRow[]): TemplateVars => ({
    data: eventDate,
    coperti: banquets.reduce((n, b) => n + (Number(b.guests) || 0), 0),
    banchetti: banquets.map(b => b.name).filter(Boolean),
    perUnit: task.covers_per_unit,
});

/** I coperti attesi in un giorno: prenotazioni non annullate più i
 *  banchetti, che non stanno in reservations (era la formula del pane). Il
 *  giorno della prenotazione si legge sul fuso del ristorante. */
const dayVars = async (tenantId: number, task: ScheduledTask, date: string, tz: string): Promise<TemplateVars> => {
    const r = await queryWithRetry(
        `SELECT
            COALESCE((SELECT SUM(guests) FROM reservations
                       WHERE tenant_id = $1
                         AND (reservation_time AT TIME ZONE $3)::date = $2::date
                         AND COALESCE(reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED')), 0)::int AS prenotati,
            COALESCE((SELECT SUM(guests) FROM banquet_menus WHERE tenant_id = $1 AND event_date = $2::date), 0)::int AS banchetto,
            COALESCE((SELECT array_agg(name ORDER BY id) FROM banquet_menus WHERE tenant_id = $1 AND event_date = $2::date), '{}') AS nomi`,
        [tenantId, date, tz]
    );
    const row = r.rows[0] || {};
    return {
        data: date,
        coperti: (Number(row.prenotati) || 0) + (Number(row.banchetto) || 0),
        banchetti: Array.isArray(row.nomi) ? row.nomi : [],
        perUnit: task.covers_per_unit,
    };
};

const pushForTodo = (deps: ScheduledTaskDeps, tenantId: number, task: ScheduledTask, todo: any): void => {
    // Il tag è quello del todo: spuntato o eliminato in Attività, la
    // campanella si spegne da sola (todoNotificationTags in server.ts), e un
    // secondo invio dello stesso giorno sostituisce il primo invece di sommarsi.
    deps.pushToRoles(tenantId, [task.assigned_team], {
        category: 'system',
        title: 'Attività programmata',
        body: todo.title,
        url: '/?view=ATTIVITA',
        tag: `todo-${todo.id}`,
    }).catch(err => console.error(`[attivita-programmate] push del todo ${todo.id} fallita:`, err?.message || err));
};

const deleteTodo = async (deps: ScheduledTaskDeps, tenantId: number, todoId: string | number): Promise<void> => {
    await queryWithRetry('DELETE FROM todos WHERE id = $1 AND tenant_id = $2', [todoId, tenantId]);
    deps.broadcast(tenantId, 'todo:deleted', { id: todoId });
    await deps.markNotificationsRead(tenantId, [`todo-${todoId}`]).catch(() => {});
};

const updateTodoBanquets = async (deps: ScheduledTaskDeps, tenantId: number, task: ScheduledTask, todo: any,
    ids: number[], eventDate: string): Promise<any> => {
    const banquets = await loadBanquetsByIds(tenantId, ids);
    const vars = banquetVars(task, eventDate, banquets);
    const title = renderTaskTemplate(task.title, vars).slice(0, 500);
    const description = task.description ? renderTaskTemplate(task.description, vars) : null;
    const sameIds = JSON.stringify([...(todo.linkedBanquetIds || [])].sort()) === JSON.stringify([...ids].sort());
    if (sameIds && todo.title === title && (todo.description ?? null) === description) return todo;
    const r = await queryWithRetry(
        `UPDATE todos SET linked_banquet_ids = $1, title = $2, description = $3
          WHERE id = $4 AND tenant_id = $5 RETURNING ${TODO_FULL_SELECT}`,
        [ids, title, description, todo.id, tenantId]
    );
    if (r.rows[0]) deps.broadcast(tenantId, 'todo:updated', r.rows[0]);
    return r.rows[0] || todo;
};

/** Fa sì che i banchetti `candidateIds` del giorno `eventDate` stiano in
 *  un'attività di `task`. Un banchetto già in un'attività di quel giorno —
 *  anche svolta — non ne fa nascere un'altra: era il difetto di prima, quando
 *  ogni deploy e ogni modifica del banchetto ricreavano le attività spuntate. */
async function ensureBanquetOccurrence(deps: ScheduledTaskDeps, tenantId: number, task: ScheduledTask,
    eventDate: string, candidateIds: number[]): Promise<boolean> {
    const due = addDaysIso(eventDate, -(task.days_before ?? 0));
    const existing = await queryWithRetry(
        `SELECT ${TODO_FULL_SELECT} FROM todos
          WHERE tenant_id = $1 AND scheduled_task_id = $2 AND due_date = $3
          ORDER BY created_at`,
        [tenantId, task.id, due]
    );
    const covered = new Set<number>(existing.rows.flatMap((t: any) => (t.linkedBanquetIds || []).map(Number)));
    const missing = candidateIds.filter(id => !covered.has(id));
    if (missing.length === 0) return false;

    const open = existing.rows.find((t: any) => !t.completed);
    if (open) {
        const ids = [...(open.linkedBanquetIds || []).map(Number), ...missing];
        const updated = await updateTodoBanquets(deps, tenantId, task, open, ids, eventDate);
        pushForTodo(deps, tenantId, task, updated);
        return true;
    }
    const banquets = await loadBanquetsByIds(tenantId, missing);
    const vars = banquetVars(task, eventDate, banquets);
    const created = await queryWithRetry(
        `INSERT INTO todos (tenant_id, title, description, priority, category, due_date,
                            assigned_to_team, linked_banquet_ids, scheduled_task_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${TODO_FULL_SELECT}`,
        [tenantId, renderTaskTemplate(task.title, vars).slice(0, 500),
         task.description ? renderTaskTemplate(task.description, vars) : null,
         task.priority, task.category, due, task.assigned_team, missing, task.id]
    );
    if (!created.rows[0]) return false;
    deps.broadcast(tenantId, 'todo:created', created.rows[0]);
    pushForTodo(deps, tenantId, task, created.rows[0]);
    return true;
}

/** Fa nascere le attività di un banchetto-tipo per i banchetti il cui giorno
 *  stabilito cade fra `fromDue` e l'ultimo già scoccato. Gli eventi passati
 *  non contano. Aggiorna released_through. */
async function releaseBanquetTask(deps: ScheduledTaskDeps, task: ScheduledTask, now: LocalNow,
    fromDue: string | null): Promise<void> {
    const rt = releasedThroughNow(now, task.schedule_time);
    const days = task.days_before ?? 0;
    const lowEvent = fromDue ? addDaysIso(fromDue, days) : now.date;
    const fromEvent = lowEvent > now.date ? lowEvent : now.date;
    const toEvent = addDaysIso(rt, days);
    let released = false;
    if (fromEvent <= toEvent) {
        // Le altre finestre attive del ristorante, per saltare quelle superate.
        const family = await loadBanquetTasks(task.tenant_id);
        const r = await queryWithRetry(
            `SELECT id, name, guests, TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date, status
               FROM banquet_menus
              WHERE tenant_id = $1 AND event_date BETWEEN $2::date AND $3::date
              ORDER BY event_date, id`,
            [task.tenant_id, fromEvent, toEvent]
        );
        const byDate = new Map<string, number[]>();
        for (const b of r.rows as BanquetRow[]) {
            if (!eligible(task, b) || isSupersededWindow(task, b, family, now.date)) continue;
            byDate.set(b.event_date, [...(byDate.get(b.event_date) || []), Number(b.id)]);
        }
        for (const [eventDate, ids] of byDate) {
            if (await ensureBanquetOccurrence(deps, task.tenant_id, task, eventDate, ids)) released = true;
        }
    }
    // «Ultima volta» in Impostazioni dice quando è nata un'attività, non
    // quando è passato il giro: senza banchetti resta com'era.
    if (task.released_through !== rt || released) {
        await queryWithRetry(
            `UPDATE scheduled_tasks
                SET released_through = $1,
                    last_run_at = CASE WHEN $4::boolean THEN CURRENT_TIMESTAMP ELSE last_run_at END
              WHERE id = $2 AND tenant_id = $3`,
            [rt, task.id, task.tenant_id, released]
        );
        task.released_through = rt;
    }
}

/** Le attività ancora da fare di `task` che contengono banchetti non più
 *  suoi (spostati, eliminati, tornati preventivo, o il task ha cambiato
 *  giorni): quei banchetti escono, e l'attività rimasta vuota sparisce.
 *  Le altre si riscrivono, se nome o coperti sono cambiati. */
async function reconcileOpenTodos(deps: ScheduledTaskDeps, tenantId: number, todos: any[],
    taskById: Map<number, ScheduledTask>, onlyBanquetId?: number): Promise<void> {
    const ids = Array.from(new Set(todos.flatMap((t: any) => (t.linkedBanquetIds || []).map(Number))));
    const banquets = new Map((await loadBanquetsByIds(tenantId, ids)).map(b => [Number(b.id), b]));
    for (const todo of todos) {
        const task = taskById.get(Number(todo.scheduledTaskId));
        const linked: number[] = (todo.linkedBanquetIds || []).map(Number);
        const keep = linked.filter(id => {
            if (onlyBanquetId !== undefined && id !== onlyBanquetId) return true;
            const b = banquets.get(id);
            if (!task || !b || !eligible(task, b)) return false;
            return addDaysIso(b.event_date, -(task.days_before ?? 0)) === todo.dueDate;
        });
        if (keep.length === 0) {
            await deleteTodo(deps, tenantId, todo.id);
        } else if (task) {
            const eventDate = addDaysIso(todo.dueDate, task.days_before ?? 0);
            await updateTodoBanquets(deps, tenantId, task, todo, keep, eventDate);
        }
    }
}

const loadBanquetTasks = async (tenantId: number): Promise<ScheduledTask[]> =>
    (await queryWithRetry(
        `SELECT ${TASK_SELECT} FROM scheduled_tasks WHERE tenant_id = $1 AND kind = 'BANQUET' AND active = TRUE`,
        [tenantId]
    )).rows;

/** Il banchetto è nato, cambiato o sparito. `catchUp` quando può aver
 *  appena guadagnato un'attività (nuovo, data spostata, confermato): se il
 *  giorno stabilito è già scoccato, l'attività nasce subito. Senza catchUp
 *  una modifica qualsiasi non fa rinascere un'attività eliminata a mano. */
export async function syncBanquetScheduledTasks(deps: ScheduledTaskDeps, tenantId: number, banquetId: number,
    opts: { catchUp: boolean }): Promise<void> {
    const tasks = await loadBanquetTasks(tenantId);
    const taskById = new Map(tasks.map(t => [Number(t.id), t]));
    const [banquet] = await loadBanquetsByIds(tenantId, [banquetId]);

    // Da fare: escono i banchetti non più al loro posto. Svolte: restano come
    // storico, salvo il banchetto eliminato (come prima di questo modulo).
    const todos = await queryWithRetry(
        `SELECT ${TODO_FULL_SELECT} FROM todos
          WHERE tenant_id = $1 AND scheduled_task_id IS NOT NULL AND $2 = ANY(linked_banquet_ids)
            AND (completed = FALSE OR $3::boolean)`,
        [tenantId, banquetId, !banquet]
    );
    await reconcileOpenTodos(deps, tenantId, todos.rows, taskById, banquetId);

    if (!banquet || !opts.catchUp) return;
    const now = localNow(new Date(), await tenantTimezone(tenantId));
    if (banquet.event_date < now.date) return;
    for (const task of tasks) {
        if (!eligible(task, banquet) || isSupersededWindow(task, banquet, tasks, now.date)) continue;
        const due = addDaysIso(banquet.event_date, -(task.days_before ?? 0));
        if (due > releasedThroughNow(now, task.schedule_time)) continue;
        if (await ensureBanquetOccurrence(deps, tenantId, task, banquet.event_date, [banquetId])) {
            await queryWithRetry(
                'UPDATE scheduled_tasks SET last_run_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2',
                [task.id, tenantId]
            );
        }
    }
}

/** Dopo create/modifica di un'attività programmata. Per quelle dei
 *  banchetti: le attività ancora da fare si riallineano (giorni, banchetti,
 *  testo) e nascono subito quelle il cui giorno è già scoccato. */
async function syncTaskAfterSave(deps: ScheduledTaskDeps, task: ScheduledTask): Promise<void> {
    if (task.kind !== 'BANQUET') return;
    const open = await queryWithRetry(
        `SELECT ${TODO_FULL_SELECT} FROM todos
          WHERE tenant_id = $1 AND scheduled_task_id = $2 AND completed = FALSE AND linked_banquet_ids IS NOT NULL`,
        [task.tenant_id, task.id]
    );
    await reconcileOpenTodos(deps, task.tenant_id, open.rows, new Map([[Number(task.id), task]]));
    if (!task.active) return;
    const now = localNow(new Date(), await tenantTimezone(task.tenant_id));
    await releaseBanquetTask(deps, task, now, null);
}

/** Il giro dello scheduler (ogni 5 minuti, sotto il lock dei promemoria).
 *  `at` esiste per i test: lo scheduler vero gira sempre sull'ora corrente. */
export async function scheduledTasksTick(deps: ScheduledTaskDeps, at: Date = new Date()): Promise<void> {
    // Nessun filtro tenant: il tick serve tutti i ristoranti, ogni riga porta
    // il suo tenant_id a valle.
    const r = await queryWithRetry(`SELECT ${TASK_SELECT} FROM scheduled_tasks WHERE active = TRUE ORDER BY id`);
    const tzCache = new Map<number, string>();
    const tzOf = async (tenantId: number): Promise<string> => {
        if (!tzCache.has(tenantId)) tzCache.set(tenantId, await tenantTimezone(tenantId));
        return tzCache.get(tenantId)!;
    };
    for (const task of r.rows as ScheduledTask[]) {
        try {
            const tz = await tzOf(task.tenant_id);
            const now = localNow(at, tz);
            if (task.kind === 'BANQUET') {
                const rt = releasedThroughNow(now, task.schedule_time);
                if (task.released_through && task.released_through >= rt) continue;
                // Da dove riprendere: il giorno dopo l'ultimo fatto, ma non più
                // di una settimana indietro (un server spento a lungo non deve
                // far piovere attività di banchetti ormai passati).
                const weekAgo = addDaysIso(rt, -7);
                const from = task.released_through ? addDaysIso(task.released_through, 1) : rt;
                await releaseBanquetTask(deps, task, now, from < weekAgo ? weekAgo : from);
                continue;
            }
            const lastRunDate = task.last_run_at ? localNow(new Date(task.last_run_at), tz).date : null;
            if (!isTimedTaskDue(task, now, lastRunDate)) continue;
            await fireTimedTask(deps, task, now, tz);
            await queryWithRetry(
                `UPDATE scheduled_tasks
                    SET last_run_at = CURRENT_TIMESTAMP,
                        active = CASE WHEN kind = 'ONE_OFF' THEN FALSE ELSE active END
                  WHERE id = $1 AND tenant_id = $2`,
                [task.id, task.tenant_id]
            );
        } catch (err: any) {
            console.error(`[attivita-programmate] #${task.id} fallita:`, err?.message || err);
        }
    }
}

/** Crea (o aggiorna) l'attività del giorno e avvisa la squadra. Se quella
 *  del giorno c'è già ed è svolta, non si ricrea e non suona: era la regola
 *  del pane. */
async function fireTimedTask(deps: ScheduledTaskDeps, task: ScheduledTask, now: LocalNow, tz: string): Promise<void> {
    const due = addDaysIso(now.date, task.due_in_days || 0);
    const vars = await dayVars(task.tenant_id, task, due, tz);
    const title = renderTaskTemplate(task.title, vars).slice(0, 500);
    const description = task.description ? renderTaskTemplate(task.description, vars) : null;
    const existing = await queryWithRetry(
        `SELECT ${TODO_FULL_SELECT} FROM todos
          WHERE tenant_id = $1 AND scheduled_task_id = $2 AND due_date = $3
          ORDER BY completed, created_at LIMIT 1`,
        [task.tenant_id, task.id, due]
    );
    let todo = existing.rows[0];
    if (todo?.completed) return;
    if (todo) {
        const u = await queryWithRetry(
            `UPDATE todos SET title = $1, description = $2 WHERE id = $3 AND tenant_id = $4 RETURNING ${TODO_FULL_SELECT}`,
            [title, description, todo.id, task.tenant_id]
        );
        todo = u.rows[0] || todo;
        deps.broadcast(task.tenant_id, 'todo:updated', todo);
    } else {
        const c = await queryWithRetry(
            `INSERT INTO todos (tenant_id, title, description, priority, category, due_date, assigned_to_team, scheduled_task_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING ${TODO_FULL_SELECT}`,
            [task.tenant_id, title, description, task.priority, task.category, due, task.assigned_team, task.id]
        );
        todo = c.rows[0];
        if (!todo) return;
        deps.broadcast(task.tenant_id, 'todo:created', todo);
    }
    pushForTodo(deps, task.tenant_id, task, todo);
}

// ── Rotte ──────────────────────────────────────────────────────────────────

const publicRow = (row: any) => {
    const { tenant_id: _t, released_through: _r, ...rest } = row;
    return rest;
};

export function createScheduledTasksRouter(deps: ScheduledTaskDeps): express.Router {
    const router = express.Router();
    const manage = [authenticate, requirePermission('settings:full')];

    // Chi programma un'attività per una squadra deve poterla assegnare a mano
    // (stessa regola di POST /todos): un manager non crea compiti al titolare.
    const teamAllowed = (req: Request, team: string): boolean => {
        const role = req.user?.role as UserRole | undefined;
        return !role || canAssignToRole(role, team as UserRole);
    };

    router.get('/', authenticate, async (req, res) => {
        try {
            const r = await queryWithRetry(
                `SELECT ${TASK_SELECT} FROM scheduled_tasks WHERE tenant_id = $1
                  ORDER BY active DESC, kind = 'BANQUET' DESC, days_before DESC NULLS LAST, schedule_time, id`,
                [req.tenantId!]
            );
            res.json({ tasks: r.rows.map(publicRow) });
        } catch (err) {
            console.error('GET /scheduled-tasks error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.post('/', ...manage, async (req, res) => {
        try {
            const parsed = normalizeScheduledTaskPayload(req.body || {});
            if (parsed.ok === false) return res.status(400).json({ error: parsed.error });
            const d = parsed.data;
            if (!teamAllowed(req, d.assigned_team)) return res.status(403).json({ error: 'Non puoi assegnare attività a questa squadra' });
            const r = await queryWithRetry(
                `INSERT INTO scheduled_tasks
                    (tenant_id, title, description, kind, days_before, banquet_scope, frequency, weekdays,
                     month_day, schedule_date, schedule_time, due_in_days, covers_per_unit, assigned_team,
                     priority, category, active)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                 RETURNING ${TASK_SELECT}`,
                [req.tenantId!, d.title, d.description, d.kind, d.days_before, d.banquet_scope, d.frequency,
                 d.weekdays, d.month_day, d.schedule_date, d.schedule_time, d.due_in_days, d.covers_per_unit,
                 d.assigned_team, d.priority, d.category, d.active]
            );
            const task = r.rows[0] as ScheduledTask;
            // Il salvataggio è fatto: un errore nel far nascere le attività
            // non deve sembrare un salvataggio fallito. Il tick riprova.
            await syncTaskAfterSave(deps, task).catch(err =>
                console.error('[attivita-programmate] sync dopo la creazione fallita:', err?.message || err));
            res.status(201).json(publicRow(task));
        } catch (err) {
            console.error('POST /scheduled-tasks error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.put('/:id', ...manage, async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
            const parsed = normalizeScheduledTaskPayload(req.body || {});
            if (parsed.ok === false) return res.status(400).json({ error: parsed.error });
            const d = parsed.data;
            if (!teamAllowed(req, d.assigned_team)) return res.status(403).json({ error: 'Non puoi assegnare attività a questa squadra' });
            // Cambiano giorni o orario: si riparte dal calcolo di oggi, così il
            // tick non salta un giorno né ne ripete uno.
            const r = await queryWithRetry(
                `UPDATE scheduled_tasks
                    SET title = $1, description = $2, kind = $3::varchar, days_before = $4::smallint, banquet_scope = $5,
                        frequency = $6, weekdays = $7, month_day = $8, schedule_date = $9, schedule_time = $10::varchar,
                        due_in_days = $11, covers_per_unit = $12, assigned_team = $13, priority = $14,
                        category = $15, active = $16,
                        released_through = CASE WHEN days_before IS DISTINCT FROM $4::smallint
                                                  OR schedule_time <> $10::varchar OR kind <> $3::varchar
                                                THEN NULL ELSE released_through END,
                        updated_at = CURRENT_TIMESTAMP
                  WHERE id = $17 AND tenant_id = $18
                  RETURNING ${TASK_SELECT}`,
                [d.title, d.description, d.kind, d.days_before, d.banquet_scope, d.frequency, d.weekdays,
                 d.month_day, d.schedule_date, d.schedule_time, d.due_in_days, d.covers_per_unit,
                 d.assigned_team, d.priority, d.category, d.active, id, req.tenantId!]
            );
            const task = r.rows[0] as ScheduledTask | undefined;
            if (!task) return res.status(404).json({ error: 'Attività programmata non trovata' });
            await syncTaskAfterSave(deps, task).catch(err =>
                console.error('[attivita-programmate] sync dopo la modifica fallita:', err?.message || err));
            res.json(publicRow(task));
        } catch (err) {
            console.error('PUT /scheduled-tasks/:id error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.delete('/:id', ...manage, async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
            // Le attività già nate e ancora da fare se ne vanno con lei; quelle
            // svolte restano come storico (la colonna va a NULL da sola).
            const open = await queryWithRetry(
                `SELECT id FROM todos WHERE tenant_id = $1 AND scheduled_task_id = $2 AND completed = FALSE`,
                [req.tenantId!, id]
            );
            const del = await queryWithRetry(
                'DELETE FROM scheduled_tasks WHERE id = $1 AND tenant_id = $2 RETURNING id',
                [id, req.tenantId!]
            );
            if (del.rows.length === 0) return res.status(404).json({ error: 'Attività programmata non trovata' });
            for (const t of open.rows) await deleteTodo(deps, req.tenantId!, t.id);
            res.json({ ok: true, removedTodos: open.rows.length });
        } catch (err) {
            console.error('DELETE /scheduled-tasks/:id error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return router;
}
