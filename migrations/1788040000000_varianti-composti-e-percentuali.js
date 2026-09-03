/**
 * Gestione varianti dal CRM: gruppi accendibili, legami piatto↔gruppo con
 * origine, piatti composti e sovrapprezzi percentuali.
 *
 * - `modifier_groups.is_active`: interruttore del gruppo intero (es. «Aggiunte
 *   tartufo» fuori stagione) senza perdere le assegnazioni ai piatti. Il sync
 *   Passepartout non lo tocca: lo spegnimento sopravvive agli import.
 * - UNIQUE parziale sul nome SOLO per i gruppi manuali (external_ref IS NULL):
 *   le etichette dei gruppi pp sono autogenerate e troncate a 100 caratteri
 *   («Varianti (…)»), possono collidere legittimamente fra set diversi — un
 *   vincolo pieno farebbe fallire l'import.
 * - `dish_modifier_groups.source`: chi ha creato il legame. Il sync inserisce
 *   'pp' e la sua pulizia cancella SOLO i legami 'pp': un gruppo della cassa
 *   agganciato a mano a un piatto ('manual') sopravvive a ogni import.
 *   Backfill: i legami odierni verso gruppi pp li ha creati tutti il sync.
 * - `dishes.dish_type`: SIMPLE com'è oggi, COMPOSED = piatto fatto di
 *   ingredienti (dish_components) pre-inclusi, togliibili sull'orderpad.
 * - `dish_components`: gli ingredienti di un piatto composto. Per-piatto, non
 *   condivisi: non sono modifier — lì conta cosa si aggiunge, qui cosa si
 *   toglie. `removal_delta_cents <= 0`: togliere è gratis (0) o sconta, mai
 *   un sovrapprezzo.
 * - `modifiers.price_delta_pct`: NULL = sovrapprezzo assoluto (dati e sync
 *   odierni intatti); valorizzato = percentuale del prezzo battuto, risolta
 *   in centesimi alla creazione della riga d'ordine (lo snapshot JSONB resta
 *   in centesimi: conti emessi e fiscale non cambiano pipeline).
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE modifier_groups ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;`);
    pgm.sql(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_modifier_groups_tenant_name
            ON modifier_groups (tenant_id, LOWER(name))
            WHERE external_ref IS NULL;
    `);

    pgm.sql(`
        ALTER TABLE dish_modifier_groups
            ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
            CHECK (source IN ('pp', 'manual'));
    `);
    pgm.sql(`
        UPDATE dish_modifier_groups l
           SET source = 'pp'
          FROM modifier_groups g
         WHERE g.id = l.group_id
           AND g.tenant_id = l.tenant_id
           AND g.external_ref LIKE 'pp:varianti:%';
    `);

    pgm.sql(`
        ALTER TABLE dishes
            ADD COLUMN IF NOT EXISTS dish_type TEXT NOT NULL DEFAULT 'SIMPLE'
            CHECK (dish_type IN ('SIMPLE', 'COMPOSED'));
    `);

    pgm.sql(`
        CREATE TABLE dish_components (
            id                  SERIAL PRIMARY KEY,
            tenant_id           BIGINT NOT NULL REFERENCES tenants(id),
            dish_id             INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
            name                VARCHAR(100) NOT NULL,
            removal_delta_cents INTEGER NOT NULL DEFAULT 0 CHECK (removal_delta_cents <= 0),
            sort_order          INTEGER NOT NULL DEFAULT 0
        );
    `);
    pgm.sql(`CREATE INDEX idx_dish_components_dish ON dish_components (tenant_id, dish_id, sort_order);`);

    // RLS come per ogni tabella nuova con tenant_id: la migration B4 ha
    // coperto solo l'esistente. Espressione copiata verbatim da
    // chat-interna-staff.
    const POLICY = `
        (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::bigint)
        OR (
            (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
            AND (
                (current_setting('app.rls_strict', true) IS DISTINCT FROM 'on')
                OR (current_setting('app.rls_bypass', true) = 'on')
            )
        )
    `;
    pgm.sql(`ALTER TABLE dish_components ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE dish_components FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON dish_components;`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON dish_components
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);

    // > -100: uno «sconto» del 100% o più renderebbe la variante un prezzo
    // negativo del piatto; <= 500 taglia i refusi (5000% da un 50,00 battuto
    // nel campo sbagliato).
    pgm.sql(`
        ALTER TABLE modifiers
            ADD COLUMN IF NOT EXISTS price_delta_pct NUMERIC(5,2)
            CHECK (price_delta_pct > -100 AND price_delta_pct <= 500);
    `);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE modifiers DROP COLUMN IF EXISTS price_delta_pct;`);
    pgm.sql(`DROP TABLE IF EXISTS dish_components;`);
    pgm.sql(`ALTER TABLE dishes DROP COLUMN IF EXISTS dish_type;`);
    pgm.sql(`ALTER TABLE dish_modifier_groups DROP COLUMN IF EXISTS source;`);
    pgm.sql(`DROP INDEX IF EXISTS idx_modifier_groups_tenant_name;`);
    pgm.sql(`ALTER TABLE modifier_groups DROP COLUMN IF EXISTS is_active;`);
};
