import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronDown, Loader2, Receipt } from 'lucide-react';
import type { CashMovement, CashTransactionsView } from '../../types';
import { timePart } from '../../utils/displayTime';
import { Callout, EmptyState, SearchField, SegmentedControl, StatusPill } from '../ds';
import { methodLabel } from '../pagamenti/settleView';
import { euro } from './cassaView';

/* ── Fuori flusso · transazioni ───────────────────────────────────────────
   Un solo libro: tutti i movimenti d'incasso del servizio.

   Caparre, omaggi, sospesi e storni ci sono ma restano FUORI dal totale
   incassato — sono denaro che il conto ha mosso senza entrare nel cassetto, e
   sommarli darebbe una cifra che non si trova contando. */

type Filter = 'all' | 'CONTANTI' | 'POS_FISICO' | 'online' | 'voided' | 'CAPARRA';

/* Le tre funzioni di modulo qui sotto ricevono `t` come parametro: sono
   pure, e una funzione non può chiamare un hook. */
type TFunc = (key: string, options?: Record<string, unknown>) => string;

const label = (m: CashMovement, tr: TFunc): string => {
  const base =
    m.source === 'deposit' ? tr('onlineDeposit')
    : m.online ? tr('qrAtTable')
    : methodLabel(m.method);
  // Il nome che l'ospite ha scritto pagando la sua quota: «QR al tavolo ·
  // Marco» dice subito chi era, senza aprire il conto.
  return m.claimant_label ? `${base} · ${m.claimant_label}` : base;
};

/** Cosa dire dello stato di una riga. «Conto aperto» e il documento fiscale
 *  non stanno qui: sono fatti del CONTO, e vivono sull'intestazione e sul
 *  piede del gruppo — ripeterli su ogni riga era rumore. */
const pill = (m: CashMovement): { label: string; tone: 'positive' | 'pending' | 'critical' | 'neutral' } | null => {
  if (m.voided) return { label: 'stornata', tone: 'critical' };
  if (m.source === 'deposit') return { label: 'caparra', tone: 'neutral' };
  if (m.online) return { label: 'online', tone: 'positive' };
  return null;
};

/** Il documento con cui il conto è stato chiuso, per il piede del gruppo.
 *  `token` presente = c'è la copia digitale su /scontrino/<token> (solo gli
 *  scontrini cloud ce l'hanno: la proforma non ha una pagina da aprire).
 *  Il piede parla anche quando il documento NON c'è: un conto chiuso senza
 *  riga fiscale lo dice, e un conto saldato dal QR ma mai chiuso pure —
 *  visto al collaudo: piede muto e nessuno sa se il fiscale è a posto. */
const groupDoc = (ms: CashMovement[], tr: TFunc): { label: string; tone: 'positive' | 'pending' | 'critical' | 'neutral'; token: string | null } | null => {
  // Solo le righe del conto portano i campi fiscali: un gruppo di sole
  // caparre non può dire niente sul documento, e sta zitto.
  const billRows = ms.filter(x => x.source === 'bill');
  if (billRows.length === 0) return null;
  const m = billRows.find(x => x.fiscal_doc_type != null) ?? billRows[0];
  if (!m.fiscal_doc_type) {
    const st = m.bill_status;
    if (st === 'CLOSED' || st === 'SETTLED_PARTIAL') return { label: tr('closedNoFiscal'), tone: 'neutral', token: null };
    if (st === 'SETTLED') return { label: tr('settledToClose'), tone: 'pending', token: null };
    return null;
  }
  const n = m.fiscal_doc_number ?? m.fiscal_ref;
  const name =
    m.fiscal_doc_type === 'RECEIPT' ? (n ? tr('docReceiptNo', { numero: n }) : tr('docReceipt'))
    : m.fiscal_doc_type === 'PROFORMA' ? tr('proforma')
    : m.fiscal_doc_type === 'INVOICE' ? (n ? tr('docInvoiceNo', { numero: n }) : tr('docInvoice'))
    : (n ? tr('docCreditNoteNo', { numero: n }) : tr('docCreditNote'));
  if (m.fiscal_status === 'FAILED') return { label: tr('docFailed', { documento: name }), tone: 'critical', token: null };
  if (m.fiscal_status === 'PENDING') return { label: tr('docPending', { documento: name }), tone: 'pending', token: null };
  if (m.fiscal_status === 'VOIDED') return { label: tr('docVoided', { documento: name }), tone: 'pending', token: null };
  return { label: name, tone: 'positive', token: m.fiscal_public_token ?? null };
};

/* Il cliente sta sull'intestazione del gruppo, non sulla riga: qui restano
   solo i fatti del singolo movimento. Vuoto = la seconda riga non si mostra. */
const rowSubtitle = (m: CashMovement, tr: TFunc): string => {
  if (m.voided) {
    const base = m.voided_by_name ? tr('voidedBy', { chi: m.voided_by_name }) : tr('voidedPlain');
    return m.void_reason ? tr('withReason', { testo: base, motivo: m.void_reason }) : base;
  }
  if (m.source === 'deposit') return tr('depositOutOfService');
  return m.recorded_by_name ?? '';
};

/* Quanto è ENTRATO dal conto: la cifra dell'intestazione. Storni, caparre,
   omaggi e sospesi restano fuori, con la stessa regola del totale in fondo —
   una cifra diversa non si ritroverebbe contando. */
const groupCollected = (ms: CashMovement[]): number =>
  ms.reduce((s, m) => (
    m.voided || m.source === 'deposit' || m.method === 'OMAGGIO' || m.method === 'SOSPESO'
      ? s : s + m.amount_cents
  ), 0);

interface TransazioniProps {
  data: CashTransactionsView | null;
  loading: boolean;
  error: string | null;
  onBack: () => void;
  onOpenBill: (billId: number) => void;
}

export const Transazioni: React.FC<TransazioniProps> = ({
  data, loading, error, onBack, onOpenBill,
}) => {
  const { t: tr } = useTranslation('cassa', { useSuspense: false });
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  // Le card partono chiuse: la lista dice tavolo, totale e documento a colpo
  // d'occhio, i singoli movimenti si aprono col tocco sull'intestazione.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (k: string) => setOpenGroups(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const movements = data?.movements ?? [];

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: movements.length };
    for (const m of movements) {
      if (m.voided) c.voided = (c.voided ?? 0) + 1;
      else if (m.source === 'deposit') c.CAPARRA = (c.CAPARRA ?? 0) + 1;
      else if (m.online) c.online = (c.online ?? 0) + 1;
      else c[m.method] = (c[m.method] ?? 0) + 1;
    }
    return c;
  }, [movements]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return movements.filter(m => {
      const passes =
        filter === 'all' ? true
        : filter === 'voided' ? m.voided
        : filter === 'CAPARRA' ? m.source === 'deposit'
        : filter === 'online' ? m.online && m.source !== 'deposit' && !m.voided
        : m.method === filter && !m.voided && !m.online;
      if (!passes) return false;
      if (!q) return true;
      return (
        (m.table_name ?? '').toLowerCase().includes(q)
        || (m.customer_name ?? '').toLowerCase().includes(q)
        || (m.claimant_label ?? '').toLowerCase().includes(q)
        || (m.amount_cents / 100).toFixed(2).includes(q)
      );
    });
  }, [movements, filter, query]);

  // Un gruppo per conto (in pratica: per tavolo — due conti sullo stesso
  // tavolo sono due visite, e vanno tenuti separati). L'elenco arriva già
  // in ordine di tempo discendente, quindi i gruppi escono ordinati per
  // movimento più recente e le righe dentro restano in ordine.
  const groups = useMemo(() => {
    const map = new Map<string, CashMovement[]>();
    for (const m of visible) {
      const k = m.bill_id != null ? `b${m.bill_id}` : `m${m.id}`;
      const arr = map.get(k);
      if (arr) arr.push(m); else map.set(k, [m]);
    }
    return [...map.values()];
  }, [visible]);

  const options = [
    { value: 'all' as Filter, label: tr('all'), badge: counts.all ?? 0, badgeTone: 'neutral' as const },
    { value: 'CONTANTI' as Filter, label: tr('cash'), badge: counts.CONTANTI ?? 0, badgeTone: 'neutral' as const },
    { value: 'POS_FISICO' as Filter, label: 'POS', badge: counts.POS_FISICO ?? 0, badgeTone: 'neutral' as const },
    { value: 'online' as Filter, label: tr('online'), badge: counts.online ?? 0, badgeTone: 'neutral' as const },
    { value: 'voided' as Filter, label: tr('voidedTab'), badge: counts.voided ?? 0, badgeTone: 'neutral' as const },
    { value: 'CAPARRA' as Filter, label: tr('deposits'), badge: counts.CAPARRA ?? 0, badgeTone: 'neutral' as const },
  ];

  const t = data?.totals;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mx-auto w-full max-w-[1100px] flex-shrink-0 px-4 pb-3 pt-4 lg:px-8">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label={tr('backToQueue')}
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-[var(--ds-text-primary)] lg:text-[26px]">
            {tr('transactions')}
          </h1>
        </div>

        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={tr('searchTransactions')}
          ariaLabel={tr('searchMovement')}
          className="mt-3 w-full"
        />

        <div className="mt-3">
          <SegmentedControl<Filter>
            value={filter}
            onChange={setFilter}
            options={options}
            ariaLabel={tr('filterMovements')}
            equalWidth={false}
            overflow="scroll"
          />
        </div>
      </div>

      <div className="mx-auto w-full min-h-0 max-w-[1100px] flex-1 overflow-y-auto px-4 pb-6 lg:px-8">
        {error && <Callout tone="critical" className="mb-3">{error}</Callout>}

        {loading && movements.length === 0 ? (
          <div className="flex items-center gap-2 py-8 text-[14px] text-[var(--ds-text-muted)]">
            <Loader2 size={16} className="animate-spin" /> {tr('loadingMovements')}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState icon={Receipt}>
            {query.trim() || filter !== 'all'
              ? tr('noMovementByFilter')
              : tr('noMovementInService')}
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-2.5">
            {groups.map(g => {
              const head = g[0];
              const collected = groupCollected(g);
              const billOpen = head.bill_status === 'OPEN' || head.bill_status === 'LOCKED';
              const doc = groupDoc(g, tr);
              const key = head.bill_id != null ? `b${head.bill_id}` : `m${head.id}`;
              const expanded = openGroups.has(key);
              return (
                <div
                  key={key}
                  className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]"
                >
                  {/* L'intestazione apre/chiude la card; il conto si apre
                      dalle righe dentro. */}
                  <button
                    type="button"
                    onClick={() => toggleGroup(key)}
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-3 px-3 pb-2 pt-3 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
                        {tr('tableNamed', { nome: head.table_name ?? '—' })}
                      </span>
                      <span className="block truncate text-[12px] text-[var(--ds-text-muted)]">
                        {head.customer_name ?? tr('walkIn')} · {tr('movementCount', { count: g.length })}
                      </span>
                    </span>
                    {billOpen && <StatusPill tone="neutral">{tr('billOpen')}</StatusPill>}
                    <span className="w-24 flex-shrink-0 text-right text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                      {euro(collected)}
                    </span>
                    <ChevronDown
                      size={16}
                      aria-hidden
                      className={`flex-shrink-0 text-[var(--ds-text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {expanded && (
                  <div className="border-t border-[var(--ds-border)]">
                    {g.map(m => {
                      const p = pill(m);
                      const sub = rowSubtitle(m, tr);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => onOpenBill(m.bill_id)}
                          className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)] [&+button]:border-t [&+button]:border-[var(--ds-border)] ${
                            m.voided ? 'bg-[var(--ds-critical-tint)]' : ''
                          }`}
                        >
                          <span className="w-12 flex-shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                            {timePart(m.at)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={`block truncate text-[14px] font-medium ${
                              m.voided ? 'text-[var(--ds-critical-text)] line-through' : 'text-[var(--ds-text-primary)]'
                            }`}>
                              {label(m, tr)}
                            </span>
                            {sub && (
                              <span className="block truncate text-[12px] text-[var(--ds-text-muted)]">
                                {sub}
                              </span>
                            )}
                          </span>
                          {p && <StatusPill tone={p.tone}>{p.label}</StatusPill>}
                          <span className={`w-24 flex-shrink-0 text-right text-[14px] font-semibold tabular-nums ${
                            m.voided ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-secondary)]'
                          }`}>
                            {m.voided ? '−' : ''}{euro(m.amount_cents)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  )}
                  {/* Il documento con cui il conto è stato chiuso: fatto del
                      conto, quindi una volta sola, in piede — visibile anche
                      a card chiusa. Col token c'è la copia digitale — si
                      apre in un'altra scheda, la lista resta dov'è. */}
                  {doc && (
                    doc.token ? (
                      <a
                        href={`/scontrino/${doc.token}`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-2 border-t border-[var(--ds-border)] px-3 py-2 text-[13px] font-medium text-[var(--ds-seated-text)] transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)]"
                      >
                        <Receipt size={14} aria-hidden /> {doc.label} · apri
                      </a>
                    ) : (
                      <span className={`flex items-center gap-2 border-t border-[var(--ds-border)] px-3 py-2 text-[13px] ${
                        doc.tone === 'critical' ? 'text-[var(--ds-critical-text)]'
                        : doc.tone === 'pending' ? 'text-[var(--ds-pending-text)]'
                        : doc.tone === 'positive' ? 'font-medium text-[var(--ds-seated-text)]'
                        : 'text-[var(--ds-text-muted)]'
                      }`}>
                        <Receipt size={14} aria-hidden /> {doc.label}
                      </span>
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}

        {t && (
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] px-4 py-3 text-[13px] text-[var(--ds-text-secondary)]">
            <span>{tr('totalsLine', { movimenti: tr('movementCount', { count: t.movements }), mostrati: visible.length, tavoli: tr('tableCount', { count: groups.length }) })}</span>
            <span>{tr('collected')} <strong className="tabular-nums text-[var(--ds-text-primary)]">{euro(t.collected_cents)}</strong></span>
            {t.voided_cents > 0 && <span>{tr('voidedTab')} <strong className="tabular-nums">{euro(t.voided_cents)}</strong></span>}
            {t.omaggio_cents > 0 && <span>{tr('freebie')} <strong className="tabular-nums">{euro(t.omaggio_cents)}</strong></span>}
            {t.sospeso_cents > 0 && <span>{tr('onAccount')} <strong className="tabular-nums">{euro(t.sospeso_cents)}</strong></span>}
            {t.deposits_cents > 0 && <span>{tr('deposits')} <strong className="tabular-nums">{euro(t.deposits_cents)}</strong></span>}
          </div>
        )}
      </div>
    </div>
  );
};
