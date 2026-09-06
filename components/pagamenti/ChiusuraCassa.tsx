import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { billsApiService } from '../../services/billsApiService';
import { socketClient } from '../../services/socketClient';
import type { CashClosureBillRow, CashClosureReport } from '../../types';
import { Callout, FormCard, StatusPill } from '../ds';
import { ChiusuraFiscale } from './ChiusuraFiscale';
import { formatEuro } from './paymentsView';

/* ── Chiusura di cassa ────────────────────────────────────────────────────
   I totali del giorno per metodo di incasso, dal libro cassa
   (table_bill_payments). È la pagina che si legge a fine serata contando il
   cassetto: contanti da trovare fisicamente, POS da riscontrare coi totali
   del terminale, online già riconciliato dal gateway. Sotto, i conti chiusi
   del giorno tavolo per tavolo, filtrabili per tipo di chiusura — il
   riscontro "questi sono andati a scontrino, questi a fattura, questi in
   proforma" che chiude davvero la serata. */

const METHOD_LABELS: Record<string, string> = {
  CONTANTI: 'Contanti',
  POS_FISICO: 'POS',
  SATISPAY: 'Satispay',
  BUONO_PASTO: 'Buoni pasto',
  GIFT_CARD: 'Gift card',
  SOSPESO: 'Sospeso',
  OMAGGIO: 'Omaggio',
  LINK_ONLINE: 'Online',
};

// Tipo di chiusura del conto, derivato dall'ultimo documento fiscale.
// 'none' copre sia il mai emesso sia il fallito/annullato: per il filtro
// contano tutti come "senza documento" — sono i conti da sistemare.
type DocFilter = 'all' | 'receipt' | 'invoice' | 'credit_note' | 'proforma' | 'none';

const docKind = (b: CashClosureBillRow): Exclude<DocFilter, 'all'> => {
  if (b.fiscal_status !== 'CONFIRMED') return 'none';
  if (b.fiscal_doc_type === 'INVOICE') return 'invoice';
  // Fattura stornata: la nota resta l'ultimo documento del conto, e nel
  // riscontro serale il conto va rivisto — non è né fatturato né scoperto.
  if (b.fiscal_doc_type === 'CREDIT_NOTE') return 'credit_note';
  if (b.fiscal_doc_type === 'PROFORMA') return 'proforma';
  return 'receipt';
};

const DOC_FILTERS: { value: DocFilter; label: string }[] = [
  { value: 'all', label: 'Tutti' },
  { value: 'receipt', label: 'Scontrino' },
  { value: 'invoice', label: 'Fattura' },
  { value: 'credit_note', label: 'Nota di credito' },
  { value: 'proforma', label: 'Proforma' },
  { value: 'none', label: 'Senza documento' },
];

const docPill = (b: CashClosureBillRow) => {
  const kind = docKind(b);
  // Scontrino uscito dal registratore (Passepartout o battuto a mano nel
  // periodo ponte): nel riscontro serale il numero è quello dell'RT.
  if (kind === 'receipt' && (b.fiscal_provider === 'external_rt' || b.fiscal_provider === 'passepartout')) {
    return <StatusPill tone="positive">scontrino di cassa{b.fiscal_doc_number ? ` ${b.fiscal_doc_number}` : ''}</StatusPill>;
  }
  if (kind === 'receipt') return <StatusPill tone="positive">scontrino</StatusPill>;
  if (kind === 'invoice') return <StatusPill tone="positive">fattura {b.fiscal_doc_number ?? ''}</StatusPill>;
  if (kind === 'credit_note') return <StatusPill tone="neutral">nota di credito {b.fiscal_doc_number ?? ''}</StatusPill>;
  if (kind === 'proforma') return <StatusPill tone="neutral">proforma</StatusPill>;
  if (b.fiscal_status === 'FAILED') return <StatusPill tone="critical">errore emissione</StatusPill>;
  return <StatusPill tone="neutral">senza documento</StatusPill>;
};

export const ChiusuraCassa: React.FC<{
  date?: string;
  /** Turno dalla topbar: filtra la lista dei conti (i totali per metodo
   *  restano dell'intera giornata — è la cassa che si conta a fine serata). */
  shift?: 'LUNCH' | 'DINNER';
  /** Conti con ancora un residuo: qui sono solo un rimando — si incassano
   *  in Cassa, non da questa pagina. */
  openCount?: number;
  openResidualCents?: number;
  onOpenCassa?: () => void;
  /** Un tocco sulla riga apre la scheda del conto chiuso nel pannello: è lì
   *  che vive lo scontrino elettronico (emetti, riprova, annulla). */
  selectedId?: number | null;
  onSelectBill?: (id: number) => void;
}> = ({ date, shift, openCount = 0, openResidualCents = 0, onOpenCassa, selectedId, onSelectBill }) => {
  const [report, setReport] = useState<CashClosureReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docFilter, setDocFilter] = useState<DocFilter>('all');

  const fetchReport = useCallback(async () => {
    try {
      setError(null);
      setReport(await billsApiService.getCashClosure(date));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [date]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  // I numeri si muovono mentre il servizio incassa: ogni evento di conto
  // rilegge, con debounce perché una chiusura emette più eventi in raffica.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onEvent = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { fetchReport(); }, 500);
    };
    const socket = socketClient.getSocket();
    const events = ['bill:closed', 'bill:settled', 'bill:split-paid', 'bill:payment-recorded', 'bill:payment-voided', 'bill:split-refunded', 'fiscal:updated'];
    events.forEach(e => socket?.on(e, onEvent));
    return () => {
      if (timer.current) clearTimeout(timer.current);
      events.forEach(e => socket?.off(e, onEvent));
    };
  }, [fetchReport]);

  // Prima il turno della topbar, poi il filtro documento: i conteggi sui
  // chip parlano di quello che la lista sta davvero mostrando.
  const bills = useMemo(() => {
    const all = report?.bills ?? [];
    return shift ? all.filter(b => b.shift === shift) : all;
  }, [report, shift]);
  const counts = useMemo(() => {
    const c: Record<Exclude<DocFilter, 'all'>, number> = { receipt: 0, invoice: 0, credit_note: 0, proforma: 0, none: 0 };
    bills.forEach(b => { c[docKind(b)] += 1; });
    return c;
  }, [bills]);
  const visibleBills = docFilter === 'all' ? bills : bills.filter(b => docKind(b) === docFilter);
  // Con "Tutti" i turni in vista, le righe si raggruppano per turno: lo
  // stesso numero di tavolo esiste a pranzo E a cena, e senza sezioni la
  // lista del giorno sembrerebbe piena di doppioni.
  const sections = useMemo(() => {
    const lunch = visibleBills.filter(b => b.shift === 'LUNCH');
    const dinner = visibleBills.filter(b => b.shift === 'DINNER');
    if (shift || lunch.length === 0 || dinner.length === 0) return [{ label: null as string | null, rows: visibleBills }];
    return [{ label: 'Pranzo', rows: lunch }, { label: 'Cena', rows: dinner }];
  }, [visibleBills, shift]);

  if (error) {
    return <Callout tone="critical" icon={AlertCircle}>{error}</Callout>;
  }
  if (!report) return null;

  const hasMovements = report.methods.length > 0;

  return (
    <div className="space-y-3">
      {/* Il residuo vive qui come rimando, non come lista: da quando il tab
          «Conti aperti» è stato ritirato, incassare si fa solo in Cassa. */}
      {openCount > 0 && (
        <Callout tone="pending" icon={AlertCircle}>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span>
              {openCount === 1 ? '1 conto ancora da incassare' : `${openCount} conti ancora da incassare`}
              {' · '}{formatEuro(openResidualCents)}
            </span>
            {onOpenCassa && (
              <button
                type="button"
                onClick={onOpenCassa}
                className="inline-flex min-h-[44px] items-center font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                Apri la Cassa
              </button>
            )}
          </div>
        </Callout>
      )}

      <FormCard title={`Incassi del ${report.date.split('-').reverse().join('/')}`}>
        {hasMovements ? (
          <dl className="space-y-1.5 text-[14px]">
            {report.methods.map(m => (
              <div key={m.method} className="flex justify-between text-[var(--ds-text-secondary)]">
                <dt>
                  {METHOD_LABELS[m.method] ?? m.method}
                  <span className="ml-1.5 text-[12px] text-[var(--ds-text-muted)]">×{m.movements}</span>
                </dt>
                <dd className="tabular-nums">{formatEuro(m.amount_cents)}</dd>
              </div>
            ))}
            <div className="flex justify-between border-t border-[var(--ds-border)] pt-1.5 font-semibold text-[var(--ds-text-primary)]">
              <dt>Totale</dt>
              <dd className="tabular-nums">{formatEuro(report.total_cents)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-[14px] text-[var(--ds-text-muted)]">Nessun incasso registrato.</p>
        )}
      </FormCard>

      <FormCard
        title={shift ? `Conti chiusi · ${shift === 'LUNCH' ? 'pranzo' : 'cena'}` : 'Conti chiusi'}
        aside={<span className="text-[13px] tabular-nums text-[var(--ds-text-muted)]">{bills.length}</span>}
      >
        <div className="space-y-3">
          {(report.tip_cents > 0 || report.deposit_credit_cents > 0 || report.shortfall_cents > 0) && (
            <dl className="space-y-1.5 text-[14px]">
              {report.tip_cents > 0 && (
                <div className="flex justify-between text-[var(--ds-text-secondary)]">
                  <dt>Mance</dt>
                  <dd className="tabular-nums">{formatEuro(report.tip_cents)}</dd>
                </div>
              )}
              {report.deposit_credit_cents > 0 && (
                <div className="flex justify-between text-[var(--ds-text-secondary)]">
                  <dt>Acconti maturati</dt>
                  <dd className="tabular-nums">{formatEuro(report.deposit_credit_cents)}</dd>
                </div>
              )}
              {report.shortfall_cents > 0 && (
                <div className="flex justify-between text-[var(--ds-critical-text)]">
                  <dt>Ammanchi</dt>
                  <dd className="tabular-nums">{formatEuro(report.shortfall_cents)}</dd>
                </div>
              )}
            </dl>
          )}

          {bills.length > 0 && (
            <>
              {/* Filtro per tipo di chiusura, col conteggio nel chip: a
                  colpo d'occhio quanti sono andati a scontrino, a fattura,
                  in proforma — e quanti restano scoperti. */}
              <div className="flex flex-wrap gap-1.5">
                {DOC_FILTERS.map(f => {
                  const count = f.value === 'all' ? bills.length : counts[f.value];
                  if (f.value !== 'all' && count === 0) return null;
                  return (
                    <button
                      key={f.value}
                      type="button"
                      onClick={() => setDocFilter(f.value)}
                      className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${
                        docFilter === f.value
                          ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                          : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
                      }`}
                    >
                      {f.label} <span className="tabular-nums opacity-70">{count}</span>
                    </button>
                  );
                })}
              </div>

              {sections.map(section => (
                <div key={section.label ?? 'tutti'}>
                  {section.label && (
                    <p className="mb-1 mt-2 text-[12px] font-medium text-[var(--ds-text-muted)]">
                      {section.label} <span className="tabular-nums">· {section.rows.length}</span>
                    </p>
                  )}
                  <ul>
                    {section.rows.map(b => {
                      const body = (
                        <>
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="min-w-0 truncate text-[14px] font-medium text-[var(--ds-text-primary)]">
                              Tav. {b.table_name ?? '—'}
                              {b.customer_name && <span className="ml-1.5 font-normal text-[var(--ds-text-muted)]">{b.customer_name}</span>}
                            </span>
                            <span className={`flex-shrink-0 text-[14px] font-semibold tabular-nums ${b.status === 'SETTLED_PARTIAL' ? 'text-[var(--ds-pending-text)]' : 'text-[var(--ds-text-primary)]'}`}>
                              {formatEuro(b.total_cents)}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--ds-text-muted)] tabular-nums">
                            {docPill(b)}
                            {b.status === 'SETTLED_PARTIAL' && <StatusPill tone="pending">parziale</StatusPill>}
                            {b.payments.map((p, i) => (
                              <span key={i}>{(METHOD_LABELS[p.method] ?? p.method).toLowerCase()} {formatEuro(p.amount_cents)}</span>
                            ))}
                            {b.tip_cents > 0 && <span className="text-[var(--ds-seated-text)]">mancia {formatEuro(b.tip_cents)}</span>}
                          </div>
                        </>
                      );
                      return (
                        <li key={b.id} className="[&+li]:border-t [&+li]:border-[var(--ds-border)]">
                          {onSelectBill ? (
                            <button
                              type="button"
                              onClick={() => onSelectBill(b.id)}
                              className={`-mx-2 flex w-[calc(100%+16px)] flex-col gap-1 rounded-[12px] px-2 py-2.5 text-left transition-colors ${
                                selectedId === b.id
                                  ? 'bg-[var(--ds-surface-row)]'
                                  : 'hover:bg-[var(--ds-surface-row)]'
                              } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]`}
                            >
                              {body}
                            </button>
                          ) : (
                            <div className="flex flex-col gap-1 py-2.5">{body}</div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              {visibleBills.length === 0 && (
                <p className="py-2.5 text-[13px] text-[var(--ds-text-muted)]">Nessun conto per questo filtro.</p>
              )}
            </>
          )}
          {bills.length === 0 && (
            <p className="text-[14px] text-[var(--ds-text-muted)]">Nessun conto chiuso in questo giorno.</p>
          )}
        </div>
      </FormCard>

      {/* La giornata fiscale è di calendario, non di turno: la card ignora il
          filtro della topbar apposta. */}
      <ChiusuraFiscale date={report.date} />
    </div>
  );
};
