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
            // Un sensore a sé: l'escursione si legge in ordine di misura, e le
            // letture in soglia di adesso del primo la spezzerebbero.
            const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
            await api().post('/haccp/sensors/ingest').query({ token }).send({ sensor: 'cella-sensori-ex', value: 3.0, at: ago(60) });
            const exId = (await api().get('/haccp/sensors').set(bearer(owner))).body.sensors.find((x: any) => x.externalId === 'cella-sensori-ex').id;
            expect((await api().put(`/haccp/sensors/${exId}`).set(bearer(owner)).send({ pointId })).status).toBe(200);

            await api().post('/haccp/sensors/ingest').query({ token }).send({ readings: [
                { sensor: 'cella-sensori-ex', value: 7.2, at: ago(40) },
            ] });
            let ncs = await api().get('/haccp/nonconformities').set(bearer(owner));
            expect(ncs.body.nonconformities.some((n: any) => n.source === 'SENSOR')).toBe(false);
            await api().post('/haccp/sensors/ingest').query({ token }).send({ readings: [
                { sensor: 'cella-sensori-ex', value: 7.8, at: ago(20) },
                { sensor: 'cella-sensori-ex', value: 8.1 },
            ] });
            await api().post('/haccp/sensors/ingest').query({ token }).send({ sensor: 'cella-sensori-ex', value: 8.3 });
            ncs = await api().get('/haccp/nonconformities').set(bearer(owner));
            const sensorNcs = ncs.body.nonconformities.filter((n: any) => n.source === 'SENSOR');
            expect(sensorNcs).toHaveLength(1);
            expect(sensorNcs[0].title).toContain('Cella sensori');
            expect(sensorNcs[0].title).toContain('da 40 minuti');
            const readings = await api().get(`/haccp/sensors/${exId}/readings`).set(bearer(owner)).query({ hours: 2 });
            expect(readings.body.readings.length).toBe(5);

            // Una lettura in soglia arrivata in ritardo non è lo stato di
            // adesso: la cella resta «fuori soglia».
            await api().post('/haccp/sensors/ingest').query({ token }).send({ sensor: 'cella-sensori-ex', value: 3.2, at: ago(30) });
            const after = (await api().get('/haccp/sensors').set(bearer(owner))).body.sensors.find((x: any) => x.id === exId);
            expect(after.outSince).not.toBeNull();
            expect(after.lastValue).toBe(8.3);
        });

        it('la stessa misura due volte resta una riga, e una lettura non si riscrive', async () => {
            const at = new Date(Date.now() - 5 * 60_000).toISOString();
            const first = await api().post('/haccp/sensors/ingest').query({ token }).send({ sensor: 'cella-sensori-01', value: 3.3, at });
            expect(first.body).toMatchObject({ accepted: 1, duplicates: 0 });
            const again = await api().post('/haccp/sensors/ingest').query({ token }).send({ sensor: 'cella-sensori-01', value: 3.3, at });
            expect(again.status).toBe(200);
            expect(again.body).toMatchObject({ accepted: 0, duplicates: 1 });
            const rows = await db.query(`SELECT count(*)::int AS n FROM haccp_sensor_readings WHERE sensor_id = $1 AND measured_at = $2`, [sensorId, at]);
            expect(rows.rows[0].n).toBe(1);
            await expect(db.query(`UPDATE haccp_sensor_readings SET value = 0 WHERE sensor_id = $1`, [sensorId])).rejects.toThrow(/sola aggiunta/);
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

        it('legge il gateway Milesight: un TS302 sono due sensori, uno per sonda', async () => {
            // Il decoder TS302 col «Metadata» del gateway acceso: piatto, con
            // devEUI e deviceName accanto alle temperature.
            const res = await api().post('/haccp/sensors/ingest').set('X-Haccp-Sensor-Token', token).send({
                applicationID: '1', devEUI: '24E124123456789A', deviceName: 'Celle',
                battery: 88, temperature_chn1: -19.2, temperature_chn2: 3.4, temperature_chn1_alarm: 'threshold',
            });
            expect(res.status).toBe(200);
            expect(res.body.accepted).toBe(2);
            const list = (await api().get('/haccp/sensors').set(bearer(owner))).body.sensors;
            const one = list.find((x: any) => x.externalId === '24e124123456789a-1');
            const two = list.find((x: any) => x.externalId === '24e124123456789a-2');
            expect(one).toMatchObject({ label: 'Celle sonda 1', vendor: 'milesight', lastValue: -19.2, battery: 88 });
            expect(two).toMatchObject({ label: 'Celle sonda 2', lastValue: 3.4 });

            // Senza «Metadata» (firmware vecchio) il DevEUI arriva dall'indirizzo.
            const bare = await api().post('/haccp/sensors/ingest').query({ token, device: '24e1240000000001' }).send({ battery: 70, temperature: 2.1 });
            expect(bare.body.accepted).toBe(1);
            // Il contatto della porta non è una lettura, ma nemmeno un errore.
            const door = await api().post('/haccp/sensors/ingest').query({ token }).send({ devEUI: '24e124123456789a', battery: 88, magnet_chn1: 'opened' });
            expect(door.status).toBe(200);
            expect(door.body.accepted).toBe(0);
            const after = (await api().get('/haccp/sensors').set(bearer(owner))).body.sensors;
            expect(after.find((x: any) => x.externalId === '24e1240000000001')).toMatchObject({ vendor: 'milesight', lastValue: 2.1 });
        });

        it('legge ChirpStack e The Things Network', async () => {
            const at = new Date(Date.now() - 60_000).toISOString();
            const cs = await api().post('/haccp/sensors/ingest').query({ token }).send({
                deviceInfo: { devEui: 'a84041000181c4d1', deviceName: 'Frigo bar' }, time: at, object: { temperature: 5.5, battery: 95 },
            });
            expect(cs.body.accepted).toBe(1);
            const ttn = {
                end_device_ids: { device_id: 'cella-ttn', dev_eui: '70B3D57ED0000001' },
                received_at: at,
                uplink_message: { decoded_payload: { temperature: -18.4 } },
            };
            expect((await api().post('/haccp/sensors/ingest').query({ token }).send(ttn)).body.accepted).toBe(1);
            expect((await api().post('/haccp/sensors/ingest').query({ token }).send(ttn)).body.duplicates).toBe(1);
            const list = (await api().get('/haccp/sensors').set(bearer(owner))).body.sensors;
            expect(list.find((x: any) => x.externalId === 'a84041000181c4d1')).toMatchObject({ label: 'Frigo bar', vendor: 'lorawan', lastValue: 5.5, battery: 95 });
            const t = list.find((x: any) => x.externalId === '70b3d57ed0000001');
            expect(t).toMatchObject({ label: 'cella-ttn', lastValue: -18.4 });
            expect(new Date(t.lastSeenAt).toISOString()).toBe(at);
        });

        it('lo storico ritrasmesso dopo un buco di rete apre la non conformità che c\'era', async () => {
            const nowSecs = Math.floor(Date.now() / 1000);
            const secs = (min: number) => nowSecs - min * 60;
            const eui = '24e124aaaaaaaaaa';
            await api().post('/haccp/sensors/ingest').query({ token }).send({ devEUI: eui, deviceName: 'Storico', temperature: 3.1 });
            const id = (await api().get('/haccp/sensors').set(bearer(owner))).body.sensors.find((x: any) => x.externalId === eui).id;
            expect((await api().put(`/haccp/sensors/${id}`).set(bearer(owner)).send({ pointId })).status).toBe(200);
            const before = (await api().get('/haccp/nonconformities').set(bearer(owner))).body.nonconformities.filter((n: any) => n.source === 'SENSOR').length;

            // L'ora dello storico è in secondi Unix: letta come millisecondi
            // cadrebbe nel 1970 e diventerebbe «adesso».
            const res = await api().post('/haccp/sensors/ingest').query({ token }).send({
                devEUI: eui, deviceName: 'Storico',
                history: [
                    { timestamp: secs(180), temperature: 9.0 },
                    { timestamp: secs(140), temperature: 9.5 },
                    { timestamp: secs(120), temperature: 3.0 },
                ],
            });
            expect(res.body.accepted).toBe(3);
            const stored = await db.query(`SELECT count(*)::int AS n FROM haccp_sensor_readings WHERE sensor_id = $1 AND measured_at = to_timestamp($2)`, [id, secs(180)]);
            expect(stored.rows[0].n).toBe(1);
            const ncs = (await api().get('/haccp/nonconformities').set(bearer(owner))).body.nonconformities.filter((n: any) => n.source === 'SENSOR');
            expect(ncs).toHaveLength(before + 1);
            const nc = ncs.find((n: any) => n.detail?.includes('Storico'));
            expect(nc.title).toContain('da 40 minuti');
            // Lo stato di adesso resta quello dell'ultima misura, in soglia.
            const s = (await api().get('/haccp/sensors').set(bearer(owner))).body.sensors.find((x: any) => x.id === id);
            expect(s.outSince).toBeNull();
            expect(s.lastValue).toBe(3.1);
        });

        it('la batteria scarica avvisa una volta, e si riarma a batteria cambiata', async () => {
            const alertedAt = async () => (await db.query(`SELECT battery_alerted_at FROM haccp_sensors WHERE id = $1`, [sensorId])).rows[0].battery_alerted_at;
            await api().post('/haccp/sensors/ingest').query({ token }).send({ sensor: 'cella-sensori-01', value: 3.0, battery: 15 });
            const first = await alertedAt();
            expect(first).not.toBeNull();
            await api().post('/haccp/sensors/ingest').query({ token }).send({ sensor: 'cella-sensori-01', value: 3.0, battery: 14 });
            expect((await alertedAt())?.toISOString()).toBe(first.toISOString());
            await api().post('/haccp/sensors/ingest').query({ token }).send({ sensor: 'cella-sensori-01', value: 3.0, battery: 100 });
            expect(await alertedAt()).toBeNull();
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
