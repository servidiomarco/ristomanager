// Seconda rifinitura del Title Case dei titoli menu, dal collaudo della
// Demo Pizzeria: le unità di misura dopo una quantità uscivano maiuscole
// («Coca-Cola 33 Cl», «Vino ½ L») e «IPA» diventava «Ipa» — le bibite non
// erano mai passate dalla regola prima di un menu da pizzeria.
//
// Replica MENU_UNIT_WORDS/MENU_QUANTITY_TOKEN e l'aggiunta Ipa→IPA di
// utils/text.ts (toMenuTitleCase): dati e scritture future devono restare
// byte-identici, o i confronti esatti (category = $1) divergono. Stessa
// lista di tabelle della rifinitura precedente (rifinitura-titoli-menu).
export const up = (pgm) => {
    pgm.sql(`
        CREATE FUNCTION pg_temp.rm_unita_minuscole(input text) RETURNS text AS $fn$
        DECLARE
            out_s text := coalesce(input, '');
            parts text[];
            idx int;
            units text[] := ARRAY['cl','l','ml','lt','g','kg'];
        BEGIN
            out_s := regexp_replace(out_s, '\\mIpa\\M', 'IPA', 'g');
            parts := string_to_array(out_s, ' ');
            IF coalesce(array_length(parts, 1), 0) >= 2 THEN
                FOR idx IN 2..array_length(parts, 1) LOOP
                    IF lower(parts[idx]) = ANY(units)
                       AND (parts[idx - 1] ~ '^[0-9.,]+$' OR parts[idx - 1] ~ '^[½¼¾]$') THEN
                        parts[idx] := lower(parts[idx]);
                    END IF;
                END LOOP;
                out_s := array_to_string(parts, ' ');
            END IF;
            RETURN out_s;
        END
        $fn$ LANGUAGE plpgsql;
    `);

    pgm.sql(`UPDATE dishes SET name = pg_temp.rm_unita_minuscole(name)
             WHERE name IS NOT NULL AND name <> pg_temp.rm_unita_minuscole(name);`);
    pgm.sql(`UPDATE dishes SET category = pg_temp.rm_unita_minuscole(category)
             WHERE category IS NOT NULL AND category <> pg_temp.rm_unita_minuscole(category);`);
    pgm.sql(`UPDATE modifier_groups SET name = pg_temp.rm_unita_minuscole(name)
             WHERE name <> pg_temp.rm_unita_minuscole(name);`);
    pgm.sql(`UPDATE modifiers SET name = pg_temp.rm_unita_minuscole(name)
             WHERE name <> pg_temp.rm_unita_minuscole(name);`);
    pgm.sql(`UPDATE dish_components SET name = pg_temp.rm_unita_minuscole(name)
             WHERE name <> pg_temp.rm_unita_minuscole(name);`);
    pgm.sql(`
        DELETE FROM category_stations a
        USING category_stations b
        WHERE a.tenant_id = b.tenant_id
          AND pg_temp.rm_unita_minuscole(a.category) = pg_temp.rm_unita_minuscole(b.category)
          AND a.category > b.category;
    `);
    pgm.sql(`UPDATE category_stations SET category = pg_temp.rm_unita_minuscole(category)
             WHERE category <> pg_temp.rm_unita_minuscole(category);`);
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
                    SELECT COALESCE(jsonb_object_agg(pg_temp.rm_unita_minuscole(e.key), e.value), '{}'::jsonb)::text
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
