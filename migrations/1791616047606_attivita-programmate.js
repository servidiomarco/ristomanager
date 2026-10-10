/**
 * Attività programmate (services/scheduledTasks.ts).
 *
 * Le attività che nascevano da sole in Attività erano scritte nel codice:
 * «Ordinare merce» 72, 48 e 24 ore prima di ogni banchetto, alla Cucina, e il
 * «Promemoria pane» (1 kg ogni 10 coperti, al Titolare). Diventano righe di
 * scheduled_tasks, che il ristorante crea, cambia ed elimina da Impostazioni.
 *
 * - scheduled_tasks: una riga per attività programmata. kind BANQUET (giorni
 *   prima di ogni banchetto), RECURRING (giornaliera, settimanale, mensile) o
 *   ONE_OFF (una data). released_through è l'ultimo giorno stabilito già
 *   lavorato per i banchetti: lo scheduler riparte dal giorno dopo, così
 *   un'attività eliminata a mano non rinasce al giro successivo.
 * - todos.scheduled_task_id: da quale attività programmata è nato il todo.
 *   Le attività di prima si agganciano alle righe nuove, comprese quelle
 *   svolte: è quello che impedisce di ricrearle.
 * - Le tre righe dei banchetti nascono per ogni ristorante; il pane solo dove
 *   c'era il promemoria BREAD_DAILY, con il suo orario e il suo stato.
 * - La riga BREAD_DAILY di reminders resta, spenta e nascosta: createSchema
 *   la riseminerebbe a ogni boot se sparisse (guardia NOT EXISTS).
 * - todos.assigned_to_team accettava solo OWNER/MANAGER/WAITER/KITCHEN: un
 *   todo per Reception, General Manager o Cassa falliva. Si allarga a tutti i
 *   ruoli del ristorante.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

const RLS_POLICY = `
    (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::bigint)
    OR (
        (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
        AND (
            (current_setting('app.rls_strict', true) IS DISTINCT FROM 'on')
            OR (current_setting('app.rls_bypass', true) = 'on')
        )
    )
`;

const TEAMS = `('OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'KITCHEN', 'CASSA')`;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
            id               SERIAL PRIMARY KEY,
            tenant_id        BIGINT NOT NULL,
            title            VARCHAR(200) NOT NULL,
            description      TEXT,
            kind             VARCHAR(12) NOT NULL CHECK (kind IN ('BANQUET', 'RECURRING', 'ONE_OFF')),
            days_before      SMALLINT CHECK (days_before IS NULL OR days_before BETWEEN 0 AND 60),
            banquet_scope    VARCHAR(10) NOT NULL DEFAULT 'ALL' CHECK (banquet_scope IN ('ALL', 'CONFIRMED')),
            frequency        VARCHAR(10) CHECK (frequency IS NULL OR frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
            weekdays         TEXT[],
            month_day        SMALLINT CHECK (month_day IS NULL OR month_day BETWEEN 1 AND 28),
            schedule_date    DATE,
            schedule_time    VARCHAR(5) NOT NULL DEFAULT '09:00',
            due_in_days      SMALLINT NOT NULL DEFAULT 0 CHECK (due_in_days BETWEEN 0 AND 30),
            covers_per_unit  INTEGER CHECK (covers_per_unit IS NULL OR covers_per_unit BETWEEN 1 AND 1000),
            assigned_team    VARCHAR(20) NOT NULL CHECK (assigned_team IN ${TEAMS}),
            priority         VARCHAR(10) NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH')),
            category         VARCHAR(20) NOT NULL DEFAULT 'GENERAL'
                             CHECK (category IN ('GENERAL', 'RESERVATION', 'INVENTORY', 'STAFF', 'MAINTENANCE', 'EVENT')),
            active           BOOLEAN NOT NULL DEFAULT TRUE,
            released_through DATE,
            last_run_at      TIMESTAMPTZ,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (kind <> 'BANQUET' OR days_before IS NOT NULL),
            CHECK (kind <> 'RECURRING' OR frequency IS NOT NULL),
            CHECK (kind <> 'ONE_OFF' OR schedule_date IS NOT NULL)
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_tenant ON scheduled_tasks (tenant_id);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_active ON scheduled_tasks (active) WHERE active = TRUE;`);

    pgm.sql(`ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON scheduled_tasks;`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON scheduled_tasks
        USING (${RLS_POLICY})
        WITH CHECK (${RLS_POLICY});
    `);

    pgm.sql(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS scheduled_task_id INTEGER REFERENCES scheduled_tasks(id) ON DELETE SET NULL;`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_todos_scheduled_task ON todos (scheduled_task_id, due_date) WHERE scheduled_task_id IS NOT NULL;`);

    pgm.sql(`ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_assigned_to_team_check;`);
    pgm.sql(`ALTER TABLE todos ADD CONSTRAINT todos_assigned_to_team_check CHECK (assigned_to_team IS NULL OR assigned_to_team IN ${TEAMS});`);

    // «Ordinare merce» per i banchetti: le tre finestre di prima, con lo
    // stesso testo, la stessa squadra e la stessa priorità. Ora della
    // campanella: le 9, quando la cucina c'è.
    pgm.sql(`
        WITH finestre (giorni, ore, priorita) AS (
            VALUES (3, 72, 'LOW'), (2, 48, 'MEDIUM'), (1, 24, 'HIGH')
        ),
        seminate AS (
            INSERT INTO scheduled_tasks
                (tenant_id, title, description, kind, days_before, schedule_time, assigned_team, priority, category)
            SELECT t.id,
                   'Ordinare merce — banchetti del {data} (' || f.ore || 'h prima)',
                   'Ricorda di ordinare la merce necessaria per i banchetti programmati il {data}.',
                   'BANQUET', f.giorni, '09:00', 'KITCHEN', f.priorita, 'INVENTORY'
              FROM tenants t CROSS JOIN finestre f
            RETURNING id, tenant_id, days_before
        )
        UPDATE todos td
           SET scheduled_task_id = s.id
          FROM seminate s
         WHERE td.tenant_id = s.tenant_id
           AND td.banquet_reminder_hours = s.days_before * 24
           AND td.assigned_to_team = 'KITCHEN';
    `);

    // Il pane: dove c'era il promemoria, con il suo orario, i suoi giorni e il
    // suo stato (al Frantoio è spento dal 06/09/2026). Scadenza il giorno dopo.
    pgm.sql(`
        WITH pane AS (
            INSERT INTO scheduled_tasks
                (tenant_id, title, description, kind, frequency, weekdays, month_day, schedule_date,
                 schedule_time, due_in_days, covers_per_unit, assigned_team, priority, category, active, last_run_at)
            SELECT r.tenant_id,
                   'Ordinare {quantità} kg di pane per domani ({coperti} coperti)',
                   'Pane previsto per {data}: {quantità} kg (1 kg ogni 10 coperti, {coperti} coperti previsti).',
                   r.kind, r.frequency, r.weekdays, r.month_day, r.schedule_date,
                   r.schedule_time, 1, 10, 'OWNER', 'HIGH', 'INVENTORY', r.active, r.last_run_at
              FROM reminders r
             WHERE r.system_key = 'BREAD_DAILY'
            RETURNING id, tenant_id
        )
        UPDATE todos td
           SET scheduled_task_id = p.id
          FROM pane p
         WHERE td.tenant_id = p.tenant_id
           AND td.auto_kind = 'BREAD_DAILY';
    `);
    pgm.sql(`UPDATE reminders SET active = FALSE, updated_at = now() WHERE system_key = 'BREAD_DAILY';`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE todos DROP COLUMN IF EXISTS scheduled_task_id;`);
    pgm.sql(`DROP TABLE IF EXISTS scheduled_tasks;`);
};
