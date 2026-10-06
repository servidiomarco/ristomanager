import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chiudiComandaCompleta, emettiPreconto, precontoUnaVolta } from '../../services/passepartoutService';

// Il client della cassa Passepartout davanti a una cassa SOAP finta, per le
// due cose emerse dalle prove sulla cassa vera del 06/10:
// - una comanda col preconto stampato non si chiude con ContoComanda (che
//   in Passepartout va in errore cancellando il conto del preconto): si
//   chiude quel conto con PutConto, il pagamento esterno al posto dei
//   contanti precompilati;
// - il preconto si stampa con un ComandoComanda «Preconto» su RiceviMessaggio
//   dell'endpoint /Adapter, una volta sola.

interface Chiamata { path: string; action: string; body: string }

const busta = (op: string, risultato: string) =>
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<${op}Response xmlns="http://tempuri.org/"><${op}Result xmlns:a="http://schemas.datacontract.org/2004/07/PMessageBox.Contract.Conto" ` +
    `xmlns:i="http://www.w3.org/2001/XMLSchema-instance">${risultato}</${op}Result></${op}Response></s:Body></s:Envelope>`;
const faultXml = (msg: string) =>
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode>` +
    `<faultstring>${msg}</faultstring></s:Fault></s:Body></s:Envelope>`;

describe('cassa Passepartout: preconto e chiusura dopo il preconto', () => {
    let server: http.Server;
    const chiamate: Chiamata[] = [];
    // Lo stato della cassa finta.
    let conti: Array<{ id: number; comanda: number; stato: 'Aperto' | 'Pagato'; sospeso: number; daPagare: number; pagato: number }> = [];
    let erroriMessaggio: string[] = [];

    const contoXml = (c: typeof conti[number]) =>
        `<a:ContrattoConto><a:IdComanda>${c.comanda}</a:IdComanda><a:IdGestionale>${c.id}</a:IdGestionale>` +
        `<a:NumeroScontrinoFiscale i:nil="true"/><a:Sospeso>${c.sospeso.toFixed(2)}</a:Sospeso>` +
        `<a:StatoEnum>${c.stato}</a:StatoEnum><a:TotaleDaPagare>${c.daPagare.toFixed(2)}</a:TotaleDaPagare>` +
        `<a:TotalePagato>${c.pagato.toFixed(2)}</a:TotalePagato></a:ContrattoConto>`;
    const comandaXml = (id: number) =>
        `<a:IdGestionale>${id}</a:IdGestionale><a:IsPagato>false</a:IsPagato><a:Stato>1</a:Stato><a:Tavolo>29</a:Tavolo><a:Sala>DENTRO</a:Sala>` +
        `<a:Righe><a:PMBRigaComanda><a:Descrizione>Coperti</a:Descrizione><a:IdGestionale>1</a:IdGestionale><a:Pezzi>2</a:Pezzi><a:Prezzo>1</a:Prezzo><a:Stato>3</a:Stato><a:Totale>2</a:Totale></a:PMBRigaComanda>` +
        `<a:PMBRigaComanda><a:Descrizione>Antipasto</a:Descrizione><a:IdGestionale>2</a:IdGestionale><a:Pezzi>1</a:Pezzi><a:Prezzo>1</a:Prezzo><a:Stato>3</a:Stato><a:Totale>1</a:Totale></a:PMBRigaComanda></a:Righe>`;
    const ultima = (op: string) => chiamate.filter(c => c.action.endsWith(`/${op}"`)).pop();

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (d) => { body += d; });
            req.on('end', () => {
                const action = String(req.headers.soapaction ?? '');
                chiamate.push({ path: req.url ?? '', action, body });
                const op = action.replace(/"/g, '').split('/').pop() ?? '';
                const rispondi = (xml: string) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(xml); };
                if (op === 'GetContiGiorno') return rispondi(busta(op, conti.map(contoXml).join('')));
                if (op === 'GetComanda') return rispondi(busta(op, comandaXml(Number(body.match(/<idGestionale>(\d+)</)?.[1]))));
                if (op === 'GetTipiPagamento') {
                    return rispondi(busta(op,
                        `<b:PMBTipoPagamento xmlns:b="x"><b:Categoria>Contanti</b:Categoria><b:Codice>Contanti</b:Codice></b:PMBTipoPagamento>` +
                        `<b:PMBTipoPagamento xmlns:b="x"><b:Categoria>Varie1</b:Categoria><b:Codice>ESTERNO</b:Codice></b:PMBTipoPagamento>`));
                }
                if (op === 'PutConto') {
                    const id = Number(body.match(/IdGestionale>(\d+)</)?.[1]);
                    const c = conti.find(x => x.id === id);
                    if (c) { c.stato = 'Pagato'; c.pagato = c.daPagare; }
                    return rispondi(busta(op, c ? contoXml(c).replace(/^<a:ContrattoConto>|<\/a:ContrattoConto>$/g, '') : ''));
                }
                // Come la cassa vera dopo un preconto (pmbLog del 06/10).
                if (op === 'ContoComanda') return rispondi(faultXml("E' avvenuto un errore interno sul server"));
                if (op === 'RiceviMessaggio') {
                    return rispondi(
                        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><RiceviMessaggioResponse xmlns="http://tempuri.org/">` +
                        `<Risposta xmlns:a="http://schemas.datacontract.org/2004/07/PMessageBox.Contract"><a:Errori xmlns:b="http://schemas.microsoft.com/2003/10/Serialization/Arrays">` +
                        erroriMessaggio.map(e => `<b:string>${e}</b:string>`).join('') +
                        `</a:Errori><a:IsDead>false</a:IsDead></Risposta></RiceviMessaggioResponse></s:Body></s:Envelope>`);
                }
                rispondi(faultXml(`op non prevista: ${op}`));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        process.env.PASSEPARTOUT_WS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/AdapterWS`;
        process.env.PASSEPARTOUT_WS_USER = 'utente-prova';
        process.env.PASSEPARTOUT_WS_PASSWORD = 'segreto-prova';
    });

    afterAll(async () => {
        delete process.env.PASSEPARTOUT_WS_URL;
        delete process.env.PASSEPARTOUT_WS_USER;
        delete process.env.PASSEPARTOUT_WS_PASSWORD;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        chiamate.length = 0;
        erroriMessaggio = [];
        // Il conto che il preconto lascia: Aperto, coperto dai contanti precompilati.
        conti = [{ id: 82583, comanda: 78532, stato: 'Aperto', sospeso: 0, daPagare: 3, pagato: 3 }];
    });

    it('col preconto chiude quel conto: PutConto «Chiudi», proforma, ESTERNO al posto dei contanti', async () => {
        const esito = await chiudiComandaCompleta({ idComanda: 78532, tipoPagamento: 'ESTERNO', proforma: true });
        expect(esito).toMatchObject({ chiuso: true, stato: 'Pagato', totaleDaPagare: 3, avviso: null });
        expect(ultima('ContoComanda')).toBeUndefined();
        const put = ultima('PutConto')!.body;
        expect(put).toContain('<c:ComandoEnum>Chiudi</c:ComandoEnum>');
        expect(put).toContain('<c:IdGestionale>82583</c:IdGestionale>');
        expect(put).toContain('<c:Importo>3.00</c:Importo>');
        expect(put).toContain('<cm:Categoria>Varie1</cm:Categoria><cm:Codice>ESTERNO</cm:Codice>');
        expect(put).toContain('<c:TipoDocumentoEnum>Proforma</c:TipoDocumentoEnum>');
        // Ordine del data contract: Pagamenti prima di TipoDocumentoEnum.
        expect(put.indexOf('<c:Pagamenti>')).toBeLessThan(put.indexOf('<c:TipoDocumentoEnum>'));
    });

    it('con lo scontrino lo emette: «ChiudiEStampa»', async () => {
        await chiudiComandaCompleta({ idComanda: 78532, tipoPagamento: 'ESTERNO', tipoDocumento: 'Scontrino' });
        const put = ultima('PutConto')!.body;
        expect(put).toContain('<c:ComandoEnum>ChiudiEStampa</c:ComandoEnum>');
        expect(put).toContain('<c:TipoDocumentoEnum>Scontrino</c:TipoDocumentoEnum>');
    });

    it('un nuovo tentativo non scambia il conto del preconto per una chiusura già fatta', async () => {
        const esito = await chiudiComandaCompleta({ idComanda: 78532, tipoPagamento: 'ESTERNO', proforma: true, riprendi: true });
        expect(esito.stato).toBe('Pagato');
        expect(ultima('PutConto')).toBeDefined();
    });

    it('senza il tipo di pagamento in cassa non chiude, e lo dice', async () => {
        await expect(chiudiComandaCompleta({ idComanda: 78532, tipoPagamento: 'BONIFICO', proforma: true }))
            .rejects.toThrow(/BONIFICO/);
        expect(ultima('PutConto')).toBeUndefined();
    });

    it('senza preconto resta la chiusura di prima (ContoComanda)', async () => {
        conti = [];
        await expect(chiudiComandaCompleta({ idComanda: 78532, tipoPagamento: 'ESTERNO', proforma: true })).rejects.toThrow();
        expect(ultima('ContoComanda')).toBeDefined();
        expect(ultima('PutConto')).toBeUndefined();
    });

    it('il preconto va su /Adapter con un ComandoComanda «Preconto», credenziali nel messaggio', async () => {
        await emettiPreconto(78532);
        const msg = ultima('RiceviMessaggio')!;
        expect(msg.path).toBe('/Adapter');
        expect(msg.action).toBe('"http://tempuri.org/IAdapter/RiceviMessaggio"');
        expect(msg.body).toContain('<b:ComandoEnum>ComandoImmediato</b:ComandoEnum>');
        expect(msg.body).toContain('i:type="c:ComandoComanda"');
        expect(msg.body).toContain('<c:Comando>Preconto</c:Comando><c:IDGestionale>78532</c:IDGestionale>');
        expect(msg.body).toContain('<b:Utente>utente-prova</b:Utente>');
        expect(msg.body).not.toContain('datiLogin');
    });

    it('gli errori del messaggio tornano come errore', async () => {
        erroriMessaggio = ['Comanda non trovata'];
        await expect(emettiPreconto(1)).rejects.toThrow('Comanda non trovata');
    });

    it('una volta sola: con il conto di un preconto già aperto non se ne stampa un altro', async () => {
        expect(await precontoUnaVolta(78532)).toEqual({ emesso: false });
        expect(ultima('RiceviMessaggio')).toBeUndefined();
        conti = [];
        expect(await precontoUnaVolta(78532)).toEqual({ emesso: true });
        expect(ultima('RiceviMessaggio')).toBeDefined();
    });
});
