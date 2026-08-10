// Collaudo manuale del client SOAP Passepartout (services/passepartoutService.ts).
//
// Uso (dalla LAN del ristorante, con il Web Service del Tool attivo):
//   PASSEPARTOUT_WS_URL=http://192.168.1.10:7606/AdapterWS \
//   PASSEPARTOUT_WS_USER=admin PASSEPARTOUT_WS_PASSWORD=... \
//   node --loader ts-node/esm scripts/passepartout-test.ts versione
//
// Comandi: versione | pagamenti | tavolo <nome> | comanda <id> | conto <id>
// Non è wired in nessuna route: è solo un attrezzo di sviluppo.

import {
    getVersioneGestionale,
    getTipiPagamento,
    getSaleMenu,
    getComandaTavolo,
    getComanda,
    getConto,
    getContiGiorno,
    contoComanda,
    isPassepartoutConfigured,
    PassepartoutError,
    type TipoDocumentoConto,
} from '../services/passepartoutService.js';

const [cmd, arg, arg2, arg3, arg4, arg5] = process.argv.slice(2);

if (!isPassepartoutConfigured()) {
    console.error('Config mancante: servono PASSEPARTOUT_WS_URL e PASSEPARTOUT_WS_USER (più password).');
    process.exit(1);
}

try {
    switch (cmd) {
        case 'versione':
            console.log('Versione gestionale:', await getVersioneGestionale());
            break;
        case 'pagamenti':
            console.log(JSON.stringify(await getTipiPagamento(), null, 2));
            break;
        case 'sale':
            console.log(JSON.stringify(await getSaleMenu(), null, 2));
            break;
        case 'tavolo': {
            if (!arg) throw new Error('Indica il nome del tavolo: ... tavolo 12');
            const comanda = await getComandaTavolo(arg);
            if (!comanda) { console.log(`Nessuna comanda attiva sul tavolo ${arg}`); break; }
            console.log(JSON.stringify(comanda, null, 2));
            const totale = comanda.righe.reduce((sum, r) => sum + (r.totale ?? 0), 0);
            console.log(`\n${comanda.righe.length} righe, totale righe: €${totale.toFixed(2)}`);
            break;
        }
        case 'comanda':
            console.log(JSON.stringify(await getComanda(Number(arg)), null, 2));
            break;
        case 'conto':
            console.log(JSON.stringify(await getConto(Number(arg)), null, 2));
            break;
        case 'conti-giorno': {
            // arg opzionale: YYYY-MM-DD (default oggi). Stampa i campi chiave
            // per il verdetto post-chiusura.
            const conti = await getContiGiorno(arg || undefined);
            for (const c of conti) {
                console.log(JSON.stringify({
                    id: c.IdGestionale ?? c.idGestionale,
                    idComanda: c.IdComanda ?? c.idComanda,
                    tavolo: c.Tavolo ?? c.tavolo,
                    totale: c.TotaleDaPagare ?? c.totaleDaPagare,
                    pagato: c.TotalePagato ?? c.totalePagato,
                    sospeso: c.Sospeso ?? c.sospeso,
                    scontrino: c.NumeroScontrinoFiscale ?? c.numeroScontrinoFiscale,
                    stato: c.Stato ?? c.stato,
                }));
            }
            console.log(`${conti.length} conti`);
            break;
        }
        case 'chiudi': {
            // ATTENZIONE: azione fiscale — può emettere lo scontrino sul RT.
            // Uso: chiudi <idComanda> <tipoPagamento> [tipoDocumento] [importo] [invio]
            // Il 5° argomento letterale "invio" imposta noInvio=false (le righe
            // non ancora inviate partono in produzione alla chiusura).
            if (!arg || !arg2) throw new Error('Uso: chiudi <idComanda> <tipoPagamento> [tipoDocumento] [importo] [invio]');
            const params = {
                idComanda: Number(arg),
                noInvio: arg5 !== 'invio',
                tipoPagamento: arg2,
                tipoDocumento: (arg3 || undefined) as TipoDocumentoConto | undefined,
                importoPagato: arg4 != null && arg4 !== '' && arg4 !== '-' ? Number(arg4) : undefined,
            };
            console.log('Chiusura con parametri:', JSON.stringify(params));
            await contoComanda(params);
            console.log('ContoComanda eseguito senza errori.');
            break;
        }
        default:
            console.log('Comandi: versione | pagamenti | sale | tavolo <nome> | comanda <id> | conto <id> | chiudi <id> <tipoPag> [tipoDoc] [importo]');
            process.exit(1);
    }
} catch (err) {
    if (err instanceof PassepartoutError) {
        console.error(`Errore dal gestionale [${err.operation}]: ${err.message}`);
        process.exit(2);
    }
    throw err;
}
