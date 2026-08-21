import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Libreria media. Il flusso che conta non è "carica un file" ma il giro
// completo: caricare una volta e poi allegare più volte senza consumare la
// copia in libreria. È la ragione per cui la tabella esiste — se allegare
// svuotasse il catalogo, tanto valeva ricaricare il file ogni volta.
//
// Un id di un altro tenant equivale a inesistente: il 404 su id inventato
// esercita lo stesso ramo, senza bisogno di fabbricare un secondo tenant.

// PDF minimo valido: pochi byte, evita di spedire un allegato finto grosso.
const PDF_B64 = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>'
).toString('base64');

describe('libreria media', () => {
    let token: string;
    let mediaId: number;

    beforeAll(async () => {
        token = await ownerToken();
    });

    it('carica un file e lo elenca', async () => {
        const res = await api().post('/media').set(bearer(token)).send({
            title: 'Menù di Ferragosto',
            filename: 'menu-ferragosto.pdf',
            content_type: 'application/pdf',
            data: PDF_B64,
        });
        expect(res.status).toBe(201);
        expect(res.body.title).toBe('Menù di Ferragosto');
        expect(res.body.size_bytes).toBeGreaterThan(0);
        mediaId = res.body.id;

        const list = await api().get('/media').set(bearer(token));
        expect(list.status).toBe(200);
        expect(list.body.files.some((f: any) => f.id === mediaId)).toBe(true);
    });

    it('rifiuta un tipo non ammesso', async () => {
        const res = await api().post('/media').set(bearer(token)).send({
            title: 'Eseguibile',
            filename: 'virus.exe',
            content_type: 'application/x-msdownload',
            data: PDF_B64,
        });
        expect(res.status).toBe(415);
    });

    it('rifiuta un file senza nome riconoscibile', async () => {
        const res = await api().post('/media').set(bearer(token)).send({
            title: '   ',
            filename: 'x.pdf',
            content_type: 'application/pdf',
            data: PDF_B64,
        });
        expect(res.status).toBe(400);
    });

    it('allegare produce un token e NON consuma il file in libreria', async () => {
        const primo = await api().post(`/media/${mediaId}/attach`).set(bearer(token));
        expect(primo.status).toBe(201);
        expect(primo.body.token).toBeTruthy();
        expect(primo.body.content_type).toBe('application/pdf');

        // Secondo allegato dallo stesso file: token diverso, entrambi validi.
        const secondo = await api().post(`/media/${mediaId}/attach`).set(bearer(token));
        expect(secondo.status).toBe(201);
        expect(secondo.body.token).not.toBe(primo.body.token);

        const list = await api().get('/media').set(bearer(token));
        expect(list.body.files.some((f: any) => f.id === mediaId)).toBe(true);
    });

    it('404 su id estraneo, sia per allegare che per eliminare', async () => {
        const inesistente = 99_999_999;
        const attach = await api().post(`/media/${inesistente}/attach`).set(bearer(token));
        expect(attach.status).toBe(404);
        const del = await api().delete(`/media/${inesistente}`).set(bearer(token));
        expect(del.status).toBe(404);
    });

    it('elimina il file dalla libreria', async () => {
        const del = await api().delete(`/media/${mediaId}`).set(bearer(token));
        expect(del.status).toBe(200);
        const list = await api().get('/media').set(bearer(token));
        expect(list.body.files.some((f: any) => f.id === mediaId)).toBe(false);
    });

    it('richiede autenticazione', async () => {
        const res = await api().get('/media');
        expect(res.status).toBe(401);
    });
});
