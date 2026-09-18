import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Fase 4b della tappa 4: l'interruttore «Servizio completo sul nodo» e i
// suoi cancelli, dal lato dei rifiuti — qui nessun nodo è collegato, quindi
// ogni accensione deve morire sul cancello giusto. Il giro felice (nodo
// vivo, allineato, acceso e spento col drenaggio) sta nel test e2e dello
// stream inverso.
describe("interruttore autorità: i cancelli", () => {
    let token: string;
    let hybridPrima = false;

    beforeAll(async () => {
        token = await ownerToken();
        const flags = await api().get('/settings/features').set(bearer(token));
        hybridPrima = flags.body.sala_node_enabled === true;
    });

    afterAll(async () => {
        await api().put('/settings/features').set(bearer(token)).send({ sala_node_enabled: hybridPrima });
    });

    it('il flag NON passa dal PUT generico dei feature flag', async () => {
        const flags = await api().get('/settings/features').set(bearer(token));
        expect(flags.body).not.toHaveProperty('sala_node_authority_enabled');
        // Un body con solo quella chiave è «nessun aggiornamento»: il PUT
        // generico non la conosce di proposito.
        const put = await api().put('/settings/features').set(bearer(token)).send({ sala_node_authority_enabled: true });
        expect(put.status).toBe(400);
        expect(put.body.error).toBe('no_updates');
    });

    it('a ibrido spento: 409 hybrid_off', async () => {
        await api().put('/settings/features').set(bearer(token)).send({ sala_node_enabled: false });
        const res = await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: true });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('hybrid_off');
    });

    it('a ibrido acceso ma nodo scollegato: 409 node_offline', async () => {
        await api().put('/settings/features').set(bearer(token)).send({ sala_node_enabled: true });
        const res = await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: true });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('node_offline');
        const overview = await api().get('/sala-node/authority').set(bearer(token));
        expect(overview.status).toBe(200);
        expect(overview.body.enabled).toBe(false);
        expect(overview.body.node_online).toBe(false);
        expect(overview.body.aligned).toBe(false);
    });

    it('spegnere quando è già spento è un no-op tranquillo', async () => {
        const res = await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: false });
        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(false);
    });
});
