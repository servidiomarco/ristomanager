import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Il supervisore in «modo agente» (piano «Passepartout plug and play», punto
// 4): per i ristoranti con la sola cassa. Si prova con i pezzi veri: il
// pacchetto leggero dell'agente, il server di test coi suoi rilasci, una
// cassa SOAP finta. Il supervisore avvia l'agente, chiede al cloud se c'è
// una versione nuova per il canale del ristorante, la scarica, la installa
// e torna indietro da solo se la nuova non si collega. In più, con un cloud
// finto, uno zip che non torna con lo sha256 annunciato si scarta.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ADMIN = { 'X-Platform-Admin-Token': 'test-platform-token' };
const busta = (op: string, risultato: string) =>
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<${op}Response xmlns="http://tempuri.org/"><${op}Result>${risultato}</${op}Result></${op}Response></s:Body></s:Envelope>`;

const readJson = (file: string): any => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const isAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Una versione del pacchetto leggero: il bundle costruito, con lo sha
 *  scritto in build-info.json. `rotto` = un agente che esce subito. */
const pacchetto = (base: string, dest: string, sha: string, rotto = false) => {
    fs.cpSync(base, dest, { recursive: true });
    const info = readJson(path.join(dest, 'build-info.json'));
    fs.writeFileSync(path.join(dest, 'build-info.json'), JSON.stringify({ ...info, sha }));
    if (rotto) fs.writeFileSync(path.join(dest, 'passepartout-agent.js'), 'process.exit(1);\n');
};
const zippa = (dir: string, zip: string) => { execFileSync('zip', ['-qr', zip, '.'], { cwd: dir }); return fs.readFileSync(zip); };

describe('supervisore in modo agente, aggiornamenti dal cloud', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisore-agente-'));
    const root = path.join(tmp, 'root');
    const supervisorPath = path.resolve('sala-node/supervisor.mjs');
    const BASE_SHA = 'f00a001';
    const bundle = path.join('build', 'agente', BASE_SHA);
    let token: string;
    let db: Client;
    let cassa: http.Server;
    let urlCassa = '';
    let sup: ChildProcess | null = null;

    const logSup = () => fs.readFileSync(path.join(root, 'logs', 'supervisor.log'), 'utf8');
    const finoA = async (cond: () => boolean | Promise<boolean>, descr: string, timeoutMs = 30_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) {
                let log = '';
                try { log = logSup(); } catch { /* ancora niente */ }
                throw new Error(`Timeout: ${descr}\n${log.slice(-2500)}`);
            }
            await sleep(250);
        }
    };
    const versioneCollegata = async () => (await api().get('/passepartout/status').set(bearer(token))).body?.versione_agente;
    const carica = (sha: string, zip: Buffer) => api().post('/admin/agent-releases').set(ADMIN)
        .set('Content-Type', 'application/zip').set('X-Release-Sha', sha).send(zip);
    const ambiente = (radice: string) => ({
        PATH: process.env.PATH ?? '',
        SYMPOTIA_NODE_ROOT: radice,
        SYMPOTIA_UPDATE_CHECK_MS: '500',
        SYMPOTIA_DOWNLOAD_CHECK_MS: '1500',
        SYMPOTIA_READY_TIMEOUT_MS: '8000',
    });
    const configura = (radice: string, cloudUrl: string) => fs.writeFileSync(path.join(radice, 'nodo.json'), JSON.stringify({
        modo: 'agente',
        cloud_url: cloudUrl,
        update_window: { from: '00:00', to: '24:00' },
        passepartout_agent: {
            env: {
                PP_AGENT_TOKEN: 'test-pp-agent-token',
                PASSEPARTOUT_WS_URL: urlCassa,
                PASSEPARTOUT_WS_USER: 'prova',
                PASSEPARTOUT_WS_PASSWORD: 'prova',
                PP_AGENT_STATE_MS: '1000',
            },
        },
    }));

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
        await db.query(`DELETE FROM agent_releases`);
        await db.query(`UPDATE tenants SET agente_canale = 'pilota' WHERE id = 1`);

        cassa = http.createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                const op = String(req.headers.soapaction ?? '').replace(/"/g, '').split('/').pop() ?? '';
                res.writeHead(200, { 'Content-Type': 'text/xml' });
                res.end(op === 'GetVersioneGestionale' ? busta(op, '2026C1') : busta(op, ''));
            });
        });
        await new Promise<void>((resolve) => cassa.listen(0, '127.0.0.1', resolve));
        urlCassa = `http://127.0.0.1:${(cassa.address() as AddressInfo).port}/AdapterWS`;

        execFileSync('node', ['scripts/build-agent-bundle.mjs'], { env: { ...process.env, BUILD_SHA: BASE_SHA }, stdio: 'pipe' });
        pacchetto(bundle, path.join(root, 'versions', 'aaa1111'), 'aaa1111');
        configura(root, process.env.TEST_BASE_URL!);
        sup = spawn(process.execPath, [supervisorPath, 'run'], { env: ambiente(root), stdio: 'ignore' });
    }, 60_000);

    afterAll(async () => {
        const st = readJson(path.join(root, 'state', 'agente.json'));
        sup?.kill('SIGTERM');
        await sleep(1_500);
        if (st?.pid && isAlive(st.pid)) process.kill(st.pid, 'SIGKILL');
        await new Promise<void>((resolve) => cassa.close(() => resolve()));
        await db.query(`DELETE FROM agent_releases`);
        await db.query(`UPDATE tenants SET agente_canale = 'stabile' WHERE id = 1`);
        await db.end();
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(bundle, { recursive: true, force: true });
    });

    it("avvia l'agente della cassa senza nodo: si collega e scrive il suo stato", async () => {
        await finoA(async () => (await versioneCollegata()) === 'aaa1111', 'agente aaa1111 collegato');
        await finoA(() => readJson(path.join(root, 'state', 'agente.json'))?.ok === true, 'stato scritto');
        expect(readJson(path.join(root, 'state', 'agente.json'))).toMatchObject({ ok: true, in_corso: 0, versione: 'aaa1111' });
        expect(fs.readFileSync(path.join(root, 'current.txt'), 'utf8')).toBe('aaa1111');
        expect(logSup()).toContain('modo agente');
    }, 45_000);

    it('scarica la versione nuova del canale pilota e la installa', async () => {
        const dir = path.join(tmp, 'bbb2222');
        pacchetto(bundle, dir, 'bbb2222');
        expect((await carica('bbb2222', zippa(dir, path.join(tmp, 'bbb2222.zip')))).status).toBe(201);
        await finoA(async () => (await versioneCollegata()) === 'bbb2222', 'agente bbb2222 collegato', 40_000);
        await finoA(() => fs.readFileSync(path.join(root, 'current.txt'), 'utf8') === 'bbb2222', 'current.txt aggiornato');
        expect(fs.readFileSync(path.join(root, 'previous.txt'), 'utf8')).toBe('aaa1111');
        await finoA(() => fs.existsSync(path.join(root, 'inbox', 'done'))
            && fs.readdirSync(path.join(root, 'inbox', 'done')).some(n => n.endsWith('sympotia-agente-bbb2222.zip')), 'zip archiviato');
        expect(logSup()).toContain('scaricato bbb2222');
    }, 60_000);

    it('una versione che non si collega torna indietro, e non si riscarica', async () => {
        const dir = path.join(tmp, 'ccc3333');
        pacchetto(bundle, dir, 'ccc3333', true);
        expect((await carica('ccc3333', zippa(dir, path.join(tmp, 'ccc3333.zip')))).status).toBe(201);
        await finoA(() => fs.existsSync(path.join(root, 'inbox', 'rejected'))
            && fs.readdirSync(path.join(root, 'inbox', 'rejected')).some(n => n.endsWith('sympotia-agente-ccc3333.zip')), 'pacchetto respinto', 45_000);
        expect(fs.readFileSync(path.join(root, 'current.txt'), 'utf8')).toBe('bbb2222');
        await finoA(async () => (await versioneCollegata()) === 'bbb2222', 'di nuovo bbb2222 collegato');
        expect(logSup()).toContain('non si collega al cloud');
        // Qualche giro di controllo dopo: resta solo fra i respinti.
        await finoA(() => logSup().includes('ccc3333 già rifiutato'), 'non riscaricato', 10_000);
        expect(fs.readdirSync(path.join(root, 'inbox')).filter(n => n.includes('ccc3333'))).toEqual([]);
    }, 75_000);

    it('uno zip che non torna con lo sha256 annunciato si scarta', async () => {
        // Cloud finto: annuncia un rilascio con uno sha256 che non è quello dei byte.
        const zip = zippa(path.join(root, 'versions', 'bbb2222'), path.join(tmp, 'finto.zip'));
        const finto = http.createServer((req, res) => {
            if (req.url?.startsWith('/pp-agent/aggiornamento')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ sha: 'ddd4444', sha256: '0'.repeat(64), url: '/pp-agent/rilascio/ddd4444', canale: 'pilota' }));
            }
            if (req.url === '/pp-agent/rilascio/ddd4444') { res.writeHead(200, { 'Content-Type': 'application/zip' }); return res.end(zip); }
            res.writeHead(404); res.end();
        });
        await new Promise<void>((resolve) => finto.listen(0, '127.0.0.1', resolve));
        const altra = path.join(tmp, 'altra');
        pacchetto(bundle, path.join(altra, 'versions', 'aaa1111'), 'aaa1111');
        configura(altra, `http://127.0.0.1:${(finto.address() as AddressInfo).port}`);
        const secondo = spawn(process.execPath, [supervisorPath, 'run'], { env: ambiente(altra), stdio: 'ignore' });
        try {
            const log = () => { try { return fs.readFileSync(path.join(altra, 'logs', 'supervisor.log'), 'utf8'); } catch { return ''; } };
            await finoA(() => log().includes('sha256 diverso da quello annunciato'), 'zip scartato', 15_000);
            expect(fs.existsSync(path.join(altra, 'inbox')) ? fs.readdirSync(path.join(altra, 'inbox')).filter(n => n.includes('ddd4444')) : []).toEqual([]);
        } finally {
            const st = readJson(path.join(altra, 'state', 'agente.json'));
            secondo.kill('SIGTERM');
            await sleep(1_500);
            if (st?.pid && isAlive(st.pid)) process.kill(st.pid, 'SIGKILL');
            await new Promise<void>((resolve) => finto.close(() => resolve()));
        }
    }, 30_000);
});
