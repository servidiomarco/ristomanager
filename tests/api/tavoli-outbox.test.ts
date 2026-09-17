import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Fase 1b della tappa 4: il dominio sala (tavoli, unioni, nascosti, chiusure)
// scrive l'evento nell'outbox DENTRO la transazione della mutazione, e il
// broadcast lo fa l'handler del dispatcher. Qui si verifica che ogni verbo
// lasci il suo evento nel log, con l'envelope, e che venga consegnato.
// Nessun feature flag toccato: il dominio sala è core.
describe('outbox del dominio sala', () => {
    let token: string;
    let db: Client;
    let roomId: number;
    let tableId: number;

    const DATE = '2027-03-10';

    const attesaConsegna = async (filtro: string, params: any[]): Promise<number> => {
        for (let i = 0; i < 50; i++) {
            const r = await db.query(
                `SELECT COUNT(*)::int AS n FROM outbox_events
                 WHERE ${filtro} AND delivered_at IS NULL`, params);
            if (r.rows[0].n === 0) break;
            await new Promise(rs => setTimeout(rs, 200));
        }
        const done = await db.query(
            `SELECT COUNT(*)::int AS n FROM outbox_events
             WHERE ${filtro} AND delivered_at IS NOT NULL`, params);
        return done.rows[0].n;
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();

        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Outbox 1b', width: 800, height: 600 });
        roomId = room.body.id;
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'OB1', shape: 'SQUARE', seats: 4, x: 100, y: 100, room_id: roomId, status: 'FREE',
        });
        expect(table.status).toBe(201);
        tableId = table.body.id;
    });

    afterAll(async () => {
        await db.end();
    });

    it('PUT /tables/:id scrive table:updated in transazione, con actor e envelope', async () => {
        const upd = await api().put(`/tables/${tableId}`).set(bearer(token)).send({ status: 'OCCUPIED' });
        expect(upd.status).toBe(200);

        const rows = await db.query(
            `SELECT payload, actor, event_id, schema_ver FROM outbox_events
             WHERE event = 'table:updated' AND aggregate = $1`,
            [`table:${tableId}`]
        );
        expect(rows.rows.length).toBeGreaterThanOrEqual(1);
        const row = rows.rows[0];
        // Riferimento, non snapshot: l'handler ricarica la riga vera.
        expect(row.payload.table_id).toBe(tableId);
        // L'actor porta SOLO riferimenti (regola PII): mai email o nome.
        expect(row.actor.user_id).toBeTypeOf('number');
        expect(row.actor.role).toBeTypeOf('string');
        expect(JSON.stringify(row.actor)).not.toContain('@');
        expect(row.event_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(row.schema_ver).toBe(1);

        const consegnati = await attesaConsegna(`event = 'table:updated' AND aggregate = $1`, [`table:${tableId}`]);
        expect(consegnati).toBeGreaterThanOrEqual(1);
    });

    it("unione e divisione lasciano l'evento con lo snapshot nel payload", async () => {
        const t2 = await api().post('/tables').set(bearer(token)).send({
            name: 'OB2', shape: 'SQUARE', seats: 2, x: 300, y: 100, room_id: roomId, status: 'FREE',
        });
        expect(t2.status).toBe(201);

        const merge = await api().post('/table-merges').set(bearer(token)).send({
            date: DATE, shift: 'DINNER', primary_id: tableId, merged_ids: [t2.body.id],
        });
        expect(merge.status).toBe(201);
        const mergeId = merge.body.id;

        const created = await db.query(
            `SELECT payload FROM outbox_events WHERE event = 'tableMerge:created' AND aggregate = $1`,
            [`tableMerge:${mergeId}`]
        );
        expect(created.rows.length).toBe(1);
        // Lo snapshot è il payload: id e date, nessuna anagrafica.
        expect(created.rows[0].payload).toMatchObject({
            id: mergeId, date: DATE, shift: 'DINNER', primary_id: tableId, merged_ids: [t2.body.id],
        });

        const del = await api().delete('/table-merges').set(bearer(token)).send({
            date: DATE, shift: 'DINNER', primary_id: tableId,
        });
        expect(del.status).toBe(200);

        const deleted = await db.query(
            `SELECT payload FROM outbox_events WHERE event = 'tableMerge:deleted' AND aggregate = $1`,
            [`tableMerge:${mergeId}`]
        );
        expect(deleted.rows.length).toBe(1);
        expect(deleted.rows[0].payload.merged_ids).toEqual([t2.body.id]);

        const consegnati = await attesaConsegna(`aggregate = $1`, [`tableMerge:${mergeId}`]);
        expect(consegnati).toBe(2);
    });

    it('nascondere/mostrare un tavolo e chiudere/riaprire una sala passano dal log', async () => {
        const hide = await api().post('/table-hidden').set(bearer(token)).send({
            date: DATE, shift: 'LUNCH', table_id: tableId,
        });
        expect(hide.status).toBe(201);
        const unhide = await api().delete('/table-hidden').set(bearer(token)).send({
            date: DATE, shift: 'LUNCH', table_id: tableId,
        });
        expect(unhide.status).toBe(200);

        const close = await api().post('/room-closed').set(bearer(token)).send({
            date: DATE, shift: 'LUNCH', room_id: roomId,
        });
        expect(close.status).toBe(201);
        const reopen = await api().delete('/room-closed').set(bearer(token)).send({
            date: DATE, shift: 'LUNCH', room_id: roomId,
        });
        expect(reopen.status).toBe(200);

        const eventi = await db.query(
            `SELECT event FROM outbox_events
             WHERE (aggregate = $1 OR aggregate = $2 OR aggregate = $3 OR aggregate = $4)
             ORDER BY id`,
            [
                `tableHidden:${hide.body.id}`, `tableHidden:${unhide.body.id}`,
                `roomClosed:${close.body.id}`, `roomClosed:${reopen.body.id}`,
            ]
        );
        expect(eventi.rows.map((r: any) => r.event)).toEqual([
            'tableHidden:created', 'tableHidden:deleted',
            'roomClosed:created', 'roomClosed:deleted',
        ]);
    });
});
