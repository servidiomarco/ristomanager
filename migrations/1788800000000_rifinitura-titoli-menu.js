// Rifinitura della normalizzazione titoli (titoli-menu-title-case), dal
// collaudo in produzione e dal titolare:
//
// 1. Sigle PUNTATE. I punti non sono confini di parola per il Title Case,
//    quindi «salumi d.o.p.» era uscito «Salumi D.o.p.». Una sequenza di
//    almeno due coppie lettera-punto è una sigla e va tutta maiuscola
//    («D.O.P.», «S.P.A.»); il minimo di due coppie protegge le
//    abbreviazioni vere («Mel.», «Pat.»).
// 2. Title Case all'italiana: preposizioni, articoli e congiunzioni
//    minuscoli quando non aprono il titolo — «Filetto ai Porcini», non
//    «Filetto Ai Porcini»; comprese le forme elise («all'Aglio»).
//
// Replica DOTTED_ACRONYMS + MENU_MINOR_WORDS/MENU_ELISION_PREFIXES di
// utils/text.ts (toMenuTitleCase): dati e scritture future devono restare
// byte-identici, o i confronti esatti (category = $1) divergono.
export const up = (pgm) => {
    pgm.sql(`
        CREATE FUNCTION pg_temp.rm_rifinisci_titolo(input text) RETURNS text AS $fn$
        DECLARE
            out_s text := coalesce(input, '');
            m text;
            parts text[];
            w text;
            em text[];
            idx int;
            minor text[] := ARRAY[
                'di','a','da','in','con','su','per','tra','fra','senza',
                'e','ed','o','od',
                'il','lo','la','i','gli','le','un','uno','una',
                'del','dello','della','dei','degli','delle',
                'al','allo','alla','ai','agli','alle',
                'dal','dallo','dalla','dai','dagli','dalle',
                'nel','nello','nella','nei','negli','nelle',
                'sul','sullo','sulla','sui','sugli','sulle',
                'col','coi'];
            elis text[] := ARRAY['d','l','un','all','dell','dall','nell','sull','coll'];
        BEGIN
            -- Sigle puntate: da parola intera, tutta maiuscola.
            FOR m IN
                SELECT DISTINCT x[1]
                FROM regexp_matches(out_s, '(\\m(?:[[:alpha:]]\\.){2,})', 'g') AS x
            LOOP
                out_s := replace(out_s, m, upper(m));
            END LOOP;
            -- Minuscole mai sulla prima parola (idx parte da 2).
            parts := string_to_array(out_s, ' ');
            IF coalesce(array_length(parts, 1), 0) >= 2 THEN
                FOR idx IN 2..array_length(parts, 1) LOOP
                    w := parts[idx];
                    IF lower(w) = ANY(minor) THEN
                        parts[idx] := lower(w);
                    ELSE
                        em := regexp_match(w, '^([[:alpha:]]+)([''’])(.*)$');
                        IF em IS NOT NULL AND lower(em[1]) = ANY(elis) THEN
                            parts[idx] := lower(em[1]) || em[2] || em[3];
                        END IF;
                    END IF;
                END LOOP;
                out_s := array_to_string(parts, ' ');
            END IF;
            RETURN out_s;
        END
        $fn$ LANGUAGE plpgsql;
    `);

    pgm.sql(`UPDATE dishes SET name = pg_temp.rm_rifinisci_titolo(name)
             WHERE name IS NOT NULL AND name <> pg_temp.rm_rifinisci_titolo(name);`);
    pgm.sql(`UPDATE dishes SET category = pg_temp.rm_rifinisci_titolo(category)
             WHERE category IS NOT NULL AND category <> pg_temp.rm_rifinisci_titolo(category);`);
    pgm.sql(`UPDATE modifier_groups SET name = pg_temp.rm_rifinisci_titolo(name)
             WHERE name <> pg_temp.rm_rifinisci_titolo(name);`);
    pgm.sql(`UPDATE modifiers SET name = pg_temp.rm_rifinisci_titolo(name)
             WHERE name <> pg_temp.rm_rifinisci_titolo(name);`);
    pgm.sql(`UPDATE dish_components SET name = pg_temp.rm_rifinisci_titolo(name)
             WHERE name <> pg_temp.rm_rifinisci_titolo(name);`);
    pgm.sql(`
        DELETE FROM category_stations a
        USING category_stations b
        WHERE a.tenant_id = b.tenant_id
          AND pg_temp.rm_rifinisci_titolo(a.category) = pg_temp.rm_rifinisci_titolo(b.category)
          AND a.category > b.category;
    `);
    pgm.sql(`UPDATE category_stations SET category = pg_temp.rm_rifinisci_titolo(category)
             WHERE category <> pg_temp.rm_rifinisci_titolo(category);`);
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
                    SELECT COALESCE(jsonb_object_agg(pg_temp.rm_rifinisci_titolo(e.key), e.value), '{}'::jsonb)::text
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
