// Setup globale dei test API: azzera il database di test, avvia il server
// compilato (dist/server.js, lo stesso artefatto che gira su Railway) e
// aspetta che sia davvero pronto prima di far partire i test.
//
// Il database indicato da DATABASE_URL viene DROPPATO e ricreato a ogni run:
// per questo il setup rifiuta qualunque host non locale — la stessa guardia
// degli script in scripts/ (dev-comande.sh, test-locale.sh).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const OWNER_EMAIL = 'admin@ristomanager.com';
const OWNER_PASSWORD = 'test-owner-password';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export default async function globalSetup(): Promise<() => Promise<void>> {
    const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
    const url = new URL(dbUrl);
    if (!['localhost', '127.0.0.1', '::1', ''].includes(url.hostname)) {
        throw new Error(
            `DATABASE_URL punta a un host remoto (${url.hostname}): i test API droppano il database, solo localhost è ammesso.`
        );
    }
    const dbName = url.pathname.replace(/^\//, '');
    if (!dbName || dbName === 'postgres') {
        throw new Error('Usa un database dedicato ai test (es. ristotest_api), non quello di manutenzione.');
    }

    // Reset: si passa dal database di manutenzione perché non si può droppare
    // il database a cui si è connessi. WITH (FORCE) stacca eventuali sessioni
    // rimaste appese da una run interrotta.
    const adminUrl = new URL(dbUrl);
    adminUrl.pathname = '/postgres';
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.query(`CREATE DATABASE "${dbName}"`);
    } finally {
        await admin.end();
    }

    // Modalità certificazione RLS rigida (TEST_STRICT_RLS=1, opzionale): il
    // SERVER dei test gira con un ruolo non-superuser che ha app.rls_strict
    // acceso a livello di ruolo — l'intera suite diventa la prova che ogni
    // percorso dell'app dichiara il proprio contesto. I client diretti dei
    // singoli file restano superuser (seed e cleanup non c'entrano con la
    // policy). In CI resta spenta: è una prova da lanciare deliberatamente.
    let serverDbUrl = dbUrl;
    if (process.env.TEST_STRICT_RLS === '1') {
        const ROLE = 'app_test_rls';
        const admin2 = new Client({ connectionString: dbUrl });
        await admin2.connect();
        try {
            await admin2.query(`DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
                    CREATE ROLE ${ROLE} LOGIN;
                END IF;
            END $$`);
            await admin2.query(`ALTER ROLE ${ROLE} LOGIN PASSWORD '${ROLE}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
            await admin2.query(`ALTER ROLE ${ROLE} SET app.rls_strict = 'on'`);
            await admin2.query(`GRANT CREATE, CONNECT, TEMP ON DATABASE "${dbName}" TO ${ROLE}`);
            await admin2.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${ROLE}`);
        } finally {
            await admin2.end();
        }
        const roleUrl = new URL(dbUrl);
        roleUrl.username = ROLE;
        roleUrl.password = ROLE;
        serverDbUrl = roleUrl.toString();
        console.log('[globalSetup] TEST_STRICT_RLS=1: server con ruolo non-superuser e RLS rigida accesa');
    }

    const distServer = path.resolve('dist/server.js');
    if (!existsSync(distServer)) {
        throw new Error('dist/server.js mancante: `npm test` compila prima il server (npm run build:server).');
    }

    const port = Number(process.env.TEST_API_PORT || 3199);
    const child: ChildProcess = spawn('node', [distServer], {
        env: {
            ...process.env,
            DATABASE_URL: serverDbUrl,
            PORT: String(port),
            JWT_SECRET: 'test-jwt-secret',
            // La suite fa più POST pubblici al minuto dallo stesso IP di
            // quanti il limiter di produzione ne conceda (5).
            PUBLIC_BOOKING_RATE_LIMIT: '1000',
            JWT_REFRESH_SECRET: 'test-jwt-refresh-secret',
            DEFAULT_OWNER_PASSWORD: OWNER_PASSWORD,
            // Gate degli endpoint /admin/tenants (Fase D1): senza questo i
            // test di provisioning riceverebbero solo 503.
            PLATFORM_ADMIN_TOKEN: 'test-platform-token',
            // Coda di stampa: il legacy token fa da alias del tenant 1, così
            // i test possono ritirare i job (RT fiscale incluso) e ackarli.
            PRINT_AGENT_TOKEN: 'test-print-agent-token',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bootLog = '';
    child.stdout?.on('data', d => { bootLog += d; });
    child.stderr?.on('data', d => { bootLog += d; });

    // /health risponde 200 prima ancora che lo schema esista (createSchema gira
    // in background dopo la listen), quindi non è un readiness probe. Il login
    // del seed owner invece verifica in un colpo solo che lo schema c'è, che il
    // seed è passato e che role_permissions è popolata.
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    for (;;) {
        if (child.exitCode !== null) {
            throw new Error(`Il server è morto al boot (exit ${child.exitCode}):\n${bootLog}`);
        }
        try {
            const res = await fetch(`${baseUrl}/auth/login`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
            });
            if (res.status === 200) break;
        } catch {
            // server non ancora in ascolto
        }
        if (Date.now() > deadline) {
            child.kill('SIGKILL');
            throw new Error(`Server non pronto entro 90s. Log di boot:\n${bootLog}`);
        }
        await sleep(500);
    }

    // I worker di test (pool 'forks') ereditano l'ambiente da questo processo.
    process.env.TEST_BASE_URL = baseUrl;
    process.env.TEST_OWNER_EMAIL = OWNER_EMAIL;
    process.env.TEST_OWNER_PASSWORD = OWNER_PASSWORD;

    return async () => {
        child.kill('SIGTERM');
        const forceKill = setTimeout(() => child.kill('SIGKILL'), 3_000);
        await new Promise<void>(resolve => {
            child.once('exit', () => { clearTimeout(forceKill); resolve(); });
            setTimeout(resolve, 5_000);
        });
    };
}
