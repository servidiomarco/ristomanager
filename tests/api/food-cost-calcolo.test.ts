import { describe, it, expect } from 'vitest';
// Il sorgente, non dist: il conto non ha dipendenze (vedi event-registry).
import {
    CicloRicettaError,
    calcolaBanchetto,
    costoPiatto,
    creaCalcolatore,
    creaCiclo,
    foodCostPct,
    margineCents,
    prezzoConsigliatoEuro,
    semaforo,
    type CostoPiatto,
    type IngredienteFc,
    type RigaFc,
} from '../../utils/foodCost';

// Food cost, Fase 1: il conto che server e schermo fanno uguale. Numeri
// scelti per poterli rifare a mano: ogni attesa ha accanto il suo conto.

const ing = (id: number, costoCents: number | null, unitaCosto: 'kg' | 'l' | 'pz' | null, extra: Partial<IngredienteFc> = {}): IngredienteFc => ({
    id, costoCents, unitaCosto, resaPct: 100, isPreparazione: false, resaQuantita: null, ...extra,
});

const PASTA = 1, MANZO = 2, POMODORO = 3, CIPOLLA = 4, CAROTA = 5, OLIO = 6, UOVA = 7, BRANZINO = 8, SALE = 9, BURRO = 10;
const SOFFRITTO = 20, RAGU = 21;

const ingredienti = new Map<number, IngredienteFc>([
    [PASTA, ing(PASTA, 300, 'kg')],
    [MANZO, ing(MANZO, 1200, 'kg')],
    [POMODORO, ing(POMODORO, 200, 'kg')],
    [CIPOLLA, ing(CIPOLLA, 150, 'kg')],
    [CAROTA, ing(CAROTA, 120, 'kg')],
    [OLIO, ing(OLIO, 900, 'l')],
    [UOVA, ing(UOVA, 25, 'pz')],
    [BRANZINO, ing(BRANZINO, 1800, 'kg', { resaPct: 48 })],
    [SALE, ing(SALE, 30, 'kg')],
    [BURRO, ing(BURRO, null, 'kg')],
    [SOFFRITTO, ing(SOFFRITTO, null, 'kg', { isPreparazione: true, resaQuantita: 300 })],
    [RAGU, ing(RAGU, null, 'kg', { isPreparazione: true, resaQuantita: 1200 })],
]);

const preparazioni = new Map<number, RigaFc[]>([
    // 200 g cipolla = 30 c, 200 g carota = 24 c → 54 c per 300 g → 180 c/kg
    [SOFFRITTO, [{ productId: CIPOLLA, quantita: 200 }, { productId: CAROTA, quantita: 200 }]],
    // manzo 1 kg = 1200 c, soffritto 300 g = 54 c, pomodoro 500 g = 100 c
    // → 1354 c per 1200 g → 1128,33 c/kg
    [RAGU, [{ productId: MANZO, quantita: 1000 }, { productId: SOFFRITTO, quantita: 300 }, { productId: POMODORO, quantita: 500 }]],
]);

describe('food cost — il conto', () => {
    const calc = creaCalcolatore(ingredienti, preparazioni);

    it('converte g→kg, ml→l e conta i pezzi', () => {
        expect(calc.costoRiga({ productId: PASTA, quantita: 100 })).toBeCloseTo(30, 6);   // 0,1 kg × 300
        expect(calc.costoRiga({ productId: OLIO, quantita: 20 })).toBeCloseTo(18, 6);     // 0,02 l × 900
        expect(calc.costoRiga({ productId: UOVA, quantita: 2 })).toBeCloseTo(50, 6);      // 2 × 25
        // 3 g di sale: 0,09 centesimi, senza arrotondare la riga.
        expect(calc.costoRiga({ productId: SALE, quantita: 3 })).toBeCloseTo(0.09, 6);
    });

    it('la resa trasforma il netto in lordo da comprare', () => {
        // 100 g di filetto al 48%: 208,3 g di branzino intero a 18 €/kg = 375 c
        expect(calc.costoRiga({ productId: BRANZINO, quantita: 100 })).toBeCloseTo(375, 6);
    });

    it('risolve i semilavorati su due livelli', () => {
        expect(calc.costoUnitario(SOFFRITTO).cents).toBeCloseTo(180, 6);
        expect(calc.costoUnitario(RAGU).cents).toBeCloseTo(1354 / 1.2, 6);
        // Tagliatelle: 100 g pasta (30 c) + 120 g ragù (135,4 c)
        const tagliatelle = calc.costoRighe([{ productId: PASTA, quantita: 100 }, { productId: RAGU, quantita: 120 }]);
        expect(tagliatelle.cents).toBeCloseTo(165.4, 6);
        expect(tagliatelle.mancanti).toEqual([]);
    });

    it('un prezzo che manca rende la scheda incompleta, non vuota', () => {
        const c = costoPiatto(calc, [{ productId: PASTA, quantita: 100 }, { productId: BURRO, quantita: 20 }], 1, null);
        expect(c.stato).toBe('incompleto');
        expect(c.mancanti).toEqual([BURRO]);
        expect(c.cents).toBeCloseTo(30, 6);
    });

    it('divide per le porzioni della ricetta', () => {
        // Una teglia: 1 kg di ragù (1128,33 c) + 500 g di pasta (150 c), per 8
        const c = costoPiatto(calc, [{ productId: RAGU, quantita: 1000 }, { productId: PASTA, quantita: 500 }], 8, null);
        expect(c.stato).toBe('completo');
        expect(c.cents).toBeCloseTo((1354 / 1.2 + 150) / 8, 6);
    });

    it('senza righe vale il costo a mano, e senza nemmeno quello non c\'è scheda', () => {
        expect(costoPiatto(calc, [], 1, 120)).toEqual({ cents: 120, stato: 'completo', mancanti: [], manuale: true });
        expect(costoPiatto(calc, [], 1, null).stato).toBe('senza_scheda');
    });

    it('riconosce i cicli fra semilavorati', () => {
        // Il soffritto che contenesse il ragù: il ragù contiene già il soffritto.
        expect(creaCiclo(SOFFRITTO, [{ productId: RAGU, quantita: 10 }], preparazioni)).toBe(true);
        expect(creaCiclo(RAGU, [{ productId: SOFFRITTO, quantita: 10 }], preparazioni)).toBe(false);
        const sporchi = new Map(preparazioni);
        sporchi.set(SOFFRITTO, [{ productId: RAGU, quantita: 10 }]);
        expect(() => creaCalcolatore(ingredienti, sporchi).costoUnitario(RAGU)).toThrow(CicloRicettaError);
    });

    it('misura il food cost sul prezzo senza IVA', () => {
        // 12 € con IVA 10% = 1090,91 c netti; 300 c di costo = 27,5%
        expect(foodCostPct(300, 12, 10)).toBeCloseTo(27.5, 6);
        expect(margineCents(300, 12, 10)).toBeCloseTo(1200 / 1.1 - 300, 6);
        // Al 30%: 300 c / 0,3 = 1000 c netti = 11 € con IVA
        expect(prezzoConsigliatoEuro(300, 30, 10)).toBeCloseTo(11, 6);
        expect(foodCostPct(300, 0, 10)).toBeNull();
    });

    it('colora entro il target, fino a 5 punti sopra, e oltre', () => {
        expect(semaforo(30, 30)).toBe('ok');
        expect(semaforo(34.9, 30)).toBe('attenzione');
        expect(semaforo(35.1, 30)).toBe('alto');
        expect(semaforo(null, 30)).toBeNull();
    });

    it('il banchetto: quote di porzione, bambini, sconto e IVA', () => {
        const costi = new Map<number, CostoPiatto>([
            [101, { cents: 200, stato: 'completo', mancanti: [], manuale: false }],
            [102, { cents: 100, stato: 'incompleto', mancanti: [BURRO], manuale: false }],
            [103, { cents: 400, stato: 'completo', mancanti: [], manuale: false }],
        ]);
        const b = calcolaBanchetto({
            courses: [
                { dish_ids: [101, 102], quote: { '102': 0.5 } },
                { dish_ids: [103, 104] },
            ],
            costoPiatto: id => costi.get(id),
            guests: 10, children: 2,
            pricePerPerson: 50, childrenPrice: 25,
            discountType: 'PERCENT', discountValue: 10,
            ivaPct: 10, quotaBambiniPct: 50, targetPct: 30,
        });
        // Adulto: 200 + 100 × ½ + 400 = 650 c; bambino al 50% = 325 c
        expect(b.costoAdultoCents).toBeCloseTo(650, 6);
        expect(b.costoBambinoCents).toBeCloseTo(325, 6);
        expect(b.piattiSenzaCosto).toEqual([104]);
        expect(b.piattiIncompleti).toEqual([102]);
        // 8 adulti × 650 + 2 bambini × 325 = 5850 c
        expect(b.costoTotaleCents).toBeCloseTo(5850, 6);
        // Lordo 8 × 50 + 2 × 25 = 450 €, sconto 10% = 405 €, senza IVA 368,18 €
        expect(b.ricavoNettoCents).toBeCloseTo(40500 / 1.1, 6);
        expect(b.foodCostPct).toBeCloseTo(5850 / (40500 / 1.1) * 100, 6);
        expect(b.margineTotaleCents).toBeCloseTo(40500 / 1.1 - 5850, 6);
        // Adulto: 50 € × 0,9 / 1,1 = 4090,91 c netti − 650 c
        expect(b.margineAdultoCents).toBeCloseTo(4500 / 1.1 - 650, 6);
        // Al 30%: 650 / 0,3 = 2166,67 c netti × 1,1 = 23,83 €
        expect(b.prezzoConsigliatoAdulto).toBeCloseTo(650 / 0.3 / 100 * 1.1, 6);
    });

    it('il banchetto senza prezzo dà il costo ma non la percentuale', () => {
        const b = calcolaBanchetto({
            courses: [{ dish_ids: [1] }],
            costoPiatto: () => ({ cents: 500, stato: 'completo', mancanti: [], manuale: false }),
            guests: 0, children: 0, pricePerPerson: 0, childrenPrice: null,
            discountType: null, discountValue: null, ivaPct: 10, quotaBambiniPct: 50, targetPct: 30,
        });
        expect(b.costoAdultoCents).toBe(500);
        expect(b.foodCostPct).toBeNull();
        expect(b.margineAdultoCents).toBeNull();
    });
});
