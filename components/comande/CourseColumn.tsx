import React from 'react';
import { Ban, Check, ChevronUp, ChevronsUpDown, Loader2, Plus, Send, SendHorizontal } from 'lucide-react';
import { CourseChips } from './CourseChips';
import type { OrderItem, OrderWithItems } from '../../types';
import { StatusPill } from '../ds';
import {
  BAR_COURSE_NO,
  DESSERT_COURSE_NO,
  courseBadge, MAX_COURSES, cartForCourse, cartSum, cartUnitCents, courseLabel,
  courseStatus, euro, isSent, itemsForCourse, rowCount, rowCountLabel, weightLabel,
  type CartLine,
  isSystemLine,
} from './orderView';
import { useCourseDrag, type DragPayload } from './useCourseDrag';

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
  /** Apre il foglio varianti su una riga in bozza: si leggono tutte
   *  (le lunghe si troncano in lista) e si correggono prima dell'invio. */
  onEditLine?: (line: CartLine) => void;
  /** Annulla la chiamata di un'uscita già lanciata (finché la cucina non
   *  ha iniziato): torna in coda, le card spariscono dai monitor. */
  onUnfire?: (courseNo: number) => void;
  /** Sposta una riga in bozza su un'altra uscita («gli antipasti li
   *  prendiamo in prima»). Solo bozze: oltre l'invio si richiama o storna. */
  onMoveLine?: (line: CartLine) => void;
  /** Come sopra, per una bozza rimasta sul server. */
  onMoveItem?: (item: OrderItem) => void;
  /** Sposta TUTTE le bozze dell'uscita su un'altra. */
  onMoveCourse?: (courseNo: number) => void;
  /** Il drop del trascinamento: stesse operazioni del selettore, via gesto.
   *  Due maniglie con due icone APPOSTA diverse (collaudo al telefono: due
   *  icone uguali si confondevano): il ⇅ in fondo alla riga muove la riga,
   *  la ⇕ a cavallo dell'angolo in alto a sinistra muove l'uscita intera.
   *  Tocco secco = selettore, tenuto e mosso = drag. */
  onDragLine?: (key: string, to: number) => void;
  onDragItem?: (item: OrderItem, to: number) => void;
  onDragCourse?: (from: number, to: number) => void;
  /** Sezione «Bar» in testa alla comanda: c'è quando il ristorante ha
   *  categorie da bar, o quando l'uscita Bar ha già righe. */
  showBar?: boolean;
  /** Sezione «Dolci» in coda: stessa regola, per le categorie da dolci. */
  showDessert?: boolean;
}

export const CourseList: React.FC<CourseListProps> = ({
  order, cart, course, onCourse, busy, onBump, onDrop, onVoid, onRecall, onFire, onEditLine, onUnfire,
  onMoveLine, onMoveItem, onMoveCourse, onDragLine, onDragItem, onDragCourse, showBar, showDessert,
}) => {
  const dnd = useCourseDrag({
    disabled: busy,
    canDropOn: n => !isSent(courseStatus(order, n)),
    onDrop: (p: DragPayload, to: number) => {
      if (p.kind === 'line') onDragLine?.(p.key, to);
      else if (p.kind === 'item') onDragItem?.(p.item, to);
      else onDragCourse?.(p.from, to);
    },
    // Tenuto e rilasciato senza trascinare: il selettore modale — la via a
    // tocco che prima stava sulle maniglie ⇅.
    onHoldTap: (p: DragPayload) => {
      if (p.kind === 'line') { const l = cart.find(x => x.key === p.key); if (l) onMoveLine?.(l); }
      else if (p.kind === 'item') onMoveItem?.(p.item);
    },
  });
  // Maniglia solo se il drop ha un gestore: senza, il bottone resta il
  // bottone di sempre.
  const grip = (p: DragPayload) => {
    const wired = p.kind === 'line' ? !!onDragLine : p.kind === 'item' ? !!onDragItem : !!onDragCourse;
    return wired ? dnd.handleProps(p) : {};
  };
  // La presa da riga (tocco lungo, useCourseDrag.rowProps): sostituisce le
  // maniglie ⇅ per riga, che partivano da sole durante lo scroll.
  const rowGrip = (p: DragPayload) => {
    const wired = p.kind === 'line' ? !!(onDragLine || onMoveLine) : p.kind === 'item' ? !!(onDragItem || onMoveItem) : false;
    return wired ? dnd.rowProps(p) : {};
  };

  // Il Bar sta in testa: le bibite escono prima degli antipasti. I Dolci in
  // coda: escono per ultimi. Le sezioni compaiono anche senza flag quando
  // l'uscita ha righe (comunque arrivate).
  const courseNos = [
    ...(showBar || course === BAR_COURSE_NO
      || itemsForCourse(order, BAR_COURSE_NO).length > 0
      || cartForCourse(cart, BAR_COURSE_NO).length > 0
        ? [BAR_COURSE_NO] : []),
    ...Array.from({ length: MAX_COURSES }, (_, i) => i + 1),
    ...(showDessert || course === DESSERT_COURSE_NO
      || itemsForCourse(order, DESSERT_COURSE_NO).length > 0
      || cartForCourse(cart, DESSERT_COURSE_NO).length > 0
        ? [DESSERT_COURSE_NO] : []),
  ];
  return (
  <div className="flex flex-col gap-5 pt-4">
    {courseNos.map(n => {
      const serverRows = itemsForCourse(order, n);
      const draftRows = cartForCourse(cart, n);
      const status = courseStatus(order, n);
      const sent = isSent(status);
      // «In corso in cucina»: la card si accende — bordo pieno più spesso e
      // fondo tinto (famiglia arriving, la stessa della pillola «in cucina»).
      const fired = status === 'FIRED';
      const current = n === course;
      const badge = courseBadge(status, n);
      // Righe rimaste in coda dentro un'uscita GIÀ partita (aggiunte dopo il
      // lancio in un fire mode che non le fa partire da solo, o dati vecchi):
      // il «Chiama» deve coprirle, o restano orfane — l'uscita non risulta
      // «in coda» e il bottone normale non comparirebbe.
      const strandedQueued = status === 'FIRED' && serverRows.some(i => i.status === 'QUEUED');
      // La chiamata si può annullare solo finché NESSUNA riga è oltre SENT:
      // alla prima in preparazione il rimedio è lo storno, non il riavvolgi.
      const live = serverRows.filter(i => i.status !== 'VOIDED');
      const unfirable = status === 'FIRED' && live.length > 0 && live.every(i => i.status === 'SENT');

      // Feedback del trascinamento: il bersaglio sotto il puntatore prende
      // il ring dell'uscita corrente («qui»), le uscite partite si smorzano
      // (non sono bersagli), la sorgente resta come placeholder attenuato.
      const dragging = dnd.drag != null;
      const courseMovable = !sent && !!onMoveCourse
        && (draftRows.length > 0 || serverRows.some(i => i.status === 'DRAFT'));
      const isDropTarget = dragging && dnd.overCourse === n;
      const isDragSource = dnd.drag?.kind === 'course' && dnd.drag.from === n;
      const dimmedTarget = dragging && sent;

      if (serverRows.length === 0 && draftRows.length === 0 && !current) {
        // L'uscita vuota resta un bersaglio: portarci sopra il prossimo piatto
        // deve costare un tocco, non un menu.
        return (
          <button
            key={n}
            type="button"
            data-course-drop={n}
            onClick={() => onCourse(n)}
            className={`flex min-h-[52px] w-full items-center gap-2 rounded-[16px] border border-dashed border-[var(--ds-border-strong)] px-4 text-left text-[15px] text-[var(--ds-text-muted)] transition-colors hover:border-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              isDropTarget ? 'ring-2 ring-[var(--ds-action-bg)] border-transparent' : ''
            }`}
          >
            <Plus size={16} aria-hidden /> {courseLabel(n)}
          </button>
        );
      }

      // La testata «dentro» la card non c'è più: etichetta, stato e maniglia
      // dell'uscita vivono A CAVALLO del bordo (metà sopra, metà sotto) —
      // ridisegno chiesto da Marco al collaudo. Ne resta una riga interna
      // solo quando ci sono azioni (Chiama, torna in bozza, annulla).
      const hasActions = (unfirable && !!onUnfire) || (strandedQueued && !!onFire) || status === 'QUEUED';

      return (
        <section
          key={n}
          data-course-drop={n}
          // Tutta la card elegge l'uscita corrente, non solo la pill sul
          // bordo: il tocco sul fondo o fra le righe fa quello che l'occhio
          // si aspetta. I controlli interni restano loro — il guard lascia
          // passare solo i tocchi che non atterrano su un bottone.
          onClick={e => {
            if ((e.target as HTMLElement).closest('button, a, input, textarea')) return;
            onCourse(n);
          }}
          className={`relative cursor-pointer rounded-[16px] p-3 pt-4 transition-opacity ${
            fired
              ? 'border-2 border-[var(--ds-arriving-solid)] bg-[var(--ds-arriving-tint)]'
              : sent
                ? 'border border-[var(--ds-border-strong)] bg-[var(--ds-surface-row)]'
                : 'border border-[var(--ds-border-strong)] bg-[var(--ds-surface)]'
          } ${isDropTarget ? 'ring-2 ring-[var(--ds-action-bg)]' : current ? 'ring-2 ring-[var(--ds-action-bg)]' : ''} ${
            dimmedTarget || isDragSource ? 'opacity-60' : ''
          }`}
        >
          {/* La maniglia dell'uscita intera, nell'angolo in alto a sinistra:
              icona ⇕ APPOSTA diversa dal ⇅ di riga (due icone uguali si
              confondevano al telefono). Tocco = selettore, trascinata = drag. */}
          {courseMovable && (
            <button
              type="button"
              onClick={() => onMoveCourse!(n)}
              disabled={busy}
              aria-label={`Sposta la ${courseLabel(n)} su un'altra uscita`}
              title="Tocca per scegliere l'uscita, trascina per spostare l'uscita intera"
              {...grip({ kind: 'course', from: n, count: draftRows.length + serverRows.filter(i => i.status === 'DRAFT').length })}
              className="absolute left-3 top-0 z-10 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] ring-1 ring-[var(--ds-border-strong)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              <ChevronsUpDown size={15} />
            </button>
          )}
          {/* La pill col nome dell'uscita, a cavallo del bordo in alto. Da
              CENTRATA è passata a SINISTRA: le uscite sono una colonna, e
              un'etichetta al centro di ogni card costringe l'occhio a
              zigzagare per leggere quale uscita sta guardando. Il tocco la
              elegge uscita corrente, come l'etichetta di prima. */}
          <button
            type="button"
            onClick={() => onCourse(n)}
            aria-pressed={current}
            className={`absolute left-3 top-0 z-10 -translate-y-1/2 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[14px] font-semibold ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              current
                ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] ring-transparent'
                : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] ring-[var(--ds-border-strong)]'
            }`}
          >
            {/* La spunta sull'uscita servita: quella card è finita, e si
                riconosce senza leggere lo stato dall'altra parte. */}
            {status === 'SERVED' && <Check size={14} aria-hidden />}
            {courseLabel(n)}
          </button>
          {(sent || serverRows.length > 0 || draftRows.length > 0) && (
            <span className="absolute right-3 top-0 z-10 -translate-y-1/2">
              {sent
                ? <StatusPill tone={badge.tone}>{badge.text}</StatusPill>
                : current
                  ? <StatusPill tone="neutral">in composizione</StatusPill>
                  : <StatusPill tone="pending">da inviare</StatusPill>}
            </span>
          )}

          {hasActions && (
          <div className="flex items-center justify-end gap-2">
            {/* «annulla chiamata» quiet come «torna in bozza»: è il rimedio
                del tavolo sbagliato, non un verbo del servizio normale. */}
            {unfirable && onUnfire && (
              <button
                type="button"
                onClick={() => onUnfire(n)}
                disabled={busy}
                title="Annulla la chiamata: l'uscita torna in coda e sparisce dai monitor di cucina"
                className="flex-shrink-0 text-[13px] font-medium text-[var(--ds-text-muted)] underline decoration-dotted transition-opacity hover:opacity-70 disabled:opacity-40"
              >
                annulla chiamata
              </button>
            )}
            {strandedQueued && onFire && (
              <button
                type="button"
                onClick={() => onFire(n)}
                disabled={busy}
                title="Lancia in cucina le righe rimaste in coda su questa uscita"
                className="flex-shrink-0 rounded-full bg-[var(--ds-action-bg)] px-3.5 py-1.5 text-[13px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
              >
                Chiama
              </button>
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
          )}

          {(serverRows.length > 0 || draftRows.length > 0) && (
            <div className={`${hasActions ? 'mt-2' : 'mt-1'} flex flex-col gap-1`}>
              {serverRows.map(i => (
                <div
                  key={i.id}
                  // La riga in bozza si prende col tocco lungo (le altre no:
                  // una riga già in cucina si storna, non si sposta).
                  {...(i.status === 'DRAFT' && i.line_kind === 'DISH'
                    ? rowGrip({ kind: 'item', item: i, from: i.course_no })
                    : {})}
                  className={`flex items-center gap-2 text-[17px] transition-opacity ${
                    dnd.drag?.kind === 'item' && dnd.drag.item.id === i.id ? 'opacity-40' : ''
                  }`}
                >
                  {/* La quantità in una pastiglia invece che col «×»: in una
                      colonna di righe il numero nudo si perde nel nome del
                      piatto, e quanti pezzi sono è la prima cosa che la
                      cucina chiede al telefono. */}
                  <span className="inline-flex h-7 min-w-[28px] flex-shrink-0 items-center justify-center rounded-[6px] bg-[var(--ds-surface-row)] px-1.5 text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                    {i.qty}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      i.status === 'VOIDED'
                        ? 'text-[var(--ds-text-muted)] line-through'
                        : 'text-[var(--ds-text-primary)]'
                    }`}
                  >
                    {i.name_snapshot}
                    {i.weight_grams != null && (
                      <span className="text-[14px] tabular-nums text-[var(--ds-text-muted)]"> · {weightLabel(i.weight_grams)}</span>
                    )}
                    {((i.modifiers && i.modifiers.length > 0) || i.note) && (
                      <span className="text-[14px] text-[var(--ds-text-muted)]">
                        {' · '}{[...(i.modifiers ?? []).map(m => m.name), ...(i.note ? [i.note] : [])].join(', ')}
                      </span>
                    )}
                    {sent && i.status === 'QUEUED' && (
                      <span className="text-[14px] text-[var(--ds-pending-text)]"> · in coda</span>
                    )}
                  </span>
                  <span className="flex-shrink-0 text-[15px] tabular-nums text-[var(--ds-text-muted)]">
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
                <div
                  key={l.key}
                  {...rowGrip({ kind: 'line', key: l.key, label: l.dish.name, qty: l.qty, from: l.course_no })}
                  className={`flex items-center gap-2 transition-opacity ${
                    dnd.drag?.kind === 'line' && dnd.drag.key === l.key ? 'opacity-40' : ''
                  }`}
                >
                  {/* Stessa pastiglia delle righe server: lo stepper in riga
                      non c'è più, si cambia dal foglio. */}
                  <span className="inline-flex h-7 min-w-[28px] flex-shrink-0 items-center justify-center rounded-[6px] bg-[var(--ds-surface-row)] px-1.5 text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                    {l.qty}
                  </span>
                  {/* Le varianti lunghe si troncano: il tocco sul nome apre
                      il foglio varianti della riga, dove si leggono TUTTE e
                      si correggono — chiesto da Marco dal palmare («--- Con
                      burrata, ++ S…» non si legge). Bozza sola: una riga già
                      inviata non si riapre, si storna. */}
                  <button
                    type="button"
                    onClick={onEditLine ? () => onEditLine(l) : undefined}
                    disabled={!onEditLine}
                    aria-label={`Varianti di ${l.dish.name}`}
                    className="min-w-0 flex-1 rounded-[10px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <div className="truncate text-[17px] text-[var(--ds-text-primary)]">
                      {l.dish.name}
                      {l.weight_grams != null && (
                        <span className="text-[14px] tabular-nums text-[var(--ds-text-muted)]"> · {weightLabel(l.weight_grams)}</span>
                      )}
                    </div>
                    {(l.modifier_labels.length > 0 || l.note) && (
                      <div className="truncate text-[14px] text-[var(--ds-text-muted)]">
                        ↳ {[...l.modifier_labels, ...(l.note ? [l.note] : [])].join(', ')}
                      </div>
                    )}
                  </button>
                  <span className="flex-shrink-0 text-[15px] tabular-nums text-[var(--ds-text-muted)]">
                    {euro(cartUnitCents(l) * l.qty)}
                  </span>
                  {/* Niente matita e niente maniglia ⇅: il tocco sul nome
                      apre il foglio di riga, il TOCCO LUNGO sulla riga la
                      prende per spostarla (rowGrip). */}
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
    {dnd.ghost}
  </div>
  );
};

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
  /** 'full' è il piede della colonna sullo schermo largo: il riepilogo del
   *  conto e un bottone che dice cosa manda e quanto vale. 'compact' (il
   *  default) è quello del palmare, dove lo spazio è del menu e il totale è
   *  già la maniglia del foglio comanda — invariato. */
  variant?: 'compact' | 'full';
  /** Il riepilogo, solo per 'full'. Il coperto è una riga di sistema della
   *  comanda: si mostra com'è battuto (8 × 2,00 €), non ricalcolato. */
  summary?: {
    subtotalCents: number;
    coverCount: number;
    coverUnitCents: number;
    coverTotalCents: number;
    serviceCents: number;
    discountCents: number;
    totalCents: number;
  };
}

export const SendFooter: React.FC<SendFooterProps> = ({
  course, courseCount, courseTotal, allCount, allTotal, busy, onSend, onSendAll, onExpand,
  variant = 'compact', summary,
}) => variant === 'full' ? (
  <div className="flex flex-col gap-3">
    {summary && (
      /* Il riepilogo del conto sotto la comanda. Non sostituisce il foglio
         Conto — lì si incassa, si divide e si stampa: qui si legge soltanto,
         perché «quanto stanno spendendo» è la domanda che si fa a metà
         servizio senza voler aprire niente. */
      <div className="flex flex-col gap-1 border-t border-[var(--ds-border)] pt-3 text-[14px]">
        <div className="flex items-center justify-between text-[var(--ds-text-muted)]">
          <span>Subtotale</span>
          <span className="tabular-nums">{euro(summary.subtotalCents)}</span>
        </div>
        {summary.coverCount > 0 && (
          <div className="flex items-center justify-between text-[var(--ds-text-muted)]">
            <span className="tabular-nums">
              Coperti · {summary.coverCount} × {euro(summary.coverUnitCents)}
            </span>
            <span className="tabular-nums">{euro(summary.coverTotalCents)}</span>
          </div>
        )}
        {summary.serviceCents > 0 && (
          <div className="flex items-center justify-between text-[var(--ds-text-muted)]">
            <span>Servizio</span>
            <span className="tabular-nums">{euro(summary.serviceCents)}</span>
          </div>
        )}
        {summary.discountCents > 0 && (
          <div className="flex items-center justify-between text-[var(--ds-pending-text)]">
            <span>Sconto</span>
            <span className="tabular-nums">−{euro(summary.discountCents)}</span>
          </div>
        )}
        <div className="mt-1 flex items-baseline justify-between">
          <span className="text-[15px] text-[var(--ds-text-secondary)]">Totale</span>
          <span className="text-[26px] font-semibold tabular-nums tracking-[-0.015em] text-[var(--ds-text-primary)]">
            {euro(summary.totalCents)}
          </span>
        </div>
      </div>
    )}
    {/* Il bottone dice cosa manda e quanto vale: «Invia» e basta costringeva
        a guardare da un'altra parte per sapere quale uscita stava partendo. */}
    <button
      type="button"
      onClick={onSend}
      disabled={busy || courseCount === 0}
      className="inline-flex h-14 w-full items-center justify-center gap-2 rounded-full bg-[var(--ds-action-bg)] px-6 text-[17px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
    >
      {busy ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Send size={18} aria-hidden />}
      {courseCount === 0 ? `Invia ${courseLabel(course)}` : `Invia ${courseLabel(course)} · ${euro(courseTotal)}`}
    </button>
    {/* «Invia tutto» resta, e resta alla sua condizione di sempre: compare
        solo se ci sono bozze FUORI dall'uscita corrente, altrimenti sarebbe
        lo stesso bottone due volte. */}
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
) : (
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
        className="inline-flex h-12 flex-shrink-0 items-center gap-2 rounded-full bg-[var(--ds-surface)] px-6 text-[17px] font-semibold text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
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
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-[var(--ds-action-bg)] text-[15px] font-medium text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
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
  /** «di Luca» / «dalla cassa» quando la comanda l'ha aperta qualcun altro:
   *  chi tocca un tavolo non suo lo legge in testa, prima di battere. */
  openedBy?: string | null;
}

export const CourseColumn: React.FC<CourseColumnProps> = ({ onSend, onSendAll, openedBy, ...list }) => {
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
  // Il coperto è una riga di sistema della comanda, non un calcolo: si mostra
  // com'è battuto. Righe multiple (comande vecchie, coperti ritoccati) si
  // sommano invece di far vincere la prima.
  const liveOf = (kind: 'COVER' | 'SERVICE') =>
    order.items.filter(i => i.line_kind === kind && i.status !== 'VOIDED');
  const centsOf = (rows: OrderItem[]) =>
    rows.reduce((s, i) => s + (i.line_total_cents ?? i.qty * i.unit_price_cents), 0);
  const coverRows = liveOf('COVER');
  const coverCount = coverRows.reduce((s, i) => s + i.qty, 0);
  const coverTotalCents = centsOf(coverRows);
  const serviceCents = centsOf(liveOf('SERVICE'));
  // `subtotal_cents` del server comprende TUTTE le righe vive, coperto
  // compreso. Qui il coperto ha la sua riga, quindi il subtotale sopra deve
  // essere quello dei soli piatti: sommato com'è arrivava a contarlo due
  // volte, e il riepilogo non tornava con il totale scritto sotto.
  const summary = {
    subtotalCents: order.subtotal_cents - coverTotalCents - serviceCents,
    coverCount,
    coverUnitCents: coverRows[0]?.unit_price_cents ?? 0,
    coverTotalCents,
    serviceCents,
    discountCents: order.discount_cents ?? 0,
    totalCents: order.total_cents,
  };
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
      {/* La riga «Comanda · vuota» compare solo quando c'è qualcosa da dire
          che non sta già sopra: chi ha aperto il tavolo. Il conteggio e il
          totale li porta la scheda del tavolo, e una fascia che ripete il
          nome della colonna sotto il titolo della colonna era una riga da
          saltare per arrivare alle uscite (§10). */}
      {openedBy && (
        <header className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--ds-border)] px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
            Comanda<span className="font-normal text-[var(--ds-text-muted)]"> {openedBy}</span>
          </h2>
          <span className="flex-shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
            {rows === 0 ? 'vuota' : rowCountLabel(rows)}
          </span>
        </header>
      )}
      {/* La pista delle uscite resta SEMPRE in vista: a comanda lunga le
          uscite in fondo alla colonna scorrono via, e selezionarne una
          voleva dire andarla a cercare. Stessa pista del palmare — pallino
          «qui c'è roba», verde «già partita». */}
      <div className="flex-shrink-0 border-b border-[var(--ds-border)] px-3 py-2">
        <CourseChips
          order={order}
          cart={cart}
          course={course}
          onCourse={list.onCourse}
          showBar={list.showBar}
          showDessert={list.showDessert}
          variant="card"
        />
      </div>
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
          variant="full"
          summary={summary}
        />
      </div>
    </div>
  );
};
