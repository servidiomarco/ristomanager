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
    contoComanda,
    isPassepartoutConfigured,
    PassepartoutError,
    type TipoDocumentoConto,
} from '../services/passepartoutService.js';

const [cmd, arg, arg2, arg3, arg4] = process.argv.slice(2);

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
        case 'chiudi': {
            // ATTENZIONE: azione fiscale — può emettere lo scontrino sul RT.
            // Uso: chiudi <idComanda> <tipoPagamento> [tipoDocumento] [importo]
            if (!arg || !arg2) throw new Error('Uso: chiudi <idComanda> <tipoPagamento> [tipoDocumento] [importo]');
            const params = {
                idComanda: Number(arg),
                noInvio: true,
                tipoPagamento: arg2,
                tipoDocumento: (arg3 || undefined) as TipoDocumentoConto | undefined,
                importoPagato: arg4 != null ? Number(arg4) : undefined,
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
