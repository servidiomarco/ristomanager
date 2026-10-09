import http from 'node:http';

// ---------------------------------------------------------------------------
// La cassa finta: comande e righe in memoria, PutComanda come la cassa vera
// (righe con id = cambiate, senza id = aggiunte, DaCancellare = tolte se mai
// mandate, «Cancellato» se mandate).
// ---------------------------------------------------------------------------
export interface RigaFinta { id: number; articolo: string; descrizione: string; pezzi: number; prezzo: number; uscita: number; stato: string; tipo: string; varianti: string[] }
export interface ComandaFinta { id: number; note: string; sala: string; tavolo: string; coperti: number; pagata: boolean; righe: RigaFinta[] }

export const CATALOGO = [
    { id: 1, codice: 'Coperti', descrizione: 'Coperti', prezzo: 3 },
    { id: 11, codice: 'Tagliatelle Silana', descrizione: 'Tagliatelle Silana', prezzo: 13 },
    { id: 12, codice: 'Gnocchi Silani', descrizione: 'Gnocchi Silani', prezzo: 12 },
    { id: 500, codice: 'VARIE', descrizione: 'Varie', prezzo: 0 },
];

export function cassaFinta() {
    const comande = new Map<number, ComandaFinta>();
    let prossima = 80_000;
    let prossimaRiga = 900_000;
    const put: string[] = [];
    // Gli invii in produzione (InviaProduzioneComanda), e i tavoli su cui la
    // cassa rifiuta la scrittura (come la comanda vecchia della demo).
    const invii: Array<{ id: number; uscite: number[] }> = [];
    const rifiuta = new Set<string>();
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const un = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const campo = (xml: string, nome: string) => {
        const m = new RegExp(`<c:${nome}>([^<]*)</c:${nome}>`).exec(xml);
        return m ? un(m[1]) : null;
    };
    const comandaXml = (c: ComandaFinta) =>
        `<a:Coperti>${c.coperti}</a:Coperti><a:IdGestionale>${c.id}</a:IdGestionale><a:IsPagato>${c.pagata}</a:IsPagato>` +
        `<a:Note>${esc(c.note)}</a:Note><a:Righe>` + c.righe.map((r) =>
            `<a:PMBRigaComanda><a:Articolo>${esc(r.articolo)}</a:Articolo><a:Descrizione>${esc(r.descrizione)}</a:Descrizione>` +
            `<a:IdGestionale>${r.id}</a:IdGestionale><a:Pezzi>${r.pezzi}</a:Pezzi><a:Prezzo>${r.prezzo.toFixed(4)}</a:Prezzo>` +
            `<a:StatoEnum>${r.stato}</a:StatoEnum><a:TipoEnum>${r.tipo}</a:TipoEnum><a:Totale>${(r.prezzo * r.pezzi).toFixed(4)}</a:Totale>` +
            `<a:Uscita>${r.uscita}</a:Uscita></a:PMBRigaComanda>`).join('') +
        `</a:Righe><a:Sala>${esc(c.sala)}</a:Sala><a:Tavolo>${esc(c.tavolo)}</a:Tavolo>`;

    function putComanda(body: string): ComandaFinta {
        put.push(body);
        const corpo = /<comanda[^>]*>([\s\S]*)<\/comanda>/.exec(body)![1];
        const [testa, resto = ''] = corpo.split('<c:Righe>');
        const [righeXml, coda = ''] = resto.split('</c:Righe>');
        const id = campo(testa, 'IdGestionale');
        let c: ComandaFinta;
        if (id) {
            c = comande.get(Number(id))!;
        } else {
            c = {
                id: ++prossima, note: campo(testa, 'Note') ?? '', sala: campo(coda, 'Sala') ?? '', tavolo: campo(coda, 'Tavolo') ?? '',
                coperti: Number(campo(testa, 'Coperti') ?? 0), pagata: false, righe: [],
            };
            comande.set(c.id, c);
        }
        for (const xml of righeXml.match(/<c:PMBRigaComanda>[\s\S]*?<\/c:PMBRigaComanda>/g) ?? []) {
            const varianti = [...xml.matchAll(/<c:PMBRigaVariante><c:Descrizione>([^<]*)<\/c:Descrizione><c:InAggiunta>(true|false)<\/c:InAggiunta>/g)]
                .map((m) => `${m[2] === 'true' ? '+' : '-'}${un(m[1])}`);
            const r = xml.replace(/<c:Varianti>[\s\S]*<\/c:Varianti>/, '');
            const idRiga = campo(r, 'IdGestionale');
            if (idRiga) {
                const esistente = c.righe.find((x) => x.id === Number(idRiga))!;
                if (campo(r, 'DaCancellare') === 'true') {
                    if (esistente.stato === 'Nuovo') c.righe = c.righe.filter((x) => x !== esistente);
                    else esistente.stato = 'Cancellato';
                } else {
                    esistente.pezzi = Number(campo(r, 'Pezzi'));
                    // Senza prezzo resta quello che c'è, come la cassa vera.
                    if (campo(r, 'Prezzo') != null) esistente.prezzo = Number(campo(r, 'Prezzo'));
                }
                continue;
            }
            const articolo = campo(r, 'Articolo') ?? '';
            const coperto = campo(r, 'TipoEnum') === 'Coperto';
            c.righe.push({
                id: ++prossimaRiga, articolo, descrizione: campo(r, 'Descrizione') ?? CATALOGO.find((a) => a.codice === articolo)?.descrizione ?? articolo,
                // Senza prezzo la cassa prende quello del suo listino (prova del 07/10).
                pezzi: Number(campo(r, 'Pezzi')),
                prezzo: campo(r, 'Prezzo') != null ? Number(campo(r, 'Prezzo')) : (CATALOGO.find((a) => a.codice === articolo)?.prezzo ?? 0),
                uscita: coperto ? 0 : Number(campo(r, 'Uscita') ?? 1),
                stato: 'Nuovo', tipo: coperto ? 'Coperto' : 'Semplice', varianti,
            });
        }
        return c;
    }

    const busta = (op: string, risultato: string) =>
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
        `<${op}Response xmlns="http://tempuri.org/"><${op}Result xmlns:a="x" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">${risultato}</${op}Result></${op}Response></s:Body></s:Envelope>`;
    const nil = (op: string) =>
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><${op}Response xmlns="http://tempuri.org/">` +
        `<${op}Result i:nil="true" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"/></${op}Response></s:Body></s:Envelope>`;

    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const op = String(req.headers.soapaction ?? '').replace(/"/g, '').split('/').pop() ?? '';
            const ok = (xml: string) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(xml); };
            if (op === 'GetArticoli') {
                return ok(busta(op, CATALOGO.map((a) =>
                    `<a:ContrattoArticolo><a:Codice>${a.codice}</a:Codice><a:Descrizione>${a.descrizione}</a:Descrizione>` +
                    `<a:IdGestionale>${a.id}</a:IdGestionale><a:IsAttivo>true</a:IsAttivo><a:Prezzo>${a.prezzo}</a:Prezzo></a:ContrattoArticolo>`).join('')));
            }
            if (op === 'GetComanda') {
                const c = comande.get(Number(/<idGestionale>(\d+)<\/idGestionale>/.exec(body)?.[1]));
                return ok(c ? busta(op, comandaXml(c)) : nil(op));
            }
            if (op === 'GetComandaTavolo') {
                const tavolo = /<tavolo>([^<]*)<\/tavolo>/.exec(body)?.[1] ?? '';
                const c = [...comande.values()].find((x) => x.tavolo === tavolo && !x.pagata);
                return ok(c ? busta(op, comandaXml(c)) : nil(op));
            }
            if (op === 'PutComanda') {
                const tavolo = /<c:Tavolo>([^<]*)<\/c:Tavolo>/.exec(body)?.[1];
                if (tavolo && rifiuta.has(tavolo)) {
                    return ok(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>Errore comanda: System.NullReferenceException</faultstring></s:Fault></s:Body></s:Envelope>`);
                }
                return ok(busta(op, comandaXml(putComanda(body))));
            }
            if (op === 'InviaProduzioneComanda') {
                const id = Number(/<idComanda>(\d+)<\/idComanda>/.exec(body)?.[1]);
                const uscite = [...body.matchAll(/<a:int>(\d+)<\/a:int>/g)].map((m) => Number(m[1]));
                invii.push({ id, uscite });
                for (const r of comande.get(id)?.righe ?? []) {
                    if (r.stato === 'Nuovo' && r.tipo !== 'Coperto' && (uscite.length === 0 || uscite.includes(r.uscita))) r.stato = 'InProduzione';
                }
                return ok(nil(op));
            }
            ok(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>op non prevista: ${op}</faultstring></s:Fault></s:Body></s:Envelope>`);
        });
    });
    return { server, comande, put, invii, rifiuta, sulTavolo: (t: string) => [...comande.values()].find((c) => c.tavolo === t && !c.pagata) ?? null };
}
