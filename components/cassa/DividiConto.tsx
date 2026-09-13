import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Minus, Plus } from 'lucide-react';
import type { OpenBillRow } from '../../services/billsApiService';
import { StatusPill } from '../ds';
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

   «Per piatti» segue lo stesso modello: la spunta dei piatti è solo la
   calcolatrice della quota — niente claim persistito, l'importo arriva al
   pannello come ogni altra quota. Vale la stessa regola del QR: righe che
   quadrano col totale, altrimenti la piastrella non c'è (con uno sconto in
   mezzo, pagare «la propria riga» addebiterebbe più del dovuto) — una
   piastrella spenta con una spiegazione accanto genera una telefonata, la
   sua assenza no. */

type Mode = 'equal' | 'amount' | 'items';

interface DividiContoProps {
  bill: OpenBillRow;
  /** Il residuo corrente, già al netto di quello che è entrato. */
  residualCents: number;
  onBack: () => void;
  /** Porta l'importo scelto al pannello di incasso; per la quota «per piatti»
   *  anche le unità spuntate, che l'incasso ricorda in meta.item_units. */
  onUseAmount: (cents: number, itemUnits?: { order_item_id: number; units: number }[]) => void;
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

  // Per piatti: la stessa regola del QR — serve il dettaglio righe e la somma
  // deve quadrare col totale (uno sconto sul conto la fa divergere).
  const items = useMemo(() => bill.items ?? [], [bill.items]);
  const itemsSum = useMemo(
    () => items.reduce((n, i) => n + i.unit_price_cents * i.qty, 0),
    [items]
  );
  const perItemAvailable = items.length > 0 && itemsSum === bill.total_cents;
  // Unità già coperte per riga (quote dal QR e incassi «per piatti»
  // precedenti): quelle non si ripropongono.
  const takenOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of bill.item_taken_units ?? []) m.set(t.order_item_id, t.units);
    return (it: { qty: number; order_item_id?: number }) =>
      Math.min(it.qty, it.order_item_id != null ? (m.get(it.order_item_id) ?? 0) : 0);
  }, [bill.item_taken_units]);
  // Unità scelte per riga (una riga da 3 coperti si prende anche a metà:
  // «due dei quattro caffè li paga lui»). Il conto ricaricato azzera la
  // scelta: il residuo è cambiato sotto, meglio ripartire che sbagliare.
  const [picked, setPicked] = useState<number[]>(() => items.map(() => 0));
  useEffect(() => { setPicked(items.map(() => 0)); }, [items]);
  const pickedSum = items.reduce((n, i, ix) => n + (picked[ix] ?? 0) * i.unit_price_cents, 0);
  const pickedCount = picked.reduce((n, u) => n + u, 0);
  const bump = (ix: number, delta: number) => setPicked(p =>
    p.map((u, i) => i === ix ? Math.max(0, Math.min(items[ix].qty - takenOf(items[ix]), u + delta)) : u));
  const toggleRow = (ix: number) => setPicked(p =>
    p.map((u, i) => i === ix ? (u > 0 ? 0 : items[ix].qty - takenOf(items[ix])) : u));
  // La spunta viaggia con l'incasso solo se copre esattamente l'importo: se
  // il residuo la taglia, non si sa più quali piatti sono davvero coperti.
  const pickedUnits = pickedSum <= residualCents
    ? items.flatMap((it, ix) => (picked[ix] ?? 0) > 0 && it.order_item_id != null
        ? [{ order_item_id: it.order_item_id, units: picked[ix] }] : [])
    : [];

  const chosen = mode === 'equal' ? perPart
    : mode === 'amount' ? Math.min(typed, residualCents)
    : Math.min(pickedSum, residualCents);
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
        <div className={`grid gap-3 ${perItemAvailable ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
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

          {perItemAvailable && (
            <button
              type="button"
              onClick={() => setMode('items')}
              className={`rounded-[20px] p-4 text-left transition-colors ${
                mode === 'items'
                  ? 'bg-[var(--ds-arriving-tint)] ring-2 ring-[var(--ds-arriving-solid)]'
                  : 'bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] hover:bg-[var(--ds-surface-row)]'
              }`}
            >
              <div className="text-[16px] font-semibold text-[var(--ds-text-primary)]">Per piatti</div>
              <div className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">spunta cosa ha preso</div>
              <div className="mt-2 text-[13px] font-medium text-[var(--ds-arriving-text)]">
                {pickedCount > 0
                  ? `${pickedCount} ${pickedCount === 1 ? 'piatto' : 'piatti'} · ${euro(pickedSum)}`
                  : 'come dal QR al tavolo'}
              </div>
            </button>
          )}
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
          ) : mode === 'items' ? (
            <div className="space-y-1.5">
              {items.map((it, ix) => {
                const units = picked[ix] ?? 0;
                const taken = takenOf(it);
                const remaining = it.qty - taken;
                if (remaining <= 0) {
                  return (
                    <div key={ix} className="flex min-h-[44px] items-center gap-3 rounded-[14px] bg-[var(--ds-surface-row)] px-3 py-1.5 opacity-60">
                      <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-border-strong)] text-white">
                        <Check size={12} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium text-[var(--ds-text-secondary)]">
                          {it.qty > 1 ? `${it.qty}× ` : ''}{it.name}
                        </span>
                        <span className="block text-[12px] text-[var(--ds-text-muted)]">già pagata</span>
                      </span>
                      <span className="flex-shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                        {euro(it.unit_price_cents * it.qty)}
                      </span>
                    </div>
                  );
                }
                return (
                  <div
                    key={ix}
                    className={`flex items-center gap-2 rounded-[14px] px-3 py-1.5 transition-colors ${
                      units > 0 ? 'bg-[var(--ds-arriving-tint)]' : 'bg-[var(--ds-surface-row)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleRow(ix)}
                      className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span
                        className={`inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ${
                          units > 0
                            ? 'bg-[var(--ds-arriving-solid)] text-white'
                            : 'border border-[var(--ds-border-strong)]'
                        }`}
                      >
                        {units > 0 && <Check size={12} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium text-[var(--ds-text-primary)]">
                          {remaining > 1 ? `${remaining}× ` : ''}{it.name}
                        </span>
                        <span className="block text-[12px] tabular-nums text-[var(--ds-text-muted)]">
                          {euro(it.unit_price_cents)}{remaining > 1 ? ' l’uno' : ''}{taken > 0 ? ` · ${taken} già ${taken === 1 ? 'pagato' : 'pagati'}` : ''}
                        </span>
                      </span>
                    </button>
                    {remaining > 1 && (
                      <div className="flex flex-shrink-0 items-center gap-1 rounded-full bg-[var(--ds-surface)] px-1.5 py-1">
                        <button
                          type="button"
                          onClick={() => bump(ix, -1)}
                          disabled={units <= 0}
                          aria-label={`Un ${it.name} in meno`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
                        >
                          <Minus size={14} />
                        </button>
                        <span className="min-w-[34px] text-center text-[13px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                          {units}/{remaining}
                        </span>
                        <button
                          type="button"
                          onClick={() => bump(ix, 1)}
                          disabled={units >= remaining}
                          aria-label={`Un ${it.name} in più`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
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
              onClick={() => onUseAmount(chosen, mode === 'items' && pickedUnits.length > 0 ? pickedUnits : undefined)}
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
      </div>
    </div>
  );
};
