import { queryWithRetry } from '../db.js';
import { getTenantLocale, sqlTimeZone } from '../services/tenantLocale.js';

export enum ActivityAction {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  LOGIN = 'LOGIN',
  LOGOUT = 'LOGOUT'
}

export enum ResourceType {
  RESERVATION = 'RESERVATION',
  TABLE = 'TABLE',
  ROOM = 'ROOM',
  DISH = 'DISH',
  BANQUET_MENU = 'BANQUET_MENU',
  USER = 'USER',
  AUTH = 'AUTH',
  CUSTOMER = 'CUSTOMER',
  INVENTORY_LOCATION = 'INVENTORY_LOCATION',
  INVENTORY_CATEGORY = 'INVENTORY_CATEGORY',
  INVENTORY_PRODUCT = 'INVENTORY_PRODUCT',
  INVENTORY_MOVEMENT = 'INVENTORY_MOVEMENT',
  ORDER = 'ORDER',
  SETTINGS = 'SETTINGS',
  STAFF = 'STAFF'
}

export interface ActivityLog {
  id: number;
  user_id: number | null;
  user_email: string;
  user_name: string;
  action: ActivityAction;
  resource_type: ResourceType;
  resource_id?: number;
  resource_name?: string;
  details?: Record<string, any>;
  status: 'SUCCESS' | 'ERROR';
  error_message?: string;
  created_at: string;
}

export interface LogFilters {
  user_id?: number;
  resource_type?: ResourceType;
  resource_id?: number;
  action?: ActivityAction;
  from_date?: string;
  to_date?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Quello che serve per leggere un log senza aprire il database: nei details
 * ci sono id (tavoli, prenotazioni), non nomi. Si risolvono alla lettura, per
 * la pagina richiesta, così valgono anche per i log scritti prima di oggi.
 */
export interface LogRefs {
  /** id tavolo → nome attuale. */
  tables: Record<string, string>;
  /** id sala → nome (chiusure per turno). */
  rooms: Record<string, string>;
  /** id prenotazione → nome (per «scambiato con …»). */
  reservations: Record<string, string>;
  /** id log di unione/divisione → prenotazioni oggi sedute su quei tavoli
   *  in quel giorno e turno. */
  merge_reservations: Record<string, { id: number; name: string }[]>;
}

// Il nome mostrato è quello della scheda utente, non quello scritto nel log:
// quasi tutti i call site passano l'email anche come nome (req.user non porta
// il nome), e un registro di sole email non dice chi è stato. Scheda
// cancellata o di un altro tenant (accesso dal pannello): resta quello scritto.
const LOG_COLUMNS = `l.id, l.user_id, l.user_email,
       COALESCE(NULLIF(u.full_name, ''), l.user_name) AS user_name,
       l.action, l.resource_type, l.resource_id, l.resource_name, l.details,
       l.status, l.error_message, l.created_at`;
const LOG_FROM = `activity_logs l
       LEFT JOIN users u ON u.id = l.user_id AND u.tenant_id = l.tenant_id`;

// Unioni e divisioni non hanno un tipo loro: sono log TABLE chiamati
// «Merge <data> <turno>» / «Unmerge …», con data e turno nei details e il
// tavolo principale in resource_id.
const MERGE_LOG_SQL = `(l.resource_type = 'TABLE' AND l.resource_name ~ '^(Merge|Unmerge) ')`;
const MERGED_IDS_SQL = `(CASE WHEN jsonb_typeof(l.details->'merged_ids') = 'array'
       THEN l.details->'merged_ids' ELSE '[]'::jsonb END)`;

const isMergeLog = (log: Pick<ActivityLog, 'resource_type' | 'resource_name'>): boolean =>
  log.resource_type === ResourceType.TABLE && /^(Merge|Unmerge) /.test(log.resource_name ?? '');

const positiveInt = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Campi della prenotazione di cui il log tiene prima e dopo.
const RESERVATION_VALUE_FIELDS = [
  'reservation_time', 'shift', 'guests', 'children', 'table_id', 'reservation_status',
  'arrival_status', 'payment_status', 'duration_minutes', 'banquet_menu_id',
] as const;
// Questi invece dicono solo «cambiato»: l'oblio del cliente ripulisce
// resource_name, non i details, e un vecchio telefono scritto lì dentro
// sopravvivrebbe alla cancellazione.
const RESERVATION_PRIVATE_FIELDS = ['customer_name', 'phone', 'email', 'notes'] as const;

const normalizeField = (key: string, v: unknown): string | number | null => {
  if (v == null || v === '') return null;
  if (key === 'reservation_time') {
    const t = new Date(v as string | number | Date);
    return Number.isNaN(t.getTime()) ? String(v) : t.toISOString();
  }
  if (typeof v === 'number') return v;
  const str = String(v).trim();
  return /^-?\d+$/.test(str) ? Number(str) : str;
};

/**
 * Prima → dopo di una modifica alla prenotazione. `prev` è la fotografia
 * presa nella stessa UPDATE (CTE old), `next` la riga restituita. null se non
 * è cambiato niente o manca la fotografia.
 */
export function reservationChanges(
  prev: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): { changes?: Record<string, [string | number | null, string | number | null]>; changed_fields?: string[] } | null {
  if (!prev || !next) return null;
  const changes: Record<string, [string | number | null, string | number | null]> = {};
  for (const key of RESERVATION_VALUE_FIELDS) {
    const a = normalizeField(key, prev[key]);
    const b = normalizeField(key, next[key]);
    if (a !== b) changes[key] = [a, b];
  }
  const changed = RESERVATION_PRIVATE_FIELDS.filter(key =>
    normalizeField(key, prev[key]) !== normalizeField(key, next[key])
  );
  if (Object.keys(changes).length === 0 && changed.length === 0) return null;
  return {
    ...(Object.keys(changes).length > 0 ? { changes } : {}),
    ...(changed.length > 0 ? { changed_fields: changed } : {}),
  };
}

export interface ActivityStats {
  total_logs: number;
  logs_by_action: Record<string, number>;
  logs_by_resource: Record<string, number>;
  recent_users: { user_id: number; user_name: string; count: number }[];
}

export class LogService {
  /**
   * Log an activity to the database.
   * tenantId è il PRIMO parametro, obbligatorio (Fase B3.7): un call site
   * nuovo non può dimenticarlo, il compilatore lo rifiuta — stesso pattern
   * di pushService.sendToRoles. Senza, l'audit di un ristorante mostrerebbe
   * le azioni dello staff di tutti gli altri.
   */
  static async logActivity(
    tenantId: number,
    userId: number | null,
    userEmail: string,
    userName: string,
    action: ActivityAction,
    resourceType: ResourceType,
    resourceId?: number,
    resourceName?: string,
    details?: Record<string, any>,
    status: 'SUCCESS' | 'ERROR' = 'SUCCESS',
    errorMessage?: string
  ): Promise<ActivityLog | null> {
    try {
      const result = await queryWithRetry(
        `INSERT INTO activity_logs
         (tenant_id, user_id, user_email, user_name, action, resource_type, resource_id, resource_name, details, status, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          tenantId,
          userId,
          userEmail,
          userName,
          action,
          resourceType,
          resourceId || null,
          resourceName || null,
          details ? JSON.stringify(details) : null,
          status,
          errorMessage || null
        ]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Error logging activity:', error);
      return null;
    }
  }

  /**
   * Get activity logs with filters and pagination
   */
  static async getActivityLogs(tenantId: number, filters: LogFilters = {}): Promise<{ logs: ActivityLog[]; total: number; refs: LogRefs }> {
    const {
      user_id,
      resource_type,
      resource_id,
      action,
      from_date,
      to_date,
      search,
      limit = 50,
      offset = 0
    } = filters;

    // Il tenant è la prima condizione, sempre presente: i filtri opzionali
    // si sommano, non la sostituiscono.
    const conditions: string[] = ['l.tenant_id = $1'];
    const params: any[] = [tenantId];
    let paramIndex = 2;

    if (user_id) {
      conditions.push(`l.user_id = $${paramIndex++}`);
      params.push(user_id);
    }

    if (resource_type) {
      conditions.push(`l.resource_type = $${paramIndex++}`);
      params.push(resource_type);
    }

    if (resource_id) {
      conditions.push(`l.resource_id = $${paramIndex++}`);
      params.push(resource_id);
    }

    if (action) {
      conditions.push(`l.action = $${paramIndex++}`);
      params.push(action);
    }

    if (from_date) {
      conditions.push(`l.created_at >= $${paramIndex++}`);
      params.push(from_date);
    }

    if (to_date) {
      conditions.push(`l.created_at <= $${paramIndex++}`);
      params.push(to_date);
    }

    const trimmedSearch = search?.trim();
    let withClause = '';
    if (trimmedSearch) {
      // Un'unione di tavoli non porta il nome di nessuno (i details hanno
      // solo id, e così l'oblio non deve inseguirli): cercando «Orlando» la
      // si trova attraverso la prenotazione seduta su quei tavoli in quel
      // giorno e turno. Senza, la domanda «chi ha unito il tavolo di X» non
      // aveva risposta dal registro (indagine 11/10). Si parte dalle
      // prenotazioni col nome cercato, poche: il contrario (ogni unione
      // contro tutte le prenotazioni) costava 2 s sui dati del Frantoio.
      const tz = sqlTimeZone((await getTenantLocale(tenantId)).timezone);
      withClause = `WITH search_resv AS MATERIALIZED (
          SELECT table_id, shift, (reservation_time AT TIME ZONE ${tz})::date::text AS day
            FROM reservations
           WHERE tenant_id = $1 AND table_id IS NOT NULL AND customer_name ILIKE $${paramIndex}
        )`;
      conditions.push(
        `(l.resource_name ILIKE $${paramIndex} OR l.user_name ILIKE $${paramIndex} OR u.full_name ILIKE $${paramIndex}
          OR l.user_email ILIKE $${paramIndex} OR l.error_message ILIKE $${paramIndex} OR l.details::text ILIKE $${paramIndex}
          OR (${MERGE_LOG_SQL} AND EXISTS (
                SELECT 1 FROM search_resv r
                 WHERE r.shift = l.details->>'shift' AND r.day = l.details->>'date'
                   AND (r.table_id = l.resource_id
                        OR r.table_id IN (SELECT e.v::int FROM jsonb_array_elements_text(${MERGED_IDS_SQL}) AS e(v)
                                           WHERE e.v ~ '^[0-9]+$')))))`
      );
      params.push(`%${trimmedSearch}%`);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Get total count
    const countResult = await queryWithRetry(
      `${withClause} SELECT COUNT(*) FROM ${LOG_FROM} ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get paginated logs
    const logsResult = await queryWithRetry(
      `${withClause} SELECT ${LOG_COLUMNS} FROM ${LOG_FROM} ${whereClause}
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, limit, offset]
    );

    return {
      logs: logsResult.rows,
      total,
      refs: await LogService.buildRefs(tenantId, logsResult.rows)
    };
  }

  /**
   * La storia di una prenotazione: i suoi log, più le unioni e divisioni dei
   * tavoli su cui è stata in quel giorno e turno. Le unioni sono log TABLE
   * (data, turno, tavoli) senza legame con la prenotazione — e il form le
   * crea prima di salvare il tavolo nuovo — quindi si agganciano per tavolo:
   * quello attuale, quelli citati nei suoi log (spostamenti, proposta AI) e
   * quelli uniti oggi al suo. null se la prenotazione non esiste e non ha log.
   */
  static async getReservationHistory(tenantId: number, reservationId: number): Promise<{ logs: ActivityLog[]; refs: LogRefs } | null> {
    const tz = sqlTimeZone((await getTenantLocale(tenantId)).timezone);
    const resv = await queryWithRetry(
      `SELECT id, table_id, shift, (reservation_time AT TIME ZONE ${tz})::date::text AS day
         FROM reservations WHERE id = $1 AND tenant_id = $2`,
      [reservationId, tenantId]
    );
    const row = resv.rows[0] as { id: number; table_id: number | null; shift: string; day: string } | undefined;

    // swapped_with: lo scambio di tavoli scrive un solo log, sulla prima
    // delle due prenotazioni.
    const own = await queryWithRetry(
      `SELECT ${LOG_COLUMNS} FROM ${LOG_FROM}
        WHERE l.tenant_id = $1 AND l.resource_type = 'RESERVATION'
          AND (l.resource_id = $2 OR l.details->>'swapped_with' = $3)
        ORDER BY l.created_at ASC, l.id ASC
        LIMIT 500`,
      [tenantId, reservationId, String(reservationId)]
    );
    if (!row && own.rows.length === 0) return null;

    let related: ActivityLog[] = [];
    if (row) {
      const tableIds = new Set<number>();
      const add = (v: unknown) => { const n = positiveInt(v); if (n) tableIds.add(n); };
      add(row.table_id);
      for (const log of own.rows as ActivityLog[]) {
        const d: Record<string, any> = log.details && typeof log.details === 'object' ? log.details : {};
        add(d.table_id); add(d.prev_table_id); add(d.new_table_id);
        if (Array.isArray(d.merge_with_table_ids)) d.merge_with_table_ids.forEach(add);
      }
      if (row.table_id != null) {
        const merges = await queryWithRetry(
          `SELECT merged_ids FROM table_merges
            WHERE tenant_id = $1 AND date = $2 AND shift = $3 AND primary_id = $4`,
          [tenantId, row.day, row.shift, row.table_id]
        );
        for (const m of merges.rows) (m.merged_ids || []).forEach(add);
      }
      if (tableIds.size > 0) {
        const rel = await queryWithRetry(
          `SELECT ${LOG_COLUMNS} FROM ${LOG_FROM}
            WHERE l.tenant_id = $1 AND ${MERGE_LOG_SQL}
              AND l.details->>'date' = $2 AND l.details->>'shift' = $3
              AND (l.resource_id = ANY($4::int[])
                   OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(${MERGED_IDS_SQL}) AS e(v)
                               WHERE e.v ~ '^[0-9]+$' AND e.v::int = ANY($4::int[])))
            ORDER BY l.created_at ASC, l.id ASC
            LIMIT 200`,
          [tenantId, row.day, row.shift, [...tableIds]]
        );
        related = rel.rows;
      }
    }

    const logs = [...(own.rows as ActivityLog[]), ...related].sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id - b.id
    );
    return { logs, refs: await LogService.buildRefs(tenantId, logs) };
  }

  /**
   * Nomi per gli id citati in una pagina di log. Quattro query al massimo, solo
   * se servono: la pagina è di 20–50 righe.
   */
  static async buildRefs(tenantId: number, logs: ActivityLog[]): Promise<LogRefs> {
    const refs: LogRefs = { tables: {}, rooms: {}, reservations: {}, merge_reservations: {} };
    const tableIds = new Set<number>();
    const roomIds = new Set<number>();
    const reservationIds = new Set<number>();
    const merges: { logId: number; day: string; shift: string; tableIds: number[] }[] = [];
    const addTable = (v: unknown) => { const n = positiveInt(v); if (n) tableIds.add(n); };

    for (const log of logs) {
      const d: Record<string, any> = log.details && typeof log.details === 'object' ? log.details : {};
      if (log.resource_type === ResourceType.TABLE) addTable(log.resource_id);
      if (log.resource_type === ResourceType.ROOM) { const r = positiveInt(log.resource_id); if (r) roomIds.add(r); }
      addTable(d.table_id); addTable(d.prev_table_id); addTable(d.new_table_id);
      // Prima → dopo: dal CRM (changes) e da Sofia / link dell'ospite (before/after).
      if (Array.isArray(d.changes?.table_id)) d.changes.table_id.forEach(addTable);
      addTable(d.before?.table_id); addTable(d.after?.table_id);
      for (const key of ['merged_ids', 'merge_with_table_ids']) {
        if (Array.isArray(d[key])) d[key].forEach(addTable);
      }
      const swapped = positiveInt(d.swapped_with);
      if (swapped) reservationIds.add(swapped);
      if (isMergeLog(log) && typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date)
          && (d.shift === 'LUNCH' || d.shift === 'DINNER')) {
        const ids = [log.resource_id, ...(Array.isArray(d.merged_ids) ? d.merged_ids : [])]
          .map(positiveInt).filter((n): n is number => n != null);
        if (ids.length > 0) merges.push({ logId: log.id, day: d.date, shift: d.shift, tableIds: ids });
      }
    }

    if (tableIds.size > 0) {
      const res = await queryWithRetry(
        'SELECT id, name FROM tables WHERE tenant_id = $1 AND id = ANY($2::int[])',
        [tenantId, [...tableIds]]
      );
      for (const r of res.rows) refs.tables[String(r.id)] = r.name;
    }

    if (roomIds.size > 0) {
      const res = await queryWithRetry(
        'SELECT id, name FROM rooms WHERE tenant_id = $1 AND id = ANY($2::int[])',
        [tenantId, [...roomIds]]
      );
      for (const r of res.rows) refs.rooms[String(r.id)] = r.name;
    }

    if (reservationIds.size > 0) {
      const res = await queryWithRetry(
        'SELECT id, customer_name FROM reservations WHERE tenant_id = $1 AND id = ANY($2::int[])',
        [tenantId, [...reservationIds]]
      );
      for (const r of res.rows) refs.reservations[String(r.id)] = r.customer_name;
    }

    if (merges.length > 0) {
      // Una riga per (log, tavolo): unnest di array paralleli invece di un
      // round trip per unione.
      const logIds: number[] = [], days: string[] = [], shifts: string[] = [], tIds: number[] = [];
      for (const m of merges) {
        for (const t of m.tableIds) { logIds.push(m.logId); days.push(m.day); shifts.push(m.shift); tIds.push(t); }
      }
      const tz = sqlTimeZone((await getTenantLocale(tenantId)).timezone);
      const res = await queryWithRetry(
        `SELECT DISTINCT m.log_id, r.id, r.customer_name, r.reservation_time
           FROM unnest($2::int[], $3::date[], $4::text[], $5::int[]) AS m(log_id, day, shift, table_id)
           JOIN reservations r
             ON r.tenant_id = $1 AND r.table_id = m.table_id AND r.shift = m.shift
            AND (r.reservation_time AT TIME ZONE ${tz})::date = m.day
            AND COALESCE(r.reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED')
          ORDER BY r.reservation_time, r.id`,
        [tenantId, logIds, days, shifts, tIds]
      );
      for (const r of res.rows) {
        const key = String(r.log_id);
        (refs.merge_reservations[key] ??= []).push({ id: Number(r.id), name: r.customer_name });
      }
    }

    return refs;
  }

  /**
   * Get activity statistics
   */
  static async getActivityStats(tenantId: number): Promise<ActivityStats> {
    // Total logs
    const totalResult = await queryWithRetry('SELECT COUNT(*) FROM activity_logs WHERE tenant_id = $1', [tenantId]);
    const total_logs = parseInt(totalResult.rows[0].count, 10);

    // Logs by action
    const actionResult = await queryWithRetry(
      `SELECT action, COUNT(*) as count FROM activity_logs WHERE tenant_id = $1 GROUP BY action`,
      [tenantId]
    );
    const logs_by_action: Record<string, number> = {};
    for (const row of actionResult.rows) {
      logs_by_action[row.action] = parseInt(row.count, 10);
    }

    // Logs by resource type
    const resourceResult = await queryWithRetry(
      `SELECT resource_type, COUNT(*) as count FROM activity_logs WHERE tenant_id = $1 GROUP BY resource_type`,
      [tenantId]
    );
    const logs_by_resource: Record<string, number> = {};
    for (const row of resourceResult.rows) {
      logs_by_resource[row.resource_type] = parseInt(row.count, 10);
    }

    // Recent active users (top 5)
    const usersResult = await queryWithRetry(
      `SELECT user_id, user_name, COUNT(*) as count
       FROM activity_logs
       WHERE tenant_id = $1 AND user_id IS NOT NULL
       GROUP BY user_id, user_name
       ORDER BY count DESC
       LIMIT 5`,
      [tenantId]
    );
    const recent_users = usersResult.rows.map(row => ({
      user_id: row.user_id,
      user_name: row.user_name,
      count: parseInt(row.count, 10)
    }));

    return {
      total_logs,
      logs_by_action,
      logs_by_resource,
      recent_users
    };
  }

  /**
   * Get list of users who have activity logs (for filter dropdown)
   */
  static async getLogUsers(tenantId: number): Promise<{ id: number; name: string; email: string }[]> {
    // Una riga per utente, col nome della scheda: il DISTINCT su
    // (id, nome, email) dava un doppione per ogni nome scritto diverso.
    const result = await queryWithRetry(
      `SELECT l.user_id AS id,
              COALESCE(NULLIF(MAX(u.full_name), ''), MAX(l.user_name)) AS name,
              MAX(l.user_email) AS email
         FROM ${LOG_FROM}
        WHERE l.tenant_id = $1 AND l.user_id IS NOT NULL
        GROUP BY l.user_id
        ORDER BY 2`,
      [tenantId]
    );
    return result.rows;
  }
}
