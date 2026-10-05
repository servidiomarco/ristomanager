import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
import { haccpMissingTag, haccpTemperatureTag } from '../../utils/haccp';

// Avvisi HACCP: una temperatura fuori soglia avvisa chi risponde del registro
// (non chi l'ha scritta) e si chiude per tutti quando la postazione torna in
// soglia o la lettura si cancella; il promemoria «rilevazioni mancanti» si
// chiude quando il registro del giorno è completo.

const MANAGER_EMAIL = 'manager.haccp@example.com';
const PASSWORD = 'password-haccp-notifiche';

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';

// Il giorno del ristorante (tenant 1, Europe/Rome): solo oggi suona.
const romeToday = (): string => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

describe('HACCP · avvisi temperature', () => {
    let owner = '';
    let ownerId = 0;
    let manager = '';
    let managerId = 0;
    let db: Client;
    const today = romeToday();

    const rowsFor = async (userId: number, tag: string) =>
        (await db.query(
            `SELECT id, read_at, title, body FROM notifications
              WHERE tenant_id = 1 AND recipient_user_id = $1 AND tag = $2`,
            [userId, tag]
        )).rows;

    const record = (location: string, temperature: number, targetMax: number, date = today) =>
        api().post('/haccp/temperatures').set(bearer(owner)).send({ date, location, temperature, targetMax });

    beforeAll(async () => {
        owner = await ownerToken();
        const me = await api().post('/auth/login').send({
            email: process.env.TEST_OWNER_EMAIL,
            password: process.env.TEST_OWNER_PASSWORD,
        });
        ownerId = me.body.user.id;
        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: MANAGER_EMAIL, password: PASSWORD, full_name: 'Test Haccp', role: 'MANAGER',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: MANAGER_EMAIL, password: PASSWORD });
        expect(login.status).toBe(200);
        manager = login.body.accessToken;
        managerId = login.body.user.id;

        db = new Client({ connectionString: dbUrl() });
        await db.connect();
        await db.query(`DELETE FROM haccp_temperature_readings WHERE tenant_id = 1 AND date = $1`, [today]);
    });

    afterAll(async () => {
        try {
            await db.query(`DELETE FROM notifications WHERE tag LIKE 'haccp-%'`);
            await db.query(`DELETE FROM haccp_temperature_readings WHERE tenant_id = 1 AND date = $1`, [today]);
            await db.query(`DELETE FROM users WHERE email = $1`, [MANAGER_EMAIL]);
        } finally {
            await db.end();
        }
    });

    it('fuori soglia: avvisa gli altri, non chi ha registrato', async () => {
        const res = await record('Cella 1', 7.5, 4);
        expect(res.status).toBe(201);
        const tag = haccpTemperatureTag(today, 'Cella 1');
        expect(tag).toBe(`haccp-temp-${today}-cella-1`);

        const theirs = await rowsFor(managerId, tag);
        expect(theirs).toHaveLength(1);
        expect(theirs[0].read_at).toBeNull();
        expect(theirs[0].title).toBe('Temperatura fuori soglia');
        expect(theirs[0].body).toBe('Cella 1 · 7,5 °C (limite 4 °C)');
        expect(await rowsFor(ownerId, tag)).toHaveLength(0);
    });

    it('lo stesso valore ripubblicato non riapre un avviso già letto', async () => {
        const tag = haccpTemperatureTag(today, 'Cella 1');
        const [row] = await rowsFor(managerId, tag);
        const read = await api().post(`/notifications/${row.id}/read`).set(bearer(manager));
        expect(read.status).toBe(200);

        expect((await record('Cella 1', 7.5, 4)).status).toBe(201);
        const [after] = await rowsFor(managerId, tag);
        expect(after.read_at).not.toBeNull();
    });

    it('di nuovo in soglia: l\'avviso si chiude per tutti', async () => {
        const tag = haccpTemperatureTag(today, 'Cella 2');
        expect((await record('Cella 2', 9, 4)).status).toBe(201);
        expect((await rowsFor(managerId, tag))[0].read_at).toBeNull();

        expect((await record('Cella 2', 3, 4)).status).toBe(201);
        expect((await rowsFor(managerId, tag))[0].read_at).not.toBeNull();
    });

    it('lettura cancellata: l\'avviso si chiude', async () => {
        const tag = haccpTemperatureTag(today, 'Congelatore 1c');
        const res = await record('Congelatore 1c', -10, -18);
        expect(res.status).toBe(201);
        expect((await rowsFor(managerId, tag))[0].read_at).toBeNull();

        const del = await api().delete(`/haccp/temperatures/${res.body.id}`).set(bearer(owner));
        expect(del.status).toBe(204);
        expect((await rowsFor(managerId, tag))[0].read_at).not.toBeNull();
    });

    it('un giorno passato non suona', async () => {
        const res = await record('Cella 3', 12, 4, '2026-01-15');
        expect(res.status).toBe(201);
        expect(await rowsFor(managerId, haccpTemperatureTag('2026-01-15', 'Cella 3'))).toHaveLength(0);
        await db.query(`DELETE FROM haccp_temperature_readings WHERE tenant_id = 1 AND date = '2026-01-15'`);
    });

    it('registro completo: il promemoria delle mancanti si chiude', async () => {
        const tag = haccpMissingTag(today);
        const inserted = await db.query(
            `INSERT INTO notifications (tenant_id, recipient_user_id, category, title, body, tag)
             VALUES (1, $1, 'system', 'Mancano 2 temperature', 'Cella 4, Frigo primi', $2) RETURNING id`,
            [managerId, tag]
        );
        const id = Number(inserted.rows[0].id);
        // Le postazioni sono quelle del ristorante (haccp_points): il
        // Frantoio di tenant 1 più quelle che un altro test avesse aggiunto.
        const config = await api().get('/haccp/points').set(bearer(owner));
        expect(config.status).toBe(200);
        const locations = config.body.points.filter((p: any) => p.register === 'TEMPERATURE');
        expect(locations.length).toBeGreaterThan(1);
        const inRange = (p: any) => (typeof p.maxTemp === 'number' ? p.maxTemp - 1 : p.minTemp + 1);
        for (const loc of locations.slice(0, -1)) {
            expect((await record(loc.label, inRange(loc), loc.maxTemp)).status).toBe(201);
        }
        const readAt = async () => (await db.query(`SELECT read_at FROM notifications WHERE id = $1`, [id])).rows[0].read_at;
        expect(await readAt()).toBeNull();

        const last = locations[locations.length - 1];
        expect((await record(last.label, inRange(last), last.maxTemp)).status).toBe(201);
        expect(await readAt()).not.toBeNull();
    });

    it('il promemoria di sistema è seminato e si configura come gli altri', async () => {
        const res = await api().get('/reminders').set(bearer(owner));
        expect(res.status).toBe(200);
        const haccp = res.body.reminders.find((r: any) => r.system_key === 'HACCP_TEMPERATURES');
        expect(haccp).toBeTruthy();
        expect(haccp.schedule_time).toBe('11:00');
        expect(haccp.target_roles).toEqual(['OWNER', 'GENERAL_MANAGER', 'MANAGER', 'KITCHEN']);
    });
});
