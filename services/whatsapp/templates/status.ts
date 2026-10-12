// Lo stato dei template di un ristorante, per la scheda «Template» delle
// Impostazioni: quali ci sono, in quale lingua, e se Meta li ha approvati.
//
// Una SID mancante oggi non si vede da nessuna parte: il messaggio scende
// su SMS senza dirlo, e ci si accorge del template mai incollato su Railway
// solo leggendo le conversazioni. Qui ogni riga del catalogo dice se la SID
// c'è e, chiedendolo a Twilio, se l'approvazione è arrivata.

import { getSender } from '../config.js';
import { queryWithRetry } from '../../../db.js';
import type { TwilioSender } from '../types.js';
import { TEMPLATE_CATALOG, templateEnvKey, type TemplateDef, type TemplateLanguage } from './catalog.js';
import { META_TEMPLATES } from './metaCatalog.js';
import { writesFromEnvTwilio } from './registry.js';

export type ApprovalStatus = 'approved' | 'pending' | 'rejected' | 'unsubmitted' | 'unknown';

export interface TemplateLanguageStatus {
    language: TemplateLanguage;
    configured: boolean;
    approval: ApprovalStatus | null;
    rejectionReason: string | null;
}

export interface TemplateStatusRow {
    key: string;
    label: string;
    group: TemplateDef['group'];
    category: TemplateDef['category'];
    languages: TemplateLanguageStatus[];
}

// L'approvazione cambia di rado (ore o giorni): dieci minuti di memoria
// evitano trenta chiamate a Twilio a ogni apertura della scheda.
const approvalCache = new Map<string, { status: ApprovalStatus; reason: string | null; at: number }>();
const APPROVAL_TTL_MS = 10 * 60_000;

const contentBase = (env: NodeJS.ProcessEnv = process.env): string =>
    (env.TWILIO_CONTENT_URL || 'https://content.twilio.com').replace(/\/+$/, '');

async function twilioApproval(sender: TwilioSender, sid: string): Promise<{ status: ApprovalStatus; reason: string | null }> {
    const cached = approvalCache.get(sid);
    if (cached && Date.now() - cached.at <= APPROVAL_TTL_MS) return cached;
    try {
        const auth = Buffer.from(`${sender.accountSid}:${sender.authToken}`).toString('base64');
        const res = await fetch(`${contentBase()}/v1/Content/${encodeURIComponent(sid)}/ApprovalRequests`, {
            headers: { Authorization: `Basic ${auth}` },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json().catch(() => ({})) as any;
        const raw = String(body?.whatsapp?.status ?? '').toLowerCase();
        const status: ApprovalStatus = raw === 'approved' || raw === 'pending' || raw === 'rejected' || raw === 'unsubmitted'
            ? raw
            : (raw === 'received' ? 'pending' : 'unknown');
        const reason = typeof body?.whatsapp?.rejection_reason === 'string' && body.whatsapp.rejection_reason.trim()
            ? body.whatsapp.rejection_reason.trim()
            : null;
        const entry = { status, reason, at: Date.now() };
        approvalCache.set(sid, entry);
        return entry;
    } catch (err: any) {
        console.warn(`[whatsapp] stato approvazione di ${sid} non letto:`, err?.message || err);
        return cached ?? { status: 'unknown', reason: null };
    }
}

// Lo stato di Meta (whatsapp_templates.status) come lo mostra la scheda.
// FLAGGED parte ancora, ma Meta lo sta guardando: lo si dice nel motivo.
function metaApproval(status: string | undefined, reason: string | null): { approval: ApprovalStatus; reason: string | null } {
    switch (status) {
        case undefined: return { approval: 'unsubmitted', reason: null };
        case 'APPROVED': return { approval: 'approved', reason: null };
        case 'FLAGGED': return { approval: 'approved', reason: reason ?? 'Qualità bassa: Meta potrebbe metterlo in pausa' };
        case 'PENDING': case 'IN_APPEAL': return { approval: 'pending', reason: null };
        case 'PAUSED': return { approval: 'rejected', reason: reason ?? 'In pausa: Meta l\'ha fermato per la qualità' };
        case 'REJECTED': case 'DISABLED': return { approval: 'rejected', reason };
        // ERROR: non è arrivato a Meta, il tasto della scheda lo rimanda.
        case 'ERROR': return { approval: 'unsubmitted', reason };
        default: return { approval: 'unknown', reason };
    }
}

async function metaTemplateStatus(tenantId: number): Promise<TemplateStatusRow[]> {
    const rows = (await queryWithRetry(
        `SELECT template_key, language, status, reason FROM whatsapp_templates WHERE tenant_id = $1`, [tenantId]
    )).rows;
    const byKey = new Map(rows.map(r => [`${r.template_key}:${r.language}`, r]));
    // Il conto al tavolo con la scheda e la richiesta di recensione non
    // esistono su Meta (metaCatalog.ts): mostrarli come «non impostati»
    // inviterebbe a cercarli.
    return TEMPLATE_CATALOG.filter(def => META_TEMPLATES[def.key]).map(def => ({
        key: def.key,
        label: def.label,
        group: def.group,
        category: def.category,
        languages: (['it', 'en'] as const).filter(language => META_TEMPLATES[def.key]?.[language]).map(language => {
            const row = byKey.get(`${def.key}:${language}`);
            const { approval, reason } = metaApproval(row?.status, row?.reason ?? null);
            return { language, configured: true, approval, rejectionReason: reason };
        }),
    }));
}

/** Il catalogo con lo stato di ogni template per il ristorante. */
export async function templateStatus(tenantId: number, env: NodeJS.ProcessEnv = process.env): Promise<TemplateStatusRow[]> {
    const usesEnv = writesFromEnvTwilio(tenantId, env);
    const sender = await getSender(tenantId);
    if (!usesEnv && sender?.provider === 'meta') return metaTemplateStatus(tenantId);
    return Promise.all(TEMPLATE_CATALOG.map(async def => ({
        key: def.key,
        label: def.label,
        group: def.group,
        category: def.category,
        languages: await Promise.all(def.languages.map(async (language): Promise<TemplateLanguageStatus> => {
            const sid = usesEnv ? env[templateEnvKey(def.key, language)] : undefined;
            if (!sid) return { language, configured: false, approval: null, rejectionReason: null };
            if (sender?.provider !== 'twilio') return { language, configured: true, approval: 'unknown', rejectionReason: null };
            const { status, reason } = await twilioApproval(sender, sid);
            return { language, configured: true, approval: status, rejectionReason: reason };
        })),
    })));
}
