/* Quanto costa ogni chiamata di Sofia (Fase 1 dei minuti inclusi nell'add-on).
 *
 * ElevenLabs manda il costo di ogni conversazione nel webhook di fine
 * chiamata (metadata.cost in crediti, metadata.charging.llm_price e
 * platform_price in dollari) e il post-call lo scartava: per sapere quanto
 * costa un ristorante bisognava rileggere l'API a mano. Con il costo sulla
 * riga si possono sommare minuti e spesa per ristorante e per giorno — il
 * conto ElevenLabs è unico per tutti i tenant, quindi il consumo del singolo
 * ristorante esiste solo qui.
 *
 * NULL = costo non noto (chiamate precedenti a questa colonna finché lo
 * script di backfill non le riempie): le viste lo dicono invece di contare
 * zero.
 *
 * L'indice su (tenant_id, created_at) serve ai riepiloghi mensili per
 * tenant: senza, ogni apertura del pannello scorre tutta la tabella.
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE voice_calls
            ADD COLUMN IF NOT EXISTS cost_credits INTEGER,
            ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,5),
            ADD COLUMN IF NOT EXISTS llm_cost_usd NUMERIC(10,5),
            ADD COLUMN IF NOT EXISTS platform_cost_usd NUMERIC(10,5);
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_voice_calls_tenant_created ON voice_calls (tenant_id, created_at);`);
};

export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS idx_voice_calls_tenant_created;`);
    pgm.sql(`
        ALTER TABLE voice_calls
            DROP COLUMN IF EXISTS cost_credits,
            DROP COLUMN IF EXISTS cost_usd,
            DROP COLUMN IF EXISTS llm_cost_usd,
            DROP COLUMN IF EXISTS platform_cost_usd;
    `);
};
