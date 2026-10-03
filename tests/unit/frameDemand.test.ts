import { describe, it, expect } from 'vitest';
import {
  FPS_ACTIVE,
  FPS_PULSE,
  createFrameDemand,
  expectedFrameMs,
  pulseResumeAt,
  slowFrameLimit,
  targetFps,
} from '../../components/salaVivo/scene/frameDemand';

/* Il ritmo dei frame della Sala dal vivo: quanti frame chiedere, quando
 * risvegliarsi, quando un dispositivo non tiene il passo. Su una TV accesa
 * tutto il servizio ogni frame inutile è calore, e un declassamento sbagliato
 * peggiora la vista per sempre. */

const PERIODO = 2200;
const VIVO = 0.7 * PERIODO;

const conAnello = () => {
  const d = createFrameDemand();
  d.pulsing = true;
  d.pulsePeriodMs = PERIODO;
  d.pulseLiveMs = VIVO;
  return d;
};

describe('l\'anello «in arrivo»', () => {
  it('nella parte visibile del ciclo 12 fps, più un frame dopo la dissolvenza', () => {
    const d = conAnello();
    const ciclo = 10 * PERIODO;
    expect(targetFps(d, ciclo, false)).toBe(FPS_PULSE);
    expect(targetFps(d, ciclo + VIVO - 1, false)).toBe(FPS_PULSE);
    // Il frame che lo disegna a opacità 0 e lo nasconde.
    expect(targetFps(d, ciclo + VIVO + 50, false)).toBe(FPS_PULSE);
  });

  it('nella parte trasparente nessun frame, e il risveglio all\'inizio del ciclo dopo', () => {
    const d = conAnello();
    const ciclo = 10 * PERIODO;
    const morto = ciclo + VIVO + 200;
    expect(targetFps(d, morto, false)).toBe(0);
    expect(pulseResumeAt(d, morto)).toBeCloseTo(ciclo + PERIODO, 6);
    // Ripartito, la fase è di nuovo visibile.
    expect(targetFps(d, ciclo + PERIODO, false)).toBe(FPS_PULSE);
    // Nella parte visibile non c'è niente da aspettare.
    expect(pulseResumeAt(d, ciclo + 100)).toBeNull();
  });

  it('chi muove la camera vince sul ciclo; senza anello o col movimento ridotto niente', () => {
    const d = conAnello();
    const morto = 10 * PERIODO + VIVO + 200;
    d.interacting = true;
    expect(targetFps(d, morto, false)).toBe(FPS_ACTIVE);
    const fermo = createFrameDemand();
    expect(targetFps(fermo, morto, false)).toBe(0);
    expect(pulseResumeAt(fermo, morto)).toBeNull();
    // Un ciclo non dichiarato (0) vale «sempre visibile», come prima.
    const senzaCiclo = createFrameDemand();
    senzaCiclo.pulsing = true;
    expect(targetFps(senzaCiclo, morto, false)).toBe(FPS_PULSE);
    expect(pulseResumeAt(senzaCiclo, morto)).toBeNull();
  });
});

describe('il declassamento della risoluzione', () => {
  const hz = (n: number) => 1000 / n;

  it('il ritmo vero a 30 fps dipende dal vsync dello schermo', () => {
    expect(expectedFrameMs(FPS_ACTIVE, hz(60))).toBeCloseTo(33.33, 1);
    expect(expectedFrameMs(FPS_ACTIVE, hz(120))).toBeCloseTo(33.33, 1);
    expect(expectedFrameMs(FPS_ACTIVE, hz(50))).toBeCloseTo(40, 6);
    expect(expectedFrameMs(FPS_ACTIVE, hz(75))).toBeCloseTo(40, 6);
    expect(expectedFrameMs(FPS_ACTIVE, hz(48))).toBeCloseTo(41.67, 1);
    expect(expectedFrameMs(FPS_ACTIVE, hz(144))).toBeCloseTo(34.72, 1);
    // Senza un vsync misurato, l'intervallo nominale.
    expect(expectedFrameMs(FPS_ACTIVE, Infinity)).toBeCloseTo(33.33, 1);
  });

  it('una GPU ferma su un pannello a 48, 50 o 75 Hz non fa scattare il declassamento', () => {
    for (const n of [48, 50, 60, 75, 90, 100, 120, 144]) {
      const cadenza = expectedFrameMs(FPS_ACTIVE, hz(n));
      // Il ritmo dello schermo, più un millisecondo di rumore.
      expect(cadenza + 1, `${n} Hz`).toBeLessThan(slowFrameLimit(hz(n)));
    }
  });

  it('una GPU in affanno sì: ogni frame arriva un vsync dopo il previsto', () => {
    for (const n of [48, 50, 60, 75, 120, 144]) {
      const vsync = hz(n);
      const inRitardo = expectedFrameMs(FPS_ACTIVE, vsync) + vsync;
      expect(inRitardo, `${n} Hz`).toBeGreaterThan(slowFrameLimit(vsync));
    }
    // A 60 Hz il limite di prima, quasi: un frame ogni 50 ms è lento.
    expect(slowFrameLimit(hz(60))).toBeCloseTo(41.67, 1);
    // Mai sotto i 40 ms, e senza vsync misurato il limite fisso.
    expect(slowFrameLimit(hz(240))).toBe(40);
    expect(slowFrameLimit(Infinity)).toBe(40);
  });
});
