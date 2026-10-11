import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
import { AI_STUB_PORT, startAiStub, stubCalls, stubText, type AiStub } from './aiStub';

// WhatsApp, Fase 4: gli strumenti informazioni e richiamata dell'agente.
//
// «Siamo aperti?», «l'esterno è chiuso?» (Frantoio, settembre 2026): l'agente
// poteva rispondere solo con le regole scritte a mano. Ora legge orari,
// chiusure e sale dal gestionale (get_restaurant_info). E un gruppo da 21 col
// menù da definire diventa un promemoria «da ricontattare» con la push
// (request_callback), invece di una promessa in chat.
//   TEST_AI_STUB=1 ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://127.0.0.1:47649 \
//   npx vitest run tests/api/agente-whatsapp-strumenti.test.ts

const NUMERO = '3391188101';
const SALA = 'Terrazza Strumenti';

const giornoFra = (days: number): string => {
    const oggi = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
    const [y, m, d] = oggi.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const CHIUSO = giornoFra(20);
const SALA_CHIUSA = giornoFra(21);

describe.runIf(AI_STUB_PORT > 0)('agente WhatsApp: informazioni e richiamate', () => {
    let stub: AiStub;
    let db: Client;
    let token = '';
    let roomId = 0;

    const giro = async (...risposte: Parameters<AiStub['load']>) => {
        stub.load(...risposte);
        const res = await api().post('/messages/agent/run').set(bearer(token)).send({ phone_digits: NUMERO });
        expect(res.status).toBe(200);
        return res;
    };

    beforeAll(async () => {
        stub = await startAiStub();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true });
        await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: true });
        await db.query(`INSERT INTO ai_knowledge_entries (tenant_id, title, content) VALUES (1, 'Strumenti test', 'Siamo aperti a cena')`);
        await db.query(`INSERT INTO special_closures (tenant_id, date, shift, reason) VALUES (1, $1, NULL, 'Ferie strumenti')`, [CHIUSO]);
        const r = await db.query(
            `INSERT INTO rooms (tenant_id, name, width, height, location) VALUES (1, $1, 800, 600, 'OUTDOOR') RETURNING id`, [SALA]
        );
        roomId = r.rows[0].id;
        await db.query(`INSERT INTO room_closed_overrides (tenant_id, date, shift, room_id) VALUES (1, $1, 'DINNER', $2)`, [SALA_CHIUSA, roomId]);
        await db.query(
            `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, from_phone, from_phone_digits, body, status)
             VALUES (1, 'twilio', 'whatsapp', 'inbound', $1, $2, 'Siete aperti? Siamo in 21, il menù è da definire', 'received')`,
            [`+39${NUMERO}`, `39${NUMERO}`]
        );
    });

    afterAll(async () => {
        await stub.close();
        await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: false });
        await db.query(`DELETE FROM outbound_messages WHERE tenant_id = 1 AND from_phone_digits = $1`, [`39${NUMERO}`]);
        await db.query(`DELETE FROM voice_calls WHERE tenant_id = 1 AND conversation_id LIKE 'wa-cb-1-%'`);
        await db.query(`DELETE FROM room_closed_overrides WHERE tenant_id = 1 AND room_id = $1`, [roomId]);
        await db.query(`DELETE FROM rooms WHERE id = $1`, [roomId]);
        await db.query(`DELETE FROM special_closures WHERE tenant_id = 1 AND reason = 'Ferie strumenti'`);
        await db.query(`DELETE FROM ai_knowledge_entries WHERE tenant_id = 1 AND title = 'Strumenti test'`);
        await db.query(`DELETE FROM ai_token_usage WHERE feature = 'whatsapp_agent'`);
        await db.end();
    });

    it('orari e chiusure arrivano dal gestionale', async () => {
        await giro(
            stubCalls(
                ['h1', 'get_restaurant_info', { topic: 'hours', date: CHIUSO }],
                ['h2', 'get_restaurant_info', { topic: 'closures' }],
            ),
            stubText('Quel giorno siamo chiusi.'),
        );
        const orari = stub.toolResult('h1');
        expect(orari.executed).toBe(true);
        expect(orari.orari_settimanali).toHaveLength(7);
        // La chiusura straordinaria vince sulla settimana tipo.
        expect(orari.giorno).toEqual({ data: CHIUSO, pranzo: 'chiuso', cena: 'chiuso' });
        const chiusure = stub.toolResult('h2');
        expect(chiusure.chiusure_straordinarie).toContainEqual({ data: CHIUSO, turno: 'tutto il giorno', motivo: 'Ferie strumenti' });
    });

    it('«l\'esterno è chiuso?»: la sala chiusa quel giorno e turno lo dice', async () => {
        await giro(
            stubCalls(
                ['z1', 'get_restaurant_info', { topic: 'zones', date: SALA_CHIUSA, shift: 'DINNER' }],
                ['z2', 'get_restaurant_info', { topic: 'zones' }],
            ),
            stubText('Fuori quella sera è chiuso.'),
        );
        expect(stub.toolResult('z1').sale).toContainEqual({ nome: SALA, zona: 'esterno', stato: 'chiusa' });
        expect(stub.toolResult('z2').sale).toContainEqual({ nome: SALA, zona: 'esterno', stato: 'aperta' });
    });

    it('menu spento, indicazioni e recapiti', async () => {
        await giro(
            stubCalls(
                ['m1', 'get_restaurant_info', { topic: 'menu' }],
                ['m2', 'get_restaurant_info', { topic: 'directions' }],
                ['m3', 'get_restaurant_info', { topic: 'contacts' }],
            ),
            stubText('Ecco.'),
        );
        expect(stub.toolResult('m1').menu_digitale).toBeNull();
        expect(stub.toolResult('m2')).toHaveProperty('indirizzo');
        expect(stub.toolResult('m3')).toHaveProperty('telefono');
    });

    it('gruppo da 21: una richiamata sola al giorno, eseguita subito', async () => {
        for (let i = 0; i < 2; i++) {
            const res = await giro(
                stubCalls(['c1', 'request_callback', { reason: 'gruppo da 21, menù da definire', guests: 21 }]),
                stubText('Ti richiamiamo per organizzare.'),
            );
            // Eseguita, non proposta: non tocca le prenotazioni.
            expect(res.body.proposal).toBeNull();
            expect(stub.toolResult('c1')).toMatchObject({ success: true, executed: true });
        }
        const righe = await db.query(
            `SELECT callback_requested, callback_reason, phone FROM voice_calls
              WHERE tenant_id = 1 AND conversation_id LIKE $1`,
            [`wa-cb-1-${NUMERO}-%`]
        );
        expect(righe.rows).toHaveLength(1);
        expect(righe.rows[0].callback_requested).toBe(true);
        expect(righe.rows[0].callback_reason).toBe('gruppo da 21, menù da definire');
    });
});
