import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
import {
    createMessagingSender,
    parseMessagingTenantIds,
    parseSandboxRecipients,
} from '../../services/messagingSender.js';
import { buildApiError } from '../../services/apiError.js';

// Il mittente WhatsApp/SMS in env è del Vecchio Frantoio (audit isolamento
// tenant, H-08): fino al 25/09/2026 ogni tenant spediva da lì, anche in forma
// anonima dalla pagina /prenota/<slug>.
//
// Due livelli, perché nei test API Twilio NON è configurato:
//
// 1. Il cancello vero — services/messagingSender.ts, modulo puro — si prova
//    qui sotto con credenziali finte. È l'unico modo di vedere che una
//    notifica automatica (la conferma della pagina pubblica anonima, i
//    promemoria…) salta WhatsApp e SMS per un altro tenant: dal server,
//    senza Twilio, «nessun canale» e «canale negato» producono la stessa
//    assenza di righe in outbound_messages, anche col codice di prima.
//    dispatchBookingNotification passa da notificationReadiness proprio per
//    questo.
//
// 2. Dal server si provano i discriminanti che si vedono da fuori: il 409
//    messaging_not_available sugli invii a mano (prima erano 500/502/503/404
//    a seconda della route), il link di pagamento che non crea l'ordine sul
//    gateway, la sandbox che confronta l'E.164 esatto, il tenant 1 che non
//    cambia, i webhook Vonage (M-05) e /debug/whatsapp-test spariti.
//    globalSetup imposta ENV_MESSAGING_SANDBOX_RECIPIENTS='+39 333 000 9990'
//    e ENV_MESSAGING_TENANT_IDS='1;3' (volutamente malformata).

const FAKE_TWILIO = {
    TWILIO_ACCOUNT_SID: 'AC_finto',
    TWILIO_AUTH_TOKEN: 'token_finto',
    TWILIO_WHATSAPP_FROM: 'whatsapp:+390000000000',
    TWILIO_MESSAGING_SERVICE_SID: 'MG_finto',
};

describe('messagingSender: chi spedisce dal mittente del Frantoio', () => {
    const sender = (extra: Record<string, string> = {}, warn: (m: string) => void = () => {}) =>
        createMessagingSender({ ...FAKE_TWILIO, ...extra }, { ownerTenantId: 1, warn });

    it('il tenant 1 è cablato: numero o stringa (BIGINT da pg), con o senza destinatario', () => {
        const s = sender();
        expect(s.configFor(1)).not.toBeNull();
        expect(s.configFor('1')).not.toBeNull();
        expect(s.configFor(1, '+447700900123')).not.toBeNull();
        expect(s.configFor(1)?.twilioAccountSid).toBe('AC_finto');
    });

    it('un altro tenant è spento, verso qualunque numero fuori dalla sandbox', () => {
        const s = sender();
        expect(s.configFor(3)).toBeNull();
        expect(s.configFor('3', '+393335550101')).toBeNull();
        expect(s.twilioSmsReady(3, '+393335550101')).toBe(false);
        expect(s.twilioWhatsAppReady(3, '+393335550101')).toBe(false);
        expect(s.metaWhatsAppReady(3)).toBe(false);
    });

    it('ENV_MESSAGING_TENANT_IDS aggiunge; malformata si ignora con un warning e non spegne il tenant 1', () => {
        const avvisi: string[] = [];
        const rotta = sender({ ENV_MESSAGING_TENANT_IDS: '1;3' }, m => avvisi.push(m));
        expect(avvisi).toHaveLength(1);
        expect(rotta.configFor(1)).not.toBeNull();
        expect(rotta.configFor(3)).toBeNull();

        const buona = sender({ ENV_MESSAGING_TENANT_IDS: ' 3 , 7' });
        expect(buona.configFor('3')).not.toBeNull();
        expect(buona.configFor(7)).not.toBeNull();
        expect(buona.configFor(1)).not.toBeNull();
        expect(buona.configFor(2)).toBeNull();

        const scarti: string[] = [];
        expect([...parseMessagingTenantIds('0,-1,abc,2.5,,4', m => scarti.push(m))]).toEqual([4]);
        expect(scarti).toHaveLength(4);
    });

    it('sandbox: confronto esatto sull\'E.164, mai la chiave larga dei thread', () => {
        const s = sender({ ENV_MESSAGING_SANDBOX_RECIPIENTS: '+39 333 000 9990, 0044 7700 900000' });
        expect(s.configFor(3, '+393330009990')).not.toBeNull();
        expect(s.configFor(3, '+39 333 000 9990')).not.toBeNull();
        expect(s.configFor(3, '+447700900000')).not.toBeNull();
        // phoneMatchKey('+3330009990') === phoneMatchKey('+393330009990'):
        // un numero straniero diverso passava per quello di Marco.
        expect(s.configFor(3, '+3330009990')).toBeNull();
        // La forma locale va risolta prima col prefisso del ristorante
        // (messagingDestination): qui non si indovina.
        expect(s.configFor(3, '3330009990')).toBeNull();
        expect(s.configFor(3, '07700 900000')).toBeNull();
        // Senza destinatario la sandbox non apre niente.
        expect(s.configFor(3)).toBeNull();
    });

    it('le voci della sandbox si normalizzano una volta: senza prefisso valgono come italiane', () => {
        expect([...parseSandboxRecipients('3330009990, 0039 333 000 9991, +44 7700 900000, abc, ,123')])
            .toEqual(['+393330009990', '+393330009991', '+447700900000']);
        expect(parseSandboxRecipients(undefined).size).toBe(0);
    });

    it('notificationReadiness: il cancello delle notifiche automatiche', () => {
        const s = sender({ ENV_MESSAGING_SANDBOX_RECIPIENTS: '+393330009990' });
        // Tenant 1: come sempre, WhatsApp solo col template.
        expect(s.notificationReadiness(1, '+393335550101', { whatsappTemplate: true }))
            .toEqual({ allowed: true, whatsappReady: true, smsReady: true });
        expect(s.notificationReadiness('1', '+393335550101', { whatsappTemplate: false }))
            .toEqual({ allowed: true, whatsappReady: false, smsReady: true });
        // Il vettore H-08: un altro tenant, un numero qualsiasi.
        expect(s.notificationReadiness(3, '+393335550101', { whatsappTemplate: true }))
            .toEqual({ allowed: false, whatsappReady: false, smsReady: false });
        expect(s.notificationReadiness(3, '', { whatsappTemplate: true }))
            .toEqual({ allowed: false, whatsappReady: false, smsReady: false });
        // Demo verso il telefono di prova.
        expect(s.notificationReadiness(3, '+393330009990', { whatsappTemplate: true }))
            .toEqual({ allowed: true, whatsappReady: true, smsReady: true });
    });

    it('tenant 1 senza credenziali: ammesso ma non pronto, così gli errori restano quelli di sempre', () => {
        const s = createMessagingSender({}, { ownerTenantId: 1 });
        expect(s.configFor(1)).not.toBeNull();
        expect(s.notificationReadiness(1, '+393335550101', { whatsappTemplate: true }))
            .toEqual({ allowed: true, whatsappReady: false, smsReady: false });
    });

    it('le credenziali si rileggono a ogni chiamata, gli elenchi solo alla creazione', () => {
        const env: Record<string, string | undefined> = { ENV_MESSAGING_TENANT_IDS: '' };
        const s = createMessagingSender(env, { ownerTenantId: 1 });
        expect(s.twilioSmsReady(1)).toBe(false);
        Object.assign(env, FAKE_TWILIO, { ENV_MESSAGING_TENANT_IDS: '3' });
        expect(s.twilioSmsReady(1)).toBe(true);
        expect(s.configFor(3)).toBeNull();
    });

    it('il WhatsApp del preventivo si offre al tenant 1 e, nelle demo, solo se la sandbox ha numeri', () => {
        expect(sender().twilioWhatsAppOffered(1)).toBe(true);
        expect(sender().twilioWhatsAppOffered(3)).toBe(false);
        expect(sender({ ENV_MESSAGING_SANDBOX_RECIPIENTS: '+393330009990' }).twilioWhatsAppOffered(3)).toBe(true);
        const senzaWhatsApp = createMessagingSender(
            { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', ENV_MESSAGING_SANDBOX_RECIPIENTS: '+393330009990' },
            { ownerTenantId: 1 }
        );
        expect(senzaWhatsApp.twilioWhatsAppOffered(1)).toBe(false);
        expect(senzaWhatsApp.twilioWhatsAppOffered(3)).toBe(false);
    });
});

describe('buildApiError: il 409 si legge in italiano', () => {
    it('con un codice macchina in error, il messaggio è la frase; il codice resta in data', () => {
        const err = buildApiError(409, {
            error: 'messaging_not_available',
            message: 'Messaggi non ancora attivi per questo ristorante',
        });
        expect(err.message).toBe('Messaggi non ancora attivi per questo ristorante');
        expect(err.status).toBe(409);
        expect(err.data.error).toBe('messaging_not_available');
    });

    it('un error già in forma di frase resta il titolo, e detail si accoda come prima', () => {
        expect(buildApiError(400, { error: 'SMS non configurato', message: 'altro' }).message).toBe('SMS non configurato');
        expect(buildApiError(500, { error: 'Twilio SMS not configured' }).message).toBe('Twilio SMS not configured');
        expect(buildApiError(502, { error: 'Rimborso fallito', detail: 'carta scaduta' }).message).toBe('Rimborso fallito: carta scaduta');
        expect(buildApiError(404, { error: 'not_found' }).message).toBe('not_found');
        expect(buildApiError(503, null, 'Audio non disponibile').message).toBe('Audio non disponibile');
    });
});

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const SLUG = 'osteria-mittente-test';
const OWNER2_EMAIL = 'owner.mittente@example.com';
const NUMERO_QUALSIASI = '+39 333 555 0101';
const NUMERO_SANDBOX = '3330009990'; // = '+39 333 000 9990' di globalSetup, scritto in forma locale
const DATA_FUTURA = '2027-05-12';

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';

describe('mittente WhatsApp/SMS solo del Frantoio', () => {
    let db: Client;
    let tenantId = 0;
    let owner2 = '';
    let tenant2WebhookToken = '';
    let reservationId = 0;

    const outboundRows = async (tenant: number) => {
        const r = await db.query(
            `SELECT id, channel, to_phone FROM outbound_messages
              WHERE tenant_id = $1 AND direction = 'outbound' AND channel IN ('sms', 'whatsapp')`,
            [tenant]
        );
        return r.rows;
    };

    beforeAll(async () => {
        db = new Client({ connectionString: dbUrl() });
        await db.connect();

        // Il tenant nasce con gli add-on che servono ai percorsi d'invio:
        // senza whatsapp il 403 dell'entitlement arriverebbe prima del 409,
        // senza pay_at_table e takeaway idem per i link del conto.
        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG,
            name: 'Osteria Mittente',
            owner_email: OWNER2_EMAIL,
            features: { whatsapp: true, web_booking: true, pay_at_table: true, takeaway: true },
        });
        expect(created.status).toBe(201);
        tenantId = Number(created.body.tenant.id);
        tenant2WebhookToken = created.body.webhook_token;

        // Gateway con una chiave finta, scritto prima di qualunque chiamata
        // del tenant: la config Revolut ha una cache di 30 s per tenant.
        // Serve alla richiesta di acconto; nessuna chiamata arriva a Revolut.
        await db.query(
            `INSERT INTO integration_settings (tenant_id, provider, environment, api_key)
             VALUES ($1, 'revolut', 'sandbox', 'sk_test_finta_mittente')`,
            [tenantId]
        );

        const login = await api().post('/auth/login').send({
            email: OWNER2_EMAIL,
            password: created.body.owner_temp_password,
        });
        expect(login.status).toBe(200);
        owner2 = login.body.accessToken;

        const flags = await api().put('/settings/features').set(bearer(owner2)).send({
            public_bookings_enabled: true,
            pay_at_table_enabled: true,
        });
        expect(flags.status).toBe(200);

        const resv = await api().post('/reservations').set(bearer(owner2)).send({
            customer_name: 'Ospite Mittente',
            reservation_time: `${DATA_FUTURA}T20:00:00`,
            shift: 'DINNER',
            guests: 2,
            phone: NUMERO_QUALSIASI,
        });
        expect(resv.status).toBe(201);
        reservationId = Number(resv.body.id);
    });

    afterAll(async () => {
        if (!db) return;
        try {
            if (tenantId) {
                // Prenotazioni, rubrica, log di replica, sessioni…: le righe
                // del tenant stanno in più tabelle di quante valga la pena
                // elencare, e le FK impongono un ordine. Si passa da tutte le
                // tabelle con tenant_id, più giri finché le dipendenze cadono.
                const tables = await db.query(
                    `SELECT DISTINCT table_name FROM information_schema.columns
                      WHERE table_schema = 'public' AND column_name = 'tenant_id'`
                );
                for (let giro = 0; giro < 4; giro++) {
                    for (const { table_name } of tables.rows) {
                        await db.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [tenantId]).catch(() => {});
                    }
                }
                await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
            }
            await db.query(`DELETE FROM outbound_messages WHERE tenant_id = 1 AND body LIKE 'prova mittente%'`);
        } finally {
            await db.end();
        }
    });

    it('un altro tenant: /messages/send → 409 messaging_not_available, nessuna riga', async () => {
        const sms = await api().post('/messages/send').set(bearer(owner2))
            .send({ phone: NUMERO_QUALSIASI, text: 'prova mittente sms', channel: 'sms' });
        expect(sms.status).toBe(409);
        expect(sms.body).toEqual({
            error: 'messaging_not_available',
            message: 'Messaggi non ancora attivi per questo ristorante',
        });

        // Anche su WhatsApp, prima ancora del controllo sulla finestra 24h.
        const wa = await api().post('/messages/send').set(bearer(owner2))
            .send({ phone: NUMERO_QUALSIASI, text: 'prova mittente wa' });
        expect(wa.status).toBe(409);
        expect(wa.body.error).toBe('messaging_not_available');

        expect(await outboundRows(tenantId)).toEqual([]);
    });

    it('un altro tenant: reminder, conferma e link del conto → 409', async () => {
        const reminder = await api().post(`/reservations/${reservationId}/send-reminder`).set(bearer(owner2));
        expect(reminder.status).toBe(409);
        expect(reminder.body.error).toBe('messaging_not_available');

        const conferma = await api().post(`/reservations/${reservationId}/confirm-whatsapp?channel=sms`).set(bearer(owner2));
        expect(conferma.status).toBe(409);
        expect(conferma.body.error).toBe('messaging_not_available');

        // Il 409 arriva prima di cercare il conto: senza mittente non serve
        // nemmeno averlo aperto (prima: 404, nessun conto).
        const conto = await api().post(`/reservations/${reservationId}/bill/notify`).set(bearer(owner2));
        expect(conto.status).toBe(409);
        expect(conto.body.error).toBe('messaging_not_available');

        // E il promemoria non risulta marcato come inviato.
        const r = await db.query('SELECT reminder_sent FROM reservations WHERE id = $1', [reservationId]);
        expect(r.rows[0].reminder_sent).toBe(false);
        expect(await outboundRows(tenantId)).toEqual([]);
    });

    it('un altro tenant: il link del conto dell\'asporto → 409, prima di cercare il conto', async () => {
        const ordine = await db.query(
            `INSERT INTO takeaway_orders (tenant_id, customer_name, customer_phone, pickup_date, pickup_time, shift)
             VALUES ($1, 'Asporto Mittente', $2, $3, '20:00', 'DINNER') RETURNING id`,
            [tenantId, NUMERO_QUALSIASI, DATA_FUTURA]
        );
        const res = await api().post(`/takeaway/orders/${ordine.rows[0].id}/bill/notify`).set(bearer(owner2));
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('messaging_not_available');
    });

    it('un altro tenant: la richiesta di acconto → 409 PRIMA dell\'ordine sul gateway', async () => {
        // Il gateway è «configurato» (chiave finta, in beforeAll): senza, il
        // 503 del gateway arriverebbe prima. Col codice di prima si sarebbe
        // creato l'ordine sul conto Revolut e poi spedito dal mittente del
        // Frantoio.
        for (const channel of ['sms', 'whatsapp', 'auto']) {
            const res = await api().post('/payments/requests').set(bearer(owner2))
                .send({ reservation_id: reservationId, amount: 20, channel });
            expect(res.status, channel).toBe(409);
            expect(res.body.error, channel).toBe('messaging_not_available');
        }
        const richieste = await db.query('SELECT 1 FROM payment_requests WHERE tenant_id = $1', [tenantId]);
        expect(richieste.rowCount).toBe(0);
    });

    it('un altro tenant: il preventivo del banchetto su WhatsApp → 409; verso la sandbox si passa', async () => {
        const banchetto = await api().post('/banquet-menus').set(bearer(owner2)).send({
            name: 'Banchetto Mittente', description: '', price_per_person: 50, guests: 30,
            courses: [], event_date: '2027-06-01', shift: 'DINNER',
        });
        expect(banchetto.status).toBe(201);

        const res = await api().post(`/banquet-menus/${banchetto.body.id}/send-quote-whatsapp`).set(bearer(owner2))
            .send({ phone: NUMERO_QUALSIASI });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('messaging_not_available');

        // Verso il numero di prova il 409 non c'è: si ferma al 503 «in
        // attivazione», perché nei test Twilio e il template mancano.
        const sandbox = await api().post(`/banquet-menus/${banchetto.body.id}/send-quote-whatsapp`).set(bearer(owner2))
            .send({ phone: NUMERO_SANDBOX });
        expect(sandbox.status).toBe(503);
        expect(sandbox.body.error).toBe('whatsapp_non_configurato');
    });

    it('la pagina pubblica di un altro tenant prenota (201) senza spedire nulla', async () => {
        // Il vettore anonimo di H-08: solo un telefono, nessun login. Che
        // WhatsApp e SMS vengano davvero negati lo prova notificationReadiness
        // qui sopra; da fuori, senza Twilio, si vede solo che la prenotazione
        // non si rompe.
        const res = await api().post(`/public/${SLUG}/reservations`).send({
            customer_name: 'Ospite Anonimo',
            phone: '+39 333 555 0202',
            date: DATA_FUTURA,
            time: '20:30',
            shift: 'DINNER',
            guests: 2,
        });
        expect(res.status).toBe(201);
        expect(res.body.ok).toBe(true);
        expect(await outboundRows(tenantId)).toEqual([]);
    });

    it('verso un numero della sandbox demo l\'invio arriva al provider, come per il tenant 1', async () => {
        const sandbox = await api().post('/messages/send').set(bearer(owner2))
            .send({ phone: NUMERO_SANDBOX, text: 'prova mittente sandbox', channel: 'sms' });
        expect(sandbox.status).toBe(500);
        expect(sandbox.body.error).toBe('Twilio SMS not configured');

        // Un numero straniero con le stesse cifre nazionali non è quello di
        // prova: con la chiave larga dei thread (phoneMatchKey) passava.
        const sosia = await api().post('/messages/send').set(bearer(owner2))
            .send({ phone: '+3330009990', text: 'prova mittente sosia', channel: 'sms' });
        expect(sosia.status).toBe(409);
        expect(sosia.body.error).toBe('messaging_not_available');

        // Anche la pagina pubblica col numero di sandbox resta un 201.
        const pubblica = await api().post(`/public/${SLUG}/reservations`).send({
            customer_name: 'Ospite Sandbox',
            phone: NUMERO_SANDBOX,
            date: DATA_FUTURA,
            time: '21:00',
            shift: 'DINNER',
            guests: 2,
        });
        expect(pubblica.status).toBe(201);
    });

    it('il tenant 1 non cambia: arriva al provider anche con ENV_MESSAGING_TENANT_IDS malformata', async () => {
        const token = await ownerToken();
        const sms = await api().post('/messages/send').set(bearer(token))
            .send({ phone: NUMERO_QUALSIASI, text: 'prova mittente tenant 1', channel: 'sms' });
        expect(sms.status).toBe(500);
        expect(sms.body.error).toBe('Twilio SMS not configured');
    });

    it('media Twilio: un altro tenant non usa le credenziali del Frantoio', async () => {
        const media = JSON.stringify([{ url: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM0/Media/ME0', content_type: 'image/jpeg' }]);
        const ins = await db.query(
            `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, from_phone, from_phone_digits, body, status, media)
             VALUES ($1, 'twilio', 'whatsapp', 'inbound', '+393335550303', '393335550303', 'prova mittente media', 'received', $2::jsonb)
             RETURNING id`,
            [tenantId, media]
        );
        const res = await api().get(`/messages/${ins.rows[0].id}/media/0`).set(bearer(owner2));
        expect(res.status).toBe(404);
    });

    it('webhook Vonage: rimossi, 404 e nessun messaggio finto in posta', async () => {
        const frantoio = await api().get('/settings/webhook-info').set(bearer(await ownerToken()));
        expect(frantoio.status).toBe(200);
        expect(frantoio.body.examples.vonage_inbound).toBeUndefined();

        const body = { from: '393335550404', message_type: 'text', text: 'prova mittente vonage' };
        const paths = [
            '/webhook/vonage-inbound',
            '/webhook/vonage-status',
            `/webhook/t/${frantoio.body.webhook_token}/vonage-inbound`,
            `/webhook/t/${frantoio.body.webhook_token}/vonage-status`,
            `/webhook/t/${tenant2WebhookToken}/vonage-inbound`,
        ];
        for (const path of paths) {
            const res = await api().post(path).send(body);
            expect(res.status, path).toBe(404);
        }
        const inbound = await db.query(
            `SELECT 1 FROM outbound_messages WHERE direction = 'inbound' AND body = 'prova mittente vonage'`
        );
        expect(inbound.rowCount).toBe(0);
    });

    it('/debug/whatsapp-test non esiste più', async () => {
        const res = await api().post('/debug/whatsapp-test').set(bearer(await ownerToken()))
            .send({ to: NUMERO_QUALSIASI, text: 'prova mittente debug' });
        expect(res.status).toBe(404);
    });
});
