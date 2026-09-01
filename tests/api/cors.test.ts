import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api } from './helpers';

// Fase D4 — CORS chiuso su allowlist (services/corsAllowlist.ts). Il
// pacchetto cors, quando la funzione origin risponde `false`, NON blocca la
// richiesta: omette gli header Access-Control-Allow-* e lascia che sia il
// browser a rifiutare la risposta — quindi qui si verifica la presenza o
// l'assenza dell'header, non lo status.
describe('cors', () => {
    // Dominio custom inserito direttamente in tenant_domains (come fa
    // prenota-slug.test.ts): NON è tra i fallback env della allowlist, quindi
    // se l'header arriva è stata davvero la lookup dinamica a consentirlo.
    // Va inserito PRIMA di qualunque richiesta con Origin di questo file:
    // la cache (TTL 60s) si riempie alla prima origine non statica e non
    // verrebbe aggiornata in tempo per il test.
    const CUSTOM_DOMAIN = 'crm.trattoria-collaudo.it';
    let db: Client;

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await db.query(
            `INSERT INTO tenant_domains (domain, tenant_id, purpose) VALUES ($1, 1, 'crm')
             ON CONFLICT (domain) DO NOTHING`,
            [CUSTOM_DOMAIN]
        );
    });

    afterAll(async () => {
        await db.query('DELETE FROM tenant_domains WHERE domain = $1', [CUSTOM_DOMAIN]);
        await db.end();
    });

    it('origine sconosciuta: risposta senza access-control-allow-origin', async () => {
        const res = await api().get('/health').set('Origin', 'https://evil.example');
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rete privata consentita fuori produzione (collaudo in sala dai tablet)', async () => {
        // In produzione (NODE_ENV=production, dal Dockerfile) resta chiusa:
        // qui il server di test gira senza, come lo stack di collaudo.
        const res = await api().get('/health').set('Origin', 'http://192.168.1.26:5199');
        expect(res.headers['access-control-allow-origin']).toBe('http://192.168.1.26:5199');
    });

    it('localhost è consentito su qualunque porta (sviluppo)', async () => {
        const res = await api().get('/health').set('Origin', 'http://localhost:5173');
        expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });

    it('i deploy preview Vercel sono consentiti (suffix match, non includes)', async () => {
        const ok = await api().get('/health').set('Origin', 'https://ristomanager-abc123.vercel.app');
        expect(ok.headers['access-control-allow-origin']).toBe('https://ristomanager-abc123.vercel.app');

        // "vercel.app" in mezzo all'hostname non deve bastare.
        const evil = await api().get('/health').set('Origin', 'https://vercel.app.attacker.com');
        expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('un dominio custom in tenant_domains è consentito (lookup dinamica)', async () => {
        const res = await api().get('/health').set('Origin', `https://${CUSTOM_DOMAIN}`);
        expect(res.headers['access-control-allow-origin']).toBe(`https://${CUSTOM_DOMAIN}`);
    });

    it('senza header Origin la richiesta passa normalmente (curl, webhook)', async () => {
        const res = await api().get('/health');
        expect(res.status).toBe(200);
    });
});
