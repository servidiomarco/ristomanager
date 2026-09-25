import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Due difese sulle comunicazioni verso l'ospite (audit isolamento tenant).
//
// 1. H-03: la casella email in env (SMTP_*, RESEND_*) è del Frantoio e vale
//    solo per il tenant 1. Prima ogni tenant la ereditava campo per campo:
//    un owner di un altro ristorante puntava l'host a un suo server, lasciava
//    vuota la password, premeva «Test» e riceveva in AUTH quella del
//    Frantoio; la GET gliene mostrava le ultime 4 cifre. Le env finte sono in
//    globalSetup.ts (senza mittente: il tenant 1 resta «non configurato»).
//
// 2. Il nome dell'ospite arriva libero dal form pubblico (80 caratteri, link
//    compresi) e finiva tale e quale nei testi firmati dal ristorante: un
//    «Mario https://… 333…» diventava phishing col mittente del Frantoio.
//    Nei messaggi ora passa da guestNameForMessage; in DB resta com'è.

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const SLUG = 'osteria-email-isolata';
const OWNER2_EMAIL = 'owner.email-isolata@example.com';

// I valori di globalSetup.ts: qui servono solo le ultime 4 cifre.
const ENV_PASSWORD_LAST4 = '8421';
const ENV_RESEND_KEY_LAST4 = '5190';
const ENV_INBOUND_SECRET_LAST4 = '7733';

// Data futura tutta sua (mercoledì, cena aperta nel seed): il booking pubblico
// può auto-assegnare un tavolo e non deve pestare le date degli altri file.
const DATA_WEB = '2027-04-21';

const dbQuery = async (sql: string, params: any[] = []) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    try {
        return await client.query(sql, params);
    } finally {
        await client.end();
    }
};

// L'invio parte dopo la risposta 201 (fire-and-forget): si aspetta la riga
// che logOutboundEmail scrive, anche quando l'SMTP (porta chiusa) rifiuta.
const waitForEmailLog = async (reservationId: number): Promise<{ subject: string; body: string }> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const r = await dbQuery(
            `SELECT subject, body FROM outbound_messages
              WHERE tenant_id = 1 AND reservation_id = $1 AND channel = 'email'
              ORDER BY id DESC LIMIT 1`,
            [reservationId]
        );
        if (r.rows[0]) return r.rows[0];
        if (Date.now() > deadline) throw new Error(`nessuna email registrata per la prenotazione ${reservationId}`);
        await new Promise(resolve => setTimeout(resolve, 200));
    }
};

describe('email: le env del Frantoio restano al tenant 1', () => {
    let owner2 = '';
    let owner2WebhookToken = '';

    beforeAll(async () => {
        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG,
            name: 'Osteria Email Isolata',
            owner_email: OWNER2_EMAIL,
        });
        expect(created.status).toBe(201);
        owner2WebhookToken = created.body.webhook_token;
        const login = await api().post('/auth/login').send({
            email: OWNER2_EMAIL,
            password: created.body.owner_temp_password,
        });
        expect(login.status).toBe(200);
        owner2 = login.body.accessToken;
    });

    afterAll(async () => {
        const t = await dbQuery('SELECT id FROM tenants WHERE slug = $1', [SLUG]);
        const id = t.rows[0]?.id;
        if (id != null) {
            for (const table of ['activity_logs', 'integration_settings', 'users', 'tenant_features', 'opening_hours', 'role_permissions', 'app_settings']) {
                await dbQuery(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]);
            }
            await dbQuery('DELETE FROM tenants WHERE id = $1', [id]);
        }
    });

    it('un tenant nuovo senza riga non è configurato e non vede i segreti in env', async () => {
        const res = await api().get('/settings/integrations/smtp').set(bearer(owner2));
        expect(res.status).toBe(200);
        expect(res.body.configured).toBe(false);
        expect(res.body.host).toBe('');
        expect(res.body.user).toBe('');
        expect(res.body.has_password).toBe(false);
        expect(res.body.password_last4).toBeNull();
        expect(res.body.has_resend_api_key).toBe(false);
        expect(res.body.resend_api_key_last4).toBeNull();
        expect(res.body.has_resend_inbound_secret).toBe(false);
        expect(res.body.resend_inbound_secret_last4).toBeNull();
    });

    it('il tenant 1 continua a ereditare le env, identico a prima', async () => {
        const token = await ownerToken();
        const res = await api().get('/settings/integrations/smtp').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.host).toBe('127.0.0.1');
        expect(res.body.port).toBe(1);
        expect(res.body.user).toBe('frantoio-env@test.local');
        expect(res.body.password_last4).toBe(ENV_PASSWORD_LAST4);
        expect(res.body.resend_api_key_last4).toBe(ENV_RESEND_KEY_LAST4);
        expect(res.body.resend_inbound_secret_last4).toBe(ENV_INBOUND_SECRET_LAST4);
        // Senza mittente in env resta «non configurato», come per tutta la suite.
        expect(res.body.configured).toBe(false);
    });

    it('host proprio senza password: niente password del Frantoio, il test non parte', async () => {
        // Il percorso dell'attacco: riga parziale, password lasciata vuota.
        const put = await api().put('/settings/integrations/smtp').set(bearer(owner2)).send({
            host: '127.0.0.1',
            port: 1,
            user: 'owner2@example.com',
            from_email: 'prenotazioni@osteria-isolata.test',
        });
        expect(put.status).toBe(200);
        expect(put.body.host).toBe('127.0.0.1');
        expect(put.body.has_password).toBe(false);
        expect(put.body.password_last4).toBeNull();
        expect(put.body.configured).toBe(false);

        // Prima del fix la config risultava completa (password dall'env) e il
        // test apriva la connessione autenticandosi col segreto del Frantoio:
        // l'errore sarebbe stato quello di rete, non «non configurato».
        const test = await api().post('/settings/integrations/smtp/test').set(bearer(owner2))
            .send({ to: 'destinatario@example.com' });
        expect(test.status).toBe(400);
        expect(test.body.error).toBe('Email non è configurato');
    });

    it('il webhook Resend col token di un altro tenant non usa il segreto del Frantoio', async () => {
        expect(owner2WebhookToken).toMatch(/^[0-9a-f]{48}$/);
        const altro = await api().post(`/webhook/t/${owner2WebhookToken}/resend-inbound`).send({});
        expect(altro.status).toBe(503);
        expect(altro.body.error).toBe('inbound_not_configured');

        // Il path storico del tenant 1 ha chiave e segreto (env): arriva alla
        // verifica della firma e la rifiuta, non risponde «non configurato».
        const frantoio = await api().post('/webhook/resend-inbound').send({});
        expect(frantoio.status).toBe(401);
        expect(frantoio.body.error).toBe('invalid_signature');
    });
});

describe('nome dell\'ospite nei messaggi in uscita', () => {
    let token = '';
    const createdIds: number[] = [];

    beforeAll(async () => {
        token = await ownerToken();
        const acceso = await api().put('/settings/features').set(bearer(token)).send({ public_bookings_enabled: true });
        expect(acceso.status).toBe(200);
        // Col mittente in riga il tenant 1 diventa «configurato» (host, porta,
        // utente e password dall'env): l'email parte e fallisce subito sulla
        // porta chiusa, ma logOutboundEmail registra oggetto e testo.
        const put = await api().put('/settings/integrations/smtp').set(bearer(token))
            .send({ from_email: 'prenotazioni@frantoio.test' });
        expect(put.status).toBe(200);
        expect(put.body.configured).toBe(true);
    });

    afterAll(async () => {
        // Prima il PUT (invalida la cache del server), poi la riga via SQL:
        // i file dopo questo devono ritrovare il tenant 1 senza mittente.
        await api().put('/settings/integrations/smtp').set(bearer(token)).send({ from_email: '' });
        await dbQuery(`DELETE FROM integration_settings WHERE tenant_id = 1 AND provider = 'smtp'`);
        await api().put('/settings/features').set(bearer(token)).send({ public_bookings_enabled: false });
        if (createdIds.length) {
            await dbQuery(`DELETE FROM outbound_messages WHERE tenant_id = 1 AND reservation_id = ANY($1::int[])`, [createdIds]);
            await dbQuery(`DELETE FROM reservations WHERE tenant_id = 1 AND id = ANY($1::int[])`, [createdIds]);
        }
    });

    it('link e numeri nel nome non arrivano nell\'email; in DB il nome resta com\'è', async () => {
        const created = await api().post('/public/reservations').send({
            customer_name: 'Mario https://evil.example 3331234567',
            email: 'mario.nomi@example.com',
            date: DATA_WEB,
            time: '20:00',
            shift: 'DINNER',
            guests: 2,
        });
        expect(created.status).toBe(201);
        const id = Number(created.body.id);
        createdIds.push(id);

        const mail = await waitForEmailLog(id);
        expect(mail.body).toMatch(/^Ciao Mario,/);
        const everything = `${mail.subject}\n${mail.body}`.toLowerCase();
        expect(everything).not.toContain('evil');
        expect(everything).not.toContain('https://evil');
        expect(everything).not.toContain('3331234567');

        // Il CRM continua a mostrare quello che l'ospite ha scritto.
        const stored = await dbQuery('SELECT customer_name FROM reservations WHERE id = $1', [id]);
        expect(String(stored.rows[0].customer_name).toLowerCase()).toContain('https://evil.example');
    });

    it('un nome fatto solo di cifre lascia il saluto senza nome', async () => {
        const created = await api().post('/public/reservations').send({
            customer_name: '333 1234567',
            email: 'solo.cifre@example.com',
            date: DATA_WEB,
            time: '21:00',
            shift: 'DINNER',
            guests: 2,
        });
        expect(created.status).toBe(201);
        const id = Number(created.body.id);
        createdIds.push(id);

        // Ricevuta («Ciao,») o conferma se il tavolo si è assegnato da solo
        // («La prenotazione per…»): in entrambi i casi il saluto senza nome.
        const mail = await waitForEmailLog(id);
        expect(mail.body).toMatch(/^(Ciao,|La prenotazione per)/);
        expect(mail.body).not.toContain('1234567');
    });

    it('le note dello staff escono intere, l\'iniziale attaccata resta un nome', async () => {
        // Nomi veri scritti male, non attacchi. La prima versione della pulizia
        // dalla nota e da «x2» toglieva solo cifre e simboli e ne lasciava le
        // parole, e scambiava l'iniziale attaccata per un dominio, facendola
        // sparire col cognome: questo nome usciva «Ciao Persone X,».
        const created = await api().post('/public/reservations').send({
            customer_name: 'A.Rossi (2 persone) x2',
            email: 'note.staff@example.com',
            date: DATA_WEB,
            time: '20:00',
            shift: 'DINNER',
            guests: 2,
        });
        expect(created.status).toBe(201);
        const id = Number(created.body.id);
        createdIds.push(id);

        // Ricevuta, conferma o caparra: tutte aprono con «Ciao <nome>,».
        const mail = await waitForEmailLog(id);
        expect(mail.body).toMatch(/^Ciao A\. Rossi,/);
        expect(mail.body.toLowerCase()).not.toContain('persone,');
    });
});
