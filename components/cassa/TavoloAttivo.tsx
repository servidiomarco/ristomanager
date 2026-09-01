import React, { useMemo, useState } from 'react';
import { ArrowLeft, Loader2, Minus, Plus, Users } from 'lucide-react';
import type { Dish, OrderItem, OrderWithItems, Reservation } from '../../types';
import { Callout, StatusPill, useMediaQuery } from '../ds';
import { DishBrowser } from '../comande/DishBrowser';
import {
  cartSum, euro, isSystemLine, type CartLine,
} from '../comande/orderView';

/* ── Passo 3 · tavolo attivo ──────────────────────────────────────────────
   Il menu a sinistra, la comanda a destra. Le righe inviate e le bozze restano
   due cose distinte, perché la differenza fra modificare e stornare è una sola
   domanda: la cucina l'ha già vista?

   Niente menu `•••` sulle righe (docs/cassa-plan.md §10). Con lo sconto di
   riga fuori dall'MVP resterebbe una voce sola, e un menu che ne nasconde una
   insegna a non aprire i menu:

     - bozza   → stepper, e il «−» a quantità 1 toglie la riga: la cucina non
                 l'ha vista, sparisce senza lasciare traccia;
     - inviata → «Storna», che chiede una motivazione (la route la pretende, e
                 quel testo è anche il messaggio che ferma la cucina).

   Le bozze pesano sul totale, ma non arrivano mai al pagamento: il primario
   diventa «Invia e vai al pagamento» finché ce n'è una. Non si incassa una
   riga che la cucina non ha visto — il piatto non arriverebbe — e così il
   totale a schermo, la proforma e il documento fiscale non possono divergere. */

interface TavoloAttivoProps {
  tableName: string;
  reservation: Reservation | null;
  order: OrderWithItems;
  cart: CartLine[];
  dishes: Dish[];
  categories: string[];
  category: string | null;
  onCategory: (next: string) => void;
  query: string;
  onQuery: (next: string) => void;
  hasVariants: (dishId: number) => boolean;
  busy: boolean;
  error: string | null;
  serviceLabel: string;
  onBack: () => void;
  onAddDish: (dish: Dish) => void;
  onRemoveDish: (dish: Dish) => void;
  onVariants: (dish: Dish) => void;
  onCartQty: (key: string, delta: number) => void;
  onVoidItem: (item: OrderItem) => void;
  onCovers: (delta: number) => void;
  onDiscount: () => void;
  onCustomer: () => void;
  /** Manda in cucina le bozze e va al pagamento; senza bozze va e basta. */
  onGoToPayment: () => void;
  /** Il lavoro di uscite e lanci resta di Comande: scorciatoia, non copia. */
  onOpenInComande?: () => void;
}

const Row: React.FC<{
  label: React.ReactNode;
  sub?: React.ReactNode;
  amount: string;
  tone?: 'normal' | 'voided' | 'draft';
  action?: React.ReactNode;
}> = ({ label, sub, amount, tone = 'normal', action }) => (
  <div
    className={`flex items-center gap-2 rounded-[14px] px-3 py-2 ${
      tone === 'voided' ? 'bg-[var(--ds-critical-tint)]'
      : tone === 'draft' ? 'bg-[var(--ds-arriving-tint)]'
      : 'bg-[var(--ds-surface-row)]'
    }`}
  >
    <div className="min-w-0 flex-1">
      <div className={`truncate text-[14px] ${
        tone === 'voided' ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-primary)]'
      }`}>
        {label}
      </div>
      {sub && <div className="truncate text-[12px] text-[var(--ds-text-muted)]">{sub}</div>}
    </div>
    <span className={`flex-shrink-0 text-[14px] font-medium tabular-nums ${
      tone === 'voided' ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-primary)]'
    }`}>
      {amount}
    </span>
    {action}
  </div>
);

export const TavoloAttivo: React.FC<TavoloAttivoProps> = ({
  tableName, reservation, order, cart, dishes, categories, category, onCategory,
  query, onQuery, hasVariants, busy, error, serviceLabel, onBack,
  onAddDish, onRemoveDish, onVariants, onCartQty, onVoidItem, onCovers,
  onDiscount, onCustomer, onGoToPayment, onOpenInComande,
}) => {
  const isWide = useMediaQuery('(min-width: 1024px)');
  const [comandaOpen, setComandaOpen] = useState(false);

  const sent = useMemo(
    () => order.items.filter(i => !isSystemLine(i)),
    [order.items]
  );
  const systemLines = useMemo(
    () => order.items.filter(isSystemLine),
    [order.items]
  );

  const draftCents = cartSum(cart);
  // Il totale del server non conosce le bozze, che stanno solo qui finché non
  // si invia: si somma a mano, ed è la stessa cifra che il tavolo pagherebbe
  // se tutto arrivasse.
  const totalCents = order.total_cents + draftCents;
  const hasDrafts = cart.length > 0;
  const isEmpty = sent.length === 0 && !hasDrafts;

  const qtyInCourse = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of cart) m.set(l.dish.id, (m.get(l.dish.id) ?? 0) + l.qty);
    return m;
  }, [cart]);

  const markedCategories = useMemo(
    () => new Set(cart.map(l => l.dish.category).filter(Boolean) as string[]),
    [cart]
  );

  const comanda = (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-[var(--ds-text-primary)]">Comanda</h2>
        <span className="text-[12px] text-[var(--ds-text-muted)]">
          {isEmpty ? 'nuova' : `${sent.length + cart.length} righe`}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {isEmpty && (
          <div className="rounded-[14px] bg-[var(--ds-surface-row)] px-3 py-6 text-center text-[13px] text-[var(--ds-text-muted)]">
            Ancora niente su questo tavolo. Scegli dal menu: le righe restano in
            bozza finché non le invii.
          </div>
        )}

        {sent.length > 0 && (
          <section className="space-y-1.5">
            <div className="text-[12px] font-semibold text-[var(--ds-text-muted)]">Inviati</div>
            {sent.map(item => {
              const voided = item.status === 'VOIDED';
              return (
                <Row
                  key={item.id}
                  tone={voided ? 'voided' : 'normal'}
                  label={`${item.qty} × ${item.name_snapshot}`}
                  sub={voided ? `stornata · ${item.void_reason ?? ''}` : item.note ?? undefined}
                  amount={voided ? `−${euro(item.line_total_cents ?? 0)}` : euro(item.line_total_cents ?? 0)}
                  action={!voided && (
                    <button
                      type="button"
                      onClick={() => onVoidItem(item)}
                      disabled={busy}
                      className="flex-shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-[var(--ds-critical-text)] transition-colors hover:bg-[var(--ds-critical-tint)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                    >
                      Storna
                    </button>
                  )}
                />
              );
            })}
          </section>
        )}

        {hasDrafts && (
          <section className="space-y-1.5">
            <div className="text-[12px] font-semibold text-[var(--ds-arriving-text)]">Da inviare</div>
            {cart.map(line => (
              <Row
                key={line.key}
                tone="draft"
                label={line.dish.name}
                sub={line.modifier_labels.join(' · ') || line.note || undefined}
                amount={euro(cartSum([line]))}
                action={
                  // Il «−» a quantità 1 toglie la riga: nessuna conferma,
                  // perché non c'è niente da annullare — la cucina non l'ha vista.
                  <span className="flex flex-shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onCartQty(line.key, -1)}
                      disabled={busy}
                      aria-label={line.qty === 1 ? 'Togli la riga' : 'Una in meno'}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40"
                    >
                      <Minus size={14} />
                    </button>
                    <span className="w-5 text-center text-[14px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                      {line.qty}
                    </span>
                    <button
                      type="button"
                      onClick={() => onCartQty(line.key, 1)}
                      disabled={busy}
                      aria-label="Una in più"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40"
                    >
                      <Plus size={14} />
                    </button>
                  </span>
                }
              />
            ))}
          </section>
        )}

        {/* Coperto e servizio, ricalcolati dal server a ogni mutazione.
            DA DECIDERE (vedi docs/cassa-plan.md §13): syncSystemLinesInTx
            inserisce il coperto appena `covers > 0`, senza guardare se c'è una
            riga DISH — quindi un tavolo appena aperto mostra già un totale pur
            non avendo ordinato niente. La funzione è condivisa con Comande e
            in questa tranche non si tocca. */}
        {systemLines.length > 0 && (
          <section className="space-y-1.5 border-t border-[var(--ds-border)] pt-3">
            {systemLines.map(item => (
              <div key={item.id} className="flex items-center justify-between gap-2 px-1 text-[13px]">
                <span className="truncate text-[var(--ds-text-secondary)]">
                  {item.name_snapshot}
                  {item.line_kind === 'COVER' && ` × ${item.qty}`}
                  <span className="ml-1 text-[var(--ds-text-muted)]">automatico</span>
                </span>
                <span className="flex-shrink-0 tabular-nums text-[var(--ds-text-secondary)]">
                  {euro(item.line_total_cents ?? 0)}
                </span>
              </div>
            ))}
            {order.discount_cents > 0 && (
              <div className="flex items-center justify-between gap-2 px-1 text-[13px]">
                <span className="text-[var(--ds-critical-text)]">Sconto conto</span>
                <span className="flex-shrink-0 tabular-nums text-[var(--ds-critical-text)]">
                  −{euro(order.discount_cents)}
                </span>
              </div>
            )}
          </section>
        )}
      </div>

      <div className="flex-shrink-0 space-y-3 border-t border-[var(--ds-border)] pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[17px] font-semibold text-[var(--ds-text-primary)]">Totale</span>
          <span className="text-[26px] font-semibold tabular-nums tracking-[-0.02em] text-[var(--ds-text-primary)]">
            {euro(totalCents)}
          </span>
        </div>

        <button
          type="button"
          onClick={onDiscount}
          disabled={busy}
          className="inline-flex h-9 items-center rounded-full bg-[var(--ds-surface-row)] px-3.5 text-[13px] font-medium text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
        >
          Sconto conto
        </button>

        {onOpenInComande && (
          <button
            type="button"
            onClick={onOpenInComande}
            disabled={busy}
            className="inline-flex h-9 items-center rounded-full bg-[var(--ds-surface-row)] px-3.5 text-[13px] font-medium text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
          >
            Apri in Comande
          </button>
        )}

        {error && <Callout tone="critical">{error}</Callout>}

        <button
          type="button"
          onClick={onGoToPayment}
          disabled={busy || isEmpty}
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ds-action-bg)] text-[16px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          {hasDrafts ? 'Invia e vai al pagamento' : 'Vai al pagamento'}
        </button>
        {isEmpty && (
          <p className="text-center text-[12px] text-[var(--ds-text-muted)]">
            Si attiva alla prima riga.
          </p>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Testata */}
      {/* Sotto lg la testata dell'app è nascosta (immersive): questa scheda è
          la prima in cima e il padding rispetta il notch dove c'è. */}
      <div className="mx-auto w-full max-w-[1600px] flex-shrink-0 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] lg:px-8">
        <div className="flex items-center gap-3 rounded-[20px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
          <button
            type="button"
            onClick={onBack}
            aria-label="Torna indietro"
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
              Tavolo {tableName}
            </h1>
            <p className="truncate text-[13px] text-[var(--ds-text-muted)]">{serviceLabel}</p>
          </div>

          <button
            type="button"
            onClick={onCustomer}
            className="hidden max-w-[220px] flex-shrink-0 items-center gap-2 rounded-full bg-[var(--ds-arriving-tint)] px-3 py-1.5 text-[13px] font-medium text-[var(--ds-arriving-text)] transition-colors hover:brightness-95 sm:inline-flex"
          >
            <span className="truncate">
              {reservation?.customer_name ?? 'Associa cliente'}
            </span>
          </button>

          {/* Neutro, non ambra: i coperti sono un fatto, e l'ambra nel design
              system vuol dire «chiede un'azione». */}
          <div className="flex flex-shrink-0 items-center gap-1 rounded-full bg-[var(--ds-surface-row)] px-2 py-1">
            <Users size={14} className="text-[var(--ds-text-muted)]" aria-hidden />
            <button
              type="button"
              onClick={() => onCovers(-1)}
              disabled={busy || order.order.covers <= 1}
              aria-label="Un coperto in meno"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
            >
              <Minus size={13} />
            </button>
            <span className="min-w-[16px] text-center text-[14px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
              {order.order.covers}
            </span>
            <button
              type="button"
              onClick={() => onCovers(1)}
              disabled={busy}
              aria-label="Un coperto in più"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
            >
              <Plus size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* Corpo. Su schermo largo menu e comanda stanno affiancati; sul telefono
          la comanda è dietro il totale in fondo. È una differenza di albero,
          non di stile, quindi la sceglie useMediaQuery (regola 13). */}
      <div className="mx-auto flex w-full min-h-0 max-w-[1600px] flex-1 gap-4 px-4 pb-4 lg:px-8">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DishBrowser
            dishes={dishes}
            categories={categories}
            category={category}
            onCategory={onCategory}
            query={query}
            onQuery={onQuery}
            qtyInCourse={qtyInCourse}
            markedCategories={markedCategories}
            hasVariants={hasVariants}
            onAdd={onAddDish}
            onRemove={onRemoveDish}
            onLongPress={onVariants}
            layout={isWide ? 'grid' : 'list'}
          />
        </div>

        {isWide && (
          <aside className="flex w-[380px] flex-shrink-0 flex-col rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)] xl:w-[420px]">
            {comanda}
          </aside>
        )}
      </div>

      {/* Sul telefono: la barra col totale, e la comanda dietro. */}
      {!isWide && (
        <>
          <div className="flex-shrink-0 border-t border-[var(--ds-border)] bg-[var(--ds-surface)] px-4 py-3">
            <button
              type="button"
              onClick={() => setComandaOpen(true)}
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <span className="text-[13px] text-[var(--ds-text-muted)]">
                Comanda · {sent.length + cart.length} righe
                {hasDrafts && <StatusPill tone="info" className="ml-2">da inviare</StatusPill>}
              </span>
              <span className="text-[22px] font-semibold tabular-nums tracking-[-0.015em] text-[var(--ds-text-primary)]">
                {euro(totalCents)}
              </span>
            </button>
          </div>
          {comandaOpen && (
            <div className="fixed inset-0 z-50 flex flex-col bg-[var(--ds-canvas)] p-4" role="dialog" aria-modal="true">
              <button
                type="button"
                onClick={() => setComandaOpen(false)}
                className="mb-3 self-start rounded-full bg-[var(--ds-surface-row)] px-4 py-2 text-[14px] font-medium text-[var(--ds-text-primary)]"
              >
                Chiudi
              </button>
              <div className="min-h-0 flex-1 rounded-[20px] bg-[var(--ds-surface)] p-4">{comanda}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
