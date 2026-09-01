import React from 'react';
import { Ban, ChevronUp, Loader2, Minus, Plus, Send, SendHorizontal, Trash2 } from 'lucide-react';
import type { OrderItem, OrderWithItems } from '../../types';
import { StatusPill } from '../ds';
import {
  COURSE_BADGE, MAX_COURSES, cartForCourse, cartSum, cartUnitCents, courseLabel,
  courseStatus, euro, isSent, itemsForCourse, rowCount, rowCountLabel,
  type CartLine,
  isSystemLine,
} from './orderView';

// ---------------------------------------------------------------------------
// La comanda come la legge il passe: sei uscite in colonna, quella che si sta
// componendo cerchiata, quelle già partite con lo stato scritto in chiaro.
//
// Su desktop è la colonna di destra, sempre a schermo accanto al menu. Sul
// palmare è il contenuto del foglio «Comanda». La stessa lista, perché è la
// stessa domanda: cosa ho su questo tavolo.
// ---------------------------------------------------------------------------

interface CourseListProps {
  order: OrderWithItems;
  cart: CartLine[];
  course: number;
  onCourse: (next: number) => void;
  busy: boolean;
  onBump: (key: string, delta: number) => void;
  onDrop: (key: string) => void;
  /** Una riga già in cucina non si cancella: si storna, con motivazione. */
  onVoid: (item: OrderItem) => void;
  onRecall: (courseNo: number) => void;
  /** Lancia in cucina un'uscita proposta (QUEUED): il verbo del cameriere
   *  nei ristoranti dove i tempi li batte la sala, non il passe. Assente =
   *  il bottone non compare (il lancio resta del passe). */
  onFire?: (courseNo: number) => void;
}

const stepper =
  'inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

export const CourseList: React.FC<CourseListProps> = ({
  order, cart, course, onCourse, busy, onBump, onDrop, onVoid, onRecall, onFire,
}) => (
  <div className="flex flex-col gap-2">
    {Array.from({ length: MAX_COURSES }, (_, i) => i + 1).map(n => {
      const serverRows = itemsForCourse(order, n);
      const draftRows = cartForCourse(cart, n);
      const status = courseStatus(order, n);
      const sent = isSent(status);
      const current = n === course;
      const badge = COURSE_BADGE[status];

      if (serverRows.length === 0 && draftRows.length === 0 && !current) {
        // L'uscita vuota resta un bersaglio: portarci sopra il prossimo piatto
        // deve costare un tocco, non un menu.
        return (
          <button
            key={n}
            type="button"
            onClick={() => onCourse(n)}
            className="flex min-h-[52px] w-full items-center gap-2 rounded-[16px] border border-dashed border-[var(--ds-border-strong)] px-4 text-left text-[15px] text-[var(--ds-text-muted)] transition-colors hover:border-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <Plus size={16} aria-hidden /> {courseLabel(n)}
          </button>
        );
      }

      return (
        <section
          key={n}
          className={`rounded-[16px] p-3 ${
            sent ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)]'
          } ${current ? 'ring-2 ring-[var(--ds-action-bg)]' : ''}`}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onCourse(n)}
              aria-pressed={current}
              className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {courseLabel(n)}
            </button>
            {sent && <StatusPill tone={badge.tone}>{badge.text}</StatusPill>}
            {!sent && serverRows.length > 0 && (
              <StatusPill tone="pending">da inviare</StatusPill>
            )}
            {status === 'QUEUED' && (
              <>
                {onFire && (
                  <button
                    type="button"
                    onClick={() => onFire(n)}
                    disabled={busy}
                    title="Lancia l'uscita in cucina adesso"
                    className="flex-shrink-0 rounded-full bg-[var(--ds-action-bg)] px-3.5 py-1.5 text-[13px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
                  >
                    Chiama
                  </button>
                )}
                {/* Mai più «richiama» accanto a «Chiama»: quasi la stessa
                    parola, significato opposto — un tocco sbagliato ha
                    riportato in bozza un'uscita che si credeva lanciata. */}
                <button
                  type="button"
                  onClick={() => onRecall(n)}
                  disabled={busy}
                  title="Annulla la proposta: l'uscita torna in bozza, la cucina non la vede"
                  className="flex-shrink-0 text-[13px] font-medium text-[var(--ds-text-muted)] underline decoration-dotted transition-opacity hover:opacity-70 disabled:opacity-40"
                >
                  torna in bozza
                </button>
              </>
            )}
          </div>

          {(serverRows.length > 0 || draftRows.length > 0) && (
            <div className="mt-2 flex flex-col gap-1">
              {serverRows.map(i => (
                <div key={i.id} className="flex items-center gap-2 text-[15px]">
                  <span className="flex-shrink-0 text-[14px] font-semibold tabular-nums text-[var(--ds-text-muted)]">
                    {i.qty}×
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      i.status === 'VOIDED'
                        ? 'text-[var(--ds-text-muted)] line-through'
                        : 'text-[var(--ds-text-primary)]'
                    }`}
                  >
                    {i.name_snapshot}
                    {((i.modifiers && i.modifiers.length > 0) || i.note) && (
                      <span className="text-[13px] text-[var(--ds-text-muted)]">
                        {' · '}{[...(i.modifiers ?? []).map(m => m.name), ...(i.note ? [i.note] : [])].join(', ')}
                      </span>
                    )}
                  </span>
                  <span className="flex-shrink-0 text-[14px] tabular-nums text-[var(--ds-text-muted)]">
                    {euro(i.line_total_cents ?? 0)}
                  </span>
                  {i.status !== 'VOIDED' && i.line_kind === 'DISH' && (
                    <button
                      type="button"
                      onClick={() => onVoid(i)}
                      aria-label={`Storna ${i.name_snapshot}`}
                      title="Storna"
                      className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-critical-text)] transition-colors hover:bg-[var(--ds-critical-tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                    >
                      <Ban size={15} />
                    </button>
                  )}
                </div>
              ))}

              {draftRows.map(l => (
                <div key={l.key} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] text-[var(--ds-text-primary)]">
                      {l.dish.name}
                    </div>
                    {(l.modifier_labels.length > 0 || l.note) && (
                      <div className="truncate text-[13px] text-[var(--ds-text-muted)]">
                        ↳ {[...l.modifier_labels, ...(l.note ? [l.note] : [])].join(', ')}
                      </div>
                    )}
                  </div>
                  <span className="flex-shrink-0 text-[14px] tabular-nums text-[var(--ds-text-muted)]">
                    {euro(cartUnitCents(l) * l.qty)}
                  </span>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onBump(l.key, -1)}
                      aria-label={`Uno in meno di ${l.dish.name}`}
                      className={stepper}
                    >
                      <Minus size={15} />
                    </button>
                    <span className="w-6 text-center text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                      {l.qty}
                    </span>
                    <button
                      type="button"
                      onClick={() => onBump(l.key, +1)}
                      aria-label={`Uno in più di ${l.dish.name}`}
                      className={stepper}
                    >
                      <Plus size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDrop(l.key)}
                      aria-label={`Togli ${l.dish.name}`}
                      className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-critical-text)] transition-colors hover:bg-[var(--ds-critical-tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {current && serverRows.length === 0 && draftRows.length === 0 && (
            <p className="mt-2 rounded-[12px] bg-[var(--ds-surface-row)] px-4 py-6 text-center text-[14px] text-[var(--ds-text-muted)]">
              Tocca un piatto per iniziare.
            </p>
          )}
        </section>
      );
    })}
  </div>
);

/* ── SendFooter ───────────────────────────────────────────────────────────
   Due azioni, e la differenza fra loro è tutto il senso delle uscite: «Invia»
   manda in cucina soltanto quella che si sta componendo, «Invia tutto» manda
   ogni bozza che c'è sulla comanda. La seconda compare solo quando esistono
   bozze fuori dall'uscita corrente — altrimenti è lo stesso bottone due volte. */
interface SendFooterProps {
  course: number;
  courseCount: number;
  courseTotal: number;
  allCount: number;
  allTotal: number;
  busy: boolean;
  onSend: () => void;
  onSendAll: () => void;
  /** Sul palmare l'etichetta è anche la maniglia della comanda: non c'è una
   *  seconda colonna, e questo è il posto dove la mano è già appoggiata. */
  onExpand?: () => void;
}

export const SendFooter: React.FC<SendFooterProps> = ({
  course, courseCount, courseTotal, allCount, allTotal, busy, onSend, onSendAll, onExpand,
}) => (
  <div className="flex flex-col gap-1.5">
    {/* Sul palmare la comanda è un foglio ripiegato qui sotto, e lo dice la
        maniglia — la stessa dei fogli aperti. Ad aprirla è lei più tutta la
        zona del totale: la sola freccetta era un bersaglio da 14px per
        un'azione che si fa col pollice a fine giro. */}
    {onExpand && (
      <button
        type="button"
        onClick={onExpand}
        aria-label="Apri la comanda"
        className="-mt-1.5 flex justify-center rounded-full py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      >
        <span className="h-1 w-9 rounded-full bg-[var(--ds-border-strong)]" aria-hidden />
      </button>
    )}
    <div className="flex items-center gap-3">
      {onExpand ? (
        <button
          type="button"
          onClick={onExpand}
          className="-my-1.5 -ml-1.5 min-w-0 flex-1 rounded-[14px] p-1.5 text-left transition-colors hover:bg-[var(--ds-surface-row)] active:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          <span className="flex items-center gap-1.5 text-[13px] text-[var(--ds-text-muted)]">
            <span className="truncate">{courseLabel(course)} · da inviare</span>
            <ChevronUp size={15} className="flex-shrink-0" aria-hidden />
          </span>
          <span className="block text-[22px] font-semibold tabular-nums tracking-[-0.015em] text-[var(--ds-text-primary)]">
            {euro(courseTotal)}
          </span>
        </button>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-[var(--ds-text-muted)]">
            Da inviare · {courseLabel(course)}
          </div>
          <div className="text-[22px] font-semibold tabular-nums tracking-[-0.015em] text-[var(--ds-text-primary)]">
            {euro(courseTotal)}
          </div>
        </div>
      )}
      {/* Non «INVIA»: il maiuscolo non aggiunge peso che il corpo e il
          grassetto non diano già, e si legge peggio (§5.2). */}
      <button
        type="button"
        onClick={onSend}
        disabled={busy || courseCount === 0}
        className="inline-flex h-12 flex-shrink-0 items-center gap-2 rounded-full bg-[var(--ds-action-bg)] px-6 text-[17px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
        Invia
      </button>
    </div>
    {allCount > courseCount && (
      <button
        type="button"
        onClick={onSendAll}
        disabled={busy}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-[var(--ds-surface)] text-[15px] font-medium text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      >
        <SendHorizontal size={16} aria-hidden />
        Invia tutto · {euro(allTotal)}
      </button>
    )}
  </div>
);

/* ── CourseColumn ─────────────────────────────────────────────────────────
   La colonna di destra su desktop: intestazione, lista che scorre, azioni in
   fondo. Il padding in basso dell'intestazione è portante — sotto c'è una zona
   che scorre e dipinge dopo, e senza quel margine coprirebbe l'ombra. */
interface CourseColumnProps extends CourseListProps {
  onSend: () => void;
  onSendAll: () => void;
}

export const CourseColumn: React.FC<CourseColumnProps> = ({ onSend, onSendAll, ...list }) => {
  const { order, cart, course } = list;
  const courseLines = cartForCourse(cart, course);
  const rows = rowCount(order, cart);
  // Le righe rimaste in bozza SUL SERVER (uscita tornata in bozza, invio
  // interrotto) contano come «da inviare»: senza, il footer resta a zero e
  // l'uscita è irrecuperabile dal palmare (successo al tavolo 40).
  const isServerDraft = (i: OrderItem) => i.status === 'DRAFT' && !isSystemLine(i);
  const serverCourseQty = order.items.reduce((s, i) => s + (isServerDraft(i) && i.course_no === course ? i.qty : 0), 0);
  const serverCourseTotal = order.items.reduce((s, i) => s + (isServerDraft(i) && i.course_no === course ? i.qty * i.unit_price_cents : 0), 0);
  const serverAllQty = order.items.reduce((s, i) => s + (isServerDraft(i) ? i.qty : 0), 0);
  const serverAllTotal = order.items.reduce((s, i) => s + (isServerDraft(i) ? i.qty * i.unit_price_cents : 0), 0);
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--ds-border)] px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
          Comanda
        </h2>
        <span className="flex-shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
          {rows === 0 ? 'vuota' : rowCountLabel(rows)}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--ds-canvas)] p-3">
        <CourseList {...list} />
      </div>
      <div className="flex-shrink-0 border-t border-[var(--ds-border)] p-3">
        <SendFooter
          course={course}
          courseCount={courseLines.reduce((s, l) => s + l.qty, 0) + serverCourseQty}
          courseTotal={cartSum(courseLines) + serverCourseTotal}
          allCount={cart.reduce((s, l) => s + l.qty, 0) + serverAllQty}
          allTotal={cartSum(cart) + serverAllTotal}
          busy={list.busy}
          onSend={onSend}
          onSendAll={onSendAll}
        />
      </div>
    </div>
  );
};
