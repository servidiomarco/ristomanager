import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Search, Siren, Timer, Truck } from 'lucide-react';
import { haccpApiService, HaccpTraceResult } from '../../services/haccpApiService';
import { useAuth } from '../../contexts/AuthContext';
import { Callout, EmptyState, ModalShell, StatusPill, dsButton, dsInput, dsTextarea } from '../ds';
import { Card, CardHeader, emptyNote, formatLongDate, formatNumber, formatShortDate, rowList, todayISO } from './haccpUi';
import { processLabel, processSummary } from './HaccpProcesses';
import { HACCP_PROCESS_LABELS_IT, type HaccpProcess } from '../../utils/haccp';

/* Rintracciabilità (Reg. CE 178/2002, artt. 18–19): dato un prodotto, un
   lotto, un fornitore o un documento di trasporto, da dove è arrivato e in
   quali preparazioni del locale è finito. Da qui parte il richiamo: una non
   conformità con la sua fonte, che si chiude scrivendo cosa è stato ritirato
   e chi è stato avvisato. */

export const HaccpTrace: React.FC<{ refreshKey: number; onRecallCreated?: () => void }> = ({ refreshKey, onRecallCreated }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const { hasPermission } = useAuth();
  const [q, setQ] = useState('');
  const [result, setResult] = useState<HaccpTraceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recalling, setRecalling] = useState(false);
  const seq = useRef(0);

  const search = async (query: string) => {
    const clean = query.trim();
    if (clean.length < 2) { setResult(null); return; }
    const mine = ++seq.current;
    setLoading(true);
    try {
      const r = await haccpApiService.trace(clean);
      if (mine === seq.current) { setResult(r); setError(null); }
    } catch (e: any) {
      if (mine === seq.current) setError(e?.message || t('err.load', 'Errore nel caricamento'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };

  // Cerca mentre si scrive, con un attimo di respiro fra un tasto e l'altro.
  useEffect(() => {
    const id = window.setTimeout(() => search(q), 300);
    return () => window.clearTimeout(id);
  }, [q, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = result ? result.receipts.length + result.production.length : 0;

  return (
    <div className="space-y-4">
      <p className="text-[14px] text-[var(--ds-text-muted)]">
        {t('trace.intro', 'Cerca un prodotto, un lotto, un fornitore o un documento di trasporto: vedi da dove è arrivato e dove è stato usato.')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-text-muted)]" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder={t('trace.placeholder', 'Lotto, prodotto, fornitore, DDT')}
            aria-label={t('trace.search', 'Cerca nella rintracciabilità')}
            className="h-11 w-full rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] pl-10 pr-4 text-[15px] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] placeholder:text-[var(--ds-text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          />
        </div>
        {hasPermission('haccp:record') && (
          <button type="button" className={dsButton.secondary} onClick={() => setRecalling(true)}>
            <Siren className="h-4 w-4" aria-hidden />
            {t('trace.recall', 'Avvia un richiamo')}
          </button>
        )}
      </div>

      {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}

      {q.trim().length < 2 ? null : loading && !result ? (
        <p className={emptyNote}>{t('loading', 'Caricamento…')}</p>
      ) : result && total === 0 ? (
        <EmptyState icon={Search}>{t('trace.none', 'Nessun arrivo e nessun processo con «{{q}}».', { q: result.q })}</EmptyState>
      ) : result && (
        <>
          <Card>
            <CardHeader
              title={t('trace.arrivals', 'Arrivi')}
              icon={<Truck className="h-4 w-4" />}
              status={t('records', '{{count}} registrazioni', { count: result.receipts.length })}
            />
            {result.receipts.length === 0 ? (
              <p className={emptyNote}>{t('trace.noArrivals', 'Nessun ricevimento.')}</p>
            ) : (
              <ul className={rowList}>
                {result.receipts.map(r => (
                  <li key={r.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
                    <span className="w-24 flex-shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">{formatLongDate(r.date)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-medium text-[var(--ds-text-primary)]">
                        {r.product}{r.lotNumber && <span className="ml-1.5 text-[13px] tabular-nums text-[var(--ds-text-muted)]">{t('lotInline', '· lotto {{numero}}', { numero: r.lotNumber })}</span>}
                      </div>
                      <div className="text-[13px] text-[var(--ds-text-muted)]">
                        {[
                          r.supplierName,
                          r.ddtNumber ? t('ddtInline', 'DDT {{numero}}', { numero: r.ddtNumber }) : null,
                          r.expiryDate ? t('expiryInline', 'scade {{giorno}}', { giorno: formatShortDate(r.expiryDate) }) : null,
                          r.temperature !== null ? `${formatNumber(r.temperature)} °C` : null,
                        ].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <StatusPill tone={r.accepted ? 'positive' : 'critical'}>{r.accepted ? t('accepted', 'Accettato') : t('rejected', 'Respinto')}</StatusPill>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader
              title={t('trace.usedIn', 'Usato nei processi')}
              icon={<Timer className="h-4 w-4" />}
              status={t('records', '{{count}} registrazioni', { count: result.production.length })}
            />
            {result.production.length === 0 ? (
              <p className={emptyNote}>{t('trace.noProcesses', 'Nessun processo.')}</p>
            ) : (
              <ul className={rowList}>
                {result.production.map(p => (
                  <li key={p.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
                    <span className="w-24 flex-shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">{formatLongDate(p.date)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-medium text-[var(--ds-text-primary)]">
                        {p.product}{p.internalLot && <span className="ml-1.5 text-[13px] tabular-nums text-[var(--ds-text-muted)]">{t('lotInline', '· lotto {{numero}}', { numero: p.internalLot })}</span>}
                      </div>
                      <div className="text-[13px] text-[var(--ds-text-muted)]">
                        {[processSummary(p, t), p.sourceLots ? t('sourceLotsInline', 'ingredienti {{lotti}}', { lotti: p.sourceLots }) : null].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <StatusPill>{processLabel((p.process ?? 'LEGACY') as HaccpProcess, t)}</StatusPill>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <RecallDialog
        open={recalling}
        prefill={q.trim()}
        result={result}
        onClose={() => setRecalling(false)}
        onCreated={() => { setRecalling(false); onRecallCreated?.(); }}
      />
    </div>
  );
};

const RecallDialog: React.FC<{
  open: boolean;
  prefill: string;
  result: HaccpTraceResult | null;
  onClose: () => void;
  onCreated: () => void;
}> = ({ open, prefill, result, onClose, onCreated }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [product, setProduct] = useState('');
  const [lot, setLot] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Si parte da quello che si stava cercando: il primo arrivo trovato dà
    // prodotto e lotto, che si correggono se serve.
    const first = result?.receipts[0];
    setProduct(first?.product ?? prefill);
    setLot(first?.lotNumber ?? '');
    setReason('');
    setBusy(false);
    setError(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const save = async () => {
    if (!product.trim()) { setError(t('trace.productRequired', 'Serve il prodotto.')); return; }
    if (!reason.trim()) { setError(t('trace.reasonRequired', 'Scrivi perché si richiama.')); return; }
    setBusy(true);
    setError(null);
    // Il testo va nel registro, che è in italiano qualunque sia la lingua
    // dell'interfaccia: è un documento per l'ASL, come il foglio stampato.
    const affected = result
      ? [
          ...result.receipts.map(r => `arrivo ${formatShortDate(r.date)}${r.supplierName ? ` da ${r.supplierName}` : ''}${r.ddtNumber ? ` (DDT ${r.ddtNumber})` : ''}`),
          ...result.production.map(p => `${HACCP_PROCESS_LABELS_IT[(p.process ?? 'LEGACY') as HaccpProcess].toLowerCase()} ${p.product} ${formatShortDate(p.date)}${p.internalLot ? ` lotto ${p.internalLot}` : ''}`),
        ].slice(0, 20).join('; ')
      : '';
    try {
      await haccpApiService.createNonConformity({
        date: todayISO(),
        source: 'RECALL',
        title: `Richiamo · ${product.trim()}${lot.trim() ? ` lotto ${lot.trim()}` : ''}`,
        detail: [reason.trim(), affected ? `Registrazioni coinvolte: ${affected}` : ''].filter(Boolean).join(' · '),
      });
      onCreated();
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title={t('trace.recallDialog', 'Avvia un richiamo')}
      size="sm"
      bodyClassName="px-5 py-5 sm:px-6"
      footer={
        <>
          <button type="button" className={dsButton.quiet} onClick={onClose} disabled={busy}>{t('cancel', 'Annulla')}</button>
          <button type="button" className={dsButton.primary} onClick={save} disabled={busy}>{t('trace.recallConfirm', 'Apri il richiamo')}</button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[14px] text-[var(--ds-text-muted)]">
          {t('trace.recallIntro', 'Il richiamo resta aperto fra le non conformità finché non scrivi cosa è stato ritirato e chi è stato avvisato.')}
        </p>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label htmlFor="haccp-recall-product" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('product', 'Prodotto')}</label>
            <input id="haccp-recall-product" value={product} onChange={e => setProduct(e.target.value)} className={dsInput} />
          </div>
          <div>
            <label htmlFor="haccp-recall-lot" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('lot', 'Lotto')}</label>
            <input id="haccp-recall-lot" value={lot} onChange={e => setLot(e.target.value)} className={`${dsInput} tabular-nums`} />
          </div>
        </div>
        <div>
          <label htmlFor="haccp-recall-reason" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('trace.why', 'Perché (avviso del fornitore, del Ministero, problema trovato)')}</label>
          <textarea id="haccp-recall-reason" rows={3} value={reason} onChange={e => setReason(e.target.value)} className={dsTextarea} />
        </div>
        {result && result.receipts.length + result.production.length > 0 && (
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            {t('trace.willAttach', 'Nel richiamo finiscono anche {{count}} registrazioni trovate dalla ricerca.', { count: result.receipts.length + result.production.length })}
          </p>
        )}
        {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
};
