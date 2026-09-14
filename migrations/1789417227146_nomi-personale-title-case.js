// Normalizza i nomi del personale in Title Case, per tutti i tenant: nome,
// cognome e ruolo di staff_members. L'anagrafica veniva salvata com'era
// digitata («luca marino»), e le superfici che la mostrano cruda — Compensi
// in testa — la stampavano minuscola; StaffManagement la titolava solo a
// schermo, quindi il dato restava sporco. Da qui in poi la stessa forma la
// impone il server a ogni scrittura (toTitleCase su POST/PUT /staff).
//
// pg_temp.rm_person_title_case replica utils/text.ts toTitleCase (tutto
// minuscolo, poi maiuscola dopo inizio/spazio/apostrofo/trattino): dati
// migrati e scritture future devono produrre byte identici. È la versione
// SENZA sigle né minuscole di cortesia del menu: su un nome di persona
// «De Rosa», «D'Angelo» e «Anna-Maria» si titolano tutti, e una sigla non
// esiste. Stesso loop della migration titoli-menu-title-case.
//
// @type {import('node-pg-migrate').ColumnDefinitions | undefined}
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE FUNCTION pg_temp.rm_person_title_case(input text) RETURNS text AS $fn$
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
            RETURN out_s;
        END
        $fn$ LANGUAGE plpgsql;
    `);

    pgm.sql(`
        UPDATE staff_members
           SET name    = pg_temp.rm_person_title_case(name),
               surname = pg_temp.rm_person_title_case(surname),
               role    = CASE WHEN role IS NULL THEN NULL
                              ELSE pg_temp.rm_person_title_case(role) END,
               updated_at = CURRENT_TIMESTAMP
         WHERE name    IS DISTINCT FROM pg_temp.rm_person_title_case(name)
            OR surname IS DISTINCT FROM pg_temp.rm_person_title_case(surname)
            OR role    IS DISTINCT FROM pg_temp.rm_person_title_case(role);
    `);
};

export const down = () => {
    // La forma originale (com'era stata digitata) non è ricostruibile.
};
