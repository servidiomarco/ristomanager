import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { api } from './helpers';

// Fase 2a della tappa 4: la stessa codebase, due topologie. Un secondo
// processo di dist/server.js con SERVER_PROFILE=service-node deve rifiutare
// il mondo inbound (webhook, pagine pubbliche, /pay) con un 503 esplicito,
// mentre il server condiviso dei test — profilo cloud — continua a servirlo.
// Il middleware di profilo non tocca il DB, quindi basta /health come
// readiness (stesso pattern del test provisioning).

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

describe('profilo service-node', () => {
    let child: ChildProcess | null = null;
    let base = '';

    beforeAll(async () => {
        const distServer = path.resolve('dist/server.js');
        expect(existsSync(distServer)).toBe(true);
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const port = await freePort();
        base = `http://127.0.0.1:${port}`;
        const env = {
            ...process.env,
            DATABASE_URL: dbUrl,
            PORT: String(port),
            SERVER_PROFILE: 'service-node',
            JWT_SECRET: 'test-jwt-secret',
            JWT_REFRESH_SECRET: 'test-jwt-refresh-secret',
        };
        child = spawn('node', [distServer], { env, stdio: 'ignore' });
        const deadline = Date.now() + 20_000;
        for (;;) {
            if (child.exitCode !== null) throw new Error(`Nodo di prova uscito subito (exit ${child.exitCode})`);
            try {
                const res = await fetch(`${base}/health`);
                if (res.status === 200) break;
            } catch { /* non ancora in ascolto */ }
            if (Date.now() > deadline) throw new Error('Nodo di prova non pronto entro 20s');
            await sleep(250);
        }
    }, 30_000);

    afterAll(() => {
        child?.kill('SIGKILL');
    });

    it('i webhook dei provider rispondono 503 profile_not_served', async () => {
        const res = await fetch(`${base}/webhook/twilio-whatsapp`, { method: 'POST' });
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.error).toBe('profile_not_served');
        expect(body.profile).toBe('service-node');
    });

    it('le API pubbliche e il conto ospite non sono serviti', async () => {
        for (const path_ of ['/public/contact', '/pay/un-token-qualunque', '/prenota', '/ordina']) {
            const res = await fetch(`${base}${path_}`);
            expect(res.status, path_).toBe(503);
            const body = await res.json();
            expect(body.error, path_).toBe('profile_not_served');
        }
    });

    it("'/payments' (cassa, dominio servizio) NON è catturato dal prefisso '/pay/'", async () => {
        // Senza token deve essere il solito 401 dell'authenticate, non il 503
        // del profilo: la route esiste ed è servita.
        const res = await fetch(`${base}/payments`);
        expect(res.status).toBe(401);
    });

    it('/health resta vivo sul nodo, e il profilo cloud continua a servire il pubblico', async () => {
        const health = await fetch(`${base}/health`);
        expect(health.status).toBe(200);
        // /healthz è la sonda del circuito client: DEVE esserci su entrambi
        // i profili (trovato al collaudo: senza, il circuito non si richiude
        // mai e le letture non tornano sul nodo).
        const healthz = await fetch(`${base}/healthz`);
        expect(healthz.status).toBe(200);
        expect((await healthz.json()).profile).toBe('service-node');
        const cloudHealthz = await api().get('/healthz');
        expect(cloudHealthz.status).toBe(200);
        // Il server condiviso dei test (profilo cloud) serve /public/contact.
        const cloud = await api().get('/public/contact');
        expect(cloud.status).toBe(200);
    });
});
