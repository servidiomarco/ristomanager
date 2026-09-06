import React from 'react';
import type { OrderWithItems } from '../../types';
import {
  BAR_COURSE_NO, DESSERT_COURSE_NO, MAX_COURSES, cartForCourse, courseLabel, courseStatus, isSent, itemsForCourse, ordinal,
  type CartLine,
} from './orderView';

// ---------------------------------------------------------------------------
// La pista delle uscite sul palmare. Sostituisce il menu a tendina che c'era
// prima: sei bersagli da 44px battono una select, e soprattutto si vede quali
// uscite hanno già qualcosa dentro senza aprirle una per una.
//
// Il pallino dice «qui c'è roba», il verde dice «questa è già partita». Non è
// solo colore: il pallino c'è o non c'è, ed è quello a portare l'informazione
// (§4.3).
// ---------------------------------------------------------------------------

export const CourseChips: React.FC<{
  order: OrderWithItems;
  cart: CartLine[];
  course: number;
  onCourse: (next: number) => void;
  /** Pastiglia «Bar» in testa: c'è quando il ristorante ha categorie da bar
   *  (o quando l'uscita Bar ha già righe, comunque arrivate). */
  showBar?: boolean;
  /** Pastiglia «Dolci» in coda: stessa regola, per le categorie da dolci. */
  showDessert?: boolean;
}> = ({ order, cart, course, onCourse, showBar, showDessert }) => (
  // Margine negativo con padding uguale: lo scorrimento orizzontale ritaglia
  // anche in verticale, e senza questo l'ombra sotto le pastiglie esce tagliata.
  <div className="-my-1.5 flex gap-2 overflow-x-auto py-1.5 scrollbar-hide">
    {[
      ...(showBar || course === BAR_COURSE_NO
        || cartForCourse(cart, BAR_COURSE_NO).length > 0
        || itemsForCourse(order, BAR_COURSE_NO).length > 0
          ? [BAR_COURSE_NO] : []),
      ...Array.from({ length: MAX_COURSES }, (_, i) => i + 1),
      ...(showDessert || course === DESSERT_COURSE_NO
        || cartForCourse(cart, DESSERT_COURSE_NO).length > 0
        || itemsForCourse(order, DESSERT_COURSE_NO).length > 0
          ? [DESSERT_COURSE_NO] : []),
    ].map(n => {
      const active = n === course;
      const sent = isSent(courseStatus(order, n));
      const filled =
        cartForCourse(cart, n).length > 0 ||
        itemsForCourse(order, n).some(i => i.status !== 'VOIDED');
      return (
        <button
          key={n}
          type="button"
          onClick={() => onCourse(n)}
          aria-pressed={active}
          aria-label={courseLabel(n)}
          className={`inline-flex h-11 min-w-[64px] flex-shrink-0 items-center justify-center gap-1.5 rounded-full px-4 text-[16px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
            active
              ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
              : 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]'
          }`}
        >
          {ordinal(n)}
          {filled && (
            <span
              className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                sent ? 'bg-[var(--ds-seated-solid)]'
                : active ? 'bg-[var(--ds-action-fg)]'
                : 'bg-[var(--ds-text-muted)]'
              }`}
              aria-hidden
            />
          )}
        </button>
      );
    })}
  </div>
);
