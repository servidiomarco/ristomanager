import React, { useMemo, useState } from 'react';
import { ArrowLeft, Loader2, Receipt } from 'lucide-react';
import type { CashMovement, CashTransactionsView } from '../../types';
import { getRomeTimePart } from '../../utils/reservationTime';
import { Callout, EmptyState, SearchField, SegmentedControl, StatusPill } from '../ds';
import { methodLabel } from '../pagamenti/settleView';
import { euro } from './cassaView';

/* ── Fuori flusso · transazioni ───────────────────────────────────────────
   Un solo libro: tutti i movimenti d'incasso del servizio.

   Caparre, omaggi, sospesi e storni ci sono ma restano FUORI dal totale
   incassato — sono denaro che il conto ha mosso senza entrare nel cassetto, e
   sommarli darebbe una cifra che non si trova contando. */

type Filter = 'all' | 'CONTANTI' | 'POS_FISICO' | 'online' | 'voided' | 'CAPARRA';

const label = (m: CashMovement): string =>
  m.source === 'deposit' ? 'Caparra online'
  : m.online ? 'QR al tavolo'
  : methodLabel(m.method);

/** Cosa dire dello stato di una riga. Il documento fiscale è un binario a
 *  parte: se è fallito lo dice, e non chiama «fallito» il pagamento.
 *  «Conto aperto» non sta qui: è un fatto del conto, e vive sull'intestazione
 *  del gruppo. */
const pill = (m: CashMovement): { label: string; tone: 'positive' | 'pending' | 'critical' | 'neutral' } | null => {
  if (m.voided) return { label: 'stornata', tone: 'critical' };
  if (m.source === 'deposit') return { label: 'caparra', tone: 'neutral' };
  if (m.fiscal_status === 'FAILED') return { label: 'da verificare fiscale', tone: 'pending' };
  if (m.fiscal_status === 'CONFIRMED' && m.fiscal_doc_type === 'RECEIPT') {
    return { label: 'scontrino emesso', tone: 'positive' };
  }
  if (m.online) return { label: 'online', tone: 'positive' };
  return null;
};

/* Il cliente sta sull'intestazione del gruppo, non sulla riga: qui restano
   solo i fatti del singolo movimento. Vuoto = la seconda riga non si mostra. */
const rowSubtitle = (m: CashMovement): string => {
  if (m.voided) return `Stornata${m.voided_by_name ? ` da ${m.voided_by_name}` : ''}${m.void_reason ? ` · ${m.void_reason}` : ''}`;
  if (m.source === 'deposit') return 'incassata alla prenotazione · fuori dagli incassi del servizio';
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
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

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
    { value: 'all' as Filter, label: 'Tutti', badge: counts.all ?? 0, badgeTone: 'neutral' as const },
    { value: 'CONTANTI' as Filter, label: 'Contanti', badge: counts.CONTANTI ?? 0, badgeTone: 'neutral' as const },
    { value: 'POS_FISICO' as Filter, label: 'POS', badge: counts.POS_FISICO ?? 0, badgeTone: 'neutral' as const },
    { value: 'online' as Filter, label: 'Online', badge: counts.online ?? 0, badgeTone: 'neutral' as const },
    { value: 'voided' as Filter, label: 'Stornati', badge: counts.voided ?? 0, badgeTone: 'neutral' as const },
    { value: 'CAPARRA' as Filter, label: 'Caparre', badge: counts.CAPARRA ?? 0, badgeTone: 'neutral' as const },
  ];

  const t = data?.totals;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mx-auto w-full max-w-[1100px] flex-shrink-0 px-4 pb-3 pt-4 lg:px-8">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Torna alla coda"
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-[var(--ds-text-primary)] lg:text-[26px]">
            Transazioni
          </h1>
        </div>

        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Tavolo, importo o cliente…"
          ariaLabel="Cerca un movimento"
          className="mt-3 w-full"
        />

        <div className="mt-3">
          <SegmentedControl<Filter>
            value={filter}
            onChange={setFilter}
            options={options}
            ariaLabel="Filtra i movimenti"
            equalWidth={false}
            overflow="scroll"
          />
        </div>
      </div>

      <div className="mx-auto w-full min-h-0 max-w-[1100px] flex-1 overflow-y-auto px-4 pb-6 lg:px-8">
        {error && <Callout tone="critical" className="mb-3">{error}</Callout>}

        {loading && movements.length === 0 ? (
          <div className="flex items-center gap-2 py-8 text-[14px] text-[var(--ds-text-muted)]">
            <Loader2 size={16} className="animate-spin" /> Carico i movimenti…
          </div>
        ) : visible.length === 0 ? (
          <EmptyState icon={Receipt}>
            {query.trim() || filter !== 'all'
              ? 'Nessun movimento con questi criteri.'
              : 'Nessun movimento in questo servizio.'}
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-2.5">
            {groups.map(g => {
              const head = g[0];
              const collected = groupCollected(g);
              const billOpen = head.bill_status === 'OPEN' || head.bill_status === 'LOCKED';
              return (
                <div
                  key={head.bill_id != null ? `b${head.bill_id}` : `m${head.id}`}
                  className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]"
                >
                  <button
                    type="button"
                    onClick={() => onOpenBill(head.bill_id)}
                    className="flex w-full items-center gap-3 px-3 pb-2 pt-3 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
                        Tavolo {head.table_name ?? '—'}
                      </span>
                      <span className="block truncate text-[12px] text-[var(--ds-text-muted)]">
                        {head.customer_name ?? 'Walk-in'}
                      </span>
                    </span>
                    {billOpen && <StatusPill tone="neutral">conto aperto</StatusPill>}
                    <span className="w-24 flex-shrink-0 text-right text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                      {euro(collected)}
                    </span>
                  </button>
                  <div className="border-t border-[var(--ds-border)]">
                    {g.map(m => {
                      const p = pill(m);
                      const sub = rowSubtitle(m);
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
                            {getRomeTimePart(m.at)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={`block truncate text-[14px] font-medium ${
                              m.voided ? 'text-[var(--ds-critical-text)] line-through' : 'text-[var(--ds-text-primary)]'
                            }`}>
                              {label(m)}
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
                </div>
              );
            })}
          </div>
        )}

        {t && (
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] px-4 py-3 text-[13px] text-[var(--ds-text-secondary)]">
            <span>{t.movements} movimenti · {visible.length} mostrati · {groups.length} tavol{groups.length === 1 ? 'o' : 'i'}</span>
            <span>Incassati <strong className="tabular-nums text-[var(--ds-text-primary)]">{euro(t.collected_cents)}</strong></span>
            {t.voided_cents > 0 && <span>Stornati <strong className="tabular-nums">{euro(t.voided_cents)}</strong></span>}
            {t.omaggio_cents > 0 && <span>Omaggio <strong className="tabular-nums">{euro(t.omaggio_cents)}</strong></span>}
            {t.sospeso_cents > 0 && <span>Sospeso <strong className="tabular-nums">{euro(t.sospeso_cents)}</strong></span>}
            {t.deposits_cents > 0 && <span>Caparre <strong className="tabular-nums">{euro(t.deposits_cents)}</strong></span>}
          </div>
        )}
      </div>
    </div>
  );
};
