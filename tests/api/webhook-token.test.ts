import { describe, it, expect } from 'vitest';
import { api, ownerToken, bearer } from './helpers';

// Webhook instradabili per tenant (Fase C2): ogni famiglia di webhook ha un
// gemello /webhook/t/:tenantToken/<nome> che risolve il tenant dal token in
// tenants.webhook_token (backfillato per il tenant 1 dalla migration
// webhook-token-per-tenant). I path storici restano alias del tenant 1.
//
// ELEVENLABS_WEBHOOK_SECRET non è impostato nell'ambiente di test, quindi
// authorizeElevenLabs lascia passare: init-conversation è il webhook che si
// può esercitare per intero senza credenziali esterne (risponde sempre 200
// col saluto, anche per chiamante anonimo — failure mode di produzione).
describe('webhook token per tenant (C2)', () => {
    const info = async () => {
        const token = await ownerToken();
        const res = await api().get('/settings/webhook-info').set(bearer(token));
        expect(res.status).toBe(200);
        return res.body;
    };

    it('GET /settings/webhook-info richiede autenticazione', async () => {
        const res = await api().get('/settings/webhook-info');
        expect(res.status).toBe(401);
    });

    it('espone i token del tenant 1 (backfill migration) e gli URL di esempio', async () => {
        const body = await info();
        // 24 byte in hex = 48 caratteri: la forma del backfill pgcrypto.
        expect(body.webhook_token).toMatch(/^[0-9a-f]{48}$/);
        expect(body.print_agent_token).toMatch(/^[0-9a-f]{48}$/);
        expect(body.webhook_base_url).toContain(`/webhook/t/${body.webhook_token}`);
        expect(body.examples.elevenlabs_init_conversation).toBe(
            `${body.webhook_base_url}/elevenlabs/init-conversation`
        );
    });

    it('il gemello col token risponde come il path storico', async () => {
        const { webhook_token } = await info();

        const tokenized = await api()
            .post(`/webhook/t/${webhook_token}/elevenlabs/init-conversation`)
            .send({});
        expect(tokenized.status).toBe(200);
        expect(tokenized.body.type).toBe('conversation_initiation_client_data');
        expect(tokenized.body.conversation_config_override?.agent?.first_message).toBeTruthy();

        // Alias tenant 1: il path storico continua a funzionare identico.
        const legacy = await api()
            .post('/webhook/elevenlabs/init-conversation')
            .send({});
        expect(legacy.status).toBe(200);
        expect(legacy.body.type).toBe('conversation_initiation_client_data');
    });

    it('token ignoto → 404, mai fallback silenzioso sul tenant 1', async () => {
        const res = await api()
            .post(`/webhook/t/${'0'.repeat(48)}/elevenlabs/init-conversation`)
            .send({});
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('unknown_webhook_token');
    });

    it('print agent: il token per tenant autentica, un token inventato no', async () => {
        const { print_agent_token } = await info();

        const ok = await api()
            .get('/print-agent/config')
            .set('x-print-agent-token', print_agent_token);
        expect(ok.status).toBe(200);
        expect(Array.isArray(ok.body.printers)).toBe(true);

        const ko = await api()
            .get('/print-agent/config')
            .set('x-print-agent-token', '1'.repeat(48));
        expect(ko.status).toBe(401);

        const senzaToken = await api().get('/print-agent/jobs');
        expect(senzaToken.status).toBe(401);
    });
});
