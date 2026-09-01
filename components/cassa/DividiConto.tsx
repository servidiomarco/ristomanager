import React, { useMemo, useState } from 'react';
import { ArrowLeft, Minus, Plus } from 'lucide-react';
import type { OpenBillRow } from '../../services/billsApiService';
import { Callout, StatusPill } from '../ds';
import { euro } from './cassaView';

/* ── Passo 4a · dividi conto ──────────────────────────────────────────────
   «Definisce quanto si paga adesso, non come.»

   Ed è letteralmente così, anche nel modello: per la cassa una quota NON è
   una riga nuova da qualche parte, è un incasso parziale sul conto — che il
   libro cassa registra già oggi (POST /bills/:id/payments lascia il conto
   OPEN finché il totale non è coperto). Persistere una «quota dello staff»
   accanto al movimento vorrebbe dire scrivere due volte lo stesso denaro.

   Le quote vere restano quelle degli ospiti, create dal QR: quelle si vedono
   qui perché spiegano perché il residuo è più basso, ma non si toccano — una
   quota prenotata da un telefono scade da sola.

   Per articolo non c'è: resta dal QR, lato ospite (docs/cassa-plan.md §12).
   Due piastrelle e non tre disabilitate — una terza spenta con una spiegazione
   accanto genera una telefonata, la sua assenza no. */

type Mode = 'equal' | 'amount';

interface DividiContoProps {
  bill: OpenBillRow;
  /** Il residuo corrente, già al netto di quello che è entrato. */
  residualCents: number;
  onBack: () => void;
  /** Porta l'importo scelto al pannello di incasso. */
  onUseAmount: (cents: number) => void;
}

export const DividiConto: React.FC<DividiContoProps> = ({
  bill, residualCents, onBack, onUseAmount,
}) => {
  const [mode, setMode] = useState<Mode>('equal');
  const [parts, setParts] = useState(Math.max(2, Math.min(bill.covers || 2, 12)));
  const [amount, setAmount] = useState('');

  // Si arrotonda per eccesso al centesimo: meglio che l'ultima quota sia più
  // piccola delle altre che lasciare un centesimo scoperto sul conto.
  const perPart = useMemo(
    () => (parts > 0 ? Math.min(residualCents, Math.ceil(residualCents / parts)) : residualCents),
    [residualCents, parts]
  );

  const typed = useMemo(() => {
    const n = parseFloat(amount.replace(/[^\d.,]/g, '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
  }, [amount]);

  const chosen = mode === 'equal' ? perPart : Math.min(typed, residualCents);
  const after = Math.max(0, residualCents - chosen);

  const deposit = bill.deposit_credit_cents ?? 0;
  const claimed = bill.claimed_cents ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mx-auto w-full max-w-[900px] flex-shrink-0 px-4 pb-3 pt-4 lg:px-8">
        <div className="flex items-center gap-3 rounded-[20px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
          <button
            type="button"
            onClick={onBack}
            aria-label="Torna al pagamento"
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-semibold text-[var(--ds-text-primary)]">Dividi conto</h1>
            <p className="truncate text-[13px] text-[var(--ds-text-muted)]">
              Tavolo {bill.table_name ?? '—'} · residuo {euro(residualCents)}
            </p>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full min-h-0 max-w-[900px] flex-1 space-y-4 overflow-y-auto px-4 pb-6 lg:px-8">
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setMode('equal')}
            className={`rounded-[20px] p-4 text-left transition-colors ${
              mode === 'equal'
                ? 'bg-[var(--ds-arriving-tint)] ring-2 ring-[var(--ds-arriving-solid)]'
                : 'bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] hover:bg-[var(--ds-surface-row)]'
            }`}
          >
            <div className="text-[16px] font-semibold text-[var(--ds-text-primary)]">In parti uguali</div>
            <div className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">scegli il numero di persone</div>
            <div className="mt-2 text-[13px] font-medium text-[var(--ds-arriving-text)]">
              {parts} quote da {euro(perPart)}
            </div>
          </button>

          <button
            type="button"
            onClick={() => setMode('amount')}
            className={`rounded-[20px] p-4 text-left transition-colors ${
              mode === 'amount'
                ? 'bg-[var(--ds-arriving-tint)] ring-2 ring-[var(--ds-arriving-solid)]'
                : 'bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] hover:bg-[var(--ds-surface-row)]'
            }`}
          >
            <div className="text-[16px] font-semibold text-[var(--ds-text-primary)]">Per importo</div>
            <div className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">quanto paga ora</div>
            <div className="mt-2 text-[13px] font-medium text-[var(--ds-arriving-text)]">
              es. {euro(Math.min(1000, residualCents))} su {euro(residualCents)}
            </div>
          </button>
        </div>

        <section className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
          {mode === 'equal' ? (
            <div className="flex items-center gap-3">
              <span className="text-[14px] text-[var(--ds-text-secondary)]">Persone</span>
              <div className="flex items-center gap-1 rounded-full bg-[var(--ds-surface-row)] px-2 py-1">
                <button
                  type="button"
                  onClick={() => setParts(p => Math.max(2, p - 1))}
                  disabled={parts <= 2}
                  aria-label="Una persona in meno"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
                >
                  <Minus size={14} />
                </button>
                <span className="min-w-[20px] text-center text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                  {parts}
                </span>
                <button
                  type="button"
                  onClick={() => setParts(p => Math.min(20, p + 1))}
                  aria-label="Una persona in più"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)]"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          ) : (
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">
                Quanto paga adesso
              </span>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[17px] text-[var(--ds-text-muted)]">€</span>
                <input
                  type="text" inputMode="decimal" value={amount} autoFocus
                  onChange={e => setAmount(e.target.value)}
                  placeholder={(residualCents / 100).toFixed(2)}
                  className="h-12 w-full rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface-2)] pl-8 pr-3 text-right text-[17px] tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)]"
                />
              </div>
            </label>
          )}

          <div className="mt-4 flex items-center justify-between gap-3 rounded-[14px] bg-[var(--ds-surface-row)] p-3">
            <div className="min-w-0">
              <div className="text-[15px] font-semibold text-[var(--ds-text-primary)]">
                Quota corrente · {euro(chosen)}
              </div>
              <div className="text-[13px] text-[var(--ds-text-muted)]">
                residuo dopo questa quota: {euro(after)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onUseAmount(chosen)}
              disabled={chosen <= 0}
              className="inline-flex h-11 flex-shrink-0 items-center rounded-full bg-[var(--ds-action-bg)] px-5 text-[15px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
            >
              Scegli metodo
            </button>
          </div>
        </section>

        {/* Quello che è già entrato, e perché il residuo è quello che è. Non si
            tocca da qui: una quota presa da un telefono la rilascia il tempo. */}
        {(deposit > 0 || claimed > 0 || bill.paid_splits > 0) && (
          <section className="space-y-2">
            <div className="text-[13px] font-semibold text-[var(--ds-text-muted)]">Quote di questo conto</div>
            {bill.paid_splits > 0 && (
              <div className="flex items-center justify-between gap-2 rounded-[14px] bg-[var(--ds-seated-tint)] px-3 py-2.5">
                <span className="min-w-0 truncate text-[14px] text-[var(--ds-seated-text)]">
                  {bill.paid_splits === 1 ? '1 quota pagata al tavolo col QR' : `${bill.paid_splits} quote pagate al tavolo col QR`}
                </span>
                <StatusPill tone="positive">bloccata</StatusPill>
              </div>
            )}
            {claimed > 0 && (
              <div className="flex items-center justify-between gap-2 rounded-[14px] bg-[var(--ds-pending-tint)] px-3 py-2.5">
                <span className="min-w-0 truncate text-[14px] text-[var(--ds-pending-text)]">
                  {euro(claimed)} prenotati dal telefono di un ospite
                </span>
                <StatusPill tone="pending">scade da sola</StatusPill>
              </div>
            )}
            {deposit > 0 && (
              // La caparra è una quota nel modello ma non è il claim di un
              // cliente: sta in fondo, come nota, non in mezzo alle altre.
              <div className="flex items-center justify-between gap-2 rounded-[14px] bg-[var(--ds-surface-row)] px-3 py-2.5">
                <span className="min-w-0 truncate text-[14px] text-[var(--ds-text-secondary)]">
                  Caparra della prenotazione
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-[14px] tabular-nums text-[var(--ds-text-secondary)]">{euro(deposit)}</span>
                  <StatusPill tone="neutral">a credito</StatusPill>
                </span>
              </div>
            )}
          </section>
        )}

        <Callout tone="info">
          Le quote degli ospiti si dividono anche per articolo, dal QR al tavolo.
        </Callout>
      </div>
    </div>
  );
};
