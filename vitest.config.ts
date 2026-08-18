import { defineConfig } from 'vitest/config';

// Test API: girano in sequenza contro UN server e UN database condivisi
// (avviati da tests/api/globalSetup.ts) — niente parallelismo fra file,
// o i toggle di settings di un file sporcherebbero le assunzioni di un altro.
export default defineConfig({
    test: {
        include: ['tests/api/**/*.test.ts'],
        globalSetup: ['tests/api/globalSetup.ts'],
        pool: 'forks',
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 120_000,
    },
});
