import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// «Chi chiama» (docs/telefono-piano.md, Fase 1): l'init di Sofia apre una
// chiamata in corso con la scheda del cliente, il post-call la chiude. Il
// banner del CRM la legge da /phone/live e dagli eventi phoneCall:*.
//
// Telefono e call sid unici per non collidere con gli altri file (i test
// girano in sequenza sullo stesso DB).
const TELEFONO = '3478801234';
const CALL_SID = 'CAtelefonochichiama0001';
const WAITER_EMAIL = 'cameriere.telefono@example.com';
const PASSWORD = 'password-cameriere-telefono';

// L'annuncio parte in parallelo alla risposta dell'init: si aspetta che arrivi.
const waitFor = async <T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
    let last = await read();
    for (let i = 0; i < 20 && !ok(last); i++) {
        await new Promise(r => setTimeout(r, 100));
        last = await read();
    }
    return last;
};

describe('telefono: chi chiama mentre Sofia parla', () => {
    let token: string;
    let reservationId: number;

    beforeAll(async () => {
        token = await ownerToken();
        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);

        const customer = await api().post('/customers').set(bearer(token)).send({
            name: 'Ornella Telefono',
            phone: TELEFONO,
            is_vip: true,
            dietary_notes: 'Allergia alle noci',
        });
        expect(customer.status).toBe(201);

        const reservation = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Ornella Telefono',
            phone: TELEFONO,
            reservation_time: '2027-06-12T20:30:00',
            shift: 'DINNER',
            guests: 4,
            children: 0,
        });
        expect(reservation.status).toBe(201);
        reservationId = reservation.body.id;
    });

    afterAll(async () => {
        // Il DB è condiviso fra i file: si toglie l'utente creato qui.
        const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await client.connect();
        try {
            await client.query(`DELETE FROM users WHERE email = $1`, [WAITER_EMAIL]);
        } finally {
            await client.end();
        }
    });

    const live = async () => {
        const res = await api().get('/phone/live').set(bearer(token));
        expect(res.status).toBe(200);
        return res.body.calls as any[];
    };

    it("l'init apre la chiamata con la scheda del cliente", async () => {
        const init = await api().post('/webhook/elevenlabs/init-conversation').send({
            caller_id: `+39${TELEFONO}`,
            call_sid: CALL_SID,
            called_number: '+390985010032',
        });
        expect(init.status).toBe(200);
        expect(init.body.type).toBe('conversation_initiation_client_data');

        const calls = await waitFor(live, cs => cs.some(c => c.id === CALL_SID));
        const call = calls.find(c => c.id === CALL_SID);
        expect(call).toBeTruthy();
        expect(call.channel).toBe('sofia');
        expect(call.phone).toBe(`+39${TELEFONO}`);
        expect(call.card.customer.name).toBe('Ornella Telefono');
        expect(call.card.customer.is_vip).toBe(true);
        expect(call.card.customer.dietary_notes).toBe('Allergia alle noci');
        expect(call.card.upcoming.map((r: any) => r.id)).toContain(reservationId);
    });

    it('il post-call la chiude', async () => {
        const post = await api().post('/webhook/elevenlabs/post-call').send({
            type: 'post_call_transcription',
            data: {
                conversation_id: 'conv_telefono_chi_chiama_1',
                transcript: [{ role: 'agent', message: 'Buonasera, sono Sofia.' }],
                metadata: {
                    call_duration_secs: 42,
                    phone_call: { call_sid: CALL_SID, external_number: `+39${TELEFONO}` },
                },
            },
        });
        expect(post.status).toBe(200);

        const calls = await waitFor(live, cs => !cs.some(c => c.id === CALL_SID));
        expect(calls.some(c => c.id === CALL_SID)).toBe(false);
    });

    it('senza numero né sid non apre niente', async () => {
        const before = (await live()).length;
        const init = await api().post('/webhook/elevenlabs/init-conversation').send({});
        expect(init.status).toBe(200);
        await new Promise(r => setTimeout(r, 300));
        expect((await live()).length).toBe(before);
    });

    it('un numero sconosciuto ha la scheda vuota', async () => {
        const sid = 'CAtelefonochichiama0002';
        await api().post('/webhook/elevenlabs/init-conversation').send({ caller_id: '+393470000999', call_sid: sid });
        const calls = await waitFor(live, cs => cs.some(c => c.id === sid));
        const call = calls.find(c => c.id === sid);
        expect(call.card.customer).toBeNull();
        expect(call.card.visits).toBe(0);
        expect(call.card.upcoming).toEqual([]);

        await api().post('/webhook/elevenlabs/post-call').send({
            data: { conversation_id: 'conv_telefono_chi_chiama_2', metadata: { phone_call: { call_sid: sid, external_number: '+393470000999' } } },
        });
        await waitFor(live, cs => !cs.some(c => c.id === sid));
    });

    it('il cameriere non vede le chiamate in corso', async () => {
        const created = await api().post('/auth/users').set(bearer(token)).send({
            email: WAITER_EMAIL, password: PASSWORD, full_name: 'Cameriere Telefono', role: 'WAITER',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: WAITER_EMAIL, password: PASSWORD });
        expect(login.status).toBe(200);
        const res = await api().get('/phone/live').set(bearer(login.body.accessToken));
        expect(res.status).toBe(403);
    });
});
