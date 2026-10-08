import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// «Crea nel CRM le sale e i tavoli della cassa» (prima installazione vera,
// 08/10): un ristorante nuovo ha la pianta in cassa e niente nel CRM. Dalla
// pianta letta si creano le sale scelte coi tavoli già abbinati; una sala o
// un tavolo che nel CRM c'è già si riusa, e rifarlo non crea doppioni.

const PIANTA = [
    { sala: 'SOPRA PROVA', tavoli: [{ nome: '7', coperti: 6 }, { nome: '8', coperti: 1 }] },
    { sala: 'SOTTO PROVA', tavoli: [{ nome: '1', coperti: 4 }, { nome: 'BANCO', coperti: null }, { nome: '2', coperti: 2 }] },
    { sala: 'MYSELF', tavoli: [{ nome: '2000', coperti: 1 }] },
];

describe('sale e tavoli del CRM creati dalla cassa', () => {
    let token: string;
    let db: Client;
    let piantaPrima: unknown = null;

    const crea = (sale: unknown) => api().post('/passepartout/tavoli/crea').set(bearer(token)).send({ sale });
    const tavoliDella = async (sala: string) => (await db.query(
        `SELECT t.name, t.seats, t.x, t.y, t.shape, t.status, pt.pp_sala, pt.pp_tavolo, pt.origine, pt.confermato
           FROM tables t JOIN rooms r ON r.id = t.room_id
           LEFT JOIN passepartout_tavoli pt ON pt.table_id = t.id
          WHERE t.tenant_id = 1 AND r.name = $1 ORDER BY t.id`,
        [sala]
    )).rows;

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
        piantaPrima = (await db.query(`SELECT pianta FROM passepartout_config WHERE tenant_id = 1`)).rows[0]?.pianta ?? null;
        // Nel CRM c'è già la sala di sotto, col tavolo 1 abbinato e un «banco»
        // scritto in minuscolo, non ancora abbinato.
        const sotto = await db.query(`INSERT INTO rooms (tenant_id, name, width, height) VALUES (1, 'SOTTO PROVA', 800, 600) RETURNING id`);
        const uno = await db.query(
            `INSERT INTO tables (tenant_id, name, shape, seats, x, y, room_id, status) VALUES (1, '1', 'SQUARE', 4, 60, 60, $1, 'FREE') RETURNING id`,
            [sotto.rows[0].id]
        );
        await db.query(
            `INSERT INTO tables (tenant_id, name, shape, seats, x, y, room_id, status) VALUES (1, 'banco', 'RECTANGLE', 2, 200, 60, $1, 'FREE')`,
            [sotto.rows[0].id]
        );
        await db.query(
            `INSERT INTO passepartout_tavoli (table_id, tenant_id, pp_sala, pp_tavolo, origine, confermato) VALUES ($1, 1, 'SOTTO PROVA', '1', 'manuale', true)`,
            [uno.rows[0].id]
        );
    });

    afterAll(async () => {
        await db.query(`DELETE FROM rooms WHERE tenant_id = 1 AND name IN ('SOPRA PROVA', 'SOTTO PROVA', 'MYSELF')`);
        await db.query(
            `INSERT INTO passepartout_config (tenant_id, pianta) VALUES (1, $1::jsonb)
             ON CONFLICT (tenant_id) DO UPDATE SET pianta = EXCLUDED.pianta`,
            [piantaPrima == null ? null : JSON.stringify(piantaPrima)]
        );
        await db.end();
    });

    it('senza la pianta letta dalla cassa non crea niente', async () => {
        await db.query(
            `INSERT INTO passepartout_config (tenant_id, pianta) VALUES (1, NULL)
             ON CONFLICT (tenant_id) DO UPDATE SET pianta = NULL`
        );
        const r = await crea(['SOPRA PROVA']);
        expect(r.status).toBe(409);
        expect(r.body.error).toBe('pianta_non_letta');
    });

    it('crea le sale scelte coi tavoli già abbinati, riusando quello che nel CRM c\'è già', async () => {
        await db.query(`UPDATE passepartout_config SET pianta = $1::jsonb WHERE tenant_id = 1`, [JSON.stringify(PIANTA)]);
        expect((await crea([])).status).toBe(400);
        expect((await crea(['NON ESISTE'])).status).toBe(400);

        const r = await crea(['SOPRA PROVA', 'SOTTO PROVA']);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ sale_create: 1, tavoli_creati: 3, tavoli_abbinati: 1, gia_abbinati: 1 });

        // Sala nuova, in griglia; i posti dalla cassa, 4 se la cassa dice 0 o 1.
        expect(await tavoliDella('SOPRA PROVA')).toEqual([
            { name: '7', seats: 6, x: 60, y: 60, shape: 'SQUARE', status: 'FREE', pp_sala: 'SOPRA PROVA', pp_tavolo: '7', origine: 'manuale', confermato: true },
            { name: '8', seats: 4, x: 200, y: 60, shape: 'SQUARE', status: 'FREE', pp_sala: 'SOPRA PROVA', pp_tavolo: '8', origine: 'manuale', confermato: true },
        ]);
        // Sala che c'era: il «banco» si abbina invece di raddoppiarsi, il 2
        // nasce dopo i due tavoli che c'erano.
        expect(await tavoliDella('SOTTO PROVA')).toEqual([
            expect.objectContaining({ name: '1', pp_tavolo: '1' }),
            expect.objectContaining({ name: 'banco', shape: 'RECTANGLE', pp_sala: 'SOTTO PROVA', pp_tavolo: 'BANCO', confermato: true }),
            expect.objectContaining({ name: '2', seats: 2, x: 340, y: 60, pp_tavolo: '2', confermato: true }),
        ]);
        // La sala virtuale non scelta resta fuori.
        expect((await db.query(`SELECT 1 FROM rooms WHERE tenant_id = 1 AND name = 'MYSELF'`)).rows).toHaveLength(0);
        // La risposta porta già la lista aggiornata per la sezione.
        expect(r.body.tavoli.filter((t: any) => t.pp_sala === 'SOPRA PROVA')).toHaveLength(2);
    });

    it('rifarlo non crea doppioni', async () => {
        const r = await crea(['SOPRA PROVA', 'SOTTO PROVA']);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ sale_create: 0, tavoli_creati: 0, tavoli_abbinati: 0, gia_abbinati: 5 });
        expect(await tavoliDella('SOPRA PROVA')).toHaveLength(2);
        expect(await tavoliDella('SOTTO PROVA')).toHaveLength(3);
    });
});
