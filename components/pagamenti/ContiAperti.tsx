import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, QrCode, TriangleAlert, Check } from 'lucide-react';
import { socketClient } from '../../services/socketClient';
import {
  billsApiService, getOpenBills, type OpenBillRow, type StaleOrderRow,
} from '../../services/billsApiService';
import { toTitleCase } from '../../utils/text';
import { Callout, EmptyState, SectionHeader, StatusPill } from '../ds';
import { BillSheet } from './BillSheet';
import { formatEuro, formatServiceDay, shiftLabel } from './paymentsView';

/* ── Conti aperti ─────────────────────────────────────────────────────────
   Every open table bill, with and without a reservation. The bill UI used to
   live only inside the reservation detail, so a walk-in produced a bill nobody
   could reopen: no QR, no way to close it. That is why this list exists.

   The split that drives the layout is not "paid vs unpaid" but "can I still do
   something about it": a bill with a residual is money not yet collected and
   gets a full card with its actions; a settled one only needs archiving and
   collapses to a single line. */

const euro = (cents: number) => formatEuro(cents);

/** One open bill. The amount is the headline because that is what the operator
 *  is scanning for — the table number identifies it, the number is the job. */
const BillCard: React.FC<{
  bill: OpenBillRow;
  onOpen: () => void;
  onClose: () => void;
  closing: boolean;
}> = ({ bill, onOpen, onClose, closing }) => {
  const [armed, setArmed] = useState(false);
  const pct = bill.total_cents > 0
    ? Math.min(100, Math.round((bill.paid_cents / bill.total_cents) * 100))
    : 0;

  return (
    <div className="flex flex-col gap-3 rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
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

      <div className="mt-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-[var(--ds-action-bg)] px-4 text-[14px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          <QrCode className="h-4 w-4" aria-hidden /> Mostra QR
        </button>
        {/* Two-tap, and it says what the second tap does. Closing a bill with a
            residual writes off money that was never collected, and this button
            sits in a grid of near-identical cards. */}
        <button
          type="button"
          onClick={() => { if (armed) { onClose(); setArmed(false); } else setArmed(true); }}
          onBlur={() => setArmed(false)}
          disabled={closing}
          className={`inline-flex h-11 flex-shrink-0 items-center justify-center rounded-full px-4 text-[14px] font-medium transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
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

export type BillsSummary = {
  openCount: number;
  residualCents: number;
};

export const ContiAperti: React.FC<{
  /** The page's search box, applied here too. A bill is found by its table
   *  number or by whoever booked it — the two things anyone actually knows
   *  when they walk up asking about a table. */
  query?: string;
  /** Lifted so the page header can show the residual alongside the link
   *  totals. The service stays local — it is named on this tab, in place. */
  onSummaryChange?: (summary: BillsSummary) => void;
}> = ({ query = '', onSummaryChange }) => {
  const [bills, setBills] = useState<OpenBillRow[]>([]);
  const [stale, setStale] = useState<StaleOrderRow[]>([]);
  const [service, setService] = useState<{ service_date: string; shift: 'LUNCH' | 'DINNER' } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<OpenBillRow | null>(null);
  const [closingId, setClosingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyResidual, setOnlyResidual] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await getOpenBills();
      setBills(res.bills);
      setStale(res.stale_orders ?? []);
      setService(res.service ?? null);
      // The bill moves while you are looking at it: refresh the selected one
      // too, or the residual in the sheet stays frozen at what it was.
      setSelected(prev => (prev ? res.bills.find(b => b.id === prev.id) ?? null : null));
    } catch (err: any) {
      setError(err?.message ?? 'Conti non caricati');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const socket = socketClient.getSocket();
    const onChange = () => reload();
    socket?.on('bill:opened', onChange);
    socket?.on('bill:updated', onChange);
    socket?.on('bill:closed', onChange);
    socket?.on('connect', onChange);
    const poll = setInterval(reload, 30_000);
    return () => {
      socket?.off('bill:opened', onChange);
      socket?.off('bill:updated', onChange);
      socket?.off('bill:closed', onChange);
      socket?.off('connect', onChange);
      clearInterval(poll);
    };
  }, [reload]);

  const closeBill = async (bill: OpenBillRow) => {
    setClosingId(bill.id);
    setError(null);
    try {
      await billsApiService.closeBill(bill.id);
      setSelected(null);
      await reload();
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Chiusura non riuscita');
    } finally {
      setClosingId(null);
    }
  };

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

  // Reported from every bill, not the filtered subset: the header figure is
  // "what this service still owes", and it must not fall as you type a search.
  const serviceResidual = bills.reduce((sum, b) => sum + Math.max(0, b.residual_cents), 0);
  useEffect(() => {
    onSummaryChange?.({ openCount: bills.length, residualCents: serviceResidual });
  }, [bills.length, serviceResidual, onSummaryChange]);

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-[var(--ds-text-muted)]">
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
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {daChiudere.map(b => (
                  <BillCard
                    key={b.id}
                    bill={b}
                    closing={closingId === b.id}
                    onOpen={() => setSelected(b)}
                    onClose={() => closeBill(b)}
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
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {shown.map(b => (
                  <div
                    key={b.id}
                    className="flex items-center gap-3 rounded-[16px] bg-[var(--ds-surface)] px-4 py-3 shadow-[var(--ds-shadow-card)]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-semibold text-[var(--ds-text-primary)]">
                        Tav. {b.table_name ?? '—'}
                        {b.customer_name && (
                          <span className="font-normal text-[var(--ds-text-muted)]"> · {toTitleCase(b.customer_name)}</span>
                        )}
                      </div>
                      <div className="truncate text-[13px] text-[var(--ds-seated-text)] tabular-nums">
                        saldato · {euro(b.total_cents)} · {formatServiceDay(b.service_date)} {shiftLabel(b.shift)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => closeBill(b)}
                      disabled={closingId === b.id}
                      className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full bg-[var(--ds-seated-tint)] px-3.5 text-[13px] font-medium text-[var(--ds-seated-text)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
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

      {selected && (
        <BillSheet
          bill={selected}
          busy={closingId === selected.id}
          onClose={() => setSelected(null)}
          onSettle={() => closeBill(selected)}
        />
      )}
    </div>
  );
};
