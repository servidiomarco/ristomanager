// Rifinitura della normalizzazione titoli (titoli-menu-title-case): le
// sigle PUNTATE. I punti non sono confini di parola per il Title Case,
// quindi «salumi d.o.p.» era uscito «Salumi D.o.p.» (visto in produzione).
// Regola: una sequenza di almeno due coppie lettera-punto è una sigla e va
// tutta maiuscola («D.O.P.», «S.P.A.»); il minimo di due coppie protegge le
// abbreviazioni vere («Mel.», «Pat.»), che di coppia ne hanno una sola.
// Replica DOTTED_ACRONYMS di utils/text.ts (toMenuTitleCase): dati e
// scritture future devono restare byte-identici.
export const up = (pgm) => {
    pgm.sql(`
        CREATE FUNCTION pg_temp.rm_dotted_sigle(input text) RETURNS text AS $fn$
        DECLARE
            out_s text := coalesce(input, '');
            m text;
        BEGIN
            FOR m IN
                SELECT DISTINCT x[1]
                FROM regexp_matches(coalesce(input, ''), '(\\m(?:[[:alpha:]]\\.){2,})', 'g') AS x
            LOOP
                out_s := replace(out_s, m, upper(m));
            END LOOP;
            RETURN out_s;
        END
        $fn$ LANGUAGE plpgsql;
    `);

    pgm.sql(`UPDATE dishes SET name = pg_temp.rm_dotted_sigle(name)
             WHERE name IS NOT NULL AND name <> pg_temp.rm_dotted_sigle(name);`);
    pgm.sql(`UPDATE dishes SET category = pg_temp.rm_dotted_sigle(category)
             WHERE category IS NOT NULL AND category <> pg_temp.rm_dotted_sigle(category);`);
    pgm.sql(`UPDATE modifier_groups SET name = pg_temp.rm_dotted_sigle(name)
             WHERE name <> pg_temp.rm_dotted_sigle(name);`);
    pgm.sql(`UPDATE modifiers SET name = pg_temp.rm_dotted_sigle(name)
             WHERE name <> pg_temp.rm_dotted_sigle(name);`);
    pgm.sql(`UPDATE dish_components SET name = pg_temp.rm_dotted_sigle(name)
             WHERE name <> pg_temp.rm_dotted_sigle(name);`);
    pgm.sql(`
        DELETE FROM category_stations a
        USING category_stations b
        WHERE a.tenant_id = b.tenant_id
          AND pg_temp.rm_dotted_sigle(a.category) = pg_temp.rm_dotted_sigle(b.category)
          AND a.category > b.category;
    `);
    pgm.sql(`UPDATE category_stations SET category = pg_temp.rm_dotted_sigle(category)
             WHERE category <> pg_temp.rm_dotted_sigle(category);`);
    pgm.sql(`
        DO $do$
        DECLARE
            r RECORD;
            newval text;
        BEGIN
            FOR r IN SELECT tenant_id, key, text_value FROM app_settings
                     WHERE key IN ('menu_category_prefs', 'menu_category_translations')
            LOOP
                BEGIN
                    SELECT COALESCE(jsonb_object_agg(pg_temp.rm_dotted_sigle(e.key), e.value), '{}'::jsonb)::text
                      INTO newval
                      FROM jsonb_each(r.text_value::jsonb) AS e(key, value);
                    UPDATE app_settings SET text_value = newval, updated_at = CURRENT_TIMESTAMP
                     WHERE tenant_id = r.tenant_id AND key = r.key AND text_value IS DISTINCT FROM newval;
                EXCEPTION WHEN others THEN
                    NULL;
                END;
            END LOOP;
        END
        $do$;
    `);
};
