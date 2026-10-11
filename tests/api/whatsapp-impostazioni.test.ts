import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// WhatsApp, Fase 2: la sezione Impostazioni › WhatsApp. Numero e stato,
// template col loro stato, consumi del mese. Nei test il mittente non c'è
// (manca TWILIO_WHATSAPP_FROM): il locale risulta non collegato, ed è proprio
// quello che la scheda deve saper dire.

const NUMERO = '393478812301';

describe('Impostazioni › WhatsApp', () => {
    let token: string;
    let db: Client;

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true });
    });

    afterAll(async () => {
        await db.query(`DELETE FROM outbound_messages WHERE tenant_id = 1 AND to_phone_digits = $1`, [NUMERO]);
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true });
        await db.end();
    });

    it('lo stato dice che il numero non è collegato e dà gli indirizzi dei webhook', async () => {
        const res = await api().get('/whatsapp/status').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.connected).toBe(false);
        expect(res.body.phone).toBeNull();
        expect(res.body.shared_env_sender).toBe(true);
        expect(res.body.sms_ready).toBe(false);
        expect(res.body.webhooks?.inbound).toMatch(/\/webhook\/t\/[A-Za-z0-9_-]+\/twilio-whatsapp$/);
        expect(res.body.webhooks?.status).toMatch(/\/twilio-whatsapp-status$/);
    });

    it('il catalogo dei template dice cosa manca', async () => {
        const res = await api().get('/whatsapp/templates').set(bearer(token));
        expect(res.status).toBe(200);
        const keys = res.body.templates.map((t: any) => t.key);
        expect(keys).toContain('BOOKING_CONFIRMED');
        expect(keys).toContain('BANQUET_QUOTE');
        const confermata = res.body.templates.find((t: any) => t.key === 'BOOKING_CONFIRMED');
        expect(confermata.languages.map((l: any) => l.language)).toEqual(['it', 'en']);
        expect(confermata.languages.every((l: any) => l.configured === false && l.approval === null)).toBe(true);
    });

    it('i consumi contano i messaggi del mese, a mano e automatici', async () => {
        const prima = (await api().get('/whatsapp/usage').set(bearer(token))).body;
        await db.query(
            `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, to_phone, to_phone_digits, body, status, kind)
             VALUES (1, 'twilio', 'whatsapp', 'outbound', $1, $1, 'conferma', 'failed', 'confirmation'),
                    (1, 'twilio', 'whatsapp', 'outbound', $1, $1, 'ciao', 'delivered', NULL)`,
            [NUMERO]
        );
        const res = await api().get('/whatsapp/usage').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.month).toMatch(/^\d{4}-\d{2}-01$/);
        expect(res.body.whatsapp.outboundAutomatic).toBe(prima.whatsapp.outboundAutomatic + 1);
        expect(res.body.whatsapp.outboundStaff).toBe(prima.whatsapp.outboundStaff + 1);
        expect(res.body.whatsapp.failed).toBe(prima.whatsapp.failed + 1);
        expect(res.body.whatsapp.byKind.confirmation).toBe((prima.whatsapp.byKind.confirmation ?? 0) + 1);
        expect(typeof res.body.ai.costEur).toBe('number');
    });

    it('senza l\'add-on WhatsApp le rotte rispondono 403', async () => {
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: false });
        const res = await api().get('/whatsapp/status').set(bearer(token));
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'feature_not_enabled', feature: 'whatsapp' });
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true });
    });
});
