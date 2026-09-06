import React, { useMemo, useState } from 'react';
import { RefreshCw, UtensilsCrossed } from 'lucide-react';
import type { Dish, OrderItem, OrderWithItems } from '../../types';
import { EmptyState, SectionHeader, Sheet, SegmentedControl } from '../ds';
import { CourseList, SendFooter } from './CourseColumn';
import {
  cartForCourse, cartSum, courseLabel, euro, groupByCategory, isSystemLine, ordinal,
  repeatLines, repeatQty, repeatTotal, rowCount, rowCountLabel,
  type CartLine, type RepeatLine,
} from './orderView';

// ---------------------------------------------------------------------------
// La comanda sul palmare. Sul telefono non c'è una seconda colonna, quindi la
// comanda vive dietro il totale in fondo allo schermo: si apre, si guarda, si
// richiude.
//
// Due letture, perché sono due domande diverse. «Per uscita» è la comanda come
// la vede la cucina. «Tutto il tavolo» è cosa ha ordinato questa gente, sommato
// attraverso le uscite: è da lì che si fa il secondo giro senza ricontare a
// memoria quanti antipasti erano.
// ---------------------------------------------------------------------------

type SheetTab = 'course' | 'table';

interface ComandaSheetProps {
  open: boolean;
  onClose: () => void;
  order: OrderWithItems;
  cart: CartLine[];
  dishes: Dish[];
  categories: string[];
  course: number;
  onCourse: (next: number) => void;
  busy: boolean;
  onBump: (key: string, delta: number) => void;
  onDrop: (key: string) => void;
  onVoid: (item: OrderItem) => void;
  onRecall: (courseNo: number) => void;
  onFire?: (courseNo: number) => void;
  onEditLine?: (line: CartLine) => void;
  onUnfire?: (courseNo: number) => void;
  onMoveLine?: (line: CartLine) => void;
  onMoveItem?: (item: OrderItem) => void;
  onMoveCourse?: (courseNo: number) => void;
  onDragLine?: (key: string, to: number) => void;
  onDragItem?: (item: OrderItem, to: number) => void;
  onDragCourse?: (from: number, to: number) => void;
  /** «di Luca» / «dalla cassa» quando la comanda l'ha aperta qualcun altro. */
  openedBy?: string | null;
  onSend: () => void;
  onSendAll: () => void;
  onRepeat: (line: RepeatLine, qty: number) => void;
  onRepeatAll: (lines: RepeatLine[]) => void;
  /** Sezione «Bar» in testa alla lista uscite (categorie da bar attive). */
  showBar?: boolean;
  /** Sezione «Dolci» in coda (categorie da dolci attive). */
  showDessert?: boolean;
}

export const ComandaSheet: React.FC<ComandaSheetProps> = ({
  open, onClose, order, cart, dishes, categories, course, onCourse, busy,
  onBump, onDrop, onVoid, onRecall, onFire, onEditLine, onUnfire, onMoveLine, onMoveItem, onMoveCourse,
  onDragLine, onDragItem, onDragCourse,
  openedBy, onSend, onSendAll, onRepeat, onRepeatAll, showBar, showDessert,
}) => {
  const [tab, setTab] = useState<SheetTab>('course');

  const lines = useMemo(() => repeatLines(order, cart, dishes), [order, cart, dishes]);
  const groups = useMemo(() => groupByCategory(lines, categories), [lines, categories]);
  const courseLines = cartForCourse(cart, course);
  const rows = rowCount(order, cart);

  // Le bozze rimaste SUL SERVER (uscita tornata in bozza, invio interrotto)
  // contano come «da inviare» anche qui: è il TERZO footer con lo stesso
  // dovere — palmare e colonna erano già stati sistemati (tavolo 40), questo
  // dentro il foglio no, e a carrello vuoto l'Invia restava disabilitato con
  // la pill «da inviare» a vista (successo di nuovo al 40, 3ª uscita).
  const isServerDraft = (i: OrderItem) => i.status === 'DRAFT' && !isSystemLine(i);
  const serverCourseQty = order.items.reduce((s, i) => s + (isServerDraft(i) && i.course_no === course ? i.qty : 0), 0);
  const serverCourseTotal = order.items.reduce((s, i) => s + (isServerDraft(i) && i.course_no === course ? i.qty * i.unit_price_cents : 0), 0);
  const serverAllQty = order.items.reduce((s, i) => s + (isServerDraft(i) ? i.qty : 0), 0);
  const serverAllTotal = order.items.reduce((s, i) => s + (isServerDraft(i) ? i.qty * i.unit_price_cents : 0), 0);

  const footer = tab === 'course' ? (
    <SendFooter
      course={course}
      courseCount={courseLines.reduce((s, l) => s + l.qty, 0) + serverCourseQty}
      courseTotal={cartSum(courseLines) + serverCourseTotal}
      allCount={cart.reduce((s, l) => s + l.qty, 0) + serverAllQty}
      allTotal={cartSum(cart) + serverAllTotal}
      busy={busy}
      onSend={onSend}
      onSendAll={onSendAll}
    />
  ) : lines.length > 0 ? (
    <>
      <div>
        <div className="text-[13px] text-[var(--ds-text-muted)]">
          {repeatQty(lines)} {repeatQty(lines) === 1 ? 'piatto ordinato' : 'piatti ordinati'} dal tavolo
        </div>
        <div className="text-[22px] font-semibold tabular-nums tracking-[-0.015em] text-[var(--ds-text-primary)]">
          {euro(repeatTotal(lines))}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onRepeatAll(lines)}
        disabled={busy || lines.every(l => l.dish === null)}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ds-action-bg)] px-5 text-[16px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      >
        <RefreshCw size={17} aria-hidden />
        Ripeti tutto nella {ordinal(course)} uscita
      </button>
    </>
  ) : undefined;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={openedBy ? `Comanda ${openedBy}` : 'Comanda'}
      subtitle={rows === 0 ? 'vuota' : rowCountLabel(rows)}
      ariaLabel="Comanda del tavolo"
      bodyClassName="px-4 py-4"
      footer={footer}
      subheader={
        <SegmentedControl<SheetTab>
          value={tab}
          onChange={setTab}
          ariaLabel="Come leggere la comanda"
          options={[
            { value: 'course', label: 'Per uscita' },
            { value: 'table', label: 'Tutto il tavolo' },
          ]}
        />
      }
    >
      {tab === 'course' ? (
        <CourseList
          showBar={showBar}
          showDessert={showDessert}
          order={order}
          cart={cart}
          course={course}
          onCourse={onCourse}
          busy={busy}
          onBump={onBump}
          onDrop={onDrop}
          onVoid={onVoid}
          onRecall={onRecall}
          onFire={onFire}
          onEditLine={onEditLine}
          onUnfire={onUnfire}
          onMoveLine={onMoveLine}
          onMoveItem={onMoveItem}
          onMoveCourse={onMoveCourse}
          onDragLine={onDragLine}
          onDragItem={onDragItem}
          onDragCourse={onDragCourse}
        />
      ) : lines.length === 0 ? (
        <EmptyState icon={UtensilsCrossed}>Il tavolo non ha ancora ordinato niente.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(g => (
            <section key={g.category}>
              <SectionHeader>{g.category}</SectionHeader>
              <div className="mt-1 flex flex-col gap-2">
                {g.lines.map(l => (
                  <div
                    key={l.key}
                    className="flex items-center gap-3 rounded-[16px] bg-[var(--ds-surface)] px-3 py-2.5 shadow-[var(--ds-shadow-card)]"
                  >
                    <span className="w-8 flex-shrink-0 text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                      {l.qty}×
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
                        {l.name}
                      </div>
                      {/* Dove è già uscito e quanto costa il singolo: le due
                          cose che servono per decidere se rifarlo. */}
                      <div className="truncate text-[13px] text-[var(--ds-text-muted)]">
                        {l.courses.map(ordinal).join(' · ')} uscita
                        {l.modifier_labels.length > 0 && ` · ${l.modifier_labels.join(', ')}`}
                        {' · '}{euro(l.unit_cents)} cad.
                      </div>
                    </div>
                    <span className="flex-shrink-0 text-[15px] tabular-nums text-[var(--ds-text-muted)]">
                      {euro(l.unit_cents * l.qty)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRepeat(l, l.qty)}
                      disabled={busy || l.dish === null}
                      title={l.dish === null ? 'Il piatto non è più a menu' : undefined}
                      aria-label={`Ripeti ${l.qty}× ${l.name} nella ${courseLabel(course)}`}
                      className="inline-flex h-11 flex-shrink-0 items-center gap-1 rounded-full bg-[var(--ds-surface)] px-3 text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                    >
                      + {l.qty}×
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Sheet>
  );
};
