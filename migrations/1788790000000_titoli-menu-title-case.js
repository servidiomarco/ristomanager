// Normalizza i titoli del menu in Title Case, per tutti i tenant: nomi e
// categorie dei piatti (in gran parte URLATI dall'import Passepartout, contro
// la regola "mai maiuscolo" del design system), gruppi varianti, varianti,
// ingredienti dei piatti composti, mappa categoria→stazione e i due blob in
// app_settings chiavati per nome categoria (prefs e traduzioni) — se le
// chiavi non seguissero i piatti, menu di categoria e stazioni smetterebbero
// di agganciarsi. Da qui in poi la stessa forma la impone il server a ogni
// scrittura (toTitleCase sui punti di write), sync cassa compreso.
//
// pg_temp.rm_title_case replica utils/text.ts toMenuTitleCase (tutto
// minuscolo, poi maiuscola dopo inizio/spazio/apostrofo/trattino, e le
// denominazioni tornano sigle: «Barolo DOCG», «Mozzarella di Bufala» DOP —
// stessa lista chiusa di MENU_ACRONYMS): dati migrati e scritture future
// devono produrre byte identici, o i confronti esatti (category = $1)
// tornano a mancare.
export const up = (pgm) => {
    pgm.sql(`
        CREATE FUNCTION pg_temp.rm_title_case(input text) RETURNS text AS $fn$
        DECLARE
            src text := lower(coalesce(input, ''));
            out_s text := '';
            ch text;
            boundary boolean := true;
        BEGIN
            FOR i IN 1..length(src) LOOP
                ch := substr(src, i, 1);
                IF boundary THEN
                    out_s := out_s || upper(ch);
                ELSE
                    out_s := out_s || ch;
                END IF;
                boundary := ch = ' ' OR ch = '''' OR ch = '’' OR ch = '-' OR ch = E'\\t';
            END LOOP;
            -- Denominazioni: da parola intera (\\m…\\M) tornano maiuscole.
            -- «Docg» non viene toccato da \\mDoc\\M (la g è word char),
            -- quindi l'ordine non conta.
            out_s := regexp_replace(out_s, '\\mDoc\\M',  'DOC',  'g');
            out_s := regexp_replace(out_s, '\\mDocg\\M', 'DOCG', 'g');
            out_s := regexp_replace(out_s, '\\mIgt\\M',  'IGT',  'g');
            out_s := regexp_replace(out_s, '\\mIgp\\M',  'IGP',  'g');
            out_s := regexp_replace(out_s, '\\mDop\\M',  'DOP',  'g');
            out_s := regexp_replace(out_s, '\\mStg\\M',  'STG',  'g');
            out_s := regexp_replace(out_s, '\\mAoc\\M',  'AOC',  'g');
            out_s := regexp_replace(out_s, '\\mAop\\M',  'AOP',  'g');
            RETURN out_s;
        END
        $fn$ LANGUAGE plpgsql;
    `);

    pgm.sql(`UPDATE dishes SET name = pg_temp.rm_title_case(name)
             WHERE name IS NOT NULL AND name <> pg_temp.rm_title_case(name);`);
    pgm.sql(`UPDATE dishes SET category = pg_temp.rm_title_case(category)
             WHERE category IS NOT NULL AND category <> pg_temp.rm_title_case(category);`);
    pgm.sql(`UPDATE modifier_groups SET name = pg_temp.rm_title_case(name)
             WHERE name <> pg_temp.rm_title_case(name);`);
    pgm.sql(`UPDATE modifiers SET name = pg_temp.rm_title_case(name)
             WHERE name <> pg_temp.rm_title_case(name);`);
    pgm.sql(`UPDATE dish_components SET name = pg_temp.rm_title_case(name)
             WHERE name <> pg_temp.rm_title_case(name);`);

    // category_stations ha PK (tenant_id, category): due righe che collassano
    // sullo stesso Title Case ("ANTIPASTI" e "Antipasti") erano già ambigue
    // per il matching LOWER() delle query — sopravvive la prima in alfabetico.
    pgm.sql(`
        DELETE FROM category_stations a
        USING category_stations b
        WHERE a.tenant_id = b.tenant_id
          AND pg_temp.rm_title_case(a.category) = pg_temp.rm_title_case(b.category)
          AND a.category > b.category;
    `);
    pgm.sql(`UPDATE category_stations SET category = pg_temp.rm_title_case(category)
             WHERE category <> pg_temp.rm_title_case(category);`);

    // Blob chiavati per nome categoria. Ciclo con EXCEPTION per riga: un
    // text_value corrotto non deve far fallire il boot. Su chiavi che
    // collassano vince l'ultima (erano duplicati anche prima).
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
                    SELECT COALESCE(jsonb_object_agg(pg_temp.rm_title_case(e.key), e.value), '{}'::jsonb)::text
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
