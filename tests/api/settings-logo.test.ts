import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Logo del ristorante: upload da Impostazioni (byte in outbound_media, path
// in legal_config), esposto alla pagina prenota via /public/contact. Il
// tenant 1 parte già col logo storico (/prenota/logo.png) grazie alla
// migration di preload.
describe('logo del tenant', () => {
    let owner = '';
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    beforeAll(async () => { owner = await ownerToken(); });

    it('la migration precarica il logo storico del tenant 1', async () => {
        const legal = await api().get('/settings/legal').set(bearer(owner));
        expect(legal.status).toBe(200);
        expect(legal.body.logo_url).toBe('/prenota/logo.png');

        const contact = await api().get('/public/contact');
        expect(contact.status).toBe(200);
        expect(contact.body.branding.logo_url).toBe('/prenota/logo.png');
    });

    it('upload: salva, serve i byte dal token pubblico e aggiorna la pagina prenota', async () => {
        const up = await api().post('/settings/logo').set(bearer(owner))
            .send({ content_type: 'image/png', data: PNG });
        expect(up.status).toBe(201);
        expect(up.body.logo_url).toMatch(/^\/public\/media\/[A-Za-z0-9_-]{20,64}$/);

        const img = await api().get(up.body.logo_url);
        expect(img.status).toBe(200);
        expect(img.headers['content-type']).toBe('image/png');

        const contact = await api().get('/public/contact');
        expect(contact.body.branding.logo_url).toBe(up.body.logo_url);

        // Un secondo upload sostituisce: il vecchio token sparisce.
        const up2 = await api().post('/settings/logo').set(bearer(owner))
            .send({ content_type: 'image/png', data: PNG });
        expect(up2.status).toBe(201);
        const old = await api().get(up.body.logo_url);
        expect(old.status).toBe(404);
    });

    it('formato non immagine → 415; rimozione → la pagina prenota resta senza logo', async () => {
        const pdf = await api().post('/settings/logo').set(bearer(owner))
            .send({ content_type: 'application/pdf', data: PNG });
        expect(pdf.status).toBe(415);

        const del = await api().delete('/settings/logo').set(bearer(owner));
        expect(del.status).toBe(200);

        const legal = await api().get('/settings/legal').set(bearer(owner));
        expect(legal.body.logo_url).toBe('');
        const contact = await api().get('/public/contact');
        expect(contact.body.branding.logo_url).toBeNull();
    });
});
