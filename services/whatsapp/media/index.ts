// Vocali e foto dei clienti (Impostazioni › WhatsApp › Vocali e foto).
//
// - Un vocale in arrivo si trascrive subito, dentro l'aggancio del messaggio:
//   la coda dell'agente parte dopo e lo trova già scritto. L'Inbox riceve la
//   trascrizione col socket message:updated.
// - Le foto nuove del cliente (quelle del suo ultimo turno, al massimo tre)
//   l'agente le guarda come immagini ridotte a 1568 px, la misura oltre la
//   quale il modello le rimpicciolisce comunque.

import { queryWithRetry } from '../../../db.js';
import { whatsappDeps } from '../deps.js';
import { onInbound } from '../inbound.js';
import { getMediaPolicy } from '../settings.js';
import type { InboundMessage } from '../types.js';
import { fetchInboundMedia } from './fetch.js';
import { isTranscriptionConfigured, transcribeAudio } from './transcribe.js';

export { fetchInboundMedia, MediaFetchError, MEDIA_MAX_BYTES } from './fetch.js';

// sharp ha binari nativi: si carica solo quando una foto va ridotta. Se manca
// (pacchetto non installato, piattaforma senza binario) la foto non arriva
// all'agente, ma il server parte lo stesso. L'11/10 un import diretto, con
// sharp rimasto fra le dipendenze di sviluppo, ha fatto fallire il deploy al
// boot: l'immagine di produzione installa solo le dipendenze vere.
let sharpLoading: Promise<typeof import('sharp')> | null = null;
async function loadSharp(): Promise<typeof import('sharp')> {
    sharpLoading ??= import('sharp').then(m => ((m as any).default ?? m) as typeof import('sharp'));
    return sharpLoading;
}
export { isTranscriptionConfigured, transcribeAudio } from './transcribe.js';

export function configureWhatsAppMedia(): void {
    // Prima degli altri agganci: tasti e agente leggono il vocale già scritto.
    onInbound(transcribeInbound, { first: true });
}

const isAudio = (m: { content_type?: string | null }) => String(m?.content_type || '').startsWith('audio/');
const isImage = (m: { content_type?: string | null }) => /^image\/(jpeg|png|webp|gif)$/.test(String(m?.content_type || ''));

async function transcribeInbound(tenantId: number, row: any, message: InboundMessage): Promise<void> {
    if (message.channel !== 'whatsapp' || !row?.id) return;
    const audio = message.media.find(isAudio);
    if (!audio) return;
    if (!isTranscriptionConfigured() || !(await getMediaPolicy(tenantId)).transcribe_voice) return;
    await queryWithRetry(`UPDATE outbound_messages SET transcript_status = 'pending' WHERE id = $1 AND tenant_id = $2`, [row.id, tenantId]);
    let update: { transcript: string | null; status: 'done' | 'failed'; language: string | null };
    try {
        const file = await fetchInboundMedia(tenantId, audio);
        const t = await transcribeAudio(file.bytes, file.contentType);
        update = { transcript: t.text || null, status: t.text ? 'done' : 'failed', language: t.language };
    } catch (err: any) {
        console.warn('[whatsapp-vocali] trascrizione non riuscita:', err?.message || err);
        update = { transcript: null, status: 'failed', language: null };
    }
    await queryWithRetry(
        `UPDATE outbound_messages SET transcript = $3, transcript_status = $4, transcript_language = $5 WHERE id = $1 AND tenant_id = $2`,
        [row.id, tenantId, update.transcript, update.status, update.language]
    );
    try {
        whatsappDeps().broadcastToAll(tenantId, 'message:updated', {
            id: row.id, from_phone_digits: row.from_phone_digits,
            transcript: update.transcript, transcript_status: update.status, transcript_language: update.language,
        });
    } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Per l'agente
// ---------------------------------------------------------------------------

/** Il testo di un messaggio come lo legge l'agente: il vocale trascritto
 *  dice che lo è, una foto o un vocale senza testo dicono che c'erano. */
export function agentMessageBody(row: { body?: string | null; media?: any; transcript?: string | null; direction?: string }): string {
    const body = String(row.body ?? '').trim();
    if (row.direction !== 'inbound') return body;
    const media: any[] = Array.isArray(row.media) ? row.media : [];
    const parts: string[] = [];
    if (row.transcript) parts.push(`[Vocale, trascrizione automatica]: "${row.transcript}"`);
    else if (media.some(isAudio)) parts.push('[Il cliente ha mandato un vocale che non è stato trascritto]');
    if (media.some(isImage)) parts.push('[Il cliente ha mandato una foto]');
    if (body) parts.push(body);
    return parts.join('\n');
}

export interface AgentImage {
    media_type: 'image/jpeg';
    data: string;
}

const MAX_PHOTOS = 3;
const MAX_SIDE = 1568;

/** Le foto del turno del cliente (i messaggi dopo l'ultima risposta), al
 *  massimo tre, ridotte e in base64, per id del messaggio. Una foto che non
 *  si scarica si salta: l'agente legge comunque «ha mandato una foto». */
export async function photosForAgent(
    tenantId: number,
    rows: Array<{ id: number; direction: string; media?: any }>
): Promise<Map<number, AgentImage[]>> {
    const out = new Map<number, AgentImage[]>();
    if (!(await getMediaPolicy(tenantId)).read_photos) return out;
    // rows in ordine cronologico: il turno del cliente è la coda di messaggi
    // in arrivo dopo l'ultimo in uscita.
    let start = rows.length;
    while (start > 0 && rows[start - 1].direction === 'inbound') start--;
    let taken = 0;
    for (const row of rows.slice(start)) {
        const media: any[] = Array.isArray(row.media) ? row.media : [];
        for (const item of media.filter(isImage)) {
            if (taken >= MAX_PHOTOS) return out;
            try {
                const file = await fetchInboundMedia(tenantId, item);
                const sharp = await loadSharp();
                const jpeg = await sharp(file.bytes)
                    .rotate()
                    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 80 })
                    .toBuffer();
                const list = out.get(row.id) ?? [];
                list.push({ media_type: 'image/jpeg', data: jpeg.toString('base64') });
                out.set(row.id, list);
                taken++;
            } catch (err: any) {
                console.warn('[whatsapp-foto] foto non letta:', err?.message || err);
            }
        }
    }
    return out;
}
