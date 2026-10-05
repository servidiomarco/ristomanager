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
// Comandi:
//   node supervisor.mjs run            il servizio (default)
//   node supervisor.mjs install        scrive la definizione del servizio
//   node supervisor.mjs check          controlla nodo.json e la versione

import { spawn, execFileSync } from 'node:child_process';
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

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;
const BACKOFF_MAX_MS = 60_000;
const HEALTHY_AFTER_MS = 5 * 60_000;
const UPDATE_CHECK_MS = Math.max(1_000, Number(process.env.SYMPOTIA_UPDATE_CHECK_MS) || 60_000);
const READY_TIMEOUT_MS = Math.max(5_000, Number(process.env.SYMPOTIA_READY_TIMEOUT_MS) || 180_000);
const KEEP_VERSIONS = 3;

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
    for (const key of ['cloud_url', 'node_token', 'database_url']) {
        if (typeof raw[key] !== 'string' || !raw[key].trim()) throw new Error(`nodo.json: manca ${key}`);
    }
    return {
        ...raw,
        port: Number(raw.port) || 8443,
        update_window: raw.update_window || { from: '04:00', to: '10:00' },
    };
};

// --- Versioni -----------------------------------------------------------------

const readText = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };

const isAppDir = (dir) => fs.existsSync(path.join(dir, 'dist', 'server.js'));

/** La cartella dell'app da lanciare. app_dir in nodo.json vince (un checkout
 *  del repo, come prima dei pacchetti); altrimenti versions/<current>. */
const currentAppDir = (cfg) => {
    if (cfg.app_dir) return path.resolve(cfg.app_dir);
    const sha = readText(path.join(ROOT, 'current.txt'));
    if (sha && isAppDir(path.join(VERSIONS_DIR, sha))) return path.join(VERSIONS_DIR, sha);
    // Prima installazione: se c'è una versione sola, è quella.
    const all = fs.existsSync(VERSIONS_DIR) ? fs.readdirSync(VERSIONS_DIR).filter(d => isAppDir(path.join(VERSIONS_DIR, d))) : [];
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
    const version = cfg.build_sha || versionOf(appDir);
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
    if (cfg.passepartout_agent?.enabled) {
        specs.push({
            name: 'passepartout',
            args: [path.join(appDir, 'dist', 'scripts', 'passepartout-agent.js')],
            env: { ...(cfg.passepartout_agent.env || {}) },
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

const waitReady = async (cfg, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if ((await localGet(cfg, '/ready')).status === 200) return true;
        await new Promise(r => setTimeout(r, 2_000));
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

const serviceIsQuiet = async (cfg) => {
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
const stagePackage = (item) => {
    fs.mkdirSync(VERSIONS_DIR, { recursive: true });
    const incoming = path.join(VERSIONS_DIR, `_incoming-${Date.now()}`);
    if (item.endsWith('.zip')) extractZip(item, incoming);
    else fs.cpSync(item, incoming, { recursive: true });
    if (!isAppDir(incoming)) {
        fs.rmSync(incoming, { recursive: true, force: true });
        throw new Error('pacchetto senza dist/server.js');
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
    if (!inWindow(cfg.update_window)) return skip(`fuori finestra ${cfg.update_window.from}–${cfg.update_window.to}`);
    if (!(await serviceIsQuiet(cfg))) return skip('comande o conti aperti (o nodo che non risponde)');
    updating = true;
    try {
        const sha = stagePackage(item);
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
        startAll(cfg);
        if (await waitReady(cfg, READY_TIMEOUT_MS)) {
            log(`aggiornamento riuscito: ${sha} risponde`);
            archiveInboxItem(item, 'done');
            pruneVersions();
            return;
        }
        log(`aggiornamento FALLITO: ${sha} non risponde a /ready, si torna a ${previous}`);
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

// --- Comandi ----------------------------------------------------------------------

const run = async () => {
    const cfg = readConfig();
    acquireLock();
    log(`supervisore avviato (pid ${process.pid}, cartella ${ROOT})`);
    startAll(cfg);
    const timer = setInterval(() => { void tryUpdate(cfg); }, UPDATE_CHECK_MS);
    const shutdown = async (signal) => {
        log(`arresto (${signal})`);
        clearInterval(timer);
        await stopAll();
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
};

const install = () => {
    const node = process.execPath;
    const self = path.join(ROOT, 'supervisor.mjs');
    if (path.resolve(fileURLToPath(import.meta.url)) !== self) {
        fs.copyFileSync(fileURLToPath(import.meta.url), self);
    }
    if (process.platform === 'win32') {
        const xml = `<service>
  <id>sympotia-nodo</id>
  <name>Sympotia - nodo di sala</name>
  <description>Nodo di sala, agente di stampa e agente Passepartout (supervisore unico).</description>
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
        fs.writeFileSync(path.join(ROOT, 'sympotia-nodo.xml'), xml);
        console.log(`Scritto ${path.join(ROOT, 'sympotia-nodo.xml')}.
1. Scarica WinSW-x64.exe (github.com/winsw/winsw/releases) e salvalo come
   ${path.join(ROOT, 'sympotia-nodo.exe')}
2. PowerShell da amministratore:
   cd "${ROOT}"
   .\\sympotia-nodo.exe install
   .\\sympotia-nodo.exe start
3. Disattiva le vecchie attività pianificate (nodo, stampa, Passepartout).`);
        return;
    }
    if (process.platform === 'darwin') {
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sympotia.nodo</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${self}</string><string>run</string></array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key><dict><key>SYMPOTIA_NODE_ROOT</key><string>${ROOT}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
        fs.writeFileSync(path.join(ROOT, 'com.sympotia.nodo.plist'), plist);
        console.log(`Scritto ${path.join(ROOT, 'com.sympotia.nodo.plist')}.
  sudo cp "${path.join(ROOT, 'com.sympotia.nodo.plist')}" /Library/LaunchDaemons/
  sudo launchctl bootstrap system /Library/LaunchDaemons/com.sympotia.nodo.plist
  sudo pmset -a sleep 0 autorestart 1`);
        return;
    }
    const unit = `[Unit]
Description=Sympotia - nodo di sala (supervisore)
After=network-online.target postgresql.service
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
    fs.writeFileSync(path.join(ROOT, 'sympotia-nodo.service'), unit);
    console.log(`Scritto ${path.join(ROOT, 'sympotia-nodo.service')}.
  sudo cp "${path.join(ROOT, 'sympotia-nodo.service')}" /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now sympotia-nodo`);
};

const check = () => {
    const cfg = readConfig();
    const appDir = currentAppDir(cfg);
    console.log(`configurazione ok (${CONFIG_PATH})`);
    console.log(`versione: ${versionOf(appDir)} (${appDir})`);
    console.log(`processi: ${childSpecs(cfg, appDir).map(s => s.name).join(', ')}`);
    console.log(`finestra aggiornamenti: ${cfg.update_window.from}–${cfg.update_window.to} (ora di Roma)`);
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
