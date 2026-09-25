// Gira PRIMA degli import di ogni file di test (setupFiles in vitest.config).
//
// Serve ai test che importano moduli del server in-process (billing.test.ts
// importa billingService → db.ts): il pool di db.ts legge DATABASE_URL al
// momento dell'import, e senza variabile pg ricade sul database con il nome
// dell'utente di sistema — che non esiste, e il test fallisce per la
// connessione invece che per ciò che verifica. Il default è lo stesso di
// tests/api/globalSetup.ts: se cambia lì deve cambiare anche qui.
import { afterAll, beforeAll } from 'vitest';
import { violazioniTenant } from './sentinellaTenant';

process.env.DATABASE_URL ||= 'postgresql://localhost/ristotest_api';

// Sentinella dell'invariante del tenant (audit isolamento tenant, H-07; vedi
// sentinellaTenant.ts): il file durante il quale il server ha scartato un
// evento diretto a un altro tenant fallisce lui, con la riga del log, invece
// di lasciare solo il teardown a segnalarlo in fondo alla run. I file girano
// in sequenza (fileParallelism: false), quindi la riga è sua salvo un lavoro
// in background rimasto dal file prima: il testo dice comunque evento e tenant.
let violazioniPrima = 0;
beforeAll(() => {
    violazioniPrima = violazioniTenant().length;
});
afterAll(() => {
    const nuove = violazioniTenant().slice(violazioniPrima);
    if (nuove.length > 0) {
        throw new Error(
            `Il server ha emesso eventi verso un tenant diverso da quello della richiesta (invariante di SocketService.emitTo, audit H-07):\n${nuove.join('\n')}`
        );
    }
});
