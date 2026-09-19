// Persistenza della richiesta di recensione post-visita.
//
// Vive fuori da server.ts perché è la parte che l'incidente del 18-19/09/2026
// ha dimostrato essere critica, e qui i test possono eseguirla contro un
// Postgres vero: le query sono esportate come stringhe proprio per questo
// (stesso motivo di COST_USD_SQL in services/aiPricing.ts).
//
// Cosa era successo: lo sweep INVIAVA il messaggio e solo DOPO segnava
// l'esito sulla prenotazione. La UPDATE di marcatura era però invalida —
// `$1` veniva assegnato a una colonna varchar e insieme confrontato con un
// letterale ('sent'), e Postgres rifiuta la query con «inconsistent types
// deduced for parameter $1». Risultato: messaggio partito, riga rimasta
// non marcata, e al giro dopo lo sweep la ritrovava "mai valutata" e
// rimandava. Ogni 15 minuti, per 40 numeri, 418 SMS.
//
// Da qui le due regole di questo modulo:
//
// 1. SI PRENDE IN CARICO PRIMA DI INVIARE (claimReviewRequest). La riga
//    passa a 'sending' in modo atomico: chi non ottiene la riga non invia.
//    Una prenotazione non può quindi essere tentata due volte, qualunque
//    cosa vada storta a valle — nemmeno se la marcatura finale fallisce di
//    nuovo per un motivo che oggi non prevediamo. Il prezzo è che un crash
//    fra invio ed esito lascia la riga a 'sending' e nessuno riproverà:
//    scelta deliberata, una richiesta mancante vale infinitamente meno di
//    ventisei copie allo stesso cliente.
// 2. IL COOLDOWN GUARDA GLI INVII VERI (hasRecentReviewRequest), non solo
//    lo stato sulla prenotazione. Durante l'incidente il cooldown non ha
//    protetto nessuno proprio perché interrogava le righe marcate 'sent', e
//    di marcate non ce n'era una: la verità di cosa è uscito davvero sta in
//    outbound_messages.
import { queryWithRetry } from '../db.js';
import { PHONE_MATCH_KEY_SQL } from '../utils/text.js';

/** Il link «scrivi una recensione» di Google, che non richiede API. */
export const GOOGLE_REVIEW_LINK_HOST = 'search.google.com/local/writereview';

export const buildGoogleReviewUrl = (placeId: string): string =>
    `https://${GOOGLE_REVIEW_LINK_HOST}?placeid=${encodeURIComponent(placeId)}`;

/** 'sending' = presa in carico, esito ancora ignoto: non si riprova. */
export type ReviewRequestStatus =
    | 'sending'
    | 'sent'
    | 'failed'
    | 'skipped_consent'
    | 'skipped_no_contact'
    | 'skipped_recent';

export const CLAIM_REVIEW_REQUEST_SQL = `
    UPDATE reservations
       SET review_request_status = 'sending'
     WHERE id = $1::int
       AND tenant_id = $2::bigint
       AND review_request_status IS NULL
    RETURNING id`;

// I cast espliciti sono il fix: senza, `$1` è insieme varchar (assegnato
// alla colonna) e text (confrontato col letterale) e la query non si
// prepara nemmeno. La WHERE accetta solo le righe prese in carico da noi.
export const FINISH_REVIEW_REQUEST_SQL = `
    UPDATE reservations
       SET review_request_status = $1::varchar,
           review_request_channel = $2::varchar,
           review_request_sent_at = CASE WHEN $1::varchar = 'sent' THEN CURRENT_TIMESTAMP ELSE review_request_sent_at END,
           review_request_error = $3::text
     WHERE id = $4::int
       AND tenant_id = $5::bigint
       AND review_request_status = 'sending'`;

export const RECENT_REVIEW_REQUEST_SQL = `
    SELECT
        EXISTS (
            SELECT 1 FROM reservations
             WHERE tenant_id = $1::bigint
               AND review_request_status = 'sent'
               AND review_request_sent_at > NOW() - make_interval(days => $2::int)
               AND ${PHONE_MATCH_KEY_SQL("COALESCE(phone, '')")} = ${PHONE_MATCH_KEY_SQL('$3::text')}
        ) OR EXISTS (
            SELECT 1 FROM outbound_messages
             WHERE tenant_id = $1::bigint
               AND direction = 'outbound'
               AND body LIKE '%' || $4::text || '%'
               AND sent_at > NOW() - make_interval(days => $2::int)
               AND ${PHONE_MATCH_KEY_SQL("COALESCE(to_phone_digits, '')")} = ${PHONE_MATCH_KEY_SQL('$3::text')}
        ) AS recente`;

/**
 * Prende in carico la prenotazione. `false` = qualcun altro l'ha già presa
 * (o è già stata valutata): NON inviare.
 */
export async function claimReviewRequest(tenantId: number, reservationId: number): Promise<boolean> {
    const res = await queryWithRetry(CLAIM_REVIEW_REQUEST_SQL, [reservationId, tenantId]);
    return (res.rowCount ?? 0) > 0;
}

/** Scrive l'esito definitivo su una riga presa in carico. */
export async function finishReviewRequest(
    tenantId: number,
    reservationId: number,
    status: Exclude<ReviewRequestStatus, 'sending'>,
    channel: string | null = null,
    error: string | null = null
): Promise<void> {
    await queryWithRetry(FINISH_REVIEW_REQUEST_SQL, [status, channel, error, reservationId, tenantId]);
}

/** Una richiesta è già uscita verso questo numero negli ultimi `days` giorni? */
export async function hasRecentReviewRequest(tenantId: number, phone: string, days: number): Promise<boolean> {
    const res = await queryWithRetry(RECENT_REVIEW_REQUEST_SQL, [tenantId, days, phone, GOOGLE_REVIEW_LINK_HOST]);
    return res.rows[0]?.recente === true;
}
