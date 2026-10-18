import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Receipt, X } from 'lucide-react';
import { ArrivalStatus, ReservationStatus, type Reservation } from '../../types';
import { useSocket } from '../../hooks/useSocket';
import { formatMoneyMinor } from '../../utils/money';
import { toTitleCase } from '../../utils/text';

/* ===========================================================================
   «Il tavolo X ha pagato» — dalla cassa Passepartout.

   Il server legge i tavoli aperti in cassa ogni minuto; una comanda che
   sparisce e, riletta, risulta pagata diventa l'evento
   'passepartout:tavolo-pagato' (avvisaTavoliPagati in server.ts), mandato
   solo a titolare, GM, manager e reception. Qui il modal propone di
   liberare il tavolo della prenotazione: «Libera il tavolo» o «Non ora».

   Più tavoli che pagano insieme si mettono in fila, uno alla volta. Un
   avviso sparisce da solo quando la prenotazione non è più da liberare —
   l'ha liberata un altro dispositivo, o è stata annullata.
   ========================================================================= */

interface AvvisoPagato {
  pp_comanda_id: number;
  reservation_id: number;
  table_id: number;
  tavolo: string | null;
  customer_name: string;
  guests: number | null;
  coperti: number | null;
  totale_cents: number;
}

interface Props {
  enabled: boolean;
  reservations: Reservation[];
  onFree: (reservation: Reservation) => void;
}

const daLiberare = (r: Reservation | undefined): r is Reservation =>
  !!r
  && r.arrival_status !== ArrivalStatus.DEPARTED
  && (r.reservation_status ?? ReservationStatus.CONFIRMED) === ReservationStatus.CONFIRMED;

export const AvvisoTavoloPagato: React.FC<Props> = ({ enabled, reservations, onFree }) => {
  const { t } = useTranslation('common', { useSuspense: false });
  const { socket } = useSocket();
  const [coda, setCoda] = useState<AvvisoPagato[]>([]);

  useEffect(() => {
    if (!socket || !enabled) return;
    const onPagato = (a: AvvisoPagato) => {
      if (!a || !Number.isFinite(Number(a.reservation_id))) return;
      setCoda(prev => prev.some(x => x.reservation_id === a.reservation_id) ? prev : [...prev, a]);
    };
    socket.on('passepartout:tavolo-pagato', onPagato);
    return () => { socket.off('passepartout:tavolo-pagato', onPagato); };
  }, [socket, enabled]);

  const togli = (reservationId: number) => setCoda(prev => prev.filter(x => x.reservation_id !== reservationId));

  const ancora = coda.filter(a => daLiberare(reservations.find(r => r.id === a.reservation_id)));
  const avviso = ancora[0];
  const res = avviso ? reservations.find(r => r.id === avviso.reservation_id) : undefined;
  if (!enabled || !avviso || !daLiberare(res)) return null;

  const coperti = avviso.coperti ?? avviso.guests;
  const dettagli = [
    toTitleCase(avviso.customer_name),
    coperti ? t('tavoloPagato.coperti', { count: coperti }) : null,
    avviso.totale_cents > 0 ? formatMoneyMinor(avviso.totale_cents) : null,
  ].filter(Boolean).join(' · ');

  // Sopra il modal della prenotazione (z-50) e ai suoi picker (z-[60]): il
  // pagamento arriva mentre si lavora su qualcos'altro.
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-[var(--ds-backdrop)] sm:px-4" onClick={() => togli(avviso.reservation_id)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="avviso-tavolo-pagato"
        className="bg-[var(--ds-surface)] w-full sm:max-w-md rounded-t-[var(--ds-radius)] sm:rounded-[var(--ds-radius)] shadow-[var(--ds-shadow-raised)] overflow-hidden pb-[env(safe-area-inset-bottom)] sm:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="w-9 h-1 rounded-full bg-[var(--ds-border-strong)]" />
        </div>
        <div className="flex items-start gap-4 px-5 pt-5 pb-4 sm:px-6 sm:pt-6">
          <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]">
            <Receipt className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h3 id="avviso-tavolo-pagato" className="text-[18px] font-semibold leading-snug tracking-[-0.01em] text-[var(--ds-text-primary)]">
              {avviso.tavolo ? t('tavoloPagato.title', { tavolo: avviso.tavolo }) : t('tavoloPagato.titleNoTable')}
            </h3>
            <p className="mt-1 truncate text-[14px] text-[var(--ds-text-muted)]">{dettagli}</p>
          </div>
          <button
            type="button"
            onClick={() => togli(avviso.reservation_id)}
            aria-label={t('tavoloPagato.later')}
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 pb-5 sm:px-6 sm:pb-6">
          <p className="text-[15px] leading-relaxed text-[var(--ds-text-secondary)]">{t('tavoloPagato.body')}</p>
          <div className="mt-4 flex flex-col gap-2.5">
            <button
              type="button"
              onClick={() => { togli(avviso.reservation_id); onFree(res); }}
              className="inline-flex w-full items-center justify-center gap-2 h-11 rounded-[var(--ds-radius-control)] text-[15px] font-semibold bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {t('tavoloPagato.free')}
            </button>
            <button
              type="button"
              onClick={() => togli(avviso.reservation_id)}
              className="inline-flex w-full items-center justify-center h-11 rounded-[var(--ds-radius-control)] text-[15px] font-medium bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {t('tavoloPagato.later')}
            </button>
          </div>
          {ancora.length > 1 && (
            <p className="mt-3 text-center text-[13px] text-[var(--ds-text-muted)]">
              {t('tavoloPagato.more', { count: ancora.length - 1 })}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
