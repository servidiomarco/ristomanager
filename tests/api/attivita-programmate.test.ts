import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
// Il giro dello scheduler si chiama qui, nel worker, con un orologio finto
// (come billing.test.ts fa col billing): il server di prova lo farebbe solo
// ogni 5 minuti, all'ora vera.
import {
    normalizeScheduledTaskPayload,
    renderTaskTemplate,
    quantityForCovers,
    isTimedTaskDue,
    releasedThroughNow,
    localNow,
    addDaysIso,
    scheduledTasksTick,
    type ScheduledTaskDeps,
    type ScheduledTaskPush,
} from '../../services/scheduledTasks';
import { zonedWallTimeToInstant } from '../../services/bookingReminders';
import { runAsPlatform } from '../../db';

// Attività programmate (services/scheduledTasks.ts): le attività che nascono
// da sole in Attività. Prima erano tre promemoria fissi per ogni banchetto e
// il pane, scritti in server.ts; il difetto da non rifare è quello trovato in
// produzione il 10/10/2026 — le attività già spuntate rinascevano a ogni
// deploy e a ogni modifica del banchetto.

const ROME = 'Europe/Rome';
const PREFIX = 'test-attp';

const banquetTask = {
    title: `${PREFIX} ordinare per {data}: {coperti} coperti, {banchetti}`,
    description: null,
    kind: 'BANQUET',
    days_before: 1,
    banquet_scope: 'ALL',
    schedule_time: '00:00',
    assigned_team: 'KITCHEN',
    priority: 'HIGH',
    category: 'INVENTORY',
    active: true,
};

describe('attività programmate — regole', () => {
    it('accetta i tre tipi e scarta quello che non torna', () => {
        expect(normalizeScheduledTaskPayload(banquetTask).ok).toBe(true);
        expect(normalizeScheduledTaskPayload({ ...banquetTask, kind: 'RECURRING', frequency: 'WEEKLY', weekdays: ['mon', 'FRI'] }))
            .toMatchObject({ ok: true, data: { weekdays: ['MON', 'FRI'], days_before: null } });
        expect(normalizeScheduledTaskPayload({ ...banquetTask, kind: 'ONE_OFF', schedule_date: '2031-02-03', due_in_days: 1 }))
            .toMatchObject({ ok: true, data: { schedule_date: '2031-02-03', due_in_days: 1 } });

        expect(normalizeScheduledTaskPayload({ ...banquetTask, title: '  ' }).ok).toBe(false);
        expect(normalizeScheduledTaskPayload({ ...banquetTask, days_before: 61 }).ok).toBe(false);
        expect(normalizeScheduledTaskPayload({ ...banquetTask, days_before: 1.5 }).ok).toBe(false);
        expect(normalizeScheduledTaskPayload({ ...banquetTask, schedule_time: '9:00' }).ok).toBe(false);
        expect(normalizeScheduledTaskPayload({ ...banquetTask, assigned_team: 'PLATFORM_ADMIN' }).ok).toBe(false);
        expect(normalizeScheduledTaskPayload({ ...banquetTask, kind: 'RECURRING', frequency: 'WEEKLY', weekdays: [] }).ok).toBe(false);
        expect(normalizeScheduledTaskPayload({ ...banquetTask, kind: 'RECURRING', frequency: 'MONTHLY', month_day: 29 }).ok).toBe(false);
        expect(normalizeScheduledTaskPayload({ ...banquetTask, kind: 'ONE_OFF' }).ok).toBe(false);
        expect(normalizeScheduledTaskPayload({ ...banquetTask, covers_per_unit: 0 }).ok).toBe(false);
    });

    it('riempie i segnaposto, con e senza accento, e lascia stare il resto', () => {
        const vars = { data: '2026-11-07', coperti: 31, banchetti: ['Motoclub', 'Rossi'], perUnit: 10 };
        expect(renderTaskTemplate('Ordinare {quantità} kg ({coperti} coperti) per il {data}', vars))
            .toBe('Ordinare 4 kg (31 coperti) per il 7 novembre 2026');
        expect(renderTaskTemplate('{quantita} · { banchetti } · {altro}', vars)).toBe('4 · Motoclub, Rossi · {altro}');
    });

    it('la quantità è quella del pane: una unità ogni N coperti, almeno una, zero a sala vuota', () => {
        expect(quantityForCovers(0, 10)).toBe(0);
        expect(quantityForCovers(1, 10)).toBe(1);
        expect(quantityForCovers(30, 10)).toBe(3);
        expect(quantityForCovers(31, 10)).toBe(4);
        expect(quantityForCovers(5, null)).toBe(5);
    });

    it("legge l'orologio del ristorante, anche a cavallo della mezzanotte", () => {
        expect(localNow(new Date('2026-10-10T22:30:00Z'), ROME)).toEqual({ date: '2026-10-11', time: '00:30', dow: 0 });
        expect(releasedThroughNow({ date: '2026-10-11', time: '08:59', dow: 0 }, '09:00')).toBe('2026-10-10');
        expect(releasedThroughNow({ date: '2026-10-11', time: '09:00', dow: 0 }, '09:00')).toBe('2026-10-11');
    });

    it('decide quando nasce una ricorrente o una tantum', () => {
        const giornaliera = { kind: 'RECURRING' as const, frequency: 'DAILY' as const, weekdays: null, month_day: null, schedule_date: null, schedule_time: '20:00' };
        const sabato = { date: '2026-10-10', time: '20:05', dow: 6 };
        expect(isTimedTaskDue(giornaliera, { ...sabato, time: '19:59' }, null)).toBe(false);
        expect(isTimedTaskDue(giornaliera, sabato, null)).toBe(true);
        expect(isTimedTaskDue(giornaliera, sabato, '2026-10-10')).toBe(false);
        expect(isTimedTaskDue({ ...giornaliera, frequency: 'WEEKLY', weekdays: ['SAT'] }, sabato, null)).toBe(true);
        expect(isTimedTaskDue({ ...giornaliera, frequency: 'WEEKLY', weekdays: ['MON'] }, sabato, null)).toBe(false);
        expect(isTimedTaskDue({ ...giornaliera, frequency: 'MONTHLY', month_day: 10 }, sabato, null)).toBe(true);
        expect(isTimedTaskDue({ ...giornaliera, kind: 'ONE_OFF', frequency: null, schedule_date: '2026-10-10' }, sabato, null)).toBe(true);
        expect(isTimedTaskDue({ ...giornaliera, kind: 'BANQUET' }, sabato, null)).toBe(false);
    });
});

describe('attività programmate — rotte e banchetti', () => {
    let db: Client;
    let owner: string;
    const today = localNow(new Date(), ROME).date;
    const tomorrow = addDaysIso(today, 1);
    // I banchetti di ogni test spariscono alla sua fine: un'attività nuova
    // raccoglie tutti quelli già scoccati, e quelli del test prima
    // finirebbero dentro. allBanquetIds resta per pulire i todo.
    let banquetIds: number[] = [];
    const allBanquetIds: number[] = [];
    const taskIds: number[] = [];
    const startedAt = new Date();
    const pushes: { tenantId: number; roles: string[]; push: ScheduledTaskPush }[] = [];
    const deps: ScheduledTaskDeps = {
        pushToRoles: async (tenantId, roles, push) => { pushes.push({ tenantId, roles, push }); },
        markNotificationsRead: async () => {},
        broadcast: () => {},
    };

    const todosOf = async (taskId: number) => (await db.query(
        `SELECT id, title, completed, assigned_to_team, linked_banquet_ids,
                to_char(due_date, 'YYYY-MM-DD') AS due
           FROM todos WHERE tenant_id = 1 AND scheduled_task_id = $1 ORDER BY created_at`,
        [taskId]
    )).rows;

    // Le attività dei banchetti nascono in sottofondo: si aspetta la riga.
    const waitFor = async <T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
        let v = await read();
        for (let i = 0; i < 40 && !ok(v); i++) {
            await new Promise(r => setTimeout(r, 100));
            v = await read();
        }
        return v;
    };
    // Il contrario: si dà tempo al sottofondo e si controlla che NON sia
    // successo niente.
    const settle = () => new Promise(r => setTimeout(r, 600));

    const createTask = async (body: Record<string, unknown>) => {
        const res = await api().post('/scheduled-tasks').set(bearer(owner)).send(body);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        taskIds.push(res.body.id);
        return res.body;
    };
    const createBanquet = async (name: string, eventDate: string, extra: Record<string, unknown> = {}) => {
        const res = await api().post('/banquet-menus').set(bearer(owner)).send({
            name, description: '', price_per_person: 40, courses: [], event_date: eventDate, guests: 30, ...extra,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        banquetIds.push(Number(res.body.id));
        allBanquetIds.push(Number(res.body.id));
        return res.body;
    };
    const updateBanquet = (b: any, patch: Record<string, unknown>) =>
        api().put(`/banquet-menus/${b.id}`).set(bearer(owner)).send({ ...b, courses: b.courses || [], ...patch });

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        owner = await ownerToken();
    });

    afterEach(async () => {
        await db.query(`DELETE FROM banquet_menus WHERE id = ANY($1::int[])`, [banquetIds]);
        banquetIds = [];
    });

    afterAll(async () => {
        // Anche quelle che il giro finto ha fatto nascere alle altre attività
        // del ristorante di prova (il pane, la merce dei banchetti).
        await db.query(
            `DELETE FROM todos WHERE tenant_id = 1
               AND (scheduled_task_id = ANY($1::int[]) OR linked_banquet_ids && $2::int[]
                    OR (scheduled_task_id IS NOT NULL AND created_at >= $3))`,
            [taskIds, allBanquetIds, startedAt]
        );
        await db.query(`DELETE FROM scheduled_tasks WHERE id = ANY($1::int[])`, [taskIds]);
        await db.end();
    });

    it('le attività fisse di prima sono righe modificabili; il pane non sta più nei promemoria', async () => {
        const res = await api().get('/scheduled-tasks').set(bearer(owner));
        expect(res.status).toBe(200);
        const merce = res.body.tasks.filter((t: any) => t.kind === 'BANQUET' && t.title.startsWith('Ordinare merce'));
        expect(merce.map((t: any) => [t.days_before, t.priority, t.assigned_team]).sort()).toEqual([
            [1, 'HIGH', 'KITCHEN'], [2, 'MEDIUM', 'KITCHEN'], [3, 'LOW', 'KITCHEN'],
        ]);
        const pane = res.body.tasks.find((t: any) => t.kind === 'RECURRING' && t.covers_per_unit === 10);
        expect(pane).toMatchObject({ assigned_team: 'OWNER', due_in_days: 1, category: 'INVENTORY' });
        expect(pane.title).toContain('{quantità}');
        expect(res.body.tasks[0].tenant_id).toBeUndefined();

        const reminders = await api().get('/reminders').set(bearer(owner));
        expect(reminders.body.reminders.some((r: any) => r.system_key === 'BREAD_DAILY')).toBe(false);
    });

    it('valida il corpo e lo scrive solo chi ha le impostazioni', async () => {
        const bad = await api().post('/scheduled-tasks').set(bearer(owner)).send({ ...banquetTask, days_before: 99 });
        expect(bad.status).toBe(400);
        const anon = await api().post('/scheduled-tasks').send(banquetTask);
        expect(anon.status).toBe(401);
    });

    it("un banchetto fa nascere l'attività al suo giorno, e quella spuntata non rinasce", async () => {
        const task = await createTask(banquetTask);
        const b1 = await createBanquet(`${PREFIX} Rossi`, tomorrow);

        let rows = await waitFor(() => todosOf(task.id), r => r.length > 0);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ due: today, completed: false, assigned_to_team: 'KITCHEN', linked_banquet_ids: [Number(b1.id)] });
        expect(rows[0].title).toContain('30 coperti');
        expect(rows[0].title).toContain(`${PREFIX} Rossi`);

        const toggled = await api().put(`/todos/${rows[0].id}/toggle`).set(bearer(owner));
        expect(toggled.status).toBe(200);

        // Stesso giorno, nome e coperti cambiati: prima ogni salvataggio
        // cancellava la spuntata e ne creava una nuova.
        expect((await updateBanquet(b1, { name: `${PREFIX} Rossi bis`, guests: 35 })).status).toBe(200);
        await settle();
        rows = await todosOf(task.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].completed).toBe(true);

        // Un secondo banchetto lo stesso giorno: la spuntata copre il primo,
        // ne nasce una nuova solo per lui.
        const b2 = await createBanquet(`${PREFIX} Bianchi`, tomorrow, { guests: 12 });
        rows = await waitFor(() => todosOf(task.id), r => r.length > 1);
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ completed: false, linked_banquet_ids: [Number(b2.id)] });
        expect(rows[1].title).toContain('12 coperti');

        // Eliminata a mano: una modifica che non sposta la data non la ricrea.
        expect((await api().delete(`/todos/${rows[1].id}`).set(bearer(owner))).status).toBe(204);
        expect((await updateBanquet(b2, { guests: 14 })).status).toBe(200);
        await settle();
        expect(await todosOf(task.id)).toHaveLength(1);

        // Spostato a dopodomani: il suo giorno stabilito è domani, non ancora.
        expect((await updateBanquet(b2, { event_date: addDaysIso(today, 2) })).status).toBe(200);
        await settle();
        expect(await todosOf(task.id)).toHaveLength(1);
    });

    it('«solo confermati» segue lo stato del banchetto, e vale per tutte le squadre', async () => {
        const task = await createTask({
            ...banquetTask, title: `${PREFIX} conferma {banchetti}`, days_before: 0,
            banquet_scope: 'CONFIRMED', assigned_team: 'RECEPTION',
        });
        const b = await createBanquet(`${PREFIX} Verdi`, today);
        await settle();
        expect(await todosOf(task.id)).toHaveLength(0);

        expect((await api().put(`/banquet-menus/${b.id}/status`).set(bearer(owner)).send({ status: 'CONFIRMED' })).status).toBe(200);
        let rows = await waitFor(() => todosOf(task.id), r => r.length > 0);
        expect(rows).toHaveLength(1);
        // RECEPTION: prima il vincolo di todos accettava solo quattro squadre.
        expect(rows[0]).toMatchObject({ assigned_to_team: 'RECEPTION', title: `${PREFIX} conferma ${PREFIX} Verdi` });

        expect((await api().put(`/banquet-menus/${b.id}/status`).set(bearer(owner)).send({ status: 'QUOTE' })).status).toBe(200);
        rows = await waitFor(() => todosOf(task.id), r => r.length === 0);
        expect(rows).toHaveLength(0);
    });

    it("cambiata, l'attività riscrive quelle da fare; eliminata, se le porta via", async () => {
        const b = await createBanquet(`${PREFIX} Neri`, addDaysIso(today, 3), { status: 'CONFIRMED' });
        const task = await createTask({ ...banquetTask, title: `${PREFIX} prima {banchetti}`, days_before: 3 });
        let rows = await todosOf(task.id);
        expect(rows.map(r => r.title)).toEqual([`${PREFIX} prima ${PREFIX} Neri`]);

        const put = await api().put(`/scheduled-tasks/${task.id}`).set(bearer(owner))
            .send({ ...banquetTask, title: `${PREFIX} dopo {coperti}`, days_before: 3 });
        expect(put.status).toBe(200);
        rows = await todosOf(task.id);
        expect(rows.map(r => r.title)).toEqual([`${PREFIX} dopo 30`]);
        expect(rows[0].linked_banquet_ids).toEqual([Number(b.id)]);

        const del = await api().delete(`/scheduled-tasks/${task.id}`).set(bearer(owner));
        expect(del.status).toBe(200);
        expect(del.body.removedTodos).toBe(1);
        expect((await db.query('SELECT 1 FROM todos WHERE id = $1', [rows[0].id])).rows).toHaveLength(0);
    });

    it("il giro dello scheduler: all'ora stabilita nasce e suona una volta sola", async () => {
        // 23:59 perché lo scheduler del server di prova, sull'ora vera, non
        // arrivi prima di questo test a farle nascere.
        const at = new Date(zonedWallTimeToInstant(today, '23:59', ROME).getTime() + 30_000);
        const daily = await createTask({
            title: `${PREFIX} pane {quantità} kg ({coperti} coperti) per {data}`, description: null,
            kind: 'RECURRING', frequency: 'DAILY', schedule_time: '23:59', due_in_days: 1,
            covers_per_unit: 10, assigned_team: 'OWNER', priority: 'HIGH', category: 'INVENTORY',
        });
        const late = await createTask({ ...banquetTask, title: `${PREFIX} sera {banchetti}`, days_before: 4, schedule_time: '23:59' });
        await createBanquet(`${PREFIX} Gialli`, addDaysIso(today, 4), { guests: 21 });
        await settle();
        // Il suo giorno stabilito è oggi, ma alle 23:59: non nasce subito.
        expect(await todosOf(late.id)).toHaveLength(0);

        pushes.length = 0;
        await runAsPlatform(() => scheduledTasksTick(deps, at));

        const pane = await todosOf(daily.id);
        expect(pane).toHaveLength(1);
        expect(pane[0].due).toBe(tomorrow);
        expect(pane[0].title).toMatch(new RegExp(`^${PREFIX} pane \\d+ kg \\(\\d+ coperti\\) per `));
        const sera = await todosOf(late.id);
        expect(sera).toHaveLength(1);
        expect(sera[0].title).toBe(`${PREFIX} sera ${PREFIX} Gialli`);
        const mine = pushes.filter(p => [`todo-${pane[0].id}`, `todo-${sera[0].id}`].includes(p.push.tag));
        expect(mine).toHaveLength(2);
        expect(mine.find(p => p.push.tag === `todo-${pane[0].id}`)?.roles).toEqual(['OWNER']);

        // Secondo giro alla stessa ora: niente doppioni, niente seconda campanella.
        pushes.length = 0;
        await runAsPlatform(() => scheduledTasksTick(deps, at));
        expect(await todosOf(daily.id)).toHaveLength(1);
        expect(await todosOf(late.id)).toHaveLength(1);
        expect(pushes.filter(p => [`todo-${pane[0].id}`, `todo-${sera[0].id}`].includes(p.push.tag))).toHaveLength(0);

        // Eliminata a mano, il giro dopo non la ricrea.
        expect((await api().delete(`/todos/${sera[0].id}`).set(bearer(owner))).status).toBe(204);
        await runAsPlatform(() => scheduledTasksTick(deps, at));
        expect(await todosOf(late.id)).toHaveLength(0);
    });
});
