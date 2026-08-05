import React, { useState } from 'react';
import { Loader2, QrCode, TriangleAlert, Check } from 'lucide-react';
import type { OpenBillRow, StaleOrderRow } from '../../services/billsApiService';
import { toTitleCase } from '../../utils/text';
import { Callout, EmptyState, SectionHeader, StatusPill } from '../ds';
import { formatEuro, formatServiceDay, shiftLabel } from './paymentsView';
import type { Service } from './useOpenBills';

/* ── Conti aperti ─────────────────────────────────────────────────────────
   Every open table bill, with and without a reservation. The bill UI used to
   live only inside the reservation detail, so a walk-in produced a bill nobody
   could reopen: no QR, no way to close it. That is why this list exists.

   The split that drives the layout is not "paid vs unpaid" but "can I still do
   something about it": a bill with a residual is money not yet collected and
   gets a full card; a settled one only needs archiving and collapses to a
   single line.

   The list is one column now — it sits in the pane beside the detail, so the
   card can no longer spread into a grid. The QR and the item breakdown moved
   with it: they were the reason for the old "Mostra QR" button, and the pane
   shows them the moment a card is selected. */

const euro = (cents: number) => formatEuro(cents);

/** One open bill. The amount is the headline because that is what the operator
 *  is scanning for — the table number identifies it, the number is the job. */
const BillCard: React.FC<{
  bill: OpenBillRow;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  closing: boolean;
}> = ({ bill, active, onSelect, onClose, closing }) => {
  const [armed, setArmed] = useState(false);
  const pct = bill.total_cents > 0
    ? Math.min(100, Math.round((bill.paid_cents / bill.total_cents) * 100))
    : 0;

  return (
    // The selectable region and Chiudi are siblings, not nested: a button
    // inside a button is invalid and the inner one stops working in Safari.
    <div
      className={`flex flex-col overflow-hidden rounded-[20px] shadow-[var(--ds-shadow-card)] transition-colors ${
        active ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)]'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex flex-col gap-3 p-4 pb-3 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)]"
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <span className="text-[17px] font-semibold text-[var(--ds-text-primary)]">
              Tav. {bill.table_name ?? '—'}
            </span>
            <span className="ml-2 text-[14px] text-[var(--ds-text-muted)]">
              {bill.customer_name ? toTitleCase(bill.customer_name) : 'senza prenotazione'}
            </span>
          </div>
          <span className="flex-shrink-0 text-[13px] text-[var(--ds-text-muted)] tabular-nums">
            {bill.covers} cop.
          </span>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-[var(--ds-text-primary)] tabular-nums">
            {euro(bill.total_cents)}
          </span>
          <span className="text-[13px] font-medium text-[var(--ds-critical-text)] tabular-nums">
            {bill.paid_cents > 0 && `incassato ${euro(bill.paid_cents)} · `}
            residuo {euro(bill.residual_cents)}
          </span>
        </div>

        {/* Only drawn once something has actually been collected: a bar sitting
            at zero on every card is noise, not information. */}
        {bill.paid_cents > 0 && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--ds-border)]">
            <div
              className="h-full rounded-full bg-[var(--ds-seated-solid)] transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        {(!bill.is_current_service || bill.open_orders > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {!bill.is_current_service && (
              <StatusPill tone="pending">
                {formatServiceDay(bill.service_date)} · {shiftLabel(bill.shift)}
              </StatusPill>
            )}
            {bill.open_orders > 0 && (
              <StatusPill tone="pending" title="Il totale può ancora cambiare">
                comanda aperta
              </StatusPill>
            )}
          </div>
        )}
      </button>

      {/* Two-tap, and it says what the second tap does. Closing a bill with a
          residual writes off money that was never collected, and this button
          sits in a column of near-identical cards. */}
      <div className="px-4 pb-3">
        <button
          type="button"
          onClick={() => { if (armed) { onClose(); setArmed(false); } else setArmed(true); }}
          onBlur={() => setArmed(false)}
          disabled={closing}
          className={`inline-flex h-10 w-full items-center justify-center rounded-full px-4 text-[14px] font-medium transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
            armed
              ? 'bg-[var(--ds-critical-solid)] text-[#ffffff]'
              : 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] hover:bg-[var(--ds-border)]'
          }`}
        >
          {closing ? <Loader2 className="h-4 w-4 animate-spin" /> : armed ? 'Confermi?' : 'Chiudi'}
        </button>
      </div>
    </div>
  );
};

export const ContiAperti: React.FC<{
  bills: OpenBillRow[];
  stale: StaleOrderRow[];
  service: Service | null;
  loading: boolean;
  error: string | null;
  closingId: number | null;
  onCloseBill: (bill: OpenBillRow) => void;
  /** Which bill the detail pane is showing. */
  selectedId: number | null;
  onSelect: (bill: OpenBillRow) => void;
  /** The pane's search box, applied here too. A bill is found by its table
   *  number or by whoever booked it — the two things anyone actually knows
   *  when they walk up asking about a table. */
  query?: string;
}> = ({
  bills, stale, service, loading, error, closingId, onCloseBill, selectedId, onSelect, query = '',
}) => {
  const [onlyResidual, setOnlyResidual] = useState(false);

  const q = query.trim().toLowerCase();
  const matches = (b: OpenBillRow) =>
    !q
    || (b.table_name ?? '').toLowerCase().includes(q)
    || (b.customer_name ?? '').toLowerCase().includes(q);

  const visible = bills.filter(matches);
  const current = visible.filter(b => b.is_current_service);
  const previous = visible.filter(b => !b.is_current_service);
  const daChiudere = [...current, ...previous].filter(b => b.residual_cents > 0);
  const saldati = [...current, ...previous].filter(b => b.residual_cents === 0);
  const residualTotal = daChiudere.reduce((s, b) => s + b.residual_cents, 0);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-[14px] text-[var(--ds-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Carico i conti…
      </div>
    );
  }

  const shown = onlyResidual ? [] : saldati;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-[var(--ds-text-muted)]">
          {service
            ? `Servizio ${shiftLabel(service.shift)} · ${formatServiceDay(service.service_date)}`
            : 'Servizio corrente'}
          {current.length === 0 && ' · nessun conto aperto adesso'}
        </p>
        {saldati.length > 0 && (
          <button
            type="button"
            onClick={() => setOnlyResidual(v => !v)}
            aria-pressed={onlyResidual}
            className={`inline-flex h-9 items-center rounded-full px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              onlyResidual
                ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] hover:text-[var(--ds-text-primary)]'
            }`}
          >
            Solo con residuo
          </button>
        )}
      </div>

      {/* Orders left open by an earlier service. They show in neither the room
          nor the kitchen any more, so without this a never-closed table would
          simply vanish. */}
      {stale.length > 0 && (
        <Callout
          tone="pending"
          icon={TriangleAlert}
          title={stale.length === 1
            ? 'Una comanda di servizi precedenti mai chiusa'
            : `${stale.length} comande di servizi precedenti mai chiuse`}
        >
          Aprila da Comande scegliendo il tavolo nel servizio a cui appartiene,
          oppure chiudi il conto se il pagamento è già avvenuto.
        </Callout>
      )}

      {error && (
        <Callout tone="critical" icon={TriangleAlert} title="Operazione non riuscita">
          {error}
        </Callout>
      )}

      {daChiudere.length === 0 && saldati.length === 0 ? (
        <EmptyState icon={QrCode}>
          {q
            ? 'Nessun conto per questa ricerca.'
            : 'Nessun conto aperto in questo servizio. Si apre chiudendo una comanda da Comande.'}
        </EmptyState>
      ) : (
        <>
          {daChiudere.length > 0 && (
            <section>
              <SectionHeader
                tone="attention"
                meta={`${daChiudere.length} cont${daChiudere.length === 1 ? 'o' : 'i'} · ${euro(residualTotal)} di residuo`}
              >
                Da chiudere
              </SectionHeader>
              <div className="space-y-3">
                {daChiudere.map(b => (
                  <BillCard
                    key={b.id}
                    bill={b}
                    active={selectedId === b.id}
                    closing={closingId === b.id}
                    onSelect={() => onSelect(b)}
                    onClose={() => onCloseBill(b)}
                  />
                ))}
              </div>
            </section>
          )}

          {shown.length > 0 && (
            <section>
              <SectionHeader tone="positive" meta={`${shown.length} cont${shown.length === 1 ? 'o' : 'i'}`}>
                Saldati, da archiviare
              </SectionHeader>
              {/* Settled bills are a one-line job: confirm and file. A full card
                  each would give the same weight to money already in the till
                  as to money still owed. */}
              <div className="space-y-2">
                {shown.map(b => (
                  <div
                    key={b.id}
                    className={`flex items-center overflow-hidden rounded-[16px] shadow-[var(--ds-shadow-card)] transition-colors ${
                      selectedId === b.id ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(b)}
                      className="min-w-0 flex-1 px-4 py-3 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)]"
                    >
                      <div className="truncate text-[14px] font-semibold text-[var(--ds-text-primary)]">
                        Tav. {b.table_name ?? '—'}
                        {b.customer_name && (
                          <span className="font-normal text-[var(--ds-text-muted)]"> · {toTitleCase(b.customer_name)}</span>
                        )}
                      </div>
                      <div className="truncate text-[13px] text-[var(--ds-seated-text)] tabular-nums">
                        saldato · {euro(b.total_cents)} · {formatServiceDay(b.service_date)} {shiftLabel(b.shift)}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => onCloseBill(b)}
                      disabled={closingId === b.id}
                      className="mr-3 inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full bg-[var(--ds-seated-tint)] px-3.5 text-[13px] font-medium text-[var(--ds-seated-text)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                    >
                      {closingId === b.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Check className="h-3.5 w-3.5" aria-hidden />}
                      Chiudi
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
};
