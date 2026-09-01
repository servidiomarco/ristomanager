import { describe, it, expect, afterAll } from 'vitest';
import { api, ownerToken, bearer } from './helpers';

// Entitlements commerciali (Fase C1): tenant_features è il livello sopra i
// flag operativi di app_settings. Il tenant 1 nasce con tutti e tre gli
// add-on attivi (seed della migration tenant-features: grandfathered).
//
// Data futura fissa come in availability.test.ts: per la data odierna
// l'endpoint scarta gli slot già passati e il test dipenderebbe dall'orologio.
const DATA_FUTURA = '2027-03-10';

const TUTTO_ATTIVO = { voice: true, whatsapp: true, web_booking: true, pay_at_table: true, passepartout: true, sala_node: true };

describe('entitlements (tenant_features)', () => {
    // Qualunque cosa succeda nei test, il tenant 1 torna com'era: i file di
    // test girano in sequenza sullo stesso server e gli altri contano sui
    // canali attivi.
    afterAll(async () => {
        const token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send(TUTTO_ATTIVO);
    });

    it('/auth/me espone le feature del tenant, tutte attive per il tenant 1', async () => {
        const token = await ownerToken();
        const res = await api().get('/auth/me').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.tenant?.features).toEqual(TUTTO_ATTIVO);
    });

    it('GET /settings/entitlements richiede autenticazione', async () => {
        const res = await api().get('/settings/entitlements');
        expect(res.status).toBe(401);
    });

    it('GET /settings/entitlements ritorna i tre boolean', async () => {
        const token = await ownerToken();
        const res = await api().get('/settings/entitlements').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body).toEqual(TUTTO_ATTIVO);
    });

    it('PUT rifiuta valori non boolean e body vuoto', async () => {
        const token = await ownerToken();
        const nonBool = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: 'sì' });
        expect(nonBool.status).toBe(400);
        const vuoto = await api().put('/settings/entitlements').set(bearer(token)).send({});
        expect(vuoto.status).toBe(400);
    });

    it('web_booking spento → endpoint pubblici 503, il resto del CRM funziona', async () => {
        const token = await ownerToken();

        const put = await api().put('/settings/entitlements').set(bearer(token)).send({ web_booking: false });
        expect(put.status).toBe(200);
        expect(put.body).toEqual({ ...TUTTO_ATTIVO, web_booking: false });

        // Stessa forma 503/bookings_disabled del flag operativo: la pagina
        // /prenota la gestisce già senza distinguere i due livelli.
        const avail = await api().get('/public/availability').query({ date: DATA_FUTURA });
        expect(avail.status).toBe(503);
        expect(avail.body.error).toBe('bookings_disabled');

        const resv = await api().post('/public/reservations').send({
            customer_name: 'Test Entitlements',
            phone: '+39 333 1234567',
            date: DATA_FUTURA,
            time: '20:00',
            shift: 'DINNER',
            guests: 2,
        });
        expect(resv.status).toBe(503);
        expect(resv.body.error).toBe('bookings_disabled');

        // /public/contact non chiude: la pagina deve poter mostrare branding
        // e telefono, con il form spento (bookingsEnabled: false).
        const contact = await api().get('/public/contact');
        expect(contact.status).toBe(200);
        expect(contact.body.bookingsEnabled).toBe(false);

        // Endpoint di controllo: un add-on spento non tocca il resto del CRM.
        const ctrl = await api().get('/settings/features').set(bearer(token));
        expect(ctrl.status).toBe(200);

        // Riattivazione: l'availability torna a rispondere subito (il PUT
        // invalida la cache, niente attesa del TTL).
        const put2 = await api().put('/settings/entitlements').set(bearer(token)).send({ web_booking: true });
        expect(put2.status).toBe(200);
        expect(put2.body).toEqual(TUTTO_ATTIVO);

        const availOk = await api().get('/public/availability').query({ date: DATA_FUTURA });
        expect(availOk.status).toBe(200);
        expect(availOk.body.date).toBe(DATA_FUTURA);
    });

    it('pay_at_table spento → il flag operativo si maschera e le route del conto rispondono 403', async () => {
        const token = await ownerToken();

        // Il ristoratore accende il flag operativo…
        const flagOn = await api().put('/settings/features').set(bearer(token)).send({ pay_at_table_enabled: true });
        expect(flagOn.status).toBe(200);

        // …ma senza l'add-on venduto la lettura lo maschera a false, e le
        // route del modulo chiudono comunque.
        const put = await api().put('/settings/entitlements').set(bearer(token)).send({ pay_at_table: false });
        expect(put.status).toBe(200);

        const masked = await api().get('/settings/features').set(bearer(token));
        expect(masked.status).toBe(200);
        expect(masked.body.pay_at_table_enabled).toBe(false);

        const bill = await api().post('/reservations/999999/bill').set(bearer(token)).send({});
        expect(bill.status).toBe(403);
        expect(bill.body.error).toBe('feature_disabled');

        // Rivenduto: il flag operativo riemerge com'era, senza ritoccarlo.
        const put2 = await api().put('/settings/entitlements').set(bearer(token)).send({ pay_at_table: true });
        expect(put2.status).toBe(200);

        const visible = await api().get('/settings/features').set(bearer(token));
        expect(visible.body.pay_at_table_enabled).toBe(true);

        // Si rispegne il flag operativo per non cambiare stato ai file dopo.
        const flagOff = await api().put('/settings/features').set(bearer(token)).send({ pay_at_table_enabled: false });
        expect(flagOff.status).toBe(200);
    });

    it('voice spento → 403 feature_not_enabled sulle route /voice-calls', async () => {
        const token = await ownerToken();

        const put = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: false });
        expect(put.status).toBe(200);

        const calls = await api().get('/voice-calls').set(bearer(token));
        expect(calls.status).toBe(403);
        expect(calls.body).toEqual({ error: 'feature_not_enabled', feature: 'voice' });

        const put2 = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(put2.status).toBe(200);

        const callsOk = await api().get('/voice-calls').set(bearer(token));
        expect(callsOk.status).toBe(200);
    });

    it('whatsapp spento → 403 feature_not_enabled sugli invii', async () => {
        const token = await ownerToken();

        const put = await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: false });
        expect(put.status).toBe(200);

        // Il middleware chiude prima della validazione del body: il 403
        // arriva anche con una richiesta minima.
        const send = await api().post('/messages/send').set(bearer(token)).send({ phone: '+39 333 1234567', text: 'ciao' });
        expect(send.status).toBe(403);
        expect(send.body).toEqual({ error: 'feature_not_enabled', feature: 'whatsapp' });

        const put2 = await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true });
        expect(put2.status).toBe(200);
    });
});
