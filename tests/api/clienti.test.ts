import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Rubrica clienti dopo lo scoping per tenant (Fase B3.4): CRUD, dedupe per
// sole cifre del telefono (ora unica per tenant, non più globale) e unione
// schede. I numeri usati qui sono inventati e non compaiono negli altri file
// di test, così il dedupe non incrocia dati altrui.
describe('clienti (rubrica)', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
    });

    describe('creazione e lista', () => {
        let customerId: number;

        it('crea un cliente e lo ritrova nella lista', async () => {
            const created = await api().post('/customers').set(bearer(token)).send({
                name: 'MARIA VERDI',
                phone: '+39 340 111 2233',
                email: 'maria.verdi@example.com',
                notes: 'preferisce il dehors',
            });
            expect(created.status).toBe(201);
            expect(created.body.id).toBeTypeOf('number');
            // Il nome viene normalizzato in title-case dal server.
            expect(created.body.name).toBe('Maria Verdi');
            expect(created.body.phone).toBe('+39 340 111 2233');
            customerId = created.body.id;

            const list = await api().get('/customers').set(bearer(token));
            expect(list.status).toBe(200);
            const found = list.body.find((c: any) => c.id === customerId);
            expect(found).toBeDefined();
            expect(found.email).toBe('maria.verdi@example.com');
        });

        it('un telefono duplicato (stesse cifre, formato diverso) non crea un doppione: torna la scheda esistente', async () => {
            // Stesse cifre di "+39 340 111 2233" ma scritte senza spazi né
            // prefisso formattato: il dedupe è sul digits-only.
            const dup = await api().post('/customers').set(bearer(token)).send({
                name: 'Maria Doppione',
                phone: '393401112233',
            });
            // Semantica del handler: 200 (non 201) con la riga già esistente.
            expect(dup.status).toBe(200);
            expect(dup.body.id).toBe(customerId);
            expect(dup.body.name).toBe('Maria Verdi');

            const list = await api().get('/customers').set(bearer(token));
            const matches = list.body.filter(
                (c: any) => String(c.phone ?? '').replace(/\D/g, '') === '393401112233'
            );
            expect(matches).toHaveLength(1);
        });
    });

    describe('unione schede', () => {
        let sourceId: number;
        let targetId: number;

        it('unisce due schede: la superstite eredita i dati, la sorgente sparisce', async () => {
            const target = await api().post('/customers').set(bearer(token)).send({
                name: 'Paolo Bianchi',
                phone: '340 555 0001',
                notes: 'nota target',
            });
            expect(target.status).toBe(201);
            targetId = target.body.id;

            const source = await api().post('/customers').set(bearer(token)).send({
                name: 'Paolo Bianchi Vecchio',
                phone: '340 555 0002',
                email: 'paolo.bianchi@example.com',
                city: 'Terlizzi',
                notes: 'nota source',
                is_vip: true,
            });
            expect(source.status).toBe(201);
            sourceId = source.body.id;

            const merged = await api()
                .post(`/customers/${sourceId}/merge-into/${targetId}`)
                .set(bearer(token));
            expect(merged.status).toBe(200);
            expect(merged.body.id).toBe(targetId);
            // Backfill dei campi vuoti dalla sorgente + OR sul flag VIP +
            // note concatenate.
            expect(merged.body.email).toBe('paolo.bianchi@example.com');
            expect(merged.body.city).toBe('Terlizzi');
            expect(merged.body.is_vip).toBe(true);
            expect(merged.body.notes).toContain('nota target');
            expect(merged.body.notes).toContain('nota source');

            const list = await api().get('/customers').set(bearer(token));
            expect(list.body.find((c: any) => c.id === sourceId)).toBeUndefined();
            expect(list.body.find((c: any) => c.id === targetId)).toBeDefined();
        });

        it('unire una scheda inesistente (o di un altro tenant) fa 404', async () => {
            const res = await api()
                .post(`/customers/999999/merge-into/${targetId}`)
                .set(bearer(token));
            expect(res.status).toBe(404);
        });
    });

    describe('modifica e cancellazione', () => {
        it('rifiuta con 409 un telefono già in rubrica su un altro cliente', async () => {
            const a = await api().post('/customers').set(bearer(token)).send({
                name: 'Rita Neri',
                phone: '340 555 0003',
            });
            expect(a.status).toBe(201);
            const b = await api().post('/customers').set(bearer(token)).send({
                name: 'Rocco Russo',
                phone: '340 555 0004',
            });
            expect(b.status).toBe(201);

            // Stesse cifre di "340 555 0003", solo senza spazi: il controllo
            // del PUT confronta il digits-only per intero (niente prefisso).
            const clash = await api().put(`/customers/${b.body.id}`).set(bearer(token)).send({
                name: 'Rocco Russo',
                phone: '3405550003',
            });
            expect(clash.status).toBe(409);
            expect(clash.body.existing_customer_id).toBe(a.body.id);
        });

        it('blacklist: il flag fa il giro completo e sopravvive alla fusione', async () => {
            const created = await api().post('/customers').set(bearer(token)).send({
                name: 'Bruno Blacklist',
                phone: '340 555 0090',
                is_blacklisted: true,
                blacklist_reason: 'due no-show senza avviso',
            });
            expect(created.status).toBe(201);
            expect(created.body.is_blacklisted).toBe(true);
            expect(created.body.blacklist_reason).toBe('due no-show senza avviso');

            // Il PUT può toglierlo (e il motivo cade con lui).
            const cleared = await api().put(`/customers/${created.body.id}`).set(bearer(token)).send({
                name: 'Bruno Blacklist',
                phone: '340 555 0090',
                is_blacklisted: false,
            });
            expect(cleared.status).toBe(200);
            expect(cleared.body.is_blacklisted).toBe(false);
            expect(cleared.body.blacklist_reason).toBeNull();

            // Fondere una scheda in blacklist dentro una pulita NON la ripulisce:
            // il flag fa OR come il VIP, il motivo viaggia con lui.
            const dirty = await api().post('/customers').set(bearer(token)).send({
                name: 'Bruno Doppione',
                phone: '340 555 0091',
                is_blacklisted: true,
                blacklist_reason: 'assegno scoperto',
            });
            expect(dirty.status).toBe(201);
            const merged = await api()
                .post(`/customers/${dirty.body.id}/merge-into/${created.body.id}`)
                .set(bearer(token));
            expect(merged.status).toBe(200);
            expect(merged.body.is_blacklisted).toBe(true);
            expect(merged.body.blacklist_reason).toBe('assegno scoperto');
        });

        it('blacklist: il form pubblico rifiuta il numero segnato, gli altri passano', async () => {
            // Il flag del form pubblico è spento di default: si accende solo per
            // questo test e si rispegne alla fine, così i file successivi
            // ritrovano lo stato che si aspettano (la suite è sequenziale).
            const acceso = await api().put('/settings/features').set(bearer(token)).send({
                public_bookings_enabled: true,
            });
            expect(acceso.status).toBe(200);
            try {
                const marked = await api().post('/customers').set(bearer(token)).send({
                    name: 'Web Bandito',
                    phone: '+39 340 555 0092',
                    is_blacklisted: true,
                });
                expect(marked.status).toBe(201);

                // Stesse ultime 10 cifre, formato diverso: il match è right(10).
                const blocked = await api().post('/public/reservations').send({
                    customer_name: 'Web Bandito',
                    phone: '3405550092',
                    date: '2027-03-18',
                    time: '20:00',
                    shift: 'DINNER',
                    guests: 2,
                });
                expect(blocked.status).toBe(503);
                expect(blocked.body.error).toBe('customer_blacklisted');

                const ok = await api().post('/public/reservations').send({
                    customer_name: 'Web Regolare',
                    phone: '340 555 0093',
                    date: '2027-03-18',
                    time: '20:00',
                    shift: 'DINNER',
                    guests: 2,
                });
                expect(ok.status).toBe(201);
            } finally {
                await api().put('/settings/features').set(bearer(token)).send({
                    public_bookings_enabled: false,
                });
            }
        });

        it('cancella un cliente; un id inesistente fa 404', async () => {
            const c = await api().post('/customers').set(bearer(token)).send({
                name: 'Da Cancellare',
                phone: '340 555 0005',
            });
            expect(c.status).toBe(201);

            const del = await api().delete(`/customers/${c.body.id}`).set(bearer(token));
            expect(del.status).toBe(204);

            const again = await api().delete(`/customers/${c.body.id}`).set(bearer(token));
            expect(again.status).toBe(404);
        });
    });
});
