// La finestra di 24 ore di WhatsApp: per 24 ore dall'ultimo messaggio del
// cliente il locale può scrivergli testo libero; fuori serve un template
// approvato (Twilio accetta l'invio e Meta lo rifiuta dopo, con l'errore
// 63016, senza che chi ha mandato se ne accorga).

import { queryWithRetry } from '../../db.js';
import { phoneDigitsVariants, phoneMatchKey } from '../../utils/text.js';

export const WINDOW_MS = 24 * 3600 * 1000;

/** L'ultimo messaggio WhatsApp arrivato da quel numero, o null. */
export async function lastInboundAt(tenantId: number, phone: string): Promise<Date | null> {
    const key = phoneMatchKey(phone);
    if (!key) return null;
    const r = await queryWithRetry(
        `SELECT MAX(sent_at) AS last_inbound_at
           FROM outbound_messages
          WHERE tenant_id = $2
            AND direction = 'inbound' AND channel = 'whatsapp'
            AND from_phone_digits = ANY($1::text[])`,
        [phoneDigitsVariants(key), tenantId]
    );
    const at = r.rows[0]?.last_inbound_at;
    return at ? new Date(at) : null;
}

/** La finestra è aperta, con almeno `marginMs` ancora davanti? */
export async function isWindowOpen(tenantId: number, phone: string, marginMs = 0): Promise<boolean> {
    const at = await lastInboundAt(tenantId, phone);
    return !!at && Date.now() - at.getTime() < WINDOW_MS - marginMs;
}
