// Setup globale dei test API: azzera il database di test, avvia il server
// compilato (dist/server.js, lo stesso artefatto che gira su Railway) e
// aspetta che sia davvero pronto prima di far partire i test.
//
// Il database indicato da DATABASE_URL viene DROPPATO e ricreato a ogni run:
// per questo il setup rifiuta qualunque host non locale — la stessa guardia
// degli script in scripts/ (dev-comande.sh, test-locale.sh).
import { generateKeyPairSync } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
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
    // policy). In CI gira in un job suo, «Test API (RLS rigida)», accanto a
    // quello normale.
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

    // Niente Cloudflare né Let's Encrypt veri dai test (revisione audit
    // H-05, 25/09). I test del nodo di sala ora passano APPOSTA tutti i
    // controlli e contano solo sull'assenza del token per fermarsi al 503:
    // con CLOUDFLARE_API_TOKEN esportato nella shell (è la variabile che
    // legge wrangler) avrebbero scritto record veri in sympotia.com ed
    // emesso certificati veri, anche per il nome vivo del Frantoio.
    // Scritto in process.env e non solo nell'env del server: lo ereditano
    // anche i worker di vitest e i server che i singoli file avviano.
    // Stringa vuota e non delete: dotenv non tocca una chiave già presente,
    // quindi nemmeno un .env locale col token lo riaccende nel server.
    process.env.CLOUDFLARE_API_TOKEN = '';
    process.env.ACME_STAGING = '1';

    // La chiave privata ES256 della suite: la genera il setup (non il
    // server) così i test possono coniare token che il server non darebbe
    // mai — scaduti da ore, di un altro tenant — per provare la proroga del
    // nodo di sala a linea giù (fase A2). In process.env la leggono i worker.
    process.env.TEST_JWT_ES256_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    const port = Number(process.env.TEST_API_PORT || 3199);
    const child: ChildProcess = spawn('node', [distServer], {
        env: {
            ...process.env,
            DATABASE_URL: serverDbUrl,
            PORT: String(port),
            JWT_SECRET: 'test-jwt-secret',
            // Tutta la suite firma gli access token ES256 (fase A1): i nodi
            // di prova li verificano con la sola chiave pubblica.
            JWT_SIGN_ES256: '1',
            JWT_ES256_PRIVATE_KEY: process.env.TEST_JWT_ES256_PRIVATE_KEY,
            // La suite fa più POST pubblici al minuto dallo stesso IP di
            // quanti il limiter di produzione ne conceda (5).
            PUBLIC_BOOKING_RATE_LIMIT: '1000',
            PUBLIC_ORDER_RATE_LIMIT: '1000',
            // Avviso «cambio turno»: in produzione aspetta che la griglia
            // smetta di scrivere (20 s); nei test basta un attimo.
            SHIFT_CHANGE_NOTIFY_DELAY_MS: '300',
            JWT_REFRESH_SECRET: 'test-jwt-refresh-secret',
            // Telefono (Fase 2): i webhook voce verificano la firma Twilio, e
            // register-call va a uno stub locale che il test della voce
            // accende da sé (porta del server + 11). Il controllo «Sofia
            // muta» aspetta mezzo secondo invece di tre minuti.
            TWILIO_AUTH_TOKEN: 'test-twilio-auth-token',
            SOFIA_REGISTER_CALL_URL: `http://127.0.0.1:${port + 11}/register-call`,
            SOFIA_SILENT_CHECK_MS: '500',
            // Softphone (Fase 3): token firmati con una API key finta. Con il
            // solo SID dell'account WhatsApp e SMS restano spenti: servono
            // anche il mittente o il messaging service.
            TWILIO_ACCOUNT_SID: 'ACtest00000000000000000000000000',
            TWILIO_API_KEY_SID: 'SKtest00000000000000000000000000',
            TWILIO_API_KEY_SECRET: 'test-api-key-secret',
            TWILIO_TWIML_APP_SID: 'APtest00000000000000000000000000',
            // Cordless (Fase 4): dominio SIP finto, e le API REST di Twilio
            // (credenziali SIP) su uno stub che il test del cordless accende
            // da sé alla porta del server + 12.
            TWILIO_SIP_DOMAIN: 'sympotia-test.sip.twilio.com',
            TWILIO_SIP_CREDENTIAL_LIST_SID: 'CLtest00000000000000000000000000',
            TWILIO_REST_URL: `http://127.0.0.1:${port + 12}`,
            DEFAULT_OWNER_PASSWORD: OWNER_PASSWORD,
            // Gate degli endpoint /admin/tenants (Fase D1): senza questo i
            // test di provisioning riceverebbero solo 503.
            PLATFORM_ADMIN_TOKEN: 'test-platform-token',
            // Il token della CI che carica i rilasci dell'agente: apre solo
            // POST /admin/agent-releases.
            AGENT_RELEASE_TOKEN: 'test-agent-release-token',
            // Coda di stampa: il legacy token fa da alias del tenant 1, così
            // i test possono ritirare i job (RT fiscale incluso) e ackarli.
            PRINT_AGENT_TOKEN: 'test-print-agent-token',
            // Agente Passepartout (fase B5): il ponte acceso, chiusura in
            // cassa configurata e spazzino veloce. Senza agente collegato le
            // rotte che lo usano rispondono 503 come prima.
            PASSEPARTOUT_AGENT_TOKEN: 'test-pp-agent-token',
            PASSEPARTOUT_TIPO_PAGAMENTO: 'ESTERNO',
            PASSEPARTOUT_CLOSE_SWEEP_MS: '300',
            PASSEPARTOUT_CLOSE_RETRY_UNIT_MS: '300',
            // Il giro delle prenotazioni in cassa lo lanciano i test con
            // «Sincronizza ora»: quello periodico non deve intromettersi.
            PASSEPARTOUT_PREN_SWEEP_MS: '3600000',
            PASSEPARTOUT_CONTI_SWEEP_MS: '3600000',
            PASSEPARTOUT_TAVOLI_SWEEP_MS: '3600000',
            PASSEPARTOUT_SPECCHIO_SWEEP_MS: '3600000',
            // Le comande vive le spingono le rotte delle comande, nei test.
            PASSEPARTOUT_COMANDE_VIVE_SWEEP_MS: '3600000',
            // La stampa di ripiego della comanda viva (fase 3): nei test dopo mezzo secondo.
            PASSEPARTOUT_COMANDE_VIVE_RIPIEGO_MS: '500',
            // Le comande chiuse in cassa: nei test si guarda a ogni giro.
            PASSEPARTOUT_COMANDE_VIVE_CHIUSE_MS: '1',
            // Il flag del token storico si rilegge a ogni handshake: il test
            // dell'abbinamento lo spegne e lo riaccende per i file dopo.
            PP_TOKEN_STORICO_TTL_MS: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bootLog = '';
    child.stdout?.on('data', d => { bootLog += d; });
    child.stderr?.on('data', d => { bootLog += d; });
    // TEST_SERVER_LOG=<file>: tutto il log del server su file, per capire un
    // test che fallisce lato cloud (senza, si vede solo il log di boot).
    if (process.env.TEST_SERVER_LOG) {
        const out = createWriteStream(process.env.TEST_SERVER_LOG);
        child.stdout?.pipe(out);
        child.stderr?.pipe(out);
    }

    // /health risponde 200 prima ancora che lo schema esista (createSchema gira
    // in background dopo la listen), quindi non è un readiness probe. Serve
    // /ready (migration finite) E il login del seed owner: il login da solo
    // passa appena l'owner esiste, mentre createSchema sta ancora seminando
    // role_permissions — il primo test leggeva una matrice a metà e la
    // cache la teneva per 5 minuti (403 su POST /rooms, CI del 09/10).
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    for (;;) {
        if (child.exitCode !== null) {
            throw new Error(`Il server è morto al boot (exit ${child.exitCode}):\n${bootLog}`);
        }
        try {
            const ready = await fetch(`${baseUrl}/ready`);
            if (ready.status === 200) {
                const res = await fetch(`${baseUrl}/auth/login`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
                });
                if (res.status === 200) break;
            }
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
