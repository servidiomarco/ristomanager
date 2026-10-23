// ============================================
// Fatture fornitori via email (Fase 2, PR 3)
// ============================================
// Ogni locale ha un indirizzo suo sul dominio di piattaforma
// (utils/fattureEmail.ts). Resend riceve l'email, ci chiama col webhook
// `email.received` (POST /webhook/fatture-email, in server.ts accanto
// all'altro webhook di Resend) e noi scarichiamo gli allegati: XML, p7m e zip
// passano da apriFile/importaXml come un caricamento a mano e finiscono «da
// controllare». Se il fornitore ha il carico automatico e tutte le righe sono
// già note, la fattura si carica da sola. In ogni caso arriva una push a chi
// vede le fatture.
//
// Configurazione di piattaforma, non per locale (vedi docs/fatture-email.md):
//   FATTURE_EMAIL_DOMAIN           il dominio di ricezione (fatture.sympotia.com)
//   RESEND_FATTURE_API_KEY         la chiave Resend dell'account che riceve
//   RESEND_FATTURE_WEBHOOK_SECRET  il segreto Svix del webhook (whsec_…)
//   RESEND_FATTURE_API_URL         solo per i test (di serie https://api.resend.com)
// Senza le prime tre l'indirizzo non compare e il webhook risponde 503.

import express from 'express';
import { randomBytes } from 'node:crypto';
import { queryWithRetry, runWithTenantContext } from '../db.js';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';
import { sendToRoles as pushSendToRoles } from './pushService.js';
import { apriFile } from '../utils/fatturaPa.js';
import {
    TOKEN_LENGTH,
    allegatoFattura,
    indirizzoFatture,
    soloIndirizzo,
    tokenDaDestinatari,
} from '../utils/fattureEmail.js';
import {
    caricaAutomaticamente,
    importaXml,
    type EsitoFile,
    type FattureFornitoriDeps,
} from './fattureFornitoriRoutes.js';

export interface FattureEmailConfig {
    dominio: string;
    apiKey: string;
    webhookSecret: string;
    apiBase: string;
}

export const fattureEmailConfig = (): FattureEmailConfig | null => {
    const dominio = (process.env.FATTURE_EMAIL_DOMAIN || '').trim().toLowerCase();
    const apiKey = (process.env.RESEND_FATTURE_API_KEY || '').trim();
    const webhookSecret = (process.env.RESEND_FATTURE_WEBHOOK_SECRET || '').trim();
    if (!dominio || !apiKey || !webhookSecret) return null;
    const apiBase = (process.env.RESEND_FATTURE_API_URL || 'https://api.resend.com').trim().replace(/\/$/, '');
    return { dominio, apiKey, webhookSecret, apiBase };
};

// Limiti: un'email di un commercialista con lo zip del mese sta comodamente
// sotto; oltre è quasi sempre altro (foto, cataloghi) e non si scarica.
const MAX_ALLEGATI = 20;
const MAX_BYTES_ALLEGATO = 25 * 1024 * 1024;

// 36^12: un indirizzo non si indovina provando.
const nuovoToken = (): string => {
    const alfabeto = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = randomBytes(TOKEN_LENGTH * 2);
    let out = '';
    for (const b of bytes) {
        // 252 = 7×36: si scartano i byte che darebbero un alfabeto sbilanciato.
        if (b >= 252) continue;
        out += alfabeto[b % 36];
        if (out.length === TOKEN_LENGTH) break;
    }
    return out.length === TOKEN_LENGTH ? out : nuovoToken();
};

/** L'indirizzo del locale; il token nasce alla prima lettura. */
export async function indirizzoDelLocale(tenantId: number, cfg: FattureEmailConfig, rigenera = false): Promise<string> {
    const t = await queryWithRetry(`SELECT slug, fatture_email_token FROM tenants WHERE id = $1`, [tenantId]);
    if (!t.rowCount) throw new Error('Locale non trovato');
    let token: string | null = t.rows[0].fatture_email_token;
    if (!token || rigenera) {
        token = nuovoToken();
        await queryWithRetry(`UPDATE tenants SET fatture_email_token = $2 WHERE id = $1`, [tenantId, token]);
    }
    return indirizzoFatture(t.rows[0].slug, token, cfg.dominio);
}

// ---- Rotte (montate su /fatture-fornitori/email, prima del router delle fatture)

export function createFattureEmailRouter(): express.Router {
    const router = express.Router();
    const guard = [authenticate, requirePermission('inventory:invoices')];

    router.get('/', ...guard, async (req, res) => {
        try {
            const cfg = fattureEmailConfig();
            if (!cfg) return res.json({ attivo: false, indirizzo: null, ricevute: [] });
            const tenantId = req.tenantId!;
            const [indirizzo, ricevute] = await Promise.all([
                indirizzoDelLocale(tenantId, cfg),
                queryWithRetry(
                    `SELECT id, mittente, oggetto, allegati, esito, ricevuta_at
                       FROM fatture_email_ricevute WHERE tenant_id = $1
                      ORDER BY ricevuta_at DESC, id DESC LIMIT 10`,
                    [tenantId],
                ),
            ]);
            res.json({
                attivo: true,
                indirizzo,
                ricevute: ricevute.rows.map(r => ({
                    id: r.id,
                    mittente: r.mittente,
                    oggetto: r.oggetto,
                    allegati: r.allegati,
                    esito: Array.isArray(r.esito) ? r.esito : [],
                    ricevutaAt: new Date(r.ricevuta_at).toISOString(),
                })),
            });
        } catch (err: any) {
            console.error('[fatture-email] GET:', err?.message || err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Un indirizzo finito in mano sbagliata (o pieno di spam) si cambia: il
    // vecchio smette di funzionare subito.
    router.post('/rigenera', ...guard, async (req, res) => {
        try {
            const cfg = fattureEmailConfig();
            if (!cfg) return res.status(503).json({ error: 'Ricezione email non attiva' });
            res.json({ indirizzo: await indirizzoDelLocale(req.tenantId!, cfg, true) });
        } catch (err: any) {
            console.error('[fatture-email] rigenera:', err?.message || err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return router;
}

// ---- Il webhook ---------------------------------------------------------------

interface Allegato {
    nome: string;
    contentType: string | null;
    contenuto: Buffer;
}

const comeLista = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];

async function resendGet(cfg: FattureEmailConfig, path: string): Promise<any> {
    const r = await fetch(`${cfg.apiBase}${path}`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`Resend ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
}

async function scaricaAllegati(cfg: FattureEmailConfig, emailId: string): Promise<{ allegati: Allegato[]; saltati: EsitoFile[] }> {
    const lista = await resendGet(cfg, `/emails/receiving/${encodeURIComponent(emailId)}/attachments`);
    const voci: any[] = Array.isArray(lista?.data) ? lista.data : [];
    const allegati: Allegato[] = [];
    const saltati: EsitoFile[] = [];
    for (const v of voci.slice(0, MAX_ALLEGATI)) {
        const nome = String(v?.filename || 'allegato').split(/[\\/]/).pop()!.slice(0, 255);
        if (typeof v?.size === 'number' && v.size > MAX_BYTES_ALLEGATO) {
            saltati.push({ file: nome, esito: 'scartato', motivo: 'Allegato troppo grande' });
            continue;
        }
        if (typeof v?.download_url !== 'string') continue;
        const r = await fetch(v.download_url, { signal: AbortSignal.timeout(60_000) });
        if (!r.ok) {
            saltati.push({ file: nome, esito: 'scartato', motivo: `Download non riuscito (${r.status})` });
            continue;
        }
        const contenuto = Buffer.from(await r.arrayBuffer());
        if (contenuto.length > MAX_BYTES_ALLEGATO) {
            saltati.push({ file: nome, esito: 'scartato', motivo: 'Allegato troppo grande' });
            continue;
        }
        allegati.push({ nome, contentType: typeof v?.content_type === 'string' ? v.content_type : null, contenuto });
    }
    if (voci.length > MAX_ALLEGATI) {
        saltati.push({ file: `${voci.length - MAX_ALLEGATI} allegati`, esito: 'scartato', motivo: `Oltre i ${MAX_ALLEGATI} per email` });
    }
    return { allegati, saltati };
}

/**
 * Il webhook, già verificato. Trova i locali fra i destinatari, scarica gli
 * allegati una volta sola e li importa per ognuno. Gira dopo la risposta 200
 * (Resend non deve ritentare mentre lavoriamo): gli errori vanno nel log.
 */
export async function gestisciWebhookFatture(payload: any, cfg: FattureEmailConfig, deps: FattureFornitoriDeps): Promise<void> {
    if (payload?.type !== 'email.received') return;
    const emailId = String(payload?.data?.email_id ?? payload?.data?.id ?? '');
    if (!emailId) return;

    // received_for è l'indirizzo che ha ricevuto davvero: in un inoltro
    // automatico «A» resta quello originale (la casella del commercialista) e
    // il nostro compare solo lì, o in copia nascosta.
    let destinatari = [
        ...comeLista(payload?.data?.received_for),
        ...comeLista(payload?.data?.to),
        ...comeLista(payload?.data?.cc),
        ...comeLista(payload?.data?.bcc),
    ];
    let mittente = typeof payload?.data?.from === 'string' ? payload.data.from : '';
    let oggetto = typeof payload?.data?.subject === 'string' ? payload.data.subject : '';
    if (destinatari.length === 0) {
        const full = await resendGet(cfg, `/emails/receiving/${encodeURIComponent(emailId)}`);
        destinatari = [...comeLista(full?.received_for), ...comeLista(full?.to), ...comeLista(full?.cc), ...comeLista(full?.bcc)];
        mittente = mittente || (typeof full?.from === 'string' ? full.from : '');
        oggetto = oggetto || (typeof full?.subject === 'string' ? full.subject : '');
    }
    const token = tokenDaDestinatari(destinatari, cfg.dominio);
    if (token.length === 0) {
        console.warn(`[fatture-email] ${emailId}: nessun indirizzo di ${cfg.dominio} fra i destinatari`);
        return;
    }
    const locali = await queryWithRetry(`SELECT id FROM tenants WHERE fatture_email_token = ANY($1::text[])`, [token]);
    if (!locali.rowCount) {
        console.warn(`[fatture-email] ${emailId}: indirizzo sconosciuto o rigenerato`);
        return;
    }

    const { allegati, saltati } = await scaricaAllegati(cfg, emailId);
    for (const row of locali.rows) {
        const tenantId = Number(row.id);
        await runWithTenantContext(tenantId, () =>
            riceviPerIlLocale(tenantId, { emailId, mittente: soloIndirizzo(mittente), oggetto, allegati, saltati }, deps),
        ).catch((err: any) => console.error(`[fatture-email] locale ${tenantId}:`, err?.message || err));
    }
}

interface EsitoEmail extends EsitoFile {
    /** Caricata in magazzino da sola (carico automatico del fornitore). */
    caricata?: boolean;
    /** Perché il carico automatico non è partito, se il fornitore ce l'ha. */
    nonCaricata?: string;
}

async function riceviPerIlLocale(
    tenantId: number,
    email: { emailId: string; mittente: string; oggetto: string; allegati: Allegato[]; saltati: EsitoFile[] },
    deps: FattureFornitoriDeps,
): Promise<void> {
    // Una riga per email: un webhook ripetuto da Resend non importa due volte.
    const log = await queryWithRetry(
        `INSERT INTO fatture_email_ricevute (tenant_id, resend_id, mittente, oggetto, allegati)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, resend_id) DO NOTHING
         RETURNING id`,
        [tenantId, email.emailId.slice(0, 100), email.mittente.slice(0, 320) || null, email.oggetto.slice(0, 1000) || null,
            email.allegati.length + email.saltati.length],
    );
    if (!log.rowCount) return;
    const logId = Number(log.rows[0].id);

    const esiti: EsitoEmail[] = [...email.saltati];
    // Si aprono gli allegati che possono essere fatture. Se non ce n'è
    // nessuno (il commercialista ha inoltrato solo il PDF) si aprono tutti:
    // apriFile dice «È un PDF, serve l'XML», che è la cosa da sapere.
    const candidati = email.allegati.filter(a => allegatoFattura(a.nome, a.contentType));
    const daAprire = candidati.length ? candidati : email.allegati;
    for (const a of email.allegati) {
        if (!daAprire.includes(a)) esiti.push({ file: a.nome, esito: 'scartato', motivo: 'Non è una fattura (ignorato)' });
    }
    const creatoDa = `Email da ${email.mittente || 'sconosciuto'}`.slice(0, 255);
    for (const a of daAprire) {
        try {
            const { fatture, scartati } = apriFile(a.contenuto, a.nome);
            for (const s of scartati) esiti.push({ file: s.nome, esito: 'scartato', motivo: s.motivo });
            for (const f of fatture) esiti.push(...await importaXml(tenantId, f.nome, f.xml, 'EMAIL', creatoDa));
        } catch (err: any) {
            esiti.push({ file: a.nome, esito: 'scartato', motivo: err?.message || 'File illeggibile' });
        }
    }
    if (email.allegati.length === 0 && email.saltati.length === 0) {
        esiti.push({ file: '', esito: 'scartato', motivo: 'Nessun allegato' });
    }

    // Il carico automatico, fattura per fattura.
    for (const e of esiti) {
        if (e.esito !== 'nuova' || !e.id) continue;
        const auto = await caricaAutomaticamente(tenantId, e.id, deps);
        if (auto.caricata) e.caricata = true;
        else if (auto.motivo) e.nonCaricata = auto.motivo;
    }

    await queryWithRetry(`UPDATE fatture_email_ricevute SET esito = $3 WHERE tenant_id = $1 AND id = $2`,
        [tenantId, logId, JSON.stringify(esiti)]);

    const nuove = esiti.filter(e => e.esito === 'nuova');
    try {
        deps.broadcast(tenantId, 'fatture:changed', { what: 'email' });
    } catch {
        // la pagina si rilegge alla prossima apertura
    }
    if (nuove.length === 0) return;
    await avvisa(tenantId, nuove, logId).catch(err => console.warn('[fatture-email] push:', err?.message || err));
}

async function avvisa(tenantId: number, nuove: EsitoEmail[], logId: number): Promise<void> {
    const ruoli = (await queryWithRetry(
        `SELECT DISTINCT role FROM role_permissions WHERE tenant_id = $1 AND permission = 'inventory:invoices'`,
        [tenantId],
    )).rows.map(r => String(r.role));
    if (ruoli.length === 0) return;
    const caricate = nuove.filter(e => e.caricata);
    const daControllare = nuove.length - caricate.length;
    const chi = (e: EsitoEmail) => `${e.fornitore ?? 'Fornitore'}${e.numero ? ` n. ${e.numero}` : ''}`;
    let title: string;
    let body: string;
    if (nuove.length === 1) {
        const e = nuove[0];
        title = e.caricata ? 'Fattura caricata in magazzino' : 'Fattura da controllare';
        body = e.caricata
            ? `${chi(e)}: arrivata per email e caricata da sola`
            : `${chi(e)}${e.nonCaricata ? ` · ${e.nonCaricata}` : ''}`;
    } else {
        title = `${nuove.length} fatture arrivate per email`;
        body = [
            daControllare ? `${daControllare} da controllare` : null,
            caricate.length ? `${caricate.length} caricate da sole` : null,
        ].filter(Boolean).join(', ');
    }
    await pushSendToRoles(tenantId, ruoli, {
        title,
        body,
        url: '/?view=INVENTARIO',
        tag: `fatture-email-${logId}`,
        category: 'system',
    });
}
