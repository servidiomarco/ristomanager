import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Collaudo della scopatura tenant delle tabelle residue (Fase B3.7):
// activity_logs, notifications, ai_knowledge_entries, dev_board_cards e le
// proposte dell'agente WhatsApp (PR #162). Non si rifà il collaudo funzionale
// dei singoli moduli: si verifica che le rotte rispondano con le query
// scopate e che l'audit registri davvero il login appena fatto.

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('tabelle residue per tenant', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
    });

    it('il log attività elenca il LOGIN appena eseguito', async () => {
        // La scrittura del log di login è fire-and-forget: si riprova per
        // qualche istante invece di assumere che sia già atterrata.
        let loginRow: any;
        for (let i = 0; i < 10 && !loginRow; i++) {
            const res = await api()
                .get('/activity-logs')
                .query({ action: 'LOGIN' })
                .set(bearer(token));
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.logs)).toBe(true);
            loginRow = res.body.logs.find(
                (l: any) => l.action === 'LOGIN' && l.user_email === process.env.TEST_OWNER_EMAIL
            );
            if (!loginRow) await sleep(200);
        }
        expect(loginRow).toBeTruthy();
    });

    it('le statistiche del log rispondono scopate', async () => {
        const res = await api().get('/activity-logs/stats').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.total_logs).toBeGreaterThanOrEqual(1);
        expect(res.body.logs_by_action.LOGIN).toBeGreaterThanOrEqual(1);
    });

    it('il centro notifiche risponde con la lista scopata', async () => {
        const lista = await api().get('/notifications').set(bearer(token));
        expect(lista.status).toBe(200);
        expect(Array.isArray(lista.body.notifications)).toBe(true);

        const count = await api().get('/notifications/unread-count').set(bearer(token));
        expect(count.status).toBe(200);
        expect(typeof count.body.count).toBe('number');
    });

    it('le regole della casa (ai-knowledge) rispondono scopate', async () => {
        const res = await api().get('/settings/ai-knowledge').set(bearer(token));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.entries)).toBe(true);
    });

    it('una proposta agente inesistente fa 404 (fetch scopato sul tenant)', async () => {
        // PR #162: la confirm cerca la proposta con tenant nel WHERE — un id
        // estraneo o inesistente deve morire lì, prima di ogni scrittura.
        const res = await api()
            .post('/messages/agent/proposals/99999999/confirm')
            .set(bearer(token));
        expect(res.status).toBe(404);
    });
});
