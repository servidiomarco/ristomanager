import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Eliminare una prenotazione nata da una telefonata azzerava il collegamento
// (FK ON DELETE SET NULL) e rimandava la chiamata fra le «Da ricontattare»:
// è successo con le tre chiamate di prova del 23/09/2026. Ora la chiamata
// resta gestita e porta l'etichetta «Prenotazione eliminata».
const CONV = 'conv-test-prenotazione-eliminata';
const PHONE = '+393390000701';

const dbQuery = async (sql: string, params: any[] = []) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    try {
        return await client.query(sql, params);
    } finally {
        await client.end();
    }
};

describe('chiamata vocale con prenotazione eliminata', () => {
    let token: string;
    let callId: number;
    let reservationId: number;

    beforeAll(async () => {
        token = await ownerToken();
        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);

        const creata = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Chiamata Test Eliminata',
            phone: PHONE,
            reservation_time: '2027-08-10T20:00:00',
            shift: 'DINNER',
            guests: 2,
            children: 0,
        });
        expect(creata.status).toBe(201);
        reservationId = creata.body.id;

        const tenant = await dbQuery(`SELECT tenant_id FROM reservations WHERE id = $1`, [reservationId]);
        const call = await dbQuery(
            `INSERT INTO voice_calls (tenant_id, conversation_id, phone, duration_seconds, reservation_id)
             VALUES ($1, $2, $3, 60, $4) RETURNING id`,
            [tenant.rows[0].tenant_id, CONV, PHONE, reservationId]
        );
        callId = call.rows[0].id;
    });

    afterAll(async () => {
        await dbQuery(`DELETE FROM voice_calls WHERE conversation_id = $1`, [CONV]);
        await dbQuery(`DELETE FROM reservations WHERE customer_name = 'Chiamata Test Eliminata'`);
    });

    it('eliminata la prenotazione, la chiamata non torna fra le da ricontattare', async () => {
        const del = await api().delete(`/reservations/${reservationId}`).set(bearer(token));
        expect(del.status).toBe(204);

        const detail = await api().get(`/voice-calls/${callId}`).set(bearer(token));
        expect(detail.status).toBe(200);
        expect(detail.body.reservation_id).toBeNull();
        expect(detail.body.reservation_deleted_at).toBeTruthy();
        expect(detail.body.follow_up_status).toBe('CONTACTED');

        const pending = await api().get('/voice-calls').set(bearer(token)).query({ follow_up: 'pending', q: '3390000701' });
        expect(pending.status).toBe(200);
        expect(pending.body.items.map((i: any) => i.id)).not.toContain(callId);
    });

    it('riportata a mano fra le da ricontattare perde l\'etichetta', async () => {
        const patch = await api().patch(`/voice-calls/${callId}/follow-up`).set(bearer(token)).send({ status: 'PENDING' });
        expect(patch.status).toBe(200);
        expect(patch.body.follow_up_status).toBe('PENDING');
        expect(patch.body.reservation_deleted_at).toBeNull();
    });
});
