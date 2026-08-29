/* Logo del ristorante nella pagina prenota: legal_config guadagna logo_url
 * (whitelist in server.ts, upload da Impostazioni → identità pubblica).
 *
 * Preload per il Vecchio Frantoio: il logo esiste già come asset statico
 * (/prenota/logo.png → public/logo-vf.png, usato dalle email) — si scrive
 * quel path nel legal_config del tenant 1 così la card lo mostra da subito
 * e la pagina prenota lo espone senza ricaricarlo. Il fallback in codice è
 * deliberatamente vuoto: un logo VF su un tenant nuovo sarebbe il marchio
 * sbagliato in faccia ai suoi clienti.
 */
export const up = (pgm) => {
    pgm.sql(`
        UPDATE app_settings
           SET text_value = (COALESCE(NULLIF(text_value, ''), '{}')::jsonb
                             || '{"logo_url": "/prenota/logo.png"}'::jsonb)::text,
               updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = 1 AND key = 'legal_config'
           AND COALESCE(COALESCE(NULLIF(text_value, ''), '{}')::jsonb->>'logo_url', '') = '';
    `);
    pgm.sql(`
        INSERT INTO app_settings (tenant_id, key, text_value)
        SELECT 1, 'legal_config', '{"logo_url": "/prenota/logo.png"}'
        WHERE NOT EXISTS (
            SELECT 1 FROM app_settings WHERE tenant_id = 1 AND key = 'legal_config'
        );
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        UPDATE app_settings
           SET text_value = (text_value::jsonb - 'logo_url')::text
         WHERE tenant_id = 1 AND key = 'legal_config'
           AND NULLIF(text_value, '') IS NOT NULL;
    `);
};
