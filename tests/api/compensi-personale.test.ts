import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Compensi del personale: il doppio recinto (permesso staff:payments +
// sblocco step-up con la password) e il calcolo del dovuto degli EXTRA dai
// turni con presenza — giorni a servizio singolo e doppio, tariffe distinte.
//
// Il mese è fisso e lontano (marzo 2026 non ha altri turni di test): il
// conteggio deve dare ESATTAMENTE 1 singolo + 1 doppio, non "almeno".

const MONTH = '2026-03';
const WAITER_EMAIL = 'cameriere.compensi@example.com';
const WAITER_PASSWORD = 'password-compensi-waiter';

const stepUpHeaders = (owner: string, stepUp: string) => ({
    ...bearer(owner),
    'X-Step-Up-Token': stepUp,
});

describe('compensi personale — recinto e calcolo', () => {
    let owner = '';
    let stepUp = '';
    let staffId = '';

    beforeAll(async () => {
        owner = await ownerToken();

        const created = await api().post('/staff').set(bearer(owner)).send({
            name: 'Extra', surname: 'Compensi', category: 'SALA', staffType: 'EXTRA',
        });
        expect(created.status).toBe(201);
        staffId = created.body.id;

        // Un giorno a servizio singolo, uno doppio, uno assente (non conta).
        for (const [date, shift, present] of [
            [`${MONTH}-06`, 'LUNCH', true],
            [`${MONTH}-07`, 'LUNCH', true],
            [`${MONTH}-07`, 'DINNER', true],
            [`${MONTH}-08`, 'DINNER', false],
        ] as const) {
            const res = await api().post('/staff/shifts').set(bearer(owner)).send({
                staffId, date, shift, present,
            });
            expect(res.status).toBe(201);
        }
    });

    afterAll(async () => {
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        try {
            // Le tabelle compensi cascano con il dipendente.
            await client.query('DELETE FROM staff_members WHERE id = $1', [staffId]);
            await client.query('DELETE FROM users WHERE email = $1', [WAITER_EMAIL]);
        } finally {
            await client.end();
        }
    });

    it('senza sblocco le route rispondono 401 step_up_required', async () => {
        const res = await api().get(`/staff/compensation/summary?month=${MONTH}`).set(bearer(owner));
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('step_up_required');
    });

    it('un access token normale non passa come step-up', async () => {
        const res = await api().get('/staff/compensation/profiles')
            .set(stepUpHeaders(owner, owner));
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('step_up_required');
    });

    it('la password sbagliata non sblocca', async () => {
        const res = await api().post('/auth/step-up').set(bearer(owner)).send({
            password: 'password-sbagliata', scope: 'staff_compensation',
        });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('wrong_password');
    });

    it('lo scope sconosciuto è rifiutato', async () => {
        const res = await api().post('/auth/step-up').set(bearer(owner)).send({
            password: process.env.TEST_OWNER_PASSWORD, scope: 'scope_inventato',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_scope');
    });

    it('la password giusta sblocca per 15 minuti', async () => {
        const res = await api().post('/auth/step-up').set(bearer(owner)).send({
            password: process.env.TEST_OWNER_PASSWORD, scope: 'staff_compensation',
        });
        expect(res.status).toBe(200);
        expect(res.body.expiresIn).toBe(900);
        stepUp = res.body.stepUpToken;
        expect(stepUp).toBeTruthy();
    });

    it('un ruolo senza staff:payments prende 403, sblocco compreso', async () => {
        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: WAITER_EMAIL, password: WAITER_PASSWORD, full_name: 'Test Waiter', role: 'WAITER',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: WAITER_EMAIL, password: WAITER_PASSWORD });
        expect(login.status).toBe(200);
        const waiter = login.body.accessToken;

        // Il permesso viene PRIMA della password: senza staff:payments non
        // si saggia nemmeno la propria password contro /auth/step-up.
        const unlock = await api().post('/auth/step-up').set(bearer(waiter)).send({
            password: WAITER_PASSWORD, scope: 'staff_compensation',
        });
        expect(unlock.status).toBe(403);

        const res = await api().get(`/staff/compensation/summary?month=${MONTH}`)
            .set(stepUpHeaders(waiter, stepUp));
        expect(res.status).toBe(403);
    });

    it('tariffe EXTRA salvate e dovuto calcolato dai turni', async () => {
        const put = await api().put(`/staff/compensation/profiles/${staffId}`)
            .set(stepUpHeaders(owner, stepUp))
            .send({ singleServiceCents: 5000, doubleServiceCents: 9000 });
        expect(put.status).toBe(200);
        expect(put.body.singleServiceCents).toBe(5000);

        const res = await api().get(`/staff/compensation/summary?month=${MONTH}`)
            .set(stepUpHeaders(owner, stepUp));
        expect(res.status).toBe(200);
        const row = res.body.rows.find((r: any) => r.staffId === staffId);
        expect(row).toBeTruthy();
        // Il 6 un servizio, il 7 due, l'8 non presente: 1 singolo + 1 doppio.
        expect(row.singleDays).toBe(1);
        expect(row.doubleDays).toBe(1);
        expect(row.dueCents).toBe(5000 + 9000);
        expect(row.dueSource).toBe('AUTO');
    });

    it('un acconto riduce il residuo', async () => {
        const post = await api().post('/staff/compensation/payments')
            .set(stepUpHeaders(owner, stepUp))
            .send({ staffId, periodMonth: MONTH, kind: 'ACCONTO', amountCents: 4000, method: 'CONTANTI' });
        expect(post.status).toBe(201);

        const res = await api().get(`/staff/compensation/summary?month=${MONTH}`)
            .set(stepUpHeaders(owner, stepUp));
        const row = res.body.rows.find((r: any) => r.staffId === staffId);
        expect(row.paidCents).toBe(4000);
        expect(row.residualCents).toBe(14000 - 4000);
    });

    it("l'override vince sul calcolo e la cancellazione lo ripristina", async () => {
        const put = await api().put(`/staff/compensation/overrides/${staffId}`)
            .set(stepUpHeaders(owner, stepUp))
            .send({ periodMonth: MONTH, overrideCents: 12000, note: 'accordo a voce' });
        expect(put.status).toBe(200);

        let res = await api().get(`/staff/compensation/summary?month=${MONTH}`)
            .set(stepUpHeaders(owner, stepUp));
        let row = res.body.rows.find((r: any) => r.staffId === staffId);
        expect(row.dueCents).toBe(12000);
        expect(row.dueSource).toBe('OVERRIDE');
        expect(row.residualCents).toBe(12000 - 4000);

        const del = await api().delete(`/staff/compensation/overrides/${staffId}?month=${MONTH}`)
            .set(stepUpHeaders(owner, stepUp));
        expect(del.status).toBe(200);

        res = await api().get(`/staff/compensation/summary?month=${MONTH}`)
            .set(stepUpHeaders(owner, stepUp));
        row = res.body.rows.find((r: any) => r.staffId === staffId);
        expect(row.dueCents).toBe(14000);
        expect(row.dueSource).toBe('AUTO');
    });

    it('il registro elenca il movimento e la cancellazione lo toglie', async () => {
        const list = await api().get(`/staff/compensation/payments?month=${MONTH}&staffId=${staffId}`)
            .set(stepUpHeaders(owner, stepUp));
        expect(list.status).toBe(200);
        expect(list.body).toHaveLength(1);
        expect(list.body[0].kind).toBe('ACCONTO');
        expect(list.body[0].periodMonth).toBe(MONTH);

        const del = await api().delete(`/staff/compensation/payments/${list.body[0].id}`)
            .set(stepUpHeaders(owner, stepUp));
        expect(del.status).toBe(200);

        const after = await api().get(`/staff/compensation/payments?month=${MONTH}&staffId=${staffId}`)
            .set(stepUpHeaders(owner, stepUp));
        expect(after.body).toHaveLength(0);
    });

    it('il permesso staff:payments è del solo OWNER in matrice', async () => {
        const ownerPerms = await api().get('/auth/permissions/roles/OWNER').set(bearer(owner));
        expect(ownerPerms.status).toBe(200);
        expect(ownerPerms.body.permissions).toContain('staff:payments');

        const gmPerms = await api().get('/auth/permissions/roles/GENERAL_MANAGER').set(bearer(owner));
        expect(gmPerms.status).toBe(200);
        expect(gmPerms.body.permissions).not.toContain('staff:payments');
    });
});
