// I template sul numero Meta di un locale: crearli nel suo account
// WhatsApp Business, tenerne lo stato, applicare quello che Meta decide.
//
// - provisionMetaTemplates: al collegamento del numero (e dal tasto della
//   scheda Template) crea i template del catalogo che l'account non ha
//   ancora e li manda in approvazione. Prima legge quelli che ci sono già:
//   ricollegare lo stesso account non li ricrea, ne riprende lo stato.
// - syncMetaTemplates: rilegge lo stato da Meta (scheda Template, se lo
//   stato in memoria è vecchio).
// - applyMetaTemplateUpdates: il webhook message_template_status_update
//   (approvato, rifiutato, in pausa…) e template_category_update.
//
// Le righe stanno in whatsapp_templates; la memoria per pickTemplate
// (templates/meta.ts) si ricarica dopo ogni cambiamento.

import { queryWithRetry, runAsPlatform, runWithTenantContext } from '../../../db.js';
import { metaCreateTemplate, metaListTemplates, type MetaRemoteTemplate, type MetaTemplateUpdate } from '../providers/meta.js';
import type { MetaSender } from '../types.js';
import { TEMPLATE_CATALOG } from './catalog.js';
import { metaSpecList, type MetaTemplateSpec } from './metaCatalog.js';
import { loadMetaTemplates } from './meta.js';

const categoryOf = (key: string): 'UTILITY' | 'MARKETING' =>
    TEMPLATE_CATALOG.find(d => d.key === key)?.category ?? 'UTILITY';

/** Il template come lo vuole POST /{waba_id}/message_templates. */
export function metaTemplateDefinition(key: string, language: string, spec: MetaTemplateSpec): Record<string, unknown> {
    const components: Array<Record<string, unknown>> = [
        { type: 'BODY', text: spec.body, ...(spec.examples.length ? { example: { body_text: [spec.examples] } } : {}) },
    ];
    if (spec.buttons?.length) {
        components.push({
            type: 'BUTTONS',
            buttons: spec.buttons.map(b => b.type === 'QUICK_REPLY'
                ? { type: 'QUICK_REPLY', text: b.text }
                : { type: 'URL', text: b.text, url: b.url, example: [b.example] }),
        });
    }
    return { name: spec.name, language, category: categoryOf(key), components };
}

async function upsertRow(tenantId: number, wabaId: string, key: string, language: string, name: string,
    fields: { externalId?: string | null; category?: string | null; status: string; reason?: string | null }): Promise<void> {
    await queryWithRetry(
        `INSERT INTO whatsapp_templates (tenant_id, provider, template_key, language, name, waba_id, external_id, category, status, reason)
         VALUES ($1, 'meta', $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id, template_key, language) DO UPDATE SET
            name = EXCLUDED.name, waba_id = EXCLUDED.waba_id,
            external_id = COALESCE(EXCLUDED.external_id, whatsapp_templates.external_id),
            category = COALESCE(EXCLUDED.category, whatsapp_templates.category),
            status = EXCLUDED.status, reason = EXCLUDED.reason, updated_at = NOW()`,
        [tenantId, key, language, name, wabaId, fields.externalId ?? null, fields.category ?? null, fields.status, fields.reason ?? null]
    );
}

const remoteKey = (name: string, language: string) => `${name}:${language}`;

export interface ProvisionSummary {
    created: number;
    existing: number;
    failed: number;
}

// Un collegamento e un tasto premuto due volte non devono creare due volte.
const running = new Set<number>();
// L'ultima lettura da Meta per locale: la scheda Template rilegge al più
// ogni dieci minuti (gli stati arrivano comunque dal webhook).
const lastSync = new Map<number, number>();
const SYNC_MS = 10 * 60_000;

/** Crea nell'account del locale i template che mancano. Va chiamata nel
 *  contesto del locale. */
export async function provisionMetaTemplates(tenantId: number, sender: MetaSender): Promise<ProvisionSummary> {
    const summary: ProvisionSummary = { created: 0, existing: 0, failed: 0 };
    if (running.has(tenantId)) return summary;
    running.add(tenantId);
    lastSync.set(tenantId, Date.now());
    try {
        // I template di un account collegato prima non valgono più.
        await queryWithRetry(`DELETE FROM whatsapp_templates WHERE tenant_id = $1 AND waba_id <> $2`, [tenantId, sender.wabaId]);
        const listed = await metaListTemplates(sender);
        if (listed.ok === false) throw new Error(`Meta non dà l'elenco dei template: ${listed.error}`);
        const remote = new Map(listed.templates.map(t => [remoteKey(t.name, t.language), t]));
        for (const { key, language, spec } of metaSpecList()) {
            const found = remote.get(remoteKey(spec.name, language));
            if (found) {
                await upsertRow(tenantId, sender.wabaId, key, language, spec.name, {
                    externalId: found.id, category: found.category, status: found.status, reason: found.rejectedReason,
                });
                summary.existing++;
                continue;
            }
            const created = await metaCreateTemplate(sender, metaTemplateDefinition(key, language, spec));
            if (created.ok === false) {
                // Un errore non è un rifiuto: il template non è arrivato a
                // Meta, e il tasto della scheda lo rimanda.
                console.warn(`[whatsapp] template ${spec.name} (${language}) non creato per il tenant ${tenantId}: ${created.error}`);
                await upsertRow(tenantId, sender.wabaId, key, language, spec.name, { status: 'ERROR', reason: created.error });
                summary.failed++;
                continue;
            }
            await upsertRow(tenantId, sender.wabaId, key, language, spec.name, {
                externalId: created.id, category: created.category, status: created.status,
            });
            summary.created++;
        }
        return summary;
    } finally {
        running.delete(tenantId);
        await loadMetaTemplates(tenantId).catch(() => {});
    }
}

/** Lo stato dei template del locale come lo vede Meta adesso. */
export async function syncMetaTemplates(tenantId: number, sender: MetaSender): Promise<void> {
    const listed = await metaListTemplates(sender);
    if (listed.ok === false) throw new Error(listed.error);
    const remote = new Map<string, MetaRemoteTemplate>(listed.templates.map(t => [remoteKey(t.name, t.language), t]));
    const rows = (await queryWithRetry(
        `SELECT template_key, language, name, status FROM whatsapp_templates WHERE tenant_id = $1 AND waba_id = $2`,
        [tenantId, sender.wabaId]
    )).rows;
    for (const row of rows) {
        const found = remote.get(remoteKey(String(row.name), String(row.language)));
        if (found) {
            await upsertRow(tenantId, sender.wabaId, String(row.template_key), String(row.language), String(row.name), {
                externalId: found.id, category: found.category, status: found.status, reason: found.rejectedReason,
            });
        } else if (row.status !== 'ERROR') {
            // Cancellato dall'account (dal WhatsApp Manager): non parte più.
            await upsertRow(tenantId, sender.wabaId, String(row.template_key), String(row.language), String(row.name), {
                status: 'ERROR', reason: 'Non risulta più fra i template dell\'account su Meta',
            });
        }
    }
    await loadMetaTemplates(tenantId);
}

/** La scheda Template: rilegge da Meta se l'ultima volta è lontana, mai
 *  mentre i template si stanno creando (vedrebbe a metà quelli nuovi). */
export async function syncMetaTemplatesIfStale(tenantId: number, sender: MetaSender): Promise<void> {
    if (running.has(tenantId) || Date.now() - (lastSync.get(tenantId) ?? 0) < SYNC_MS) return;
    lastSync.set(tenantId, Date.now());
    try {
        await syncMetaTemplates(tenantId, sender);
    } catch (err: any) {
        console.warn(`[whatsapp] stato dei template Meta non riletto per il tenant ${tenantId}:`, err?.message || err);
    }
}

/** Il webhook dei template: lo stesso nome può stare in più locali solo se
 *  condividono l'account, quindi si aggiornano tutte le righe che combaciano. */
export async function applyMetaTemplateUpdates(updates: MetaTemplateUpdate[]): Promise<void> {
    for (const u of updates) {
        // rls-bypass: webhook di Meta senza JWT, il locale si ricava dall'account WhatsApp e dal nome del template
        const tenants = await runAsPlatform(async () => (await queryWithRetry(
            `SELECT DISTINCT tenant_id FROM whatsapp_templates WHERE waba_id = $1 AND name = $2 AND language = $3`,
            [u.wabaId, u.name, u.language]
        )).rows.map(r => Number(r.tenant_id)));
        for (const tenantId of tenants) {
            await runWithTenantContext(tenantId, async () => {
                if (u.event) {
                    // REINSTATED: tolto dalla pausa, torna a partire.
                    const status = u.event === 'REINSTATED' ? 'APPROVED' : u.event;
                    await queryWithRetry(
                        `UPDATE whatsapp_templates SET status = $5, reason = $6, updated_at = NOW()
                          WHERE tenant_id = $1 AND waba_id = $2 AND name = $3 AND language = $4`,
                        [tenantId, u.wabaId, u.name, u.language, status, u.reason]
                    );
                }
                if (u.category) {
                    await queryWithRetry(
                        `UPDATE whatsapp_templates SET category = $5, updated_at = NOW()
                          WHERE tenant_id = $1 AND waba_id = $2 AND name = $3 AND language = $4`,
                        [tenantId, u.wabaId, u.name, u.language, u.category]
                    );
                }
                await loadMetaTemplates(tenantId);
            });
        }
    }
}

/** Il locale ha scollegato il numero: i template restano nel suo account,
 *  ma qui non valgono più. */
export async function forgetMetaTemplates(tenantId: number): Promise<void> {
    lastSync.delete(tenantId);
    await queryWithRetry(`DELETE FROM whatsapp_templates WHERE tenant_id = $1`, [tenantId]);
    await loadMetaTemplates(tenantId);
}
