import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  currentServiceInTz,
  serviceDayInTz,
  getDatePartInTz,
  SERVICE_DAY_START_HOUR,
  DINNER_START_HOUR,
} from '../../utils/reservationTime';
import { currentService, datePart, serviceDayOf, setSessionTimeZone } from '../../utils/displayTime';

/* Il servizio «di adesso» del client contro quello del server.
 *
 * Il giorno di servizio comincia alle 05:00 del ristorante, la cena alle
 * 17:00: prima delle 5 si è ancora nella cena di ieri. Gli istanti sono in
 * UTC; Roma è UTC+2 d'estate e UTC+1 d'inverno, e nel 2026 l'ora cambia il
 * 29 marzo e il 25 ottobre, all'01:00 UTC. */
const ROMA = 'Europe/Rome';

const servizio = (iso: string, tz = ROMA) => {
  const s = currentServiceInTz(new Date(iso), tz);
  return { date: s.date, shift: s.shift };
};

const turno = (s: { date: string; shift: string }) => ({ date: s.date, shift: s.shift });

// Il fuso del dispositivo si cambia dal processo: process.env.TZ si rilegge
// subito (per questo vitest.unit.config.ts tiene i test in processi, non in
// worker thread), e alla fine si rimette com'era.
const conFusoDelDispositivo = <T>(tz: string, fn: () => T): T => {
  const prima = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prima === undefined) delete process.env.TZ;
    else process.env.TZ = prima;
  }
};

// La data di un Date coi getter del dispositivo: è come la legge la testata
// di App.
const dataDelDispositivo = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* La formula del server, copiata da resolveService (server.ts, sezione
 * «GESTIONALE DI SALA — COMANDE») così com'è: il client deve dare la stessa
 * risposta a ogni ora. server.ts non si importa in un test unitario (avvia
 * il server), quindi la copia sta qui, e le soglie si leggono dal sorgente. */
function resolveServiceDelServer(at: Date, tz: string): { service_date: string; shift: 'LUNCH' | 'DINNER' } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const hour = Number(get('hour'));
  let date = `${get('year')}-${get('month')}-${get('day')}`;

  if (hour < 5) {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    date = d.toISOString().slice(0, 10);
    return { service_date: date, shift: 'DINNER' };
  }
  return { service_date: date, shift: hour < 17 ? 'LUNCH' : 'DINNER' };
}

// Qualche giorno qualunque, le due notti del cambio d'ora in Europa e a New
// York, e capodanno, dove «ieri» è dell'anno prima.
const FINESTRE: Array<[string, string]> = [
  ['2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z'],
  ['2026-03-27T00:00:00Z', '2026-03-31T00:00:00Z'],
  ['2026-10-23T00:00:00Z', '2026-10-27T00:00:00Z'],
  ['2026-03-07T00:00:00Z', '2026-03-10T00:00:00Z'],
  ['2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z'],
  ['2026-12-30T00:00:00Z', '2027-01-02T00:00:00Z'],
];

describe('servizio corrente — i confini, a Roma', () => {
  it('alle 04:59 è ancora la cena di ieri, alle 05:00 è il pranzo di oggi', () => {
    expect(servizio('2026-10-03T02:59:00Z')).toEqual({ date: '2026-10-02', shift: 'DINNER' });
    expect(servizio('2026-10-03T03:00:00Z')).toEqual({ date: '2026-10-03', shift: 'LUNCH' });
  });

  it('alle 16:59 è pranzo, alle 17:00 è cena', () => {
    expect(servizio('2026-10-03T14:59:00Z')).toEqual({ date: '2026-10-03', shift: 'LUNCH' });
    expect(servizio('2026-10-03T15:00:00Z')).toEqual({ date: '2026-10-03', shift: 'DINNER' });
  });

  it('la notte dell\'ora legale non sposta il confine delle 5', () => {
    // 29 marzo: alle 02:00 si va alle 03:00. 02:59Z sono le 04:59 di Roma.
    expect(servizio('2026-03-29T02:59:00Z')).toEqual({ date: '2026-03-28', shift: 'DINNER' });
    expect(servizio('2026-03-29T03:00:00Z')).toEqual({ date: '2026-03-29', shift: 'LUNCH' });
  });

  it('la notte dell\'ora solare non sposta il confine delle 5', () => {
    // 25 ottobre: alle 03:00 si torna alle 02:00. 03:59Z sono le 04:59 di Roma.
    expect(servizio('2026-10-25T03:59:00Z')).toEqual({ date: '2026-10-24', shift: 'DINNER' });
    expect(servizio('2026-10-25T04:00:00Z')).toEqual({ date: '2026-10-25', shift: 'LUNCH' });
  });

  it('un walk-in delle 00:30 è della cena di ieri', () => {
    expect(serviceDayInTz('2026-10-04T22:30:00Z', ROMA)).toBe('2026-10-04');
    expect(serviceDayInTz(new Date('2026-10-04T22:30:00Z'), ROMA)).toBe('2026-10-04');
    // un'ora prima, alle 23:30 del 4, è lo stesso servizio
    expect(serviceDayInTz('2026-10-04T21:30:00Z', ROMA)).toBe('2026-10-04');
    // e alle 05:00 del 5 comincia il giorno nuovo
    expect(serviceDayInTz('2026-10-05T03:00:00Z', ROMA)).toBe('2026-10-05');
  });

  it('senza istante, o con un istante illeggibile, il giorno di servizio è vuoto', () => {
    expect(serviceDayInTz(null, ROMA)).toBe('');
    expect(serviceDayInTz(undefined, ROMA)).toBe('');
    expect(serviceDayInTz('', ROMA)).toBe('');
    expect(serviceDayInTz('non è una data', ROMA)).toBe('');
  });
});

describe('servizio corrente — l\'ancora per setGlobalDate', () => {
  it('di notte torna di sei ore e cade nel giorno di servizio', () => {
    const at = new Date('2026-10-04T22:30:00Z'); // 00:30 del 5 a Roma
    const s = currentServiceInTz(at, ROMA);
    expect(s.anchor.getTime()).toBe(at.getTime() - 6 * 3600 * 1000);
    expect(getDatePartInTz(s.anchor, ROMA)).toBe(s.date);
    expect(s.date).toBe('2026-10-04');
  });

  it('di giorno è l\'istante stesso', () => {
    const at = new Date('2026-10-03T10:00:00Z');
    expect(currentServiceInTz(at, ROMA).anchor.getTime()).toBe(at.getTime());
  });

  it('cade sempre dentro il giorno di servizio, ogni quarto d\'ora, notti del cambio d\'ora comprese', () => {
    for (const tz of [ROMA, 'Europe/London', 'America/New_York', 'Asia/Dubai']) {
      for (const [da, a] of FINESTRE) {
        for (let t = Date.parse(da); t < Date.parse(a); t += 15 * 60 * 1000) {
          const s = currentServiceInTz(new Date(t), tz);
          expect(getDatePartInTz(s.anchor, tz), `${tz} ${new Date(t).toISOString()}`).toBe(s.date);
        }
      }
    }
  });
});

describe('servizio corrente — il fuso è quello del ristorante', () => {
  it('lo stesso istante dà servizi diversi a Roma, Londra e Dubai', () => {
    // 01:30Z: Roma 03:30 e Londra 02:30 sono nella cena di ieri, Dubai 05:30 è già pranzo
    expect(servizio('2026-10-03T01:30:00Z', ROMA)).toEqual({ date: '2026-10-02', shift: 'DINNER' });
    expect(servizio('2026-10-03T01:30:00Z', 'Europe/London')).toEqual({ date: '2026-10-02', shift: 'DINNER' });
    expect(servizio('2026-10-03T01:30:00Z', 'Asia/Dubai')).toEqual({ date: '2026-10-03', shift: 'LUNCH' });
    // 03:30Z: Roma 05:30 è pranzo, Londra 04:30 ancora cena di ieri
    expect(servizio('2026-10-03T03:30:00Z', ROMA)).toEqual({ date: '2026-10-03', shift: 'LUNCH' });
    expect(servizio('2026-10-03T03:30:00Z', 'Europe/London')).toEqual({ date: '2026-10-02', shift: 'DINNER' });
    // 13:30Z: Dubai 17:30 è già cena, Roma 15:30 e Londra 14:30 ancora pranzo
    expect(servizio('2026-10-03T13:30:00Z', 'Asia/Dubai')).toEqual({ date: '2026-10-03', shift: 'DINNER' });
    expect(servizio('2026-10-03T13:30:00Z', ROMA)).toEqual({ date: '2026-10-03', shift: 'LUNCH' });
    // 15:30Z: Roma 17:30 è cena, Londra 16:30 ancora pranzo
    expect(servizio('2026-10-03T15:30:00Z', ROMA)).toEqual({ date: '2026-10-03', shift: 'DINNER' });
    expect(servizio('2026-10-03T15:30:00Z', 'Europe/London')).toEqual({ date: '2026-10-03', shift: 'LUNCH' });
  });

  it('un fuso inventato ricade su Roma invece di esplodere', () => {
    for (const iso of ['2026-10-03T02:59:00Z', '2026-10-03T03:00:00Z', '2026-10-03T15:00:00Z']) {
      expect(() => currentServiceInTz(new Date(iso), 'Europe/Atlantide')).not.toThrow();
      expect(servizio(iso, 'Europe/Atlantide')).toEqual(servizio(iso, ROMA));
    }
    expect(serviceDayInTz('2026-10-04T22:30:00Z', 'Europe/Atlantide')).toBe('2026-10-04');
    expect(servizio('2026-10-03T02:59:00Z', '')).toEqual(servizio('2026-10-03T02:59:00Z', ROMA));
  });

  it('non dipende dal fuso del dispositivo', () => {
    // Il difetto che sostituisce: App leggeva at.getHours(), cioè l'ora del
    // dispositivo. Qui il processo cambia fuso sotto i piedi del calcolo.
    for (const fusoDispositivo of ['Asia/Dubai', 'America/Los_Angeles', 'UTC']) {
      conFusoDelDispositivo(fusoDispositivo, () => {
        // il cambio di fuso deve aver preso, o il test non proverebbe niente
        const oraLocale = new Date('2026-10-03T12:00:00Z').getHours();
        expect(oraLocale).toBe({ 'Asia/Dubai': 16, 'America/Los_Angeles': 5, UTC: 12 }[fusoDispositivo]);
        expect(servizio('2026-10-03T02:59:00Z')).toEqual({ date: '2026-10-02', shift: 'DINNER' });
        expect(servizio('2026-10-03T03:00:00Z')).toEqual({ date: '2026-10-03', shift: 'LUNCH' });
        expect(servizio('2026-10-03T15:00:00Z')).toEqual({ date: '2026-10-03', shift: 'DINNER' });
      });
    }
  });
});

describe('servizio corrente — client e server dicono la stessa cosa', () => {
  it('le soglie sono quelle di server.ts', () => {
    const server = readFileSync(fileURLToPath(new URL('../../server.ts', import.meta.url)), 'utf8');
    const soglia = (nome: string) => Number(server.match(new RegExp(`^const ${nome} = (\\d+);`, 'm'))?.[1]);
    expect(soglia('SERVICE_DAY_START_HOUR')).toBe(SERVICE_DAY_START_HOUR);
    expect(soglia('DINNER_START_HOUR')).toBe(DINNER_START_HOUR);
    expect(SERVICE_DAY_START_HOUR).toBe(5);
    expect(DINNER_START_HOUR).toBe(17);
  });

  it('a ogni ora di qualche giorno, a Roma e a Londra (e a New York e Dubai)', () => {
    let confronti = 0;
    for (const tz of [ROMA, 'Europe/London', 'America/New_York', 'Asia/Dubai']) {
      for (const [da, a] of FINESTRE) {
        // ogni quarto d'ora: prende le ore piene e i minuti a cavallo
        for (let t = Date.parse(da); t < Date.parse(a); t += 15 * 60 * 1000) {
          const at = new Date(t);
          const server = resolveServiceDelServer(at, tz);
          const client = currentServiceInTz(at, tz);
          expect({ date: client.date, shift: client.shift }, `${tz} ${at.toISOString()}`)
            .toEqual({ date: server.service_date, shift: server.shift });
          confronti++;
        }
      }
    }
    expect(confronti).toBeGreaterThan(5000);
  });
});

describe('servizio corrente — nel client, il fuso della sessione', () => {
  afterEach(() => {
    setSessionTimeZone(null);
    vi.useRealTimers();
  });

  it('finché nessuno lo imposta, è il servizio di Roma', () => {
    const at = new Date('2026-10-03T02:59:00Z');
    expect(turno(currentService(at))).toEqual({ date: '2026-10-02', shift: 'DINNER' });
    // su un dispositivo a ora di Roma l'ancora è proprio quella del ristorante
    conFusoDelDispositivo(ROMA, () => {
      expect(currentService(at)).toEqual(currentServiceInTz(at, ROMA));
    });
    expect(serviceDayOf('2026-10-04T22:30:00Z')).toBe('2026-10-04');
  });

  it('con un ristorante a Londra segue l\'ora di Londra', () => {
    setSessionTimeZone('Europe/London');
    const at = new Date('2026-10-03T03:30:00Z'); // Londra 04:30, Roma 05:30
    expect(turno(currentService(at))).toEqual({ date: '2026-10-02', shift: 'DINNER' });
    conFusoDelDispositivo('Europe/London', () => {
      expect(currentService(at)).toEqual(currentServiceInTz(at, 'Europe/London'));
    });
    // 03:30Z del 3: a Londra sono le 04:30, ancora la cena del 2; a Roma le
    // 05:30, già il giorno del 3
    expect(serviceDayOf('2026-10-03T03:30:00Z')).toBe('2026-10-02');
    expect(serviceDayInTz('2026-10-03T03:30:00Z', ROMA)).toBe('2026-10-03');
  });

  it('senza argomenti legge l\'orologio di adesso', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T03:30:00Z')); // Roma 05:30
    conFusoDelDispositivo(ROMA, () => {
      const s = currentService();
      expect(turno(s)).toEqual({ date: '2026-10-03', shift: 'LUNCH' });
      expect(s.anchor.getTime()).toBe(Date.parse('2026-10-03T03:30:00Z'));
    });
  });
});

describe('servizio corrente — l\'ancora nelle due letture di App', () => {
  // App legge globalDate in due modi: coi getter del dispositivo (la testata,
  // la piantina, le prenotazioni) e con datePart nel fuso del ristorante (la
  // cassa, la cucina, i pagamenti). Tutte e due devono dare la data del
  // servizio, anche su un portatile rimasto in un altro fuso.
  afterEach(() => setSessionTimeZone(null));

  const FUSI_DEL_DISPOSITIVO = [ROMA, 'Europe/London', 'Asia/Dubai', 'Asia/Tokyo', 'America/New_York', 'America/Los_Angeles', 'UTC'];

  it('alle 22:30 di Roma un Mac a Dubai resta su stasera, non salta a domani', () => {
    conFusoDelDispositivo('Asia/Dubai', () => {
      const at = new Date('2026-10-03T20:30:00Z'); // Roma 22:30, Dubai già 00:30 del 4
      const s = currentService(at);
      expect(turno(s)).toEqual({ date: '2026-10-03', shift: 'DINNER' });
      expect(dataDelDispositivo(s.anchor)).toBe('2026-10-03');
      expect(datePart(s.anchor)).toBe('2026-10-03');
    });
  });

  it('cade nel giorno del servizio in tutte e due le letture, da qualunque fuso del dispositivo', () => {
    let confronti = 0;
    for (const fusoRistorante of [ROMA, 'Europe/London']) {
      setSessionTimeZone(fusoRistorante);
      for (const fusoDispositivo of FUSI_DEL_DISPOSITIVO) {
        conFusoDelDispositivo(fusoDispositivo, () => {
          for (const [da, a] of FINESTRE) {
            for (let t = Date.parse(da); t < Date.parse(a); t += 15 * 60 * 1000) {
              const at = new Date(t);
              const s = currentService(at);
              const delRistorante = currentServiceInTz(at, fusoRistorante);
              const dove = `ristorante ${fusoRistorante}, dispositivo ${fusoDispositivo}, ${at.toISOString()}`;
              expect(turno(s), dove).toEqual(turno(delRistorante));
              expect(dataDelDispositivo(s.anchor), dove).toBe(s.date);
              expect(datePart(s.anchor), dove).toBe(s.date);
              // sul dispositivo del locale l'ancora non cambia: è quella di
              // sempre, l'istante o sei ore prima
              if (fusoDispositivo === fusoRistorante) {
                expect(s.anchor.getTime(), dove).toBe(delRistorante.anchor.getTime());
              }
              confronti++;
            }
          }
        });
      }
    }
    expect(confronti).toBeGreaterThan(20000);
  });

  it('con i fusi a più di 12 ore di distanza resta l\'ancora del ristorante', () => {
    // Kiritimati è a UTC+14, Los Angeles a UTC−7: il mezzogiorno del
    // dispositivo cadrebbe nel giorno prima per il ristorante. Vince la
    // lettura del ristorante, su cui il giro di App decide se avanzare.
    setSessionTimeZone('America/Los_Angeles');
    conFusoDelDispositivo('Pacific/Kiritimati', () => {
      let testataFuori = 0;
      for (const [da, a] of FINESTRE) {
        for (let t = Date.parse(da); t < Date.parse(a); t += 15 * 60 * 1000) {
          const at = new Date(t);
          const s = currentService(at);
          expect(s, at.toISOString()).toEqual(currentServiceInTz(at, 'America/Los_Angeles'));
          expect(datePart(s.anchor), at.toISOString()).toBe(s.date);
          if (dataDelDispositivo(s.anchor) !== s.date) testataFuori++;
        }
      }
      // il caso c'è davvero: senza questo, il test non proverebbe niente
      expect(testataFuori).toBeGreaterThan(0);
    });
  });
});
