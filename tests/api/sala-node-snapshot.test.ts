import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Fase 2b della tappa 4: lo snapshot per il bootstrap del nodo di sala.
// Un dump coerente delle proiezioni del dominio servizio, marcato «al seq N»
// del log outbox — il nodo lo carica nel Postgres locale e segue il log da N.
describe('snapshot del nodo di sala', () => {
    let token: string;
    let nodeToken: string;
    let db: Client;
    let roomId: number;
    let vecchiaId: number;
    let recenteId: number;

    const snapshot = () => api().get('/sala-node/snapshot').set({ 'X-Sala-Node-Token': nodeToken });

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        const t = await db.query('SELECT sala_node_token FROM tenants WHERE id = 1');
        nodeToken = t.rows[0].sala_node_token;
        expect(nodeToken).toBeTruthy();

        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Snapshot', width: 700, height: 500 });
        roomId = room.body.id;

        // Una prenotazione dentro la finestra (oggi) e una fuori (90 giorni
        // fa, inserita diretta: il punto è la data, non il flusso).
        const recente = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Snapshot Recente',
            phone: '340 555 2288',
            reservation_time: new Date().toISOString(),
            shift: 'DINNER',
            guests: 2,
        });
        expect(recente.status).toBe(201);
        recenteId = recente.body.id;

        const vecchia = await db.query(
            `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, payment_status, arrival_status, reservation_status)
             VALUES (1, 'Snapshot Antica', NOW() - INTERVAL '90 days', 'DINNER', 2, 'PENDING', 'WAITING', 'CONFIRMED')
             RETURNING id`
        );
        vecchiaId = vecchia.rows[0].id;
    });

    afterAll(async () => {
        await db.query('DELETE FROM reservations WHERE id = ANY($1)', [[vecchiaId, recenteId]]).catch(() => {});
        await db.end();
    });

    it('senza token → 401, con token sbagliato → 401', async () => {
        const senza = await api().get('/sala-node/snapshot');
        expect(senza.status).toBe(401);
        const sbagliato = await api().get('/sala-node/snapshot').set({ 'X-Sala-Node-Token': 'token-sbagliato' });
        expect(sbagliato.status).toBe(401);
    });

    it('il dump è coerente: envelope, seq dal log, finestra rispettata', async () => {
        const res = await snapshot();
        expect(res.status).toBe(200);
        expect(res.body.format).toBe(1);
        expect(res.body.tenant_id).toBe(1);
        expect(typeof res.body.seq).toBe('number');
        expect(res.body.seq).toBeGreaterThanOrEqual(0);
        expect(res.body.window_days).toBe(60);

        const tables = res.body.tables;
        expect(tables.rooms.some((r: any) => r.id === roomId)).toBe(true);
        // Dentro la finestra sì, fuori no.
        const ids = tables.reservations.map((r: any) => r.id);
        expect(ids).toContain(recenteId);
        expect(ids).not.toContain(vecchiaId);
    });

    it('i segreti non lasciano il cloud', async () => {
        const res = await snapshot();
        const tables = res.body.tables;
        // Gli hash di users sono tolti riga per riga.
        expect(tables.users.length).toBeGreaterThan(0);
        for (const u of tables.users) {
            expect(u).not.toHaveProperty('password_hash');
            expect(u).not.toHaveProperty('refresh_token_hash');
            expect(u).not.toHaveProperty('reset_token_hash');
        }
        // La chiave ACME resta fuori; integration_settings e il log stesso
        // non sono nemmeno nell'allow-list.
        expect((tables.app_settings ?? []).some((r: any) => r.key === 'sala_node_acme_account_key')).toBe(false);
        expect(tables).not.toHaveProperty('integration_settings');
        expect(tables).not.toHaveProperty('outbox_events');
    });

    it('una mutazione di sala fa avanzare il seq: righe e cursore sono la stessa foto', async () => {
        const prima = await snapshot();
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'SNAP1', shape: 'SQUARE', seats: 2, x: 50, y: 50, room_id: roomId, status: 'FREE',
        });
        expect(table.status).toBe(201);
        const upd = await api().put(`/tables/${table.body.id}`).set(bearer(token)).send({ status: 'OCCUPIED' });
        expect(upd.status).toBe(200);

        const dopo = await snapshot();
        expect(dopo.body.seq).toBeGreaterThan(prima.body.seq);
        const row = dopo.body.tables.tables.find((r: any) => r.id === table.body.id);
        expect(row?.status).toBe('OCCUPIED');
    });
});
