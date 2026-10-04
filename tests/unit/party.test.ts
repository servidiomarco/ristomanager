import { describe, it, expect } from 'vitest';
import {
  ArrivalStatus,
  PaymentStatus,
  ReservationStatus,
  Shift,
  type NoteSelection,
  type Reservation,
} from '../../types';
import type { NotePresetRef } from '../../components/salaVivo/types';
import {
  BABY_FALLBACK_LABELS,
  DOG_FALLBACK_LABELS,
  MAX_DOGS,
  composeParty,
  countMentions,
  partyLabels,
} from '../../components/salaVivo/model/party';
import { MAX_PARTY_PEOPLE, peopleOf } from '../../components/salaVivo/model/presence';

/* Chi c'è in una comitiva: adulti, bambini, cani e seggiolone, dai campi
 * della prenotazione e dalle note. Il cane e il seggiolone si riconoscono
 * dalle etichette dei preset delle note (icona 'dog' e 'baby'), con «Cane» e
 * «Seggiolone» di ripiego. */

const prenotazione = (over: Partial<Reservation> = {}): Reservation => ({
  id: 1,
  customer_name: 'Esposito',
  reservation_time: '2026-10-04T18:00:00.000Z',
  shift: Shift.DINNER,
  guests: 4,
  table_id: 40,
  payment_status: PaymentStatus.PENDING,
  arrival_status: ArrivalStatus.ARRIVED,
  reservation_status: ReservationStatus.CONFIRMED,
  ...over,
});

const RIPIEGO = partyLabels([]);
const cani = (notes: unknown, note_selections?: unknown, labels: readonly string[] = RIPIEGO.dog) =>
  countMentions({ notes: notes as string, note_selections: note_selections as NoteSelection[] }, labels);
const scelta = (label: string, quantity: unknown): NoteSelection =>
  ({ preset_id: 9, label, quantity: quantity as number });

describe('la comitiva', () => {
  it('quattro ospiti, due bambini e «Cane» nelle note: due adulti, due bambini, un cane', () => {
    expect(composeParty(prenotazione({ guests: 4, children: 2, notes: 'Cane' }), RIPIEGO))
      .toEqual({ adults: 2, kids: 2, dogs: 1, highChair: false });
  });

  it('i bambini sono una parte degli ospiti, letti con prudenza', () => {
    const conta = (over: Partial<Reservation>) => {
      const { adults, kids } = composeParty(prenotazione(over), RIPIEGO);
      return [adults, kids];
    };
    expect(conta({ guests: 4, children: 6 })).toEqual([0, 4]);
    expect(conta({ guests: 0 })).toEqual([1, 0]);
    expect(conta({ guests: -3, children: 2 })).toEqual([0, 1]);
    expect(conta({ guests: '3' as unknown as number, children: '1' as unknown as number })).toEqual([2, 1]);
    expect(conta({ guests: Number.NaN })).toEqual([1, 0]);
    expect(conta({ guests: 5.8, children: 1.7 })).toEqual([4, 1]);
    expect(conta({ guests: 3, children: -2 })).toEqual([3, 0]);
  });

  it('adulti più bambini sono sempre le persone che il riassunto conta', () => {
    for (const guests of [0, 1, 2, 7, 12.5, Number.NaN, -1, 1e9, '4' as unknown as number]) {
      for (const children of [undefined, 0, 1, 3, 20]) {
        for (const notes of [undefined, 'Seggiolone', '2× Cane, Seggiolone']) {
          const r = prenotazione({ guests, children, notes });
          const { adults, kids } = composeParty(r, RIPIEGO);
          expect(adults + kids).toBe(peopleOf(r));
        }
      }
    }
    // Un numero sbagliato non disegna diecimila persone.
    expect(peopleOf(prenotazione({ guests: 10_000 }))).toBe(MAX_PARTY_PEOPLE);
    expect(peopleOf(null)).toBe(0);
  });
});

describe('il cane, dalle note', () => {
  it('«canederli» non è un cane; «cane» come parola sì, maiuscole o no', () => {
    expect(cani('canederli al burro')).toBe(0);
    expect(cani('cane2')).toBe(0);
    expect(cani('Cani')).toBe(0);
    expect(cani('Cane')).toBe(1);
    expect(cani('fuori, col CANE.')).toBe(1);
    expect(cani('Allergia noci | Cane | compleanno')).toBe(1);
    expect(cani('«cane»')).toBe(1);
  });

  it('le lettere accentate, composte o con l\'accento staccato (NFD), sono lettere e non confini', () => {
    const nfd = (s: string) => s.normalize('NFD');
    expect(nfd('Canè')).not.toBe('Canè');
    // «Canè» non è «Cane», anche con l'accento staccato dopo la «e».
    expect(cani('Canè')).toBe(0);
    expect(cani(nfd('Canè'))).toBe(0);
    expect(cani(nfd('2× Canè'))).toBe(0);
    // Una lettera accentata attaccata davanti non è un confine.
    expect(cani('àcane')).toBe(0);
    expect(cani(nfd('àcane'))).toBe(0);
    // Accanto, separata da uno spazio o da una virgola, sì.
    expect(cani(nfd('caffè, cane'))).toBe(1);
    expect(cani('città cane')).toBe(1);
    // Un'etichetta accentata combacia con le note scritte nell'altra forma.
    expect(countMentions({ notes: nfd('Bebè') }, ['Bebè'])).toBe(1);
    expect(countMentions({ notes: 'Bebè' }, [nfd('Bebè')])).toBe(1);
    expect(countMentions({ notes: nfd('2× Bebè') }, ['Bebè'])).toBe(2);
    expect(countMentions({ notes: 'Bebèè' }, ['Bebè'])).toBe(0);
    expect(countMentions({ notes: '', note_selections: [scelta(nfd('bebè '), 2)] }, ['Bebè'])).toBe(2);
  });

  it('«2× Cane» sono due cani, «3x cane» tre, ma se ne disegnano al più due', () => {
    expect(cani('2× Cane')).toBe(2);
    expect(cani('2×Cane')).toBe(2);
    expect(cani('2 x cane')).toBe(2);
    expect(cani('2 X CANE')).toBe(2);
    expect(cani('1× Cane, 1× Cane')).toBe(2);
    expect(cani('3x cane')).toBe(3);
    expect(MAX_DOGS).toBe(2);
    expect(composeParty(prenotazione({ notes: '3x cane' }), RIPIEGO).dogs).toBe(2);
    // «2× Canederli» resta un piatto.
    expect(cani('2× Canederli')).toBe(0);
  });

  it('una scelta strutturata vince sulle note che la riportano, e non conta due volte', () => {
    // ReservationList scrive le scelte anche nelle note, in chiaro: «2× Cane».
    expect(cani('1× Cane', [scelta('cane ', 2)])).toBe(2);
    expect(cani('2× Cane', [scelta('Cane', 2)])).toBe(2);
    // Righe da sommare, quantità lette con prudenza (almeno 1 a riga).
    expect(cani('', [scelta('Cane', 1), scelta('CANE', 1)])).toBe(2);
    expect(cani('', [scelta('Cane', 'tanti'), scelta('Cane', 0)])).toBe(2);
    expect(cani('', [scelta('Cane', '2')])).toBe(2);
    // Un'altra scelta non conta, e le note restano valide.
    expect(cani('Cane', [scelta('Stinco', 3)])).toBe(1);
    // Scelte che non sono un array, o righe rotte: si guardano le note.
    expect(cani('Cane', 'Cane')).toBe(1);
    expect(cani('Cane', [null, 'Cane', { label: 5, quantity: 2 }])).toBe(1);
  });

  it('note assenti, strane, o etichette vuote: nessun cane', () => {
    expect(countMentions({}, ['Cane'])).toBe(0);
    expect(cani(42)).toBe(0);
    expect(cani(null)).toBe(0);
    expect(countMentions({ notes: 'Cane' }, [])).toBe(0);
    // Un'etichetta vuota non deve combaciare con qualunque cosa.
    expect(countMentions({ notes: 'qualunque cosa' }, ['', '  '])).toBe(0);
    expect(countMentions(null as unknown as Reservation, ['Cane'])).toBe(0);
  });
});

describe('il seggiolone', () => {
  it('senza bambini segnati, uno degli adulti è il bambino', () => {
    expect(composeParty(prenotazione({ guests: 3, children: 0, notes: 'Seggiolone' }), RIPIEGO))
      .toEqual({ adults: 2, kids: 1, dogs: 0, highChair: true });
  });

  it('da solo resta un adulto; con i bambini segnati non cambia niente', () => {
    expect(composeParty(prenotazione({ guests: 1, notes: 'seggiolone' }), RIPIEGO))
      .toEqual({ adults: 1, kids: 0, dogs: 0, highChair: true });
    expect(composeParty(prenotazione({ guests: 4, children: 2, notes: 'Seggiolone, Cane' }), RIPIEGO))
      .toEqual({ adults: 2, kids: 2, dogs: 1, highChair: true });
  });

  it('anche da una scelta strutturata', () => {
    const r = prenotazione({ guests: 2, note_selections: [scelta('Seggiolone', 1)] });
    expect(composeParty(r, RIPIEGO)).toEqual({ adults: 1, kids: 1, dogs: 0, highChair: true });
  });
});

describe('le etichette dei preset', () => {
  it('quelle con icona \'dog\' e \'baby\', nell\'ordine dei preset, una volta sola, poi «Cane» e «Seggiolone»', () => {
    const presets: NotePresetRef[] = [
      { label: 'Stinco', icon: null },
      { label: 'Cani', icon: 'dog' },
      { label: ' cani ', icon: ' dog ' },
      { label: 'Cane guida', icon: 'dog' },
      { label: 'Seggiolone bimbo', icon: 'baby' },
      { label: 'seggiolone', icon: 'baby' },
    ];
    expect(partyLabels(presets)).toEqual({ dog: ['Cani', 'Cane guida', 'Cane'], baby: ['Seggiolone bimbo', 'seggiolone'] });
  });

  it('con le etichette dei preset contano le loro, e «Cane» resta valido', () => {
    const etichette = partyLabels([{ label: 'Cani', icon: 'dog' }]);
    expect(countMentions({ notes: 'Cani' }, etichette.dog)).toBe(1);
    expect(countMentions({ notes: 'Cane' }, etichette.dog)).toBe(1);
    expect(countMentions({ notes: 'Gatto' }, etichette.dog)).toBe(0);
    expect(composeParty(prenotazione({ notes: '2× Cani' }), etichette).dogs).toBe(2);
    // Il seggiolone, senza preset 'baby', resta quello di ripiego.
    expect(etichette.baby).toEqual(['Seggiolone']);
  });

  it('un preset rinominato non toglie il cane né il seggiolone alle prenotazioni di prima', () => {
    // Note e scelte portano l'etichetta di quando la prenotazione è stata
    // salvata: «1× Cane», anche dopo che il preset è diventato «Cane al seguito».
    const etichette = partyLabels([
      { label: 'Cane al seguito', icon: 'dog' },
      { label: 'Sedia alta', icon: 'baby' },
    ]);
    expect(etichette).toEqual({ dog: ['Cane al seguito', 'Cane'], baby: ['Sedia alta', 'Seggiolone'] });
    const prima = prenotazione({ notes: '1× Cane', note_selections: [scelta('Cane', 1)] });
    expect(composeParty(prima, etichette).dogs).toBe(1);
    expect(composeParty(prenotazione({ notes: 'Cane' }), etichette).dogs).toBe(1);
    // Le prenotazioni nuove, col nome nuovo.
    expect(composeParty(prenotazione({ notes: '2× Cane al seguito' }), etichette).dogs).toBe(2);
    expect(composeParty(prenotazione({ note_selections: [scelta('Cane al seguito', 1)] }), etichette).dogs).toBe(1);
    expect(composeParty(prenotazione({ guests: 3, notes: 'Seggiolone' }), etichette).highChair).toBe(true);
    expect(composeParty(prenotazione({ guests: 3, notes: 'Sedia alta' }), etichette).highChair).toBe(true);
  });

  it('senza preset, o con righe rotte, valgono «Cane» e «Seggiolone»', () => {
    expect(DOG_FALLBACK_LABELS).toEqual(['Cane']);
    expect(BABY_FALLBACK_LABELS).toEqual(['Seggiolone']);
    for (const presets of [undefined, null, [], 'Cane', [null, 'x', { label: 5, icon: 'dog' }, { label: '  ', icon: 'dog' }]]) {
      expect(partyLabels(presets as NotePresetRef[])).toEqual({ dog: ['Cane'], baby: ['Seggiolone'] });
    }
    // Il ripiego è una copia: cambiarla non cambia la costante.
    const l = partyLabels([]);
    l.dog.push('Gatto');
    expect(partyLabels([]).dog).toEqual(['Cane']);
  });

  it('un\'etichetta coi metacaratteri si prende alla lettera', () => {
    expect(countMentions({ notes: 'Cane (taglia S)' }, ['Cane (taglia S)'])).toBe(1);
    expect(countMentions({ notes: '2× Cane (taglia S)' }, ['Cane (taglia S)'])).toBe(2);
    expect(countMentions({ notes: 'Cane' }, ['C.ne'])).toBe(0);
    expect(countMentions({ notes: 'C.ne' }, ['C.ne'])).toBe(1);
    expect(countMentions({ notes: 'Caneee' }, ['Cane+'])).toBe(0);
    expect(countMentions({ notes: 'Cane+' }, ['Cane+'])).toBe(1);
    expect(countMentions({ notes: '[Cane]' }, ['[Cane]', 'a|b', '$^\\'])).toBe(1);
    // Gli spazi dell'etichetta valgono qualunque spazio.
    expect(countMentions({ notes: 'Cane   piccolo' }, ['Cane piccolo'])).toBe(1);
  });

  it('«Cane piccolo» e «Cane»: «2× Cane piccolo» sono due, non quattro', () => {
    expect(countMentions({ notes: '2× Cane piccolo' }, ['Cane', 'Cane piccolo'])).toBe(2);
    expect(countMentions({ notes: '2× Cane piccolo' }, ['Cane piccolo', 'Cane'])).toBe(2);
    expect(countMentions({ notes: '2× Cane piccolo, 1× Cane' }, ['Cane', 'Cane piccolo'])).toBe(3);
  });
});
