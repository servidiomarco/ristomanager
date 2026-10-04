import { describe, it, expect } from 'vitest';
import {
  FPS_ACTIVE,
  FPS_AMBIENT,
  FPS_PULSE,
  MIN_MOTION_WAKE_MS,
  createFrameDemand,
  expectedFrameMs,
  lightFrameLimit,
  motionFps,
  motionWakeAtFrom,
  nextWakeAt,
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

describe('il regista chiede i frame (PR3)', () => {
  const ADESSO = 50_000;

  it('30 fps mentre un ospite o l\'hostess si muovono, 20 coi soli camerieri, 0 da fermi', () => {
    const d = createFrameDemand();
    expect(d.motion).toBe('none');
    expect(d.motionWakeAt).toBe(Infinity);
    expect(targetFps(d, ADESSO, false)).toBe(0);
    d.motion = 'ambient';
    expect(targetFps(d, ADESSO, false)).toBe(FPS_AMBIENT);
    expect(FPS_AMBIENT).toBe(20);
    d.motion = 'active';
    expect(targetFps(d, ADESSO, false)).toBe(FPS_ACTIVE);
    // Un valore che questo client non conosce non chiede niente.
    expect(motionFps('presto' as never)).toBe(0);
    expect(motionFps(undefined)).toBe(0);
  });

  it('si prende il più alto fra regista, anello e camera; in modalità lenta mai oltre 15', () => {
    const d = conAnello();
    const vivo = 10 * PERIODO;
    d.motion = 'ambient';
    expect(targetFps(d, vivo, false)).toBe(FPS_AMBIENT);
    d.motion = 'none';
    expect(targetFps(d, vivo, false)).toBe(FPS_PULSE);
    d.motion = 'ambient';
    d.interacting = true;
    expect(targetFps(d, vivo, false)).toBe(FPS_ACTIVE);
    d.interacting = false;
    d.motion = 'active';
    expect(targetFps(d, vivo, true)).toBe(15);
    d.motion = 'ambient';
    expect(targetFps(d, vivo, true)).toBe(15);
  });

  it('da fermi ci si risveglia al primo fra l\'anello e il cameriere che riparte', () => {
    const d = conAnello();
    const ciclo = 10 * PERIODO;
    const morto = ciclo + VIVO + 200;
    const anello = ciclo + PERIODO;
    // Solo l'anello.
    expect(nextWakeAt(d, morto)).toBeCloseTo(anello, 6);
    // Il cameriere prima dell'anello.
    d.motionWakeAt = morto + 100;
    expect(nextWakeAt(d, morto)).toBe(morto + 100);
    // Dopo l'anello: vince l'anello.
    d.motionWakeAt = anello + 500;
    expect(nextWakeAt(d, morto)).toBeCloseTo(anello, 6);
    // Senza anello, solo il cameriere; un istante già passato non conta.
    const fermo = createFrameDemand();
    fermo.motionWakeAt = ADESSO + 3000;
    expect(nextWakeAt(fermo, ADESSO)).toBe(ADESSO + 3000);
    fermo.motionWakeAt = ADESSO - 1;
    expect(nextWakeAt(fermo, ADESSO)).toBeNull();
    fermo.motionWakeAt = Infinity;
    expect(nextWakeAt(fermo, ADESSO)).toBeNull();
    fermo.motionWakeAt = NaN;
    expect(nextWakeAt(fermo, ADESSO)).toBeNull();
  });

  it('il risveglio da wakeInMs: mai prima di un frame d\'ambiente, Infinity senza attesa', () => {
    expect(motionWakeAtFrom(null, ADESSO)).toBe(Infinity);
    expect(motionWakeAtFrom(undefined, ADESSO)).toBe(Infinity);
    expect(motionWakeAtFrom(NaN, ADESSO)).toBe(Infinity);
    expect(motionWakeAtFrom(4000, ADESSO)).toBe(ADESSO + 4000);
    expect(motionWakeAtFrom(0, ADESSO)).toBe(ADESSO + MIN_MOTION_WAKE_MS);
    expect(motionWakeAtFrom(-20, ADESSO)).toBe(ADESSO + MIN_MOTION_WAKE_MS);
    expect(MIN_MOTION_WAKE_MS).toBe(50);
  });
});

describe('la modalità leggera (niente camerieri)', () => {
  const hz = (n: number) => 1000 / n;

  it('50 ms a 30 fps su 60 Hz, 75 a 20 fps; il vsync lento alza il limite', () => {
    expect(lightFrameLimit(FPS_ACTIVE, hz(60))).toBeCloseTo(50, 6);
    expect(lightFrameLimit(FPS_ACTIVE, hz(120))).toBeCloseTo(50, 6);
    expect(lightFrameLimit(FPS_ACTIVE, Infinity)).toBeCloseTo(50, 6);
    expect(lightFrameLimit(FPS_AMBIENT, hz(60))).toBeCloseTo(75, 6);
    expect(lightFrameLimit(FPS_AMBIENT, Infinity)).toBeCloseTo(75, 6);
    // A 50 Hz 30 fps sono un frame ogni 40 ms (il vsync), 20 fps uno ogni 60.
    expect(lightFrameLimit(FPS_ACTIVE, hz(50))).toBeCloseTo(60, 6);
    expect(lightFrameLimit(FPS_AMBIENT, hz(50))).toBeCloseTo(90, 6);
    // Senza un ritmo non c'è limite.
    expect(lightFrameLimit(0, hz(60))).toBe(Infinity);
  });

  it('un timer a 20 fps su un pannello a 60 Hz (50-67 ms) non la fa scattare; frame doppi sì', () => {
    for (const n of [50, 60, 120]) {
      const peggiore = 1000 / FPS_AMBIENT + hz(n);
      expect(peggiore, `${n} Hz`).toBeLessThan(lightFrameLimit(FPS_AMBIENT, hz(n)));
      expect(2 * expectedFrameMs(FPS_AMBIENT, hz(n)), `${n} Hz`).toBeGreaterThan(lightFrameLimit(FPS_AMBIENT, hz(n)));
    }
    // A 30 fps: il ritmo dello schermo più un millisecondo non scatta, un
    // frame su due perso (50 ms di media, poi oltre) sì.
    expect(expectedFrameMs(FPS_ACTIVE, hz(60)) + 1).toBeLessThan(lightFrameLimit(FPS_ACTIVE, hz(60)));
    expect(expectedFrameMs(FPS_ACTIVE, hz(60)) * 1.6).toBeGreaterThan(lightFrameLimit(FPS_ACTIVE, hz(60)));
  });
});
