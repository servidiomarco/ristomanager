// «Il tuo ordine è pronto»: un WhatsApp al cliente quando l'ordine
// d'asporto passa a «Pronto» (Impostazioni › WhatsApp › Asporto in chat).
// Dentro la finestra di 24 ore un testo libero; fuori, il template
// TAKEAWAY_READY se è approvato, altrimenti niente: non vale un SMS a
// pagamento. Una volta sola per ordine (ready_notified_at).

import { queryWithRetry } from '../../db.js';
import { detectLanguageFromPhonePrefix, isEnglishGuest } from '../../utils/language.js';
import { isWhatsAppReady } from './config.js';
import { sendWhatsAppText } from './outbound.js';
import { getTakeawayPolicy } from './settings.js';
import { pickTemplate } from './templates/registry.js';
import { isWindowOpen } from './window.js';

export const TAKEAWAY_READY_KIND = 'takeaway_ready';

/** Non lancia mai: l'avviso non deve fermare la board. */
export async function notifyTakeawayReady(tenantId: number, orderId: number, businessName: string): Promise<boolean> {
    try {
        if (!(await getTakeawayPolicy(tenantId)).notify_ready) return false;
        if (!(await isWhatsAppReady(tenantId))) return false;
        // Presa in carico prima dell'invio: due «pronto» quasi insieme ne
        // mandano uno.
        const claimed = await queryWithRetry(
            `UPDATE takeaway_orders SET ready_notified_at = NOW()
              WHERE id = $1 AND tenant_id = $2 AND ready_notified_at IS NULL AND status = 'READY'
                AND customer_phone IS NOT NULL AND customer_phone <> ''
              RETURNING customer_name, customer_phone, daily_number, pickup_time`,
            [orderId, tenantId]
        );
        const o = claimed.rows[0];
        if (!o) return false;
        const phone = String(o.customer_phone);
        if (phone.replace(/\D/g, '').length < 6) return false;
        const english = isEnglishGuest(detectLanguageFromPhonePrefix(phone));
        const numero = o.daily_number != null ? ` #${o.daily_number}` : '';
        const nome = String(o.customer_name || '').trim();
        const text = english
            ? `Hi${nome ? ` ${nome}` : ''}! Your order${numero} is ready: see you at ${businessName}.`
            : `Ciao${nome ? ` ${nome}` : ''}! Il tuo ordine${numero} è pronto: ti aspettiamo da ${businessName}.`;
        if (await isWindowOpen(tenantId, phone)) {
            await sendWhatsAppText(tenantId, phone, text, null, undefined, undefined, TAKEAWAY_READY_KIND);
            return true;
        }
        const picked = pickTemplate(tenantId, 'TWILIO_WA_CONTENT_SID_TAKEAWAY_READY', english ? 'en' : 'it');
        if (!picked) return false;
        // Il testo resta nel registro dei messaggi; con la SID Twilio manda il template.
        await sendWhatsAppText(tenantId, phone, text, null, {
            contentSid: picked.contentSid,
            contentVariables: { '1': nome || '—', '2': o.daily_number != null ? String(o.daily_number) : '—', '3': businessName || '—' },
        }, undefined, TAKEAWAY_READY_KIND);
        return true;
    } catch (err: any) {
        console.warn('[takeaway] avviso «pronto» non inviato:', err?.message || err);
        return false;
    }
}
