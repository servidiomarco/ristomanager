import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Reservation, Table, Room, Shift, BanquetMenu, TableMerge, ArrivalStatus, ReservationStatus } from '../types';
import { getRomeTimePart } from '../utils/reservationTime';
import { toTitleCase } from '../utils/text';
import { applyMerges } from '../utils/tableMerge';
import { getTableMerges } from '../services/apiService';
import { ArrowRight, X } from 'lucide-react';

interface ArrivalsTimelineProps {
  /** Already filtered to the selected day + the global shift filter. */
  reservations: Reservation[];
  tables: Table[];
  rooms: Room[];
  banquetMenus: BanquetMenu[];
  /** YYYY-MM-DD of the day being shown — used for banquet table conflicts. */
  selectedDateStr: string;
  /** Epoch ms, ticking every minute, so the "da 2h 14m" column stays live. */
  nowTick: number;
  /** Full-row replace — the PUT endpoint destructures the whole body. */
  onUpdateReservation?: (res: Reservation) => Promise<void>;
  /** Routes a PENDING booking into the existing confirm modal, which carries
   *  the unpaid-deposit guard. We deliberately don't confirm inline. */
  onConfirmPending?: (res: Reservation) => void;
  onNavigateToReservations?: () => void;
}

type RowAction = 'arrive' | 'departing' | 'free' | 'assign' | 'confirm' | null;

/** What the row looks like and what the button does next. The button is always
 *  the NEXT step, never the current state — that's what makes the timeline
 *  actionable at a glance during service. */
const rowState = (r: Reservation): { tone: string; action: RowAction } => {
  if (r.reservation_status === ReservationStatus.PENDING) {
    return { tone: 'bg-[var(--ds-pending-tint)]', action: 'confirm' };
  }
  switch (r.arrival_status) {
    case ArrivalStatus.ARRIVED:
      return { tone: 'bg-[var(--ds-seated-tint)]', action: 'departing' };
    case ArrivalStatus.DEPARTING:
      return { tone: 'bg-[var(--ds-seated-tint)]', action: 'free' };
    case ArrivalStatus.DEPARTED:
      return { tone: 'bg-[var(--ds-surface-row)]', action: null };
    default:
      return {
        tone: 'bg-[var(--ds-arriving-tint)]',
        action: r.table_id ? 'arrive' : 'assign',
      };
  }
};

const ACTION_LABEL: Record<Exclude<RowAction, null>, string> = {
  arrive: 'Arrivato',
  departing: 'In uscita',
  free: 'Libera',
  assign: 'Assegna',
  confirm: 'Conferma',
};

const ACTION_STYLE: Record<Exclude<RowAction, null>, string> = {
  arrive: 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)]',
  departing: 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] hover:bg-[var(--ds-surface-row)]',
  free: 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] ring-1 ring-inset ring-[var(--ds-seated-solid)]/25 hover:brightness-95',
  // Amber pairs with dark text — white on this gold is 3.25:1 (spec §3.3).
  assign: 'bg-[var(--ds-pending-solid)] text-[var(--ds-pending-fg)] hover:brightness-95',
  confirm: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] ring-1 ring-inset ring-[var(--ds-pending-solid)]/30 hover:brightness-95',
};

/** "da 2h 14m" / "tra 25 min" — how long since (or until) the booked time. */
const elapsedLabel = (reservationTime: string, nowTick: number): string => {
  const t = new Date(reservationTime).getTime();
  if (Number.isNaN(t)) return '';
  const diffMin = Math.round((nowTick - t) / 60000);
  const abs = Math.abs(diffMin);
  const prefix = diffMin >= 0 ? 'da' : 'tra';
  if (abs < 60) return `${prefix} ${abs} min`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `${prefix} ${h}h` : `${prefix} ${h}h ${m}m`;
};

export const ArrivalsTimeline: React.FC<ArrivalsTimelineProps> = ({
  reservations,
  tables,
  rooms,
  banquetMenus,
  selectedDateStr,
  nowTick,
  onUpdateReservation,
  onConfirmPending,
  onNavigateToReservations,
}) => {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [assigning, setAssigning] = useState<Reservation | null>(null);

  // Unioni tavoli del giorno (entrambi i turni): servono sia al badge di
  // riga — "26+27" invece del solo tavolo della prenotazione — sia al picker
  // di assegnazione, dove il tavolo unito compariva come libero (il server
  // ora lo rifiuta con 409, ma l'operatore lo scopriva solo al salvataggio).
  // Si ricaricano all'apertura del picker per non assegnare su unioni stantie.
  const [dayMerges, setDayMerges] = useState<TableMerge[]>([]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([getTableMerges(selectedDateStr, Shift.LUNCH), getTableMerges(selectedDateStr, Shift.DINNER)])
      .then(results => { if (!cancelled) setDayMerges(results.flat()); })
      .catch(() => { if (!cancelled) setDayMerges([]); });
    return () => { cancelled = true; };
  }, [selectedDateStr, assigning?.id]);

  const assignMerges = useMemo(
    () => (assigning ? dayMerges.filter(m => m.shift === assigning.shift) : []),
    [assigning, dayMerges]
  );

  const tableById = useMemo(() => new Map(tables.map(t => [t.id, t])), [tables]);
  const roomById = useMemo(() => new Map(rooms.map(r => [r.id, r])), [rooms]);

  // Nome dell'unione per tavolo e turno ("26+27"): la prenotazione sta su UN
  // tavolo del gruppo, ma in sala l'ospite occupa l'intera unione.
  const mergedNameByTable = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of dayMerges) {
      const ids = [m.primary_id, ...m.merged_ids];
      const names = ids.map(id => tableById.get(id)?.name).filter(Boolean);
      if (names.length < 2) continue;
      const joined = names.join('+');
      for (const id of ids) map.set(`${m.shift}:${id}`, joined);
    }
    return map;
  }, [dayMerges, tableById]);

  const rows = useMemo(
    () => [...reservations].sort((a, b) => a.reservation_time.localeCompare(b.reservation_time)),
    [reservations]
  );
  const withoutTable = rows.filter(r => !r.table_id).length;

  const patch = async (r: Reservation, changes: Partial<Reservation>) => {
    if (!onUpdateReservation) return;
    setBusyId(r.id);
    try {
      // Merge onto the full row: PUT /reservations/:id is a full replace and a
      // partial body would null out NOT NULL columns.
      await onUpdateReservation({ ...r, ...changes });
    } catch {
      // App-level handler already surfaces the toast.
    } finally {
      setBusyId(null);
    }
  };

  const runAction = (r: Reservation, action: RowAction) => {
    switch (action) {
      case 'arrive':
        return patch(r, { arrival_status: ArrivalStatus.ARRIVED });
      case 'departing':
        return patch(r, { arrival_status: ArrivalStatus.DEPARTING });
      case 'free':
        return patch(r, { arrival_status: ArrivalStatus.DEPARTED });
      case 'assign':
        return setAssigning(r);
      case 'confirm':
        return onConfirmPending?.(r);
      default:
        return undefined;
    }
  };

  // Tables already spoken for in the same service — other bookings on the day
  // plus any banquet holding the table. Mirrors the conflict rule the rest of
  // the app uses, so the picker can't hand out a seat that's taken.
  const takenTableIds = useMemo(() => {
    if (!assigning) return new Set<number>();
    const taken = new Set<number>();
    for (const r of reservations) {
      if (r.id === assigning.id || !r.table_id) continue;
      if (r.shift === assigning.shift) taken.add(r.table_id);
    }
    for (const b of banquetMenus) {
      if (b.event_date !== selectedDateStr || b.shift !== assigning.shift) continue;
      for (const id of b.table_ids || []) taken.add(id);
    }
    // Un tavolo occupato occupa l'intera unione (stessa regola del server).
    for (const m of assignMerges) {
      const group = [m.primary_id, ...m.merged_ids];
      if (group.some(id => taken.has(id))) group.forEach(id => taken.add(id));
    }
    return taken;
  }, [assigning, reservations, banquetMenus, selectedDateStr, assignMerges]);

  const freeByRoom = useMemo(() => {
    if (!assigning) return [];
    // I tavoli uniti compaiono come unità ("45+47", posti sommati) sul
    // primario; i secondari spariscono dai selezionabili, come in FloorPlan.
    const mergedSecondaryIds = new Set(assignMerges.flatMap(m => m.merged_ids));
    const displayTables = applyMerges(tables, assignMerges);
    return rooms
      .filter(room => !room.is_closed)
      .map(room => ({
        room,
        tables: displayTables
          .filter(t => t.room_id === room.id && !mergedSecondaryIds.has(t.id) && !takenTableIds.has(t.id))
          .sort((a, b) => a.name.localeCompare(b.name, 'it', { numeric: true })),
      }))
      .filter(g => g.tables.length > 0);
  }, [assigning, rooms, tables, takenTableIds, assignMerges]);

  return (
    <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4 sm:p-5 flex flex-col gap-3 min-w-0 w-full h-full">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] sm:text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
            Timeline arrivi
          </h2>
          <p className="text-[13px] text-[var(--ds-text-muted)] mt-0.5">
            {rows.length} {rows.length === 1 ? 'prenotazione' : 'prenotazioni'}
            {withoutTable > 0 && ` · ${withoutTable} senza tavolo`}
          </p>
        </div>
        {onNavigateToReservations && (
          <button
            type="button"
            onClick={onNavigateToReservations}
            className="flex-shrink-0 inline-flex items-center gap-1.5 text-[14px] font-medium text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] rounded-full px-1"
          >
            Vedi tutte <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-[16px] bg-[var(--ds-surface-row)] px-4 py-8 text-center text-[14px] text-[var(--ds-text-muted)]">
          Nessuna prenotazione per questo turno
        </div>
      ) : (
        // Five rows (5 × 60px + 4 × 8px gap) then scroll. On xl the card is
        // height-constrained by the grid row instead, so the cap lifts.
        <div className="flex-1 min-h-0 max-h-[332px] xl:max-h-none flex flex-col gap-2 overflow-y-auto scrollbar-hide -mx-1 px-1">
          {rows.map(r => {
            const { tone, action } = rowState(r);
            const table = r.table_id ? tableById.get(r.table_id) : undefined;
            const tableLabel = r.table_id
              ? (mergedNameByTable.get(`${r.shift}:${r.table_id}`) ?? table?.name)
              : undefined;
            const room = table ? roomById.get(table.room_id) : undefined;
            const meta = [room?.name, `${r.guests} coperti`, r.notes?.trim()]
              .filter(Boolean)
              .join(' · ');
            const busy = busyId === r.id;

            return (
              <div key={r.id} className={`flex items-center gap-3 rounded-[16px] p-3 min-w-0 ${tone}`}>
                {/* Wide enough for the longest realistic label ("tra 10h 30m")
                    on a single line — two lines here would set the row height
                    and break the rhythm of the list. */}
                <div className="flex-shrink-0 w-[68px]">
                  <div className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)] leading-tight">
                    {getRomeTimePart(r.reservation_time)}
                  </div>
                  <div className="text-[12px] text-[var(--ds-text-muted)] leading-tight mt-0.5 whitespace-nowrap">
                    {elapsedLabel(r.reservation_time, nowTick)}
                  </div>
                </div>

                <span
                  className="flex-shrink-0 inline-flex h-9 min-w-[36px] px-1.5 items-center justify-center rounded-[10px] bg-[var(--ds-surface)]/70 text-[14px] font-semibold tabular-nums text-[var(--ds-text-secondary)]"
                  aria-label={tableLabel ? `Tavolo ${tableLabel}` : 'Senza tavolo'}
                >
                  {tableLabel ?? '—'}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-semibold text-[var(--ds-text-primary)] truncate">
                    {toTitleCase(r.customer_name)}
                  </div>
                  {meta && (
                    <div className="text-[13px] text-[var(--ds-text-muted)] truncate">{meta}</div>
                  )}
                </div>

                {action && (
                  <button
                    type="button"
                    disabled={busy || (action !== 'confirm' && action !== 'assign' && !onUpdateReservation)}
                    onClick={() => runAction(r, action)}
                    className={`flex-shrink-0 h-9 px-3.5 rounded-full text-[14px] font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${ACTION_STYLE[action]}`}
                  >
                    {busy ? '…' : ACTION_LABEL[action]}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {assigning && createPortal(
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-[var(--ds-backdrop)]">
          <div className="w-full max-w-lg max-h-[80vh] flex flex-col bg-[var(--ds-surface)] rounded-[24px] shadow-[var(--ds-shadow-raised)] overflow-hidden">
            <div className="flex items-start justify-between gap-3 p-5 pb-3">
              <div className="min-w-0">
                <h3 className="text-[17px] font-semibold text-[var(--ds-text-primary)] truncate">
                  Assegna tavolo
                </h3>
                <p className="text-[13px] text-[var(--ds-text-muted)] mt-0.5 truncate">
                  {toTitleCase(assigning.customer_name)} · {assigning.guests} coperti ·{' '}
                  {assigning.shift === Shift.LUNCH ? 'pranzo' : 'cena'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAssigning(null)}
                className="flex-shrink-0 h-9 w-9 inline-flex items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)] transition-colors"
                aria-label="Chiudi"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-5 flex flex-col gap-4">
              {freeByRoom.length === 0 ? (
                <p className="text-[14px] text-[var(--ds-text-muted)] py-6 text-center">
                  Nessun tavolo libero in questo turno
                </p>
              ) : (
                freeByRoom.map(({ room, tables: free }) => (
                  <div key={room.id} className="min-w-0">
                    <div className="text-[13px] font-medium text-[var(--ds-text-secondary)] mb-2">
                      {room.name}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {free.map(t => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={async () => {
                            const target = assigning;
                            setAssigning(null);
                            await patch(target, { table_id: t.id });
                          }}
                          className={`h-10 min-w-[48px] px-3 rounded-[12px] text-[14px] font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                            t.seats < assigning.guests
                              ? 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-border)]'
                              : 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] hover:brightness-95'
                          }`}
                          title={`${t.seats} posti${t.seats < assigning.guests ? ' — sotto la capienza richiesta' : ''}`}
                        >
                          {t.name}
                          <span className="ml-1.5 font-normal opacity-70">{t.seats}p</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
