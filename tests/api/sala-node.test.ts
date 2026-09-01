import { describe, it, expect, afterAll } from 'vitest';
import { api, ownerToken, bearer } from './helpers';

// Nodo di sala, fondazioni cloud (tappa 3 del piano ibrido): token per-tenant
// su tenants.sala_node_token (backfillato per il tenant 1 dalla migration
// nodo-di-sala), endpoint di provisioning /sala-node/credentials, config per
// la SPA /sala-node/client-config e interruttore sala_node_enabled mascherato
// dall'entitlement 'sala_node' come pay_at_table.

const salaNodeToken = async (owner: string): Promise<string> => {
    const res = await api().get('/settings/webhook-info').set(bearer(owner));
    expect(res.status).toBe(200);
    return res.body.sala_node_token;
};

describe('nodo di sala — fondazioni cloud', () => {
    // I file di test condividono server e DB in sequenza: il tenant 1 torna
    // com'era (flag spento, entitlement acceso, config nodo azzerata).
    afterAll(async () => {
        const owner = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(owner)).send({ sala_node: true });
        await api().put('/settings/features').set(bearer(owner)).send({ sala_node_enabled: false });
        await api().put('/sala-node/settings').set(bearer(owner)).send({ domain: null, lan_ip: null, port: null });
    });

    it('il token per tenant esiste (backfill migration) nella forma pgcrypto', async () => {
        const owner = await ownerToken();
        const token = await salaNodeToken(owner);
        expect(token).toMatch(/^[0-9a-f]{48}$/);
    });

    it('/sala-node/credentials: 401 senza token o con token inventato', async () => {
        const senza = await api().get('/sala-node/credentials');
        expect(senza.status).toBe(401);
        const finto = await api().get('/sala-node/credentials').set('x-sala-node-token', '2'.repeat(48));
        expect(finto.status).toBe(401);
    });

    it('/sala-node/credentials: col token vero consegna segreto e allowlist', async () => {
        const owner = await ownerToken();
        const token = await salaNodeToken(owner);
        const res = await api().get('/sala-node/credentials').set('x-sala-node-token', token);
        expect(res.status).toBe(200);
        expect(res.body.tenant_id).toBe(1);
        // In test JWT_SECRET non è impostato: vale il fallback dev di
        // authService — quel che conta è che sia LO STESSO con cui il server
        // firma, così il nodo verifica i client in locale.
        expect(typeof res.body.jwt_secret).toBe('string');
        expect(res.body.jwt_secret.length).toBeGreaterThan(0);
        expect(Array.isArray(res.body.allowed_origins)).toBe(true);
        // Senza dominio configurato: niente certificato, dominio null.
        expect(res.body.domain).toBeNull();
        expect(res.body.cert).toBeNull();
    });

    it('PUT /sala-node/settings: valida e persiste dominio, IP LAN e porta', async () => {
        const owner = await ownerToken();

        const koDomain = await api().put('/sala-node/settings').set(bearer(owner)).send({ domain: 'non un dominio' });
        expect(koDomain.status).toBe(400);
        const koIp = await api().put('/sala-node/settings').set(bearer(owner)).send({ lan_ip: '999.1.2' });
        expect(koIp.status).toBe(400);
        const koVuoto = await api().put('/sala-node/settings').set(bearer(owner)).send({});
        expect(koVuoto.status).toBe(400);

        const ok = await api().put('/sala-node/settings').set(bearer(owner)).send({
            domain: 'sala.vecchiofrantoio.sympotia.com',
            lan_ip: '192.168.1.60',
            port: 8443,
        });
        expect(ok.status).toBe(200);
        expect(ok.body.domain).toBe('sala.vecchiofrantoio.sympotia.com');
        expect(ok.body.lan_ip).toBe('192.168.1.60');
        expect(ok.body.node_url).toBe('https://sala.vecchiofrantoio.sympotia.com:8443');

        // Porta 443 = URL senza porta esplicita.
        const std = await api().put('/sala-node/settings').set(bearer(owner)).send({ port: 443 });
        expect(std.status).toBe(200);
        expect(std.body.node_url).toBe('https://sala.vecchiofrantoio.sympotia.com');
    });

    it('client-config: enabled solo con flag + entitlement + dominio', async () => {
        const owner = await ownerToken();

        // Dominio configurato dal test precedente, flag ancora spento.
        const spento = await api().get('/sala-node/client-config').set(bearer(owner));
        expect(spento.status).toBe(200);
        expect(spento.body.enabled).toBe(false);
        expect(spento.body.node_url).toBe('https://sala.vecchiofrantoio.sympotia.com');

        const flip = await api().put('/settings/features').set(bearer(owner)).send({ sala_node_enabled: true });
        expect(flip.status).toBe(200);
        expect(flip.body.sala_node_enabled).toBe(true);

        const acceso = await api().get('/sala-node/client-config').set(bearer(owner));
        expect(acceso.body.enabled).toBe(true);
    });

    it("senza l'entitlement il flag si maschera e client-config spegne", async () => {
        const owner = await ownerToken();

        const off = await api().put('/settings/entitlements').set(bearer(owner)).send({ sala_node: false });
        expect(off.status).toBe(200);

        // Il flag operativo resta true a DB ma la lettura lo maschera.
        const flags = await api().get('/settings/features').set(bearer(owner));
        expect(flags.status).toBe(200);
        expect(flags.body.sala_node_enabled).toBe(false);

        const cfg = await api().get('/sala-node/client-config').set(bearer(owner));
        expect(cfg.body.enabled).toBe(false);

        await api().put('/settings/entitlements').set(bearer(owner)).send({ sala_node: true });
    });

    it('/sala/config espone il blocco sala_node accanto ad agent', async () => {
        const owner = await ownerToken();
        const res = await api().get('/sala/config').set(bearer(owner));
        expect(res.status).toBe(200);
        expect(res.body.sala_node).toBeTruthy();
        // Nessun nodo connesso nell'ambiente di test.
        expect(res.body.sala_node.online).toBe(false);
        expect(res.body.sala_node.domain).toBe('sala.vecchiofrantoio.sympotia.com');
        expect(res.body.sala_node.clients).toBeNull();
    });
});
