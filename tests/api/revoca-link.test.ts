import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Card dev board #28 — revoca dei link di pagamento e policy di scadenza.
// Il gateway vero non c'è in test (nessuna credenziale provider), quindi qui
// si coprono le guardie dell'endpoint e il giro completo della policy per
// tenant; il pattern cancel+race del provider è lo stesso già in produzione
// nel riconciliatore delle quote.
describe('revoca link di pagamento (card #28)', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
    });

    describe('policy di scadenza', () => {
        it('il default è spento, 24 ore, messaggio "declined"', async () => {
            const res = await api().get('/settings/payment-link-expiry').set(bearer(token));
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ enabled: false, hours: 24, message: 'declined' });
        });

        it('update parziale: cambia le ore, il resto resta', async () => {
            const res = await api().put('/settings/payment-link-expiry').set(bearer(token)).send({
                hours: 48,
            });
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ enabled: false, hours: 48, message: 'declined' });

            const again = await api().get('/settings/payment-link-expiry').set(bearer(token));
            expect(again.body.hours).toBe(48);
        });

        it('rifiuta ore fuori range e messaggi sconosciuti', async () => {
            const troppe = await api().put('/settings/payment-link-expiry').set(bearer(token)).send({
                hours: 500,
            });
            expect(troppe.status).toBe(400);
            expect(troppe.body.error).toBe('invalid_policy');

            const msg = await api().put('/settings/payment-link-expiry').set(bearer(token)).send({
                message: 'piccione-viaggiatore',
            });
            expect(msg.status).toBe(400);
        });

        it('accendere e spegnere fa il giro completo', async () => {
            const on = await api().put('/settings/payment-link-expiry').set(bearer(token)).send({
                enabled: true, hours: 24, message: 'none',
            });
            expect(on.status).toBe(200);
            expect(on.body).toEqual({ enabled: true, hours: 24, message: 'none' });

            // Si rispegne: i file di test successivi non devono ereditare uno
            // scheduler di scadenza armato (la suite è sequenziale).
            const off = await api().put('/settings/payment-link-expiry').set(bearer(token)).send({
                enabled: false, message: 'declined',
            });
            expect(off.status).toBe(200);
            expect(off.body.enabled).toBe(false);
        });
    });

    describe('endpoint di revoca', () => {
        it('un id inesistente (o di un altro tenant) fa 404', async () => {
            const res = await api().post('/payments/999999/revoke').set(bearer(token));
            expect(res.status).toBe(404);
        });

        it('senza token fa 401', async () => {
            const res = await api().post('/payments/1/revoke');
            expect(res.status).toBe(401);
        });
    });
});
