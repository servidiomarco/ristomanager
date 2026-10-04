import { describe, it, expect } from 'vitest';
import { hashString, mulberry32, partyRng, staffRng, uniform } from '../../components/salaVivo/model/rng';

/* Il caso del regista: lo stesso seme deve dare la stessa sequenza oggi,
 * domani e su ogni dispositivo, o la TV e il tablet della stessa sala
 * mettono in scena due coreografie diverse. I numeri qui sono fissati: se
 * cambiano, è cambiato il generatore. */

// Il mescolamento finale di MurmurHash3, riscritto qui per controllare che
// hashString sia davvero FNV-1a (vettori noti) seguito da fmix32.
const fmix32 = (x: number): number => {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};

describe('mulberry32', () => {
  it('una sequenza fissa per un seme fisso', () => {
    const r = mulberry32(1);
    expect([r(), r(), r(), r(), r()]).toEqual([
      0.6270739405881613,
      0.002735721180215478,
      0.5274470399599522,
      0.9810509674716741,
      0.9683778982143849,
    ]);
    const s = mulberry32(0x53414c41);
    expect([s(), s(), s()]).toEqual([0.8353118586819619, 0.07179402536712587, 0.6502082068473101]);
  });

  it('due generatori con lo stesso seme vanno di pari passo; semi diversi no', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const sa = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(sa);
    expect(Array.from({ length: 50 }, () => c())).not.toEqual(sa);
  });

  it('sempre in [0, 1), anche dopo molte chiamate, e un seme illeggibile vale 0', () => {
    const r = mulberry32(0xffffffff);
    for (let i = 0; i < 100_000; i++) {
      const v = r();
      if (!(v >= 0 && v < 1)) throw new Error(`fuori da [0, 1): ${v}`);
    }
    const nan = mulberry32(Number.NaN);
    const zero = mulberry32(0);
    expect([nan(), nan()]).toEqual([zero(), zero()]);
  });
});

describe('hashString', () => {
  it('FNV-1a sui code unit, poi fmix32: valori noti', () => {
    // FNV-1a a 32 bit: '' → 811c9dc5, 'a' → e40c292c, 'abc' → 1a47e90b.
    expect(hashString('')).toBe(fmix32(0x811c9dc5));
    expect(hashString('a')).toBe(fmix32(0xe40c292c));
    expect(hashString('abc')).toBe(fmix32(0x1a47e90b));
    expect(hashString('2026-10-04:DINNER:42')).toBe(635247517);
    expect(hashString('waiter:anon0')).toBe(1620675048);
  });

  it('un intero a 32 bit senza segno, stabile, diverso per chiavi vicine', () => {
    const keys = Array.from({ length: 200 }, (_, i) => `2026-10-04:DINNER:${i}`);
    const hashes = keys.map(hashString);
    for (const h of hashes) {
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
    expect(new Set(hashes).size).toBe(keys.length);
    expect(keys.map(hashString)).toEqual(hashes);
    // I code unit, non i byte: una lettera accentata conta per una.
    expect(hashString('Più')).not.toBe(hashString('Piu'));
  });
});

describe('il caso di comitive e camerieri', () => {
  it('una comitiva: dal servizio e dalla prenotazione, non dall\'ordine in cui la si incontra', () => {
    const a = partyRng('2026-10-04:DINNER', 42);
    expect([a(), a()]).toEqual([0.1149118875619024, 0.06993187451735139]);
    const b = partyRng('2026-10-04:DINNER', 42);
    const c = mulberry32(hashString('2026-10-04:DINNER:42'));
    expect(b()).toBe(c());
    // Un altro servizio, o un'altra prenotazione: un'altra sequenza.
    expect(partyRng('2026-10-04:LUNCH', 42)()).not.toBe(partyRng('2026-10-04:DINNER', 42)());
    expect(partyRng('2026-10-04:DINNER', 43)()).not.toBe(partyRng('2026-10-04:DINNER', 42)());
  });

  it('un cameriere: il seme del regista e la sua chiave', () => {
    const w = staffRng(0x53414c41, 'waiter:anon0');
    expect([w(), w()]).toEqual([0.4728598417714238, 0.19985535577870905]);
    const ref = mulberry32((0x53414c41 ^ hashString('waiter:anon0')) >>> 0);
    const again = staffRng(0x53414c41, 'waiter:anon0');
    expect(again()).toBe(ref());
    expect(staffRng(7, 'waiter:anon0')()).not.toBe(staffRng(0x53414c41, 'waiter:anon0')());
  });

  it('uniform sta nell\'intervallo, e copre tutto l\'intervallo', () => {
    const r = mulberry32(99);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 10_000; i++) {
      const v = uniform(r, 2000, 6000);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      if (!(v >= 2000 && v < 6000)) throw new Error(`fuori: ${v}`);
    }
    expect(lo).toBeLessThan(2010);
    expect(hi).toBeGreaterThan(5990);
    expect(uniform(() => 0, 3, 8)).toBe(3);
    expect(uniform(() => 0.5, 3, 8)).toBe(5.5);
  });
});
