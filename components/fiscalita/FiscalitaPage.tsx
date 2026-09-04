import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, Landmark, Loader2, Printer, X } from 'lucide-react';
import { FormCard, PanePlaceholder, SplitPane, StatusPill } from '../ds';
import { PeriodPicker, PeriodTrigger, type Period } from '../pagamenti/PeriodPicker';
import { formatEuro } from '../pagamenti/paymentsView';
import { socketClient } from '../../services/socketClient';
import { getRomeDatePart, getRomeTimePart } from '../../utils/reservationTime';
import {
  billsApiService, downloadReportCsv, getFiscalDocumentDetail, getFiscalRegistry, getFiscalVatSummary,
  type FiscalDocumentDetail, type FiscalRegistryQuery, type FiscalRegistryResponse, type FiscalRegistryRow,
} from '../../services/billsApiService';
import { printFiscalRegistry } from '../../utils/printFiscalRegistry';

/* Vista Fiscalità: il registro dei documenti per periodo — scontrini,
   fatture, note di credito, proforma — con i totali che servono alle
   interrogazioni ("quanti scontrini ad agosto?") e gli export per il
   commercialista. Vive dietro reports:view, non payments:view: la cassa del
   giorno è un'altra pagina e un altro mestiere.

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
  const today = getRomeDatePart(new Date());
  return { from: `${today.slice(0, 8)}01`, to: today };
};

const dayLabel = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
};

const Kpi: React.FC<{ label: string; value: string; tone?: 'positive' | 'critical' }> = ({ label, value, tone }) => (
  <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 py-2 lg:flex-none lg:px-4 lg:py-2.5 lg:first:pl-0 lg:last:pr-0">
    <span className={`text-[17px] leading-none font-semibold tracking-[-0.02em] tabular-nums sm:text-[20px] ${
      tone === 'positive' ? 'text-[var(--ds-seated-text)]'
      : tone === 'critical' ? 'text-[var(--ds-critical-text)]'
      : 'text-[var(--ds-text-primary)]'
    }`}>{value}</span>
    <span className="truncate text-[11px] text-[var(--ds-text-muted)] sm:text-[12px]">{label}</span>
  </div>
);

const FiscalitaPage: React.FC = () => (
  <RegistroEmessi />
);

const RegistroEmessi: React.FC = () => {
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

  const fetchRegistry = useCallback(async (offset = 0) => {
    try {
      setError(null);
      const res = await getFiscalRegistry({ from: period.from, to: period.to, ...CHIP_QUERY[chip], limit: PAGE_SIZE, offset });
      setData(res);
      setRows(prev => offset === 0 ? res.documents : [...prev, ...res.documents]);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [period, chip]);

  useEffect(() => { setSelectedId(null); fetchRegistry(0); }, [fetchRegistry]);

  // Un'emissione o un annullo mentre la pagina è aperta: si rilegge la prima
  // pagina, con debounce perché una chiusura emette più eventi in raffica.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onEvent = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { fetchRegistry(0); }, 500);
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

  const totals = data?.totals;
  const counts = data?.counts;

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

  const chipClass = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${
      active ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
             : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
    }`;
  const actionBtn =
    'inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-surface)] px-3.5 text-[13px] font-medium text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

  const chips: { value: ChipFilter; label: string; count?: number }[] = [
    { value: 'all', label: 'Tutti', count: counts?.all },
    { value: 'receipt', label: 'Scontrini', count: counts?.receipt },
    { value: 'invoice', label: 'Fatture', count: counts?.invoice },
    { value: 'credit_note', label: 'Note di credito', count: counts?.credit_note },
    { value: 'proforma', label: 'Proforma', count: counts?.proforma },
    { value: 'voided', label: 'Annullati', count: counts?.voided },
    { value: 'failed', label: 'Errori', count: counts?.failed },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Testata: periodo + export a destra, KPI del periodo sotto — gli
          stessi numeri qualunque cosa la lista stia filtrando. */}
      <div className="flex flex-shrink-0 flex-col gap-3 pb-3 pl-4 pr-4 pt-4 sm:pr-6 lg:flex-row lg:items-center lg:justify-between lg:gap-4 lg:pb-0 lg:pr-8">
        <div className="flex flex-wrap items-center gap-2">
          <PeriodTrigger period={period} count={counts?.all} onClick={() => setPeriodOpen(true)} />
          <button type="button" onClick={exportRegistry} disabled={exporting != null} className={actionBtn}>
            {exporting === 'registry' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Registro
          </button>
          <button type="button" onClick={exportVat} disabled={exporting != null} className={actionBtn}>
            {exporting === 'vat' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Corrispettivi iva
          </button>
          <button type="button" onClick={printSummary} disabled={exporting != null || !data} className={actionBtn}>
            {exporting === 'print' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
            Stampa
          </button>
        </div>
        <div className="flex w-full flex-shrink-0 items-center divide-x divide-[var(--ds-border)] rounded-[18px] bg-[var(--ds-surface)] px-1 py-1 shadow-[var(--ds-shadow-card)] lg:w-auto lg:px-4">
          <Kpi label="documentato" value={formatEuro(totals?.documented_total_cents ?? 0)} tone="positive" />
          <Kpi label={`scontrini · ${totals?.receipts.count ?? 0}`} value={formatEuro(totals?.receipts.total_cents ?? 0)} />
          <Kpi label={`fatture · ${totals?.invoices.count ?? 0}`} value={formatEuro(totals?.invoices.total_cents ?? 0)} />
          {(totals?.voided_count ?? 0) + (totals?.failed_count ?? 0) > 0 && (
            <Kpi label="annullati / errori" value={`${totals!.voided_count} / ${totals!.failed_count}`} tone="critical" />
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <SplitPane
          detailOpen={selectedId !== null}
          toolbar={
            <div className="flex flex-wrap gap-1.5">
              {chips.map(c => (
                <button key={c.value} type="button" onClick={() => setChip(c.value)} className={chipClass(chip === c.value)}>
                  {c.label}{c.count != null && c.count > 0 ? ` ${c.count}` : ''}
                </button>
              ))}
            </div>
          }
          list={
            <div className="space-y-4 pb-6">
              {error && <p className="text-[13px] text-[var(--ds-critical-text)]">{error}</p>}
              {data && rows.length === 0 && !error && (
                <p className="pt-6 text-center text-[14px] text-[var(--ds-text-muted)]">Nessun documento nel periodo</p>
              )}
              {grouped.map(([day, dayRows]) => (
                <section key={day}>
                  <h3 className="pb-1.5 text-[13px] font-medium text-[var(--ds-text-muted)]">{dayLabel(day)}</h3>
                  <ul className="overflow-hidden rounded-2xl bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
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
                              {[row.table_name ? `tavolo ${row.table_name}` : null, row.customer_name].filter(Boolean).join(' · ') || `conto #${row.table_bill_id ?? '—'}`}
                            </span>
                          </span>
                          <span className="flex flex-shrink-0 flex-col items-end gap-1">
                            <span className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{formatEuro(row.total_cents)}</span>
                            <span className="text-[12px] tabular-nums text-[var(--ds-text-muted)]">{getRomeTimePart(row.created_at)}</span>
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
                  className="mx-auto flex h-10 items-center gap-2 rounded-full bg-[var(--ds-surface)] px-5 text-[14px] font-medium text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] hover:bg-[var(--ds-surface-row)] disabled:opacity-40"
                >
                  {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                  Carica altri ({data.total_count - rows.length})
                </button>
              )}
            </div>
          }
          detail={
            detail ? (
              <DocumentoDetail detail={detail} onClose={() => setSelectedId(null)} />
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

const DocumentoDetail: React.FC<{ detail: FiscalDocumentDetail; onClose: () => void }> = ({ detail, onClose }) => {
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
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]"
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
          {row('Emesso', `${getRomeDatePart(d.created_at).split('-').reverse().join('/')} ${getRomeTimePart(d.created_at)}`)}
          {d.voided_at && row('Annullato', `${getRomeDatePart(d.voided_at).split('-').reverse().join('/')} ${getRomeTimePart(d.voided_at)}`)}
          {d.credit_note_number && row('Stornata da', `nota di credito ${d.credit_note_number}`)}
          {d.related && row('Storna', `${TYPE_LABEL[d.related.doc_type] ?? d.related.doc_type} ${d.related.doc_number ?? ''}`)}
          {(d.table_name || d.customer_name) && row('Conto', [d.table_name ? `tavolo ${d.table_name}` : null, d.customer_name].filter(Boolean).join(' · '))}
          {d.provider_ref && row('Riferimento provider', <span className="break-all text-[12px] tabular-nums">{d.provider_ref}</span>)}
          {d.fiscal_id && row('P.iva emittente', <span className="tabular-nums">{d.fiscal_id}</span>)}
        </dl>
        {d.error && <p className="mt-2 break-words text-[13px] text-[var(--ds-critical-text)]">{d.error}</p>}
        {d.public_token && d.doc_type === 'RECEIPT' && (
          <a
            href={`${window.location.origin}/scontrino/${d.public_token}`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex h-10 items-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-4 text-[13px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]"
          >
            <ExternalLink className="h-4 w-4" />
            Copia digitale
          </a>
        )}
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
