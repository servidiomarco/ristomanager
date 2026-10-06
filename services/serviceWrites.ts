// Le scritture del dominio servizio: UN elenco, letto da due lati (fase B1
// del piano «sala, comande e conto sul nodo»).
// - Il client (services/apiRouting.ts) le manda al nodo quando l'autorità è
//   in sala.
// - Il cloud (server.ts, il «recinto») le rifiuta con 409 quando l'autorità
//   è in sala: senza, un telefono col 4G poteva scrivere sul cloud la stessa
//   comanda (o lo stesso conto) che il nodo stava cambiando, e al rientro
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
    // Fase B3 — il conto in sala: apertura, incassi, sconti, storni,
    // chiusura (anche quella della comanda, che apre il conto), scontrino
    // sul registratore, preconto, sessione di cassa.
    { path: /^\/orders\/\d+\/close$/ },
    { path: /^\/tables\/\d+\/bill$/, method: /^POST$/ },
    { path: /^\/reservations\/\d+\/bill$/, method: /^POST$/ },
    { path: /^\/bills\/\d+\/(close|void|reopen|discount|payments)$/ },
    { path: /^\/bills\/\d+\/payments\/\d+\/void$/ },
    { path: /^\/bills\/\d+\/fiscal-docs$/ },
    { path: /^\/bills\/\d+\/fiscal-docs\/\d+\/void$/ },
    // Fase B5: la chiusura sul gestionale Passepartout la fa chi possiede il
    // conto — l'agente è collegato anche al nodo.
    { path: /^\/bills\/\d+\/passepartout-close$/ },
    { path: /^\/cash\/session(\/\d+(\/close)?)?$/ },
    { path: /^\/print-jobs$/, method: /^POST$/ },
    // Il conto dell'asporto è un conto come gli altri.
    { path: /^\/takeaway\/orders\/\d+\/bill$/, method: /^POST$/ },
    // Tappa C — l'accoglienza: dove siede l'ospite e a che punto è, lo
    // scambio di tavolo, il walk-in. Il resto della prenotazione è del cloud.
    { path: /^\/reservations\/\d+\/service$/, method: /^PATCH$/ },
    { path: /^\/reservations\/\d+\/swap-table$/, method: /^POST$/ },
    { path: /^\/reservations\/walk-in$/, method: /^POST$/ },
];

// Restano al cloud anche con l'autorità in sala: la fattura elettronica e
// la nota di credito (SDI, vive su internet), il rimborso di una quota
// pagata online (il gateway).
export const SERVICE_WRITE_EXCLUDED: RegExp[] = [];

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** La regola che copre la scrittura, o null. pathname senza querystring. */
export const serviceWriteRoute = (method: string, pathname: string): ServiceWriteRoute | null => {
    const m = method.toUpperCase();
    if (!WRITE_METHODS.has(m)) return null;
    if (SERVICE_WRITE_EXCLUDED.some(r => r.test(pathname))) return null;
    return SERVICE_WRITE_ROUTES.find(r => r.path.test(pathname) && (!r.method || r.method.test(m))) ?? null;
};

export const isServiceWrite = (method: string, pathname: string): boolean =>
    serviceWriteRoute(method, pathname) !== null;
