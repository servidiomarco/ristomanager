import React from 'react';
import { ArrowUpDown, Ban, ChevronUp, ChevronsUpDown, Loader2, Pencil, Plus, Send, SendHorizontal } from 'lucide-react';
import type { OrderItem, OrderWithItems } from '../../types';
import { StatusPill } from '../ds';
import {
  BAR_COURSE_NO,
  COURSE_BADGE, MAX_COURSES, cartForCourse, cartSum, cartUnitCents, courseLabel,
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
}

const stepper =
  'inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

export const CourseList: React.FC<CourseListProps> = ({
  order, cart, course, onCourse, busy, onBump, onDrop, onVoid, onRecall, onFire, onEditLine, onUnfire,
  onMoveLine, onMoveItem, onMoveCourse, onDragLine, onDragItem, onDragCourse, showBar,
}) => {
  const dnd = useCourseDrag({
    disabled: busy,
    canDropOn: n => !isSent(courseStatus(order, n)),
    onDrop: (p: DragPayload, to: number) => {
      if (p.kind === 'line') onDragLine?.(p.key, to);
      else if (p.kind === 'item') onDragItem?.(p.item, to);
      else onDragCourse?.(p.from, to);
    },
  });
  // Maniglia solo se il drop ha un gestore: senza, il bottone resta il
  // bottone di sempre.
  const grip = (p: DragPayload) => {
    const wired = p.kind === 'line' ? !!onDragLine : p.kind === 'item' ? !!onDragItem : !!onDragCourse;
    return wired ? dnd.handleProps(p) : {};
  };

  // Il Bar sta in testa: le bibite escono prima degli antipasti. La sezione
  // compare anche senza flag quando l'uscita ha righe (comunque arrivate).
  const courseNos = [
    ...(showBar || course === BAR_COURSE_NO
      || itemsForCourse(order, BAR_COURSE_NO).length > 0
      || cartForCourse(cart, BAR_COURSE_NO).length > 0
        ? [BAR_COURSE_NO] : []),
    ...Array.from({ length: MAX_COURSES }, (_, i) => i + 1),
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
      const badge = COURSE_BADGE[status];
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
          className={`relative rounded-[16px] p-3 pt-4 transition-opacity ${
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
          {/* La pill col nome dell'uscita, a cavallo del bordo in alto al
              centro. Il tocco la elegge uscita corrente, come l'etichetta
              di prima. */}
          <button
            type="button"
            onClick={() => onCourse(n)}
            aria-pressed={current}
            className={`absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              current
                ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] ring-transparent'
                : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] ring-[var(--ds-border-strong)]'
            }`}
          >
            {courseLabel(n)}
          </button>
          {(sent || serverRows.length > 0) && (
            <span className="absolute right-3 top-0 z-10 -translate-y-1/2">
              {sent
                ? <StatusPill tone={badge.tone}>{badge.text}</StatusPill>
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
                <div key={i.id} className={`flex items-center gap-2 text-[15px] transition-opacity ${
                  dnd.drag?.kind === 'item' && dnd.drag.item.id === i.id ? 'opacity-40' : ''
                }`}>
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
                    {i.weight_grams != null && (
                      <span className="text-[13px] tabular-nums text-[var(--ds-text-muted)]"> · {weightLabel(i.weight_grams)}</span>
                    )}
                    {((i.modifiers && i.modifiers.length > 0) || i.note) && (
                      <span className="text-[13px] text-[var(--ds-text-muted)]">
                        {' · '}{[...(i.modifiers ?? []).map(m => m.name), ...(i.note ? [i.note] : [])].join(', ')}
                      </span>
                    )}
                    {sent && i.status === 'QUEUED' && (
                      <span className="text-[13px] text-[var(--ds-pending-text)]"> · in coda</span>
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
                  {i.status === 'DRAFT' && i.line_kind === 'DISH' && onMoveItem && (
                    <button
                      type="button"
                      onClick={() => onMoveItem(i)}
                      disabled={busy}
                      aria-label={`Sposta ${i.name_snapshot} su un'altra uscita`}
                      title="Tocca per scegliere l'uscita, trascina per spostare"
                      {...grip({ kind: 'item', item: i, from: i.course_no })}
                      className={stepper}
                    >
                      <ArrowUpDown size={15} />
                    </button>
                  )}
                </div>
              ))}

              {draftRows.map(l => (
                <div key={l.key} className={`flex items-center gap-2 transition-opacity ${
                  dnd.drag?.kind === 'line' && dnd.drag.key === l.key ? 'opacity-40' : ''
                }`}>
                  {/* La quantità è un prefisso come nelle righe server: lo
                      stepper in riga non c'è più, si cambia dal foglio. */}
                  <span className="flex-shrink-0 text-[14px] font-semibold tabular-nums text-[var(--ds-text-muted)]">
                    {l.qty}×
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
                    <div className="truncate text-[15px] text-[var(--ds-text-primary)]">
                      {l.dish.name}
                      {l.weight_grams != null && (
                        <span className="text-[13px] tabular-nums text-[var(--ds-text-muted)]"> · {weightLabel(l.weight_grams)}</span>
                      )}
                    </div>
                    {(l.modifier_labels.length > 0 || l.note) && (
                      <div className="truncate text-[13px] text-[var(--ds-text-muted)]">
                        ↳ {[...l.modifier_labels, ...(l.note ? [l.note] : [])].join(', ')}
                      </div>
                    )}
                  </button>
                  <span className="flex-shrink-0 text-[14px] tabular-nums text-[var(--ds-text-muted)]">
                    {euro(cartUnitCents(l) * l.qty)}
                  </span>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    {/* Solo matita e maniglia (chiesto da Marco): quantità,
                        varianti ed elimina vivono nel foglio di riga che la
                        matita (o il nome) apre — la riga resta al nome. */}
                    {onEditLine && (
                      <button
                        type="button"
                        onClick={() => onEditLine(l)}
                        aria-label={`Modifica ${l.dish.name}: quantità, varianti, elimina`}
                        title="Quantità, varianti, elimina"
                        className={stepper}
                      >
                        <Pencil size={15} />
                      </button>
                    )}
                    {onMoveLine && (
                      <button
                        type="button"
                        onClick={() => onMoveLine(l)}
                        aria-label={`Sposta ${l.dish.name} su un'altra uscita`}
                        title="Tocca per scegliere l'uscita, trascina per spostare"
                        {...grip({ kind: 'line', key: l.key, label: l.dish.name, qty: l.qty, from: l.course_no })}
                        className={stepper}
                      >
                        <ArrowUpDown size={15} />
                      </button>
                    )}
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
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--ds-border)] px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
          Comanda{openedBy ? <span className="font-normal text-[var(--ds-text-muted)]"> {openedBy}</span> : null}
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
