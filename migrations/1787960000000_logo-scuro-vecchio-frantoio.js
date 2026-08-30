/* Variante scura del logo (legal_config.logo_dark_url): come le email, che
 * scambiano logo.png/logo-dark.png col tema. A Marco la piastra bianca
 * dietro il logo in dark mode non piace — con la variante il CRM scambia
 * l'immagine e la piastra resta solo per chi non la carica.
 *
 * Preload per il Vecchio Frantoio: l'artwork bianco esiste già come asset
 * (/prenota/logo-dark.png → public/logo-vf-dark.png, usato dalle email).
 */
export const up = (pgm) => {
    pgm.sql(`
        UPDATE app_settings
           SET text_value = (COALESCE(NULLIF(text_value, ''), '{}')::jsonb
                             || '{"logo_dark_url": "/prenota/logo-dark.png"}'::jsonb)::text,
               updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = 1 AND key = 'legal_config'
           AND COALESCE(COALESCE(NULLIF(text_value, ''), '{}')::jsonb->>'logo_dark_url', '') = '';
    `);
    pgm.sql(`
        INSERT INTO app_settings (tenant_id, key, text_value)
        SELECT 1, 'legal_config', '{"logo_dark_url": "/prenota/logo-dark.png"}'
        WHERE NOT EXISTS (
            SELECT 1 FROM app_settings WHERE tenant_id = 1 AND key = 'legal_config'
        );
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        UPDATE app_settings
           SET text_value = (text_value::jsonb - 'logo_dark_url')::text
         WHERE tenant_id = 1 AND key = 'legal_config'
           AND NULLIF(text_value, '') IS NOT NULL;
    `);
};
