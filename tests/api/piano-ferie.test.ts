import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Piano ferie: il self-service del dipendente (autorizzato dal collegamento
// scheda ↔ account, non dalla matrice), il conteggio dei giorni che salta
// riposo settimanale e chiusure, la proposta automatica con copertura
// minima e monte ferie, e le decisioni che diventano assenze in calendario.
//
// Anno lontano (2031) e soglia di copertura RELATIVA: altri file di test
// possono lasciare schede FISSO nel tenant, che sono in servizio ogni
// giorno. La soglia si calcola dalla copertura letta dal piano prima di
// creare le nostre tre schede, così la proposta dà sempre lo stesso esito.

const YEAR = 2031;
const WEEK_START = '2031-07-07'; // lunedì: il riposo di A
const WEEK_END = '2031-07-13';   // domenica
const CLOSED_DAY = '2031-07-10'; // giovedì, chiusura straordinaria
const WAITER_EMAIL = 'cameriere.ferie@example.com';
const OTHER_EMAIL = 'cameriere.senzascheda@example.com';
const PASSWORD = 'password-ferie-test';

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';

const dayIndex = (date: string) =>
    Math.round((Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) - Date.UTC(YEAR, 0, 1)) / 86_400_000);

describe('piano ferie — richieste, proposta, decisioni', () => {
    let owner = '';
    let waiter = '';
    let other = '';
    let waiterId = 0;
    let staffA = '';
    let staffB = '';
    let staffC = '';
    let day = '';      // il giorno conteso da B e C, quello a copertura più bassa
    let baseline = 0;  // persone di sala a cena quel giorno, prima delle nostre
    let reqA = '';
    let reqB = '';
    let reqC = '';

    beforeAll(async () => {
        owner = await ownerToken();

        const db = new Client({ connectionString: dbUrl() });
        await db.connect();
        try {
            await db.query(
                `INSERT INTO special_closures (tenant_id, date, shift, reason) VALUES (1, $1, NULL, 'test ferie')
                 ON CONFLICT DO NOTHING`,
                [CLOSED_DAY]
            );
        } finally {
            await db.end();
        }

        for (const email of [WAITER_EMAIL, OTHER_EMAIL]) {
            const created = await api().post('/auth/users').set(bearer(owner)).send({
                email, password: PASSWORD, full_name: 'Test Ferie', role: 'WAITER',
            });
            expect(created.status).toBe(201);
            if (email === WAITER_EMAIL) waiterId = created.body.id;
        }
        waiter = (await api().post('/auth/login').send({ email: WAITER_EMAIL, password: PASSWORD })).body.accessToken;
        other = (await api().post('/auth/login').send({ email: OTHER_EMAIL, password: PASSWORD })).body.accessToken;

        // Copertura di partenza: il giorno più scarico della settimana, esclusi
        // il lunedì (riposo di A) e la chiusura.
        const plan = await api().get(`/staff/leave-plan?year=${YEAR}`).set(bearer(owner));
        expect(plan.status).toBe(200);
        const dinner: number[] = plan.body.coverage.onDuty.SALA.DINNER;
        expect(dinner[dayIndex(CLOSED_DAY)]).toBe(-1);
        let best = Infinity;
        for (const d of ['2031-07-08', '2031-07-09', '2031-07-11', '2031-07-12', '2031-07-13']) {
            const n = dinner[dayIndex(d)];
            if (n < best) { best = n; day = d; }
        }
        baseline = best;

        const make = async (name: string, extra: Record<string, unknown>) => {
            const res = await api().post('/staff').set(bearer(owner)).send({
                name, surname: 'Ferie', category: 'SALA', staffType: 'FISSO', ...extra,
            });
            expect(res.status).toBe(201);
            return res.body.id as string;
        };
        staffA = await make('Anna', { weeklyRestDay: 1, userId: waiterId, annualLeaveDays: 10 });
        staffB = await make('Bruno', {});
        staffC = await make('Carla', {});
    });

    afterAll(async () => {
        const db = new Client({ connectionString: dbUrl() });
        await db.connect();
        try {
            // Richieste e assenze cascano con le schede.
            await db.query('DELETE FROM staff_members WHERE id = ANY($1::uuid[])', [[staffA, staffB, staffC].filter(Boolean)]);
            await db.query('DELETE FROM users WHERE email = ANY($1)', [[WAITER_EMAIL, OTHER_EMAIL]]);
            await db.query(`DELETE FROM special_closures WHERE tenant_id = 1 AND date = $1 AND reason = 'test ferie'`, [CLOSED_DAY]);
            await db.query('DELETE FROM staff_leave_settings WHERE tenant_id = 1');
        } finally {
            await db.end();
        }
    });

    it('la scheda espone account collegato e giorni di ferie', async () => {
        const res = await api().get(`/staff/${staffA}`).set(bearer(owner));
        expect(res.status).toBe(200);
        expect(res.body.userId).toBe(waiterId);
        expect(res.body.annualLeaveDays).toBe(10);
    });

    it('un account si collega a una sola scheda', async () => {
        const res = await api().put(`/staff/${staffB}`).set(bearer(owner)).send({ userId: waiterId });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('user_already_linked');

        const users = await api().get('/staff/linkable-users').set(bearer(owner));
        expect(users.status).toBe(200);
        expect(users.body.find((u: any) => u.id === waiterId)?.staffId).toBe(staffA);
    });

    it('senza scheda collegata niente self-service', async () => {
        const mine = await api().get('/staff/my-leave').set(bearer(other));
        expect(mine.status).toBe(200);
        expect(mine.body.linked).toBe(false);

        const post = await api().post('/staff/my-leave').set(bearer(other)).send({ startDate: WEEK_START, endDate: WEEK_END });
        expect(post.status).toBe(403);
    });

    it('il cameriere non vede il piano di tutti', async () => {
        const res = await api().get(`/staff/leave-plan?year=${YEAR}`).set(bearer(waiter));
        expect(res.status).toBe(403);
    });

    it('il dipendente chiede ferie: riposo e chiusure non si pagano', async () => {
        const res = await api().post('/staff/my-leave').set(bearer(waiter)).send({
            startDate: WEEK_START, endDate: WEEK_END, note: 'matrimonio',
        });
        expect(res.status).toBe(201);
        // 7 giorni meno il lunedì di riposo e il giovedì chiuso.
        expect(res.body.days).toBe(5);
        expect(res.body.status).toBe('PENDING');
        expect(res.body.requestedByStaff).toBe(true);
        reqA = res.body.id;

        const mine = await api().get(`/staff/my-leave?year=${YEAR}`).set(bearer(waiter));
        expect(mine.body.linked).toBe(true);
        expect(mine.body.balance).toMatchObject({ entitled: 10, approved: 0, pending: 5, remaining: 10 });
    });

    it('richieste impossibili respinte', async () => {
        const overlap = await api().post('/staff/my-leave').set(bearer(waiter)).send({ startDate: '2031-07-12', endDate: '2031-07-15' });
        expect(overlap.status).toBe(409);
        expect(overlap.body.error).toBe('overlap');

        const past = await api().post('/staff/my-leave').set(bearer(waiter)).send({ startDate: '2020-01-01', endDate: '2020-01-02' });
        expect(past.status).toBe(400);
        expect(past.body.error).toBe('in_the_past');

        const restOnly = await api().post('/staff/my-leave').set(bearer(waiter)).send({ startDate: '2031-07-14', endDate: '2031-07-14' });
        expect(restOnly.status).toBe(400);
        expect(restOnly.body.error).toBe('no_working_days');

        const bad = await api().post('/staff/my-leave').set(bearer(waiter)).send({ startDate: '2031-02-30', endDate: '2031-03-02' });
        expect(bad.status).toBe(400);
    });

    it('il responsabile inserisce per conto di altri; il cameriere non decide', async () => {
        const b = await api().post('/staff/leave-requests').set(bearer(owner)).send({ staffId: staffB, startDate: day, endDate: day });
        expect(b.status).toBe(201);
        expect(b.body.requestedByStaff).toBe(false);
        reqB = b.body.id;
        const c = await api().post('/staff/leave-requests').set(bearer(owner)).send({ staffId: staffC, startDate: day, endDate: day });
        expect(c.status).toBe(201);
        reqC = c.body.id;

        const denied = await api().post('/staff/leave-requests/decide').set(bearer(waiter)).send({
            decisions: [{ id: reqA, decision: 'APPROVE' }],
        });
        expect(denied.status).toBe(403);
    });

    it('proposta: chi chiede prima prende il giorno conteso', async () => {
        // Sul giorno conteso può mancare una sola delle nostre tre schede.
        const settings = await api().put('/staff/leave-settings').set(bearer(owner)).send({
            defaultAnnualDays: 26,
            minimums: { SALA: { LUNCH: 0, DINNER: baseline + 2 }, CUCINA: { LUNCH: 0, DINNER: 0 } },
            priority: 'FIRST_COME',
        });
        expect(settings.status).toBe(200);

        const res = await api().post('/staff/leave-plan/proposal').set(bearer(owner)).send({});
        expect(res.status).toBe(200);
        const byId = new Map(res.body.items.map((i: any) => [i.requestId, i]));
        expect((byId.get(reqA) as any).verdict).toBe('APPROVE');
        const b = byId.get(reqB) as any;
        expect(b.verdict).toBe('REJECT');
        expect(b.reasons[0]).toMatchObject({ kind: 'COVERAGE', date: day, service: 'DINNER', category: 'SALA', min: baseline + 2 });
        expect((byId.get(reqC) as any).verdict).toBe('REJECT');
    });

    it('proposta: chi sfora il monte cede il posto', async () => {
        const upd = await api().put(`/staff/${staffA}`).set(bearer(owner)).send({ annualLeaveDays: 4 });
        expect(upd.status).toBe(200);

        const res = await api().post('/staff/leave-plan/proposal').set(bearer(owner)).send({});
        const byId = new Map(res.body.items.map((i: any) => [i.requestId, i]));
        const a = byId.get(reqA) as any;
        expect(a.verdict).toBe('REJECT');
        expect(a.reasons).toContainEqual({ kind: 'BALANCE', year: String(YEAR), over: 1 });
        expect((byId.get(reqB) as any).verdict).toBe('APPROVE');
        expect((byId.get(reqC) as any).verdict).toBe('REJECT');
    });

    it('le decisioni diventano assenze; le richieste in attesa non toccano le presenze', async () => {
        const res = await api().post('/staff/leave-requests/decide').set(bearer(owner)).send({
            decisions: [
                { id: reqA, decision: 'REJECT', note: 'monte esaurito' },
                { id: reqB, decision: 'APPROVE' },
                { id: reqC, decision: 'REJECT' },
            ],
        });
        expect(res.status).toBe(200);
        expect(res.body.results.every((r: any) => r.ok)).toBe(true);

        // Una decisione presa non si riprende da capo.
        const again = await api().post('/staff/leave-requests/decide').set(bearer(owner)).send({
            decisions: [{ id: reqC, decision: 'APPROVE' }],
        });
        expect(again.body.results[0]).toMatchObject({ ok: false, error: 'not_pending' });

        const offB = await api().get(`/staff/time-off?staffId=${staffB}`).set(bearer(owner));
        expect(offB.body).toHaveLength(1);
        expect(offB.body[0]).toMatchObject({ type: 'VACANZA', startDate: day, endDate: day });

        const presence = await api().get(`/staff/presence?date=${day}`).set(bearer(owner));
        const dinnerIds = presence.body.sala.dinner.map((s: any) => s.id);
        expect(dinnerIds).not.toContain(staffB);
        expect(dinnerIds).toContain(staffA);
        expect(dinnerIds).toContain(staffC);

        const mine = await api().get(`/staff/my-leave?year=${YEAR}`).set(bearer(waiter));
        const a = mine.body.requests.find((r: any) => r.id === reqA);
        expect(a).toMatchObject({ status: 'REJECTED', decisionNote: 'monte esaurito' });

        const plan = await api().get(`/staff/leave-plan?year=${YEAR}`).set(bearer(owner));
        expect(plan.body.balances.find((x: any) => x.staffId === staffB)).toMatchObject({ entitled: 26, approved: 1, pending: 0 });
    });

    it("cancellare l'assenza dal calendario annulla la richiesta", async () => {
        const offB = await api().get(`/staff/time-off?staffId=${staffB}`).set(bearer(owner));
        const del = await api().delete(`/staff/time-off/${offB.body[0].id}`).set(bearer(owner));
        expect(del.status).toBe(204);

        const plan = await api().get(`/staff/leave-plan?year=${YEAR}`).set(bearer(owner));
        expect(plan.body.requests.find((r: any) => r.id === reqB)?.status).toBe('CANCELLED');
    });

    it('il dipendente ritira solo le proprie richieste in attesa', async () => {
        const created = await api().post('/staff/my-leave').set(bearer(waiter)).send({ startDate: '2031-08-05', endDate: '2031-08-06' });
        expect(created.status).toBe(201);

        const notMine = await api().delete(`/staff/my-leave/${reqB}`).set(bearer(waiter));
        expect(notMine.status).toBe(404);

        const ok = await api().delete(`/staff/my-leave/${created.body.id}`).set(bearer(waiter));
        expect(ok.status).toBe(204);
        const twice = await api().delete(`/staff/my-leave/${created.body.id}`).set(bearer(waiter));
        expect(twice.status).toBe(409);
    });
});

// Il conteggio del monte per chi non ha un riposo fisso e il rateo per chi
// ha un contratto che non copre l'anno. Nato da un fisso di produzione che
// risultava a 28,5 giorni su 26: senza riposo sulla scheda, ogni giorno di
// calendario si pagava, anche quelli che sarebbero stati di riposo.
describe('piano ferie — 6 giorni su 7 e monte in proporzione', () => {
    const Y = 2032;
    let owner = '';
    const ids: Record<string, string> = {};

    const balanceOf = async (staffId: string) => {
        const plan = await api().get(`/staff/leave-plan?year=${Y}`).set(bearer(owner));
        expect(plan.status).toBe(200);
        return plan.body.balances.find((b: any) => b.staffId === staffId);
    };

    beforeAll(async () => {
        owner = await ownerToken();
        const put = await api().put('/staff/leave-settings').set(bearer(owner)).send({
            defaultAnnualDays: 26,
            minimums: { SALA: { LUNCH: 0, DINNER: 0 }, CUCINA: { LUNCH: 0, DINNER: 0 } },
            priority: 'FIRST_COME',
            trackingStart: null,
        });
        expect(put.status).toBe(200);

        const db = new Client({ connectionString: dbUrl() });
        await db.connect();
        try {
            await db.query(
                `INSERT INTO special_closures (tenant_id, date, shift, reason) VALUES (1, '2032-10-07', NULL, 'test ferie 6su7')
                 ON CONFLICT DO NOTHING`
            );
        } finally {
            await db.end();
        }

        const make = async (key: string, extra: Record<string, unknown>) => {
            const res = await api().post('/staff').set(bearer(owner)).send({
                name: key, surname: 'Rateo', category: 'SALA', staffType: 'FISSO', ...extra,
            });
            expect(res.status).toBe(201);
            ids[key] = res.body.id;
        };
        await make('Senzariposo', {});
        await make('Stagionale', { staffType: 'STAGIONALE', hireDate: `${Y}-07-04`, contractEndDate: `${Y}-09-06` });
        await make('Avvio', { hireDate: `${Y}-04-01` });
    });

    afterAll(async () => {
        const db = new Client({ connectionString: dbUrl() });
        await db.connect();
        try {
            await db.query('DELETE FROM staff_members WHERE id = ANY($1::uuid[])', [Object.values(ids)]);
            await db.query(`DELETE FROM special_closures WHERE tenant_id = 1 AND reason = 'test ferie 6su7'`);
            await db.query('DELETE FROM staff_leave_settings WHERE tenant_id = 1');
        } finally {
            await db.end();
        }
    });

    it('senza riposo fisso ogni 7 giorni consecutivi ne contano 6', async () => {
        // 14 giorni pieni: due settimane, due riposi → 12.
        const two = await api().post('/staff/time-off').set(bearer(owner)).send({
            staffId: ids.Senzariposo, startDate: `${Y}-09-01`, endDate: `${Y}-09-14`, type: 'VACANZA',
        });
        expect(two.status).toBe(201);
        // 3 giorni: sotto la settimana, contano tutti.
        await api().post('/staff/time-off').set(bearer(owner)).send({
            staffId: ids.Senzariposo, startDate: `${Y}-05-11`, endDate: `${Y}-05-13`, type: 'VACANZA',
        });
        expect((await balanceOf(ids.Senzariposo)).approved).toBe(15);
    });

    it('una settimana con una chiusura non scala un riposo in più', async () => {
        // 5–11 ottobre, il 7 chiuso: 6 giorni pagati, la chiusura fa da riposo.
        await api().post('/staff/time-off').set(bearer(owner)).send({
            staffId: ids.Senzariposo, startDate: `${Y}-10-05`, endDate: `${Y}-10-11`, type: 'VACANZA',
        });
        expect((await balanceOf(ids.Senzariposo)).approved).toBe(21);
    });

    it('il monte segue i mesi di contratto', async () => {
        // Luglio e agosto pieni, settembre con 6 giorni: 2 mesi → 26 × 2/12 = 4,33 → 4,5.
        expect((await balanceOf(ids.Stagionale)).entitled).toBe(4.5);
        // Assunto il 1° aprile: 9 mesi → 19,5.
        expect((await balanceOf(ids.Avvio)).entitled).toBe(19.5);
    });

    it("chi risulta assunto fino all'avvio del registro matura da inizio anno", async () => {
        const put = await api().put('/staff/leave-settings').set(bearer(owner)).send({
            defaultAnnualDays: 26,
            minimums: { SALA: { LUNCH: 0, DINNER: 0 }, CUCINA: { LUNCH: 0, DINNER: 0 } },
            priority: 'FIRST_COME',
            trackingStart: `${Y}-04-01`,
        });
        expect(put.body.trackingStart).toBe(`${Y}-04-01`);
        expect((await balanceOf(ids.Avvio)).entitled).toBe(26);
        // L'assunzione vera, dopo l'avvio, resta in proporzione.
        expect((await balanceOf(ids.Stagionale)).entitled).toBe(4.5);

        // Il client di prima non manda trackingStart: non deve azzerarlo.
        const old = await api().put('/staff/leave-settings').set(bearer(owner)).send({
            defaultAnnualDays: 26,
            minimums: { SALA: { LUNCH: 0, DINNER: 0 }, CUCINA: { LUNCH: 0, DINNER: 0 } },
            priority: 'FIRST_COME',
        });
        expect(old.body.trackingStart).toBe(`${Y}-04-01`);
    });
});
