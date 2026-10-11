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
const NUMERO_SALA = '3391188102'; // la prenotazione di oggi: ritardo, presenza, note, allergie
const SALA = 'Terrazza Strumenti';
const PIATTO = 'Stinco Strumenti';

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

    const giroPer = async (numero: string, ...risposte: Parameters<AiStub['load']>) => {
        stub.load(...risposte);
        const res = await api().post('/messages/agent/run').set(bearer(token)).send({ phone_digits: numero });
        expect(res.status).toBe(200);
        return res;
    };
    const giro = (...risposte: Parameters<AiStub['load']>) => giroPer(NUMERO, ...risposte);
    let oggiId = 0;
    const conferma = async (proposalId: number) => {
        const r = await api().post(`/messages/agent/proposals/${proposalId}/confirm`).set(bearer(token));
        expect(r.status).toBe(200);
        return r.body;
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
             VALUES (1, 'twilio', 'whatsapp', 'inbound', $1, $2, 'Siete aperti? Siamo in 21, il menù è da definire', 'received'),
                    (1, 'twilio', 'whatsapp', 'inbound', $3, $4, 'Arriviamo con 15 minuti di ritardo', 'received')`,
            [`+39${NUMERO}`, `39${NUMERO}`, `+39${NUMERO_SALA}`, `39${NUMERO_SALA}`]
        );
        // La prenotazione di oggi, adesso: sempre «oggi» nel fuso del locale,
        // a qualunque ora giri la CI.
        const oggi = await db.query(
            `INSERT INTO reservations (tenant_id, customer_name, phone, reservation_time, shift, guests, payment_status, arrival_status, reservation_status, notes)
             VALUES (1, 'Sala Strumenti', $1, NOW(), 'DINNER', 2, 'PENDING', 'WAITING', 'CONFIRMED', 'Tavolo vicino alla finestra') RETURNING id`,
            [NUMERO_SALA]
        );
        oggiId = oggi.rows[0].id;
        const preset = await db.query(
            `INSERT INTO reservation_note_presets (tenant_id, label, sort_order, has_quantity) VALUES (1, $1, 99, TRUE) RETURNING id`, [PIATTO]
        );
        await db.query(
            `INSERT INTO reservation_note_preset_variants (tenant_id, preset_id, label, sort_order) VALUES (1, $1, 'maiale', 0), (1, $1, 'vitello', 1)`,
            [preset.rows[0].id]
        );
    });

    afterAll(async () => {
        await stub.close();
        await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: false });
        await db.query(`DELETE FROM outbound_messages WHERE tenant_id = 1 AND from_phone_digits = ANY($1)`, [[`39${NUMERO}`, `39${NUMERO_SALA}`]]);
        await db.query(`DELETE FROM agent_proposals WHERE tenant_id = 1 AND phone_digits = ANY($1)`, [[NUMERO, NUMERO_SALA]]);
        await db.query(`DELETE FROM reservations WHERE tenant_id = 1 AND phone = $1`, [NUMERO_SALA]);
        await db.query(`DELETE FROM reservation_note_presets WHERE tenant_id = 1 AND label = $1`, [PIATTO]);
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

    it('«arriviamo con 15 minuti di ritardo»: la sala lo vede subito, fino all\'arrivo', async () => {
        await giroPer(NUMERO_SALA,
            stubCalls(['l1', 'report_late_arrival', { minutes: 15 }]),
            stubText('Grazie, avviso la sala.'),
        );
        const esito = stub.toolResult('l1');
        expect(esito).toMatchObject({ success: true, executed: true, reservation_id: oggiId });
        const r = await db.query(`SELECT guest_eta_at, guest_eta_noted_at FROM reservations WHERE id = $1`, [oggiId]);
        const anticipo = (new Date(r.rows[0].guest_eta_at).getTime() - Date.now()) / 60_000;
        expect(anticipo).toBeGreaterThan(13);
        expect(anticipo).toBeLessThan(17);
        expect(r.rows[0].guest_eta_noted_at).not.toBeNull();
    });

    it('«ci saremo»: la conferma dell\'ospite si segna subito', async () => {
        await giroPer(NUMERO_SALA, stubCalls(['a1', 'confirm_attendance', {}]), stubText('Perfetto, a dopo!'));
        expect(stub.toolResult('a1')).toMatchObject({ success: true, executed: true });
        const r = await db.query(`SELECT guest_confirmed_at FROM reservations WHERE id = $1`, [oggiId]);
        expect(r.rows[0].guest_confirmed_at).not.toBeNull();
    });

    it('lo stinco da preparare: proposta, poi in coda alle note e nel conteggio della cucina, una volta sola', async () => {
        for (let i = 0; i < 2; i++) {
            const res = await giroPer(NUMERO_SALA,
                stubCalls([`n${i}`, 'add_reservation_note', { text: '2 stinchi di maiale', preset_label: PIATTO, quantity: 2, variant: 'maiale' }]),
                stubText('Lo segnalo, ti confermo a breve.'),
            );
            expect(res.body.proposal.tool).toBe('add_reservation_note');
            const fatto = await conferma(res.body.proposal.id);
            expect(fatto.ok).toBe(true);
            expect(fatto.result.piatto_in_cucina).toBe(i === 0);
        }
        const r = await db.query(`SELECT notes, note_selections FROM reservations WHERE id = $1`, [oggiId]);
        expect(r.rows[0].notes).toBe('Tavolo vicino alla finestra | [WhatsApp] 2 stinchi di maiale');
        expect(r.rows[0].note_selections).toHaveLength(1);
        expect(r.rows[0].note_selections[0]).toMatchObject({ label: PIATTO, quantity: 2, variant: 'maiale' });
    });

    it('allergia: senza consenso non si scrive; col sì diventa la pillola del modulo, col consenso registrato', async () => {
        const senza = await giroPer(NUMERO_SALA,
            stubCalls(['g1', 'record_allergy', { allergies: ['Glutine'], customer_consented: false }]),
            stubText('Posso annotarlo sulla prenotazione per la cucina?'),
        );
        expect(senza.body.proposal).toBeNull();
        expect(stub.toolResult('g1').status).toBe('refused');

        const con = await giroPer(NUMERO_SALA,
            stubCalls(['g2', 'record_allergy', { allergies: ['glutine'], details: 'celiaco', customer_consented: true }]),
            stubText('Lo segnalo alla cucina.'),
        );
        expect(con.body.proposal.tool).toBe('record_allergy');
        const fatto = await conferma(con.body.proposal.id);
        expect(fatto.ok).toBe(true);
        const r = await db.query(`SELECT notes, consent_data_health, consent_updated_at FROM reservations WHERE id = $1`, [oggiId]);
        expect(r.rows[0].notes).toBe('Allergie: Glutine | Tavolo vicino alla finestra | [WhatsApp] 2 stinchi di maiale | [WhatsApp] celiaco');
        expect(r.rows[0].consent_data_health).toBe(true);
        expect(r.rows[0].consent_updated_at).not.toBeNull();
    });

    it('a cliente arrivato l\'avviso di ritardo non serve più', async () => {
        await db.query(`UPDATE reservations SET arrival_status = 'ARRIVED' WHERE id = $1`, [oggiId]);
        const prima = await db.query(`SELECT guest_eta_at FROM reservations WHERE id = $1`, [oggiId]);
        await giroPer(NUMERO_SALA, stubCalls(['l2', 'report_late_arrival', { minutes: 5 }]), stubText('Ok.'));
        // Un cliente seduto non è più «in agenda»: nessuna prenotazione da avvisare.
        expect(stub.toolResult('l2').status).toBe('not_found');
        const dopo = await db.query(`SELECT guest_eta_at FROM reservations WHERE id = $1`, [oggiId]);
        expect(dopo.rows[0].guest_eta_at).toEqual(prima.rows[0].guest_eta_at);
    });
});
