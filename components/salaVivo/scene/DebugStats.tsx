import { useEffect, type RefObject } from 'react';
import { useThree } from '@react-three/fiber';

/* I numeri per il collaudo sull'hardware vero (localStorage salaVivo.debug =
 * '1'): fps, draw call e triangoli dell'ultimo frame, DPR, modalità lenta.
 * Servono a decidere il via libera dopo PR2b sul tablet dell'ingresso e sulla
 * TV, e a vedere che da ferma la sala stia davvero a 0 fps.
 *
 * Niente stato React e niente lavoro per frame: due volte al secondo si
 * leggono i contatori del renderer (gl.info.render.frame conta i render, gli
 * altri valgono per l'ultimo) e si scrive il testo nel div che il canvas
 * tiene accanto a sé. R3F non disegna DOM dentro la scena, e drei non c'è. */

const SAMPLE_MS = 500;

const formatCount = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1).replace('.', ',')}k` : String(n));

interface DebugStatsProps {
  targetRef: RefObject<HTMLDivElement | null>;
  slowMode: boolean;
}

export function DebugStats({ targetRef, slowMode }: DebugStatsProps) {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    let lastFrame = gl.info.render.frame;
    let lastAt = performance.now();
    const write = () => {
      const el = targetRef.current;
      if (!el) return;
      const now = performance.now();
      const frame = gl.info.render.frame;
      const fps = Math.round(((frame - lastFrame) * 1000) / Math.max(1, now - lastAt));
      lastFrame = frame;
      lastAt = now;
      const { calls, triangles } = gl.info.render;
      const dpr = Math.round(gl.getPixelRatio() * 100) / 100;
      el.textContent = `${fps} fps · ${calls} draw call · ${formatCount(triangles)} triangoli · dpr ${String(dpr).replace('.', ',')}${slowMode ? ' · modalità lenta' : ''}`;
    };
    write();
    const id = window.setInterval(write, SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [gl, slowMode, targetRef]);

  return null;
}
