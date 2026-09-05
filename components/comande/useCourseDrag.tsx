import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OrderItem } from '../../types';

// ---------------------------------------------------------------------------
// Il trascinamento della comanda: una riga in bozza (o un'uscita intera) si
// prende dal SUO BOTTONE — il ⇅ della riga, lo «sposta» della testata — e si
// lascia cadere sull'uscita di arrivo. Tocco secco = selettore modale come
// sempre; tenuto e mosso = drag. La maniglia-che-è-anche-bottone azzera il
// conflitto con lo scroll: il bottone non è una superficie di scorrimento,
// quindi touch-action: none statico e niente tocco lungo.
//
// Meccanica dai precedenti di casa: stato in ref e capture del pointer
// (SwipeRow), transform diretto sul ghost senza re-render per frame
// (FloorPlan), click fantasma soppresso col flag (DishBrowser). I listener
// vivono su window CON IDENTITÀ STABILI (motore creato una volta, opzioni
// lette da ref): un re-render o un rimontaggio da socket a metà drag non
// deve lasciare listener orfani né congelare il gesto. Il drop non sa
// niente di dominio: chiama le stesse funzioni del selettore modale.
// ---------------------------------------------------------------------------

export type DragPayload =
  | { kind: 'line'; key: string; label: string; qty: number; from: number }
  | { kind: 'item'; item: OrderItem; from: number }
  | { kind: 'course'; from: number; count: number };

interface UseCourseDragOptions {
  disabled: boolean;
  /** Un'uscita già partita non è un bersaglio: il drop deve dirlo prima. */
  canDropOn: (courseNo: number) => boolean;
  onDrop: (payload: DragPayload, to: number) => void;
}

/** Quanto il puntatore può vagare prima che il tocco diventi un drag. */
const SLOP_PX = 8;
/** Zona calda ai bordi dello scroller in cui parte l'autoscroll. */
const EDGE_PX = 48;
/** Velocità massima di autoscroll per frame. */
const MAX_SCROLL_PX = 14;

const findScroller = (from: Element | null): HTMLElement | null => {
  for (let el = from?.parentElement ?? null; el; el = el.parentElement) {
    const o = getComputedStyle(el).overflowY;
    if (o === 'auto' || o === 'scroll') return el as HTMLElement;
  }
  return null;
};

export const dragGhostLabel = (p: DragPayload): string =>
  p.kind === 'line' ? `${p.qty}× ${p.label}`
  : p.kind === 'item' ? `${p.item.qty}× ${p.item.name_snapshot}`
  : `${p.from}ª uscita · ${p.count} ${p.count === 1 ? 'riga' : 'righe'}`;

interface DragSession {
  payload: DragPayload;
  startX: number; startY: number;
  x: number; y: number;
  armed: boolean;
  pointerId: number;
  sourceEl: HTMLElement;
  scroller: HTMLElement | null;
  over: number | null;
  raf: number | null;
}

export function useCourseDrag({ disabled, canDropOn, onDrop }: UseCourseDragOptions): {
  drag: DragPayload | null;
  overCourse: number | null;
  handleProps: (payload: DragPayload) => React.HTMLAttributes<HTMLElement>;
  ghost: React.ReactNode;
} {
  const [drag, setDrag] = useState<DragPayload | null>(null);
  const [overCourse, setOverCourse] = useState<number | null>(null);

  // Le opzioni cambiano a ogni render; il motore no. Le legge da qui.
  const optsRef = useRef({ disabled, canDropOn, onDrop });
  optsRef.current = { disabled, canDropOn, onDrop };

  const ghostRef = useRef<HTMLDivElement | null>(null);
  const justDragged = useRef(false);

  // Motore creato una volta: tutto ciò che cambia per frame vive in `s`,
  // i listener su window hanno identità stabile per l'intera vita del
  // componente.
  const engine = useMemo(() => {
    let s: DragSession | null = null;

    const positionGhost = () => {
      const g = ghostRef.current;
      if (!s || !g) return;
      // Ancorato poco sopra il dito, perché non resti coperto dalla mano.
      g.style.transform = `translate(${s.x - g.offsetWidth / 2}px, ${s.y - g.offsetHeight - 12}px) scale(1.02)`;
    };

    const hitTest = () => {
      if (!s) return;
      const el = document.elementFromPoint(s.x, s.y);
      const target = el?.closest('[data-course-drop]');
      const n = target ? Number(target.getAttribute('data-course-drop')) : NaN;
      const valid = Number.isInteger(n) && n !== s.payload.from && optsRef.current.canDropOn(n) ? n : null;
      if (valid !== s.over) {
        s.over = valid;
        setOverCourse(valid);
      }
    };

    // Il rAF gira per tutto il drag: muove lo scroller nelle zone calde e
    // ripete l'hit-test, perché il contenuto scorre anche a dito fermo.
    const tick = () => {
      if (!s?.armed) return;
      const sc = s.scroller;
      if (sc) {
        const r = sc.getBoundingClientRect();
        let v = 0;
        if (s.y < r.top + EDGE_PX) v = -Math.ceil(((r.top + EDGE_PX - s.y) / EDGE_PX) * MAX_SCROLL_PX);
        else if (s.y > r.bottom - EDGE_PX) v = Math.ceil(((s.y - (r.bottom - EDGE_PX)) / EDGE_PX) * MAX_SCROLL_PX);
        if (v !== 0) { sc.scrollTop += v; hitTest(); }
      }
      s.raf = requestAnimationFrame(tick);
    };

    const arm = () => {
      if (!s || s.armed) return;
      s.armed = true;
      justDragged.current = true;
      if (typeof navigator !== 'undefined') navigator.vibrate?.(30);
      s.scroller = findScroller(s.sourceEl);
      setDrag(s.payload);
      s.raf = requestAnimationFrame(tick);
    };

    const teardown = () => {
      if (s?.raf != null) cancelAnimationFrame(s.raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      const bodyStyle = document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string };
      bodyStyle.userSelect = '';
      bodyStyle.webkitUserSelect = '';
      // Se la selezione era già partita prima dello spegnimento, la lente
      // resta a schermo: si scarta anche quella.
      try { window.getSelection()?.removeAllRanges(); } catch { /* niente */ }
      s = null;
      setDrag(null);
      setOverCourse(null);
    };

    function onMove(e: PointerEvent) {
      if (!s || e.pointerId !== s.pointerId) return;
      s.x = e.clientX; s.y = e.clientY;
      if (!s.armed) {
        if (Math.abs(s.x - s.startX) > SLOP_PX || Math.abs(s.y - s.startY) > SLOP_PX) arm();
        return;
      }
      positionGhost();
      hitTest();
    }

    function onUp(e: PointerEvent) {
      if (!s || e.pointerId !== s.pointerId) return;
      const { armed, payload, over } = s;
      teardown();
      if (armed) {
        if (over != null) optsRef.current.onDrop(payload, over);
        // Il click che il browser emette al rilascio non deve riaprire il
        // selettore: justDragged lo mangia in onClickCapture e si spegne
        // al prossimo tick.
        setTimeout(() => { justDragged.current = false; }, 0);
      }
    }

    function onCancel(e: PointerEvent) {
      if (!s || e.pointerId !== s.pointerId) return;
      teardown();
      setTimeout(() => { justDragged.current = false; }, 0);
    }

    const start = (payload: DragPayload, e: React.PointerEvent<HTMLElement>) => {
      if (optsRef.current.disabled || s) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // iOS: il tocco tenuto avvia la SELEZIONE TESTO (lente + Copy) e la
      // estende ai testi vicini al bottone — contextmenu bloccato non basta.
      // Si spegne la selezione sull'intera pagina per la durata del gesto e
      // si ripristina al teardown.
      const bodyStyle = document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string };
      bodyStyle.userSelect = 'none';
      bodyStyle.webkitUserSelect = 'none';
      s = {
        payload,
        startX: e.clientX, startY: e.clientY,
        x: e.clientX, y: e.clientY,
        armed: false,
        pointerId: e.pointerId,
        sourceEl: e.currentTarget as HTMLElement,
        scroller: null,
        over: null,
        raf: null,
      };
      // La capture tiene il gesto anche se il puntatore lascia il bottone;
      // i listener su window sopravvivono a un rimontaggio della riga.
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* niente */ }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    };

    return { start, teardown, positionGhost };
    // setDrag/setOverCourse sono stabili; tutto il resto passa da optsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => engine.teardown(), [engine]);

  const handleProps = (payload: DragPayload): React.HTMLAttributes<HTMLElement> => ({
    onPointerDown: e => engine.start(payload, e),
    onClickCapture: e => {
      // Dopo un drag il click di rilascio è rumore: non deve aprire il
      // selettore (pattern lpFired di DishBrowser).
      if (justDragged.current) { e.preventDefault(); e.stopPropagation(); }
    },
    // Il tocco tenuto sul bottone evoca il menu contestuale del browser:
    // qui è una maniglia.
    onContextMenu: e => e.preventDefault(),
    // touch-action statico e solo sul bottone (il resto della riga continua
    // a scorrere); selezione e callout iOS spenti sulla maniglia stessa —
    // per i testi VICINI ci pensa lo start, sul body.
    style: {
      touchAction: 'none',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none',
    } as React.CSSProperties,
  });

  // Prima posizione del ghost appena montato: il primo pointermove dopo il
  // mount può tardare un frame.
  useEffect(() => { if (drag) engine.positionGhost(); }, [drag, engine]);

  const ghost = drag
    ? createPortal(
        <div
          ref={ghostRef}
          className="pointer-events-none fixed left-0 top-0 z-50 select-none whitespace-nowrap rounded-[16px] bg-[var(--ds-surface)] px-4 py-2.5 text-[14px] font-semibold text-[var(--ds-text-primary)] opacity-95 shadow-[var(--ds-shadow-raised)]"
        >
          {dragGhostLabel(drag)}
        </div>,
        document.body,
      )
    : null;

  return { drag, overCourse, handleProps, ghost };
}
