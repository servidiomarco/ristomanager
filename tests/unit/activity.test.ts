import { beforeAll, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import i18next, { type TFunction } from 'i18next';
import type { DirectorEvent, PartyRef, PartyState } from '../../components/salaVivo/types';
import {
  STRIP_MAX,
  addStripItems,
  peopleText,
  revealStripItems,
  stillTrue,
  stripItemsOf,
  stripLine,
  withoutEscort,
  type StripItem,
} from '../../components/salaVivo/model/activity';

/* La striscia delle attività della Sala dal vivo: le righe che nascono dagli
 * eventi del regista, quelle che un annullamento smentisce, i riallineamenti
 * che si sommano, e che cosa si legge e che cosa si sente. Le traduzioni
 * sono quelle vere (public/locales), con i18next. */

const dizionario = (lang: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../public/locales/${lang}/salavivo.json`, import.meta.url)), 'utf8'));

let t: TFunction;
let en: TFunction;
beforeAll(async () => {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: 'it',
    fallbackLng: 'it',
    ns: ['salavivo'],
    defaultNS: 'salavivo',
    resources: { it: { salavivo: dizionario('it') }, en: { salavivo: dizionario('en') } },
    interpolation: { escapeValue: false },
  });
  t = i18n.getFixedT('it', 'salavivo');
  en = i18n.getFixedT('en', 'salavivo');
});

const famiglia: PartyRef = { id: 301, name: 'Famiglia Esposito', adults: 2, kids: 2, dogs: 1 };
const coppia: PartyRef = { id: 330, name: null, adults: 2, kids: 0, dogs: 0 };
const t40 = { id: 40, name: '40' };
const t41 = { id: 41, name: '41' };

let seq = 0;
const nuovo = () => ++seq;
const fase = (id: number, phase: PartyState['phase'], tableId: number | null = null): PartyState =>
  ({ id, phase, roomId: tableId === null ? null : 2, tableId, people: 4, banquet: false });

const escort = (party: PartyRef, table = t40, until = 1000): StripItem =>
  stripItemsOf({ kind: 'escort-start', at: 0, roomId: 2, party, table, from: 'entrance' }, nuovo, until)[0];

describe('le righe degli eventi', () => {
  it('una per arrivo, ingresso, cambio di tavolo, uscita, riallineamento; una per comitiva seduta di colpo; nessuna per la fine', () => {
    const ev: DirectorEvent[] = [
      { kind: 'escort-start', at: 0, roomId: 2, party: famiglia, table: t40, from: 'entrance' },
      { kind: 'escort-end', at: 0, roomId: 2, partyId: 301, tableId: 40, seated: true },
      { kind: 'lobby', at: 0, roomId: 2, party: coppia },
      { kind: 'moved', at: 0, roomId: 2, party: famiglia, from: t40, to: t41 },
      // La fine del cambio di tavolo (l'anello del 41 si spegne): la riga è
      // quella del cambio, arrivato o no.
      { kind: 'moved-end', at: 0, roomId: 2, partyId: 301, tableId: 41, seated: true },
      { kind: 'moved-end', at: 0, roomId: 2, partyId: 301, tableId: 41, seated: false },
      { kind: 'leaving', at: 0, roomId: 2, party: famiglia, table: t41 },
      { kind: 'bulk', at: 0, count: 3 },
      { kind: 'bulk', at: 0, count: 0 },
      { kind: 'snapped', at: 0, roomId: 2, reason: 'queue', parties: [{ party: famiglia, table: t40 }, { party: coppia, table: t41 }] },
    ];
    const kinds = ev.map(e => stripItemsOf(e, nuovo, 5).map(i => i.kind));
    expect(kinds).toEqual([['escort'], [], ['lobby'], ['moved'], [], [], ['leaving'], ['bulk'], [], ['large', 'large']]);
  });

  it('le nuove in cima, al più 4; un riallineamento dopo un altro si somma, e il tempo riparte', () => {
    let items: StripItem[] = [];
    for (let i = 0; i < 6; i++) items = addStripItems(items, [escort(famiglia)]);
    expect(items.length).toBe(STRIP_MAX);
    // A scheda nascosta ogni aggiornamento porta il suo «1 tavolo aggiornato».
    let nascosti: StripItem[] = [escort(coppia)];
    for (const count of [1, 1, 2]) {
      nascosti = addStripItems(nascosti, stripItemsOf({ kind: 'bulk', at: 0, count }, nuovo, Infinity));
    }
    expect(nascosti.map(i => (i.kind === 'bulk' ? `bulk ${i.count}` : i.kind))).toEqual(['bulk 4', 'escort']);
    // Tornando visibili i 90 s partono; le righe già a tempo restano com'erano.
    const visti = revealStripItems(nascosti, 9000);
    expect(visti.map(i => i.until)).toEqual([9000, 1000]);
    expect(revealStripItems(visti, 12000)).toBe(visti);
  });
});

describe('le righe che un annullamento smentisce', () => {
  it('l\'arrivo se ne va con l\'accompagnamento annullato, anche cambiato tavolo a metà strada', () => {
    const prima = escort(famiglia, t40);
    const altra = escort(coppia, t41);
    const moved = stripItemsOf({ kind: 'moved', at: 0, roomId: 2, party: famiglia, from: t40, to: t41 }, nuovo, 1000)[0];
    // escort-end {tableId: 41, seated: false}: la riga diceva 40.
    const rest = withoutEscort([moved, prima, altra], famiglia.id);
    expect(rest).toEqual([moved, altra]);
    expect(withoutEscort(rest, 999)).toBe(rest);
  });

  it('«Arrivato» tolto (anche col movimento ridotto, senza eventi): via arrivo, ingresso e cambio di tavolo', () => {
    const items = addStripItems([], [
      escort(famiglia, t40),
      stripItemsOf({ kind: 'moved', at: 0, roomId: 2, party: famiglia, from: t40, to: t41 }, nuovo, 1000)[0],
      stripItemsOf({ kind: 'lobby', at: 0, roomId: 2, party: coppia }, nuovo, 1000)[0],
      stripItemsOf({ kind: 'bulk', at: 0, count: 2 }, nuovo, 1000)[0],
    ]);
    // Tutti ancora veri: la stessa lista.
    expect(stillTrue(items, [fase(301, 'seated', 41), fase(330, 'lobby')])).toBe(items);
    // La famiglia torna in attesa, la coppia sparisce: resta il riallineamento.
    expect(stillTrue(items, [fase(301, 'waiting')]).map(i => i.kind)).toEqual(['bulk']);
  });

  it('«Tavolo liberato» tolto mentre uscivano: via l\'uscita; spodestati e andati via restano', () => {
    const uscita = stripItemsOf({ kind: 'leaving', at: 0, roomId: 2, party: famiglia, table: t40 }, nuovo, 1000);
    expect(stillTrue(uscita, [fase(301, 'seated', 40)])).toEqual([]);
    expect(stillTrue(uscita, [fase(301, 'standing', 40)])).toEqual([]);
    // Spodestata da una comitiva più recente, o andata via: l'uscita è vera.
    expect(stillTrue(uscita, [fase(301, 'hidden')])).toBe(uscita);
    expect(stillTrue(uscita, [])).toBe(uscita);
    // Seduta a un altro tavolo: anche (è uscita da quello).
    expect(stillTrue(uscita, [fase(301, 'seated', 41)])).toBe(uscita);
  });
});

describe('che cosa si legge e che cosa si sente', () => {
  it('chi si accorcia, dove mai; a nomi spenti nessun nome', () => {
    const it40 = escort(famiglia, t40);
    expect(peopleText(t, famiglia)).toBe('4 (2 bambini) + cane');
    expect(stripLine(it40, false, t)).toEqual({
      id: it40.id,
      lead: '4 (2 bambini) + cane',
      tail: '→ tavolo 40',
      spoken: '4 persone, 2 bambini, un cane, al tavolo 40',
    });
    expect(stripLine(it40, true, t)).toMatchObject({
      lead: 'Famiglia Esposito · 4 (2 bambini) + cane',
      tail: '→ tavolo 40',
      spoken: 'Famiglia Esposito, 4 persone, 2 bambini, un cane, al tavolo 40',
    });
    const moved = stripItemsOf({ kind: 'moved', at: 0, roomId: 2, party: famiglia, from: t40, to: t41 }, nuovo, 0)[0];
    expect(stripLine(moved, false, t)).toMatchObject({ tail: '· tavolo 40 → 41', spoken: '4 persone, 2 bambini, un cane, dal tavolo 40 al tavolo 41' });
    const uscita = stripItemsOf({ kind: 'leaving', at: 0, roomId: 2, party: coppia, table: t40 }, nuovo, 0)[0];
    expect(stripLine(uscita, true, t)).toMatchObject({ lead: '2', tail: '· tavolo 40 → uscita', spoken: '2 persone, lascia il tavolo 40' });
    const lobby = stripItemsOf({ kind: 'lobby', at: 0, roomId: 2, party: coppia }, nuovo, 0)[0];
    expect(stripLine(lobby, false, t)).toMatchObject({ lead: '2', tail: 'all\'ingresso' });
    const grande = stripItemsOf({ kind: 'snapped', at: 0, roomId: 2, reason: 'large', parties: [{ party: { id: 9, name: 'Matrimonio', adults: 14, kids: 0, dogs: 0 }, table: t41 }] }, nuovo, 0)[0];
    expect(stripLine(grande, false, t)).toMatchObject({ lead: 'Tavolo 41', tail: '· 14 a tavola', spoken: 'Tavolo 41, 14 a tavola' });
    expect(stripLine(grande, true, t)).toMatchObject({ lead: 'Matrimonio' });
    const bulk = stripItemsOf({ kind: 'bulk', at: 0, count: 1 }, nuovo, 0)[0];
    expect(stripLine(bulk, false, t)).toMatchObject({ lead: '1 tavolo aggiornato', tail: '', spoken: '1 tavolo aggiornato' });
    // Il parlato non ha frecce, punti in mezzo né «più».
    for (const line of [it40, moved, uscita, lobby, grande, bulk].map(i => stripLine(i, true, t))) {
      expect(line.spoken).not.toMatch(/[→·+]/);
    }
  });

  it('in inglese le stesse righe', () => {
    const it40 = escort(famiglia, t40);
    expect(stripLine(it40, false, en)).toMatchObject({ lead: '4 (2 children) + dog', tail: '→ table 40', spoken: '4 people, 2 children, a dog, to table 40' });
    const uscita = stripItemsOf({ kind: 'leaving', at: 0, roomId: 2, party: coppia, table: t40 }, nuovo, 0)[0];
    expect(stripLine(uscita, false, en)).toMatchObject({ tail: '· table 40 → exit' });
  });
});
