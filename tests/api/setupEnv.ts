// Gira PRIMA degli import di ogni file di test (setupFiles in vitest.config).
//
// Serve ai test che importano moduli del server in-process (billing.test.ts
// importa billingService → db.ts): il pool di db.ts legge DATABASE_URL al
// momento dell'import, e senza variabile pg ricade sul database con il nome
// dell'utente di sistema — che non esiste, e il test fallisce per la
// connessione invece che per ciò che verifica. Il default è lo stesso di
// tests/api/globalSetup.ts: se cambia lì deve cambiare anche qui.
process.env.DATABASE_URL ||= 'postgresql://localhost/ristotest_api';
