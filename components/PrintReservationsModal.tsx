import React, { useMemo, useState, useEffect } from 'react';
import { Reservation, Shift, Room, Table, ArrivalStatus, BanquetMenu } from '../types';
import { Printer, X } from 'lucide-react';

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
  const [printDate, setPrintDate] = useState(initialDate);
  const [printShift, setPrintShift] = useState<Shift | 'ALL'>(initialShift);
  const [printRoomId, setPrintRoomId] = useState<number | 'ALL'>('ALL');
  const [printArrival, setPrintArrival] = useState<ArrivalStatus | 'ALL'>('ALL');
  const [includeBanquets, setIncludeBanquets] = useState(true);

  useEffect(() => {
    if (isOpen) {
      setPrintDate(initialDate);
      setPrintShift(initialShift);
      setPrintRoomId('ALL');
      setPrintArrival('ALL');
      setIncludeBanquets(true);
    }
  }, [isOpen, initialDate, initialShift]);

  const tableById = useMemo(() => {
    const map = new Map<number, Table>();
    tables.forEach(t => map.set(t.id, t));
    return map;
  }, [tables]);

  const filteredReservations = useMemo(() => {
    return reservations
      .filter(r => r.reservation_time.split('T')[0] === printDate)
      .filter(r => printShift === 'ALL' || r.shift === printShift)
      .filter(r => {
        if (printRoomId === 'ALL') return true;
        if (!r.table_id) return false;
        const table = tableById.get(r.table_id);
        return table?.room_id === printRoomId;
      })
      .filter(r => printArrival === 'ALL' || (r.arrival_status || ArrivalStatus.WAITING) === printArrival)
      .sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));
  }, [reservations, printDate, printShift, printRoomId, printArrival, tableById]);

  const banquetsForDate = useMemo(() => {
    if (!includeBanquets) return [];
    return banquetMenus.filter(b => b.event_date === printDate);
  }, [banquetMenus, printDate, includeBanquets]);

  const totalGuests = filteredReservations.reduce((acc, r) => acc + r.guests, 0);
  const arrivedCount = filteredReservations.filter(r => r.arrival_status === ArrivalStatus.ARRIVED).length;

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
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] p-4 no-print">
        <div className="bg-[var(--color-surface)] rounded-xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] max-w-4xl w-full max-h-[90vh] flex flex-col">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--color-line)]">
            <h2 className="text-[15px] font-semibold text-[var(--color-fg)] flex items-center gap-2">
              <Printer className="h-4 w-4 text-[var(--color-fg-muted)]" />
              Stampa Prenotazioni
            </h2>
            <button onClick={onClose} className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]" aria-label="Chiudi">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="px-5 py-4 overflow-y-auto flex-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Data</label>
                <input
                  type="date"
                  value={printDate}
                  onChange={(e) => setPrintDate(e.target.value)}
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                />
              </div>
              <div>
                <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Turno</label>
                <div className="inline-flex p-0.5 bg-[var(--color-surface-3)] rounded-full w-full">
                  {(['ALL', Shift.LUNCH, Shift.DINNER] as const).map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setPrintShift(s)}
                      className={`flex-1 px-3 py-1.5 rounded-full text-sm font-medium transition ${
                        printShift === s ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]' : 'text-[var(--color-fg-muted)]'
                      }`}
                    >
                      {s === 'ALL' ? 'Tutti' : s === Shift.LUNCH ? 'Pranzo' : 'Cena'}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Sala</label>
                <select
                  value={printRoomId === 'ALL' ? 'ALL' : String(printRoomId)}
                  onChange={(e) => setPrintRoomId(e.target.value === 'ALL' ? 'ALL' : Number(e.target.value))}
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                >
                  <option value="ALL">Tutte le sale</option>
                  {rooms.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Stato arrivo</label>
                <select
                  value={printArrival}
                  onChange={(e) => setPrintArrival(e.target.value as ArrivalStatus | 'ALL')}
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                >
                  <option value="ALL">Tutti</option>
                  <option value={ArrivalStatus.WAITING}>In attesa</option>
                  <option value={ArrivalStatus.ARRIVED}>Arrivati</option>
                  <option value={ArrivalStatus.DEPARTED}>Liberati</option>
                </select>
              </div>
            </div>

            <label className="flex items-center gap-2 mb-4 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeBanquets}
                onChange={(e) => setIncludeBanquets(e.target.checked)}
                className="h-4 w-4 rounded border-[var(--color-line)]"
              />
              <span className="text-sm text-[var(--color-fg)]">Includi banchetti del giorno</span>
            </label>

            <div className="border-t border-[var(--color-line)] pt-4">
              <p className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-2">Anteprima</p>
              <div className="bg-[var(--color-surface-3)] border border-[var(--color-line)] rounded-md p-3 text-sm space-y-1">
                <p className="font-semibold text-[var(--color-fg)] capitalize">{formatPrintDate(printDate)}</p>
                <p className="text-[var(--color-fg-muted)]">{shiftLabel} · {roomLabel}</p>
                <p className="text-[var(--color-fg-subtle)]">
                  {filteredReservations.length} prenotazioni · {totalGuests} ospiti · {arrivedCount} arrivati
                  {includeBanquets && banquetsForDate.length > 0 && ` · ${banquetsForDate.length} banchetti`}
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--color-line)]">
            <button
              onClick={onClose}
              className="rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition"
            >
              Annulla
            </button>
            <button
              onClick={handlePrint}
              disabled={filteredReservations.length === 0 && banquetsForDate.length === 0}
              className="rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Printer className="h-4 w-4" />
              Stampa
            </button>
          </div>
        </div>
      </div>

      {/* Print-only area — hidden on screen, shown when printing */}
      <div id="print-area" className="print-only">
        <header style={{ marginBottom: '1.25rem', paddingBottom: '0.75rem', borderBottom: '2px solid #0f172a' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Lista Prenotazioni</h1>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.95rem', color: '#475569', textTransform: 'capitalize' }}>
            {formatPrintDate(printDate)} · {shiftLabel} · {roomLabel}
          </p>
        </header>

        {filteredReservations.length === 0 && banquetsForDate.length === 0 ? (
          <p style={{ fontStyle: 'italic', color: '#64748b' }}>Nessuna prenotazione corrispondente ai filtri.</p>
        ) : (
          <>
            {filteredReservations.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ background: '#f1f5f9', borderBottom: '1px solid #cbd5e1' }}>
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
                    const time = r.reservation_time.split('T')[1]?.slice(0, 5) || '';
                    const arrived = r.arrival_status === ArrivalStatus.ARRIVED;
                    return (
                      <tr key={r.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '0.5rem', whiteSpace: 'nowrap', fontWeight: 600 }}>{time}</td>
                        <td style={{ padding: '0.5rem' }}>
                          {r.customer_name}
                          {arrived && <span style={{ marginLeft: 6, fontSize: '0.7rem', color: '#059669' }}>✓ arrivato</span>}
                        </td>
                        <td style={{ padding: '0.5rem', textAlign: 'center' }}>{r.guests}</td>
                        <td style={{ padding: '0.5rem' }}>{table ? table.name : '—'}</td>
                        <td style={{ padding: '0.5rem' }}>{r.phone || '—'}</td>
                        <td style={{ padding: '0.5rem', fontSize: '0.78rem' }}>{r.notes || ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid #0f172a', fontWeight: 700 }}>
                    <td colSpan={2} style={{ padding: '0.5rem' }}>
                      Totale: {filteredReservations.length} prenotazioni
                    </td>
                    <td style={{ padding: '0.5rem', textAlign: 'center' }}>{totalGuests}</td>
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
                      {b.description && <span style={{ color: '#475569' }}> — {b.description}</span>}
                      <span style={{ color: '#475569' }}> · €{b.price_per_person}/persona</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <footer style={{ marginTop: '2rem', paddingTop: '0.5rem', borderTop: '1px solid #e2e8f0', fontSize: '0.7rem', color: '#94a3b8', textAlign: 'right' }}>
          Stampato il {new Date().toLocaleString('it-IT')}
        </footer>
      </div>
    </>
  );
};
