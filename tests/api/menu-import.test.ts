import { describe, it, expect, afterAll } from 'vitest';
import { api, ownerToken, bearer } from './helpers';

// Import del menu dalla cassa Passepartout (POST /menu/import/passepartout).
// L'agente LAN non esiste nell'ambiente di test, quindi qui si collauda il
// GATING, non il sync: entitlement 'passepartout' (403 senza), e col
// gating superato il 503 agent_offline — la risposta che il CRM mostra
// quando il ristorante è offline.

const TUTTO_ATTIVO = { voice: true, whatsapp: true, web_booking: true, pay_at_table: true, passepartout: true };

describe('import menu Passepartout (gating)', () => {
    afterAll(async () => {
        const token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send(TUTTO_ATTIVO);
    });

    it('senza autenticazione → 401', async () => {
        const res = await api().post('/menu/import/passepartout');
        expect(res.status).toBe(401);
    });

    it('feature passepartout spenta → 403 feature_not_enabled', async () => {
        const token = await ownerToken();
        const put = await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: false });
        expect(put.status).toBe(200);

        const res = await api().post('/menu/import/passepartout').set(bearer(token));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('feature_not_enabled');

        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
    });

    it('feature accesa ma agente non collegato → 503 passepartout_agent_offline', async () => {
        const token = await ownerToken();
        const res = await api().post('/menu/import/passepartout').set(bearer(token));
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('passepartout_agent_offline');
    });

    it('la migration porta external_ref e is_active sui piatti', async () => {
        const token = await ownerToken();
        const res = await api().get('/dishes').set(bearer(token));
        expect(res.status).toBe(200);
        // Colonne nuove presenti su ogni riga (default: piatto CRM attivo).
        for (const dish of res.body) {
            expect(dish).toHaveProperty('external_ref');
            expect(dish.is_active).toBe(true);
        }
    });
});
