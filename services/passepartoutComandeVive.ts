// Ordini del CRM nella comanda in cassa Passepartout, dal vivo («comanda
// viva», fase 2 del piano del 07/10/2026).
//
// La comanda specchio (passepartoutSpecchio.ts) porta in cassa il conto del
// CRM solo a conto chiuso, su un tavolo di comodo. Qui l'ordine preso nel
// CRM nasce, e cresce, nella comanda del suo tavolo vero: il cameriere in
// cassa lo vede mentre il servizio è in corso. Le prove sulla cassa vera
// (docs/passepartout-comanda-viva-prove.md) hanno deciso come:
// - il CRM scrive SOLO le sue righe, con l'IdGestionale della comanda: non
//   riscrive mai le righe del palmare o della cassa;
// - un tavolo già aperto in cassa (dal palmare) riceve le righe del CRM
//   nella stessa comanda (scelta dell'utente: un tavolo, una comanda);
// - quantità e prezzi si cambiano sulla stessa riga, gli storni si fanno
//   con DaCancellare (la cucina vede lo storno senza un nuovo invio);
// - il cambio di tavolo la cassa non lo fa: un ordine già in cassa si
//   sposta in cassa (la rotta di trasferimento lo rifiuta).
//
// Stato desiderato, non eventi: ogni giro legge l'ordine com'è adesso (righe
// mandate, non in bozza e non stornate), lo confronta con quello che il CRM
// ha già scritto (passepartout_righe_vive) e manda all'agente solo la
// differenza. Una rotta che dimentica di avvisare non perde niente: il giro
// periodico la recupera. Un tentativo fallito si rifà senza doppioni: le
// righe scritte di cui la risposta è andata persa le ricorda l'agente.
//
// Fase 3, «stampa: la cassa»: le uscite lanciate nel CRM le manda in
// produzione la cassa (InviaProduzioneComanda per uscita), e il CRM non
// stampa i suoi foglietti di partita per quell'ordine; il monitor resta. La
// cassa manda sempre l'uscita intera, e alla chiusura dal suo schermo manda
// anche le righe del CRM mai partite (collaudo sulla demo, 08/10): per
// questo «stampa: il CRM» si sceglie solo con «conto: il CRM». Se la cassa
// non può mandare (agente giù, ordine fermo), dopo un'attesa breve stampa il
// CRM e quell'uscita resta sua: mandata dalla cassa, la ristamperebbe.
// Niente conto dalla cassa (fase 4). Solo cloud: con i conti in sala (nodo)
// il giro salta il ristorante, come lo specchio.

import { queryWithRetry, runAsPlatform, runWithTenantContext, withTenant } from '../db.js';
import { isFeatureEnabledForTenant } from './entitlements.js';
import { callPassepartout, connectedPassepartoutTenants, passepartoutAgentSupports, PassepartoutBridgeError } from './passepartoutBridge.js';
import type { EsitoComandaViva, ParametriComandaViva, PassepartoutComanda, PassepartoutComandaAperta, RigaViva, VarianteViva } from './passepartoutService.js';
import { BAR_COURSE_NO, DESSERT_COURSE_NO } from '../utils/courses.js';

const CAPACITA = 'comanda-viva';
const CAPACITA_INVIO = 'comanda-viva-invio';
const MAX_TENTATIVI = 8;
// Ogni quanto, al massimo, si chiede alla cassa quali comande sono aperte
// per accorgersi di quelle chiuse da lei.
const CHIUSE_IN_CASSA_OGNI_MS = () => Number(process.env.PASSEPARTOUT_COMANDE_VIVE_CHIUSE_MS ?? '') || 15_000;
// Quanto si aspetta la cassa prima di stampare dal CRM un'uscita lanciata.
const STAMPA_DI_RIPIEGO_DOPO_MS = () => Number(process.env.PASSEPARTOUT_COMANDE_VIVE_RIPIEGO_MS) || 45_000;
// Un problema di configurazione non passa ritentando.
const SENZA_ARTICOLO = 'non ha un articolo in cassa';
const STATI_INVIATA = new Set(['InProduzione', 'Fatto', 'Cancellato']);

export interface StatoComandaViva {
    order_id: number;
    stato: 'PENDING' | 'SCRITTA' | 'FAILED' | 'CHIUSA';
    pp_comanda_id: number | null;
    palmare: boolean;
    error: string | null;
}

export interface ComandeViveDeps {
    /** Con l'autorità di sala i conti sono del nodo: il giro non tocca il
     *  ristorante (la fase 6 lo porta sul nodo). */
    nodeOwnsBills: (tenantId: number) => Promise<boolean>;
    /** Lo stato in cassa di un ordine, per l'etichetta nel palmare
     *  (evento 'passepartout:comanda-viva'). */
    avvisa: (tenantId: number, stato: StatoComandaViva) => void;
    /** I foglietti di partita stampati dal CRM per righe lanciate che la
     *  cassa non ha mandato (ripiego): stampa e segna stampata_crm. */
    stampaDalCrm: (tenantId: number, orderId: number, orderItemIds: number[]) => Promise<void>;
    /** L'ordine del CRM la cui comanda è stata chiusa in cassa: si chiude
     *  senza conto del CRM (il conto l'ha fatto la cassa). true se chiuso. */
    chiudiOrdineChiusoInCassa: (tenantId: number, orderId: number) => Promise<boolean>;
}

let deps: ComandeViveDeps | null = null;

/**
 * L'uscita della cassa per un'uscita del CRM. Le uscite di cucina 1..6
 * restano quelle. Il Bar del CRM (99) va sull'uscita 1: in cassa le
 * categorie del bar hanno l'uscita fissa 1 (CategoriaElementi.portataFissa,
 * letto il 08/10). I Dolci (98) vanno sulla 7, dopo le portate: da
 * confermare al collaudo, la cassa non è mai stata provata oltre la 2.
 */
export function uscitaPerCassa(courseNo: number): number {
    if (courseNo === BAR_COURSE_NO) return 1;
    if (courseNo === DESSERT_COURSE_NO) return 7;
    return Math.max(1, Math.min(9, Math.round(courseNo) || 1));
}

/** Le varianti del CRM come varianti libere della cassa. Le etichette sono
 *  già firmate (utils/modifierScale.ts): «+ X» e «Senza X» diventano «+ X»
 *  e «- X», le altre («Molto X», le cotture) restano intere col «+». La nota
 *  della riga va in coda: la cassa non ha una nota per riga. */
export function variantiPerCassa(modifiers: unknown, note: string | null): VarianteViva[] {
    const out: VarianteViva[] = [];
    for (const m of Array.isArray(modifiers) ? modifiers : []) {
        const nome = String((m as any)?.name ?? '').trim();
        if (!nome) continue;
        const senza = /^senza\s+(.+)$/i.exec(nome);
        if (senza) out.push({ descrizione: senza[1], inAggiunta: false });
        else out.push({ descrizione: nome.replace(/^\+\s*/, ''), inAggiunta: true });
    }
    const nota = String(note ?? '').trim();
    if (nota) out.push({ descrizione: nota, inAggiunta: true });
    return out;
}

/** Una riga desiderata in cassa, con il prezzo e i pezzi da confrontare con
 *  quelli già scritti. */
interface Desiderata extends RigaViva {
    orderItemId: number | null;
    /** Lanciata nel CRM: la cucina la deve avere. */
    lanciata: boolean;
}

/** L'ordine com'è adesso, nelle righe che la cassa deve avere. */
export function righeDesiderate(
    righe: Array<{
        id: number; line_kind: string; qty: number; unit_price_cents: number; modifiers: unknown;
        note: string | null; course_no: number; name_snapshot: string; weight_grams: number | null; external_ref: string | null;
        fired_at?: string | Date | null;
    }>,
    coperti: number,
    palmare: boolean,
): Desiderata[] {
    const out: Desiderata[] = [];
    let copertoPezzi = 0;
    let copertoPrezzo: number | null = null;
    for (const r of righe) {
        const kind = String(r.line_kind || 'DISH');
        if (kind === 'COVER') {
            copertoPezzi += Number(r.qty) || 0;
            copertoPrezzo ??= Number(r.unit_price_cents) || 0;
            continue;
        }
        if (kind === 'SERVICE') {
            if (palmare) continue;
            out.push({
                chiave: 'servizio', orderItemId: null, lanciata: false, idRiga: null, idArticolo: null,
                descrizione: String(r.name_snapshot || 'Servizio'), pezzi: 1,
                prezzoCents: Math.round(Number(r.unit_price_cents) * (Number(r.qty) || 1)),
                uscita: 1, varianti: [], soloComandaNostra: true,
            });
            continue;
        }
        const mods: any[] = Array.isArray(r.modifiers) ? r.modifiers : [];
        const delta = mods.reduce((s, m) => s + Number(m?.price_delta_cents || 0), 0);
        const ref = /^pp:articolo:(\d+)$/.exec(String(r.external_ref ?? ''));
        const grammi = Number(r.weight_grams) || 0;
        out.push({
            chiave: `oi:${r.id}`,
            orderItemId: Number(r.id),
            lanciata: r.fired_at != null,
            idRiga: null,
            idArticolo: ref ? Number(ref[1]) : null,
            // Al peso il prezzo della riga è già quello dei grammi pesati.
            descrizione: grammi > 0 ? `${r.name_snapshot} (${grammi} g)` : String(r.name_snapshot ?? 'Voce'),
            pezzi: Math.max(1, Number(r.qty) || 1),
            prezzoCents: Math.max(0, Number(r.unit_price_cents) + delta),
            uscita: uscitaPerCassa(Number(r.course_no) || 1),
            varianti: variantiPerCassa(mods, r.note),
        });
    }
    // Il coperto del CRM col suo prezzo; senza coperto nel CRM, una riga
    // coperto a zero coi coperti dell'ordine: se la comanda ha coperti e
    // nessuna riga coperto, la cassa aggiunge la sua al suo prezzo (prova
    // del 06/10) e il totale non tornerebbe più.
    if (!palmare && (copertoPezzi > 0 || coperti > 0)) {
        out.unshift({
            chiave: 'coperto', orderItemId: null, lanciata: false, idRiga: null, idArticolo: null, descrizione: 'Coperto',
            pezzi: copertoPezzi > 0 ? copertoPezzi : coperti,
            prezzoCents: copertoPezzi > 0 ? (copertoPrezzo ?? 0) : 0,
            uscita: 1, varianti: [], coperto: true, soloComandaNostra: true,
        });
    }
    return out;
}

interface Scritta {
    chiave: string;
    pp_riga_id: number | null;
    pezzi_scritti: number;
    prezzo_cents_scritto: number | null;
    sparita: boolean;
    /** Mandata in produzione dalla cassa. */
    inviata?: boolean;
    /** Stampata dal CRM per ripiego: la sua uscita resta del CRM. */
    stampata_crm?: boolean;
}

/** La differenza fra l'ordine e quello che il CRM ha già scritto in cassa:
 *  le righe nuove, quelle con pezzi o prezzo cambiati nel CRM, e quelle da
 *  togliere. Le righe tolte in cassa (sparita) non si toccano più. */
export function differenza(desiderate: Desiderata[], scritte: Scritta[]): Desiderata[] {
    const perChiave = new Map(scritte.map((s) => [s.chiave, s]));
    const out: Desiderata[] = [];
    for (const d of desiderate) {
        const s = perChiave.get(d.chiave);
        perChiave.delete(d.chiave);
        if (s?.sparita) continue;
        if (!s || s.pp_riga_id == null) { out.push(d); continue; }
        if (s.pezzi_scritti !== d.pezzi || s.prezzo_cents_scritto !== d.prezzoCents) {
            out.push({ ...d, idRiga: s.pp_riga_id });
        }
    }
    for (const s of perChiave.values()) {
        if (s.sparita || s.pp_riga_id == null) continue;
        out.push({
            chiave: s.chiave, orderItemId: null, lanciata: false, idRiga: s.pp_riga_id, idArticolo: null, descrizione: '',
            pezzi: s.pezzi_scritti, prezzoCents: s.prezzo_cents_scritto ?? 0, uscita: 1, varianti: [], cancella: true,
        });
    }
    return out;
}

/** Con «stampa: la cassa»: le uscite della cassa da mandare in produzione
 *  (righe lanciate nel CRM non ancora mandate) e le righe che stampa il CRM.
 *  Un'uscita con una riga già stampata dal CRM resta del CRM: la cassa la
 *  manderebbe intera, ristampando quella riga. */
export function usciteDaInviare(desiderate: Desiderata[], scritte: Scritta[]): { cassa: number[]; crm: number[] } {
    const perChiave = new Map(scritte.map((s) => [s.chiave, s]));
    const delCrm = new Set<number>();
    for (const d of desiderate) {
        const s = perChiave.get(d.chiave);
        if (s?.stampata_crm && !s.inviata) delCrm.add(d.uscita);
    }
    const cassa = new Set<number>();
    const crm: number[] = [];
    for (const d of desiderate) {
        if (!d.lanciata || d.orderItemId == null || d.cancella) continue;
        const s = perChiave.get(d.chiave);
        if (s?.inviata || s?.stampata_crm || s?.sparita) continue;
        if (delCrm.has(d.uscita)) crm.push(d.orderItemId);
        else cassa.add(d.uscita);
    }
    return { cassa: [...cassa].sort((a, b) => a - b), crm };
}

const tag = (orderId: number) => `sympotia-ordine:${orderId}`;

async function configVive(tenantId: number) {
    const rs = await queryWithRetry(
        `SELECT comande_vive_enabled, comande_vive_dal, articolo_generico_id, comande_stampa FROM passepartout_config WHERE tenant_id = $1`,
        [tenantId]
    );
    return rs.rows[0] ?? null;
}

/** Gli ordini da guardare: quelli aperti sui tavoli abbinati da quando
 *  l'interruttore è acceso, con almeno un piatto mandato; e quelli già in
 *  cassa non ancora chiusi, anche chiusi o cancellati nel CRM (le loro
 *  righe in cassa vanno allineate un'ultima volta). */
async function ordiniDaGuardare(tenantId: number, soloOrdine: number | null) {
    const rs = await queryWithRetry(
        `SELECT o.id AS order_id, o.status, o.covers, o.table_id,
                pt.pp_sala, pt.pp_tavolo,
                v.order_id AS v_order, v.stato AS v_stato, v.pp_comanda_id, v.palmare, v.attempts
           FROM orders o
           JOIN passepartout_config pc ON pc.tenant_id = o.tenant_id
           LEFT JOIN passepartout_tavoli pt ON pt.tenant_id = o.tenant_id AND pt.table_id = o.table_id AND pt.confermato
           LEFT JOIN passepartout_comande_vive v ON v.tenant_id = o.tenant_id AND v.order_id = o.id
          WHERE o.tenant_id = $1 AND o.order_type = 'DINE_IN'
            AND ($2::int IS NULL OR o.id = $2)
            AND (
                (v.order_id IS NULL AND pt.table_id IS NOT NULL AND o.status = 'OPEN' AND pc.comande_vive_enabled
                 AND o.opened_at >= COALESCE(pc.comande_vive_dal, now())
                 AND EXISTS (SELECT 1 FROM order_items oi
                              WHERE oi.order_id = o.id AND oi.tenant_id = o.tenant_id
                                AND oi.line_kind = 'DISH' AND oi.status NOT IN ('DRAFT', 'VOIDED')))
                OR (v.stato IN ('PENDING', 'SCRITTA') AND v.next_at <= now())
            )
         UNION ALL
         SELECT v.order_id, 'DELETED' AS status, 1 AS covers, v.table_id,
                pt.pp_sala, pt.pp_tavolo,
                v.order_id AS v_order, v.stato AS v_stato, v.pp_comanda_id, v.palmare, v.attempts
           FROM passepartout_comande_vive v
           LEFT JOIN passepartout_tavoli pt ON pt.tenant_id = v.tenant_id AND pt.table_id = v.table_id
          WHERE v.tenant_id = $1 AND ($2::int IS NULL OR v.order_id = $2)
            AND v.stato IN ('PENDING', 'SCRITTA') AND v.next_at <= now()
            AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = v.order_id)
          ORDER BY order_id`,
        [tenantId, soloOrdine]
    );
    return rs.rows;
}

async function righeDegliOrdini(tenantId: number, orderIds: number[]) {
    const [righe, scritte] = await Promise.all([
        queryWithRetry(
            `SELECT oi.id, oi.order_id, oi.line_kind, oi.qty, oi.unit_price_cents, oi.modifiers, oi.note,
                    oi.course_no, oi.name_snapshot, oi.weight_grams, oi.fired_at, d.external_ref
               FROM order_items oi
               LEFT JOIN dishes d ON d.id = oi.dish_id AND d.tenant_id = oi.tenant_id
              WHERE oi.tenant_id = $1 AND oi.order_id = ANY($2::int[]) AND oi.status NOT IN ('DRAFT', 'VOIDED')
              ORDER BY oi.course_no, oi.id`,
            [tenantId, orderIds]
        ),
        queryWithRetry(
            `SELECT order_id, chiave, pp_riga_id, pezzi_scritti, prezzo_cents_scritto, sparita, inviata, stampata_crm
               FROM passepartout_righe_vive WHERE tenant_id = $1 AND order_id = ANY($2::int[])`,
            [tenantId, orderIds]
        ),
    ]);
    const perOrdine = <T extends { order_id: number }>(rows: T[]) => {
        const m = new Map<number, T[]>();
        for (const r of rows) m.set(Number(r.order_id), [...(m.get(Number(r.order_id)) ?? []), r]);
        return m;
    };
    return { righe: perOrdine(righe.rows), scritte: perOrdine(scritte.rows) };
}

async function segna(tenantId: number, orderId: number, campi: { stato: StatoComandaViva['stato']; error?: string | null }) {
    const rs = await queryWithRetry(
        `UPDATE passepartout_comande_vive
            SET stato = $3, error = $4, attempts = 0, next_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND order_id = $2
          RETURNING order_id, stato, pp_comanda_id, palmare, error`,
        [tenantId, orderId, campi.stato, campi.error ?? null]
    );
    if (rs.rows[0]) avvisa(tenantId, rs.rows[0]);
}

function avvisa(tenantId: number, r: any) {
    try {
        deps?.avvisa(tenantId, {
            order_id: Number(r.order_id),
            stato: r.stato,
            pp_comanda_id: r.pp_comanda_id != null ? Number(r.pp_comanda_id) : null,
            palmare: r.palmare === true,
            error: r.error ?? null,
        });
    } catch { /* l'etichetta nel palmare non ferma il giro */ }
}

const ultimaLetturaChiuse = new Map<number, number>();

/** Gli ordini del CRM la cui comanda la cassa ha chiuso dal suo schermo
 *  (fase 4, collaudo sulla demo del 08/10: prima l'ordine restava aperto nel
 *  CRM). Una lettura delle comande aperte ogni tanto; una comanda che non
 *  c'è più si rilegge, e se è pagata o sparita l'ordine si chiude. */
export async function chiuseInCassa(tenantId: number): Promise<number> {
    if (!deps) return 0;
    const ultima = ultimaLetturaChiuse.get(tenantId) ?? 0;
    if (Date.now() - ultima < CHIUSE_IN_CASSA_OGNI_MS()) return 0;
    const rs = await queryWithRetry(
        `SELECT v.order_id, v.pp_comanda_id
           FROM passepartout_comande_vive v
           JOIN orders o ON o.id = v.order_id AND o.tenant_id = v.tenant_id
          WHERE v.tenant_id = $1 AND v.stato = 'SCRITTA' AND v.pp_comanda_id IS NOT NULL AND o.status = 'OPEN'`,
        [tenantId]
    );
    if (rs.rows.length === 0) return 0;
    ultimaLetturaChiuse.set(tenantId, Date.now());
    const aperte = await callPassepartout<PassepartoutComandaAperta[]>(tenantId, 'comandeAperte', {}, 60_000);
    const ids = new Set((aperte ?? []).map((c) => Number(c.idComanda)));
    let chiusi = 0;
    for (const r of rs.rows) {
        const idComanda = Number(r.pp_comanda_id);
        if (ids.has(idComanda)) continue;
        // Non fra le aperte: si rilegge, per non chiudere per una lettura storta.
        const c = await callPassepartout<PassepartoutComanda | null>(tenantId, 'comanda', { idGestionale: idComanda }, 30_000);
        if (c && !c.isPagato) continue;
        const orderId = Number(r.order_id);
        if (await deps.chiudiOrdineChiusoInCassa(tenantId, orderId)) chiusi++;
        await segna(tenantId, orderId, { stato: 'CHIUSA' });
    }
    return chiusi;
}

/** Una passata sugli ordini di un ristorante, DENTRO il suo contesto tenant. */
export async function lavoraComandeVive(tenantId: number, soloOrdine: number | null = null): Promise<number> {
    if (!(await isFeatureEnabledForTenant(tenantId, 'passepartout'))) return 0;
    if (!passepartoutAgentSupports(tenantId, CAPACITA)) return 0;
    if (deps && await deps.nodeOwnsBills(tenantId)) return 0;
    try {
        await chiuseInCassa(tenantId);
    } catch (err: any) {
        // Agente giù o vecchio: ci si riprova al giro dopo.
        if (!(err instanceof PassepartoutBridgeError)) console.error('[passepartout] comande vive, chiuse in cassa:', err?.message || err);
    }
    const cfg = await configVive(tenantId);
    if (!cfg) return 0;
    const ordini = await ordiniDaGuardare(tenantId, soloOrdine);
    if (ordini.length === 0) return 0;
    const { righe, scritte } = await righeDegliOrdini(tenantId, ordini.map((o: any) => Number(o.order_id)));

    // «Stampa: la cassa» con un agente che sa mandare in produzione.
    const invioDallaCassa = (cfg.comande_stampa ?? 'cassa') === 'cassa' && passepartoutAgentSupports(tenantId, CAPACITA_INVIO);

    let scritti = 0;
    for (const o of ordini) {
        const orderId = Number(o.order_id);
        const aperto = o.status === 'OPEN';
        const palmare = o.palmare === true;
        const desiderate = o.status === 'OPEN' || o.status === 'CLOSED'
            ? righeDesiderate(righe.get(orderId) ?? [], Number(o.covers) || 0, palmare)
            : [];
        const giaScritte: Scritta[] = (scritte.get(orderId) ?? []).map((s: any) => ({
            chiave: s.chiave,
            pp_riga_id: s.pp_riga_id != null ? Number(s.pp_riga_id) : null,
            pezzi_scritti: Number(s.pezzi_scritti),
            prezzo_cents_scritto: s.prezzo_cents_scritto != null ? Number(s.prezzo_cents_scritto) : null,
            sparita: s.sparita === true,
            inviata: s.inviata === true,
            stampata_crm: s.stampata_crm === true,
        }));
        const daScrivere = differenza(desiderate, giaScritte);
        // Le uscite lanciate da mandare dalla cassa; quelle già del CRM le
        // stampa il CRM, subito.
        const invio = aperto && invioDallaCassa ? usciteDaInviare(desiderate, giaScritte) : { cassa: [], crm: [] };
        if (invio.crm.length > 0 && deps) {
            try { await deps.stampaDalCrm(tenantId, orderId, invio.crm); } catch (err: any) {
                console.error('[passepartout] comande vive, stampa dal CRM:', err?.message || err);
            }
        }
        if (daScrivere.length === 0 && invio.cassa.length === 0) {
            // Allineato: un ordine chiuso o cancellato nel CRM ha finito.
            if (o.v_order != null && (!aperto || o.v_stato === 'PENDING')) {
                await segna(tenantId, orderId, { stato: aperto ? 'SCRITTA' : 'CHIUSA' });
            }
            continue;
        }
        // Un ordine mai scritto in cassa che nel frattempo si è chiuso non ci
        // va più (la riga può esserci già: la crea anche la stampa del CRM).
        if (o.pp_comanda_id == null && !aperto) {
            if (o.v_order != null && o.v_stato !== 'CHIUSA') await segna(tenantId, orderId, { stato: 'CHIUSA' });
            continue;
        }
        if (!o.pp_tavolo && o.pp_comanda_id == null) continue;

        // Claim: vince chi incrementa per primo (due processi durante un
        // deploy, o un giro che si accavalla al successivo).
        await queryWithRetry(
            `INSERT INTO passepartout_comande_vive (tenant_id, order_id, table_id) VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, order_id) DO NOTHING`,
            [tenantId, orderId, o.table_id]
        );
        const claim = await queryWithRetry(
            `UPDATE passepartout_comande_vive SET attempts = attempts + 1, next_at = now() + interval '3 minutes', updated_at = now()
              WHERE tenant_id = $1 AND order_id = $2 AND stato IN ('PENDING', 'SCRITTA') AND attempts = $3
              RETURNING attempts`,
            [tenantId, orderId, Number(o.attempts) || 0]
        );
        if ((claim.rowCount ?? 0) === 0) continue;
        const tentativi = Number(claim.rows[0].attempts);

        const params: ParametriComandaViva = {
            tag: tag(orderId),
            idComanda: o.pp_comanda_id != null ? Number(o.pp_comanda_id) : null,
            sala: String(o.pp_sala ?? ''),
            // Un ordine cancellato su un tavolo non più abbinato: la comanda
            // si ritrova dal suo numero, il tavolo serve solo alla fila.
            tavolo: String(o.pp_tavolo ?? `comanda-${o.pp_comanda_id}`),
            coperti: Number(o.covers) || 0,
            righe: daScrivere.map(({ orderItemId: _oi, lanciata: _l, ...r }) => r),
            idArticoloGenerico: cfg.articolo_generico_id != null ? Number(cfg.articolo_generico_id) : null,
            ...(invio.cassa.length > 0 ? { inviaUscite: invio.cassa } : {}),
        };
        try {
            const esito = await callPassepartout<EsitoComandaViva>(tenantId, 'comandaViva', params as unknown as Record<string, unknown>, 120_000);
            // Comanda chiusa in cassa: non si è scritto niente.
            const nonTrovate = esito.chiusa ? [] : await registra(tenantId, orderId, daScrivere, esito);
            if (!esito.chiusa && (esito.inviate?.length ?? 0) > 0) await segnaInviate(tenantId, orderId, desiderate, esito.inviate!);
            // Un ordine chiuso o cancellato nel CRM, allineato con questa
            // scrittura, ha finito: nessun altro giro deve riguardarlo.
            const stato: StatoComandaViva['stato'] = esito.chiusa
                ? 'CHIUSA'
                : nonTrovate.length > 0 ? 'FAILED' : aperto ? 'SCRITTA' : 'CHIUSA';
            const errore = esito.chiusa && daScrivere.some((d) => !d.cancella)
                ? 'La comanda è chiusa in cassa: le righe nuove non ci sono andate'
                : nonTrovate.length > 0
                    ? `Righe scritte in cassa ma non ritrovate (${nonTrovate.join(', ')}): controllale in cassa prima di riprovare`
                    : null;
            const rs = await queryWithRetry(
                `UPDATE passepartout_comande_vive
                    SET pp_comanda_id = COALESCE($3, pp_comanda_id), palmare = $4, stato = $5, error = $6,
                        attempts = 0, next_at = now(), updated_at = now()
                  WHERE tenant_id = $1 AND order_id = $2
                  RETURNING order_id, stato, pp_comanda_id, palmare, error`,
                [tenantId, orderId, esito.idComanda, esito.idComanda != null ? esito.palmare === true : palmare, stato, errore]
            );
            if (rs.rows[0]) avvisa(tenantId, rs.rows[0]);
            scritti++;
        } catch (err: any) {
            const messaggio = String(err?.message ?? err).slice(0, 500);
            // Agente spento o lento: non è colpa dell'ordine, si aspetta
            // senza contare il tentativo. Se l'agente ha scritto e la
            // risposta si è persa, il tentativo dopo ritrova le righe.
            const attesa = err instanceof PassepartoutBridgeError && (err.kind === 'agent_offline' || err.kind === 'timeout');
            const fallito = messaggio.includes(SENZA_ARTICOLO) || (!attesa && tentativi >= MAX_TENTATIVI);
            const minuti = attesa ? 1 : Math.min(15, 2 ** Math.max(0, tentativi - 1));
            const rs = await queryWithRetry(
                `UPDATE passepartout_comande_vive
                    SET stato = CASE WHEN $3::boolean THEN 'FAILED' ELSE 'PENDING' END,
                        attempts = CASE WHEN $4::boolean THEN attempts - 1 ELSE attempts END,
                        next_at = now() + make_interval(mins => $5::int),
                        error = $6, updated_at = now()
                  WHERE tenant_id = $1 AND order_id = $2
                  RETURNING order_id, stato, pp_comanda_id, palmare, error`,
                [tenantId, orderId, fallito, attesa && !fallito, minuti, messaggio]
            );
            if (rs.rows[0]) avvisa(tenantId, rs.rows[0]);
        }
    }
    return scritti;
}

/** Gli id delle righe in cassa, scritti nella stessa transazione. Torna le
 *  righe aggiunte di cui la cassa non ha restituito l'id: riprovare le
 *  scriverebbe due volte, quindi l'ordine si ferma (FAILED). */
async function registra(tenantId: number, orderId: number, inviate: Desiderata[], esito: EsitoComandaViva): Promise<string[]> {
    const perChiave = new Map(inviate.map((d) => [d.chiave, d]));
    const nonTrovate: string[] = [];
    await withTenant(tenantId, async (client) => {
        for (const r of esito.righe ?? []) {
            const d = perChiave.get(r.chiave);
            if (!d || r.saltata) continue;
            if (r.cancellata) {
                await client.query(
                    `DELETE FROM passepartout_righe_vive WHERE tenant_id = $1 AND order_id = $2 AND chiave = $3`,
                    [tenantId, orderId, r.chiave]
                );
                continue;
            }
            if (r.sparita) {
                await client.query(
                    `UPDATE passepartout_righe_vive SET sparita = true, updated_at = now()
                      WHERE tenant_id = $1 AND order_id = $2 AND chiave = $3`,
                    [tenantId, orderId, r.chiave]
                );
                continue;
            }
            if (r.idRiga == null) { nonTrovate.push(d.descrizione || r.chiave); continue; }
            await client.query(
                `INSERT INTO passepartout_righe_vive
                    (tenant_id, order_id, chiave, order_item_id, pp_riga_id, pezzi_scritti, prezzo_cents_scritto, inviata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (tenant_id, order_id, chiave) DO UPDATE
                    SET order_item_id = EXCLUDED.order_item_id, pp_riga_id = EXCLUDED.pp_riga_id,
                        pezzi_scritti = EXCLUDED.pezzi_scritti, prezzo_cents_scritto = EXCLUDED.prezzo_cents_scritto,
                        inviata = EXCLUDED.inviata, updated_at = now()`,
                [tenantId, orderId, r.chiave, d.orderItemId, r.idRiga, d.pezzi, d.prezzoCents, STATI_INVIATA.has(r.statoEnum ?? '')]
            );
        }
    });
    return nonTrovate;
}

/** Le righe lanciate delle uscite che la cassa ha appena mandato. */
async function segnaInviate(tenantId: number, orderId: number, desiderate: Desiderata[], uscite: number[]): Promise<void> {
    const chiavi = desiderate.filter((d) => d.lanciata && uscite.includes(d.uscita)).map((d) => d.chiave);
    if (chiavi.length === 0) return;
    await queryWithRetry(
        `UPDATE passepartout_righe_vive SET inviata = true, updated_at = now()
          WHERE tenant_id = $1 AND order_id = $2 AND chiave = ANY($3::text[]) AND NOT stampata_crm`,
        [tenantId, orderId, chiavi]
    );
}

/** Il ripiego: righe lanciate da più di un attimo che la cassa non ha
 *  mandato (agente giù, ordine fermo o non ancora scritto) le stampa il
 *  CRM. Gira anche senza agente collegato: è proprio il caso. */
export async function stampeDiRipiego(tenantId: number): Promise<number> {
    if (!deps) return 0;
    const rs = await queryWithRetry(
        `SELECT oi.order_id, array_agg(oi.id ORDER BY oi.id) AS ids
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id AND o.tenant_id = oi.tenant_id
           JOIN passepartout_config pc ON pc.tenant_id = o.tenant_id
           LEFT JOIN passepartout_comande_vive v ON v.tenant_id = o.tenant_id AND v.order_id = o.id
           LEFT JOIN passepartout_righe_vive rv ON rv.tenant_id = oi.tenant_id AND rv.order_id = oi.order_id AND rv.chiave = 'oi:' || oi.id
          WHERE oi.tenant_id = $1 AND o.status = 'OPEN' AND o.order_type = 'DINE_IN'
            AND pc.comande_stampa = 'cassa'
            AND oi.line_kind = 'DISH' AND oi.status NOT IN ('DRAFT', 'VOIDED')
            AND oi.fired_at IS NOT NULL AND oi.fired_at < now() - make_interval(secs => $2::double precision)
            AND NOT COALESCE(rv.inviata, false) AND NOT COALESCE(rv.stampata_crm, false)
            -- Non mentre una scrittura va a buon fine (il claim sposta next_at
            -- avanti): la cassa potrebbe star mandando proprio quell'uscita.
            -- Dopo un errore della cassa si stampa subito, senza aspettare
            -- il prossimo tentativo.
            AND (v.order_id IS NULL OR v.next_at <= now() OR v.stato = 'FAILED' OR v.error IS NOT NULL)
            AND (
                v.order_id IS NOT NULL
                OR (pc.comande_vive_enabled AND o.opened_at >= COALESCE(pc.comande_vive_dal, now())
                    AND EXISTS (SELECT 1 FROM passepartout_tavoli pt
                                 WHERE pt.tenant_id = o.tenant_id AND pt.table_id = o.table_id AND pt.confermato))
            )
          GROUP BY oi.order_id`,
        [tenantId, STAMPA_DI_RIPIEGO_DOPO_MS() / 1000]
    );
    let stampate = 0;
    for (const r of rs.rows) {
        try {
            await deps.stampaDalCrm(tenantId, Number(r.order_id), (r.ids as number[]).map(Number));
            stampate += (r.ids as number[]).length;
        } catch (err: any) {
            console.error('[passepartout] comande vive, stampa di ripiego:', err?.message || err);
        }
    }
    return stampate;
}

/** «Riprova» su un ordine fermo (FAILED): torna in coda. */
export async function riprovaComandaViva(tenantId: number, orderId: number): Promise<boolean> {
    const rs = await queryWithRetry(
        `UPDATE passepartout_comande_vive SET stato = 'PENDING', attempts = 0, next_at = now(), error = NULL, updated_at = now()
          WHERE tenant_id = $1 AND order_id = $2 AND stato = 'FAILED'
          RETURNING order_id, stato, pp_comanda_id, palmare, error`,
        [tenantId, orderId]
    );
    if (rs.rows[0]) avvisa(tenantId, rs.rows[0]);
    return (rs.rowCount ?? 0) > 0;
}

/** Lo stato in cassa degli ordini indicati, per l'etichetta nel palmare. */
export async function statiComandeVive(tenantId: number, orderIds: number[]): Promise<StatoComandaViva[]> {
    if (orderIds.length === 0) return [];
    const rs = await queryWithRetry(
        `SELECT order_id, stato, pp_comanda_id, palmare, error FROM passepartout_comande_vive
          WHERE tenant_id = $1 AND order_id = ANY($2::int[])`,
        [tenantId, orderIds]
    );
    return rs.rows.map((r: any) => ({
        order_id: Number(r.order_id),
        stato: r.stato,
        pp_comanda_id: r.pp_comanda_id != null ? Number(r.pp_comanda_id) : null,
        palmare: r.palmare === true,
        error: r.error ?? null,
    }));
}

/** Le stampe di ripiego in tutti i ristoranti con «stampa: la cassa»,
 *  agente collegato o no. */
async function ripieghi(): Promise<void> {
    // rls-bypass: solo l'elenco dei ristoranti con «stampa: la cassa» e ordini in cassa possibili; ognuno si lavora nel suo contesto tenant
    const rs = await runAsPlatform(() => queryWithRetry(
        `SELECT tenant_id FROM passepartout_config WHERE comande_stampa = 'cassa'
            AND (comande_vive_enabled OR EXISTS (SELECT 1 FROM passepartout_comande_vive v
                                                  WHERE v.tenant_id = passepartout_config.tenant_id AND v.stato IN ('PENDING', 'SCRITTA', 'FAILED')))`
    ));
    for (const row of rs.rows) {
        const tenantId = Number(row.tenant_id);
        try {
            await runWithTenantContext(tenantId, async () => {
                if (!(await isFeatureEnabledForTenant(tenantId, 'passepartout'))) return;
                if (deps && await deps.nodeOwnsBills(tenantId)) return;
                await stampeDiRipiego(tenantId);
            });
        } catch (err: any) {
            console.error('[passepartout] comande vive, ripiego:', err?.message || err);
        }
    }
}

// Un giro alla volta per ristorante in questo processo: una rotta che
// avvisa mentre il giro lavora chiede un altro giro alla fine, invece di
// partirne uno accanto.
const inCorso = new Map<number, boolean>();

async function lavoraInFila(tenantId: number): Promise<void> {
    if (inCorso.has(tenantId)) { inCorso.set(tenantId, true); return; }
    try {
        do {
            inCorso.set(tenantId, false);
            await runWithTenantContext(tenantId, async () => {
                await lavoraComandeVive(tenantId);
                await stampeDiRipiego(tenantId);
            });
        } while (inCorso.get(tenantId));
    } catch (err: any) {
        console.error('[passepartout] comande vive:', err?.message || err);
    } finally {
        inCorso.delete(tenantId);
    }
}

/** Subito dopo una modifica di un ordine: non si aspetta il giro. */
export function avviaComandeVive(tenantId: number): void {
    setImmediate(() => { void lavoraInFila(tenantId); });
}

let timer: ReturnType<typeof setInterval> | null = null;
let giroInCorso = false;

export function startPassepartoutComandeVive(d: ComandeViveDeps): void {
    deps = d;
    if (timer) return;
    const ms = Number(process.env.PASSEPARTOUT_COMANDE_VIVE_SWEEP_MS) || 20_000;
    timer = setInterval(() => {
        void giro().catch((err) => console.error('[passepartout] comande vive:', err?.message || err));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
}

async function giro(): Promise<void> {
    if (giroInCorso) return;
    giroInCorso = true;
    try {
        await ripieghi();
        const pronti = connectedPassepartoutTenants().filter((t) => passepartoutAgentSupports(t, CAPACITA));
        if (pronti.length === 0) return;
        // rls-bypass: solo l'elenco dei ristoranti con le comande in cassa accese o ancora da chiudere; ognuno si lavora nel suo contesto tenant
        const rs = await runAsPlatform(() => queryWithRetry(
            `SELECT tenant_id FROM passepartout_config WHERE comande_vive_enabled AND tenant_id = ANY($1::bigint[])
             UNION
             SELECT DISTINCT tenant_id FROM passepartout_comande_vive
              WHERE stato IN ('PENDING', 'SCRITTA') AND tenant_id = ANY($1::bigint[])`,
            [pronti]
        ));
        for (const row of rs.rows) await lavoraInFila(Number(row.tenant_id));
    } finally {
        giroInCorso = false;
    }
}
