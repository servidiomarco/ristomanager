import React, { useState } from 'react';
import { Loader2, QrCode, TriangleAlert, Check, X } from 'lucide-react';
import { printBill, type OpenBillRow, type StaleOrderRow } from '../../services/billsApiService';
import { toTitleCase } from '../../utils/text';
import { Callout, EmptyState, SectionHeader, StatusPill } from '../ds';
import { formatEuro, formatServiceDay, shiftLabel } from './paymentsView';
import type { Service } from './useOpenBills';
import { SettleDialog, type SettleOpts } from './BillSheet';

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
  onClose: (opts?: SettleOpts) => void;
  closing: boolean;
  /** Selezione multipla per la stampa QR in blocco: sostituisce l'apertura del
   *  conto col semplice spunta/deseleziona, ed esclude i conti senza un QR
   *  attivo invece di lasciarli spuntabili per poi fallire in stampa. */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}> = ({ bill, active, onSelect, onClose, closing, selectionMode, selected, onToggleSelect }) => {
  const [settleOpen, setSettleOpen] = useState(false);
  const pct = bill.total_cents > 0
    ? Math.min(100, Math.round((bill.paid_cents / bill.total_cents) * 100))
    : 0;
  const qrAvailable = !!bill.share_token;

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
        onClick={selectionMode ? onToggleSelect : onSelect}
        disabled={selectionMode && !qrAvailable}
        aria-pressed={selectionMode ? selected : undefined}
        className={`flex items-start gap-3 p-4 pb-3 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)] ${
          selectionMode && !qrAvailable ? 'opacity-40' : ''
        }`}
      >
        {selectionMode && (
          <span
            aria-hidden
            className={`mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[8px] transition-colors ${
              selected
                ? 'bg-[var(--ds-seated-solid)] text-[#ffffff]'
                : 'bg-[var(--ds-surface)] ring-1 ring-inset ring-[var(--ds-border-strong)]'
            }`}
          >
            {selected && <Check className="h-3.5 w-3.5" />}
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-3">
          <span className="flex items-baseline justify-between gap-2">
            <span className="min-w-0">
              <span className="text-[17px] font-semibold text-[var(--ds-text-primary)]">
                Tav. {bill.table_name ?? '—'}
              </span>
              <span className="ml-2 text-[14px] text-[var(--ds-text-muted)]">
                {bill.customer_name ? toTitleCase(bill.customer_name) : 'senza prenotazione'}
              </span>
            </span>
            <span className="flex-shrink-0 text-[13px] text-[var(--ds-text-muted)] tabular-nums">
              {bill.covers} cop.
            </span>
          </span>

          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-[var(--ds-text-primary)] tabular-nums">
              {euro(bill.total_cents)}
            </span>
            <span className="text-[13px] font-medium text-[var(--ds-critical-text)] tabular-nums">
              {bill.paid_cents > 0 && `incassato ${euro(bill.paid_cents)} · `}
              residuo {euro(bill.residual_cents)}
            </span>
          </span>

          {/* Only drawn once something has actually been collected: a bar sitting
              at zero on every card is noise, not information. */}
          {bill.paid_cents > 0 && (
            <span className="block h-1.5 w-full overflow-hidden rounded-full bg-[var(--ds-border)]">
              <span
                className="block h-full rounded-full bg-[var(--ds-seated-solid)] transition-all"
                style={{ width: `${pct}%` }}
              />
            </span>
          )}

          {selectionMode && !qrAvailable ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusPill tone="pending">QR non attivo</StatusPill>
            </span>
          ) : (!bill.is_current_service || bill.open_orders > 0) && (
            <span className="flex flex-wrap items-center gap-2">
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
            </span>
          )}
        </span>
      </button>

      {/* Chiudi apre il dialog di incasso (contanti + mancia) invece di scrivere
          il residuo come ammanco senza chiedere: era l'unico modo di pagare la
          carta. Nascosto in selezione multipla: lì il tap sceglie il tavolo,
          non chiude il conto. */}
      {!selectionMode && (
        <div className="px-4 pb-3">
          <button
            type="button"
            onClick={() => setSettleOpen(true)}
            disabled={closing}
            className="inline-flex h-10 w-full items-center justify-center rounded-full bg-[var(--ds-seated-tint)] px-4 text-[14px] font-medium text-[var(--ds-seated-text)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            {closing ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Chiudi'}
          </button>
        </div>
      )}
      {!selectionMode && settleOpen && (
        <SettleDialog
          bill={bill}
          busy={closing}
          onCancel={() => setSettleOpen(false)}
          onConfirm={(opts) => { onClose(opts); setSettleOpen(false); }}
        />
      )}
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
  onCloseBill: (bill: OpenBillRow, opts?: SettleOpts) => void;
  /** Which bill the detail pane is showing. */
  selectedId: number | null;
  onSelect: (bill: OpenBillRow) => void;
  /** The pane's search box, applied here too. A bill is found by its table
   *  number or by whoever booked it — the two things anyone actually knows
   *  when they walk up asking about a table. */
  query?: string;
  /** Vista dei conti già chiusi (rivedere gli incassi del servizio): sola
   *  lettura, con la ripartizione carta/contanti/mancia. */
  closedView?: boolean;
}> = ({
  bills, stale, service, loading, error, closingId, onCloseBill, selectedId, onSelect, query = '', closedView = false,
}) => {
  const [onlyResidual, setOnlyResidual] = useState(false);

  // Stampa QR in blocco: "uno o più tavoli" in un solo giro, invece di aprire
  // ogni conto per stampare il suo QR singolarmente.
  const [qrSelectionMode, setQrSelectionMode] = useState(false);
  const [qrSelectedIds, setQrSelectedIds] = useState<Set<number>>(new Set());
  const [qrPrinting, setQrPrinting] = useState(false);
  const [qrResult, setQrResult] = useState<{ ok: number; failed: number } | null>(null);

  const toggleQrSelected = (id: number) => setQrSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const exitQrSelection = () => {
    setQrSelectionMode(false);
    setQrSelectedIds(new Set());
  };

  const printQrSelection = async () => {
    if (qrSelectedIds.size === 0 || qrPrinting) return;
    setQrPrinting(true);
    const ids = [...qrSelectedIds];
    const results = await Promise.allSettled(ids.map(id => printBill(id, 'QR')));
    const ok = results.filter(r => r.status === 'fulfilled').length;
    setQrPrinting(false);
    setQrResult({ ok, failed: results.length - ok });
    setTimeout(() => setQrResult(null), 4000);
    exitQrSelection();
  };

  const q = query.trim().toLowerCase();
  const matches = (b: OpenBillRow) =>
    !q
    || (b.table_name ?? '').toLowerCase().includes(q)
    || (b.customer_name ?? '').toLowerCase().includes(q);

  const visible = bills.filter(matches);

  // --- Vista "Chiusi": elenco in sola lettura degli incassi del servizio. ---
  if (closedView) {
    const label = (st: string) => st === 'VOIDED' ? 'Annullato' : st === 'SETTLED_PARTIAL' ? 'Parziale' : 'Chiuso';
    const tone = (st: string) => st === 'VOIDED' ? 'critical' : st === 'SETTLED_PARTIAL' ? 'pending' : 'positive';
    const real = visible.filter(b => b.status !== 'VOIDED');
    const incassato = real.reduce((s, b) => s + b.paid_cents + (b.cash_settled_cents ?? 0), 0);
    const mance = real.reduce((s, b) => s + (b.tip_cents ?? 0), 0);
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            {service ? `Servizio ${shiftLabel(service.shift)} · ${formatServiceDay(service.service_date)}` : 'Servizio'}
            {` · ${visible.length} cont${visible.length === 1 ? 'o' : 'i'} chius${visible.length === 1 ? 'o' : 'i'}`}
          </p>
          {(incassato > 0 || mance > 0) && (
            <p className="text-[13px] text-[var(--ds-text-secondary)] tabular-nums">
              Incassato {euro(incassato)}{mance > 0 && ` · mance ${euro(mance)}`}
            </p>
          )}
        </div>
        {loading ? (
          <div className="flex items-center gap-2 p-8 text-[14px] text-[var(--ds-text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Carico i conti…
          </div>
        ) : visible.length === 0 ? (
          <EmptyState icon={QrCode}>
            {q ? 'Nessun conto per questa ricerca.' : 'Nessun conto chiuso in questo giorno/turno.'}
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {visible.map(b => {
              const carta = b.paid_cents;
              const contanti = b.cash_settled_cents ?? 0;
              const mancia = b.tip_cents ?? 0;
              const ammanco = b.status === 'SETTLED_PARTIAL' ? Math.max(0, b.total_cents - carta - contanti) : 0;
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onSelect(b)}
                  className={`flex w-full flex-col gap-1.5 rounded-[16px] p-4 text-left shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                    selectedId === b.id ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)]'
                  } ${b.status === 'VOIDED' ? 'opacity-70' : ''}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
                      Tav. {b.table_name ?? '—'}
                      {b.customer_name && <span className="ml-2 font-normal text-[var(--ds-text-muted)]">{toTitleCase(b.customer_name)}</span>}
                    </span>
                    <span className={`flex-shrink-0 text-[16px] font-semibold tabular-nums ${b.status === 'VOIDED' ? 'text-[var(--ds-text-muted)] line-through' : 'text-[var(--ds-text-primary)]'}`}>
                      {euro(b.total_cents)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--ds-text-muted)] tabular-nums">
                    <StatusPill tone={tone(b.status) as any}>{label(b.status)}</StatusPill>
                    {b.status !== 'VOIDED' && (
                      <>
                        {carta > 0 && <span>carta {euro(carta)}</span>}
                        {contanti > 0 && <span>contanti {euro(contanti)}</span>}
                        {mancia > 0 && <span className="text-[var(--ds-seated-text)]">mancia {euro(mancia)}</span>}
                        {ammanco > 0 && <span className="text-[var(--ds-critical-text)]">ammanco {euro(ammanco)}</span>}
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

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
                action={daChiudere.some(b => b.share_token) ? (
                  // Un interruttore, non una porta a senso unico: resta lì e si
                  // accende invece di sparire, così l'intestazione non trema al tap.
                  <button
                    type="button"
                    onClick={() => (qrSelectionMode ? exitQrSelection() : setQrSelectionMode(true))}
                    aria-pressed={qrSelectionMode}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                      qrSelectionMode
                        ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                        : 'text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface)] hover:text-[var(--ds-text-primary)]'
                    }`}
                  >
                    <QrCode className="h-3.5 w-3.5" aria-hidden /> Stampa QR
                  </button>
                ) : undefined}
              >
                Da chiudere
              </SectionHeader>

              {qrSelectionMode && (
                <div className="sticky top-0 z-10 mb-2 flex items-center gap-2 rounded-full bg-[var(--ds-action-bg)] py-2 pl-4 pr-2 shadow-[var(--ds-shadow-raised)]">
                  <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--ds-action-fg)]">
                    {qrSelectedIds.size === 0
                      ? 'Tocca i tavoli da stampare'
                      : `${qrSelectedIds.size} tavol${qrSelectedIds.size === 1 ? 'o' : 'i'} selezionat${qrSelectedIds.size === 1 ? 'o' : 'i'}`}
                  </span>
                  <button
                    type="button"
                    onClick={printQrSelection}
                    disabled={qrSelectedIds.size === 0 || qrPrinting}
                    className="inline-flex h-10 flex-shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-3.5 text-[13px] font-medium text-[var(--ds-action-fg)] transition-colors hover:bg-white/25 disabled:opacity-40"
                  >
                    {qrPrinting ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                    Stampa
                  </button>
                  <button
                    type="button"
                    onClick={exitQrSelection}
                    aria-label="Esci dalla selezione"
                    className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-action-fg)] transition-colors hover:bg-white/10"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}

              {qrResult && (
                <Callout tone={qrResult.failed === 0 ? 'positive' : 'critical'} icon={qrResult.failed === 0 ? Check : TriangleAlert} className="mb-2">
                  {qrResult.failed === 0
                    ? `QR in stampa per ${qrResult.ok} tavol${qrResult.ok === 1 ? 'o' : 'i'}.`
                    : `${qrResult.ok} in stampa, ${qrResult.failed} non riuscit${qrResult.failed === 1 ? 'o' : 'i'}.`}
                </Callout>
              )}

              <div className="space-y-3">
                {daChiudere.map(b => (
                  <BillCard
                    key={b.id}
                    bill={b}
                    active={selectedId === b.id}
                    closing={closingId === b.id}
                    onSelect={() => onSelect(b)}
                    onClose={(opts) => onCloseBill(b, opts)}
                    selectionMode={qrSelectionMode}
                    selected={qrSelectedIds.has(b.id)}
                    onToggleSelect={() => toggleQrSelected(b.id)}
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
