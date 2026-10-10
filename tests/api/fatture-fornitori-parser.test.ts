import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Il sorgente, non dist: il parser non tocca il database (vedi food-cost-calcolo).
import {
    FatturaPaError,
    apriFile,
    chiaveArticolo,
    estraiAllegato,
    estraiDaP7m,
    leggiFatture,
    normalizzaEan,
} from '../../utils/fatturaPa';
import { fornitoreSimile, paroleNome } from '../../utils/fornitoreSimile';
import { indovinaConfezione, unitaDellaFattura } from '../../utils/confezione';

// Le fatture di prova sono due fatture vere di fornitori del Frantoio, con
// nomi, partite IVA, indirizzi e firma tolti (il repository è pubblico).
// Tengono quello che le rende difficili: prefissi dei namespace diversi, la
// riga fatta solo di note, il lotto, i 49 articoli con EAN e codice interno,
// i DDT. Più una sintetica in latin1 con due corpi (fattura e nota di credito).

const FIX = join(__dirname, '..', 'fixtures', 'fatture');
const leggi = (nome: string) => readFileSync(join(FIX, nome));
const unaFattura = (nome: string) => {
    const { fatture } = apriFile(leggi(nome), nome);
    expect(fatture).toHaveLength(1);
    return leggiFatture(fatture[0].xml);
};

describe('fatturaPa — lettura del tracciato', () => {
    it('ortofrutta: una riga di merce col lotto, la riga di note scartata, il PDF allegato', () => {
        const [f] = unaFattura('ortofrutta.xml');
        expect(f.cedente).toMatchObject({ piva: '11111111115', denominazione: 'Ortofrutta di Prova S.R.L.' });
        expect(f.cessionario.piva).toBe('01234567897');
        expect(f).toMatchObject({ tipoDocumento: 'TD01', numero: '4014', data: '2026-09-30', importoTotale: 249.6, imponibile: 240, imposta: 9.6 });
        expect(f.righe).toHaveLength(2);
        const [olive, note] = f.righe;
        expect(olive).toMatchObject({
            tipo: 'merce',
            descrizione: 'OLIVE FRESCHE BELLE DI CERIGNOLA CAL22',
            quantita: 150,
            unitaMisura: 'COLLI',
            prezzoTotale: 240,
            aliquotaIva: 4,
            codice: '0192',
            ean: null,
            lotto: '030613080526',
        });
        expect(note.tipo).toBe('nota');
        expect(note.descrizione).toBe('');
        expect(f.pagamenti).toEqual([{ modalita: 'MP01', data: '2026-09-30', importo: 249.6, iban: null, istituto: null }]);
        expect(f.allegati).toHaveLength(1);
        expect(f.allegati[0]).toMatchObject({ nome: 'Fattura.pdf', formato: 'PDF' });
    });

    it('cash & carry: 49 righe con EAN a 13 cifre, IVA per riga, DDT per riga', () => {
        const [f] = unaFattura('cash-carry.xml');
        expect(f.numero).toBe('17031/V');
        expect(f.importoTotale).toBe(297.99);
        expect(f.causale).toBe('FATTURAZIONE CASH');
        expect(f.righe).toHaveLength(49);
        expect(f.righe.every(r => r.tipo === 'merce')).toBe(true);
        const riso = f.righe[0];
        expect(riso).toMatchObject({
            descrizione: 'RISO GALLO BLOND RISOTTI KG5', // senza gli spazi in coda del gestionale
            ean: '8003490048677', // era 08003490048677 (GTIN-14)
            codice: '000005875',
            quantita: 2,
            unitaMisura: 'PZ',
            prezzoUnitario: 8.1,
            prezzoTotale: 16.2,
            aliquotaIva: 4,
            ddt: '1',
        });
        expect(f.righe[48].ddt).toBe('2');
        expect(new Set(f.righe.map(r => r.aliquotaIva))).toEqual(new Set([4, 5, 10, 22]));
        expect(f.ddt.map(d => d.numero)).toEqual(['1', '2']);
        // Il riepilogo IVA arrotonda per aliquota: la somma delle righe può
        // differire di un centesimo, il totale del documento resta quello.
        expect(f.imponibile).toBe(254.83);
        expect(Math.round((f.imponibile + f.imposta) * 100)).toBe(29799);
    });

    it('latin1, due corpi: la fattura con sconto, omaggio e trasporto; la nota di credito', () => {
        const { fatture } = apriFile(leggi('caseificio-lotto.xml'), 'caseificio-lotto.xml');
        const [fattura, nota] = leggiFatture(fatture[0].xml);
        expect(fattura.cedente.denominazione).toBe('Mario Caseificio Prova');
        expect(fattura.causale).toBe('Merce consegnata al mattino');
        const [mozzarella, ricotta, trasporto] = fattura.righe;
        expect(mozzarella).toMatchObject({
            tipo: 'merce',
            descrizione: 'Mozzarella fior di latte caffè latte kg 1',
            prezzoTotale: 36,
            lotto: 'L-4455',
            scadenza: '2026-10-20',
            ddt: 'D-9', // DDT senza righe indicate: vale per tutte
        });
        expect(mozzarella.sconti).toEqual([{ tipo: 'SC', percentuale: 10, importo: null }]);
        expect(ricotta.tipo).toBe('merce'); // l'omaggio è merce che entra
        expect(trasporto.tipo).toBe('spesa');
        expect(fattura.pagamenti[0]).toMatchObject({ modalita: 'MP05', iban: 'IT60X0542811101000000123456', data: '2026-11-05' });
        expect(nota).toMatchObject({ tipoDocumento: 'TD04', notaDiCredito: true, numero: 'NC/3', indiceBody: 1 });
    });

    it('il p7m: DER, base64 a righe e BER a lunghezza indefinita col contenuto a pezzi', () => {
        const der = leggi('ortofrutta.xml.p7m');
        expect(estraiDaP7m(der).toString('utf8')).toBe(leggi('ortofrutta.xml').toString('utf8'));
        const b64 = Buffer.from(der.toString('base64').replace(/(.{76})/g, '$1\r\n'));
        expect(apriFile(b64, 'x.p7m').fatture[0].xml).toContain('<Numero>4014</Numero>');
        // openssl cms -stream: OCTET STRING costruito, pezzi da 4096 byte.
        const ber = apriFile(leggi('cash-carry-ber.xml.p7m'), 'b.p7m');
        expect(ber.fatture[0].xml).toBe(leggi('cash-carry.xml').toString('utf8'));
        expect(leggiFatture(ber.fatture[0].xml)[0].righe).toHaveLength(49);
    });

    it('lo zip: le fatture dentro, i metadati e il PDF scartati dicendo perché', () => {
        const { fatture, scartati } = apriFile(leggi('scarico.zip'), 'scarico.zip');
        expect(fatture.map(f => f.nome).sort()).toEqual(['IT11111111115_0001.xml.p7m', 'IT22222222220_0002.xml']);
        expect(scartati).toEqual(expect.arrayContaining([
            { nome: 'IT11111111115_0001_MT_001.xml', motivo: 'Metadati dello SDI' },
            { nome: 'copia.pdf', motivo: 'È un PDF, serve l\'XML' },
        ]));
        expect(scartati).toHaveLength(2); // __MACOSX non conta
    });

    it('il PDF di cortesia si tira fuori dall\'XML', () => {
        const xml = apriFile(leggi('ortofrutta.xml'), 'o.xml').fatture[0].xml;
        const pdf = estraiAllegato(xml, 0, 0);
        expect(pdf?.nome).toBe('Fattura.pdf');
        expect(pdf?.dati.subarray(0, 5).toString()).toBe('%PDF-');
        expect(estraiAllegato(xml, 0, 1)).toBeNull();
    });

    it('rifiuta quello che non è una fattura, e le DOCTYPE', () => {
        expect(apriFile(Buffer.from('ciao'), 'a.txt').scartati[0].motivo).toBe('Non è una fattura elettronica: serve l\'XML, il p7m o lo zip');
        expect(apriFile(Buffer.from([0x30, 0x82, 0x00]), 'rotto.xml.p7m').scartati[0].motivo).toMatch(/p7m/);
        expect(apriFile(Buffer.from('<?xml version="1.0"?><Ordine/>'), 'o.xml').scartati[0].motivo).toBe('Non è una fattura elettronica');
        const bomba = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><FatturaElettronica>&a;</FatturaElettronica>';
        expect(() => leggiFatture(bomba)).toThrow(FatturaPaError);
    });
});

describe('fatturaPa — chiavi e fornitori', () => {
    it('la chiave: EAN, poi codice, poi descrizione', () => {
        expect(chiaveArticolo({ ean: '8003490048677', codice: 'X1', descrizione: 'Riso' })).toEqual({ tipo: 'ean', valore: '8003490048677' });
        expect(chiaveArticolo({ ean: null, codice: 'ab-1', descrizione: 'Riso' })).toEqual({ tipo: 'codice', valore: 'AB-1' });
        expect(chiaveArticolo({ ean: null, codice: null, descrizione: '  Riso   Carnaroli kg 1. ' })).toEqual({ tipo: 'descrizione', valore: 'RISO CARNAROLI KG 1' });
        expect(chiaveArticolo({ ean: null, codice: null, descrizione: '' })).toBeNull();
        expect(normalizzaEan('08003490048677')).toBe('8003490048677');
        expect(normalizzaEan('12345')).toBeNull();
    });

    it('il fornitore in anagrafica si riconosce dal nome', () => {
        const anagrafica = [
            { id: 'a', name: 'Mollo' },
            { id: 'b', name: 'Cash De Caprio' },
            { id: 'c', name: 'Mollo Carni' },
            { id: 'd', name: 'Eurospin' },
        ];
        expect(fornitoreSimile('Mollo Ortofrutta S.R.L.', anagrafica)?.id).toBe('a');
        expect(fornitoreSimile('DE CAPRIO S.R.L.', anagrafica)?.id).toBe('b');
        expect(fornitoreSimile('MOLLO CARNI SRL', anagrafica)?.id).toBe('c'); // la più lunga che combacia
        expect(fornitoreSimile('Ortofrutta Rossi', anagrafica)).toBeNull();
        expect(paroleNome('F.LLI ROSSI S.p.A.')).toEqual(['rossi']);
    });
});

describe('confezione letta dalla descrizione', () => {
    // Descrizioni vere della fattura del cash & carry: la proposta del
    // fattore di costo quando si abbina una riga la prima volta.
    it.each([
        ['RISO GALLO BLOND RISOTTI KG5', { unita: 'kg', quantita: 5 }],
        ['MAIS VALFRUTTA LATTINA GR 326X3 T 3 49', { unita: 'kg', quantita: 0.978 }],
        ['TONNO CALLIPO O O  GR 70X3 STRAPPO', { unita: 'kg', quantita: 0.21 }],
        ['PHILADELPHIA GR 250', { unita: 'kg', quantita: 0.25 }],
        ['DET LIQ LAV SOLE COLORE 41LAV ML 1840', { unita: 'l', quantita: 1.84 }],
        ['COCA COLA 33CL', { unita: 'l', quantita: 0.33 }],
        ['ACQUA NATURALE 1,5 LT X6', { unita: 'l', quantita: 9 }],
        ['3X326GR MAIS', { unita: 'kg', quantita: 0.978 }],
        ['UOVA FRESCHE PZ 30', { unita: 'pz', quantita: 30 }],
    ])('%s', (descrizione, atteso) => {
        expect(indovinaConfezione(descrizione)).toEqual(atteso);
    });

    it('senza confezione nel testo non propone niente', () => {
        expect(indovinaConfezione('OLIVE FRESCHE BELLE DI CERIGNOLA CAL22')).toBeNull();
        expect(unitaDellaFattura('KG')).toBe('kg');
        expect(unitaDellaFattura('Lt.')).toBe('l');
        expect(unitaDellaFattura('COLLI')).toBeNull();
    });
});
