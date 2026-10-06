/**
 * Passepartout per ristorante: l'integrazione smette di essere «del
 * Frantoio» (un solo agente e una sola configurazione, da variabili
 * d'ambiente) e diventa una scelta di ogni ristorante con la cassa.
 *
 * - tenants.passepartout_agent_token: il token con cui l'agente sul PC di
 *   sala di quel ristorante si collega a /pp-agent. Segreto di macchina
 *   come sala_node_token: non passa dalle Impostazioni, chi installa
 *   l'agente lo legge dal DB. Generato per tutti i ristoranti, esistenti e
 *   nuovi (default): non serve un passo di provisioning in più. Il token
 *   storico in PASSEPARTOUT_AGENT_TOKEN resta valido per il ristorante 1.
 * - passepartout_config.tipo_pagamento_esterno / tipo_documento: con che
 *   tipo di pagamento e documento la cassa chiude i conti saldati nel CRM.
 *   Erano PASSEPARTOUT_TIPO_PAGAMENTO / _DOCUMENTO, che restano il ripiego
 *   del ristorante 1 finché la sezione non li imposta.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS passepartout_agent_token VARCHAR(64) UNIQUE
            DEFAULT encode(gen_random_bytes(24), 'hex');
        UPDATE tenants SET passepartout_agent_token = encode(gen_random_bytes(24), 'hex')
         WHERE passepartout_agent_token IS NULL;
    `);
    pgm.sql(`
        ALTER TABLE passepartout_config
            ADD COLUMN IF NOT EXISTS tipo_pagamento_esterno VARCHAR(100),
            ADD COLUMN IF NOT EXISTS tipo_documento VARCHAR(20)
                CHECK (tipo_documento IS NULL OR tipo_documento IN ('Scontrino', 'Proforma'));
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE passepartout_config
            DROP COLUMN IF EXISTS tipo_pagamento_esterno,
            DROP COLUMN IF EXISTS tipo_documento;
    `);
    pgm.sql(`ALTER TABLE tenants DROP COLUMN IF EXISTS passepartout_agent_token;`);
};
