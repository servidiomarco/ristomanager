// L'API Cloud di Meta (Graph API): il numero WhatsApp di un ristorante che
// non sta su Twilio. Qui il formato di Meta; tutto il resto del modulo parla
// con le stesse interfacce di Twilio (InboundMessage, invii, allegati).
//
// - Invio: POST /{phone_number_id}/messages col token del locale.
// - Allegati in arrivo: Meta dà un id; l'url per scaricarlo si chiede con
//   GET /{media_id} e scade dopo pochi minuti, quindi nel database resta
//   l'id (`meta-media:<id>`) e l'url si chiede quando serve.
// - Webhook: firmato con il segreto dell'app (X-Hub-Signature-256, HMAC
//   SHA-256 del corpo grezzo); da metadata.phone_number_id si ricava il
//   ristorante.

import crypto from 'crypto';
import type { InboundMedia, InboundMessage, MetaSender } from '../types.js';
import type { MetaTemplateMessage } from '../templates/meta.js';

export const META_MEDIA_PREFIX = 'meta-media:';

export interface MetaSendOutcome {
    ok: boolean;
    sid?: string;
    error?: string;
}

async function graph(sender: Pick<MetaSender, 'graphBase' | 'accessToken'>, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: any }> {
    // Un url intero è la pagina successiva di un elenco (paging.next).
    const url = /^https?:\/\//.test(path) ? path : `${sender.graphBase}/${path.replace(/^\/+/, '')}`;
    const response = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${sender.accessToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(20_000),
    });
    const body: any = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
}

const errorText = (status: number, body: any) => {
    const e = body?.error;
    return e ? `${status} - ${e.message ?? ''}${e.code ? ` (codice ${e.code})` : ''}` : String(status);
};

/** Un messaggio: testo libero, template approvato, o allegati (ognuno un
 *  messaggio, il primo con la didascalia). Non lancia per un rifiuto di
 *  Meta: lo restituisce. */
export async function metaSendMessage(
    sender: MetaSender,
    req: { to: string; body: string; mediaUrls?: string[]; interactive?: MetaInteractiveButtons; template?: MetaTemplateMessage }
): Promise<MetaSendOutcome> {
    const to = req.to.replace(/\D/g, '');
    const payloads: Record<string, unknown>[] = [];
    if (req.template) {
        payloads.push({ type: 'template', template: req.template });
    } else if (req.interactive) {
        payloads.push({ type: 'interactive', interactive: {
            type: 'button',
            body: { text: req.body },
            action: { buttons: req.interactive.buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
        } });
    } else if (req.mediaUrls?.length) {
        // Senza il tipo del file, Meta lo riceve come documento: arriva
        // comunque, col nome e la didascalia.
        req.mediaUrls.forEach((link, i) => payloads.push({ type: 'document', document: { link, ...(i === 0 && req.body ? { caption: req.body } : {}) } }));
    } else {
        payloads.push({ type: 'text', text: { body: req.body, preview_url: true } });
    }
    let lastId: string | undefined;
    for (const p of payloads) {
        const r = await graph(sender, `${sender.phoneNumberId}/messages`, {
            method: 'POST',
            body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...p }),
        });
        if (!r.ok) return { ok: false, error: errorText(r.status, r.body) };
        lastId = r.body?.messages?.[0]?.id;
    }
    return { ok: true, sid: lastId };
}

export interface MetaInteractiveButtons {
    buttons: Array<{ id: string; title: string }>;
}

/** Il file di un allegato ricevuto: prima l'url (che scade), poi il file. */
export async function metaFetchMedia(sender: MetaSender, mediaId: string): Promise<{ bytes: Buffer; contentType: string }> {
    const info = await graph(sender, encodeURIComponent(mediaId));
    if (!info.ok || !info.body?.url) throw new Error(`Meta non dà l'allegato: ${errorText(info.status, info.body)}`);
    const file = await fetch(String(info.body.url), {
        headers: { Authorization: `Bearer ${sender.accessToken}` },
        signal: AbortSignal.timeout(30_000),
    });
    if (!file.ok) throw new Error(`Meta ha risposto ${file.status} scaricando l'allegato`);
    return { bytes: Buffer.from(await file.arrayBuffer()), contentType: file.headers.get('content-type') || info.body.mime_type || 'application/octet-stream' };
}

/** Il numero visto da Meta: serve a controllare id e token al collegamento. */
export async function metaPhoneInfo(base: string, phoneNumberId: string, accessToken: string): Promise<
    { ok: true; phone: string; displayName: string | null; quality: string | null; limit: string | null } | { ok: false; error: string }
> {
    const r = await graph({ graphBase: base, accessToken },
        `${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`);
    if (!r.ok) return { ok: false, error: errorText(r.status, r.body) };
    const digits = String(r.body?.display_phone_number ?? '').replace(/\D/g, '');
    if (!digits) return { ok: false, error: 'Meta non restituisce il numero' };
    return {
        ok: true,
        phone: `+${digits}`,
        displayName: r.body?.verified_name ?? null,
        quality: r.body?.quality_rating ?? null,
        limit: r.body?.messaging_limit_tier ?? null,
    };
}

/** L'app di Sympotia riceve i webhook di questo account WhatsApp. */
export async function metaSubscribeApp(base: string, wabaId: string, accessToken: string): Promise<boolean> {
    const r = await graph({ graphBase: base, accessToken }, `${encodeURIComponent(wabaId)}/subscribed_apps`, { method: 'POST' });
    return r.ok;
}

// ---------------------------------------------------------------------------
// Template dell'account (Fase 12b)
// ---------------------------------------------------------------------------

export interface MetaRemoteTemplate {
    id: string;
    name: string;
    language: string;
    status: string;
    category: string | null;
    rejectedReason: string | null;
}

/** Tutti i template dell'account WhatsApp, pagina dopo pagina. */
export async function metaListTemplates(sender: MetaSender): Promise<{ ok: true; templates: MetaRemoteTemplate[] } | { ok: false; error: string }> {
    const out: MetaRemoteTemplate[] = [];
    let path: string | null = `${encodeURIComponent(sender.wabaId)}/message_templates?fields=id,name,language,status,category,rejected_reason&limit=100`;
    for (let page = 0; path && page < 20; page++) {
        const r = await graph(sender, path);
        if (!r.ok) return { ok: false, error: errorText(r.status, r.body) };
        for (const t of r.body?.data ?? []) {
            out.push({
                id: String(t?.id ?? ''),
                name: String(t?.name ?? ''),
                language: String(t?.language ?? ''),
                status: String(t?.status ?? '').toUpperCase(),
                category: t?.category ? String(t.category).toUpperCase() : null,
                // Meta scrive NONE quando non c'è un motivo.
                rejectedReason: t?.rejected_reason && t.rejected_reason !== 'NONE' ? String(t.rejected_reason) : null,
            });
        }
        path = r.body?.paging?.next ?? null;
    }
    return { ok: true, templates: out };
}

/** Crea un template nell'account e lo manda in approvazione. */
export async function metaCreateTemplate(sender: MetaSender, payload: Record<string, unknown>): Promise<
    { ok: true; id: string; status: string; category: string | null } | { ok: false; error: string }
> {
    const r = await graph(sender, `${encodeURIComponent(sender.wabaId)}/message_templates`, { method: 'POST', body: JSON.stringify(payload) });
    if (!r.ok) {
        const e = r.body?.error;
        // Il motivo leggibile, quando c'è, sta in error_user_msg.
        return { ok: false, error: e?.error_user_msg || errorText(r.status, r.body) };
    }
    return {
        ok: true,
        id: String(r.body?.id ?? ''),
        status: String(r.body?.status ?? 'PENDING').toUpperCase(),
        category: r.body?.category ? String(r.body.category).toUpperCase() : null,
    };
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/** La firma X-Hub-Signature-256 (`sha256=<hex>`) sul corpo grezzo. */
export function isValidMetaSignature(rawBody: Buffer | undefined, header: string | undefined, appSecret: string): boolean {
    if (!rawBody || !header || !header.startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const got = header.slice('sha256='.length);
    if (got.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

export interface MetaStatus {
    sid: string;
    status: string;
    errorCode: string | null;
    errorText: string | null;
    pricingCategory: string | null;
    billable: boolean | null;
}

export interface MetaEcho {
    sid: string;
    to: string;
    body: string;
}

export interface MetaChange {
    phoneNumberId: string;
    inbound: InboundMessage[];
    statuses: MetaStatus[];
    /** Coesistenza: messaggi scritti dall'app WhatsApp Business del locale. */
    echoes: MetaEcho[];
}

const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'] as const;
const plus = (digits: unknown) => {
    const d = String(digits ?? '').replace(/\D/g, '');
    return d ? `+${d}` : '';
};

function toInbound(msg: any, value: any): InboundMessage | null {
    const from = plus(msg?.from);
    const contact = (value?.contacts ?? []).find((c: any) => String(c?.wa_id ?? '') === String(msg?.from ?? '')) ?? value?.contacts?.[0];
    const externalUserId = contact?.user_id ?? msg?.from_user_id ?? null;
    if (!from && !externalUserId) return null;
    const media: InboundMedia[] = [];
    let caption = '';
    for (const t of MEDIA_TYPES) {
        const m = msg?.[t];
        if (m?.id) {
            media.push({ url: `${META_MEDIA_PREFIX}${m.id}`, content_type: String(m.mime_type || 'application/octet-stream').split(';')[0] });
            caption = typeof m.caption === 'string' ? m.caption : caption;
        }
    }
    const reply = msg?.interactive?.button_reply ?? msg?.interactive?.list_reply ?? null;
    const button = msg?.button
        ? { payload: msg.button.payload ?? null, text: msg.button.text ?? null, type: 'button' }
        : reply ? { payload: reply.id ?? null, text: reply.title ?? null, type: 'interactive' } : null;
    const loc = msg?.location;
    const body = String(msg?.text?.body ?? caption ?? '') || String(button?.text ?? '');
    return {
        provider: 'meta',
        channel: 'whatsapp',
        from,
        to: plus(value?.metadata?.display_phone_number),
        body,
        sid: msg?.id ?? null,
        media,
        profileName: contact?.profile?.name ?? null,
        externalUserId,
        button,
        repliedToSid: msg?.context?.id ?? null,
        location: loc && Number.isFinite(Number(loc.latitude)) ? {
            latitude: Number(loc.latitude), longitude: Number(loc.longitude),
            label: loc.name ?? null, address: loc.address ?? null,
        } : null,
    };
}

/** Un cambiamento di stato o di categoria di un template: arriva per
 *  account WhatsApp (entry.id), non per numero. */
export interface MetaTemplateUpdate {
    wabaId: string;
    name: string;
    language: string;
    /** APPROVED, REJECTED, PAUSED, …; null se cambia solo la categoria. */
    event: string | null;
    reason: string | null;
    category: string | null;
}

export function parseMetaTemplateUpdates(payload: any): MetaTemplateUpdate[] {
    const out: MetaTemplateUpdate[] = [];
    for (const entry of payload?.entry ?? []) {
        const wabaId = String(entry?.id ?? '');
        for (const change of entry?.changes ?? []) {
            const v = change?.value ?? {};
            if (!wabaId || !v.message_template_name || !v.message_template_language) continue;
            if (change.field === 'message_template_status_update') {
                const reason = v.reason && v.reason !== 'NONE' ? String(v.reason) : (v.other_info?.description ? String(v.other_info.description) : null);
                out.push({ wabaId, name: String(v.message_template_name), language: String(v.message_template_language), event: v.event ? String(v.event).toUpperCase() : null, reason, category: null });
            } else if (change.field === 'template_category_update') {
                out.push({ wabaId, name: String(v.message_template_name), language: String(v.message_template_language), event: null, reason: null, category: v.new_category ? String(v.new_category).toUpperCase() : null });
            }
        }
    }
    return out;
}

/** Il corpo di un webhook di Meta, cambiamento per cambiamento. */
export function parseMetaWebhook(payload: any): MetaChange[] {
    const out: MetaChange[] = [];
    for (const entry of payload?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
            const value = change?.value ?? {};
            const phoneNumberId = String(value?.metadata?.phone_number_id ?? '');
            if (!phoneNumberId) continue;
            const c: MetaChange = { phoneNumberId, inbound: [], statuses: [], echoes: [] };
            if (change.field === 'messages') {
                for (const msg of value.messages ?? []) {
                    const m = toInbound(msg, value);
                    if (m) c.inbound.push(m);
                }
                for (const s of value.statuses ?? []) {
                    const err = s?.errors?.[0];
                    c.statuses.push({
                        sid: String(s?.id ?? ''),
                        status: String(s?.status ?? '').toLowerCase(),
                        errorCode: err?.code != null ? String(err.code) : null,
                        errorText: err ? `${err.code ?? ''} ${err.title ?? err.message ?? ''}`.trim() : null,
                        pricingCategory: s?.pricing?.category ?? null,
                        billable: typeof s?.pricing?.billable === 'boolean' ? s.pricing.billable : null,
                    });
                }
            } else if (change.field === 'smb_message_echoes') {
                for (const e of value.message_echoes ?? []) {
                    c.echoes.push({ sid: String(e?.id ?? ''), to: plus(e?.to), body: String(e?.text?.body ?? '') });
                }
            }
            out.push(c);
        }
    }
    return out;
}
