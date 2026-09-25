import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';
import { violazioniTenant } from './sentinellaTenant';
import { SocketService } from '../../services/socketService';
import { runAsPlatform, runWithTenantContext } from '../../db';

// Audit isolamento tenant, H-07 (e la parte urgente di M-06).
//
// Le UPDATE di annullamento e modifica di Sofia restituivano cinque o sette
// colonne, senza tenant_id: la lambda di server.ts che faceva il broadcast
// ripiegava allora su `Number(r.tenant_id) || PUBLIC_TENANT_ID`, cioè sul
// Frantoio. Un annullamento confermato dal Demo arrivava come toast (col nome
// dell'ospite) su tutti gli schermi del tenant 1 e sul nodo di sala, mentre
// il Demo non vedeva il proprio aggiornamento. E la stessa riga parziale, sul
// Frantoio, sostituiva la scheda per intero: dopo una modifica di Sofia
// sparivano note, stato d'arrivo e dati del cliente fino al ricaricamento.
//
// Il percorso esercitato è quello delle proposte WhatsApp: la conferma di una
// proposta PENDING (inserita qui via SQL, come farebbe /messages/agent/run
// con l'LLM) esegue gli stessi strumenti di Sofia. La conferma non guarda
// ai_messages_enabled né ANTHROPIC_API_KEY, quindi non servono.
//
// Le asserzioni negative («il Frantoio non riceve niente») da sole non
// bastano: il server dei test gira con SOCKET_TENANT_INVARIANT_ENFORCE=1, e
// un evento instradato al tenant sbagliato verrebbe scartato dall'invariante
// di emitTo prima di arrivare al socket. Per questo ogni test controlla anche
// che nel log del server non sia comparsa nessuna riga '[tenant-invariant]'
// (sentinellaTenant.ts): niente sul socket E niente scartato.
//
// Il test dell'identità ha senso con TEST_STRICT_RLS=1: col superuser dei
// test normali la lettura fuori contesto vede tutto e non avvelena niente.
// Le date sono future e diverse da quelle degli altri file: la ricerca di
// Sofia va per ultime 10 cifre del telefono + data.

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const SLUG = 'osteria-eventi-tenant';
const OWNER2_EMAIL = 'owner.eventi@example.com';
const DATA = '2027-05-12';
const ISTANTE = `${DATA}T20:00:00+02:00`;
const DATA_RIFIUTO = '2027-05-19';
const TEL_T2_ANNULLO = '+39 347 700 1101';
const TEL_T2_MODIFICA = '+39 347 700 1102';
const TEL_T2_RIFIUTO = '+39 347 700 1103';
const TEL_T1_ANNULLO = '+39 347 700 1104';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Ricevuto = { event: string; payload: any };

const connetti = async (token: string): Promise<{ socket: Socket; ricevuti: Ricevuto[] }> => {
    const socket = ioClient(process.env.TEST_BASE_URL as string, {
        transports: ['websocket'],
        auth: { token },
        reconnection: false,
        timeout: 10_000,
    });
    const ricevuti: Ricevuto[] = [];
    socket.onAny((event: string, payload: any) => { ricevuti.push({ event, payload }); });
    // connection:acknowledged parte DOPO i join delle stanze del tenant:
    // aspettarlo garantisce che un broadcast successivo arrivi.
    await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('socket non connesso')), 10_000);
        socket.on('connection:acknowledged', () => { clearTimeout(t); resolve(); });
        socket.on('connect_error', (e) => { clearTimeout(t); reject(e); });
    });
    return { socket, ricevuti };
};

const aspettaEvento = async (ricevuti: Ricevuto[], event: string, id: number, ms = 5_000): Promise<any> => {
    const scadenza = Date.now() + ms;
    for (;;) {
        const hit = ricevuti.find(r => r.event === event && Number(r.payload?.id) === id);
        if (hit) return hit.payload;
        if (Date.now() > scadenza) throw new Error(`${event} per la prenotazione ${id} mai arrivato`);
        await sleep(50);
    }
};

// Tutto ciò che su un socket riguarda un certo tenant o una certa
// prenotazione, qualunque sia il nome dell'evento.
const toccati = (ricevuti: Ricevuto[], tenantId: number, reservationId: number): Ricevuto[] =>
    ricevuti.filter(r => {
        const p = r.payload;
        if (p == null) return false;
        if (typeof p === 'number') return p === reservationId;
        return Number(p.tenant_id) === tenantId || Number(p.id) === reservationId || Number(p.reservation_id) === reservationId;
    });

describe('eventi socket e identità: il tenant non ripiega sul Frantoio (audit H-07, M-06)', () => {
    let db: Client;
    let token1 = '';
    let token2 = '';
    let tenant2 = 0;
    let t1: { socket: Socket; ricevuti: Ricevuto[] } | null = null;
    let t2: { socket: Socket; ricevuti: Ricevuto[] } | null = null;
    const prenotazioni: number[] = [];

    const inserisciPrenotazione = async (tenantId: number, nome: string, telefono: string, istante = ISTANTE): Promise<number> => {
        const r = await db.query(
            `INSERT INTO reservations (tenant_id, customer_name, phone, email, guests, reservation_time, shift,
                                       notes, payment_status, arrival_status, reservation_status)
             VALUES ($1, $2, $3, 'ospite.eventi@example.com', 2, $4::timestamptz, 'DINNER',
                     'Allergia alle noci', 'NONE', 'WAITING', 'CONFIRMED')
             RETURNING id`,
            [tenantId, nome, telefono, istante]
        );
        const id = Number(r.rows[0].id);
        prenotazioni.push(id);
        return id;
    };

    const inserisciProposta = async (tenantId: number, tool: string, args: Record<string, any>): Promise<number> => {
        const r = await db.query(
            `INSERT INTO agent_proposals (tenant_id, phone_digits, tool, args, summary)
             VALUES ($1, $2, $3, $4::jsonb, 'proposta di collaudo')
             RETURNING id`,
            [tenantId, String(args.phone).replace(/\D/g, '').slice(-10), tool, JSON.stringify(args)]
        );
        return Number(r.rows[0].id);
    };

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();

        token1 = await ownerToken();
        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG,
            name: 'Osteria Eventi Tenant',
            owner_email: OWNER2_EMAIL,
        });
        expect(created.status).toBe(201);
        tenant2 = Number(created.body.tenant.id);
        expect(tenant2).toBeGreaterThan(1);
        const login = await api().post('/auth/login').send({
            email: OWNER2_EMAIL,
            password: created.body.owner_temp_password,
        });
        expect(login.status).toBe(200);
        token2 = login.body.accessToken;

        t1 = await connetti(token1);
        t2 = await connetti(token2);
    });

    afterAll(async () => {
        t1?.socket.close();
        t2?.socket.close();
        if (!db) return;
        try {
            if (prenotazioni.length > 0) {
                await db.query(`DELETE FROM agent_proposals WHERE reservation_id = ANY($1::int[]) OR summary = 'proposta di collaudo'`, [prenotazioni]).catch(() => {});
                await db.query(`DELETE FROM outbox_events WHERE aggregate = ANY($1::text[])`, [prenotazioni.map(id => `reservation:${id}`)]).catch(() => {});
                await db.query(`DELETE FROM reservations WHERE id = ANY($1::int[])`, [prenotazioni]).catch(() => {});
            }
            if (tenant2 > 1) {
                // Il provisioning e le route lasciano righe con FK sul tenant:
                // vanno via prima, o la DELETE finale viola il vincolo.
                for (const tabella of ['agent_proposals', 'outbox_events', 'reservations', 'customers', 'activity_logs',
                    'user_sessions', 'app_settings', 'tenant_tokens', 'users', 'tenant_features', 'opening_hours', 'role_permissions']) {
                    await db.query(`DELETE FROM ${tabella} WHERE tenant_id = $1`, [tenant2]).catch(() => {});
                }
                await db.query('DELETE FROM tenants WHERE id = $1', [tenant2]).catch(() => {});
            }
        } finally {
            await db.end();
        }
    });

    it('annullamento confermato da un altro tenant: evento al SUO socket con la riga intera, niente al Frantoio', async () => {
        const violazioniPrima = violazioniTenant().length;
        const id = await inserisciPrenotazione(tenant2, 'Ospite Annullo Due', TEL_T2_ANNULLO);
        const proposta = await inserisciProposta(tenant2, 'cancel_reservation', { phone: TEL_T2_ANNULLO, date: DATA });

        const res = await api().post(`/messages/agent/proposals/${proposta}/confirm`).set(bearer(token2));
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.result.status).toBe('cancelled');

        const riga = await aspettaEvento(t2!.ricevuti, 'reservation:updated', id);
        expect(Number(riga.tenant_id)).toBe(tenant2);
        expect(riga.reservation_status).toBe('CANCELLED');
        // Riga intera, non le cinque colonne di prima: la scheda non perde
        // note, stato d'arrivo, telefono ed email.
        expect(riga.notes).toBe('Allergia alle noci');
        expect(riga.arrival_status).toBe('WAITING');
        expect(riga.email).toBe('ospite.eventi@example.com');
        expect(String(riga.phone)).toContain('347');

        await sleep(1_500);
        expect(toccati(t1!.ricevuti, tenant2, id)).toEqual([]);
        expect(violazioniTenant().slice(violazioniPrima)).toEqual([]);

        // Nel log di replica, col tenant giusto: il nodo di sala lo vede.
        const outbox = await db.query(
            `SELECT tenant_id FROM outbox_events WHERE event = 'reservation:updated' AND aggregate = $1`,
            [`reservation:${id}`]
        );
        expect(outbox.rows.length).toBe(1);
        expect(Number(outbox.rows[0].tenant_id)).toBe(tenant2);
    });

    it('modifica confermata da un altro tenant: stesso tenant, riga intera, evento nel log di replica', async () => {
        const violazioniPrima = violazioniTenant().length;
        const id = await inserisciPrenotazione(tenant2, 'Ospite Modifica Due', TEL_T2_MODIFICA);
        const proposta = await inserisciProposta(tenant2, 'modify_reservation', {
            phone: TEL_T2_MODIFICA, date: DATA, new_notes: 'Tavolo vicino alla finestra',
        });

        const res = await api().post(`/messages/agent/proposals/${proposta}/confirm`).set(bearer(token2));
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.result.status).toBe('modified');

        const riga = await aspettaEvento(t2!.ricevuti, 'reservation:updated', id);
        expect(Number(riga.tenant_id)).toBe(tenant2);
        expect(String(riga.notes)).toContain('Tavolo vicino alla finestra');
        expect(riga.arrival_status).toBe('WAITING');
        expect(riga.email).toBe('ospite.eventi@example.com');
        expect(riga.reservation_status).toBe('CONFIRMED');

        await sleep(1_500);
        expect(toccati(t1!.ricevuti, tenant2, id)).toEqual([]);
        expect(violazioniTenant().slice(violazioniPrima)).toEqual([]);

        const outbox = await db.query(
            `SELECT tenant_id FROM outbox_events WHERE event = 'reservation:updated' AND aggregate = $1`,
            [`reservation:${id}`]
        );
        expect(outbox.rows.length).toBe(1);
        expect(Number(outbox.rows[0].tenant_id)).toBe(tenant2);
    });

    it('sul Frantoio l\'annullamento di Sofia arriva con note e stato d\'arrivo, e solo al Frantoio', async () => {
        const violazioniPrima = violazioniTenant().length;
        const id = await inserisciPrenotazione(1, 'Ospite Annullo Frantoio', TEL_T1_ANNULLO);
        const proposta = await inserisciProposta(1, 'cancel_reservation', { phone: TEL_T1_ANNULLO, date: DATA });

        const res = await api().post(`/messages/agent/proposals/${proposta}/confirm`).set(bearer(token1));
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const riga = await aspettaEvento(t1!.ricevuti, 'reservation:updated', id);
        expect(Number(riga.tenant_id)).toBe(1);
        expect(riga.reservation_status).toBe('CANCELLED');
        expect(riga.notes).toBe('Allergia alle noci');
        expect(riga.arrival_status).toBe('WAITING');

        await sleep(1_500);
        expect(toccati(t2!.ricevuti, 1, id)).toEqual([]);
        expect(violazioniTenant().slice(violazioniPrima)).toEqual([]);
    });

    it('un\'azione di un altro tenant non avvelena l\'identità del Frantoio in cache', async () => {
        const prima = await api().get('/settings/legal').set(bearer(token1));
        expect(prima.status).toBe(200);
        const indirizzoOriginale = String(prima.body.public_address ?? '');
        const INDIRIZZO = 'Via del Collaudo 7, Buonvicino';
        try {
            const salvato = await api().put('/settings/legal').set(bearer(token1)).send({ public_address: INDIRIZZO });
            expect(salvato.status).toBe(200);
            const fresco = await api().get('/public/contact');
            expect(fresco.body.branding.address).toBe(INDIRIZZO);

            // Cache del tenant 1 scaduta (IDENTITY_CACHE_TTL_MS=2000 in
            // globalSetup): il prossimo businessIdentity() la rinfresca.
            await sleep(2_300);

            // Il rifiuto costruisce subito l'SMS con businessIdentity() senza
            // argomento, cioè sul tenant 1, dentro una richiesta del tenant 2.
            const id = await inserisciPrenotazione(tenant2, 'Ospite Rifiuto Due', TEL_T2_RIFIUTO, `${DATA_RIFIUTO}T20:00:00+02:00`);
            const rifiuto = await api().put(`/reservations/${id}`).set(bearer(token2)).send({
                customer_name: 'Ospite Rifiuto Due',
                reservation_time: `${DATA_RIFIUTO}T20:00:00`,
                shift: 'DINNER',
                guests: 2,
                phone: TEL_T2_RIFIUTO,
                reservation_status: 'DECLINED',
            });
            expect(rifiuto.status).toBe(200);
            // Il refresh parte in background: gli si dà il tempo di chiudersi.
            await sleep(700);

            const dopo = await api().get('/public/contact');
            expect(dopo.status).toBe(200);
            expect(dopo.body.branding.address).toBe(INDIRIZZO);
        } finally {
            const ripristino = await api().put('/settings/legal').set(bearer(token1)).send({ public_address: indirizzoOriginale });
            expect(ripristino.status).toBe(200);
        }
    });
});

// L'invariante stessa, in-process: il server dei test non ha (e non deve
// avere) una route che emetta verso un altro tenant, quindi il log e lo
// scarto si provano qui, sulla classe vera e sul contesto ALS vero di db.ts.
// Se currentTenantContext() smettesse di vedere il contesto, la sentinella
// non scatterebbe più da nessuna parte: questo test se ne accorge.
describe('invariante di SocketService.emitTo (audit H-07)', () => {
    const ENFORCE = 'SOCKET_TENANT_INVARIANT_ENFORCE';
    const enforcePrima = process.env[ENFORCE];
    let emessi: Array<{ rooms: string[]; event: string }> = [];
    let svc: SocketService;
    let ioVero: { close: () => unknown } | null = null;
    let logErrori: ReturnType<typeof vi.spyOn>;
    let logNormali: ReturnType<typeof vi.spyOn>;

    beforeAll(() => {
        // I broadcast* scrivono una riga di console.log a ogni evento: qui è
        // solo rumore.
        logNormali = vi.spyOn(console, 'log').mockImplementation(() => {});
        svc = new SocketService(createServer());
        ioVero = (svc as any).io;
        // Al posto del server Socket.IO, un registro di ciò che partirebbe.
        (svc as any).io = {
            to: (rooms: string[]) => ({
                emit: (event: string) => { emessi.push({ rooms, event }); },
                except: () => ({ emit: (event: string) => { emessi.push({ rooms, event }); } }),
            }),
        };
    });

    afterEach(() => {
        emessi = [];
        logErrori?.mockRestore();
        if (enforcePrima === undefined) delete process.env[ENFORCE];
        else process.env[ENFORCE] = enforcePrima;
    });

    afterAll(() => {
        ioVero?.close();
        logNormali?.mockRestore();
    });

    const righeInvariante = () =>
        logErrori.mock.calls.map(c => String(c[0])).filter(r => r.includes('[tenant-invariant]'));

    it('contesto di un altro tenant, senza flag: registra ed emette (produzione, nodo di sala)', () => {
        delete process.env[ENFORCE];
        logErrori = vi.spyOn(console, 'error').mockImplementation(() => {});
        runWithTenantContext(2, () => svc.broadcastReservationUpdated(1, { id: 7 } as any));
        expect(righeInvariante()).toEqual([
            '[tenant-invariant] evento reservation:updated per il tenant 1 emesso nel contesto del tenant 2',
        ]);
        expect(emessi).toEqual([{ rooms: ['tenant:1'], event: 'reservation:updated' }]);
    });

    it('contesto di un altro tenant, con SOCKET_TENANT_INVARIANT_ENFORCE=1: registra e scarta', () => {
        process.env[ENFORCE] = '1';
        logErrori = vi.spyOn(console, 'error').mockImplementation(() => {});
        runWithTenantContext(2, () => svc.broadcastToAll(1, 'paymentRequest:created', { id: 9 }));
        expect(righeInvariante()).toHaveLength(1);
        expect(emessi).toEqual([]);
    });

    it('stesso tenant, piattaforma o nessun contesto: niente log, l\'evento parte', () => {
        process.env[ENFORCE] = '1';
        logErrori = vi.spyOn(console, 'error').mockImplementation(() => {});
        runWithTenantContext(2, () => svc.broadcastReservationUpdated(2, { id: 1 } as any));
        runAsPlatform(() => svc.broadcastReservationUpdated(1, { id: 2 } as any));
        svc.broadcastReservationUpdated(1, { id: 3 } as any);
        expect(righeInvariante()).toEqual([]);
        expect(emessi.map(e => e.rooms[0])).toEqual(['tenant:2', 'tenant:1', 'tenant:1']);
    });
});

// Il ripiego `x.tenant_id || PUBLIC_TENANT_ID` non si vede a tsc (la riga è
// any, Number(any) è number): è la trappola che ha prodotto H-07. Restano
// ammessi solo i siti dei pagamenti, che l'audit rimanda al secondo tenant
// reale (lì, per l'unico tenant vero, il ripiego oggi è il valore giusto e
// uno scarto bloccherebbe caparre e quote).
const AMMESSI = new Set([
    'applyPaymentOrderTransition',
    'startBillSplitReconcileScheduler',
    'startPaymentRequestReconcileScheduler',
    'startPaymentLinkExpiryScheduler',
]);
const RIPIEGO = /\|\|\s*PUBLIC_TENANT_ID\b/;
const DICHIARAZIONE = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?(?:const|let)\s+(\w+)\s*=|^app\.\w+\(\s*'([^']+)'|^([\w.]+)\(/;

const contenitore = (righe: string[], indice: number): string => {
    for (let i = indice; i >= 0; i--) {
        const m = righe[i].match(DICHIARAZIONE);
        if (m) return m[1] || m[2] || m[3] || m[4];
    }
    return '(inizio file)';
};

describe('nessun ripiego silenzioso sul tenant 1 fuori dai pagamenti (audit H-07)', () => {
    it('il pattern morde', () => {
        expect(RIPIEGO.test('broadcast(Number(r.tenant_id) || PUBLIC_TENANT_ID, r)')).toBe(true);
        expect(RIPIEGO.test('resolveTenantForPublicRequest(req) ?? PUBLIC_TENANT_ID')).toBe(false);
    });

    it('server.ts e services/ non ripiegano su PUBLIC_TENANT_ID fuori dalla lista dei pagamenti', () => {
        const file = ['server.ts', ...readdirSync(path.join(repoRoot, 'services'))
            .filter(f => f.endsWith('.ts'))
            .map(f => `services/${f}`)];
        const fuoriLista: string[] = [];
        for (const f of file) {
            const righe = readFileSync(path.join(repoRoot, f), 'utf8').split('\n');
            righe.forEach((riga, i) => {
                if (!RIPIEGO.test(riga) || riga.trim().startsWith('//')) return;
                const dove = contenitore(righe, i);
                if (!AMMESSI.has(dove)) fuoriLista.push(`${f}:${i + 1} (${dove}): ${riga.trim()}`);
            });
        }
        expect(fuoriLista, `ripiego sul tenant 1 fuori dai siti ammessi:\n${fuoriLista.join('\n')}`).toEqual([]);
    });
});
