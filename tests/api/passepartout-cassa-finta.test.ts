import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import {
    PassepartoutError, annullaPrenotazione, diagnosiCassa, getArticoliMenu,
    getPrenotazioniMenuGiorno, getVersioneGestionale, sincronizzaPrenotazione,
} from '../../services/passepartoutService';
import { api } from './helpers';

// La cassa finta (scripts/cassa-finta.ps1) con cui si prova l'installatore
// su una VM Windows senza Passepartout: qui la si interroga con lo stesso
// client SOAP dell'agente, così quello che risponde è quello che l'agente
// sa leggere. Serve PowerShell (i runner Ubuntu della CI lo hanno).

const pwsh = (() => {
    try { execFileSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe' }); return true; } catch { return false; }
})();

const portaLibera = () => new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
        const porta = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(porta));
    });
});

describe('cassa finta per la prova su VM', () => {
    it('si scarica col suo server dentro', async () => {
        const r = await api().get('/installa/cassa-finta.ps1');
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toContain('text/plain');
        expect(r.text).not.toContain('__SYMPOTIA_SERVER__');
        expect(r.text).toContain(`irm ${process.env.TEST_BASE_URL}/installa/cassa-finta.ps1 | iex`);
        expect(r.text).toContain('function Avvia-CassaFinta');
        // Solo i due script elencati, niente altro dalla cartella.
        expect((await api().get('/installa/server.ts')).status).toBe(404);
    });

    it("l'immagine di produzione la contiene", () => {
        expect(fs.readFileSync('Dockerfile', 'utf8')).toMatch(/^COPY scripts\/installa-cassa\.ps1 scripts\/cassa-finta\.ps1 \.\/scripts\/$/m);
    });

    describe.skipIf(!pwsh)('risponde come la cassa al client dell\'agente', () => {
        let cassa: ChildProcess;
        let uscita = '';

        beforeAll(async () => {
            const porta = await portaLibera();
            cassa = spawn('pwsh', ['-NoProfile', '-File', 'scripts/cassa-finta.ps1'], {
                env: { ...process.env, CASSA_FINTA_PORTA: String(porta), CASSA_FINTA_UTENTE: 'vm', CASSA_FINTA_PASSWORD: 'segreta' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`la cassa finta non parte: ${uscita}`)), 30_000);
                const leggi = (d: Buffer) => {
                    uscita += d.toString();
                    if (uscita.includes('in ascolto')) { clearTimeout(timer); resolve(); }
                };
                cassa.stdout!.on('data', leggi);
                cassa.stderr!.on('data', leggi);
                cassa.once('exit', (code) => { clearTimeout(timer); reject(new Error(`la cassa finta è uscita (${code}): ${uscita}`)); });
            });
            process.env.PASSEPARTOUT_WS_URL = `http://127.0.0.1:${porta}/AdapterWS`;
            process.env.PASSEPARTOUT_WS_USER = 'vm';
            process.env.PASSEPARTOUT_WS_PASSWORD = 'segreta';
        }, 40_000);

        afterAll(() => {
            delete process.env.PASSEPARTOUT_WS_URL;
            delete process.env.PASSEPARTOUT_WS_USER;
            delete process.env.PASSEPARTOUT_WS_PASSWORD;
            cassa?.kill();
        });

        it("il WSDL c'è, come lo cerca l'installatore", async () => {
            const testo = await (await fetch(process.env.PASSEPARTOUT_WS_URL!.replace('/AdapterWS', '/?wsdl'))).text();
            expect(testo).toContain('wsdl');
            expect(testo).toContain('name="PutPrenotazioneMenu"');
        });

        it('con la password sbagliata rifiuta, come la cassa', async () => {
            process.env.PASSEPARTOUT_WS_PASSWORD = 'sbagliata';
            try {
                await expect(getVersioneGestionale()).rejects.toThrow(PassepartoutError);
                await expect(getVersioneGestionale()).rejects.toThrow('Utente o password non validi');
            } finally {
                process.env.PASSEPARTOUT_WS_PASSWORD = 'segreta';
            }
            // La password non finisce nel registro della finestra.
            expect(uscita).not.toContain('segreta');
            expect(uscita).not.toContain('sbagliata');
        });

        it('la verifica della cassa trova tutto quello che serve', async () => {
            const d = await diagnosiCassa();
            expect(d).toMatchObject({ raggiungibile: true, errore: null, versione: '2026C1', comande_aperte: 0 });
            expect(d.tipi_pagamento).toContainEqual({ codice: 'ESTERNO', categoria: 'Varie1' });
            // L'ingombro della pianta non è un tavolo.
            expect(d.sale).toEqual([{ sala: 'DENTRO', tavoli: 6 }, { sala: 'FUORI', tavoli: 3 }]);
        });

        it('gli articoli si importano con categoria e IVA', async () => {
            const articoli = await getArticoliMenu();
            expect(articoli).toHaveLength(8);
            expect(articoli.find((a) => a.codice === 'BEV02')).toMatchObject({
                descrizione: 'Calice di vino rosso', prezzo: 6, ivaPercento: 22, attivo: true,
                categoria: 'Bevande', categoriaPadre: 'Bar', categoriaAttiva: true, varianti: [],
            });
        });

        it('la prenotazione di prova si scrive e si annulla', async () => {
            const tag = `sympotia-prova:${Date.now()}`;
            const scritta = await sincronizzaPrenotazione({
                dataOra: '2026-10-08T05:00:00+02:00', durata: 30, sala: 'DENTRO', tavoli: ['29'],
                intestazione: 'PROVA Sympotia', numeroPersone: 2, adulti: 2, bambini: 0, stato: 'Confermata', tag,
            });
            expect(scritta.esito).toBe('scritta');
            expect(scritta.prenotazione).toMatchObject({ dataOra: '2026-10-08T05:00:00', sala: 'DENTRO', tavoli: ['29'], stato: 'Confermata', tag });

            const annullata = await annullaPrenotazione({
                idGestionale: scritta.prenotazione!.idGestionale, tag, giorno: '2026-10-08', statoAtteso: 'Confermata',
            });
            expect(annullata).toMatchObject({ esito: 'scritta', prenotazione: { stato: 'Mancata', tavoli: ['29'] } });
            expect((await getPrenotazioniMenuGiorno('2026-10-08')).map((p) => p.tag)).toContain(tag);
            expect(await getPrenotazioniMenuGiorno('2026-10-09')).toEqual([]);
        });
    });
});
