import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';

// Abbinamento del PC della cassa con un codice (piano «plug and play»,
// punto 1): dalla sezione si genera un codice da 15 minuti, l'agente lo
// scambia col token, e lo scambio ruota il token — l'agente di prima (qui
// quello col token storico del ristorante 1) si stacca e non rientra.
// Alla fine il token storico torna valido: i file dopo lo usano.

const TOKEN_STORICO = 'test-pp-agent-token';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('abbinamento del PC della cassa col codice', () => {
    let token: string;
    let db: Client;
    const aperti: Socket[] = [];
    let tokenNuovo = '';

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(100);
        }
    };
    /** Collega un agente finto; risolve con la socket, o rifiuta se il
     *  server non lo accetta. */
    const collega = (tokenAgente: string, hostname: string, versioneAgente?: string) => new Promise<Socket>((resolve, reject) => {
        const socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
            auth: { token: tokenAgente }, transports: ['websocket'], reconnection: false,
        });
        aperti.push(socket);
        socket.on('connect', () => {
            socket.emit('agent:hello', { hostname, versioneGestionale: '2026C1', versioneAgente, capabilities: ['chiudi-riprendi'] });
            resolve(socket);
        });
        socket.on('connect_error', reject);
    });
    const stato = async () => (await api().get('/passepartout/status').set(bearer(token))).body;

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
    });

    afterAll(async () => {
        for (const s of aperti) s.close();
        await db.query(`DELETE FROM passepartout_abbinamenti WHERE tenant_id = 1`);
        await db.query(`UPDATE passepartout_config SET token_storico_spento = false, abbinato_at = NULL, abbinato_hostname = NULL WHERE tenant_id = 1`);
        // Il token storico torna buono per i file dopo.
        const di_nuovo = await collega(TOKEN_STORICO, 'PC-STORICO');
        di_nuovo.close();
        await db.end();
    });

    it('il codice nasce nella sezione: breve, senza caratteri ambigui, valido 15 minuti', async () => {
        const r = await api().post('/passepartout/abbinamento').set(bearer(token));
        expect(r.status).toBe(200);
        expect(r.body.codice).toMatch(/^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
        const minuti = (Date.parse(r.body.scade_at) - Date.now()) / 60_000;
        expect(minuti).toBeGreaterThan(14);
        expect(minuti).toBeLessThanOrEqual(15.1);
        // In chiaro non resta: solo l'hash.
        const salvato = await db.query(`SELECT codice_hash FROM passepartout_abbinamenti WHERE tenant_id = 1 AND usato_at IS NULL`);
        expect(salvato.rows).toHaveLength(1);
        expect(salvato.rows[0].codice_hash).not.toContain(r.body.codice.replace('-', ''));
        const cfg = await api().get('/passepartout/config').set(bearer(token));
        expect(cfg.body.abbinamento).toMatchObject({ token_storico: true });
        expect(cfg.body.abbinamento.codice_scade_at).toBeTruthy();
    });

    it("lo scambio dà il token, stacca l'agente di prima e il token storico smette di valere", async () => {
        const vecchio = await collega(TOKEN_STORICO, 'PC-VECCHIO');
        await finoA(async () => (await stato()).hostname === 'PC-VECCHIO', 'agente col token storico collegato');
        const staccato = new Promise<void>((resolve) => vecchio.on('disconnect', () => resolve()));

        const { codice } = (await api().post('/passepartout/abbinamento').set(bearer(token))).body;
        const r = await api().post('/pp-agent/abbina').send({ codice: codice.toLowerCase(), hostname: 'PC-NUOVO', versione: 'abc1234' });
        expect(r.status).toBe(200);
        expect(r.body.token).toMatch(/^[0-9a-f]{48}$/);
        tokenNuovo = r.body.token;
        await staccato;

        // Il token storico non rientra più.
        await expect(collega(TOKEN_STORICO, 'PC-VECCHIO')).rejects.toThrow();
        // Quello nuovo sì, con la versione dell'agente.
        await collega(tokenNuovo, 'PC-NUOVO', 'abc1234');
        await finoA(async () => (await stato()).hostname === 'PC-NUOVO', 'agente col token nuovo collegato');
        expect((await stato()).versione_agente).toBe('abc1234');
        const cfg = await api().get('/passepartout/config').set(bearer(token));
        expect(cfg.body.abbinamento).toMatchObject({ hostname: 'PC-NUOVO', token_storico: false, codice_scade_at: null });
    });

    it('un codice vale una volta sola, e non dopo la scadenza', async () => {
        const { codice } = (await api().post('/passepartout/abbinamento').set(bearer(token))).body;
        await db.query(`UPDATE passepartout_abbinamenti SET scade_at = now() - interval '1 minute' WHERE tenant_id = 1 AND usato_at IS NULL`);
        const scaduto = await api().post('/pp-agent/abbina').send({ codice, hostname: 'PC-X' });
        expect(scaduto.status).toBe(404);
        expect(scaduto.body.error).toBe('codice_non_valido');

        const usato = (await db.query(`SELECT 1 FROM passepartout_abbinamenti WHERE tenant_id = 1 AND usato_at IS NOT NULL`)).rows;
        expect(usato.length).toBeGreaterThan(0);
        expect((await api().post('/pp-agent/abbina').send({ codice: 'ZZZZ-ZZZZ' })).status).toBe(404);
        expect((await api().post('/pp-agent/abbina').send({ codice: 'corto' })).status).toBe(400);
    });

    it('«Scollega» ruota il token: l\'agente si stacca e non rientra', async () => {
        const r = await api().post('/passepartout/scollega').set(bearer(token));
        expect(r.status).toBe(200);
        await finoA(async () => (await stato()).connected === false, 'agente staccato');
        await expect(collega(tokenNuovo, 'PC-NUOVO')).rejects.toThrow();
        const cfg = await api().get('/passepartout/config').set(bearer(token));
        expect(cfg.body.abbinamento).toMatchObject({ hostname: null });
    });
});
