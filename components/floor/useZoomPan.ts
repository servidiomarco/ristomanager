import React, { useEffect, useRef, useState } from 'react';

// Zoom e pan minimi per la pianta: su una sala di 15 metri il fit-to-container
// rende un tavolo da 60 cm ~28px su un palmare — illeggibile. Gesti:
// pinch a due dita (zoom + pan insieme), doppio tap = avvicina/allontana,
// ctrl+rotellina sul desktop, trascinamento dello sfondo quando si è zoomati.
// Un dito resta libero per i tap sui tavoli. Lo zoom parte sempre dal fit
// (zoom 1 = la stanza intera) e non lo scende mai sotto.

interface UseZoomPanArgs {
  enabled: boolean;
  fitScale: number;
  fitOffset: { x: number; y: number };
  extent: { width: number; height: number };
  containerRef: React.RefObject<HTMLDivElement | null>;
  maxZoom?: number;
  resetKey?: unknown; // cambia sala → si torna al fit
}

export function useZoomPan({ enabled, fitScale, fitOffset, extent, containerRef, maxZoom = 3, resetKey }: UseZoomPanArgs) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const gestureRef = useRef<{
    mode: 'pinch' | 'drag' | null;
    dist0: number;
    zoom0: number;
    mid0: { x: number; y: number };
    pan0: { x: number; y: number };
    content0: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, enabled]);

  if (!enabled) {
    return { zoom: 1, pan: { x: 0, y: 0 }, handlers: {} as React.HTMLAttributes<HTMLDivElement>, gesturing: false };
  }

  const local = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  const clampPan = (p: { x: number; y: number }, z: number) => {
    // Tiene sempre un pezzo di stanza in vista: il contenuto non si può
    // scagliare fuori dal contenitore.
    const rect = containerRef.current?.getBoundingClientRect();
    const cw = rect?.width ?? 0;
    const ch = rect?.height ?? 0;
    const contentW = extent.width * fitScale * z;
    const contentH = extent.height * fitScale * z;
    const MARGIN = 60;
    return {
      x: Math.min(Math.max(p.x, -(contentW + fitOffset.x - MARGIN)), cw - fitOffset.x - MARGIN),
      y: Math.min(Math.max(p.y, -(contentH + fitOffset.y - MARGIN)), ch - fitOffset.y - MARGIN),
    };
  };

  // Il punto-stanza sotto (mx,my) deve restare sotto il dito quando cambia z.
  const anchorZoom = (mx: number, my: number, nextZoom: number) => {
    const z = Math.min(Math.max(nextZoom, 1), maxZoom);
    const content = {
      x: (mx - fitOffset.x - pan.x) / (fitScale * zoom),
      y: (my - fitOffset.y - pan.y) / (fitScale * zoom),
    };
    const nextPan = z === 1
      ? { x: 0, y: 0 }
      : clampPan({ x: mx - fitOffset.x - content.x * fitScale * z, y: my - fitOffset.y - content.y * fitScale * z }, z);
    setZoom(z);
    setPan(nextPan);
  };

  const handlers: React.HTMLAttributes<HTMLDivElement> = {
    style: { touchAction: 'none' },
    onWheel: e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const { x, y } = local(e.clientX, e.clientY);
      anchorZoom(x, y, zoom * Math.exp(-e.deltaY * 0.002));
    },
    onDoubleClick: e => {
      const { x, y } = local(e.clientX, e.clientY);
      anchorZoom(x, y, zoom > 1.2 ? 1 : 1.8);
    },
    onTouchStart: e => {
      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        const mid = local((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        gestureRef.current = {
          mode: 'pinch',
          dist0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
          zoom0: zoom,
          mid0: mid,
          pan0: pan,
          content0: {
            x: (mid.x - fitOffset.x - pan.x) / (fitScale * zoom),
            y: (mid.y - fitOffset.y - pan.y) / (fitScale * zoom),
          },
        };
      }
    },
    onTouchMove: e => {
      const g = gestureRef.current;
      if (g?.mode !== 'pinch' || e.touches.length !== 2) return;
      const [a, b] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const mid = local((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      const z = Math.min(Math.max(g.zoom0 * (dist / Math.max(1, g.dist0)), 1), maxZoom);
      const nextPan = z === 1
        ? { x: 0, y: 0 }
        : clampPan({ x: mid.x - fitOffset.x - g.content0.x * fitScale * z, y: mid.y - fitOffset.y - g.content0.y * fitScale * z }, z);
      setZoom(z);
      setPan(nextPan);
    },
    onTouchEnd: e => {
      if (e.touches.length < 2) gestureRef.current = null;
    },
    onMouseDown: e => {
      // Pan col mouse solo dallo sfondo (mai da un tavolo) e solo zoomati.
      if (zoom === 1) return;
      if ((e.target as HTMLElement).closest('button')) return;
      const start = local(e.clientX, e.clientY);
      gestureRef.current = { mode: 'drag', dist0: 0, zoom0: zoom, mid0: start, pan0: pan, content0: { x: 0, y: 0 } };
    },
    onMouseMove: e => {
      const g = gestureRef.current;
      if (g?.mode !== 'drag') return;
      const cur = local(e.clientX, e.clientY);
      setPan(clampPan({ x: g.pan0.x + (cur.x - g.mid0.x), y: g.pan0.y + (cur.y - g.mid0.y) }, zoom));
    },
    onMouseUp: () => { if (gestureRef.current?.mode === 'drag') gestureRef.current = null; },
    onMouseLeave: () => { if (gestureRef.current?.mode === 'drag') gestureRef.current = null; },
  };

  return { zoom, pan, handlers, gesturing: gestureRef.current?.mode === 'pinch' };
}
