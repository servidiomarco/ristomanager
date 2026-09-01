import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CreditCard, Receipt } from 'lucide-react';
import { socketClient } from '../services/socketClient';
import { SkeletonPaymentList } from './SkeletonCards';
import {
  paymentsApiService, type PaymentRequest, type PaymentsListParams,
} from '../services/paymentsApiService';
import { getFeatureFlags } from '../services/apiService';
import { getRomeDatePart } from '../utils/reservationTime';
import {
  Callout, PanePlaceholder, SearchField, SegmentedControl, SplitPane,
} from './ds';
import { ChiusuraCassa } from './pagamenti/ChiusuraCassa';
import { LinkDiPagamento, type StatusFilter } from './pagamenti/LinkDiPagamento';
import { BillDetail } from './pagamenti/BillSheet';
import { PaymentDetail } from './pagamenti/PaymentDetail';
import { PeriodPicker, type Period } from './pagamenti/PeriodPicker';
import { formatEuro } from './pagamenti/paymentsView';
import { useOpenBills } from './pagamenti/useOpenBills';

/* ── Pagamenti ────────────────────────────────────────────────────────────
   Il libro, non il banco: la Cassa è dove si incassa durante il servizio,
   questa pagina è dove si rilegge — la chiusura di una data qualunque e i
   link di pagamento su un periodo. Il tab «Conti aperti» che viveva qui è
   stato ritirato quando la pagina Cassa ne ha rifatto il mestiere per
   intero (verbi rapidi, dividi, correggi, fattura): due posti per chiudere
   un conto erano due flussi da tenere allineati per sempre. La lettura
   «chiusi» non è sparita — sta nel report di chiusura, tavolo per tavolo —
   e i conti ancora da incassare compaiono lì come rimando alla Cassa.

   List and detail sit side by side, the same shape Prenotazioni and the three
   Comunicazioni channels use. Below md the pane is a full-screen sheet —
   SplitPane does that itself.

   Date scopes stay independent: Chiusura follows the topbar date, Link
   follows the period filter. */

const KPI_LABELS = {
  incassato: 'Incassato',
  attesa: 'In attesa',
  residuo: 'Residuo conti',
} as const;

const Kpi: React.FC<{ label: string; value: string; tone?: 'positive' | 'pending' | 'critical' }> = ({
  label, value, tone,
}) => (
  // flex-1 + min-w-0: on a phone the three share the row evenly and the labels
  // truncate rather than pushing the third figure onto a line of its own.
  <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 py-2 lg:flex-none lg:px-4 lg:py-2.5 lg:first:pl-0 lg:last:pr-0">
    <span className={`text-[17px] leading-none font-semibold tracking-[-0.02em] tabular-nums sm:text-[20px] ${
      tone === 'positive' ? 'text-[var(--ds-seated-text)]'
      : tone === 'pending' ? 'text-[var(--ds-pending-text)]'
      : tone === 'critical' ? 'text-[var(--ds-critical-text)]'
      : 'text-[var(--ds-text-primary)]'
    }`}>
      {value}
    </span>
    {/* Sentence case, not the caps the mockup showed: at 12px capitals lose the
        word shape that makes a label scannable, and screen readers spell short
        ones out letter by letter. */}
    <span className="truncate text-[11px] text-[var(--ds-text-muted)] sm:text-[12px]">{label}</span>
  </div>
);

const PagamentiPage: React.FC<{
  globalDate?: Date;
  globalShiftFilter?: 'ALL' | 'LUNCH' | 'DINNER';
  /** Presente solo se chi guarda può entrare in Cassa: il rimando ai conti
   *  da incassare diventa un bottone, altrimenti resta una riga di stato. */
  onOpenCassa?: () => void;
}> = ({ globalDate, globalShiftFilter, onOpenCassa }) => {
  const [tab, setTab] = useState<'CASSA' | 'LINKS'>('CASSA');

  // La lista "Conti aperti" segue datepicker + toggle turno della topbar: mostra
  // solo i conti di quel giorno/turno (turno "Tutti" = entrambi). Senza data la
  // pagina non filtra (comportamento storico).
  const serviceFilter = useMemo(
    () => globalDate
      ? {
          service_date: getRomeDatePart(globalDate),
          shift: globalShiftFilter && globalShiftFilter !== 'ALL' ? globalShiftFilter : undefined,
        }
      : undefined,
    [globalDate, globalShiftFilter],
  );

  const [items, setItems] = useState<PaymentRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  // Several raw gateway statuses group under one chip to keep the filter
  // vocabulary simple: Pagati covers COMPLETED and PAID, Falliti covers
  // FAILED and CANCELLED — both terminal, both money-not-received.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [period, setPeriod] = useState<Period>({ from: '', to: '' });
  const [periodOpen, setPeriodOpen] = useState(false);

  // An id, not a row — the row objects are replaced on every refetch, and
  // holding one would pin the pane to a stale copy.
  const [selectedPaymentId, setSelectedPaymentId] = useState<number | null>(null);

  // I conti aperti non hanno più una lista qui, ma restano due numeri della
  // pagina: il KPI «Residuo conti» e il rimando alla Cassa dentro il report.
  const openBills = useOpenBills(serviceFilter, 'open');

  // I chiusi invece una scheda ce l'hanno ancora: dalla riga del report si
  // apre il conto nel pannello, ed è lì che vive lo scontrino elettronico
  // (emetti su un conto senza documento, riprova un fallito, annulla). La
  // riga del report da sola non basta — non porta righe né token QR.
  const closedBills = useOpenBills(serviceFilter, 'closed');
  const [selectedClosureBillId, setSelectedClosureBillId] = useState<number | null>(null);

  // The closure tab only exists with pay-at-table on. null = flag not known
  // yet, so the tab bar doesn't flash a section that is about to disappear.
  const [payAtTableEnabled, setPayAtTableEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    getFeatureFlags()
      .then(f => { if (!cancelled) setPayAtTableEnabled(f.pay_at_table_enabled === true); })
      .catch(() => { if (!cancelled) setPayAtTableEnabled(false); });
    const socket = socketClient.getSocket();
    const onFlags = (flags: any) => {
      if (flags && typeof flags.pay_at_table_enabled === 'boolean') {
        setPayAtTableEnabled(flags.pay_at_table_enabled);
      }
    };
    socket?.on('features:updated', onFlags);
    return () => { cancelled = true; socket?.off('features:updated', onFlags); };
  }, []);

  // With the module off there is nothing to put in the first tab, so the page
  // is the links list and the tab bar has no job.
  const billsAvailable = payAtTableEnabled === true;
  useEffect(() => {
    if (payAtTableEnabled === false) setTab('LINKS');
  }, [payAtTableEnabled]);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: PaymentsListParams = { limit: 200 };
      if (searchDebounced.trim()) params.q = searchDebounced.trim();
      if (statusFilter === 'pending') params.status = 'PENDING,AUTHORISED';
      else if (statusFilter === 'paid') params.status = 'COMPLETED,PAID';
      else if (statusFilter === 'failed') params.status = 'FAILED,CANCELLED';
      else if (statusFilter === 'expired') params.status = 'EXPIRED';
      if (period.from) params.from = period.from;
      if (period.to) params.to = period.to;
      const result = await paymentsApiService.list(params);
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [searchDebounced, statusFilter, period.from, period.to]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  // The operator is looking at the list: clear the sidebar badge. Re-marked
  // after every live refresh so payments landing while the page is open don't
  // pile up as "unseen".
  useEffect(() => {
    if (!loading) paymentsApiService.markSeen().catch(() => {});
  }, [loading, items]);

  // Live refresh: any payment created or updated (webhook, reconcile, another
  // device) refetches. Debounced so a burst of split payments is one request.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onEvent = () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => { fetchItems(); }, 400);
    };
    let attached: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attached === s) return;
      if (attached) {
        attached.off('paymentRequest:created', onEvent);
        attached.off('paymentRequest:updated', onEvent);
      }
      attached = s;
      if (attached) {
        attached.on('paymentRequest:created', onEvent);
        attached.on('paymentRequest:updated', onEvent);
      }
    };
    attach(socketClient.getSocket());
    const unsub = socketClient.onSocketChange((s) => attach(s));
    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      unsub();
      attach(null);
    };
  }, [fetchItems]);

  const totals = useMemo(() => {
    const acc = { paid: 0, pending: 0 };
    for (const p of items) {
      const s = (p.status || '').toUpperCase();
      if (s === 'COMPLETED' || s === 'PAID') acc.paid += p.amount_cents;
      else if (s === 'PENDING' || s === 'AUTHORISED') acc.pending += p.amount_cents;
    }
    return acc;
  }, [items]);

  // Solo i conti su cui c'è ancora da incassare: il KPI e il rimando alla
  // Cassa parlano dello stesso insieme, e devono dire lo stesso numero.
  const collectable = useMemo(
    () => openBills.bills.filter(b => b.residual_cents > 0),
    [openBills.bills],
  );
  const serviceResidual = useMemo(
    () => collectable.reduce((sum, b) => sum + b.residual_cents, 0),
    [collectable],
  );

  // The span the loaded results actually cover. With no period filter set there
  // is no chosen range to display, and naming the real first and last day beats
  // a word like "sempre" that says nothing about what is on screen.
  const loadedSpan = useMemo<Period | null>(() => {
    if (items.length === 0) return null;
    let min = '';
    let max = '';
    for (const p of items) {
      const day = getRomeDatePart(p.created_at);
      if (!day) continue;
      if (!min || day < min) min = day;
      if (!max || day > max) max = day;
    }
    return min && max ? { from: min, to: max } : null;
  }, [items]);

  // Derived, never stored: a refetched payment carries its new status into
  // the pane without anyone re-selecting it.
  const selectedPayment = useMemo(
    () => items.find(p => p.id === selectedPaymentId) ?? null,
    [items, selectedPaymentId],
  );
  const selectedClosureBill = useMemo(
    () => closedBills.bills.find(b => b.id === selectedClosureBillId) ?? null,
    [closedBills.bills, selectedClosureBillId],
  );

  const showingCassa = tab === 'CASSA' && billsAvailable;
  const detailOpen = showingCassa ? selectedClosureBill !== null : selectedPayment !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Above the split, and staying there: these are the totals for whatever
          the two columns are showing, so they belong to the page rather than to
          either side of it.

          Not the word "Pagamenti" — the sidebar already names the page and
          shows it selected. What matters at a glance is that these numbers are
          live: webhooks move them while you are looking at them, so the dot is
          a standing answer to "is this current?". */}
      {/* Asymmetric gutters, deliberately: pl-4 matches the list column's own
          padding so the title starts on the same line as the rows, and the
          right ramp matches the detail pane, so the figures end where the
          detail cards end. A uniform px-8 would have floated the title a
          gutter's width off the list it belongs to.

          pb below lg: there the toolbar underneath has no top padding of its
          own — it sits directly under whatever precedes it — so the gap has to
          come from here or the section switch touches the figures. */}
      <div className="flex flex-shrink-0 flex-col gap-3 pb-3 pl-4 pr-4 pt-4 sm:pr-6 lg:flex-row lg:items-center lg:justify-between lg:gap-4 lg:pb-0 lg:pr-8">
        <h1 className="flex items-center gap-2.5 text-[22px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)] sm:text-[26px]">
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0" aria-hidden>
            <span className="ds-live-dot absolute inset-0 rounded-full bg-[var(--ds-seated-solid)]" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--ds-seated-solid)]" />
          </span>
          {/* Shortened below sm: the full sentence wraps to two lines on a
              phone, and a title that wraps stops reading as a title. */}
          <span className="sm:hidden">In tempo reale</span>
          <span className="hidden sm:inline">Stato aggiornato in tempo reale</span>
        </h1>
        {/* Hairline-split figures rather than three cards: they are one reading
            of the same money, and boxing each gave three competing objects.
            No wrapping either — a third figure dropping to its own line reads
            as a separate object. They compress instead. */}
        <div className="flex w-full flex-shrink-0 items-center divide-x divide-[var(--ds-border)] rounded-[18px] bg-[var(--ds-surface)] px-1 py-1 shadow-[var(--ds-shadow-card)] lg:w-auto lg:px-4">
          <Kpi label={KPI_LABELS.incassato} value={formatEuro(totals.paid)} tone="positive" />
          <Kpi label={KPI_LABELS.attesa} value={formatEuro(totals.pending)} tone="pending" />
          {billsAvailable && (
            <Kpi label={KPI_LABELS.residuo} value={formatEuro(serviceResidual)} tone="critical" />
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <SplitPane
          detailOpen={detailOpen}
          toolbar={
            // Section switch above the search, both full width: in a column this
            // narrow they cannot sit on one line, and the switch decides what the
            // search is even searching.
            <div className="space-y-3">
              {billsAvailable && (
                // «Chiusura», non «Cassa»: un tab che porta il nome di
                // un'altra pagina è metà della confusione che questo giro
                // di riordino ha tolto.
                <SegmentedControl<'CASSA' | 'LINKS'>
                  value={tab}
                  onChange={setTab}
                  ariaLabel="Sezione pagamenti"
                  equalWidth
                  options={[
                    { value: 'CASSA', label: 'Chiusura' },
                    { value: 'LINKS', label: 'Link', badge: total || undefined },
                  ]}
                />
              )}
              {!showingCassa && (
                <SearchField
                  value={search}
                  onChange={setSearch}
                  placeholder="Cerca cliente, telefono, ordine…"
                  ariaLabel="Cerca"
                />
              )}
            </div>
          }
          list={
            showingCassa ? (
              <ChiusuraCassa
                date={serviceFilter?.service_date}
                shift={serviceFilter?.shift}
                openCount={collectable.length}
                openResidualCents={serviceResidual}
                onOpenCassa={onOpenCassa}
                selectedId={selectedClosureBillId}
                onSelectBill={setSelectedClosureBillId}
              />
            ) : (
              <>
                {error && (
                  <Callout tone="critical" icon={AlertCircle} className="mb-4">{error}</Callout>
                )}
                {loading ? (
                  <SkeletonPaymentList count={5} />
                ) : (
                  <LinkDiPagamento
                    items={items}
                    total={total}
                    statusFilter={statusFilter}
                    onStatusFilter={setStatusFilter}
                    period={period}
                    span={loadedSpan}
                    onOpenPeriod={() => setPeriodOpen(true)}
                    selectedId={selectedPaymentId}
                    onSelect={(p) => setSelectedPaymentId(p.id)}
                  />
                )}
              </>
            )
          }
          detail={
            showingCassa ? (
              selectedClosureBill ? (
                <BillDetail
                  key={selectedClosureBill.id}
                  bill={selectedClosureBill}
                  busy={closedBills.closingId === selectedClosureBill.id}
                  onClose={() => setSelectedClosureBillId(null)}
                  // Un CLOSED/VOIDED non si richiude; il SETTLED_PARTIAL sì —
                  // si completa con gli incassi mancanti.
                  onSettle={selectedClosureBill.status === 'CLOSED' || selectedClosureBill.status === 'VOIDED'
                    ? undefined
                    : (opts) => closedBills.closeBill(selectedClosureBill, opts)}
                  onFiscalChanged={closedBills.reload}
                />
              ) : (
                <PanePlaceholder icon={Receipt}>Tocca un conto per lo scontrino elettronico</PanePlaceholder>
              )
            ) : selectedPayment ? (
              <PaymentDetail
                key={selectedPayment.id}
                payment={selectedPayment}
                onClose={() => setSelectedPaymentId(null)}
                onUpdated={(updated) => {
                  setItems(prev => prev.map(p => (p.id === updated.id ? { ...p, ...updated } : p)));
                }}
              />
            ) : (
              <PanePlaceholder icon={CreditCard}>Seleziona un pagamento dalla lista</PanePlaceholder>
            )
          }
        />
      </div>

      <PeriodPicker
        open={periodOpen}
        period={period}
        span={loadedSpan}
        summary={`${total} link · ${formatEuro(totals.paid)} incassati · ${formatEuro(totals.pending)} in attesa`}
        onApply={(next) => { setPeriod(next); setPeriodOpen(false); }}
        onClose={() => setPeriodOpen(false)}
      />
    </div>
  );
};

export default PagamentiPage;
