// Sentinella dell'invariante di SocketService.emitTo (audit isolamento
// tenant, H-07). Il server dei test gira con SOCKET_TENANT_INVARIANT_ENFORCE=1:
// un evento emesso verso un tenant diverso da quello della richiesta viene
// scartato. Da solo lo scarto nasconderebbe il difetto invece di segnalarlo:
// il socket «sbagliato» non riceve niente, e le asserzioni negative («il
// Frantoio non riceve nulla») passerebbero anche sul codice che instrada
// male. Per questo globalSetup copia ogni riga '[tenant-invariant]' del log
// del server in un file (TEST_TENANT_INVARIANT_LOG): setupEnv.ts fa fallire
// il file di test durante il quale compaiono, il teardown fa fallire la run,
// e un test può controllarle da sé subito dopo l'azione che prova.

import { existsSync, readFileSync } from 'node:fs';

export const TENANT_INVARIANT_TAG = '[tenant-invariant]';

/** Tutte le righe '[tenant-invariant]' del server dall'inizio della run. */
export const violazioniTenant = (): string[] => {
    const file = process.env.TEST_TENANT_INVARIANT_LOG;
    if (!file || !existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean);
};
