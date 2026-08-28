import React, { useMemo, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ModalShell, dsInput, dsSelect, dsButton, Field, SegmentedControl } from './ds';
import { Reservation, Shift, Room, Table, ArrivalStatus, BanquetMenu } from '../types';
import { Printer, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getRomeDatePart, getRomeTimePart } from '../utils/reservationTime';
import { toTitleCase } from '../utils/text';
import { isSeated } from './reservationState';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  reservations: Reservation[];
  banquetMenus: BanquetMenu[];
  rooms: Room[];
  tables: Table[];
  initialDate: string;
  initialShift: Shift | 'ALL';
}

const formatPrintDate = (dateStr: string): string => {
  const d = new Date(`${dateStr}T12:00:00`);
  return d.toLocaleDateString('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
};

export const PrintReservationsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  reservations,
  banquetMenus,
  rooms,
  tables,
  initialDate,
  initialShift,
}) => {
  const { hasPermission } = useAuth();
  const canViewBanquetPrice = hasPermission('banquet:view_price');
  const [printDate, setPrintDate] = useState(initialDate);
  const [printShift, setPrintShift] = useState<Shift | 'ALL'>(initialShift);
  const [printRoomId, setPrintRoomId] = useState<number | 'ALL'>('ALL');
  const [printArrival, setPrintArrival] = useState<ArrivalStatus | 'ALL'>('ALL');
  const [printSort, setPrintSort] = useState<'TIME' | 'TABLE'>('TIME');
  const [includeBanquets, setIncludeBanquets] = useState(true);

  useEffect(() => {
    if (isOpen) {
      setPrintDate(initialDate);
      setPrintShift(initialShift);
      setPrintRoomId('ALL');
      setPrintArrival('ALL');
      setPrintSort('TIME');
      setIncludeBanquets(true);
    }
  }, [isOpen, initialDate, initialShift]);

  const tableById = useMemo(() => {
    const map = new Map<number, Table>();
    tables.forEach(t => map.set(t.id, t));
    return map;
  }, [tables]);

  const filteredReservations = useMemo(() => {
    const rows = reservations
      .filter(r => getRomeDatePart(r.reservation_time) === printDate)
      .filter(r => printShift === 'ALL' || r.shift === printShift)
      .filter(r => {
        if (printRoomId === 'ALL') return true;
        if (!r.table_id) return false;
        const table = tableById.get(r.table_id);
        return table?.room_id === printRoomId;
      })
      // "Arrivati" prints everyone in house (ARRIVED + DEPARTING), matching
      // the footer counter which also uses isSeated().
      .filter(r => {
        if (printArrival === 'ALL') return true;
        if (printArrival === ArrivalStatus.ARRIVED) return isSeated(r);
        return (r.arrival_status || ArrivalStatus.WAITING) === printArrival;
      });

    if (printSort === 'TABLE') {
      // Ordinamento naturale sul nome tavolo ("1","2","10" invece di "1","10","2").
      // Chi non ha tavolo assegnato scivola in fondo: in stampa serve per capire
      // subito chi ancora deve essere accomodato.
      return rows.slice().sort((a, b) => {
        const ta = a.table_id ? tableById.get(a.table_id)?.name ?? '' : '';
        const tb = b.table_id ? tableById.get(b.table_id)?.name ?? '' : '';
        if (!ta && tb) return 1;
        if (ta && !tb) return -1;
        const byTable = ta.localeCompare(tb, 'it', { numeric: true, sensitivity: 'base' });
        if (byTable !== 0) return byTable;
        return a.reservation_time.localeCompare(b.reservation_time);
      });
    }
    return rows.slice().sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));
  }, [reservations, printDate, printShift, printRoomId, printArrival, printSort, tableById]);

  const banquetsForDate = useMemo(() => {
    if (!includeBanquets) return [];
    return banquetMenus.filter(b => b.event_date === printDate);
  }, [banquetMenus, printDate, includeBanquets]);

  const totalGuests = filteredReservations.reduce((acc, r) => acc + r.guests, 0);
  const totalChildren = filteredReservations.reduce((acc, r) => acc + (r.children || 0), 0);
  const arrivedCount = filteredReservations.filter(r => isSeated(r)).length;

  const shiftLabel = printShift === 'ALL'
    ? 'Tutti i turni'
    : printShift === Shift.LUNCH ? 'Pranzo' : 'Cena';
  const roomLabel = printRoomId === 'ALL'
    ? 'Tutte le sale'
    : (rooms.find(r => r.id === printRoomId)?.name || 'Sala');

  if (!isOpen) return null;

  const handlePrint = () => {
    window.print();
  };

  return (
    <>
      {/* Modal — visible on screen, hidden in print */}
      <ModalShell
        open={isOpen}
        onClose={onClose}
        title={
          <span className="inline-flex items-center gap-2">
            <Printer className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-secondary)]" aria-hidden />
            Stampa Prenotazioni
          </span>
        }
        size="md"
        // Il backdrop e' un figlio diretto di <body>, quindi @media print lo
        // nasconderebbe comunque; `no-print` resta esplicito come prima.
        className="no-print"
        bodyClassName="px-5 py-5 sm:px-6"
        footer={
          <>
            <button type="button" onClick={onClose} className={dsButton.secondary}>
              Annulla
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={filteredReservations.length === 0 && banquetsForDate.length === 0}
              className={dsButton.primary}
            >
              <Printer className="h-4 w-4" aria-hidden />
              Stampa
            </button>
          </>
        }
      >
        <div className="space-y-4 rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)] sm:p-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Data" htmlFor="print-date">
              <input
                id="print-date"
                type="date"
                value={printDate}
                onChange={(e) => setPrintDate(e.target.value)}
                className={dsInput}
              />
            </Field>
            <Field label="Turno">
              <SegmentedControl<Shift | 'ALL'>
                ariaLabel="Turno"
                value={printShift}
                onChange={setPrintShift}
                options={[
                  { value: 'ALL' as const, label: 'Tutti' },
                  { value: Shift.LUNCH, label: 'Pranzo' },
                  { value: Shift.DINNER, label: 'Cena' },
                ]}
              />
            </Field>
            <Field label="Sala" htmlFor="print-room">
              <select
                id="print-room"
                value={printRoomId === 'ALL' ? 'ALL' : String(printRoomId)}
                onChange={(e) => setPrintRoomId(e.target.value === 'ALL' ? 'ALL' : Number(e.target.value))}
                className={dsSelect}
              >
                <option value="ALL">Tutte le sale</option>
                {rooms.map(r => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Stato arrivo" htmlFor="print-arrival">
              <select
                id="print-arrival"
                value={printArrival}
                onChange={(e) => setPrintArrival(e.target.value as ArrivalStatus | 'ALL')}
                className={dsSelect}
              >
                <option value="ALL">Tutti</option>
                <option value={ArrivalStatus.WAITING}>In attesa</option>
                <option value={ArrivalStatus.ARRIVED}>Arrivati</option>
                <option value={ArrivalStatus.DEPARTED}>Liberati</option>
              </select>
            </Field>
            <Field label="Ordina per">
              <SegmentedControl<'TIME' | 'TABLE'>
                ariaLabel="Ordina per"
                value={printSort}
                onChange={setPrintSort}
                options={[
                  { value: 'TIME' as const, label: 'Orario' },
                  { value: 'TABLE' as const, label: 'Tavolo' },
                ]}
              />
            </Field>
          </div>

          <label className="flex min-h-11 cursor-pointer select-none items-center gap-2.5">
            <input
              type="checkbox"
              checked={includeBanquets}
              onChange={(e) => setIncludeBanquets(e.target.checked)}
              className="h-5 w-5 rounded-[6px] accent-[var(--ds-action-bg)]"
            />
            <span className="text-[15px] text-[var(--ds-text-primary)]">Includi banchetti del giorno</span>
          </label>
        </div>

        <div className="mt-4">
          <p className="mb-2 text-[13px] font-semibold text-[var(--ds-text-secondary)]">Anteprima</p>
          <div className="space-y-1 rounded-[16px] bg-[var(--ds-surface-row)] p-4 text-[14px]">
            <p className="font-semibold capitalize text-[var(--ds-text-primary)]">{formatPrintDate(printDate)}</p>
            <p className="text-[var(--ds-text-secondary)]">{shiftLabel} · {roomLabel}</p>
            <p className="text-[var(--ds-text-muted)]">
              {filteredReservations.length} prenotazioni · {totalGuests} ospiti · {arrivedCount} arrivati
              {includeBanquets && banquetsForDate.length > 0 && ` · ${banquetsForDate.length} banchetti`}
            </p>
          </div>
        </div>
      </ModalShell>

      {/* Print-only area — portaled to <body> so it's a direct body child
          (see PrintInventoryModal for why this matters with App's h-screen). */}
      {createPortal(
        <div className="print-portal">
          <div id="print-area" className="print-only">
        <header style={{ marginBottom: '1.25rem', paddingBottom: '0.75rem', borderBottom: '2px solid var(--ds-print-ink)' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Lista Prenotazioni</h1>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.95rem', color: 'var(--ds-print-ink-secondary)', textTransform: 'capitalize' }}>
            {formatPrintDate(printDate)} · {shiftLabel} · {roomLabel}
          </p>
        </header>

        {filteredReservations.length === 0 && banquetsForDate.length === 0 ? (
          <p style={{ fontStyle: 'italic', color: 'var(--ds-print-ink-muted)' }}>Nessuna prenotazione corrispondente ai filtri.</p>
        ) : (
          <>
            {filteredReservations.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ background: 'var(--ds-print-fill)', borderBottom: '1px solid var(--ds-print-rule-strong)' }}>
                    <th style={{ padding: '0.5rem', textAlign: 'left' }}>Orario</th>
                    <th style={{ padding: '0.5rem', textAlign: 'left' }}>Cliente</th>
                    <th style={{ padding: '0.5rem', textAlign: 'center' }}>Ospiti</th>
                    <th style={{ padding: '0.5rem', textAlign: 'left' }}>Tavolo</th>
                    <th style={{ padding: '0.5rem', textAlign: 'left' }}>Telefono</th>
                    <th style={{ padding: '0.5rem', textAlign: 'left' }}>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredReservations.map(r => {
                    const table = r.table_id ? tableById.get(r.table_id) : null;
                    const time = getRomeTimePart(r.reservation_time);
                    const arrived = isSeated(r);
                    return (
                      <tr key={r.id} style={{ borderBottom: '1px solid var(--ds-print-rule)' }}>
                        <td style={{ padding: '0.5rem', whiteSpace: 'nowrap', fontWeight: 600 }}>{time}</td>
                        <td style={{ padding: '0.5rem' }}>
                          {toTitleCase(r.customer_name)}
                          {arrived && <span style={{ marginLeft: 6, fontSize: '0.7rem', color: 'var(--ds-print-positive)' }}>✓ arrivato</span>}
                        </td>
                        <td style={{ padding: '0.5rem', textAlign: 'center' }}>
                          {r.guests}
                          {r.children && r.children > 0 ? (
                            <span style={{ fontSize: '0.7rem', color: 'var(--ds-print-ink-muted)', marginLeft: 3 }}>({r.children}b)</span>
                          ) : null}
                        </td>
                        <td style={{ padding: '0.5rem' }}>{table ? table.name : '—'}</td>
                        <td style={{ padding: '0.5rem' }}>{r.phone || '—'}</td>
                        <td style={{ padding: '0.5rem', fontSize: '0.78rem' }}>{r.notes || ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--ds-print-ink)', fontWeight: 700 }}>
                    <td colSpan={2} style={{ padding: '0.5rem' }}>
                      Totale: {filteredReservations.length} prenotazioni
                    </td>
                    <td style={{ padding: '0.5rem', textAlign: 'center' }}>
                      {totalGuests}
                      {totalChildren > 0 && (
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--ds-print-ink-muted)', marginLeft: 4 }}>({totalChildren}b)</span>
                      )}
                    </td>
                    <td colSpan={3} style={{ padding: '0.5rem' }}>
                      {arrivedCount > 0 && `(${arrivedCount} arrivati)`}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}

            {includeBanquets && banquetsForDate.length > 0 && (
              <section style={{ marginTop: '1.5rem' }}>
                <h2 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.5rem' }}>Banchetti del giorno</h2>
                <ul style={{ listStyle: 'disc', paddingLeft: '1.25rem', margin: 0 }}>
                  {banquetsForDate.map(b => (
                    <li key={b.id} style={{ marginBottom: '0.25rem' }}>
                      <strong>{b.name}</strong>
                      {b.description && <span style={{ color: 'var(--ds-print-ink-secondary)' }}> — {b.description}</span>}
                      {canViewBanquetPrice && <span style={{ color: 'var(--ds-print-ink-secondary)' }}> · €{b.price_per_person}/persona</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <footer style={{ marginTop: '2rem', paddingTop: '0.5rem', borderTop: '1px solid var(--ds-print-rule)', fontSize: '0.7rem', color: 'var(--ds-print-ink-subtle)', textAlign: 'right' }}>
          Stampato il {new Date().toLocaleString('it-IT')}
        </footer>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
