import { describe, it, expect } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// L'identità pubblica (nome, tagline, contatti) vive in legal_config e viene
// servita da /public/contact; i fallback sono i letterali storici del
// Vecchio Frantoio, così un'installazione non configurata non cambia nulla.
describe('branding', () => {
    it('senza configurazione risponde coi fallback storici', async () => {
        const res = await api().get('/public/contact');
        expect(res.status).toBe(200);
        expect(res.body.branding.name).toBe('Il Vecchio Frantoio');
        expect(res.body.branding.tagline).toBe('Cucina Tradizionale');
        expect(typeof res.body.voice_agent_id).toBe('string');
    });

    it('il salvataggio delle impostazioni legali aggiorna subito l\'identità', async () => {
        const token = await ownerToken();
        const saved = await api().put('/settings/legal').set(bearer(token)).send({
            business_name: 'Trattoria Collaudo',
            business_tagline: 'Cucina di prova',
        });
        expect(saved.status).toBe(200);
        expect(saved.body.business_name).toBe('Trattoria Collaudo');

        // Il PUT invalida la cache dell'identità: il nuovo nome deve essere
        // visibile senza aspettare il TTL.
        const res = await api().get('/public/contact');
        expect(res.body.branding.name).toBe('Trattoria Collaudo');
        expect(res.body.branding.tagline).toBe('Cucina di prova');

        // Ripristino: gli altri file di test girano sullo stesso database e
        // non devono vedere il nome di prova.
        const reset = await api().put('/settings/legal').set(bearer(token)).send({
            business_name: '',
            business_tagline: '',
        });
        expect(reset.status).toBe(200);
        const dopo = await api().get('/public/contact');
        expect(dopo.body.branding.name).toBe('Il Vecchio Frantoio');
    });
});
