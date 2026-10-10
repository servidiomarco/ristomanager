// ============================================
// La confezione scritta nella descrizione della riga
// ============================================
// «RISO GALLO BLOND RISOTTI KG5», «TONNO CALLIPO GR 70X3», «PHILADELPHIA GR
// 250»: i gestionali dei fornitori mettono il contenuto della confezione nel
// testo, non in un campo. Qui lo si legge per proporre il fattore del costo
// (1 pezzo della fattura = 5 kg) quando si abbina una riga la prima volta.
// È solo una proposta: chi abbina la vede e la corregge.

import type { UnitaCosto } from './foodCost';

export interface Confezione {
    unita: UnitaCosto;
    /** Quanti kg, litri o pezzi ci sono in una unità della fattura. */
    quantita: number;
}

const UNITA: Record<string, { unita: UnitaCosto; per: number }> = {
    KG: { unita: 'kg', per: 1 },
    GR: { unita: 'kg', per: 0.001 },
    G: { unita: 'kg', per: 0.001 },
    LT: { unita: 'l', per: 1 },
    L: { unita: 'l', per: 1 },
    ML: { unita: 'l', per: 0.001 },
    CL: { unita: 'l', per: 0.01 },
    PZ: { unita: 'pz', per: 1 },
};

const N = '(\\d+(?:[.,]\\d+)?)';
const U = '(KG|GR|G|LT|L|ML|CL|PZ)';
// Unità e numero in tutti e due gli ordini, con un «X 3» di multipli dopo o
// un «3 X» prima: «GR 70X3», «3X326GR», «KG5», «250 GR».
const DOPO = new RegExp(`(?:^|[^A-Z])${U}\\s*${N}(?:\\s*X\\s*(\\d+))?(?![\\d.,]*[A-Z])`);
const PRIMA = new RegExp(`(?:(\\d+)\\s*X\\s*)?${N}\\s*${U}(?![A-Z])(?:\\s*X\\s*(\\d+))?`);

const numero = (s: string) => parseFloat(s.replace(',', '.'));
const arrotonda = (n: number) => Math.round(n * 10000) / 10000;

export function indovinaConfezione(descrizione: string): Confezione | null {
    const d = ` ${descrizione.toUpperCase().replace(/\s+/g, ' ')} `;
    const candidati: { unita: UnitaCosto; quantita: number }[] = [];
    const a = DOPO.exec(d);
    if (a) {
        const u = UNITA[a[1]];
        const q = numero(a[2]) * u.per * (a[3] ? Number(a[3]) : 1);
        candidati.push({ unita: u.unita, quantita: q });
    }
    const b = PRIMA.exec(d);
    if (b) {
        const u = UNITA[b[3]];
        const q = numero(b[2]) * u.per * (b[1] ? Number(b[1]) : 1) * (b[4] ? Number(b[4]) : 1);
        candidati.push({ unita: u.unita, quantita: q });
    }
    // Il peso o il volume battono i pezzi: «GR 250 PZ 4» è un 4×250 g, ma
    // per il costo al kg conta il peso.
    const scelto = candidati.find(c => c.unita !== 'pz') ?? candidati[0];
    if (!scelto || !(scelto.quantita > 0) || scelto.quantita > 1000) return null;
    return { unita: scelto.unita, quantita: arrotonda(scelto.quantita) };
}

/** L'unità di misura della fattura, quando è già un peso o un volume. */
export function unitaDellaFattura(unitaMisura: string | null): UnitaCosto | null {
    const u = (unitaMisura ?? '').trim().toUpperCase().replace(/\.$/, '');
    if (u === 'KG' || u === 'KGM' || u === 'KILOGRAMMI') return 'kg';
    if (u === 'LT' || u === 'L' || u === 'LTR' || u === 'LITRI') return 'l';
    return null;
}
