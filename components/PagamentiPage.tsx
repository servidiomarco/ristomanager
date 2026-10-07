import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CreditCard, Receipt } from 'lucide-react';
import { socketClient } from '../services/socketClient';
import { SkeletonPaymentList } from './SkeletonCards';
import {
  paymentsApiService, type PaymentRequest, type PaymentsListParams,
} from '../services/paymentsApiService';
import { getFeatureFlags } from '../services/apiService';
import { datePart } from '../utils/displayTime';
import {
  Callout, PanePlaceholder, SearchField, SegmentedControl, SplitPane, useMediaQuery,
} from './ds';
import { ChiusuraCassa } from './pagamenti/ChiusuraCassa';
import { LinkDiPagamento, type StatusFilter } from './pagamenti/LinkDiPagamento';
import { BillDetail } from './pagamenti/BillSheet';
import { PaymentDetail } from './pagamenti/PaymentDetail';
import { PeriodPicker, periodLabel, type Period } from './pagamenti/PeriodPicker';
import { formatEuro } from './pagamenti/paymentsView';
import { Kpi, KpiStrip } from './pagamenti/KpiStrip';
import { useCashClosure } from './pagamenti/useCashClosure';
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
   follows the period filter. The header says which one is on screen, and
   the figures beside it describe exactly that: the day (and shift) on
   Chiusura, the period on Link. Fiscalità is the other half of this pair —
   the same header grammar, and «Apri il conto» from its document sheet
   lands here, on the bill's service day. */

const KPI_LABELS = {
  incassato: 'Incassato',
  attesa: 'In attesa',
  coperti: 'Coperti',
  daIncassare: 'Da incassare',
} as const;

// «martedì 7 ottobre» dal giorno di servizio YYYY-MM-DD, come le testate di
// giorno del registro Fiscalità.
const serviceDayLabel = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
};

const PagamentiPage: React.FC<{
  globalDate?: Date;
  globalShiftFilter?: 'ALL' | 'LUNCH' | 'DINNER';
  /** Presente solo se chi guarda può entrare in Cassa: il rimando ai conti
   *  da incassare diventa un bottone, altrimenti resta una riga di stato. */
  onOpenCassa?: () => void;
  /** Conto da aprire all'arrivo, da «Apri il conto» in Fiscalità: App ha già
   *  portato la topbar sul suo servizio (giorno e turno). */
  openBillId?: number | null;
  onOpenBillHandled?: () => void;
}> = ({ globalDate, globalShiftFilter, onOpenCassa, openBillId, onOpenBillHandled }) => {
  const { t } = useTranslation('pagamenti', { useSuspense: false });
  const [tab, setTab] = useState<'CASSA' | 'LINKS'>('CASSA');

  // La lista "Conti aperti" segue datepicker + toggle turno della topbar: mostra
  // solo i conti di quel giorno/turno (turno "Tutti" = entrambi). Senza data la
  // pagina non filtra (comportamento storico).
  const serviceFilter = useMemo(
    () => globalDate
      ? {
          service_date: datePart(globalDate),
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
  // La Chiusura ha la sua ricerca: filtra nel browser i conti del giorno già
  // caricati, e passando da un tab all'altro ognuno ritrova la sua.
  const [closureSearch, setClosureSearch] = useState('');
  // Link in attesa, per il badge del tab: un numero fermo, che non cambia coi
  // filtri della lista — un badge dice che qualcosa aspetta, non quanti
  // link ci sono.
  const [pendingCount, setPendingCount] = useState(0);
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

  // Il report di chiusura vive qui, non nel tab: lo leggono il report stesso
  // e le cifre in testata.
  const { report: closureReport, error: closureError } = useCashClosure(serviceFilter?.service_date);
  // Le cifre della Chiusura seguono il turno della topbar come la card
  // «Incassi del…»: la testata dice «· cena», e i numeri accanto parlano
  // della cena. Stessa somma per metodo e stessi coperti della card.
  const closureFigures = useMemo(() => {
    const shift = serviceFilter?.shift;
    const cents = (closureReport?.methods ?? [])
      .filter(m => !shift || m.shift === shift)
      .reduce((n, m) => n + m.amount_cents, 0);
    // Gli asporti non contano: il loro covers è un 1 tecnico, non un coperto.
    const covers = (closureReport?.bills ?? [])
      .filter(b => !shift || b.shift === shift)
      .reduce((n, b) => n + (b.takeaway_order_id != null ? 0 : (b.covers || 0)), 0);
    return { cents, covers };
  }, [closureReport, serviceFilter?.shift]);

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
      const [result, pending] = await Promise.all([
        paymentsApiService.list(params),
        // Solo il conteggio: limit 1 basta, il totale arriva comunque.
        paymentsApiService.list({ status: 'PENDING,AUTHORISED', limit: 1 }).catch(() => null),
      ]);
      setItems(result.items);
      setTotal(result.total);
      if (pending) setPendingCount(pending.total);
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
      const day = datePart(p.created_at);
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

  // Arrivo da Fiscalità con un conto da aprire: si va sulla Chiusura e lo si
  // seleziona appena i conti del giorno sono caricati. Se non c'è (conto
  // annullato, giorno diverso) la richiesta si chiude comunque, per non
  // restare appesa e scattare più tardi su un giorno scelto a mano.
  useEffect(() => {
    if (openBillId == null) return;
    setTab('CASSA');
    if (closedBills.loading) return;
    if (closedBills.bills.some(b => b.id === openBillId)) setSelectedClosureBillId(openBillId);
    onOpenBillHandled?.();
  }, [openBillId, closedBills.loading, closedBills.bills, onOpenBillHandled]);

  // «Link di pagamento» per esteso dove ci sta; su telefono, col badge
  // accanto, si tronca — lì basta «Link», il titolo dice già il resto.
  const isWide = useMediaQuery('(min-width: 640px)');

  const showingCassa = tab === 'CASSA' && billsAvailable;
  const detailOpen = showingCassa ? selectedClosureBill !== null : selectedPayment !== null;

  // Di cosa parla la pagina, accanto alle cifre: il giorno (e il turno) sulla
  // Chiusura, il periodo sui Link.
  const scopeLabel = showingCassa
    ? serviceFilter
      ? `${serviceDayLabel(serviceFilter.service_date)}${serviceFilter.shift ? ` · ${serviceFilter.shift === 'LUNCH' ? 'pranzo' : 'cena'}` : ''}`
      : ''
    : periodLabel(period, new Date(), loadedSpan);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Above the split, and staying there: these are the totals for whatever
          the two columns are showing, so they belong to the page rather than to
          either side of it.

          Not the word "Pagamenti" — the sidebar already names the page and
          shows it selected. The title is the scope instead: which day (or
          period) the figures beside it describe — «Stato aggiornato in tempo
          reale» said nothing about that, and the Chiusura's day was only in
          the topbar. The dot stays, a standing answer to "is this current?":
          webhooks move these numbers while you are looking at them. */}
      {/* Asymmetric gutters, deliberately: pl-4 matches the list column's own
          padding so the title starts on the same line as the rows, and the
          right ramp matches the detail pane, so the figures end where the
          detail cards end. A uniform px-8 would have floated the title a
          gutter's width off the list it belongs to.

          pb below lg: there the toolbar underneath has no top padding of its
          own — it sits directly under whatever precedes it — so the gap has to
          come from here or the section switch touches the figures. */}
      <div className="flex flex-shrink-0 flex-col gap-3 pb-3 pl-4 pr-4 pt-4 sm:pr-6 lg:flex-row lg:items-center lg:justify-between lg:gap-4 lg:pb-0 lg:pr-8">
        <h1
          title={t('live', 'Aggiornato in tempo reale')}
          className="flex min-w-0 items-center gap-2.5 text-[22px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)] sm:text-[26px]"
        >
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0" aria-hidden>
            <span className="ds-live-dot absolute inset-0 rounded-[var(--ds-radius-control)] bg-[var(--ds-seated-solid)]" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--ds-seated-solid)]" />
          </span>
          <span className="sr-only">{t('live', 'Aggiornato in tempo reale')}: </span>
          <span className="min-w-0 truncate first-letter:uppercase">{scopeLabel}</span>
        </h1>
        {showingCassa ? (
          <KpiStrip>
            <Kpi label={t('kpi.incassato', KPI_LABELS.incassato)} value={formatEuro(closureFigures.cents)} tone="positive" />
            <Kpi label={t('kpi.coperti', KPI_LABELS.coperti)} value={String(closureFigures.covers)} />
            {serviceResidual > 0 && (
              <Kpi label={t('kpi.daIncassare', KPI_LABELS.daIncassare)} value={formatEuro(serviceResidual)} tone="critical" />
            )}
          </KpiStrip>
        ) : (
          <KpiStrip>
            <Kpi label={t('kpi.incassato', KPI_LABELS.incassato)} value={formatEuro(totals.paid)} tone="positive" />
            <Kpi label={t('kpi.attesa', KPI_LABELS.attesa)} value={formatEuro(totals.pending)} tone="pending" />
          </KpiStrip>
        )}
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
                  ariaLabel={t('sectionAria', 'Sezione pagamenti')}
                  equalWidth
                  options={[
                    { value: 'CASSA', label: t('tabCassa', 'Chiusura') },
                    { value: 'LINKS', label: isWide ? t('tabLinks', 'Link di pagamento') : t('tabLinksShort', 'Link'), badge: pendingCount || undefined },
                  ]}
                />
              )}
              {/* Ricerca su entrambi i tab, ognuno la sua: sulla Chiusura
                  filtra i conti del giorno, sui Link interroga il server. */}
              {showingCassa ? (
                <SearchField
                  key="closure"
                  value={closureSearch}
                  onChange={setClosureSearch}
                  placeholder={t('closureSearchPlaceholder', 'Cerca tavolo, cliente, importo…')}
                  ariaLabel={t('searchAria', 'Cerca')}
                />
              ) : (
                <SearchField
                  key="links"
                  value={search}
                  onChange={setSearch}
                  placeholder={t('searchPlaceholder', 'Cerca cliente, telefono, ordine…')}
                  ariaLabel={t('searchAria', 'Cerca')}
                />
              )}
            </div>
          }
          list={
            showingCassa ? (
              <ChiusuraCassa
                report={closureReport}
                error={closureError}
                shift={serviceFilter?.shift}
                query={closureSearch.trim()}
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
