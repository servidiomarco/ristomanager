import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { socketClient } from '../services/socketClient';
import { SkeletonPaymentList } from './SkeletonCards';
import {
  paymentsApiService, type PaymentRequest, type PaymentsListParams,
} from '../services/paymentsApiService';
import { getFeatureFlags } from '../services/apiService';
import { getRomeDatePart } from '../utils/reservationTime';
import { Callout, SearchField, SegmentedControl } from './ds';
import { ContiAperti, type BillsSummary } from './pagamenti/ContiAperti';
import { LinkDiPagamento, type StatusFilter } from './pagamenti/LinkDiPagamento';
import { PaymentDetailSheet } from './pagamenti/PaymentDetailSheet';
import { PeriodPicker, type Period } from './pagamenti/PeriodPicker';
import { formatEuro } from './pagamenti/paymentsView';

/* ── Pagamenti ────────────────────────────────────────────────────────────
   Two things the restaurant calls "pagamenti" and used to stack in one
   column: the bills open on tables right now, and the payment links sent to
   customers. They answer different questions on different clocks — one is the
   service happening this minute, the other is a ledger over a period — so
   they get a tab each rather than a shared scroll where the second always
   started below the fold.

   Their date scopes stay independent, exactly as they already were: Conti
   aperti follows the current service the server reports, Link follows the
   period filter. */

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

const PagamentiPage: React.FC = () => {
  const [tab, setTab] = useState<'BILLS' | 'LINKS'>('BILLS');

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

  const [selected, setSelected] = useState<PaymentRequest | null>(null);
  const [billsSummary, setBillsSummary] = useState<BillsSummary>({
    openCount: 0, residualCents: 0,
  });

  // The bills tab only exists with pay-at-table on. null = flag not known yet,
  // so the tab bar doesn't flash a section that is about to disappear.
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

  // Stable identity: ContiAperti reports its summary from an effect, and a
  // fresh closure every render would make that effect fire in a loop.
  const handleBillsSummary = useCallback((next: BillsSummary) => setBillsSummary(next), []);

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

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        {/* Not the word "Pagamenti" — the sidebar already names the page and
            shows it selected. What matters at a glance is that these numbers
            are live: webhooks move them while you are looking at them, so the
            dot is a standing answer to "is this current?". The service the
            figures belong to drops to the line beneath. */}
        <div className="min-w-0">
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
        </div>
        {/* Hairline-split figures rather than three cards: they are one reading
            of the same money, and boxing each gave three competing objects. */}
        {/* No wrapping: three figures that are one reading of the same money,
            so a third dropping to its own line reads as a separate object.
            They compress instead — full width on a phone, hugging on lg. */}
        <div className="flex w-full flex-shrink-0 items-center divide-x divide-[var(--ds-border)] rounded-[18px] bg-[var(--ds-surface)] px-1 py-1 shadow-[var(--ds-shadow-card)] lg:w-auto lg:px-4">
          <Kpi label={KPI_LABELS.incassato} value={formatEuro(totals.paid)} tone="positive" />
          <Kpi label={KPI_LABELS.attesa} value={formatEuro(totals.pending)} tone="pending" />
          {billsAvailable && (
            <Kpi label={KPI_LABELS.residuo} value={formatEuro(billsSummary.residualCents)} tone="critical" />
          )}
        </div>
      </div>

      {/* Search leads, the section switch follows — the same order Menu &
          Banchetti uses, so the two pages do not disagree about where the field
          lives. The search applies to whichever tab is showing: bills match on
          table number or the name that booked it, links on customer, phone and
          order. */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row-reverse sm:items-center sm:gap-4">
        {billsAvailable && (
          <SegmentedControl<'BILLS' | 'LINKS'>
            value={tab}
            onChange={setTab}
            ariaLabel="Sezione pagamenti"
            equalWidth={false}
            options={[
              { value: 'BILLS', label: 'Conti aperti', badge: billsSummary.openCount || undefined },
              { value: 'LINKS', label: 'Link di pagamento', badge: total || undefined },
            ]}
          />
        )}
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder={tab === 'BILLS' ? 'Cerca tavolo o cliente…' : 'Cerca cliente, telefono, ordine…'}
          ariaLabel="Cerca"
          className="min-w-0 sm:flex-1"
        />
      </div>

      {tab === 'BILLS' && billsAvailable && (
        <ContiAperti query={search} onSummaryChange={handleBillsSummary} />
      )}

      {tab === 'LINKS' && (
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
              onSelect={setSelected}
            />
          )}
        </>
      )}

      <PeriodPicker
        open={periodOpen}
        period={period}
        span={loadedSpan}
        summary={`${total} link · ${formatEuro(totals.paid)} incassati · ${formatEuro(totals.pending)} in attesa`}
        onApply={(next) => { setPeriod(next); setPeriodOpen(false); }}
        onClose={() => setPeriodOpen(false)}
      />

      {selected && (
        <PaymentDetailSheet
          payment={selected}
          onClose={() => setSelected(null)}
          onUpdated={(updated) => {
            setItems(prev => prev.map(p => (p.id === updated.id ? { ...p, ...updated } : p)));
            setSelected(prev => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev));
          }}
        />
      )}
    </div>
  );
};

export default PagamentiPage;
