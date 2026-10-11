// I tasti del promemoria: «Ci saremo», «Devo modificare», «Annulla»
// (template BOOKING_REMINDER_QR). Si gestiscono qui, senza AI: devono
// funzionare anche in un locale con l'agente spento, e rispondere nello
// stesso istante del tocco.
//
// - «Ci saremo»: segna la conferma dell'ospite, come il pulsante della
//   pagina «La tua prenotazione», e ringrazia.
// - «Devo modificare»: se l'agente è acceso lo lascia a lui (il messaggio
//   prosegue verso la coda); altrimenti manda il link della prenotazione, o
//   dice che risponde una persona.
// - «Annulla»: in due tempi. Prima «Confermi?», poi al «sì» annulla con le
//   stesse regole della pagina dell'ospite (la soglia d'anticipo del locale).
//
// La prenotazione si trova dal tasto: il payload può portare il token
// (`rsv_confirm:<token>`); se no, dal messaggio a cui il cliente ha risposto
// (OriginalRepliedMessageSid → la riga di outbound_messages del promemoria).
// In ogni caso dev'essere del numero che ha toccato il tasto.

import { queryWithRetry } from '../../db.js';
import { phoneMatchKey } from '../../utils/text.js';
import { isEnglishGuest, resolveGuestLanguage } from '../../utils/language.js';
import { getGuestManagePolicy, guestActionsFor } from '../guestManage.js';
import { confirmGuestAttendance, WHATSAPP_GUEST_ACTOR } from '../reservationGuestUpdates.js';
import { getTenantLocale } from '../tenantLocale.js';
import { onInbound } from './inbound.js';
import { sendWhatsAppText } from './outbound.js';
import type { InboundMessage } from './types.js';

/** Quello che sta in server.ts. */
export interface ReservationButtonDeps {
    /** L'annullo dell'ospite, lo stesso di POST /r/:token/cancel. */
    cancelAsGuest: (tenantId: number, reservationId: number) => Promise<{ ok: true } | { ok: false; error: string }>;
    /** Il link «La tua prenotazione», se il locale l'ha acceso. */
    manageLink: (tenantId: number, reservationId: number) => Promise<string | null>;
    /** Il telefono pubblico del locale. */
    businessPhone: (tenantId: number) => Promise<string | null>;
    /** L'agente WhatsApp lavora da solo su questo locale. */
    agentHandles: (tenantId: number) => Promise<boolean>;
}
let deps: ReservationButtonDeps | null = null;

export function configureReservationButtons(d: ReservationButtonDeps): void {
    deps = d;
    // Prima della coda dell'agente: un tasto gestito qui non diventa un giro.
    onInbound(handleInboundButton, { first: true });
}

export const BUTTON_REPLY_KIND = 'button_reply';
const PAYLOAD_RE = /^rsv_(confirm|manage|cancel)(?::([A-Za-z0-9_-]{20,}))?$/;
// La risposta alla domanda «Confermi che annulli…?»: breve, e solo entro
// mezz'ora. Un «sì» a qualcos'altro, più tardi, non annulla niente.
// \b non conosce le accentate senza il flag u: «Sì» non passava.
const YES_RE = /^\s*(?:s[iì]|yes|ok|okay|confermo|conferma|annulla(?:la)?|cancel(?:la)?)(?!\p{L})[\s,!.]*(?:annulla(?:la)?)?[\s!.]*$/iu;
const NO_RE = /^\s*(?:no|nope|non annullare|lascia(?:la)?(?: pure)?|resta)(?!\p{L})/iu;
const PENDING_TOOL = 'button_cancel';
const PENDING_MINUTES = 30;

interface Res {
    id: number;
    customer_name: string | null;
    reservation_time: Date;
    reservation_status: string;
    arrival_status: string | null;
    guest_confirmed_at: Date | null;
    banquet_menu_id: number | null;
    language: string | null;
    phone: string | null;
}

const RES_SQL = `SELECT id, customer_name, reservation_time, COALESCE(reservation_status, 'CONFIRMED') AS reservation_status,
                        arrival_status, guest_confirmed_at, banquet_menu_id, language, phone
                   FROM reservations`;

const samePerson = (a: string | null | undefined, b: string | null | undefined) => {
    const ka = phoneMatchKey(String(a ?? ''));
    return !!ka && ka === phoneMatchKey(String(b ?? ''));
};

async function reservationFor(tenantId: number, from: string, token: string | null, repliedToSid: string | null): Promise<Res | null> {
    let row: Res | undefined;
    if (token) {
        row = (await queryWithRetry(`${RES_SQL} WHERE guest_token = $1 AND tenant_id = $2`, [token, tenantId])).rows[0];
    }
    if (!row && repliedToSid) {
        row = (await queryWithRetry(
            `${RES_SQL} WHERE tenant_id = $1 AND id = (
                 SELECT reservation_id FROM outbound_messages WHERE tenant_id = $1 AND provider_sid = $2 LIMIT 1)`,
            [tenantId, repliedToSid]
        )).rows[0];
    }
    return row && samePerson(row.phone, from) ? row : null;
}

function labels(r: Res, tz: string) {
    const english = isEnglishGuest(resolveGuestLanguage(r));
    const when = new Date(r.reservation_time);
    const day = new Intl.DateTimeFormat(english ? 'en-GB' : 'it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(when);
    const time = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(when);
    return { english, day, time };
}

async function reply(tenantId: number, to: string, text: string, reservationId: number | null) {
    try {
        await sendWhatsAppText(tenantId, to, text, reservationId, undefined, undefined, BUTTON_REPLY_KIND);
    } catch (err: any) {
        console.warn('[whatsapp-tasti] risposta non inviata:', err?.message || err);
    }
}

async function setPending(tenantId: number, key: string, reservationId: number | null) {
    await queryWithRetry(
        `INSERT INTO agent_conversation_state (tenant_id, phone_digits, pending_confirmation, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (tenant_id, phone_digits) DO UPDATE
            SET pending_confirmation = EXCLUDED.pending_confirmation, updated_at = NOW()`,
        [tenantId, key, reservationId == null ? null : JSON.stringify({ tool: PENDING_TOOL, reservation_id: reservationId, asked_at: new Date().toISOString() })]
    );
}

async function readPending(tenantId: number, key: string): Promise<number | null> {
    const p = (await queryWithRetry(
        `SELECT pending_confirmation FROM agent_conversation_state WHERE tenant_id = $1 AND phone_digits = $2`,
        [tenantId, key]
    )).rows[0]?.pending_confirmation;
    if (!p || p.tool !== PENDING_TOOL) return null;
    const asked = new Date(p.asked_at).getTime();
    if (!Number.isFinite(asked) || Date.now() - asked > PENDING_MINUTES * 60_000) return null;
    return Number(p.reservation_id) || null;
}

/** Cosa l'ospite può fare adesso sulla prenotazione, con la soglia del
 *  locale anche se la pagina «La tua prenotazione» è spenta: i tasti li ha
 *  accesi il locale, e l'annullo da qui deve funzionare. */
async function actionsFor(tenantId: number, r: Res) {
    const policy = await getGuestManagePolicy(tenantId);
    return {
        cutoff: policy.cancel_cutoff_hours,
        ...guestActionsFor({
            now: new Date(),
            reservationTime: new Date(r.reservation_time),
            status: r.reservation_status,
            arrivalStatus: r.arrival_status,
            guestConfirmedAt: r.guest_confirmed_at ? new Date(r.guest_confirmed_at) : null,
            policy: { enabled: true, cancel_cutoff_hours: policy.cancel_cutoff_hours },
            banquetLinked: r.banquet_menu_id != null,
        }),
    };
}

/** L'aggancio sui messaggi in arrivo: 'handled' ferma gli agganci dopo
 *  (la coda dell'agente). */
export async function handleInboundButton(tenantId: number, row: any, message: InboundMessage): Promise<'handled' | void> {
    if (!deps || message.channel !== 'whatsapp') return;
    const key = phoneMatchKey(row.from_phone || message.from);
    if (!key) return;
    const tz = (await getTenantLocale(tenantId)).timezone;
    const payload = (message.button?.payload ?? '').trim();
    const m = payload ? PAYLOAD_RE.exec(payload) : null;

    if (!m) {
        // Non è un tasto: forse la risposta a «Confermi che annulli?».
        const pendingId = await readPending(tenantId, key);
        if (!pendingId) return;
        const text = String(message.body || '').trim();
        if (text.length <= 40 && YES_RE.test(text)) return confirmCancel(tenantId, key, message.from, pendingId, tz);
        await setPending(tenantId, key, null);
        if (text.length <= 40 && NO_RE.test(text)) {
            const r = (await queryWithRetry(`${RES_SQL} WHERE id = $1 AND tenant_id = $2`, [pendingId, tenantId])).rows[0] as Res | undefined;
            const english = r ? isEnglishGuest(resolveGuestLanguage(r)) : false;
            await reply(tenantId, message.from, english ? 'Fine, your booking stays as it is. See you soon!' : 'Va bene, la prenotazione resta com\'è. A presto!', pendingId);
            return 'handled';
        }
        // Ha scritto altro: la domanda decade e il messaggio va avanti.
        return;
    }

    const kind = m[1] as 'confirm' | 'manage' | 'cancel';
    const r = await reservationFor(tenantId, message.from, m[2] ?? null, message.repliedToSid);
    if (!r) {
        // Il tasto di un promemoria che non troviamo (o non è di questo
        // numero): non si tocca niente, lo legge una persona o l'agente.
        return;
    }
    const { english, day, time } = labels(r, tz);
    const actions = await actionsFor(tenantId, r);
    const inactive = english
        ? 'This booking is no longer active. Write to us if you need anything.'
        : 'Questa prenotazione non è più attiva. Scrivici se ti serve qualcosa.';

    if (kind === 'confirm') {
        if (actions.state !== 'confirmed' && actions.state !== 'pending') {
            await reply(tenantId, message.from, inactive, r.id);
            return 'handled';
        }
        await confirmGuestAttendance(tenantId, r.id, WHATSAPP_GUEST_ACTOR);
        await reply(tenantId, message.from, english
            ? `Thank you! See you on ${day} at ${time}.`
            : `Grazie! Ti aspettiamo ${day} alle ${time}.`, r.id);
        return 'handled';
    }

    if (kind === 'manage') {
        // Con l'agente acceso ci pensa lui: «Devo modificare» è l'inizio di
        // una conversazione, non un comando.
        if (await deps.agentHandles(tenantId)) return;
        const link = actions.can_modify || actions.can_cancel ? await deps.manageLink(tenantId, r.id) : null;
        await reply(tenantId, message.from, link
            ? (english ? `You can change it here: ${link}` : `Puoi cambiarla da qui: ${link}`)
            : (english ? 'Tell us what you would like to change: someone from the restaurant will reply.' : 'Scrivici pure cosa vuoi cambiare: ti risponde una persona del locale.'), r.id);
        return 'handled';
    }

    // Annulla: primo tempo.
    if (actions.state !== 'confirmed' && actions.state !== 'pending') {
        await reply(tenantId, message.from, inactive, r.id);
        return 'handled';
    }
    if (!actions.can_cancel) {
        const phone = await deps.businessPhone(tenantId);
        await reply(tenantId, message.from, english
            ? `It's less than ${actions.cutoff} hours to your booking: to cancel, please call us${phone ? ` on ${phone}` : ''}.`
            : `Mancano meno di ${actions.cutoff} ore: per annullare chiamaci${phone ? ` al ${phone}` : ''}.`, r.id);
        return 'handled';
    }
    await setPending(tenantId, key, r.id);
    await reply(tenantId, message.from, english
        ? `Do you confirm you want to cancel your booking on ${day} at ${time}? Reply "yes" to cancel.`
        : `Confermi che annulli la prenotazione di ${day} alle ${time}? Rispondi «sì» per annullare.`, r.id);
    return 'handled';
}

async function confirmCancel(tenantId: number, key: string, from: string, reservationId: number, tz: string): Promise<'handled'> {
    await setPending(tenantId, key, null);
    const r = (await queryWithRetry(`${RES_SQL} WHERE id = $1 AND tenant_id = $2`, [reservationId, tenantId])).rows[0] as Res | undefined;
    if (!r || !samePerson(r.phone, from)) return 'handled';
    const { english, day, time } = labels(r, tz);
    const out = await deps!.cancelAsGuest(tenantId, r.id);
    if (out.ok === true) {
        await reply(tenantId, from, english
            ? `Done: your booking on ${day} at ${time} is cancelled. We hope to see you soon!`
            : `Fatto: la prenotazione di ${day} alle ${time} è annullata. Speriamo di vederti presto!`, r.id);
    } else {
        const phone = await deps!.businessPhone(tenantId);
        await reply(tenantId, from, english
            ? `We couldn't cancel it from here: please call us${phone ? ` on ${phone}` : ''}.`
            : `Non riusciamo ad annullarla da qui: chiamaci${phone ? ` al ${phone}` : ''}.`, r.id);
    }
    return 'handled';
}
