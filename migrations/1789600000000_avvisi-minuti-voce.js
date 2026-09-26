/* Minuti di Sofia: il ristoratore sceglie a quale percentuale dei minuti
 * inclusi ricevere l'avviso.
 *
 * voice_plans.alert_percents: le soglie scelte, fra quelle offerte in
 * services/voicePlan.ts (50, 80, 90, 100). NULL = default (80, 90, 100);
 * un array vuoto = nessun avviso sui minuti inclusi. Gli avvisi sul tetto
 * degli extra non dipendono da qui e partono sempre.
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE voice_plans
            ADD COLUMN IF NOT EXISTS alert_percents SMALLINT[]
            CHECK (alert_percents <@ ARRAY[50, 80, 90, 100]::smallint[]);
    `);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE voice_plans DROP COLUMN IF EXISTS alert_percents;`);
};
