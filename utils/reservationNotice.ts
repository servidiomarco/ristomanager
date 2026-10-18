import type { Reservation } from '../types';
import { getReservationState, type ReservationStateKey } from '../components/reservationState';

// Che cosa dice il toast di un reservation:updated. Prima ogni modifica era
// «Prenotazione aggiornata: NOME», anche gli stati del messaggio di
// conferma: il 18/10 una prenotazione appena creata ne ha dati quattro in
// mezzo minuto (invio, poi sent/delivered/read di Twilio), uguali e
// impilati. Qui il confronto con la riga che il client ha già sceglie la
// frase di quello che è cambiato davvero; null = la card si aggiorna e
// basta. Si prova da tests/api, senza browser.

export interface ReservationNotice {
  /** Chiave sotto common:toast; il nome dell'ospite lo aggiunge chi chiama. */
  key: string;
  vars?: Record<string, string>;
  tone?: 'info' | 'error';
  /** ms; un errore senza durata resta finché non lo si chiude. */
  duration?: number;
  /** Per stateChangedNamed: lo stato di cui chi chiama mette il nome. */
  state?: ReservationStateKey;
}

// L'esito dei messaggi all'ospite: da solo non è la prenotazione.
const DELIVERY_FIELDS = new Set([
  'confirmation_status', 'confirmation_channel', 'confirmation_provider_sid',
  'confirmation_sent_at', 'confirmation_delivered_at', 'confirmation_error',
  'reminder_sent',
]);

// Le colonne del join della GET (rubrica, ultimo pagamento, autore): non
// sono della prenotazione, e una riga nuda non le porta.
const JOINED_FIELDS = new Set([
  'created_by_user_name', 'customer_is_vip', 'customer_is_blacklisted',
  'customer_blacklist_reason', 'customer_preferred_table_id',
  'customer_preferred_table_name', 'customer_dietary_notes',
  'customer_preferences_notes',
]);
const isJoined = (k: string) => JOINED_FIELDS.has(k) || k.startsWith('latest_payment_');

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

type DeliveryStage = 'sent' | 'delivered' | 'read' | 'failed';

/** Gli stati di Twilio e Meta raggruppati come li legge lo staff: queued e
 *  sent sono entrambi «inviata», e il passaggio dall'uno all'altro tace. */
export const deliveryStage = (status: unknown): DeliveryStage | null => {
  switch (status) {
    case 'queued': case 'accepted': case 'sending': case 'sent': return 'sent';
    case 'delivered': return 'delivered';
    case 'read': return 'read';
    case 'failed': case 'undelivered': return 'failed';
    default: return null;
  }
};

/** Le stesse etichette dei toast dei bottoni di conferma (ReservationList):
 *  la frase dell'eco è identica alla loro, e il dedup le fonde. */
export const deliveryChannelLabel = (channel: unknown): string =>
  channel === 'sms' ? 'SMS' : channel === 'email' ? 'email' : 'WhatsApp';

const STAGE_KEY: Record<DeliveryStage, string> = {
  sent: 'confirmSentNamed',
  delivered: 'confirmDeliveredNamed',
  read: 'confirmReadNamed',
  failed: 'confirmFailedNamed',
};

// Un cambio di stato (arrivato, in uscita, no-show, annullata…) porta con
// sé al più il tavolo (annullata e rifiutata lo staccano) e la durata
// (Arrivato su un tavolo in ritardo la allunga): il resto è un'altra modifica.
const STATE_FIELDS = new Set(['reservation_status', 'arrival_status']);
const STATE_COMPANIONS = new Set(['table_id', 'duration_minutes']);

const GENERIC: ReservationNotice = { key: 'bookingUpdatedNamed' };

export function reservationUpdateNotice(prev: Reservation | undefined, next: Reservation): ReservationNotice | null {
  if (!prev) return GENERIC;
  const p = prev as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  // Solo le chiavi che la riga nuova porta: una riga nuda non ha il join,
  // e la sua assenza non è un cambiamento.
  const changed = Object.keys(n).filter(k => !isJoined(k) && !same(p[k], n[k]));
  const booking = changed.filter(k => !DELIVERY_FIELDS.has(k));

  // L'ospite dal link o da WhatsApp: viene prima dello stato che si porta dietro.
  if (!prev.guest_cancelled_at && next.guest_cancelled_at) return { key: 'guestCancelledNamed' };
  if (!prev.guest_confirmed_at && next.guest_confirmed_at) return { key: 'guestConfirmedNamed' };

  // La frase è quella del picker di stato («Rossi Giulia: stato →
  // Arrivato»): chi cambia lo stato vede il suo toast e l'eco, uguali, e il
  // dedup li fonde.
  if (booking.some(k => STATE_FIELDS.has(k)) && booking.every(k => STATE_FIELDS.has(k) || STATE_COMPANIONS.has(k))) {
    return { key: 'stateChangedNamed', state: getReservationState(next) };
  }
  if (booking.length > 0) return GENERIC;

  const stage = deliveryStage(next.confirmation_status);
  if (stage && stage !== deliveryStage(prev.confirmation_status)) {
    return {
      key: STAGE_KEY[stage],
      vars: { canale: deliveryChannelLabel(next.confirmation_channel) },
      // La consegna fallita si vede in rosso, ma non resta: spesso il
      // ripiego su SMS parte da solo subito dopo.
      ...(stage === 'failed' ? { tone: 'error' as const, duration: 8000 } : {}),
    };
  }
  if (!prev.reminder_sent && next.reminder_sent) return { key: 'reminderSentNamed' };

  // Cambiato solo un dettaglio dell'esito (queued → sent, un orario): tace.
  if (changed.length > 0) return null;
  // Nessuna differenza: l'eco di una modifica che questo client ha già
  // applicato dalla risposta HTTP, arrivata prima del socket.
  return GENERIC;
}
