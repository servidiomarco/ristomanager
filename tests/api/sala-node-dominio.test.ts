import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, ownerToken, bearer } from './helpers';
import { pgClient, platformSessionFor, dropPlatformSession, assertNoCloudflareToken } from './platformSession';
import { RENEWAL_CANDIDATES_SQL, isNodeDomainInZone } from '../../services/salaNodeTls';
import pool from '../../db';

// Audit isolamento tenant H-05 (25/09): dominio e certificato del nodo di
// sala non sono più del tenant. Prima un OWNER qualunque (il login demo della
// Pizzeria è in mano ai prospect) sceglieva un host qualsiasi della zona del
// brand, puntava il record A a un IP pubblico e si faceva emettere un
// certificato. Qui il contratto nuovo:
// - il dominio lo cambia solo la sessione di piattaforma («Entra»); lo stesso
//   valore rimandato dalla card è un no-op e il resto si salva;
// - dominio nuovo solo sala.<etichetta>.<zona>, mai apex o nomi riservati,
//   unico fra tenant; IP LAN solo privato o CGNAT;
// - l'emissione è della piattaforma; la sync del solo record A resta al
//   gestore, con IP privato, solo su sala.<nome> o sul nome del proprio
//   certificato, e al massimo 5 al minuto;
// - collisioni scritte prima del fix: vince chi ha la riga del certificato.
// Cloudflare nei test non c'è (globalSetup azzera CLOUDFLARE_API_TOKEN e
// il beforeAll lo verifica): si verifica che i controlli passino o fermino
// PRIMA della chiamata al provider — il 503 tls_not_configured è la prova
// che tutti i controlli sono passati.

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const SLUG_B = 'pizzeria-test-nodo';
const OWNER_B_EMAIL = 'owner.nodo@example.com';

const DOMINIO_A = 'sala.frantoiotest.sympotia.com';
const DOMINIO_B = 'sala.pizzeriatest.sympotia.com';

describe('nodo di sala — dominio gestito dalla piattaforma (audit H-05)', () => {
    let tenantB = 0;
    let ownerA = '';
    let ownerB = '';
    let platA = '';
    let platB = '';

    const put = (token: string, body: Record<string, unknown>) =>
        api().put('/sala-node/settings').set(bearer(token)).send(body);
    const sql = async (text: string, params: unknown[] = []) => {
        const client = await pgClient();
        try { return await client.query(text, params); } finally { await client.end(); }
    };

    beforeAll(async () => {
        assertNoCloudflareToken();
        // Id di tenant in un intervallo di questo solo file (64000+), MAI
        // riusato nella run. Molti file cancellano i loro tenant e riportano
        // la sequence a MAX(id) o a 100: il tenant creato dopo riprende un id
        // già usato, e il server gli serve le cache in memoria per id del
        // tenant cancellato (permessi in auth/permissionService.ts, add-on in
        // services/entitlements.ts). Nella suite completa questo file dava
        // 403 «Insufficient permissions» sul tenant B. In produzione la
        // sequence non torna mai indietro.
        await sql(`SELECT setval(pg_get_serial_sequence('tenants','id'), GREATEST((SELECT MAX(id) FROM tenants), 64000))`);

        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG_B,
            name: 'Pizzeria Test Nodo',
            owner_email: OWNER_B_EMAIL,
            owner_full_name: 'Owner Di Prova Nodo',
            features: { sala_node: true },
        });
        if (created.status !== 201) {
            throw new Error(`Provisioning fallito (${created.status}): ${JSON.stringify(created.body)}`);
        }
        tenantB = created.body.tenant.id;
        const loginB = await api().post('/auth/login').send({ email: OWNER_B_EMAIL, password: created.body.owner_temp_password });
        if (loginB.status !== 200) throw new Error(`Login owner B fallito (${loginB.status})`);
        ownerB = loginB.body.accessToken;

        ownerA = await ownerToken();
        platA = await platformSessionFor(1);
        platB = await platformSessionFor(tenantB);
    });

    afterAll(async () => {
        const client = await pgClient();
        try {
            await client.query(
                `DELETE FROM app_settings WHERE tenant_id = 1 AND key IN ('sala_node_domain', 'sala_node_lan_ip', 'sala_node_port')`
            );
            await client.query(`DELETE FROM sala_node_certs WHERE domain IN ($1, $2)`, [DOMINIO_A, DOMINIO_B]);
            const t = await client.query('SELECT id FROM tenants WHERE slug = $1', [SLUG_B]);
            const id = t.rows[0]?.id;
            if (id != null) {
                await client.query('DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)', [id]);
                for (const table of ['sala_node_certs', 'activity_logs', 'users', 'tenant_features', 'opening_hours', 'role_permissions', 'app_settings']) {
                    await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]);
                }
                await client.query('DELETE FROM tenants WHERE id = $1', [id]);
            }
        } finally {
            await client.end();
        }
        await dropPlatformSession();
        // Il pool di db.ts è nato dall'import di salaNodeTls in QUESTO
        // processo (come in billing.test): senza end() il worker resta appeso.
        await pool.end();
    });

    it("l'owner non cambia il dominio (403), ma il dominio invariato salva il resto (200)", async () => {
        const assegnato = await put(platA, { domain: DOMINIO_A, lan_ip: '192.168.1.60', port: 8443 });
        expect(assegnato.status).toBe(200);
        expect(assegnato.body.domain).toBe(DOMINIO_A);

        const cambio = await put(ownerA, { domain: 'sala.altro.sympotia.com' });
        expect(cambio.status).toBe(403);
        expect(cambio.body.error).toBe('domain_platform_managed');
        // Anche azzerarlo è un cambio: un rifiuto non salva nemmeno il resto.
        const azzera = await put(ownerA, { domain: null, lan_ip: '192.168.1.99' });
        expect(azzera.status).toBe(403);

        // La card vecchia rimanda dominio + IP + porta a ogni salvataggio.
        const invariato = await put(ownerA, { domain: DOMINIO_A, lan_ip: '192.168.1.61', port: 443 });
        expect(invariato.status).toBe(200);
        expect(invariato.body.domain).toBe(DOMINIO_A);
        expect(invariato.body.lan_ip).toBe('192.168.1.61');
        expect(invariato.body.node_url).toBe(`https://${DOMINIO_A}`);

        // Maiuscole e spazi non sono un cambio; il solo dominio invariato è un no-op.
        const maiuscolo = await put(ownerA, { domain: ` ${DOMINIO_A.toUpperCase()} ` });
        expect(maiuscolo.status).toBe(200);
        expect(maiuscolo.body.domain).toBe(DOMINIO_A);
    });

    it('IP LAN: solo rete privata (RFC1918) o CGNAT, anche per la piattaforma', async () => {
        for (const ip of ['8.8.8.8', '203.0.113.7', '172.32.0.1', '100.128.0.1', '192.169.1.1', '999.1.1.1']) {
            const res = await put(ownerA, { lan_ip: ip });
            expect(res.status, ip).toBe(400);
        }
        const pubblico = await put(platA, { lan_ip: '8.8.8.8' });
        expect(pubblico.status).toBe(400);
        expect(pubblico.body.error).toBe('lan_ip_not_private');

        for (const ip of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '100.64.0.1', '100.100.1.2', '192.168.1.60']) {
            const res = await put(ownerA, { lan_ip: ip });
            expect(res.status, ip).toBe(200);
            expect(res.body.lan_ip).toBe(ip);
        }
    });

    it('fuori zona, apex, nomi riservati o annidati: 400 anche per la piattaforma', async () => {
        const casi: Array<[string, string]> = [
            ['sympotia.com', 'domain_not_allowed'],
            ['www.sympotia.com', 'domain_not_allowed'],
            ['app.sympotia.com', 'domain_not_allowed'],
            ['sala.example.com', 'domain_not_allowed'],
            ['sala.frantoio.sympotia.com.example.com', 'domain_not_allowed'],
            ['sala.a.b.sympotia.com', 'domain_not_allowed'],
            ['sala.www.sympotia.com', 'domain_reserved'],
            ['sala.prenota.sympotia.com', 'domain_reserved'],
            ['non un dominio', 'invalid_domain'],
        ];
        for (const [domain, codice] of casi) {
            const res = await put(platA, { domain });
            expect(res.status, domain).toBe(400);
            expect(res.body.error, domain).toBe(codice);
        }
        // Nessuno dei rifiuti ha toccato il dominio assegnato.
        const ora = await put(ownerA, { port: 8443 });
        expect(ora.body.domain).toBe(DOMINIO_A);
    });

    it("provision-cert: l'owner riceve 403, la piattaforma passa i controlli", async () => {
        const owner = await api().post('/sala-node/provision-cert').set(bearer(ownerA));
        expect(owner.status).toBe(403);
        expect(owner.body.error).toBe('cert_platform_managed');

        const piattaforma = await api().post('/sala-node/provision-cert').set(bearer(platA));
        expect(piattaforma.status).toBe(503);
        expect(piattaforma.body.error).toBe('tls_not_configured');
    });

    it('un dominio è unico fra tenant', async () => {
        const preso = await put(platB, { domain: DOMINIO_A });
        expect(preso.status).toBe(409);
        expect(preso.body.error).toBe('domain_taken');

        const proprio = await put(platB, { domain: DOMINIO_B, lan_ip: '10.0.0.5' });
        expect(proprio.status).toBe(200);
        expect(proprio.body.domain).toBe(DOMINIO_B);

        // E nemmeno la piattaforma sposta A sul dominio di B.
        const sopra = await put(platA, { domain: DOMINIO_B });
        expect(sopra.status).toBe(409);
    });

    it('collisione scritta prima del fix: vince il tenant che ha la riga del certificato', async () => {
        // B si era preso il dominio di A prima del fix; A ha già il certificato.
        await sql(`UPDATE app_settings SET text_value = $1 WHERE tenant_id = $2 AND key = 'sala_node_domain'`, [DOMINIO_A, tenantB]);
        await sql(
            `INSERT INTO sala_node_certs (tenant_id, domain, cert_pem, key_pem, expires_at)
             VALUES (1, $1, 'cert-finto', 'chiave-finta', CURRENT_TIMESTAMP + interval '10 days')`,
            [DOMINIO_A]
        );

        const dnsA = await api().post('/sala-node/sync-dns').set(bearer(ownerA));
        expect(dnsA.status).toBe(503);
        expect(dnsA.body.error).toBe('tls_not_configured');
        const certA = await api().post('/sala-node/provision-cert').set(bearer(platA));
        expect(certA.status).toBe(503);

        const dnsB = await api().post('/sala-node/sync-dns').set(bearer(ownerB));
        expect(dnsB.status).toBe(409);
        expect(dnsB.body.error).toBe('domain_taken');
        const certB = await api().post('/sala-node/provision-cert').set(bearer(platB));
        expect(certB.status).toBe(409);
        expect(certB.body.error).toBe('domain_taken');

        // Anche se B si era fatto emettere un certificato per lo stesso nome,
        // il rinnovo del Frantoio non si blocca: fra più titolari vince l'id
        // più basso, deterministicamente.
        await sql(
            `INSERT INTO sala_node_certs (tenant_id, domain, cert_pem, key_pem, expires_at)
             VALUES ($1, $2, 'cert-finto', 'chiave-finta', CURRENT_TIMESTAMP + interval '10 days')`,
            [tenantB, DOMINIO_A]
        );
        expect((await api().post('/sala-node/sync-dns').set(bearer(ownerA))).status).toBe(503);
        expect((await api().post('/sala-node/sync-dns').set(bearer(ownerB))).status).toBe(409);
    });

    it('emissione manuale: rifiutata se il certificato vale oltre 30 giorni, salvo force', async () => {
        await sql(`UPDATE sala_node_certs SET expires_at = CURRENT_TIMESTAMP + interval '60 days' WHERE tenant_id = 1 AND domain = $1`, [DOMINIO_A]);
        const presto = await api().post('/sala-node/provision-cert').set(bearer(platA));
        expect(presto.status).toBe(409);
        expect(presto.body.error).toBe('cert_still_valid');
        const forzato = await api().post('/sala-node/provision-cert').set(bearer(platA)).send({ force: true });
        expect(forzato.status).toBe(503);
    });

    it('sync DNS: rifiuta i valori salvati prima del fix (IP pubblico, host di piattaforma)', async () => {
        await sql(`UPDATE app_settings SET text_value = '203.0.113.7' WHERE tenant_id = 1 AND key = 'sala_node_lan_ip'`);
        const pubblico = await api().post('/sala-node/sync-dns').set(bearer(ownerA));
        expect(pubblico.status).toBe(400);
        expect(pubblico.body.error).toBe('lan_ip_not_private');
        await sql(`UPDATE app_settings SET text_value = '192.168.1.60' WHERE tenant_id = 1 AND key = 'sala_node_lan_ip'`);

        await sql(`UPDATE app_settings SET text_value = 'app.sympotia.com' WHERE tenant_id = $1 AND key = 'sala_node_domain'`, [tenantB]);
        const piattaforma = await api().post('/sala-node/sync-dns').set(bearer(ownerB));
        expect(piattaforma.status).toBe(400);
        expect(piattaforma.body.error).toBe('domain_not_allowed');
        const certPiattaforma = await api().post('/sala-node/provision-cert').set(bearer(platB));
        expect(certPiattaforma.status).toBe(400);
        expect(certPiattaforma.body.error).toBe('domain_not_allowed');
    });

    it('sync DNS del gestore: solo sala.<nome> della zona o il nome del proprio certificato', async () => {
        // Revisione del 25/09: la regola larga del rinnovo lasciava al gestore
        // un record A su qualunque nome non riservato della zona salvato prima
        // del fix — pay.sympotia.com, x.y.sympotia.com — cioè sopra un host
        // del brand. Ora quei nomi li riallinea solo la piattaforma.
        const dns = (token: string) => api().post('/sala-node/sync-dns').set(bearer(token));
        for (const nome of ['pay.sympotia.com', 'x.y.sympotia.com']) {
            await sql(`UPDATE app_settings SET text_value = $1 WHERE tenant_id = $2 AND key = 'sala_node_domain'`, [nome, tenantB]);
            const gestore = await dns(ownerB);
            expect(gestore.status, nome).toBe(403);
            expect(gestore.body.error, nome).toBe('domain_platform_managed');
        }
        const piattaforma = await dns(platB);
        expect(piattaforma.status).toBe(503);
        expect(piattaforma.body.error).toBe('tls_not_configured');

        // La rete di sicurezza per il valore vivo del Frantoio, qualunque
        // forma abbia: chi ha già il certificato per quel nome lo ripunta.
        await sql(
            `INSERT INTO sala_node_certs (tenant_id, domain, cert_pem, key_pem, expires_at)
             VALUES ($1, 'x.y.sympotia.com', 'cert-finto', 'chiave-finta', CURRENT_TIMESTAMP + interval '60 days')`,
            [tenantB]
        );
        const conCert = await dns(ownerB);
        expect(conCert.status).toBe(503);
        expect(conCert.body.error).toBe('tls_not_configured');
        await sql(`DELETE FROM sala_node_certs WHERE tenant_id = $1 AND domain = 'x.y.sympotia.com'`, [tenantB]);

        // Il dominio vivo nella forma sala.<nome> passa anche senza certificato.
        await sql(`UPDATE app_settings SET text_value = $1 WHERE tenant_id = $2 AND key = 'sala_node_domain'`, [DOMINIO_B, tenantB]);
        expect((await dns(ownerB)).status).toBe(503);
    });

    it('sync DNS: al massimo 5 al minuto per tenant, e i rifiuti non contano', async () => {
        // Ogni sync sono fino a 3 richieste API col token globale di
        // Cloudflare (limite 1200 ogni 5 minuti per tutto l'account): un
        // login con settings:full in loop lo bloccava.
        const dns = (token: string) => api().post('/sala-node/sync-dns').set(bearer(token));

        // I rifiuti non arrivano a Cloudflare e non consumano tentativi.
        await sql(`UPDATE app_settings SET text_value = '203.0.113.7' WHERE tenant_id = 1 AND key = 'sala_node_lan_ip'`);
        for (let i = 0; i < 6; i++) {
            expect((await dns(ownerA)).status).toBe(400);
        }
        await sql(`UPDATE app_settings SET text_value = '192.168.1.60' WHERE tenant_id = 1 AND key = 'sala_node_lan_ip'`);

        // Il test precedente può aver già speso qualche tentativo di A nello
        // stesso minuto: si chiama finché arriva il 429, al massimo 6 volte.
        const esiti: number[] = [];
        let rifiuto: any = null;
        for (let i = 0; i < 6; i++) {
            const res = await dns(ownerA);
            esiti.push(res.status);
            if (res.status === 429) { rifiuto = res.body; break; }
        }
        expect(esiti[esiti.length - 1], esiti.join(',')).toBe(429);
        expect(esiti.slice(0, -1).every(s => s === 503), esiti.join(',')).toBe(true);
        expect(esiti.length).toBeGreaterThanOrEqual(2);
        expect(rifiuto.error).toBe('rate_limited');
        // Il freno vale per tenant e anche per la piattaforma su quel tenant.
        expect((await dns(platA)).status).toBe(429);
        // B non ne risente.
        expect((await dns(ownerB)).status).toBe(503);
    });

    it("senza l'add-on sala_node: 403 su impostazioni, emissione e sync DNS", async () => {
        const off = await api().patch(`/admin/tenants/${tenantB}`).set(ADMIN_HEADER).send({ features: { sala_node: false } });
        expect(off.status).toBe(200);
        const settings = await put(ownerB, { port: 443 });
        expect(settings.status).toBe(403);
        expect(settings.body.error).toBe('feature_not_enabled');
        expect((await api().post('/sala-node/sync-dns').set(bearer(ownerB))).status).toBe(403);
        expect((await api().post('/sala-node/provision-cert').set(bearer(platB))).status).toBe(403);
    });

    it('il rinnovo prende solo il certificato del dominio corrente, e solo con l\'add-on', async () => {
        // A: riga del dominio corrente (in scadenza) + riga di un dominio
        // vecchio. Prima la riga vecchia restava «in scadenza» per sempre e
        // forzava un'emissione al giorno per il dominio corrente.
        await sql(`UPDATE sala_node_certs SET expires_at = CURRENT_TIMESTAMP + interval '5 days' WHERE tenant_id = 1 AND domain = $1`, [DOMINIO_A]);
        await sql(
            `INSERT INTO sala_node_certs (tenant_id, domain, cert_pem, key_pem, expires_at)
             VALUES (1, $1, 'cert-finto', 'chiave-finta', CURRENT_TIMESTAMP + interval '5 days')`,
            [DOMINIO_B]
        );
        // B ha di nuovo come dominio corrente quello del suo certificato, ma
        // l'add-on è spento (test precedente).
        await sql(`UPDATE app_settings SET text_value = $1 WHERE tenant_id = $2 AND key = 'sala_node_domain'`, [DOMINIO_A, tenantB]);

        const client = await pgClient();
        try {
            const rs = await client.query(RENEWAL_CANDIDATES_SQL, ['30']);
            const righe = rs.rows.map(r => `${r.tenant_id}:${r.domain}`).sort();
            expect(righe).toEqual([`1:${DOMINIO_A}`]);
        } finally {
            await client.end();
        }
    });

    it('il percorso di rinnovo accetta il dominio vivo del Frantoio così com\'è', () => {
        // Lo slug del Frantoio è vecchio-frantoio, il dominio vivo no: la
        // regola del rinnovo non lo ricava dallo slug e non lo rinomina.
        expect(isNodeDomainInZone('sala.vecchiofrantoio.sympotia.com')).toBe(true);
        expect(isNodeDomainInZone('sympotia.com')).toBe(false);
        expect(isNodeDomainInZone('app.sympotia.com')).toBe(false);
        expect(isNodeDomainInZone('www.sympotia.com')).toBe(false);
        expect(isNodeDomainInZone('sala.vecchiofrantoio.example.com')).toBe(false);
    });
});
