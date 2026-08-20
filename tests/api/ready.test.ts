import { describe, it, expect } from 'vitest';
import { api } from './helpers';

// /ready è la readiness vera: 200 solo a migrazioni completate e DB
// raggiungibile. /health risponde 200 appena la listen è su (anche a schema
// assente) — è la trappola storica documentata in CLAUDE.md, e la ragione
// per cui l'healthcheck Railway punta a /ready.
//
// Il globalSetup aspetta il login dell'owner, che diventa possibile DOPO
// createSchema ma potenzialmente PRIMA della fine delle migration: qui si
// attende /ready con un poll, non si assume.
describe('readiness', () => {
    it('/ready arriva a 200 con ready: true dopo il boot', async () => {
        const scadenza = Date.now() + 60_000;
        let ultimo: { status: number; body: any } | null = null;
        while (Date.now() < scadenza) {
            const res = await api().get('/ready');
            ultimo = { status: res.status, body: res.body };
            if (res.status === 200) break;
            await new Promise(r => setTimeout(r, 1000));
        }
        expect(ultimo?.status).toBe(200);
        expect(ultimo?.body).toEqual({ ready: true });
    });

    it('/health resta il liveness senza pretese di readiness', async () => {
        const res = await api().get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });
});
