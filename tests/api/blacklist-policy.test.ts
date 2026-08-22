import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Card #27, seguito — il comportamento della blacklist è una policy per
// tenant, fonte per fonte, non più una scelta hardcoded. Questo file gira
// PRIMA di clienti.test.ts (ordine alfabetico) e alla fine ripristina i
// default: quel file dà per scontato il blocco sul web.
describe('policy blacklist per fonte', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
    });

    afterAll(async () => {
        await api().put('/settings/blacklist-policy').set(bearer(token)).send({
            MANUAL: 'warn', GOOGLE: 'block', VOICE: 'block', WHATSAPP: 'warn',
        });
    });

    it('il default riproduce il primo rilascio: blocco su web e voce, avviso su manuale e WhatsApp', async () => {
        const res = await api().get('/settings/blacklist-policy').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ MANUAL: 'warn', GOOGLE: 'block', VOICE: 'block', WHATSAPP: 'warn' });
    });

    it('update parziale: cambia una fonte, le altre restano', async () => {
        const res = await api().put('/settings/blacklist-policy').set(bearer(token)).send({
            GOOGLE: 'warn',
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ MANUAL: 'warn', GOOGLE: 'warn', VOICE: 'block', WHATSAPP: 'warn' });
    });

    it('rifiuta fonti e comportamenti sconosciuti', async () => {
        const fonte = await api().put('/settings/blacklist-policy').set(bearer(token)).send({
            TELEGRAM: 'block',
        });
        expect(fonte.status).toBe(400);
        expect(fonte.body.error).toBe('invalid_source');

        const comportamento = await api().put('/settings/blacklist-policy').set(bearer(token)).send({
            GOOGLE: 'sparisci',
        });
        expect(comportamento.status).toBe(400);
        expect(comportamento.body.error).toBe('invalid_behavior');
    });

    it('con GOOGLE su warn il form pubblico accetta il numero in blacklist; su block lo rifiuta', async () => {
        const acceso = await api().put('/settings/features').set(bearer(token)).send({
            public_bookings_enabled: true,
        });
        expect(acceso.status).toBe(200);
        try {
            const marked = await api().post('/customers').set(bearer(token)).send({
                name: 'Policy Bandito',
                phone: '+39 340 555 0094',
                is_blacklisted: true,
            });
            expect([200, 201]).toContain(marked.status);

            // GOOGLE è su 'warn' dal test precedente: la prenotazione entra.
            const accettata = await api().post('/public/reservations').send({
                customer_name: 'Policy Bandito',
                phone: '3405550094',
                date: '2027-03-19',
                time: '20:00',
                shift: 'DINNER',
                guests: 2,
            });
            expect(accettata.status).toBe(201);

            // Riportato su 'block', lo stesso numero viene rifiutato.
            await api().put('/settings/blacklist-policy').set(bearer(token)).send({ GOOGLE: 'block' });
            const rifiutata = await api().post('/public/reservations').send({
                customer_name: 'Policy Bandito',
                phone: '3405550094',
                date: '2027-03-20',
                time: '20:00',
                shift: 'DINNER',
                guests: 2,
            });
            expect(rifiutata.status).toBe(503);
            expect(rifiutata.body.error).toBe('customer_blacklisted');
        } finally {
            await api().put('/settings/features').set(bearer(token)).send({
                public_bookings_enabled: false,
            });
        }
    });

    it('con MANUAL su block anche il POST /reservations dello staff fa 409', async () => {
        await api().put('/settings/blacklist-policy').set(bearer(token)).send({ MANUAL: 'block' });
        const res = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Policy Bandito',
            phone: '340 555 0094',
            reservation_time: '2027-03-21T19:00:00.000Z',
            shift: 'DINNER',
            guests: 2,
        });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('customer_blacklisted');

        // Tornato su 'warn', la stessa prenotazione passa.
        await api().put('/settings/blacklist-policy').set(bearer(token)).send({ MANUAL: 'warn' });
        const ok = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Policy Bandito',
            phone: '340 555 0094',
            reservation_time: '2027-03-21T19:00:00.000Z',
            shift: 'DINNER',
            guests: 2,
        });
        expect(ok.status).toBe(201);
    });
});
