import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
import { describeShiftChanges, shiftDayLabel } from '../../utils/staffShiftChange';

// «Il tuo turno è cambiato»: la persona con l'account collegato alla scheda
// riceve UN avviso con le sole differenze, dopo che la griglia ha finito di
// scrivere (SHIFT_CHANGE_NOTIFY_DELAY_MS, 300 ms nei test).

const EMAIL = 'cameriere.turni@example.com';
const PASSWORD = 'password-turni';
const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';

const romeToday = (): string => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const addDays = (iso: string, n: number): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('personale · cambio turno', () => {
    let owner = '';
    let waiterId = 0;
    let staffId = '';
    let db: Client;
    const day = addDays(romeToday(), 3);
    const tag = () => `shift-change-${staffId}`;

    const notifications = async () => (await db.query(
        `SELECT title, body, read_at FROM notifications WHERE recipient_user_id = $1 AND tag = $2`,
        [waiterId, tag()]
    )).rows;
    const waitForNotification = async () => {
        for (let i = 0; i < 40; i++) {
            const rows = await notifications();
            if (rows.length > 0) return rows;
            await sleep(100);
        }
        return notifications();
    };

    beforeAll(async () => {
        owner = await ownerToken();
        const user = await api().post('/auth/users').set(bearer(owner)).send({
            email: EMAIL, password: PASSWORD, full_name: 'Test Turni', role: 'WAITER',
        });
        expect(user.status).toBe(201);
        waiterId = Number(user.body.id);
        // Extra: nessuna presenza automatica, il giorno è solo quello scritto.
        const staff = await api().post('/staff').set(bearer(owner)).send({
            name: 'Test', surname: 'Turni', category: 'SALA', staffType: 'EXTRA', userId: waiterId,
        });
        expect(staff.status).toBe(201);
        staffId = staff.body.id;
        db = new Client({ connectionString: dbUrl() });
        await db.connect();
    });

    afterAll(async () => {
        try {
            await db.query(`DELETE FROM notifications WHERE recipient_user_id = $1`, [waiterId]);
            await db.query(`DELETE FROM staff_shifts WHERE staff_id = $1`, [staffId]);
            await db.query(`DELETE FROM staff_members WHERE id = $1`, [staffId]);
            await db.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
        } finally {
            await db.end();
        }
    });

    it('legge il giorno come la griglia', () => {
        const fisso = { staffType: 'FISSO', weeklyRestDay: 1, hireDate: null, contractEndDate: null };
        const extra = { staffType: 'EXTRA', weeklyRestDay: null, hireDate: null, contractEndDate: null };
        // 2026-10-05 è lunedì (riposo settimanale del fisso), 2026-10-06 martedì.
        expect(shiftDayLabel(fisso, '2026-10-06', [], [])).toBe('pranzo e cena');
        expect(shiftDayLabel(fisso, '2026-10-05', [], [])).toBe('riposo');
        expect(shiftDayLabel(fisso, '2026-10-06', [{ date: '2026-10-06', shift: 'LUNCH', present: false }], [])).toBe('cena');
        expect(shiftDayLabel(fisso, '2026-10-06', [], [
            { startDate: '2026-10-06', endDate: '2026-10-08', shift: null, type: 'MALATTIA' },
        ])).toBe('malattia');
        expect(shiftDayLabel(extra, '2026-10-06', [], [])).toBe('nessun turno');
        expect(shiftDayLabel(extra, '2026-10-06', [{ date: '2026-10-06', shift: 'DINNER', present: true }], [])).toBe('cena');
        expect(describeShiftChanges([
            { date: '2026-10-04', before: 'riposo', after: 'pranzo e cena' },
            { date: '2026-10-03', before: 'cena', after: 'riposo' },
        ])).toBe('sab 3 ott: cena → riposo · dom 4 ott: riposo → pranzo e cena');
    });

    it('più scritture sullo stesso giorno: un solo avviso con la differenza finale', async () => {
        // Come la griglia: crea la cena, poi aggiunge il pranzo.
        const [a, b] = await Promise.all([
            api().post('/staff/shifts').set(bearer(owner)).send({ staffId, date: day, shift: 'DINNER', present: true }),
            api().post('/staff/shifts').set(bearer(owner)).send({ staffId, date: day, shift: 'LUNCH', present: true }),
        ]);
        expect(a.status).toBe(201);
        expect(b.status).toBe(201);

        const rows = await waitForNotification();
        expect(rows).toHaveLength(1);
        expect(rows[0].title).toBe('Il tuo turno è cambiato');
        expect(rows[0].body).toMatch(/: nessun turno → pranzo e cena$/);
        expect(rows[0].read_at).toBeNull();
    });

    it('tornare allo stato di prima non avvisa', async () => {
        await db.query(`DELETE FROM notifications WHERE recipient_user_id = $1`, [waiterId]);
        const lunch = await api().post('/staff/shifts').set(bearer(owner))
            .send({ staffId, date: day, shift: 'LUNCH', present: false });
        expect(lunch.status).toBe(201);
        const back = await api().post('/staff/shifts').set(bearer(owner))
            .send({ staffId, date: day, shift: 'LUNCH', present: true });
        expect(back.status).toBe(201);
        await sleep(1000);
        expect(await notifications()).toHaveLength(0);
    });

    it('un giorno passato non avvisa', async () => {
        const past = await api().post('/staff/shifts').set(bearer(owner))
            .send({ staffId, date: addDays(romeToday(), -2), shift: 'DINNER', present: true });
        expect(past.status).toBe(201);
        await sleep(1000);
        expect(await notifications()).toHaveLength(0);
    });
});
