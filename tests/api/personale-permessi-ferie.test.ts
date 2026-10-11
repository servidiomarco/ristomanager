import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Chi vede le ferie degli altri (11/10/2026): solo chi ha staff:leave, di
// default titolare e general manager. Il manager ha Personale (turni,
// schede) ma le assenze altrui gli arrivano come «ASSENZA» senza note, il
// piano ferie gli è chiuso, e registra o toglie solo i riposi. Le proprie
// assenze le vede col loro motivo.

const MANAGER_EMAIL = 'manager.permessi-ferie@example.com';
const PASSWORD = 'password-permessi-ferie';
const DAY = '2032-03-10';

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';

describe('personale — ferie e assenze solo a chi ha staff:leave', () => {
    let owner = '';
    let manager = '';
    let managerId = 0;
    let mine = '';    // la scheda collegata al manager
    let other = '';   // un collega
    let vacation = '';
    let rest = '';

    beforeAll(async () => {
        owner = await ownerToken();

        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: MANAGER_EMAIL, password: PASSWORD, full_name: 'Test Permessi Ferie', role: 'MANAGER',
        });
        expect(created.status).toBe(201);
        managerId = created.body.id;
        manager = (await api().post('/auth/login').send({ email: MANAGER_EMAIL, password: PASSWORD })).body.accessToken;

        const make = async (name: string, extra: Record<string, unknown>) => {
            const res = await api().post('/staff').set(bearer(owner)).send({
                name, surname: 'Permessi', category: 'SALA', staffType: 'EXTRA', ...extra,
            });
            expect(res.status).toBe(201);
            return res.body.id as string;
        };
        mine = await make('Mara', { userId: managerId });
        other = await make('Otto', { annualLeaveDays: 26 });

        const off = async (staffId: string, type: string, notes: string | null) => {
            const res = await api().post('/staff/time-off').set(bearer(owner)).send({
                staffId, startDate: DAY, endDate: DAY, type, notes,
            });
            expect(res.status).toBe(201);
            return res.body.id as string;
        };
        vacation = await off(other, 'VACANZA', 'al mare');
        rest = await off(other, 'RIPOSO', null);
        await off(mine, 'MALATTIA', 'febbre');
    });

    afterAll(async () => {
        const db = new Client({ connectionString: dbUrl() });
        await db.connect();
        try {
            // Le assenze cascano con le schede.
            await db.query('DELETE FROM staff_members WHERE id = ANY($1::uuid[])', [[mine, other].filter(Boolean)]);
            await db.query('DELETE FROM users WHERE email = $1', [MANAGER_EMAIL]);
        } finally {
            await db.end();
        }
    });

    it('la matrice dà staff:leave a titolare e general manager, non al manager', async () => {
        for (const [role, has] of [['OWNER', true], ['GENERAL_MANAGER', true], ['MANAGER', false], ['KITCHEN', false]] as const) {
            const res = await api().get(`/auth/permissions/roles/${role}`).set(bearer(owner));
            expect(res.status).toBe(200);
            expect(res.body.permissions.includes('staff:leave'), role).toBe(has);
        }
        const kitchen = await api().get('/auth/permissions/roles/KITCHEN').set(bearer(owner));
        expect(kitchen.body.permissions).not.toContain('staff:full');
    });

    it('il titolare vede tipo e note di tutte le assenze', async () => {
        const res = await api().get(`/staff/time-off?staffId=${other}`).set(bearer(owner));
        expect(res.status).toBe(200);
        const v = res.body.find((x: any) => x.id === vacation);
        expect(v.type).toBe('VACANZA');
        expect(v.notes).toBe('al mare');
    });

    it('il manager vede le assenze di un collega senza motivo, il riposo com\'è', async () => {
        const res = await api().get(`/staff/time-off?staffId=${other}`).set(bearer(manager));
        expect(res.status).toBe(200);
        const v = res.body.find((x: any) => x.id === vacation);
        expect(v.type).toBe('ASSENZA');
        expect(v.notes).toBeNull();
        expect(v.startDate.slice(0, 10)).toBe(DAY);
        expect(res.body.find((x: any) => x.id === rest).type).toBe('RIPOSO');
    });

    it('il manager vede le proprie assenze col motivo', async () => {
        const res = await api().get(`/staff/time-off?staffId=${mine}`).set(bearer(manager));
        expect(res.status).toBe(200);
        expect(res.body[0].type).toBe('MALATTIA');
        expect(res.body[0].notes).toBe('febbre');
    });

    it('il piano ferie e il conteggio delle richieste sono chiusi al manager', async () => {
        expect((await api().get('/staff/leave-plan?year=2032').set(bearer(manager))).status).toBe(403);
        expect((await api().get('/staff/leave-requests/pending-count').set(bearer(manager))).status).toBe(403);
        expect((await api().post('/staff/leave-requests').set(bearer(manager)).send({
            staffId: other, startDate: '2032-04-01', endDate: '2032-04-02',
        })).status).toBe(403);
        expect((await api().get('/staff/leave-plan?year=2032').set(bearer(owner))).status).toBe(200);
    });

    it('il manager registra e toglie solo riposi', async () => {
        const sick = await api().post('/staff/time-off').set(bearer(manager)).send({
            staffId: other, startDate: '2032-03-11', endDate: '2032-03-11', type: 'MALATTIA',
        });
        expect(sick.status).toBe(403);

        const ok = await api().post('/staff/time-off').set(bearer(manager)).send({
            staffId: other, startDate: '2032-03-12', endDate: '2032-03-12', type: 'RIPOSO',
        });
        expect(ok.status).toBe(201);

        // Un riposo non diventa ferie, e ferie altrui non si toccano.
        expect((await api().put(`/staff/time-off/${ok.body.id}`).set(bearer(manager)).send({ type: 'VACANZA' })).status).toBe(403);
        expect((await api().put(`/staff/time-off/${vacation}`).set(bearer(manager)).send({ notes: 'x' })).status).toBe(403);
        expect((await api().delete(`/staff/time-off/${vacation}`).set(bearer(manager))).status).toBe(403);

        expect((await api().delete(`/staff/time-off/${ok.body.id}`).set(bearer(manager))).status).toBe(204);
    });

    // Ferie approvate e già passate si correggono (solo chi ha staff:leave):
    // la richiesta segue le date dell'assenza, e se l'assenza smette di
    // essere ferie la richiesta passa ad annullata.
    it('il titolare corregge ferie approvate e già passate; la richiesta le segue', async () => {
        const created = await api().post('/staff/leave-requests').set(bearer(owner)).send({
            staffId: other, startDate: '2020-02-03', endDate: '2020-02-05',
        });
        expect(created.status).toBe(201);
        const decided = await api().post('/staff/leave-requests/decide').set(bearer(owner)).send({
            decisions: [{ id: created.body.id, decision: 'APPROVE' }],
        });
        expect(decided.body.results[0].ok).toBe(true);

        const request = async () => {
            const plan = await api().get('/staff/leave-plan?year=2020').set(bearer(owner));
            expect(plan.status).toBe(200);
            return plan.body.requests.find((r: any) => r.id === created.body.id);
        };
        const approved = await request();
        expect(approved.status).toBe('APPROVED');
        const timeOffId = approved.timeOffId as string;
        expect(timeOffId).toBeTruthy();

        // Il manager non le tocca, nemmeno spostandole.
        expect((await api().put(`/staff/time-off/${timeOffId}`).set(bearer(manager)).send({ endDate: '2020-02-07' })).status).toBe(403);
        // Un intervallo rovesciato no.
        expect((await api().put(`/staff/time-off/${timeOffId}`).set(bearer(owner)).send({ endDate: '2020-02-01' })).status).toBe(400);

        const moved = await api().put(`/staff/time-off/${timeOffId}`).set(bearer(owner)).send({ startDate: '2020-02-04', endDate: '2020-02-07' });
        expect(moved.status).toBe(200);
        expect(moved.body.startDate.slice(0, 10)).toBe('2020-02-04');
        expect(moved.body.endDate.slice(0, 10)).toBe('2020-02-07');
        const followed = await request();
        expect(followed.status).toBe('APPROVED');
        expect(followed.startDate).toBe('2020-02-04');
        expect(followed.endDate).toBe('2020-02-07');

        // Era malattia, non ferie: la richiesta si annulla, l'assenza resta.
        const sick = await api().put(`/staff/time-off/${timeOffId}`).set(bearer(owner)).send({ type: 'MALATTIA' });
        expect(sick.status).toBe(200);
        expect(sick.body.type).toBe('MALATTIA');
        const cancelled = await request();
        expect(cancelled.status).toBe('CANCELLED');
        expect(cancelled.timeOffId).toBeNull();
    });

    it('i giorni di ferie l\'anno: il manager non li legge e non li sovrascrive', async () => {
        const seen = await api().get(`/staff/${other}`).set(bearer(manager));
        expect(seen.status).toBe(200);
        expect(seen.body.annualLeaveDays).toBeNull();
        const list = await api().get('/staff').set(bearer(manager));
        expect(list.body.find((s: any) => s.id === other).annualLeaveDays).toBeNull();

        const put = await api().put(`/staff/${other}`).set(bearer(manager)).send({ annualLeaveDays: 3, role: 'Runner' });
        expect(put.status).toBe(200);
        expect(put.body.role).toBe('Runner');

        const after = await api().get(`/staff/${other}`).set(bearer(owner));
        expect(after.body.annualLeaveDays).toBe(26);
    });
});
