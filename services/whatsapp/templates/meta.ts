// I template Meta dei locali in memoria, e il messaggio che li usa.
//
// pickTemplate è sincrona (i builder di server.ts lo sono, e la chiamano in
// una ventina di punti), quindi sapere se un template è approvato non può
// costare una query: le righe di whatsapp_templates stanno qui, caricate
// all'avvio e ogni cinque minuti, e aggiornate subito da chi le cambia in
// questo processo (collegamento, approvazione via webhook, scollegamento).
// Il giro dei cinque minuti serve solo a una seconda replica.
//
// Ai builder il template Meta arriva come un riferimento al posto della SID
// Twilio, `meta:<chiave>:<lingua>`, con le stesse variabili di sempre: è
// sendWhatsAppText che, vedendo il numero Meta, ne fa il messaggio.

import { queryWithRetry, runAsPlatform } from '../../../db.js';
import type { TemplateLanguage } from './catalog.js';
import { metaSpec, type MetaTemplateSpec } from './metaCatalog.js';

interface CachedTemplate {
    name: string;
    status: string;
}

const cache = new Map<number, Map<string, CachedTemplate>>();
const slot = (key: string, language: string) => `${key}:${language}`;

/** Gli stati con cui un template parte: FLAGGED è approvato ma con
 *  qualità bassa, e Meta lo manda finché non lo mette in pausa. */
export const SENDABLE_STATUSES = new Set(['APPROVED', 'FLAGGED']);

export function cachedMetaTemplate(tenantId: number, key: string, language: string): CachedTemplate | undefined {
    return cache.get(tenantId)?.get(slot(key, language));
}

export function isMetaTemplateSendable(tenantId: number, key: string, language: TemplateLanguage): boolean {
    const row = cachedMetaTemplate(tenantId, key, language);
    return !!row && SENDABLE_STATUSES.has(row.status) && !!metaSpec(key, language);
}

/** Ricarica le righe di un locale, o di tutti. */
export async function loadMetaTemplates(tenantId?: number): Promise<void> {
    const rows = tenantId == null
        // rls-bypass: la memoria dei template serve a tutti i locali, letta una volta per processo
        ? (await runAsPlatform(() => queryWithRetry(`SELECT tenant_id, template_key, language, name, status FROM whatsapp_templates`, []))).rows
        : (await queryWithRetry(`SELECT tenant_id, template_key, language, name, status FROM whatsapp_templates WHERE tenant_id = $1`, [tenantId])).rows;
    const next = new Map<number, Map<string, CachedTemplate>>();
    for (const r of rows) {
        const t = Number(r.tenant_id);
        if (!next.has(t)) next.set(t, new Map());
        next.get(t)!.set(slot(String(r.template_key), String(r.language)), { name: String(r.name), status: String(r.status) });
    }
    if (tenantId == null) {
        cache.clear();
        for (const [t, m] of next) cache.set(t, m);
    } else if (next.has(tenantId)) {
        cache.set(tenantId, next.get(tenantId)!);
    } else {
        cache.delete(tenantId);
    }
}

const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 30_000;

/** All'avvio, dopo le migrazioni: subito, poi ogni cinque minuti. */
export function startMetaTemplateCache(): void {
    const tick = () => {
        loadMetaTemplates()
            .then(() => setTimeout(tick, REFRESH_MS))
            .catch((err: any) => {
                console.error('[whatsapp] template Meta non caricati:', err?.message || err);
                setTimeout(tick, RETRY_MS);
            });
    };
    tick();
}

// ---------------------------------------------------------------------------
// Il riferimento che viaggia al posto della SID
// ---------------------------------------------------------------------------

const REF_PREFIX = 'meta:';

export const metaTemplateRef = (key: string, language: TemplateLanguage): string => `${REF_PREFIX}${key}:${language}`;

export function parseMetaTemplateRef(ref: string): { key: string; language: TemplateLanguage } | null {
    if (!ref.startsWith(REF_PREFIX)) return null;
    const [key, language] = ref.slice(REF_PREFIX.length).split(':');
    if (!key || (language !== 'it' && language !== 'en')) return null;
    return { key, language };
}

// ---------------------------------------------------------------------------
// Il messaggio
// ---------------------------------------------------------------------------

export interface MetaTemplateMessage {
    name: string;
    language: { code: string };
    components: Array<Record<string, unknown>>;
}

// Meta rifiuta i parametri con a capo, tabulazioni o più di quattro spazi
// di fila (il testo di una campagna può averne), e quelli vuoti.
const param = (value: string | undefined): string =>
    String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim() || '—';

/** Il template come lo vuole POST /{phone_number_id}/messages, dalle
 *  variabili numerate come per Twilio. */
export function buildMetaTemplateMessage(spec: MetaTemplateSpec, language: TemplateLanguage, vars: Record<string, string>): MetaTemplateMessage {
    const components: Array<Record<string, unknown>> = [];
    if (spec.bodyVars.length) {
        components.push({ type: 'body', parameters: spec.bodyVars.map(v => ({ type: 'text', text: param(vars[v]) })) });
    }
    (spec.buttons ?? []).forEach((b, index) => {
        if (b.type === 'QUICK_REPLY') {
            components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: b.payload }] });
        } else {
            components.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: param(vars[b.urlVar]) }] });
        }
    });
    return { name: spec.name, language: { code: language }, components };
}
