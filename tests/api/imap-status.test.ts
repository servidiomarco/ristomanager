import { describe, it, expect } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// IMAP non si integra-testa senza un mail server: qui verifichiamo solo il
// contratto HTTP di configurazione (stato del tenant seed e validazione del
// PUT). I PUT usati sono tutti invalidi di proposito: un PUT valido
// scriverebbe la riga smtp e farebbe ripartire il listener del tenant.
describe('impostazioni IMAP', () => {
    it('richiede autenticazione', async () => {
        const res = await api().get('/settings/integrations/imap');
        expect(res.status).toBe(401);
    });

    it('il tenant seed parte non configurato e disconnesso', async () => {
        const token = await ownerToken();
        const res = await api().get('/settings/integrations/imap').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(false);
        expect(res.body.configured).toBe(false);
        expect(res.body.connected).toBe(false);
        expect(res.body.has_password).toBe(false);
        expect(res.body.password_last4).toBeNull();
        expect(res.body.last_seen_uid).toBeNull();
    });

    it('il PUT rifiuta i tipi invalidi senza scrivere nulla', async () => {
        const token = await ownerToken();

        const badPort = await api().put('/settings/integrations/imap').set(bearer(token)).send({ port: 'abc' });
        expect(badPort.status).toBe(400);
        expect(badPort.body.error).toBe('invalid_port');

        const badSecure = await api().put('/settings/integrations/imap').set(bearer(token)).send({ secure: 'yes' });
        expect(badSecure.status).toBe(400);
        expect(badSecure.body.error).toBe('invalid_secure');

        const badEnabled = await api().put('/settings/integrations/imap').set(bearer(token)).send({ enabled: 'yes' });
        expect(badEnabled.status).toBe(400);
        expect(badEnabled.body.error).toBe('invalid_enabled');

        const empty = await api().put('/settings/integrations/imap').set(bearer(token)).send({});
        expect(empty.status).toBe(400);
        expect(empty.body.error).toBe('no_updates');

        // I rifiuti non devono aver toccato lo stato.
        const after = await api().get('/settings/integrations/imap').set(bearer(token));
        expect(after.status).toBe(200);
        expect(after.body.enabled).toBe(false);
        expect(after.body.configured).toBe(false);
    });
});
