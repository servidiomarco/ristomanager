import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Guardrail nome ↔ rubrica sul canale voce (caso Taddeo/«Caddéo» 18/09/2026):
// chi chiama da un numero già in rubrica di norma È quel cliente. Se il nome
// dettato non c'entra col nome registrato, create_reservation NON salva e
// chiede all'agente di chiarire (error name_mismatch); un nome contenuto nel
// nome di rubrica (o le stesse parole in altro ordine) viene completato al
// nome registrato; name_confirmed: true bypassa il gate e lascia in nota il
// titolare del numero.
const TELEFONO = '3391230456';
const DATA = '2027-08-10';

const dbQuery = async (sql: string, params: any[] = []) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    try {
        return await client.query(sql, params);
    } finally {
        await client.end();
    }
};

const crea = (extra: Record<string, any>) =>
    api().post('/webhook/elevenlabs/create-reservation').send({
        phone: TELEFONO, date: DATA, shift: 'DINNER', guests: 2, ...extra,
    });

describe('nome dettato vs rubrica (create_reservation)', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);
        await dbQuery(
            `INSERT INTO customers (tenant_id, name, phone) VALUES (1, 'Taddeo Sergio', $1)`,
            [TELEFONO]
        );
    });

    afterAll(async () => {
        await dbQuery(`DELETE FROM reservations WHERE tenant_id = 1 AND phone LIKE '%' || $1`, [TELEFONO]);
        await dbQuery(`DELETE FROM customers WHERE tenant_id = 1 AND phone = $1`, [TELEFONO]);
    });

    it('nome che non c\'entra: name_mismatch, niente prenotazione', async () => {
        const res = await crea({ customer_name: 'Caddeo Taddeo', time: '20:00' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('name_mismatch');
        expect(res.body.registered_name).toBe('Taddeo Sergio');
        expect(res.body.message).toContain('Taddeo Sergio');

        const list = await api().get('/reservations').set(bearer(token));
        expect(list.body.find((r: any) => r.customer_name === 'Caddeo Taddeo')).toBeUndefined();
    });

    it('solo il cognome («Taddeo»): completa col nome di rubrica', async () => {
        const res = await crea({ customer_name: 'Taddeo', time: '20:00' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.confirmation_phrase).toContain('Taddeo');

        const list = await api().get('/reservations').set(bearer(token));
        const salvata = list.body.find((r: any) => r.id === res.body.reservation_id);
        expect(salvata.customer_name).toBe('Taddeo Sergio');
    });

    it('stesse parole in altro ordine («Sergio Taddeo»): forma di rubrica', async () => {
        const res = await crea({ customer_name: 'Sergio Taddeo', time: '20:30' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const list = await api().get('/reservations').set(bearer(token));
        const salvata = list.body.find((r: any) => r.id === res.body.reservation_id);
        expect(salvata.customer_name).toBe('Taddeo Sergio');
    });

    it('name_confirmed: salva il nome dettato col titolare del numero in nota', async () => {
        const res = await crea({ customer_name: 'Caddeo Taddeo', time: '21:00', name_confirmed: true });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const list = await api().get('/reservations').set(bearer(token));
        const salvata = list.body.find((r: any) => r.id === res.body.reservation_id);
        expect(salvata.customer_name).toBe('Caddeo Taddeo');
        expect(salvata.notes).toContain('Numero in rubrica: Taddeo Sergio');
    });

    it('numero NON in rubrica: nessun gate, si salva il nome dettato', async () => {
        const res = await api().post('/webhook/elevenlabs/create-reservation').send({
            customer_name: 'Rossi Mario', phone: '3390009988', date: DATA, time: '21:00', shift: 'DINNER', guests: 2,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        await dbQuery(`DELETE FROM reservations WHERE tenant_id = 1 AND id = $1`, [res.body.reservation_id]);
        await dbQuery(`DELETE FROM customers WHERE tenant_id = 1 AND phone LIKE '%3390009988'`);
    });
});
