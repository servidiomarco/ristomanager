import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// Test API: girano in sequenza contro UN server e UN database condivisi
// (avviati da tests/api/globalSetup.ts) — niente parallelismo fra file,
// o i toggle di settings di un file sporcherebbero le assunzioni di un altro.
//
// L'ORDINE dei file è parte del contratto (orders-bills verifica i flag
// spenti di default, i file dopo di lui li accendono), ma vitest di suo
// prende l'ordine della glob, che dipende dal filesystem: alfabetico su
// macOS, arbitrario su ext4 — e in CI l'ordine cambiava. Il sequencer lo
// rende alfabetico OVUNQUE, così il contratto è esplicito e non fortuna.
class AlphabeticalSequencer extends BaseSequencer {
    async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
        return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
    }
}

export default defineConfig({
    test: {
        include: ['tests/api/**/*.test.ts'],
        globalSetup: ['tests/api/globalSetup.ts'],
        setupFiles: ['tests/api/setupEnv.ts'],
        pool: 'forks',
        fileParallelism: false,
        sequence: { sequencer: AlphabeticalSequencer },
        testTimeout: 30_000,
        hookTimeout: 120_000,
    },
});
