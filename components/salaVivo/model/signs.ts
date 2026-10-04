import type { BanquetMenu, Reservation } from '../../../types';
import { isSeated } from '../../reservationState';
import { timePart } from '../../../utils/displayTime';
import { toTitleCase } from '../../../utils/text';
import type { LiveService, SceneCopy } from '../types';
import { isLiveParty, reservationMs } from './service';
import type { GroupStatus } from './tableStatus';

/* I cartellini sui tavoli dove non siede nessuno, e la seconda riga
 * dell'etichetta. Puro: i testi arrivano tradotti dalla pagina (SceneCopy),
 * perché il modello non conosce i18n.
 *
 * - «Evento» su un tavolo di un banchetto del servizio: vince su «Riservato»,
 *   come il colore del tavolo lascia vincere il banchetto.
 * - «Riservato · 20:30» per la prenotazione del turno che sta per arrivare,
 *   da 90 minuti prima a 120 dopo l'ora prenotata: prima della piantina, che
 *   tiene il tavolo da 30 minuti prima, così chi entra vede già quali tavoli
 *   sono presi.
 * - Niente cartellino dove siede qualcuno: lì si vedono le persone.
 *
 * I nomi delle persone escono solo a nomi accesi: a nomi spenti nessun nome
 * arriva nemmeno nel modello, e uno schermo pubblico non li mostra. */

/** «Riservato» da così tanto prima dell'ora prenotata… */
export const SIGN_AHEAD_MIN = 90;
/** …a così tanto dopo, come la finestra dei ritardi della piantina. */
export const SIGN_LATE_MIN = 120;
/** La seconda riga dell'etichetta, «…» compreso: dalla porta un nome più
 *  lungo non si legge comunque. */
export const CAPTION_MAX = 24;

const MIN = 60_000;

/** Un testo tagliato a `max` caratteri veri (code point, non unità UTF-16:
 *  un'emoji non si spezza a metà), con «…» se non ci stava. */
export function truncateCaption(text: string, max: number = CAPTION_MAX): string {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/** Il nome di una comitiva come si mostra: toTitleCase, spazi ridotti, al
 *  più CAPTION_MAX caratteri. null senza nome. */
export function guestName(r: Pick<Reservation, 'customer_name'>): string | null {
  const name = toTitleCase(String(r?.customer_name ?? '')).replace(/\s+/g, ' ').trim();
  return name ? truncateCaption(name) : null;
}

export type SignChoice =
  | { kind: 'reserved'; reservation: Reservation; time: string }
  | { kind: 'event'; banquet: BanquetMenu };

/** Il cartellino di un tavolo disegnato. `candidates` sono le prenotazioni del
 *  servizio sui tavoli del suo gruppo; `occupied` dice se ci siede qualcuno
 *  (la sua comitiva o una che trabocca dal banchetto). */
export function signFor(args: {
  status: GroupStatus;
  candidates: readonly Reservation[];
  occupied: boolean;
  service: LiveService;
  nowMs: number;
}): SignChoice | null {
  const { status, occupied, service, nowMs } = args;
  if (occupied) return null;
  if (status?.banquet) return { kind: 'event', banquet: status.banquet };

  // Viva, non ancora seduta, del turno, nella finestra del cartellino.
  const startOf = (r: Reservation | null | undefined): number | null => {
    if (!r || isSeated(r) || r.shift !== service.shift || !isLiveParty(r, service, nowMs)) return null;
    const t = reservationMs(r);
    return Number.isFinite(t) && t >= nowMs - SIGN_LATE_MIN * MIN && t <= nowMs + SIGN_AHEAD_MIN * MIN ? t : null;
  };

  // La prenotazione dietro il colore del tavolo (l'anello, l'attesa) vince:
  // il cartellino parla della stessa. Se no la più vicina all'istante, poi la
  // prima, poi l'id più basso.
  let pick: Reservation | null = startOf(status?.active) !== null ? status.active : null;
  if (!pick) {
    let bestGap = Infinity;
    let bestAt = Infinity;
    for (const r of Array.isArray(args.candidates) ? args.candidates : []) {
      const t = startOf(r);
      if (t === null) continue;
      const gap = Math.abs(t - nowMs);
      if (pick === null || gap < bestGap || (gap === bestGap && (t < bestAt || (t === bestAt && r.id < pick.id)))) {
        pick = r;
        bestGap = gap;
        bestAt = t;
      }
    }
  }
  return pick ? { kind: 'reserved', reservation: pick, time: timePart(pick.reservation_time) } : null;
}

// Una riga vuota non è una riga: senza testo resta solo il nome del tavolo
// (prima che i18n sia pronto la pagina passa testi vuoti).
const lineOrNull = (text: string): string | null => {
  const line = truncateCaption(text.replace(/\s+/g, ' ').trim());
  return line ? line : null;
};

/** La seconda riga dell'etichetta, in quest'ordine: chi siede al tavolo (solo
 *  a nomi accesi, se no niente), il banchetto (il suo nome a nomi accesi, se
 *  no «Evento»), «Riservato · HH:MM». null: solo il nome del tavolo. */
export function captionFor(args: {
  sign: SignChoice | null;
  seated: Reservation | null;
  showNames: boolean;
  copy: SceneCopy;
}): string | null {
  const { sign, seated, showNames, copy } = args;
  if (seated) return showNames ? guestName(seated) : null;
  if (sign?.kind === 'event') {
    // Il nome del banchetto com'è scritto: lo scrive lo staff, e non è il
    // nome di un cliente da raddrizzare.
    const banquetName = String(sign.banquet?.name ?? '').trim();
    return lineOrNull(showNames && banquetName ? banquetName : String(copy?.event ?? ''));
  }
  if (sign?.kind === 'reserved') {
    const text = typeof copy?.reserved === 'function' ? copy.reserved(sign.time) : sign.time;
    return lineOrNull(String(text ?? ''));
  }
  return null;
}
