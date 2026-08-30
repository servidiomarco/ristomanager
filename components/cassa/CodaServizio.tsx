import React from 'react';
import { ArrowRight, Banknote, Loader2, Wallet } from 'lucide-react';
import type { OpenBillRow } from '../../services/billsApiService';
import type { CashSessionView } from '../../types';
import {
  Callout, EmptyState, SectionHeader, StatStrip, StatusPill, type Stat,
} from '../ds';
import { QUEUE_PILL, euro, queueState, queueSubtitle, residualLabel, type Queue } from './cassaView';

/* ── Passo 1 · la coda del servizio ───────────────────────────────────────
   Il punto di partenza. Dice cosa costa soldi se resta dov'è, e apre l'unica
   azione di ingresso: scegliere un tavolo.

   L'ordine della pagina è deliberato — si legge dall'alto e la prima cosa che
   si incontra è quella che costa soldi. I conti di un servizio passato stanno
   in fondo, in grigio: vanno incassati, ma non sono il servizio di adesso. */

interface CodaServizioProps {
  queue: Queue;
  session: CashSessionView | null;
  tables: { busy: number; total: number };
  loading: boolean;
  error: string | null;
  /** Il conto su cui si sta lavorando: la riga mostra la rotella. */
  busyBillId: number | null;
  onSelectTable: () => void;
  onOpenBill: (bill: OpenBillRow) => void;
  onCollect: (bill: OpenBillRow) => void;
  onTransactions: () => void;
  onCashDrawer: () => void;
}

/** Una riga della coda: il tavolo a sinistra, quanto deve a destra, l'azione
 *  in fondo. L'importo è la cosa che si cerca, quindi non divide lo spazio
 *  con altro. */
const QueueRow: React.FC<{
  bill: OpenBillRow;
  busy: boolean;
  onOpen: () => void;
  onCollect: () => void;
}> = ({ bill, busy, onOpen, onCollect }) => {
  const state = queueState(bill);
  const pill = QUEUE_PILL[state];
  const past = state === 'past';

  return (
    // Zona selezionabile e azione sono fratelli, non annidati: un bottone
    // dentro un bottone è markup non valido e in Safari quello interno smette
    // di funzionare.
    <div
      className={`flex items-stretch gap-3 overflow-hidden rounded-[20px] ${
        past ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-pending-tint)]'
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 p-3 text-left transition-colors hover:bg-[var(--ds-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)] sm:p-4"
      >
        {/* Il numero del tavolo è l'identificatore: si cerca quello, non il
            nome dell'ospite. */}
        <span className="flex h-12 w-12 flex-shrink-0 flex-col items-center justify-center rounded-[14px] bg-[var(--ds-surface)] sm:h-14 sm:w-14">
          <span className="text-[17px] font-semibold leading-none tracking-[-0.01em] text-[var(--ds-text-primary)] sm:text-[19px]">
            {bill.table_name ?? '—'}
          </span>
          <span className="mt-0.5 text-[10px] text-[var(--ds-text-muted)]">Sala</span>
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-[16px] font-semibold text-[var(--ds-text-primary)] sm:text-[17px]">
              Tavolo {bill.table_name ?? '—'}
            </span>
            <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
          </span>
          <span className="mt-0.5 block truncate text-[13px] text-[var(--ds-text-muted)]">
            {queueSubtitle(bill)}
          </span>
        </span>

        <span className="flex-shrink-0 text-right">
          <span className="block text-[18px] font-semibold tabular-nums tracking-[-0.015em] text-[var(--ds-text-primary)] sm:text-[20px]">
            {euro(bill.residual_cents)}
          </span>
          <span className="block text-[12px] text-[var(--ds-text-muted)]">
            {residualLabel(bill)}
          </span>
        </span>
      </button>

      <div className="flex flex-shrink-0 items-center pr-3 sm:pr-4">
        <button
          type="button"
          onClick={past ? onOpen : onCollect}
          disabled={busy}
          className={`inline-flex h-11 min-w-[88px] items-center justify-center gap-2 rounded-full px-4 text-[15px] font-semibold transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
            past
              ? 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] hover:bg-[var(--ds-surface-row)]'
              : 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)]'
          }`}
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : null}
          {past ? 'Apri' : 'Incassa'}
        </button>
      </div>
    </div>
  );
};

/** Le due viste che non stanno nel percorso di un tavolo. */
const JumpCard: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex min-h-[56px] flex-1 items-center justify-between gap-3 rounded-[20px] bg-[var(--ds-surface)] px-4 text-left text-[15px] font-medium text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
  >
    {label}
    <ArrowRight size={18} className="flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
  </button>
);

export const CodaServizio: React.FC<CodaServizioProps> = ({
  queue, session, tables, loading, error, busyBillId,
  onSelectTable, onOpenBill, onCollect, onTransactions, onCashDrawer,
}) => {
  const conti = queue.current.length;
  // Il tono `pending` è tinto solo quando c'è davvero qualcosa da fare: uno
  // zero in ambra direbbe che manca un incasso che non manca.
  const stats: Stat[] = [
    {
      value: euro(session?.collected_cents ?? 0),
      label: 'incassato',
      tone: 'neutral',
    },
    {
      value: euro(queue.dueCents),
      label: conti === 1 ? 'da incassare · 1 conto' : `da incassare · ${conti} conti`,
      tone: queue.dueCents > 0 ? 'pending' : 'neutral',
      tint: queue.dueCents > 0,
    },
    {
      value: `${tables.busy}/${tables.total}`,
      label: 'tavoli in servizio',
      tone: 'neutral',
      hideBelow: 'sm',
    },
  ];

  const meta = queue.past.length > 0
    ? `${conti} nel servizio · ${queue.past.length} in un servizio passato`
    : conti === 1 ? '1 conto nel servizio' : `${conti} conti nel servizio`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Testata ferma, stesso guscio di Comande: il padding in basso vive qui
          e non sulla zona che scorre, o l'ombra dei chip verrebbe tagliata. */}
      <div className="mx-auto w-full max-w-[1400px] flex-shrink-0 px-4 pb-3 pt-4 lg:px-8 lg:pt-8">
        <h1 className="hidden text-[26px] font-semibold tracking-[-0.02em] text-[var(--ds-text-primary)] lg:block">
          Cassa
        </h1>

        <div className="flex flex-col gap-3 lg:mt-3 lg:flex-row lg:items-center">
          <StatStrip stats={stats} layout="stacked" className="min-w-0 flex-1" />
          {/* Fuori dallo strip: quello prende un onClick per segmento, non un
              bottone pieno — e questa è l'azione della pagina, non un numero. */}
          <button
            type="button"
            onClick={onSelectTable}
            className="inline-flex h-12 flex-shrink-0 items-center justify-center gap-2 rounded-full bg-[var(--ds-action-bg)] px-6 text-[16px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            Seleziona tavolo
          </button>
        </div>
      </div>

      <div className="mx-auto w-full min-h-0 max-w-[1400px] flex-1 overflow-y-auto px-4 pb-6 lg:px-8">
        {error && (
          <Callout tone="critical" className="mb-4">{error}</Callout>
        )}

        {loading && queue.current.length === 0 && queue.past.length === 0 ? (
          <div className="flex items-center gap-2 py-8 text-[14px] text-[var(--ds-text-muted)]">
            <Loader2 size={16} className="animate-spin" /> Carico i conti…
          </div>
        ) : queue.current.length === 0 && queue.past.length === 0 ? (
          <EmptyState
            icon={Wallet}
            action={
              <button
                type="button"
                onClick={onSelectTable}
                className="inline-flex h-11 items-center rounded-full bg-[var(--ds-surface)] px-5 text-[15px] font-medium text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] transition-colors hover:bg-[var(--ds-surface-row)]"
              >
                Vedi i tavoli in servizio
              </button>
            }
          >
            Nessun conto da incassare in questo servizio.
          </EmptyState>
        ) : (
          <>
            {queue.current.length > 0 && (
              <section>
                <SectionHeader tone="pending" meta={meta}>Da incassare</SectionHeader>
                <div className="mt-2 flex flex-col gap-3">
                  {queue.current.map(bill => (
                    <QueueRow
                      key={bill.id}
                      bill={bill}
                      busy={busyBillId === bill.id}
                      onOpen={() => onOpenBill(bill)}
                      onCollect={() => onCollect(bill)}
                    />
                  ))}
                </div>
              </section>
            )}

            {queue.past.length > 0 && (
              <section className="mt-5">
                <SectionHeader tone="muted" meta={String(queue.past.length)}>
                  Rimasti aperti
                </SectionHeader>
                <div className="mt-2 flex flex-col gap-3">
                  {queue.past.map(bill => (
                    <QueueRow
                      key={bill.id}
                      bill={bill}
                      busy={busyBillId === bill.id}
                      onOpen={() => onOpenBill(bill)}
                      onCollect={() => onCollect(bill)}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {/* Le viste fuori dal percorso di un tavolo. In fondo perché è lì che
            si va quando il servizio è finito, non mentre corre. */}
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <JumpCard label="Transazioni" onClick={onTransactions} />
          <JumpCard label="Fondo e chiusura" onClick={onCashDrawer} />
        </div>

        {session?.session?.closed_at && (
          <Callout tone="info" icon={Banknote} className="mt-4">
            La cassa di questo servizio è già stata chiusa.
          </Callout>
        )}
      </div>
    </div>
  );
};
