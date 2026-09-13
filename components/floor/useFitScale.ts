import { useEffect, useRef, useState } from 'react';

// Fit-to-container per la pianta: la logica è quella collaudata di FloorPlan
// (ResizeObserver → scala contain con margine, mai oltre maxScale, contenuto
// centrato), estratta perché ogni superficie la reimplementava a modo suo —
// Reception moltiplicava ogni coordinata, la Piantina scalava solo in
// larghezza e scrollava in verticale.

export interface FitExtent { width: number; height: number }

export function useFitScale(extent: FitExtent, opts?: { margin?: number; maxScale?: number; center?: boolean }) {
  const margin = opts?.margin ?? 16;
  const maxScale = opts?.maxScale ?? 1;
  const center = opts?.center ?? true;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const availW = Math.max(1, size.width - margin * 2);
  const availH = Math.max(1, size.height - margin * 2);
  const scale = size.width === 0 || size.height === 0
    ? 1
    : Math.min(availW / Math.max(1, extent.width), availH / Math.max(1, extent.height), maxScale);

  const offset = center
    ? {
        x: Math.max(margin, (size.width - extent.width * scale) / 2),
        y: Math.max(margin, (size.height - extent.height * scale) / 2),
      }
    : { x: 0, y: 0 };

  return { containerRef, containerSize: size, scale, offset };
}
