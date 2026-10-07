import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowUpRight, ChevronDown, Download, ExternalLink, Landmark, Loader2, Printer, SearchX, X } from 'lucide-react';
import { Callout, EmptyState, FormCard, PanePlaceholder, SearchField, SplitPane, StatusPill, dsButton, useMediaQuery } from '../ds';
import { PeriodPicker, PeriodTrigger, periodLabel, type Period } from '../pagamenti/PeriodPicker';
import { formatEuro } from '../pagamenti/paymentsView';
import { Kpi, KpiStrip } from '../pagamenti/KpiStrip';
import { SkeletonPaymentList } from '../SkeletonCards';
import { socketClient } from '../../services/socketClient';
import { datePart, timePart } from '../../utils/displayTime';
import {
  billsApiService, downloadReportCsv, getFiscalDocumentDetail, getFiscalRegistry, getFiscalVatSummary,
  type FiscalDocumentDetail, type FiscalRegistryQuery, type FiscalRegistryResponse, type FiscalRegistryRow,
} from '../../services/billsApiService';
import { printFiscalRegistry } from '../../utils/printFiscalRegistry';

/* Vista Fiscalità: il registro dei documenti per periodo — scontrini,
   fatture, note di credito, proforma — con i totali che servono alle
   interrogazioni ("quanti scontrini ad agosto?") e gli export per il
   commercialista. Vive dietro fiscal:view (di default solo il titolare),
   non payments:view: la cassa del giorno è un'altra pagina e un altro
   mestiere — per questo le due pagine restano separate, ma vicine nel menu.

   Il registro sta in un componente figlio della pagina: quando arriverà il
   ciclo passivo (fatture ricevute) qui si aggiunge il segmento
   Emessi | Ricevuti senza rifare nulla. */

type ChipFilter = 'all' | 'receipt' | 'invoice' | 'credit_note' | 'proforma' | 'voided' | 'failed';

const CHIP_QUERY: Record<ChipFilter, Partial<FiscalRegistryQuery>> = {
  all: {},
  receipt: { doc_type: 'RECEIPT' },
  invoice: { doc_type: 'INVOICE' },
  credit_note: { doc_type: 'CREDIT_NOTE' },
  proforma: { doc_type: 'PROFORMA' },
  voided: { status: 'VOIDED' },
  failed: { status: 'FAILED' },
};

const TYPE_LABEL: Record<string, string> = {
  RECEIPT: 'scontrino', INVOICE: 'fattura', CREDIT_NOTE: 'nota di credito', PROFORMA: 'proforma',
};

// Stato → famiglia del design system. La fattura stornata (VOIDED con NC che
// la punta) non è un errore: è storia contabile chiusa, neutrale come la
// proforma.
const rowPill = (row: FiscalRegistryRow) => {
  if (row.status === 'CONFIRMED') {
    // Documento del registratore (RT esterno o Passepartout): stesso peso
    // fiscale, provenienza dichiarata.
    const cassa = row.doc_type === 'RECEIPT' && (row.provider === 'external_rt' || row.provider === 'passepartout');
    return <StatusPill tone={row.doc_type === 'PROFORMA' ? 'neutral' : 'positive'}>{cassa ? 'scontrino di cassa' : TYPE_LABEL[row.doc_type]}{row.doc_number ? ` ${row.doc_number}` : ''}</StatusPill>;
  }
  if (row.status === 'VOIDED') {
    return <StatusPill tone="neutral">{row.credit_note_number ? `stornata da nc ${row.credit_note_number}` : `${TYPE_LABEL[row.doc_type]} annullato`}</StatusPill>;
  }
  if (row.status === 'FAILED') return <StatusPill tone="critical">errore</StatusPill>;
  return <StatusPill tone="pending">in emissione</StatusPill>;
};

const PAGE_SIZE = 100;

// Default: il mese in corso — è l'orizzonte delle domande vere ("com'è
// andato il mese?", la liquidazione). Il picker copre il resto.
const defaultPeriod = (): Period => {
  const today = datePart(new Date());
  return { from: `${today.slice(0, 8)}01`, to: today };
};

const dayLabel = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
};

// «Cerca negli ultimi 12 mesi»: il rimedio quando la ricerca non trova nel
// periodo scelto. 365 giorni stanno sotto il tetto di 400 del server.
const lastTwelveMonths = (): Period => {
  const from = new Date();
  from.setDate(from.getDate() - 364);
  return { from: datePart(from), to: datePart(new Date()) };
};
const spanDays = (p: Period) => (Date.parse(p.to) - Date.parse(p.from)) / 86_400_000;

type OpenBill = (billId: number, serviceDate: string, shift: 'LUNCH' | 'DINNER' | null) => void;

const FiscalitaPage: React.FC<{
  /** «Apri il conto»: porta in Pagamenti › Chiusura sul servizio del conto
   *  (giorno e turno), con il conto aperto. Assente se chi guarda non vede
   *  Pagamenti. */
  onOpenBill?: OpenBill;
}> = ({ onOpenBill }) => (
  <RegistroEmessi onOpenBill={onOpenBill} />
);

const RegistroEmessi: React.FC<{ onOpenBill?: OpenBill }> = ({ onOpenBill }) => {
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [chip, setChip] = useState<ChipFilter>('all');
  const [data, setData] = useState<FiscalRegistryResponse | null>(null);
  const [rows, setRows] = useState<FiscalRegistryRow[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<FiscalDocumentDetail | null>(null);
  const [exporting, setExporting] = useState<'registry' | 'vat' | 'print' | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Con la ricerca le risposte si accavallano (si digita mentre la
  // precedente è in volo): vince solo l'ultima richiesta partita.
  const seq = useRef(0);
  // quiet: il refresh da socket non attenua la lista — in servizio gli
  // eventi arrivano a raffica e la pagina lampeggerebbe a ogni scontrino.
  const fetchRegistry = useCallback(async (offset = 0, quiet = false) => {
    const mine = ++seq.current;
    if (offset === 0 && !quiet) setLoading(true);
    try {
      setError(null);
      const res = await getFiscalRegistry({
        from: period.from, to: period.to, ...CHIP_QUERY[chip], q: query || undefined, limit: PAGE_SIZE, offset,
      });
      if (mine !== seq.current) return;
      setData(res);
      setRows(prev => offset === 0 ? res.documents : [...prev, ...res.documents]);
    } catch (err) {
      if (mine === seq.current) setError((err as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [period, chip, query]);

  useEffect(() => { setSelectedId(null); fetchRegistry(0); }, [fetchRegistry]);

  // Un'emissione o un annullo mentre la pagina è aperta: si rilegge la prima
  // pagina, con debounce perché una chiusura emette più eventi in raffica.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onEvent = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { fetchRegistry(0, true); }, 500);
    };
    const socket = socketClient.getSocket();
    socket?.on('fiscal:updated', onEvent);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      socket?.off('fiscal:updated', onEvent);
    };
  }, [fetchRegistry]);

  useEffect(() => {
    if (selectedId == null) { setDetail(null); return; }
    let alive = true;
    getFiscalDocumentDetail(selectedId)
      .then(d => { if (alive) setDetail(d); })
      .catch(err => { if (alive) setError((err as Error).message); });
    return () => { alive = false; };
  }, [selectedId]);

  const grouped = useMemo(() => {
    const byDay = new Map<string, FiscalRegistryRow[]>();
    for (const row of rows) {
      const day = String(row.day);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(row);
    }
    return [...byDay.entries()];
  }, [rows]);

  // Totale del giorno per il filtro attivo, dal server: la somma delle sole
  // righe caricate mentirebbe quando il giorno è tagliato dalla paginazione.
  const dayTotals = useMemo(
    () => new Map((data?.day_totals ?? []).map(d => [d.day, d.total_cents])),
    [data],
  );

  const totals = data?.totals;
  const counts = data?.counts;

  // Un bottone «Esporta» al posto di tre alla pari: dice cosa produce ogni
  // voce (CSV o stampa) e su telefono non manda la testata a capo.
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const exportTriggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!exportMenuRef.current?.contains(t) && !exportTriggerRef.current?.contains(t)) setExportOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExportOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [exportOpen]);

  const exportRegistry = async () => {
    setExporting('registry');
    try {
      const qs = new URLSearchParams({ from: period.from, to: period.to, format: 'csv' });
      const q = CHIP_QUERY[chip];
      if (q.doc_type) qs.set('doc_type', q.doc_type);
      if (q.status) qs.set('status', q.status);
      await downloadReportCsv(`/reports/fiscal-registry?${qs}`, `registro-documenti-${period.from}_${period.to}.csv`);
    } catch (err) { setError((err as Error).message); } finally { setExporting(null); }
  };

  const exportVat = async () => {
    setExporting('vat');
    try {
      await downloadReportCsv(`/reports/fiscal-vat-summary?from=${period.from}&to=${period.to}&format=csv`, `corrispettivi-iva-${period.from}_${period.to}.csv`);
    } catch (err) { setError((err as Error).message); } finally { setExporting(null); }
  };

  const printSummary = async () => {
    if (!data) return;
    setExporting('print');
    try {
      const [vat, settings] = await Promise.all([
        getFiscalVatSummary(period.from, period.to),
        billsApiService.getFiscalSettings().catch(() => null),
      ]);
      printFiscalRegistry({
        businessName: settings?.seller?.business_name || '',
        vatNumber: settings?.vat_number || '',
        from: period.from,
        to: period.to,
        registry: data,
        vat,
      });
    } catch (err) { setError((err as Error).message); } finally { setExporting(null); }
  };

  // Stesso chip dei filtri di Link di pagamento: le due pagine si leggono
  // come una coppia anche nei dettagli.
  const chipClass = (active: boolean) =>
    `inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-[var(--ds-radius-control)] px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
      active ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
             : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] hover:text-[var(--ds-text-primary)]'
    }`;
  const actionBtn =
    'inline-flex h-9 items-center gap-1.5 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-3.5 text-[13px] font-medium text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';
  const menuItem =
    'flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40';

  const chips: { value: ChipFilter; label: string; count?: number }[] = [
    { value: 'all', label: 'Tutti', count: counts?.all },
    { value: 'receipt', label: 'Scontrini', count: counts?.receipt },
    { value: 'invoice', label: 'Fatture', count: counts?.invoice },
    { value: 'credit_note', label: 'Note di credito', count: counts?.credit_note },
    { value: 'proforma', label: 'Proforma', count: counts?.proforma },
    { value: 'voided', label: 'Annullati', count: counts?.voided },
    { value: 'failed', label: 'Errori', count: counts?.failed },
  ];
  // Solo i chip che hanno qualcosa da mostrare (più «Tutti» e quello attivo):
  // in un mese normale proforma, note di credito ed errori sono zero, e sette
  // chip alla pari nascondevano i due che contano.
  const visibleChips = chips.filter(c => c.value === 'all' || c.value === chip || (c.count ?? 0) > 0);
  const activeChipLabel = chips.find(c => c.value === chip)?.label;

  const exportItems = [
    { key: 'registry', label: 'Registro documenti (CSV)', icon: Download, run: exportRegistry,
      // Il registro esporta il filtro attivo: meglio dirlo prima del download.
      note: chip !== 'all' ? `solo ${activeChipLabel?.toLowerCase()}` : undefined },
    { key: 'vat', label: 'Corrispettivi IVA (CSV)', icon: Download, run: exportVat },
    { key: 'print', label: 'Stampa riepilogo', icon: Printer, run: printSummary, disabled: !data },
  ];

  const failedCount = totals?.failed_count ?? 0;
  const isWide = useMediaQuery('(min-width: 640px)');
  const canWiden = spanDays(period) < 364;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Testata: periodo + export a destra, KPI del periodo sotto — gli
          stessi numeri qualunque cosa la lista stia filtrando. */}
      <div className="flex flex-shrink-0 flex-col gap-3 pb-3 pl-4 pr-4 pt-4 sm:pr-6 lg:flex-row lg:items-center lg:justify-between lg:gap-4 lg:pb-0 lg:pr-8">
        <div className="flex flex-wrap items-center gap-2">
          <PeriodTrigger period={period} count={counts?.all} onClick={() => setPeriodOpen(true)} />
          <div className="relative">
            <button
              ref={exportTriggerRef}
              type="button"
              onClick={() => setExportOpen(v => !v)}
              disabled={exporting != null}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
              className={actionBtn}
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Esporta
              <ChevronDown className="h-3.5 w-3.5 text-[var(--ds-text-muted)]" aria-hidden />
            </button>
            {exportOpen && (
              <div
                ref={exportMenuRef}
                role="menu"
                className="absolute left-0 top-full z-30 mt-2 w-[256px] overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] py-1.5 shadow-[var(--ds-shadow-raised)]"
              >
                {exportItems.map(a => (
                  <button
                    key={a.key}
                    type="button"
                    role="menuitem"
                    disabled={a.disabled}
                    onClick={() => { setExportOpen(false); a.run(); }}
                    className={menuItem}
                  >
                    <a.icon className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                    <span className="flex min-w-0 flex-col">
                      {a.label}
                      {a.note && <span className="text-[12px] text-[var(--ds-text-muted)]">{a.note}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <KpiStrip>
          <Kpi label="Documentato" value={formatEuro(totals?.documented_total_cents ?? 0)} tone="positive" />
          <Kpi label={`Scontrini · ${totals?.receipts.count ?? 0}`} value={formatEuro(totals?.receipts.total_cents ?? 0)} />
          <Kpi label={`Fatture · ${totals?.invoices.count ?? 0}`} value={formatEuro(totals?.invoices.total_cents ?? 0)} />
          {/* Su telefono una quarta cifra manda le altre a capo, e gli errori
              hanno già l'avviso sopra la lista. Non renderizzata, non nascosta:
              il divide-x lascerebbe il filo della cifra che non c'è. */}
          {isWide && (totals?.voided_count ?? 0) + failedCount > 0 && (
            <Kpi label="Annullati / errori" value={`${totals!.voided_count} / ${failedCount}`} tone="critical" />
          )}
        </KpiStrip>
      </div>

      <div className="min-h-0 flex-1">
        <SplitPane
          detailOpen={selectedId !== null}
          toolbar={
            <div className="space-y-3">
              <SearchField
                value={search}
                onChange={setSearch}
                placeholder="Cerca tavolo, cliente, importo…"
                ariaLabel="Cerca nel registro"
              />
              <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {visibleChips.map(c => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setChip(c.value)}
                    aria-pressed={chip === c.value}
                    className={chipClass(chip === c.value)}
                  >
                    {c.label}
                    {/* Con una ricerca attiva i conteggi del periodo
                        smentirebbero la lista: si tolgono. */}
                    {!query && c.count != null && <span className="tabular-nums opacity-70">{c.count}</span>}
                  </button>
                ))}
              </div>
            </div>
          }
          list={
            <div className={`space-y-4 pb-6 transition-opacity ${loading && data ? 'opacity-60' : ''}`}>
              {error && <Callout tone="critical" icon={AlertCircle}>{error}</Callout>}
              {/* Gli errori in testa, non in fondo ai chip: sono l'unica cosa
                  del registro che chiede di fare qualcosa. Solo sulla vista
                  intera — dentro un filtro o una ricerca è rumore. */}
              {failedCount > 0 && chip === 'all' && !query && (
                <Callout
                  tone="critical"
                  icon={AlertCircle}
                  title={failedCount === 1 ? '1 documento non emesso' : `${failedCount} documenti non emessi`}
                  action={
                    <button
                      type="button"
                      onClick={() => setChip('failed')}
                      className="inline-flex h-10 items-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-4 text-[14px] font-medium text-[var(--ds-critical-text)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                    >
                      Mostra
                    </button>
                  }
                >
                  Si riemettono dal conto, in Pagamenti.
                </Callout>
              )}
              {!data && !error && <SkeletonPaymentList count={6} />}
              {data && query && data.total_count > 0 && (
                <p className="text-[13px] text-[var(--ds-text-muted)]">
                  {data.total_count === 1 ? '1 risultato' : `${data.total_count} risultati`} per «{query}»
                </p>
              )}
              {data && rows.length === 0 && !error && (
                query ? (
                  <EmptyState
                    icon={SearchX}
                    action={canWiden ? (
                      <button type="button" onClick={() => setPeriod(lastTwelveMonths())} className={dsButton.quiet}>
                        Cerca negli ultimi 12 mesi
                      </button>
                    ) : undefined}
                  >
                    Nessun documento per «{query}» · {periodLabel(period)}
                  </EmptyState>
                ) : (
                  <EmptyState icon={Landmark}>
                    {chip === 'all' ? 'Nessun documento nel periodo.' : 'Nessun documento per questo filtro.'}
                  </EmptyState>
                )
              )}
              {grouped.map(([day, dayRows]) => (
                <section key={day}>
                  <h3 className="flex items-baseline justify-between gap-3 pb-1.5 text-[13px] font-medium text-[var(--ds-text-muted)]">
                    <span>{dayLabel(day)}</span>
                    <span className="tabular-nums">
                      Tot. <span className="text-[var(--ds-text-primary)]">{formatEuro(dayTotals.get(day) ?? dayRows.reduce((n, r) => n + r.total_cents, 0))}</span>
                    </span>
                  </h3>
                  <ul className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
                    {dayRows.map(row => (
                      <li key={row.id} className="[&+li]:border-t [&+li]:border-[var(--ds-border)]">
                        <button
                          type="button"
                          onClick={() => setSelectedId(row.id)}
                          className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--ds-surface-row)] ${selectedId === row.id ? 'bg-[var(--ds-surface-row)]' : ''}`}
                        >
                          <span className="flex min-w-0 flex-col gap-1">
                            {rowPill(row)}
                            <span className="truncate text-[13px] text-[var(--ds-text-muted)]">
                              {[row.table_name ? `tavolo ${row.table_name}` : null, row.buyer_name || row.customer_name].filter(Boolean).join(' · ') || `conto #${row.table_bill_id ?? '—'}`}
                            </span>
                          </span>
                          <span className="flex flex-shrink-0 flex-col items-end gap-1">
                            <span className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{formatEuro(row.total_cents)}</span>
                            <span className="text-[12px] tabular-nums text-[var(--ds-text-muted)]">{timePart(row.created_at)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {data && rows.length < data.total_count && (
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={async () => { setLoadingMore(true); await fetchRegistry(rows.length); setLoadingMore(false); }}
                  className="mx-auto flex h-10 items-center gap-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-5 text-[14px] font-medium text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] hover:bg-[var(--ds-surface-row)] disabled:opacity-40"
                >
                  {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                  Carica altri ({data.total_count - rows.length})
                </button>
              )}
            </div>
          }
          detail={
            detail ? (
              <DocumentoDetail detail={detail} onClose={() => setSelectedId(null)} onOpenBill={onOpenBill} />
            ) : (
              <PanePlaceholder icon={Landmark}>Seleziona un documento dal registro</PanePlaceholder>
            )
          }
        />
      </div>

      <PeriodPicker
        open={periodOpen}
        period={period}
        summary={data ? `${data.total_count} documenti · ${formatEuro(data.totals.documented_total_cents)} documentato` : undefined}
        onApply={(next) => { setPeriod(next); setPeriodOpen(false); }}
        onClose={() => setPeriodOpen(false)}
      />
    </div>
  );
};

const DocumentoDetail: React.FC<{ detail: FiscalDocumentDetail; onClose: () => void; onOpenBill?: OpenBill }> = ({ detail, onClose, onOpenBill }) => {
  const d = detail.document;
  const vatLabel = (code: string) => /^\d/.test(code) ? `iva ${code.replace('.', ',').replace(',00', '')}%` : `natura ${code}`;
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[14px]">
      <dt className="text-[var(--ds-text-muted)]">{label}</dt>
      <dd className="text-right text-[var(--ds-text-primary)]">{value}</dd>
    </div>
  );
  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Su mobile il pannello copre la lista come sheet: serve l'uscita. */}
      <div className="flex items-center justify-between gap-3 md:hidden">
        <span className="text-[16px] font-semibold text-[var(--ds-text-primary)]">Documento</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Chiudi"
          className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <FormCard
        title={`${TYPE_LABEL[d.doc_type] ?? d.doc_type}${d.doc_number ? ` ${d.doc_number}` : ''}`}
        aside={
          d.status === 'CONFIRMED' ? <StatusPill tone={d.doc_type === 'PROFORMA' ? 'neutral' : 'positive'}>emesso</StatusPill>
          : d.status === 'VOIDED' ? <StatusPill tone="neutral">{d.credit_note_number ? 'stornata' : 'annullato'}</StatusPill>
          : d.status === 'FAILED' ? <StatusPill tone="critical">errore</StatusPill>
          : <StatusPill tone="pending">in emissione</StatusPill>
        }
      >
        <dl className="divide-y divide-[var(--ds-border)]">
          {row('Totale', <span className="font-semibold tabular-nums">{formatEuro(d.total_cents)}</span>)}
          {row('Emesso', `${datePart(d.created_at).split('-').reverse().join('/')} ${timePart(d.created_at)}`)}
          {d.voided_at && row('Annullato', `${datePart(d.voided_at).split('-').reverse().join('/')} ${timePart(d.voided_at)}`)}
          {d.credit_note_number && row('Stornata da', `nota di credito ${d.credit_note_number}`)}
          {d.related && row('Storna', `${TYPE_LABEL[d.related.doc_type] ?? d.related.doc_type} ${d.related.doc_number ?? ''}`)}
          {d.buyer && row('Intestatario', <span>{d.buyer.name}{d.buyer.vat_number && <span className="block text-[12px] tabular-nums text-[var(--ds-text-muted)]">P.IVA {d.buyer.vat_number}</span>}</span>)}
          {(d.table_name || d.customer_name) && row('Conto', [d.table_name ? `tavolo ${d.table_name}` : null, d.customer_name].filter(Boolean).join(' · '))}
          {d.provider_ref && row('Riferimento provider', <span className="break-all text-[12px] tabular-nums">{d.provider_ref}</span>)}
          {d.fiscal_id && row('P.iva emittente', <span className="tabular-nums">{d.fiscal_id}</span>)}
        </dl>
        {d.error && <p className="mt-2 break-words text-[13px] text-[var(--ds-critical-text)]">{d.error}</p>}
        <div className="mt-3 flex flex-wrap gap-2 empty:hidden">
          {/* Il registro legge, il conto agisce: riemettere, annullare, fare
              la nota di credito si fa dalla scheda del conto in Pagamenti.
              Senza questo bottone un errore qui era un vicolo cieco. */}
          {onOpenBill && d.table_bill_id != null && (
            <button
              type="button"
              onClick={() => onOpenBill(d.table_bill_id!, d.bill_service_date ?? datePart(d.created_at), d.bill_shift ?? null)}
              className="inline-flex h-10 items-center gap-1.5 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-4 text-[13px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              <ArrowUpRight className="h-4 w-4" />
              Apri il conto
            </button>
          )}
          {d.public_token && d.doc_type === 'RECEIPT' && (
            <a
              href={`${window.location.origin}/scontrino/${d.public_token}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center gap-1.5 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-4 text-[13px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]"
            >
              <ExternalLink className="h-4 w-4" />
              Copia digitale
            </a>
          )}
        </div>
      </FormCard>

      {detail.items.length > 0 && (
        <FormCard title="Righe">
          <ul>
            {detail.items.map((i, idx) => (
              <li key={idx} className="flex items-baseline justify-between gap-3 py-2 text-[14px] [&+li]:border-t [&+li]:border-[var(--ds-border)]">
                <span className="min-w-0">
                  <span className="text-[var(--ds-text-primary)]">{i.quantity}× {i.description}</span>
                  <span className="ml-2 text-[12px] text-[var(--ds-text-muted)]">{vatLabel(i.vat_rate_code)}</span>
                </span>
                <span className="flex-shrink-0 tabular-nums text-[var(--ds-text-secondary)]">{formatEuro(Math.round(i.unit_price_cents * i.quantity))}</span>
              </li>
            ))}
          </ul>
        </FormCard>
      )}

      {(detail.payments.cash_cents + detail.payments.electronic_cents + detail.payments.ticket_cents + detail.payments.uncollected_cents > 0) && (
        <FormCard title="Pagamenti">
          <dl className="divide-y divide-[var(--ds-border)]">
            {detail.payments.cash_cents > 0 && row('Contanti', <span className="tabular-nums">{formatEuro(detail.payments.cash_cents)}</span>)}
            {detail.payments.electronic_cents > 0 && row('Elettronico', <span className="tabular-nums">{formatEuro(detail.payments.electronic_cents)}</span>)}
            {detail.payments.ticket_cents > 0 && row('Buoni pasto', <span className="tabular-nums">{formatEuro(detail.payments.ticket_cents)}</span>)}
            {detail.payments.uncollected_cents > 0 && row('Non riscosso', <span className="tabular-nums">{formatEuro(detail.payments.uncollected_cents)}</span>)}
            {detail.payments.discount_cents > 0 && row('Sconto', <span className="tabular-nums">−{formatEuro(detail.payments.discount_cents)}</span>)}
          </dl>
        </FormCard>
      )}
    </div>
  );
};

export default FiscalitaPage;
