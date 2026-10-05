// Le scritture del dominio servizio: UN elenco, letto da due lati (fase B1
// del piano «sala, comande e conto sul nodo»).
// - Il client (services/apiRouting.ts) le manda al nodo quando l'autorità è
//   in sala.
// - Il cloud (server.ts, il «recinto») le rifiuta con 409 quando l'autorità
//   è in sala e il nodo è vivo: senza, un telefono col 4G poteva scrivere
//   sul cloud la stessa comanda che il nodo stava cambiando, e al rientro
//   avremmo avuto due verità.
// Niente import: lo leggono sia il bundle della SPA sia il server.

export interface ServiceWriteRoute {
    path: RegExp;
    method?: RegExp;
}

export const SERVICE_WRITE_ROUTES: ServiceWriteRoute[] = [
    // Comande e cucina: il cuore dell'autorità di servizio.
    { path: /^\/orders(\/.*)?$/ },
    { path: /^\/kds\/.+$/ },
    // Stato del tavolo: SOLO il PUT — la DELETE è pianta (autorità cloud).
    { path: /^\/tables\/\d+$/, method: /^PUT$/ },
    { path: /^\/table-merges$/ },
    { path: /^\/table-hidden$/ },
    { path: /^\/room-closed$/ },
    // Asporto: la board (stato, lancio, righe) è servizio; la nascita resta
    // al cloud (tipo split, arriva online e al telefono).
    { path: /^\/takeaway\/orders\/\d+$/, method: /^PATCH$/ },
    { path: /^\/takeaway\/orders\/\d+\/(status|fire)$/ },
];

// La chiusura comanda apre e salda il CONTO: finché i conti restano
// autorità cloud (fase B3) va al cloud anche con l'autorità in sala.
export const SERVICE_WRITE_EXCLUDED: RegExp[] = [/^\/orders\/\d+\/close$/];

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** pathname senza querystring, metodo HTTP qualunque maiuscolo/minuscolo. */
export const isServiceWrite = (method: string, pathname: string): boolean => {
    const m = method.toUpperCase();
    if (!WRITE_METHODS.has(m)) return false;
    if (SERVICE_WRITE_EXCLUDED.some(r => r.test(pathname))) return false;
    return SERVICE_WRITE_ROUTES.some(r => r.path.test(pathname) && (!r.method || r.method.test(m)));
};
