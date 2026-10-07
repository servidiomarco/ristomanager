#!/usr/bin/env node
// Il supervisore del nodo di sala (fase A4 del piano «sala, comande e conto
// sul nodo»).
//
// Prima: sul PC del locale tre processi Node (nodo, agente di stampa, agente
// Passepartout), ognuno con il suo .cmd pieno di segreti, la sua attività
// pianificata e un loop «goto» per rialzarsi; aggiornamenti copiando file a
// mano. Adesso: UN servizio di sistema (WinSW su Windows, systemd su Linux,
// launchd su Mac) che lancia questo file, e questo file tiene in vita i tre
// figli, scrive i log a rotazione, impedisce due copie insieme e installa
// le versioni nuove nella finestra notturna, con ritorno automatico alla
// precedente se la nuova non si alza.
//
// Nessuna dipendenza: solo moduli di Node (>= 20), così gira identico sul PC
// Windows di oggi, su un mini PC Linux o su un Mac mini.
//
// Cartella (SYMPOTIA_NODE_ROOT, di default quella di questo file):
//   nodo.json            configurazione (token del nodo, database, agenti)
//   current.txt          la versione in uso (sha)
//   previous.txt         quella di prima, per il ritorno
//   versions/<sha>/      i pacchetti spacchettati (dist, node_modules, …)
//   inbox/               si appoggia qui un pacchetto (.zip o cartella):
//                        si installa da solo nella finestra di manutenzione
//   logs/                un file per processo, a rotazione (5 MB × 3)
//   state/               stato del nodo (certificato, chiavi, lucchetto)
//
// «modo agente» ("modo": "agente" in nodo.json, piano «Passepartout plug
// and play»): per i ristoranti con la sola cassa Passepartout, senza nodo.
// Niente database né token del nodo: un figlio solo, l'agente della cassa
// (pacchetto leggero, scripts/build-agent-bundle.mjs), che scrive il suo
// stato in state/agente.json. Il supervisore chiede al cloud ogni ora se
// c'è una versione nuova per il canale del ristorante, la scarica in inbox/
// verificandone lo sha256 e la installa nella finestra, a cassa ferma;
// se la nuova non si collega al cloud entro 3 minuti torna alla precedente.
//
// Comandi:
//   node supervisor.mjs run            il servizio (default)
//   node supervisor.mjs install        scrive la definizione del servizio
//   node supervisor.mjs check          controlla nodo.json e la versione

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.env.SYMPOTIA_NODE_ROOT || path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = process.env.SYMPOTIA_NODE_CONFIG || path.join(ROOT, 'nodo.json');
const STATE_DIR = path.join(ROOT, 'state');
const LOG_DIR = path.join(ROOT, 'logs');
const VERSIONS_DIR = path.join(ROOT, 'versions');
const INBOX_DIR = path.join(ROOT, 'inbox');
const LOCK_FILE = path.join(STATE_DIR, 'supervisor.lock');
// Lo scrive l'agente della cassa (PP_AGENT_STATE_FILE): collegato o no,
// chiamate in corso, versione.
const AGENT_STATE_FILE = path.join(STATE_DIR, 'agente.json');

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;
const BACKOFF_MAX_MS = 60_000;
const HEALTHY_AFTER_MS = 5 * 60_000;
const UPDATE_CHECK_MS = Math.max(1_000, Number(process.env.SYMPOTIA_UPDATE_CHECK_MS) || 60_000);
const READY_TIMEOUT_MS = Math.max(5_000, Number(process.env.SYMPOTIA_READY_TIMEOUT_MS) || 180_000);
const KEEP_VERSIONS = 3;
// Modo agente: ogni quanto chiedere al cloud se c'è una versione nuova.
const DOWNLOAD_CHECK_MS = Math.max(1_000, Number(process.env.SYMPOTIA_DOWNLOAD_CHECK_MS) || 60 * 60_000);

// --- Log a rotazione ----------------------------------------------------------

const rotatingWriter = (name) => {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${name}.log`);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* nuovo */ }
    const rotate = () => {
        for (let i = LOG_KEEP - 1; i >= 1; i--) {
            const from = i === 1 ? file : `${file}.${i - 1}`;
            try { fs.renameSync(from, `${file}.${i}`); } catch { /* manca: niente da spostare */ }
        }
        size = 0;
    };
    return (chunk) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        try {
            if (size + Buffer.byteLength(text) > LOG_MAX_BYTES) rotate();
            fs.appendFileSync(file, text);
            size += Buffer.byteLength(text);
        } catch { /* disco pieno o permessi: il servizio non deve cadere per un log */ }
    };
};

const supervisorLog = rotatingWriter('supervisor');
const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stdout.write(line);
    supervisorLog(line);
};

// --- Configurazione -----------------------------------------------------------

const readConfig = () => {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
        throw new Error(`configurazione illeggibile (${CONFIG_PATH}): ${err.message}`);
    }
    const modo = raw.modo === 'agente' ? 'agente' : 'nodo';
    for (const key of modo === 'agente' ? ['cloud_url'] : ['cloud_url', 'node_token', 'database_url']) {
        if (typeof raw[key] !== 'string' || !raw[key].trim()) throw new Error(`nodo.json: manca ${key}`);
    }
    if (modo === 'agente' && !raw.passepartout_agent?.env?.PP_AGENT_TOKEN) {
        throw new Error('nodo.json: manca passepartout_agent.env.PP_AGENT_TOKEN (il token dell\'agente)');
    }
    return {
        ...raw,
        modo,
        cloud_url: raw.cloud_url.trim().replace(/\/+$/, ''),
        // In modo agente l'agente della cassa È il servizio.
        passepartout_agent: modo === 'agente' ? { ...raw.passepartout_agent, enabled: true } : raw.passepartout_agent,
        port: Number(raw.port) || 8443,
        update_window: raw.update_window || { from: '04:00', to: '10:00' },
    };
};

// --- Versioni -----------------------------------------------------------------

const readText = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };

/** Lo script dell'agente della cassa in un pacchetto: quello leggero ce
 *  l'ha alla radice, quello del nodo compilato in dist/scripts. */
const agentScript = (dir) => {
    const leggero = path.join(dir, 'passepartout-agent.js');
    return fs.existsSync(leggero) ? leggero : path.join(dir, 'dist', 'scripts', 'passepartout-agent.js');
};

/** Una cartella che il supervisore sa lanciare: col nodo serve il server,
 *  in modo agente basta l'agente della cassa (anche dal pacchetto del nodo). */
const isAppDir = (dir, modo = 'nodo') => (modo === 'agente'
    ? fs.existsSync(agentScript(dir))
    : fs.existsSync(path.join(dir, 'dist', 'server.js')));

/** La cartella dell'app da lanciare. app_dir in nodo.json vince (un checkout
 *  del repo, come prima dei pacchetti); altrimenti versions/<current>. */
const currentAppDir = (cfg) => {
    if (cfg.app_dir) return path.resolve(cfg.app_dir);
    const sha = readText(path.join(ROOT, 'current.txt'));
    if (sha && isAppDir(path.join(VERSIONS_DIR, sha), cfg.modo)) return path.join(VERSIONS_DIR, sha);
    // Prima installazione: se c'è una versione sola, è quella.
    const all = fs.existsSync(VERSIONS_DIR)
        ? fs.readdirSync(VERSIONS_DIR).filter(d => !d.startsWith('_') && isAppDir(path.join(VERSIONS_DIR, d), cfg.modo))
        : [];
    if (all.length === 1) {
        fs.writeFileSync(path.join(ROOT, 'current.txt'), all[0]);
        return path.join(VERSIONS_DIR, all[0]);
    }
    throw new Error('nessuna versione da lanciare: metti un pacchetto in versions/ (o app_dir in nodo.json)');
};

const versionOf = (appDir) => {
    try {
        const sha = JSON.parse(fs.readFileSync(path.join(appDir, 'build-info.json'), 'utf8'))?.sha;
        if (typeof sha === 'string' && sha.trim()) return sha.trim().slice(0, 7);
    } catch { /* checkout senza build-info */ }
    return path.basename(appDir);
};

// --- I figli ------------------------------------------------------------------

const childSpecs = (cfg, appDir) => {
    if (cfg.modo === 'agente') return agentChildSpecs(cfg, appDir);
    const version = cfg.build_sha || versionOf(appDir);
    const pp = cfg.passepartout_agent?.enabled ? cfg.passepartout_agent : null;
    const specs = [{
        name: 'nodo',
        args: [path.join(appDir, 'dist', 'server.js')],
        env: {
            SERVER_PROFILE: 'service-node',
            DATABASE_URL: cfg.database_url,
            SALA_NODE_CLOUD_URL: cfg.cloud_url,
            SALA_NODE_TOKEN: cfg.node_token,
            SALA_NODE_STATE_DIR: STATE_DIR,
            PORT: String(cfg.port),
            BUILD_SHA: version,
            // Fase B5: l'agente Passepartout si collega anche al nodo, con lo
            // stesso token che usa col cloud. Il nodo lo riceve da qui (sta
            // già in questo file), mai dal cloud.
            ...(pp?.env?.PP_AGENT_TOKEN ? { PASSEPARTOUT_AGENT_TOKEN: pp.env.PP_AGENT_TOKEN } : {}),
            ...(cfg.node_env || {}),
        },
    }];
    if (cfg.print_agent?.enabled) {
        specs.push({
            name: 'stampa',
            args: [path.join(appDir, 'scripts', 'print-agent.mjs')],
            env: {
                API_URL: cfg.print_agent.api_url || cfg.cloud_url,
                PRINT_AGENT_TOKEN: cfg.print_agent.token || '',
                NODE_URL: cfg.print_agent.node_url || '',
                ...(cfg.print_agent.env || {}),
            },
        });
    }
    if (pp) {
        specs.push({
            name: 'passepartout',
            args: [path.join(appDir, 'dist', 'scripts', 'passepartout-agent.js')],
            env: {
                // Seconda fonte come l'agente di stampa: dove vivono i conti
                // con l'autorità in sala. Di default lo stesso indirizzo
                // che usa l'agente di stampa.
                PP_AGENT_NODE_URL: pp.node_url || cfg.print_agent?.node_url || '',
                PP_AGENT_STATE_FILE: AGENT_STATE_FILE,
                ...(pp.env || {}),
            },
        });
    }
    return specs.map(s => ({ ...s, cwd: appDir }));
};

/** Modo agente: l'agente della cassa verso il cloud, e l'agente di stampa
 *  solo se il pacchetto ce l'ha (quello leggero no). */
const agentChildSpecs = (cfg, appDir) => {
    const specs = [{
        name: 'passepartout',
        args: [agentScript(appDir)],
        env: {
            PP_AGENT_SERVER_URL: cfg.cloud_url,
            PP_AGENT_STATE_FILE: AGENT_STATE_FILE,
            ...(cfg.passepartout_agent.env || {}),
        },
    }];
    const stampa = path.join(appDir, 'scripts', 'print-agent.mjs');
    if (cfg.print_agent?.enabled && fs.existsSync(stampa)) {
        specs.push({
            name: 'stampa',
            args: [stampa],
            env: { API_URL: cfg.print_agent.api_url || cfg.cloud_url, PRINT_AGENT_TOKEN: cfg.print_agent.token || '', ...(cfg.print_agent.env || {}) },
        });
    }
    return specs.map(s => ({ ...s, cwd: appDir }));
};

class Child {
    constructor(spec) {
        this.spec = spec;
        this.proc = null;
        this.stopping = false;
        this.failures = 0;
        this.startedAt = 0;
        this.timer = null;
        this.write = rotatingWriter(spec.name);
    }

    start() {
        this.stopping = false;
        this.startedAt = Date.now();
        const proc = spawn(process.execPath, this.spec.args, {
            cwd: this.spec.cwd,
            env: { ...process.env, ...this.spec.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.proc = proc;
        proc.stdout.on('data', (d) => this.write(d));
        proc.stderr.on('data', (d) => this.write(d));
        proc.on('error', (err) => log(`${this.spec.name}: avvio fallito (${err.message})`));
        proc.on('exit', (code, signal) => {
            this.proc = null;
            if (this.stopping) return;
            // Un figlio rimasto su a lungo riparte subito; uno che cade in
            // loop aspetta sempre di più, fino a un minuto.
            if (Date.now() - this.startedAt > HEALTHY_AFTER_MS) this.failures = 0;
            const delay = Math.min(BACKOFF_MAX_MS, 1_000 * 2 ** this.failures);
            this.failures += 1;
            log(`${this.spec.name}: uscito (${signal || code}), riparte fra ${Math.round(delay / 1000)} s`);
            this.timer = setTimeout(() => this.start(), delay);
        });
        log(`${this.spec.name}: avviato (pid ${proc.pid})`);
    }

    stop() {
        this.stopping = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        const proc = this.proc;
        if (!proc) return Promise.resolve();
        return new Promise((resolve) => {
            const hard = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* già via */ } }, 10_000);
            proc.once('exit', () => { clearTimeout(hard); resolve(); });
            try { proc.kill('SIGTERM'); } catch { clearTimeout(hard); resolve(); }
        });
    }
}

let children = [];

const startAll = (cfg) => {
    const appDir = currentAppDir(cfg);
    log(`versione in uso: ${versionOf(appDir)} (${appDir})`);
    children = childSpecs(cfg, appDir).map(spec => new Child(spec));
    for (const child of children) child.start();
};

const stopAll = async () => {
    await Promise.all(children.map(c => c.stop()));
    children = [];
};

// --- Lucchetto: mai due supervisori (e quindi due agenti) insieme -------------
// «Mai due agenti verso produzione insieme» era una regola scritta in una
// memoria; adesso la fa rispettare il codice, almeno sulla stessa macchina.

const isAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

const acquireLock = () => {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const other = Number(readText(LOCK_FILE));
    if (other && other !== process.pid && isAlive(other)) {
        throw new Error(`un altro supervisore gira già (pid ${other}): mi fermo`);
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    process.on('exit', () => {
        if (Number(readText(LOCK_FILE)) === process.pid) { try { fs.unlinkSync(LOCK_FILE); } catch { /* già via */ } }
    });
};

// --- Salute del nodo ------------------------------------------------------------

const probe = (url) => new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    // In locale il certificato è per il dominio del nodo, non per 127.0.0.1.
    const req = lib.get(url, { rejectUnauthorized: false, timeout: 3_000 }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
});

const localGet = async (cfg, pathname) => {
    for (const proto of ['https', 'http']) {
        const r = await probe(`${proto}://127.0.0.1:${cfg.port}${pathname}`);
        if (r.status) return r;
    }
    return { status: 0, body: '' };
};

const readAgentState = () => {
    try { return JSON.parse(fs.readFileSync(AGENT_STATE_FILE, 'utf8')); } catch { return null; }
};

/** Col nodo: /ready risponde. In modo agente: la versione `sha` scrive di
 *  essere collegata al cloud, dopo `since`. */
const waitReady = async (cfg, timeoutMs, sha = null, since = Date.now()) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cfg.modo === 'agente') {
            const st = readAgentState();
            if (st?.ok === true && (!sha || st.versione === sha) && Date.parse(st.scritto_at) >= since) return true;
        } else if ((await localGet(cfg, '/ready')).status === 200) return true;
        await new Promise(r => setTimeout(r, cfg.modo === 'agente' ? 1_000 : 2_000));
    }
    return false;
};

// --- Aggiornamenti dalla cartella inbox -----------------------------------------
// Il pacchetto si appoggia in inbox/ (a mano oggi; dal cloud con la fase
// A4b). Si installa SOLO nella finestra (04:00–10:00 di default, ora di
// Roma) e SOLO senza comande o conti aperti; se la versione nuova non
// risponde a /ready entro 3 minuti si torna a quella di prima.

const romeMinutes = () => {
    const parts = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false })
        .formatToParts(new Date());
    const h = Number(parts.find(p => p.type === 'hour')?.value) % 24;
    const m = Number(parts.find(p => p.type === 'minute')?.value);
    return h * 60 + m;
};

const toMinutes = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
};

const inWindow = (win) => {
    const now = romeMinutes();
    const from = toMinutes(win.from);
    const to = toMinutes(win.to);
    return from <= to ? now >= from && now < to : now >= from || now < to;
};

const windowLabel = (win) => `${win.from}–${win.to}`;

const serviceIsQuiet = async (cfg) => {
    if (cfg.modo === 'agente') {
        // Solo una chiamata della cassa in corso, dichiarata da un agente
        // vivo, ferma l'aggiornamento: un agente che non scrive (caduto, in
        // loop) non sta lavorando, e la versione nuova potrebbe sistemarlo.
        const st = readAgentState();
        const fresco = st && Date.now() - Date.parse(st.scritto_at) < 60_000;
        return !fresco || st.in_corso === 0;
    }
    const r = await localGet(cfg, '/sala-node/maintenance-check');
    if (r.status !== 200) return false;
    try {
        const body = JSON.parse(r.body);
        return body.open_orders === 0 && body.open_bills === 0;
    } catch { return false; }
};

const pendingPackages = () => {
    if (!fs.existsSync(INBOX_DIR)) return [];
    return fs.readdirSync(INBOX_DIR)
        .filter(n => !['done', 'rejected'].includes(n) && !n.startsWith('.'))
        .map(n => path.join(INBOX_DIR, n))
        .filter(p => p.endsWith('.zip') || fs.existsSync(path.join(p, 'build-info.json')))
        .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
};

const extractZip = (zip, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    if (process.platform === 'win32') {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]);
    } else {
        execFileSync('unzip', ['-q', '-o', zip, '-d', dest]);
    }
};

/** Porta il pacchetto in versions/<sha>; torna lo sha. */
const stagePackage = (item, modo = 'nodo') => {
    fs.mkdirSync(VERSIONS_DIR, { recursive: true });
    const incoming = path.join(VERSIONS_DIR, `_incoming-${Date.now()}`);
    if (item.endsWith('.zip')) extractZip(item, incoming);
    else fs.cpSync(item, incoming, { recursive: true });
    if (!isAppDir(incoming, modo)) {
        fs.rmSync(incoming, { recursive: true, force: true });
        throw new Error(modo === 'agente' ? 'pacchetto senza l\'agente della cassa' : 'pacchetto senza dist/server.js');
    }
    const sha = versionOf(incoming);
    const target = path.join(VERSIONS_DIR, sha);
    if (fs.existsSync(target)) fs.rmSync(incoming, { recursive: true, force: true });
    else fs.renameSync(incoming, target);
    return sha;
};

const archiveInboxItem = (item, outcome) => {
    const dir = path.join(INBOX_DIR, outcome);
    fs.mkdirSync(dir, { recursive: true });
    try { fs.renameSync(item, path.join(dir, `${Date.now()}-${path.basename(item)}`)); }
    catch { fs.rmSync(item, { recursive: true, force: true }); }
};

const pruneVersions = () => {
    const keep = new Set([readText(path.join(ROOT, 'current.txt')), readText(path.join(ROOT, 'previous.txt'))]);
    const dirs = fs.readdirSync(VERSIONS_DIR)
        .filter(d => !d.startsWith('_') && !keep.has(d))
        .map(d => ({ d, t: fs.statSync(path.join(VERSIONS_DIR, d)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    for (const { d } of dirs.slice(Math.max(0, KEEP_VERSIONS - keep.size))) {
        fs.rmSync(path.join(VERSIONS_DIR, d), { recursive: true, force: true });
    }
};

let updating = false;
let lastSkipLog = 0;

const tryUpdate = async (cfg) => {
    if (updating || cfg.app_dir) return;
    const [item] = pendingPackages();
    if (!item) return;
    const skip = (why) => {
        if (Date.now() - lastSkipLog > 60 * 60_000) {
            lastSkipLog = Date.now();
            log(`aggiornamento in attesa (${path.basename(item)}): ${why}`);
        }
    };
    if (!inWindow(cfg.update_window)) return skip(`fuori finestra ${windowLabel(cfg.update_window)}`);
    if (!(await serviceIsQuiet(cfg))) {
        return skip(cfg.modo === 'agente' ? 'operazioni in corso sulla cassa' : 'comande o conti aperti (o nodo che non risponde)');
    }
    updating = true;
    try {
        const sha = stagePackage(item, cfg.modo);
        const previous = readText(path.join(ROOT, 'current.txt'));
        if (sha === previous) {
            log(`aggiornamento: ${sha} è già in uso`);
            archiveInboxItem(item, 'done');
            return;
        }
        log(`aggiornamento: ${previous || '(nessuna)'} → ${sha}`);
        fs.writeFileSync(path.join(ROOT, 'previous.txt'), previous);
        fs.writeFileSync(path.join(ROOT, 'current.txt'), sha);
        await stopAll();
        const avvio = Date.now();
        startAll(cfg);
        if (await waitReady(cfg, READY_TIMEOUT_MS, sha, avvio)) {
            log(`aggiornamento riuscito: ${sha} risponde`);
            archiveInboxItem(item, 'done');
            pruneVersions();
            return;
        }
        log(`aggiornamento FALLITO: ${sha} ${cfg.modo === 'agente' ? 'non si collega al cloud' : 'non risponde a /ready'}, si torna a ${previous}`);
        fs.writeFileSync(path.join(ROOT, 'current.txt'), previous);
        await stopAll();
        startAll(cfg);
        archiveInboxItem(item, 'rejected');
    } catch (err) {
        log(`aggiornamento non riuscito: ${err.message}`);
        archiveInboxItem(item, 'rejected');
    } finally {
        updating = false;
    }
};

// --- Aggiornamenti dal cloud (modo agente, fase A4b) ---------------------------
// Ogni ora si chiede al cloud, col token dell'agente, se per il canale del
// ristorante c'è una versione diversa da quella in uso. Lo zip si scarica
// in inbox/ (prima in un .part nascosto, che pendingPackages ignora) solo
// se lo sha256 torna con quello annunciato; da lì lo installa tryUpdate,
// nella finestra. Una versione già rifiutata (inbox/rejected) non si
// riscarica: si aspetta la successiva.

let downloading = false;
const refusedLogged = new Set();

const agentToken = (cfg) => String(cfg.passepartout_agent?.env?.PP_AGENT_TOKEN || '').trim();

const wasRejected = (sha) => {
    const dir = path.join(INBOX_DIR, 'rejected');
    return fs.existsSync(dir) && fs.readdirSync(dir).some(n => n.endsWith(`-sympotia-agente-${sha}.zip`));
};

const checkCloudUpdate = async (cfg) => {
    if (downloading || cfg.app_dir || cfg.aggiornamenti === 'manuali') return;
    downloading = true;
    try {
        const auth = { Authorization: `Bearer ${agentToken(cfg)}` };
        const current = readText(path.join(ROOT, 'current.txt'));
        const res = await fetch(`${cfg.cloud_url}/pp-agent/aggiornamento?ho=${encodeURIComponent(current)}`, {
            headers: auth, signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 204) return;
        if (!res.ok) { log(`controllo aggiornamenti: HTTP ${res.status}`); return; }
        const rel = await res.json();
        if (!/^[0-9a-f]{7,40}$/.test(String(rel?.sha)) || !/^[0-9a-f]{64}$/.test(String(rel?.sha256)) || typeof rel?.url !== 'string') {
            log('controllo aggiornamenti: risposta non valida');
            return;
        }
        const name = `sympotia-agente-${rel.sha}.zip`;
        if (rel.sha === current || fs.existsSync(path.join(INBOX_DIR, name))) return;
        if (wasRejected(rel.sha)) {
            if (!refusedLogged.has(rel.sha)) { refusedLogged.add(rel.sha); log(`aggiornamento ${rel.sha} già rifiutato una volta: non lo riscarico`); }
            return;
        }
        const dl = await fetch(new URL(rel.url, `${cfg.cloud_url}/`), { headers: auth, signal: AbortSignal.timeout(5 * 60_000) });
        if (!dl.ok) { log(`scaricamento di ${rel.sha}: HTTP ${dl.status}`); return; }
        const bytes = Buffer.from(await dl.arrayBuffer());
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== rel.sha256) {
            log(`scaricamento di ${rel.sha}: sha256 diverso da quello annunciato, scartato`);
            return;
        }
        fs.mkdirSync(INBOX_DIR, { recursive: true });
        const part = path.join(INBOX_DIR, `.${name}.part`);
        fs.writeFileSync(part, bytes);
        fs.renameSync(part, path.join(INBOX_DIR, name));
        log(`scaricato ${rel.sha} (${Math.round(bytes.length / 1024)} KB, canale ${rel.canale ?? '?'}): si installa nella finestra ${windowLabel(cfg.update_window)}`);
    } catch (err) {
        log(`controllo aggiornamenti non riuscito: ${err.message}`);
    } finally {
        downloading = false;
    }
};

// --- Comandi ----------------------------------------------------------------------

const run = async () => {
    const cfg = readConfig();
    acquireLock();
    log(`supervisore avviato (pid ${process.pid}, cartella ${ROOT}, modo ${cfg.modo})`);
    startAll(cfg);
    const timer = setInterval(() => { void tryUpdate(cfg); }, UPDATE_CHECK_MS);
    // Il primo controllo poco dopo l'avvio, poi ogni ora.
    const cloudTimers = [];
    if (cfg.modo === 'agente') {
        cloudTimers.push(setTimeout(() => { void checkCloudUpdate(cfg); }, Math.min(60_000, DOWNLOAD_CHECK_MS)));
        cloudTimers.push(setInterval(() => { void checkCloudUpdate(cfg); }, DOWNLOAD_CHECK_MS));
    }
    const shutdown = async (signal) => {
        log(`arresto (${signal})`);
        clearInterval(timer);
        for (const t of cloudTimers) clearTimeout(t);
        await stopAll();
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
};

// Il servizio ha un nome suo in modo agente: sullo stesso PC non si
// confonde col nodo di sala.
const serviceNames = () => {
    let modo = 'nodo';
    try { modo = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))?.modo === 'agente' ? 'agente' : 'nodo'; } catch { /* senza config: nodo */ }
    return modo === 'agente'
        ? { modo, id: 'sympotia-cassa', label: 'com.sympotia.cassa', name: 'Sympotia - agente della cassa', description: 'Agente della cassa Passepartout, con aggiornamenti dal cloud (supervisore).' }
        : { modo, id: 'sympotia-nodo', label: 'com.sympotia.nodo', name: 'Sympotia - nodo di sala', description: 'Nodo di sala, agente di stampa e agente Passepartout (supervisore unico).' };
};

const install = () => {
    const node = process.execPath;
    const self = path.join(ROOT, 'supervisor.mjs');
    const svc = serviceNames();
    if (path.resolve(fileURLToPath(import.meta.url)) !== self) {
        fs.copyFileSync(fileURLToPath(import.meta.url), self);
    }
    if (process.platform === 'win32') {
        const xml = `<service>
  <id>${svc.id}</id>
  <name>${svc.name}</name>
  <description>${svc.description}</description>
  <executable>${node}</executable>
  <arguments>"${self}" run</arguments>
  <workingdirectory>${ROOT}</workingdirectory>
  <startmode>Automatic</startmode>
  <delayedAutoStart>false</delayedAutoStart>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>20 sec</stoptimeout>
  <log mode="roll-by-size"><sizeThreshold>5120</sizeThreshold><keepFiles>3</keepFiles></log>
  <env name="SYMPOTIA_NODE_ROOT" value="${ROOT}"/>
</service>
`;
        fs.writeFileSync(path.join(ROOT, `${svc.id}.xml`), xml);
        console.log(`Scritto ${path.join(ROOT, `${svc.id}.xml`)}.
1. Scarica WinSW-x64.exe (github.com/winsw/winsw/releases) e salvalo come
   ${path.join(ROOT, `${svc.id}.exe`)}
2. PowerShell da amministratore:
   cd "${ROOT}"
   .\\${svc.id}.exe install
   .\\${svc.id}.exe start
3. ${svc.modo === 'agente' ? 'Disattiva la vecchia attività pianificata dell\'agente Passepartout.' : 'Disattiva le vecchie attività pianificate (nodo, stampa, Passepartout).'}`);
        return;
    }
    if (process.platform === 'darwin') {
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${svc.label}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${self}</string><string>run</string></array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key><dict><key>SYMPOTIA_NODE_ROOT</key><string>${ROOT}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
        fs.writeFileSync(path.join(ROOT, `${svc.label}.plist`), plist);
        console.log(`Scritto ${path.join(ROOT, `${svc.label}.plist`)}.
  sudo cp "${path.join(ROOT, `${svc.label}.plist`)}" /Library/LaunchDaemons/
  sudo launchctl bootstrap system /Library/LaunchDaemons/${svc.label}.plist
  sudo pmset -a sleep 0 autorestart 1`);
        return;
    }
    const unit = `[Unit]
Description=${svc.name} (supervisore)
After=network-online.target${svc.modo === 'agente' ? '' : ' postgresql.service'}
Wants=network-online.target

[Service]
ExecStart=${node} ${self} run
WorkingDirectory=${ROOT}
Environment=SYMPOTIA_NODE_ROOT=${ROOT}
Restart=always
RestartSec=10
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
`;
    fs.writeFileSync(path.join(ROOT, `${svc.id}.service`), unit);
    console.log(`Scritto ${path.join(ROOT, `${svc.id}.service`)}.
  sudo cp "${path.join(ROOT, `${svc.id}.service`)}" /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now ${svc.id}`);
};

const check = () => {
    const cfg = readConfig();
    const appDir = currentAppDir(cfg);
    console.log(`configurazione ok (${CONFIG_PATH}), modo ${cfg.modo}`);
    console.log(`versione: ${versionOf(appDir)} (${appDir})`);
    console.log(`processi: ${childSpecs(cfg, appDir).map(s => s.name).join(', ')}`);
    console.log(`finestra aggiornamenti: ${windowLabel(cfg.update_window)} (ora di Roma)`);
    if (cfg.modo === 'agente') console.log(`aggiornamenti dal cloud: ${cfg.aggiornamenti === 'manuali' ? 'spenti' : `ogni ${Math.round(DOWNLOAD_CHECK_MS / 60_000)} min da ${cfg.cloud_url}`}`);
};

const command = process.argv[2] || 'run';
try {
    if (command === 'install') install();
    else if (command === 'check') check();
    else if (command === 'run') await run();
    else { console.error(`comando sconosciuto: ${command} (run | install | check)`); process.exit(2); }
} catch (err) {
    log(`errore: ${err.message}`);
    process.exit(1);
}
