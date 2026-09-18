import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Cellulari storici a 9 cifre (es. 330 581013) e prefisso +39: il vecchio
// raggruppamento per «ultime 10 cifre» pescava la 9 del prefisso
// ("39330581013" → "9330581013") e la risposta WhatsApp del cliente apriva
// una conversazione nuova invece di finire nel suo thread (caso Pisciotta
// 18/09/2026). Stessa radice per Sofia: il cliente in rubrica senza +39 non
// veniva riconosciuto dal caller id in E.164. La chiave ora è il numero
// NAZIONALE (phoneMatchKey), su ogni superficie.
const NUMERO_NUDO = '330581013';          // com'è in rubrica
const NUMERO_E164 = '+39330581013';       // come arriva da WhatsApp/telefono

const dbQuery = async (sql: string, params: any[] = []) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    try {
        return await client.query(sql, params);
    } finally {
        await client.end();
    }
};

describe('telefoni storici a 9 cifre: thread messaggi e riconoscimento', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
        await dbQuery(`INSERT INTO customers (tenant_id, name, phone) VALUES (1, 'Pisciotta Prova', $1)`, [NUMERO_NUDO]);
        // Conferma uscita verso il numero come sta in rubrica (senza +39)…
        await dbQuery(
            `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, to_phone, to_phone_digits, body, status)
             VALUES (1, 'twilio', 'whatsapp', 'outbound', $1, $2, 'Ciao, la tua prenotazione è confermata', 'sent')`,
            [NUMERO_NUDO, NUMERO_NUDO]
        );
        // …e risposta del cliente dal suo WhatsApp, in E.164.
        await dbQuery(
            `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, from_phone, from_phone_digits, body, status)
             VALUES (1, 'twilio', 'whatsapp', 'inbound', $1, $2, 'Grazie', 'received')`,
            [NUMERO_E164, NUMERO_E164.replace(/\D/g, '')]
        );
    });

    afterAll(async () => {
        await dbQuery(`DELETE FROM outbound_messages WHERE tenant_id = 1 AND (to_phone_digits IN ($1, $2) OR from_phone_digits IN ($1, $2))`, [NUMERO_NUDO, NUMERO_E164.replace(/\D/g, '')]);
        await dbQuery(`DELETE FROM customers WHERE tenant_id = 1 AND phone = $1`, [NUMERO_NUDO]);
    });

    it('lista conversazioni: un solo thread, chiave nazionale, non letto incluso', async () => {
        const res = await api().get('/messages/conversations').set(bearer(token));
        expect(res.status).toBe(200);
        const nostri = res.body.conversations.filter((c: any) =>
            ['330581013', '9330581013', '39330581013'].includes(c.phone_digits));
        expect(nostri).toHaveLength(1);
        expect(nostri[0].phone_digits).toBe(NUMERO_NUDO);
        expect(nostri[0].unread_count).toBe(1);
        expect(nostri[0].last_direction).toBe('inbound');
        expect(nostri[0].customer_name).toBeDefined();
    });

    it('timeline: stessa chat da entrambe le forme del numero', async () => {
        const nudo = await api().get(`/messages/conversations/${NUMERO_NUDO}`).set(bearer(token));
        expect(nudo.status).toBe(200);
        expect(nudo.body.messages).toHaveLength(2);

        const e164 = await api().get(`/messages/conversations/${encodeURIComponent(NUMERO_E164)}`).set(bearer(token));
        expect(e164.status).toBe(200);
        expect(e164.body.messages).toHaveLength(2);
    });

    it('segna letto: azzera anche il messaggio arrivato col +39', async () => {
        const res = await api().post(`/messages/conversations/${NUMERO_NUDO}/read`).set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.marked).toBe(1);
    });

    it('Sofia riconosce dal caller id E.164 il cliente in rubrica senza +39', async () => {
        const res = await api().post('/webhook/elevenlabs/lookup-customer').send({ phone: NUMERO_E164 });
        expect(res.status).toBe(200);
        expect(res.body.exists).toBe(true);
        expect(res.body.customer_name).toBe('Pisciotta Prova');
    });
});
