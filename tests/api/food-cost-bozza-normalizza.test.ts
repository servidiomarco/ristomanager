import { describe, it, expect } from 'vitest';
// Il sorgente, non dist: la pulizia della risposta non tocca né rete né DB.
import { normalizzaBozza, type IngredienteAi } from '../../services/foodCostAi';

// Bozza della scheda con l'AI: la risposta del modello ha sempre la forma
// giusta (output strutturato), non sempre il contenuto. Qui si prova cosa
// arriva all'editor quando il modello inventa, sbaglia unità o esagera.

const ING: IngredienteAi[] = [
    { id: 1, nome: 'Spaghetti', area: 'CUCINA', unitaCosto: 'kg', isPreparazione: false },
    { id: 2, nome: 'Uova', area: 'CUCINA', unitaCosto: 'pz', isPreparazione: false },
    { id: 3, nome: 'Pecorino romano', area: 'CUCINA', unitaCosto: null, isPreparazione: false },
    { id: 4, nome: 'Ragù', area: 'CUCINA', unitaCosto: 'kg', isPreparazione: true },
    { id: 5, nome: 'Olio extravergine', area: 'CUCINA', unitaCosto: 'l', isPreparazione: false },
];

const riga = (r: Record<string, unknown>) => ({ ingrediente_id: null, nuovo_ingrediente: null, nota: null, ...r });
const piatto = { tipo: 'piatto' as const, porzioni: 1 };

describe('normalizzaBozza', () => {
    it('tiene gli ingredienti del ristorante e porta l\'unità di costo', () => {
        const b = normalizzaBozza({
            righe: [
                riga({ ingrediente_id: 1, unita: 'g', quantita: 100 }),
                riga({ ingrediente_id: 2, unita: 'pz', quantita: 1, nota: 'solo tuorlo' }),
                riga({ ingrediente_id: 5, unita: 'ml', quantita: 10 }),
            ],
            avvisi: [],
        }, ING, piatto);
        expect(b.righe).toEqual([
            { productId: 1, nomeNuovo: null, unita: 'kg', quantita: 100, nota: null },
            { productId: 2, nomeNuovo: null, unita: 'pz', quantita: 1, nota: 'solo tuorlo' },
            { productId: 5, nomeNuovo: null, unita: 'l', quantita: 10, nota: null },
        ]);
        expect(b.resaQuantita).toBeNull();
    });

    it('scarta gli id inventati, senza nome non resta niente', () => {
        const b = normalizzaBozza({ righe: [riga({ ingrediente_id: 999, unita: 'g', quantita: 50 })], avvisi: [] }, ING, piatto);
        expect(b.righe).toEqual([]);
    });

    it('un id inventato col nome diventa un ingrediente nuovo da creare', () => {
        const b = normalizzaBozza({
            righe: [riga({ ingrediente_id: 999, nuovo_ingrediente: ' Guanciale ', unita: 'g', quantita: 40 })],
            avvisi: [],
        }, ING, piatto);
        expect(b.righe).toEqual([{ productId: null, nomeNuovo: 'Guanciale', unita: 'kg', quantita: 40, nota: null }]);
    });

    it('un «nuovo» che c\'è già col suo nome è quello, maiuscole e accenti a parte', () => {
        const b = normalizzaBozza({
            righe: [riga({ nuovo_ingrediente: 'PECORINO  ROMANO', unita: 'g', quantita: 30 })],
            avvisi: [],
        }, ING, piatto);
        expect(b.righe).toEqual([{ productId: 3, nomeNuovo: null, unita: 'kg', quantita: 30, nota: null }]);
    });

    it('un\'unità diversa da quella fissata si scarta e diventa un avviso', () => {
        const b = normalizzaBozza({
            righe: [riga({ ingrediente_id: 2, unita: 'g', quantita: 50 })],
            avvisi: ['versione classica'],
        }, ING, piatto);
        expect(b.righe).toEqual([]);
        expect(b.avvisi).toEqual(['versione classica', 'Uova: proposto in g ma si conta a pz, da aggiungere a mano']);
    });

    it('scarta quantità assurde: zero, negative, oltre il tetto per porzione', () => {
        const b = normalizzaBozza({
            righe: [
                riga({ ingrediente_id: 1, unita: 'g', quantita: 0 }),
                riga({ ingrediente_id: 1, unita: 'g', quantita: -5 }),
                riga({ ingrediente_id: 1, unita: 'g', quantita: 6000 }),
                riga({ ingrediente_id: 2, unita: 'pz', quantita: 101 }),
            ],
            avvisi: [],
        }, ING, piatto);
        expect(b.righe).toEqual([]);
        // Con 8 porzioni la teglia può pesare di più.
        const teglia = normalizzaBozza({ righe: [riga({ ingrediente_id: 1, unita: 'g', quantita: 6000 })], avvisi: [] }, ING, { tipo: 'piatto', porzioni: 8 });
        expect(teglia.righe).toHaveLength(1);
    });

    it('i doppioni: vince la prima riga', () => {
        const b = normalizzaBozza({
            righe: [
                riga({ ingrediente_id: 1, unita: 'g', quantita: 100 }),
                riga({ ingrediente_id: 1, unita: 'g', quantita: 80 }),
                riga({ nuovo_ingrediente: 'Guanciale', unita: 'g', quantita: 40 }),
                riga({ nuovo_ingrediente: 'guanciale', unita: 'g', quantita: 50 }),
            ],
            avvisi: [],
        }, ING, piatto);
        expect(b.righe.map(r => [r.productId, r.nomeNuovo, r.quantita])).toEqual([[1, null, 100], [null, 'Guanciale', 40]]);
    });

    it('un semilavorato non contiene sé stesso, e porta la resa', () => {
        const b = normalizzaBozza({
            righe: [
                riga({ ingrediente_id: 4, unita: 'g', quantita: 500 }),
                riga({ nuovo_ingrediente: 'ragù', unita: 'g', quantita: 500 }),
                riga({ nuovo_ingrediente: 'Carne macinata', unita: 'g', quantita: 1500 }),
            ],
            resa_quantita: 3000,
            resa_unita: 'g',
            avvisi: [],
        }, ING, { tipo: 'semilavorato', porzioni: 1, escluso: 4 });
        expect(b.righe).toEqual([{ productId: null, nomeNuovo: 'Carne macinata', unita: 'kg', quantita: 1500, nota: null }]);
        expect(b.resaQuantita).toBe(3000);
        expect(b.resaUnita).toBe('kg');
    });

    it('la resa di un piatto non conta', () => {
        const b = normalizzaBozza({ righe: [], resa_quantita: 3000, resa_unita: 'g', avvisi: [] }, ING, piatto);
        expect(b.resaQuantita).toBeNull();
        expect(b.resaUnita).toBeNull();
    });

    it('al massimo 40 righe e 10 avvisi', () => {
        const b = normalizzaBozza({
            righe: Array.from({ length: 60 }, (_, i) => riga({ nuovo_ingrediente: `Spezia ${i}`, unita: 'g', quantita: 1 })),
            avvisi: Array.from({ length: 20 }, (_, i) => `avviso ${i}`),
        }, ING, piatto);
        expect(b.righe).toHaveLength(40);
        expect(b.avvisi).toHaveLength(10);
    });

    it('regge una risposta sbagliata senza cadere', () => {
        expect(normalizzaBozza(null, ING, piatto)).toEqual({ righe: [], resaQuantita: null, resaUnita: null, avvisi: [] });
        expect(normalizzaBozza({ righe: [{ unita: 'kg', quantita: '100' }], avvisi: 'no' }, ING, piatto).righe).toEqual([]);
    });
});
