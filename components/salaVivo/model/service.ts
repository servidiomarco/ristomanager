import { ArrivalStatus, ReservationStatus, Shift, type Reservation } from '../../../types';
import { currentService, serviceDayOf } from '../../../utils/displayTime';
import type { LiveService } from '../types';

/* Il servizio che la Sala dal vivo mostra, e chi ne fa parte.
 *
 * Sempre quello in corso nel fuso del ristorante, mai la data scelta in
 * testata: un tablet all'ingresso deve dire com'è la sala adesso. Il giorno
 * di servizio non è il giorno del calendario: alle 00:30 si è ancora nella
 * cena di ieri, e un walk-in di quell'ora (che Accoglienza registra col turno
 * LUNCH, perché guarda solo l'ora) appartiene a quella cena.
 *
 * Funzioni pure: l'istante arriva da fuori (l'orologio al minuto di App), così
 * i test lo fissano e la sala non cambia fra un render e l'altro. */

/** Una prenotazione più lontana di così dall'istante non è mai del servizio in
 *  corso: il controllo costa una sottrazione e risparmia la lettura del giorno
 *  di servizio (Intl) a tutto lo storico che App tiene in memoria. 30 ore
 *  coprono un pranzo delle 11 letto alle 4:59 della notte dopo. */
export const SERVICE_WINDOW_MS = 30 * 3600_000;

/** Il servizio in corso all'istante `now`, nel fuso del ristorante. Il turno
 *  diventa l'enum Shift qui, una volta sola: getTableMerges e compagni lo
 *  vogliono così, e nessun cast arriva alle chiamate. */
export function liveService(now: Date): LiveService {
  const s = currentService(now);
  const shift = s.shift === 'LUNCH' ? Shift.LUNCH : Shift.DINNER;
  return { date: s.date, shift, key: `${s.date}:${shift}` };
}

// L'istante della prenotazione in ms, NaN se manca o non si legge.
export const reservationMs = (r: Reservation): number =>
  typeof r?.reservation_time === 'string' ? Date.parse(r.reservation_time) : NaN;

/** La prenotazione è del giorno di servizio mostrato, qualunque turno abbia
 *  scritto sopra: il turno di un walk-in notturno è quello sbagliato. */
export function inService(r: Reservation, service: LiveService, nowMs: number): boolean {
  const t = reservationMs(r);
  return Number.isFinite(t)
    && Math.abs(t - nowMs) < SERVICE_WINDOW_MS
    && serviceDayOf(r.reservation_time) === service.date;
}

/** Una comitiva viva: del servizio, non annullata, non rifiutata, non un
 *  no-show, e non ancora andata via. È la definizione che PR2c usa per chi è
 *  in sala; i tavoli la usano per le comitive sedute. */
export function isLiveParty(r: Reservation, service: LiveService, nowMs: number): boolean {
  const status = r.reservation_status;
  return inService(r, service, nowMs)
    && status !== ReservationStatus.CANCELLED
    && status !== ReservationStatus.DECLINED
    && status !== ReservationStatus.NO_SHOW
    && r.arrival_status !== ArrivalStatus.DEPARTED;
}
