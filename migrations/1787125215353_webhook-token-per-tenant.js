/**
 * Fase C2 — Webhook instradabili per tenant (token su tenants).
 *
 * I webhook arrivano senza JWT: finora tutto il traffico non autenticato
 * cadeva sul tenant 1 (PUBLIC_TENANT_ID). Con questi due token il tenant si
 * risolve dall'URL, come già fa SumUp (/webhook/sumup/:token — l'unico
 * webhook già discriminato):
 *
 *   - webhook_token     → /webhook/t/:tenantToken/<provider> (ElevenLabs,
 *                         Twilio, Vonage, Resend). I vecchi path restano
 *                         alias del tenant 1 finché i provider non sono
 *                         riconfigurati.
 *   - print_agent_token → header x-print-agent-token dell'agente di stampa,
 *                         al posto del globale PRINT_AGENT_TOKEN da env: oggi
 *                         qualunque agente può drenare la coda di chiunque.
 *
 * VARCHAR(64) UNIQUE, nullable: i token nascono col provisioning (D1 li
 * genererà per i tenant nuovi); qui si backfilla solo il tenant 1 così il
 * Frantoio può migrare i provider subito. pgcrypto per gen_random_bytes:
 * 24 byte → 48 caratteri hex, non indovinabili per costruzione.
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

        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS webhook_token VARCHAR(64) UNIQUE;
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS print_agent_token VARCHAR(64) UNIQUE;

        -- Backfill del solo tenant 1: gli altri (futuri) li genera il
        -- provisioning D1. Il WHERE ... IS NULL rende la migration
        -- ri-eseguibile senza ruotare un token già consegnato ai provider.
        UPDATE tenants
        SET webhook_token = encode(gen_random_bytes(24), 'hex')
        WHERE id = 1 AND webhook_token IS NULL;

        UPDATE tenants
        SET print_agent_token = encode(gen_random_bytes(24), 'hex')
        WHERE id = 1 AND print_agent_token IS NULL;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE tenants DROP COLUMN IF EXISTS webhook_token;
        ALTER TABLE tenants DROP COLUMN IF EXISTS print_agent_token;
    `);
};
