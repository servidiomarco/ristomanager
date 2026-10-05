import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Il supervisore del nodo di sala (fase A4), con versioni FINTE: un server
// minimo al posto di dist/server.js e un agente di stampa che non fa niente.
// Niente database: si prova solo il mestiere del supervisore — tiene in vita
// i figli, ne riavvia uno caduto, non si lascia raddoppiare, installa una
// versione dalla inbox e torna indietro da solo se la nuova non si alza.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
            const p = addr.port;
            srv.close(() => resolve(p));
        } else {
            srv.close(() => reject(new Error('no port')));
        }
    });
});

const isAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
};

// Un'app finta: healthy=false fa una versione che non risponde mai a /ready.
const makeApp = (dir: string, sha: string, healthy: boolean) => {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ sha }));
    fs.writeFileSync(path.join(dir, 'dist', 'server.js'), `
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const state = process.env.SALA_NODE_STATE_DIR;
fs.writeFileSync(path.join(state, 'stub-nodo.json'), JSON.stringify({ pid: process.pid, sha: process.env.BUILD_SHA }));
const healthy = ${healthy};
http.createServer((req, res) => {
    if (req.url === '/ready') { res.writeHead(healthy ? 200 : 503); return res.end(); }
    if (req.url === '/sala-node/maintenance-check') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ open_orders: 0, open_bills: 0 }));
    }
    res.writeHead(404); res.end();
}).listen(Number(process.env.PORT), '127.0.0.1');
`);
    fs.writeFileSync(path.join(dir, 'scripts', 'print-agent.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(process.env.STUB_STATE, 'stub-stampa.json'), JSON.stringify({ pid: process.pid, token: process.env.PRINT_AGENT_TOKEN }));
setInterval(() => {}, 1000);
`);
};

describe('supervisore del nodo di sala', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisore-'));
    const state = path.join(root, 'state');
    const supervisorPath = path.resolve('sala-node/supervisor.mjs');
    let port = 0;
    let sup: ChildProcess | null = null;
    let supLog = '';

    const readJson = (file: string): any => {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    };
    const finoA = async (cond: () => boolean | Promise<boolean>, descr: string, timeoutMs = 20_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) {
                const log = fs.existsSync(path.join(root, 'logs', 'supervisor.log'))
                    ? fs.readFileSync(path.join(root, 'logs', 'supervisor.log'), 'utf8') : supLog;
                throw new Error(`Timeout: ${descr}\n${log.slice(-2000)}`);
            }
            await sleep(200);
        }
    };
    const env = () => ({
        ...process.env,
        SYMPOTIA_NODE_ROOT: root,
        SYMPOTIA_UPDATE_CHECK_MS: '500',
        SYMPOTIA_READY_TIMEOUT_MS: '5000',
        STUB_STATE: state,
    });

    beforeAll(async () => {
        port = await freePort();
        fs.mkdirSync(state, { recursive: true });
        makeApp(path.join(root, 'versions', 'aaaaaaa'), 'aaaaaaa', true);
        fs.writeFileSync(path.join(root, 'nodo.json'), JSON.stringify({
            cloud_url: 'http://127.0.0.1:9',
            node_token: 'token-di-prova',
            database_url: 'postgresql://localhost/nessuno',
            port,
            update_window: { from: '00:00', to: '24:00' },
            print_agent: { enabled: true, token: 'token-stampa' },
        }));
        sup = spawn('node', [supervisorPath, 'run'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
        sup.stdout?.on('data', (d) => { supLog += String(d); });
        sup.stderr?.on('data', (d) => { supLog += String(d); });
    }, 30_000);

    afterAll(async () => {
        const nodo = readJson(path.join(state, 'stub-nodo.json'));
        const stampa = readJson(path.join(state, 'stub-stampa.json'));
        sup?.kill('SIGTERM');
        await sleep(1_500);
        for (const pid of [nodo?.pid, stampa?.pid]) if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('avvia nodo e agente di stampa con la configurazione di nodo.json', async () => {
        await finoA(() => Boolean(readJson(path.join(state, 'stub-nodo.json')) && readJson(path.join(state, 'stub-stampa.json'))), 'figli avviati');
        expect(readJson(path.join(state, 'stub-nodo.json')).sha).toBe('aaaaaaa');
        expect(readJson(path.join(state, 'stub-stampa.json')).token).toBe('token-stampa');
        expect(fs.readFileSync(path.join(root, 'current.txt'), 'utf8')).toBe('aaaaaaa');
        expect(fs.existsSync(path.join(root, 'logs', 'supervisor.log'))).toBe(true);
    });

    it('un secondo supervisore si rifiuta di partire', async () => {
        const second = spawn('node', [supervisorPath, 'run'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        second.stdout?.on('data', (d) => { out += String(d); });
        const code = await new Promise<number | null>(resolve => second.on('exit', resolve));
        expect(code).toBe(1);
        expect(out).toContain('un altro supervisore gira già');
    });

    it('un figlio che cade viene rialzato', async () => {
        const before = readJson(path.join(state, 'stub-stampa.json')).pid;
        process.kill(before, 'SIGKILL');
        await finoA(() => {
            const now = readJson(path.join(state, 'stub-stampa.json'));
            return Boolean(now && now.pid !== before && isAlive(now.pid));
        }, 'agente di stampa riavviato');
    });

    it('installa una versione nuova dalla inbox', async () => {
        makeApp(path.join(root, 'inbox', 'bbbbbbb'), 'bbbbbbb', true);
        await finoA(() => readJson(path.join(state, 'stub-nodo.json'))?.sha === 'bbbbbbb', 'versione nuova in uso');
        await finoA(() => fs.existsSync(path.join(root, 'inbox', 'done')) && fs.readdirSync(path.join(root, 'inbox', 'done')).length === 1, 'pacchetto archiviato');
        expect(fs.readFileSync(path.join(root, 'current.txt'), 'utf8')).toBe('bbbbbbb');
        expect(fs.readFileSync(path.join(root, 'previous.txt'), 'utf8')).toBe('aaaaaaa');
    }, 30_000);

    it('una versione che non si alza viene respinta e si torna a quella di prima', async () => {
        makeApp(path.join(root, 'inbox', 'ccccccc'), 'ccccccc', false);
        await finoA(() => fs.existsSync(path.join(root, 'inbox', 'rejected')) && fs.readdirSync(path.join(root, 'inbox', 'rejected')).length === 1, 'pacchetto respinto', 30_000);
        expect(fs.readFileSync(path.join(root, 'current.txt'), 'utf8')).toBe('bbbbbbb');
        await finoA(() => readJson(path.join(state, 'stub-nodo.json'))?.sha === 'bbbbbbb', 'di nuovo la versione buona');
        expect(fs.readFileSync(path.join(root, 'logs', 'supervisor.log'), 'utf8')).toContain('aggiornamento FALLITO');
    }, 45_000);
});
