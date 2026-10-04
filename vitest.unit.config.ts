import { defineConfig } from 'vitest/config';

// Test unitari: logica pura (geometria del glifo tavolo, servizio corrente e
// simili), senza server né Postgres. Stanno in una configurazione a sé perché
// quella di default (vitest.config.ts) è la suite API, il cui globalSetup
// DROPPA e ricrea il database e che prima compila il server: una funzione
// pura non deve passare di lì, e così gira in un secondo, anche in CI.
// Le due suite non si vedono: questa include solo tests/unit, l'altra solo
// tests/api.
export default defineConfig({
    test: {
        include: ['tests/unit/**/*.test.ts'],
        environment: 'node',
        // Processi, non worker thread: i test sul fuso del dispositivo cambiano
        // process.env.TZ, che solo un processo vero rilegge; in un worker
        // thread resterebbe il fuso di partenza e quei test fallirebbero. È
        // già il default di Vitest 3: è scritto perché i test ci contano.
        pool: 'forks',
    },
});
