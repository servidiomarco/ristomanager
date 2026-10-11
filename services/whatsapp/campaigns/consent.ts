// Il consenso al marketing e la sua revoca.
//
// Il consenso valido sta in customers.consent_marketing; consent_events è il
// registro di come ci si è arrivati (modulo, staff, «STOP»). La revoca da
// WhatsApp mette anche marketing_opt_out_at: una campagna non raggiunge più
// quel numero, e un modulo successivo lo riaccende solo con la sua casella
// spuntata — cioè con un nuovo consenso esplicito.

import { queryWithRetry } from '../../../db.js';
import { PHONE_MATCH_KEY_SQL, phoneMatchKey } from '../../../utils/text.js';
import { onInbound } from '../inbound.js';
import { sendWhatsAppText } from '../outbound.js';
import { isEnglishGuest, detectLanguageFromPhonePrefix } from '../../../utils/language.js';
import type { InboundMessage } from '../types.js';

export type ConsentSource =
    | 'booking_form' | 'takeaway_form' | 'staff' | 'reservation'
    | 'whatsapp_stop' | 'whatsapp_button';

/**
 * Registra un consenso (o la sua revoca) per il numero: aggiorna le schede
 * in rubrica con quel numero e scrive l'evento. Non lancia mai: un consenso
 * che non si registra non deve far fallire una prenotazione.
 */
export async function recordMarketingConsent(
    tenantId: number,
    phone: string | null | undefined,
    value: boolean,
    source: ConsentSource,
    userId: number | null = null
): Promise<void> {
    try {
        const key = phoneMatchKey(phone);
        if (!key) return;
        // Solo le schede dove qualcosa cambia: rimandare lo stesso sì a ogni
        // modifica di una prenotazione non deve riempire il registro.
        const optOut = source === 'whatsapp_stop' || source === 'whatsapp_button';
        const matched = await queryWithRetry(
            `SELECT id, consent_marketing, marketing_opt_out_at FROM customers
              WHERE tenant_id = $1 AND ${PHONE_MATCH_KEY_SQL("COALESCE(phone, '')")} = $2`,
            [tenantId, key]
        );
        const changed = matched.rows.filter((c: any) =>
            c.consent_marketing !== value || (value && c.marketing_opt_out_at) || (optOut && !c.marketing_opt_out_at));
        if (matched.rows.length > 0 && changed.length === 0) return;
        for (const c of changed) {
            await queryWithRetry(
                `UPDATE customers
                    SET consent_marketing = $3,
                        consent_marketing_updated_at = NOW(),
                        marketing_opt_out_at = CASE WHEN $3 THEN NULL
                                                    WHEN $4 THEN COALESCE(marketing_opt_out_at, NOW())
                                                    ELSE marketing_opt_out_at END
                  WHERE id = $1 AND tenant_id = $2`,
                [c.id, tenantId, value, optOut]
            );
        }
        // Senza scheda in rubrica il consenso resta comunque registrato.
        const ids: Array<number | null> = changed.length ? changed.map((c: any) => Number(c.id)) : [null];
        for (const customerId of ids) {
            await queryWithRetry(
                `INSERT INTO consent_events (tenant_id, customer_id, phone_digits, kind, value, source, user_id)
                 VALUES ($1, $2, $3, 'marketing', $4, $5, $6)`,
                [tenantId, customerId, key, value, source, userId]
            );
        }
    } catch (err: any) {
        console.error('[consensi] registrazione fallita:', err?.message || err);
    }
}

// «STOP» e simili, o il tasto «Stop promozioni» del template della campagna.
const STOP_RE = /^\s*(?:stop(?:\s+promozioni)?|basta(?:\s+promozioni)?|cancellami|disiscrivimi|unsubscribe|no\s+promozioni)[\s!.]*$/i;
export const STOP_PAYLOAD = 'marketing_stop';

export const isStopMessage = (text: string | null | undefined, buttonPayload: string | null | undefined): 'whatsapp_stop' | 'whatsapp_button' | null => {
    if ((buttonPayload ?? '').trim() === STOP_PAYLOAD) return 'whatsapp_button';
    return STOP_RE.test(String(text ?? '')) ? 'whatsapp_stop' : null;
};

// ---------------------------------------------------------------------------
// «STOP» su WhatsApp
// ---------------------------------------------------------------------------


export const CONSENT_REPLY_KIND = 'consent_reply';

/** L'aggancio: «STOP» o il tasto della campagna revocano il consenso e
 *  rispondono subito, senza passare dall'agente. */
export function registerStopHook(businessName: (tenantId: number) => Promise<string>): void {
    onInbound(async (tenantId: number, _row: any, message: InboundMessage): Promise<'handled' | void> => {
        if (message.channel !== 'whatsapp') return;
        const source = isStopMessage(message.body, message.button?.payload);
        if (!source) return;
        await recordMarketingConsent(tenantId, message.from, false, source);
        const english = isEnglishGuest(detectLanguageFromPhonePrefix(message.from));
        const name = await businessName(tenantId).catch(() => '');
        try {
            await sendWhatsAppText(tenantId, message.from, english
                ? `Done: you won't receive promotions${name ? ` from ${name}` : ''} any more. Messages about your bookings will keep coming.`
                : `Fatto: non riceverai più promozioni${name ? ` da ${name}` : ''}. I messaggi sulle tue prenotazioni continuano ad arrivare.`,
                null, undefined, undefined, CONSENT_REPLY_KIND);
        } catch (err: any) {
            console.warn('[consensi] conferma dello STOP non inviata:', err?.message || err);
        }
        return 'handled';
    }, { first: true });
}
