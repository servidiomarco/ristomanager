import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// HACCP Fase 4 (docs/haccp-piano.md): i sensori di temperatura che scrivono
// nel registro da soli e aprono una non conformità sull'escursione lunga, e
// le etichette che escono sulla termica come job dell'agente di stampa.

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';

const rome = (d: Date) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).map(p => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
};

describe('HACCP · sensori ed etichette', () => {
    let owner = '';
    let kitchen = '';
    let db: Client;
    let token = '';
    let pointId = 0;
    let sensorId = 0;

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: dbUrl() });
        await db.connect();
        const email = 'cucina.sensori@example.com';
        await api().post('/auth/users').set(bearer(owner)).send({ email, password: 'password-sensori', full_name: 'Cuoca Sensori', role: 'KITCHEN' });
        kitchen = (await api().post('/auth/login').send({ email, password: 'password-sensori' })).body.accessToken;
        const point = await api().post('/haccp/points').set(bearer(owner)).send({ register: 'TEMPERATURE', label: 'Cella sensori', maxTemp: 4 });
        expect(point.status).toBe(201);
        pointId = point.body.id;
        // La prima fascia del sensore parte da qualche minuto fa: la lettura di
        // adesso cade nella sua finestra, a qualunque ora giri il test.
        const now = rome(new Date(Date.now() - 10 * 60_000));
        const slot1 = now.date === rome(new Date()).date ? now.time : '00:00';
        const s = await api().put('/haccp/settings').set(bearer(owner)).send({
            limits: { sensors: { slotTimes: [slot1, '23:58', '23:59'], outMinutes: 30, offlineMinutes: 60 } },
        });
        expect(s.status).toBe(200);
    });

    afterAll(async () => {
        try {
            await db.query(`UPDATE haccp_points SET active = false WHERE tenant_id = 1 AND label = 'Cella sensori'`);
            await db.query(`DELETE FROM haccp_settings WHERE tenant_id = 1`);
            await db.query(`DELETE FROM printers WHERE tenant_id = 1 AND name = 'etichette-test'`);
            await db.query(`DELETE FROM users WHERE email = 'cucina.sensori@example.com'`);
        } finally {
            await db.end();
        }
    });

    describe('sensori', () => {
        it('il token si genera da Configura, e senza token il webhook rifiuta', async () => {
            expect((await api().post('/haccp/sensors/token').set(bearer(kitchen))).status).toBe(403);
            const res = await api().post('/haccp/sensors/token').set(bearer(owner));
            expect(res.status).toBe(200);
            token = res.body.token;
            expect(token.length).toBeGreaterThanOrEqual(24);
            expect((await api().post('/haccp/sensors/ingest').send({ sensor: 'S1', value: 3 })).status).toBe(401);
            expect((await api().post('/haccp/sensors/ingest').set('X-Haccp-Sensor-Token', 'x'.repeat(32)).send({ sensor: 'S1', value: 3 })).status).toBe(401);
        });

        it('un sensore mai visto si registra da solo, non assegnato', async () => {
            const res = await api().post('/haccp/sensors/ingest').set('X-Haccp-Sensor-Token', token).send({
                readings: [{ sensor: 'cella-sensori-01', name: 'Sonda cella', value: 2.6 }],
            });
            expect(res.status).toBe(200);
            expect(res.body.accepted).toBe(1);
            const list = await api().get('/haccp/sensors').set(bearer(owner));
            const s = list.body.sensors.find((x: any) => x.externalId === 'cella-sensori-01');
            expect(s.label).toBe('Sonda cella');
            expect(s.pointId).toBeNull();
            expect(s.lastValue).toBe(2.6);
            sensorId = s.id;
        });

        it('assegnato, compila la rilevazione della sua fascia senza scavalcare nessuno', async () => {
            const assign = await api().put(`/haccp/sensors/${sensorId}`).set(bearer(owner)).send({ pointId });
            expect(assign.status).toBe(200);
            const res = await api().post('/haccp/sensors/ingest').query({ token }).send({ sensor: 'cella-sensori-01', value: 3.1 });
            expect(res.status).toBe(200);
            const today = rome(new Date()).date;
            const day = await api().get('/haccp/day').set(bearer(owner)).query({ date: today });
            const reading = day.body.temperatures.find((t: any) => t.pointId === pointId && t.slot === 1);
            expect(reading.temperature).toBe(3.1);
            expect(reading.sensorId).toBe(sensorId);
            expect(reading.recordedByUserName).toBe('Sensore Sonda cella');
            expect(day.body.sensors.some((s: any) => s.id === sensorId && s.pointId === pointId)).toBe(true);

            // La seconda lettura nella stessa fascia non riscrive la riga.
            await api().post('/haccp/sensors/ingest').query({ token }).send({ sensor: 'cella-sensori-01', value: 3.4 });
            const again = await api().get('/haccp/day').set(bearer(owner)).query({ date: today });
            expect(again.body.temperatures.find((t: any) => t.pointId === pointId && t.slot === 1).temperature).toBe(3.1);
        });

        it('fuori soglia da più di mezz\'ora apre una non conformità, una sola per escursione', async () => {
            const start = new Date(Date.now() - 40 * 60_000).toISOString();
            const mid = new Date(Date.now() - 20 * 60_000).toISOString();
            await api().post('/haccp/sensors/ingest').query({ token }).send({ readings: [
                { sensor: 'cella-sensori-01', value: 7.2, at: start },
            ] });
            let ncs = await api().get('/haccp/nonconformities').set(bearer(owner));
            expect(ncs.body.nonconformities.some((n: any) => n.source === 'SENSOR')).toBe(false);
            await api().post('/haccp/sensors/ingest').query({ token }).send({ readings: [
                { sensor: 'cella-sensori-01', value: 7.8, at: mid },
                { sensor: 'cella-sensori-01', value: 8.1 },
            ] });
            ncs = await api().get('/haccp/nonconformities').set(bearer(owner));
            const sensorNcs = ncs.body.nonconformities.filter((n: any) => n.source === 'SENSOR');
            expect(sensorNcs).toHaveLength(1);
            expect(sensorNcs[0].title).toContain('Cella sensori');
            expect(sensorNcs[0].title).toContain('da 40 minuti');
            const readings = await api().get(`/haccp/sensors/${sensorId}/readings`).set(bearer(owner)).query({ hours: 2 });
            expect(readings.body.readings.length).toBeGreaterThanOrEqual(5);
        });

        it('legge il webhook dei gateway Monnit', async () => {
            const res = await api().post('/haccp/sensors/ingest').set('X-Haccp-Sensor-Token', token).send({
                gatewayMessage: { gatewayID: '1', gatewayName: 'Cucina' },
                sensorMessages: [{ sensorID: '554433', sensorName: 'Congelatore Monnit', dataValue: '-19.4', messageDate: '2026-10-05 08:00:00', batteryLevel: '87' }],
            });
            expect(res.status).toBe(200);
            const list = await api().get('/haccp/sensors').set(bearer(owner));
            const s = list.body.sensors.find((x: any) => x.externalId === '554433');
            expect(s.vendor).toBe('monnit');
            expect(s.lastValue).toBe(-19.4);
            expect(s.battery).toBe(87);
        });

        it('un formato sconosciuto non passa', async () => {
            expect((await api().post('/haccp/sensors/ingest').query({ token }).send({ foo: 'bar' })).status).toBe(400);
        });
    });

    describe('etichette', () => {
        it('un\'etichetta sulla termica diventa un job ETICHETTA e resta registrata', async () => {
            await db.query(
                `INSERT INTO printers (tenant_id, name, host, port, kind) VALUES (1, 'etichette-test', '127.0.0.1', 9100, 'THERMAL')
                 ON CONFLICT DO NOTHING`,
            );
            const config = await api().get('/haccp/labels/config').set(bearer(kitchen));
            expect(config.body.printers).toContain('etichette-test');
            const res = await api().post('/haccp/labels').set(bearer(kitchen)).send({
                kind: 'APERTURA', product: 'Passata di pomodoro', expiryDate: '2026-10-09', lot: 'PS-1',
                storage: '0/+4 °C', allergens: ['Sedano'], copies: 2, printer: 'etichette-test',
            });
            expect(res.status).toBe(201);
            expect(res.body.printJobId).toBeTruthy();
            const job = await db.query(`SELECT kind, printer, payload FROM print_jobs WHERE id = $1`, [res.body.printJobId]);
            expect(job.rows[0].kind).toBe('ETICHETTA');
            expect(job.rows[0].printer).toBe('etichette-test');
            expect(job.rows[0].payload.copies).toBe(2);
            expect(job.rows[0].payload.operator).toBe('Cuoca Sensori');
            const list = await api().get('/haccp/labels').set(bearer(owner)).query({ date: res.body.labelDate });
            expect(list.body.labels.some((l: any) => l.id === res.body.id)).toBe(true);
            // Nel report del periodo, con lotto e scadenza del contenitore.
            const report = await api().get('/haccp/report').set(bearer(owner)).query({ from: res.body.labelDate, to: res.body.labelDate });
            const inReport = report.body.labels.find((l: any) => l.id === res.body.id);
            expect(inReport).toMatchObject({ product: 'Passata di pomodoro', lot: 'PS-1', expiryDate: '2026-10-09' });
        });

        it('senza stampante si registra soltanto; scadenza e stampante sconosciuta sono controllate', async () => {
            const res = await api().post('/haccp/labels').set(bearer(kitchen)).send({ kind: 'PRODUZIONE', product: 'Ragù', expiryDate: '2026-10-10' });
            expect(res.status).toBe(201);
            expect(res.body.printJobId).toBeNull();
            expect((await api().post('/haccp/labels').set(bearer(kitchen)).send({ kind: 'PRODUZIONE', product: 'Ragù' })).status).toBe(400);
            expect((await api().post('/haccp/labels').set(bearer(kitchen)).send({
                kind: 'PRODUZIONE', product: 'Ragù', expiryDate: '2026-10-10', printer: 'inesistente',
            })).status).toBe(400);
        });

        it('i modelli si configurano da responsabile', async () => {
            expect((await api().post('/haccp/label-presets').set(bearer(kitchen)).send({ name: 'Ragù', shelfLifeDays: 3 })).status).toBe(403);
            const created = await api().post('/haccp/label-presets').set(bearer(owner)).send({
                name: 'Ragù di carne', kind: 'PRODUZIONE', shelfLifeDays: 3, storage: '0/+4 °C', allergens: ['Sedano'],
            });
            expect(created.status).toBe(201);
            expect(created.body.shelfLifeDays).toBe(3);
            const upd = await api().put(`/haccp/label-presets/${created.body.id}`).set(bearer(owner)).send({ shelfLifeDays: 4 });
            expect(upd.body.shelfLifeDays).toBe(4);
            const config = await api().get('/haccp/labels/config').set(bearer(kitchen));
            expect(config.body.presets.some((p: any) => p.id === created.body.id)).toBe(true);
        });
    });
});
