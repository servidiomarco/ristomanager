import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { Client } from 'pg';
import { api } from './helpers';

// Rilasci dell'agente della cassa dal cloud (piano «plug and play», punto
// 3): la CI carica il pacchetto leggero col token di piattaforma, il
// pannello lo promuove a stabile, il supervisore sul PC chiede se c'è una
// versione nuova per il suo canale e la scarica col token dell'agente.

const ADMIN = { 'X-Platform-Admin-Token': 'test-platform-token' };
const AGENTE = { Authorization: 'Bearer test-pp-agent-token' };

/** Uno zip finto ma con l'intestazione giusta. */
const zipFinto = (testo: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(testo)]);
const impronta = (testo: string) => crypto.createHash('sha256').update(testo).digest('hex');

const carica = (sha: string, testo: string, headers: Record<string, string> = ADMIN) =>
    api().post('/admin/agent-releases')
        .set(headers)
        .set('Content-Type', 'application/zip')
        .set('X-Release-Sha', sha)
        .set('X-Contenuto-Sha256', impronta(testo))
        .send(zipFinto(testo));

describe('rilasci dell\'agente della cassa', () => {
    let db: Client;

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await db.query(`DELETE FROM agent_releases`);
        await db.query(`UPDATE tenants SET agente_canale = 'stabile' WHERE id = 1`);
    });

    afterAll(async () => {
        await db.query(`DELETE FROM agent_releases`);
        await db.query(`UPDATE tenants SET agente_canale = 'stabile' WHERE id = 1`);
        await db.end();
    });

    it('si carica solo col token di piattaforma, e solo uno zip', async () => {
        expect((await carica('aaa0001', 'v1', {})).status).toBeGreaterThanOrEqual(401);
        expect((await carica('aaa0001', 'v1', { 'X-Platform-Admin-Token': 'sbagliato' })).status).toBe(401);
        const nonZip = await api().post('/admin/agent-releases').set(ADMIN).set('Content-Type', 'application/zip')
            .set('X-Release-Sha', 'aaa0001').send(Buffer.from('non sono uno zip'));
        expect(nonZip.status).toBe(400);
        expect((await carica('NON-HEX', 'v1')).status).toBe(400);

        const r = await carica('aaa0001', 'v1');
        expect(r.status).toBe(201);
        expect(r.body).toMatchObject({ sha: 'aaa0001', canale: 'pilota', sha256: crypto.createHash('sha256').update(zipFinto('v1')).digest('hex') });
    });

    it('lo stesso codice non diventa un rilascio nuovo', async () => {
        const r = await carica('aaa0002', 'v1');
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ sha: 'aaa0001', invariato: true });
        expect((await db.query(`SELECT COUNT(*)::int AS n FROM agent_releases`)).rows[0].n).toBe(1);
    });

    it('il canale stabile vede solo i promossi, il pilota l\'ultimo caricato', async () => {
        // Senza token dell'agente niente.
        expect((await api().get('/pp-agent/aggiornamento')).status).toBe(401);
        expect((await api().get('/pp-agent/aggiornamento').set({ Authorization: 'Bearer sbagliato' })).status).toBe(401);
        // Ristorante 1 su stabile, nessuno promosso: niente da fare.
        expect((await api().get('/pp-agent/aggiornamento').set(AGENTE)).status).toBe(204);

        expect((await api().post('/admin/agent-releases/aaa0001/promuovi').set(ADMIN)).status).toBe(200);
        await carica('bbb0002', 'v2');
        let r = await api().get('/pp-agent/aggiornamento?ho=0000000').set(AGENTE);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ sha: 'aaa0001', canale: 'stabile', url: '/pp-agent/rilascio/aaa0001' });
        // Chi ha già quella versione non scarica.
        expect((await api().get('/pp-agent/aggiornamento?ho=aaa0001').set(AGENTE)).status).toBe(204);

        // Il pilota prende l'ultimo caricato.
        expect((await api().put('/admin/tenants/1/agente-canale').set(ADMIN).send({ canale: 'pilota' })).status).toBe(200);
        r = await api().get('/pp-agent/aggiornamento?ho=aaa0001').set(AGENTE);
        expect(r.body).toMatchObject({ sha: 'bbb0002', canale: 'pilota' });
        expect((await api().put('/admin/tenants/1/agente-canale').set(ADMIN).send({ canale: 'beta' })).status).toBe(400);

        // Ritirato il pilota, si torna al precedente; lo stabile in uso non si ritira.
        expect((await api().delete('/admin/agent-releases/bbb0002').set(ADMIN)).status).toBe(200);
        r = await api().get('/pp-agent/aggiornamento?ho=bbb0002').set(AGENTE);
        expect(r.body).toMatchObject({ sha: 'aaa0001' });
        expect((await api().delete('/admin/agent-releases/aaa0001').set(ADMIN)).status).toBe(409);
    });

    it('lo scaricamento dà i byte caricati, col loro sha256', async () => {
        expect((await api().get('/pp-agent/rilascio/aaa0001')).status).toBe(401);
        expect((await api().get('/pp-agent/rilascio/fff9999').set(AGENTE)).status).toBe(404);
        const r = await api().get('/pp-agent/rilascio/aaa0001').set(AGENTE)
            .buffer(true).parse((res, cb) => {
                const parti: Buffer[] = [];
                res.on('data', (d: Buffer) => parti.push(d));
                res.on('end', () => cb(null, Buffer.concat(parti)));
            });
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toBe('application/zip');
        expect(Buffer.compare(r.body as Buffer, zipFinto('v1'))).toBe(0);
        expect(r.headers['x-sha256']).toBe(crypto.createHash('sha256').update(zipFinto('v1')).digest('hex'));
    });

    it('se ne tengono dieci, e lo stabile in uso resta anche se vecchio', async () => {
        for (let i = 0; i < 11; i++) {
            const r = await carica(`ccc${String(i).padStart(4, '0')}`, `v-${i}`);
            expect(r.status).toBe(201);
        }
        const shas = (await db.query(`SELECT sha FROM agent_releases ORDER BY created_at DESC`)).rows.map((x) => x.sha);
        expect(shas).toHaveLength(11);
        expect(shas).toContain('aaa0001');
        expect(shas).not.toContain('ccc0000');

        const lista = await api().get('/admin/agent-releases').set(ADMIN);
        expect(lista.status).toBe(200);
        expect(lista.body.rilasci.find((x: any) => x.sha === 'aaa0001')).toMatchObject({ canale: 'stabile', stabile_in_uso: true });
        expect(lista.body.rilasci[0]).toMatchObject({ sha: 'ccc0010', canale: 'pilota' });
        expect(Array.isArray(lista.body.ristoranti)).toBe(true);
    });
});
