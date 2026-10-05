// ============================================
// HACCP — rotte del registro (docs/haccp-piano.md)
// ============================================
// Vive fuori da server.ts perché è un dominio intero con le sue regole —
// punti di controllo del locale, correzioni con storico, non conformità — e
// non tocca nessun altro stato dell'app. Da server.ts riceve solo le poche
// cose che lì stanno di casa: push, chiusura delle notifiche condivise, il
// giorno del ristorante, il calendario di apertura e il socket (HaccpDeps).
//
// Tre regole attraversano tutte le rotte:
//
// 1. Una registrazione non si cancella e non si sovrascrive in silenzio. La
//    riga vive porta il valore corrente; ogni creazione, modifica e
//    annullamento lascia una riga in haccp_changes con prima/dopo, chi e
//    perché. «Elimina» è un annullamento: la riga resta, annullata, nel report.
// 2. Chi corregge la propria registrazione entro 15 minuti non deve
//    motivarlo (è il refuso mentre si compila: il modulo salva a ogni uscita
//    dal campo). Dopo, o sulla riga di un altro, serve il motivo: 409 con
//    code 'reason_required', e il client lo chiede.
// 3. Ogni scostamento apre una non conformità che si chiude solo scrivendo
//    l'azione correttiva (5° principio HACCP). Una sola aperta per
//    registrazione d'origine (indice haccp_nc_one_open_per_source).
//
// Le rotte storiche (/temperatures, /oil, /cleaning, /receipts,
// /production) restano con la stessa forma: un client della versione
// precedente — una PWA non ancora ricaricata — continua a funzionare, con le
// regole nuove (postazione per nome, annullamento al posto della DELETE).

import express from 'express';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { queryWithRetry, withTenant } from '../db.js';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';
import { RolePermissionService } from '../auth/permissionService.js';
import { isPlatformScopedSession } from '../auth/authService.js';
import {
    HACCP_CORRECTION_GRACE_MINUTES,
    HACCP_FREQUENCIES,
    HACCP_POINT_REGISTERS,
    HaccpFrequency,
    HaccpRegister,
    formatHaccpTemperature,
    haccpMissingTag,
    haccpTemperatureTag,
    isOutOfRange,
} from '../utils/haccp.js';

export interface HaccpPush {
    category: 'system';
    title: string;
    body: string;
    url: string;
    tag: string;
}

export interface HaccpDeps {
    pushToRoles: (tenantId: number, roles: string[], push: HaccpPush, options?: { excludeUserId?: number | null }) => Promise<unknown>;
    markNotificationsRead: (tenantId: number, tags: string[]) => Promise<void>;
    /** Il giorno di oggi nel fuso del ristorante (YYYY-MM-DD). */
    todayIso: (tenantId: number) => Promise<string>;
    /** Il ristorante lavora quel giorno (almeno un servizio aperto). */
    isServiceDay: (tenantId: number, date: string) => Promise<boolean>;
    broadcast: (tenantId: number, event: string, data: unknown, excludeSocketId?: string) => void;
}

/** Chi riceve gli avvisi HACCP quando non passano da un promemoria
 *  configurabile: chi risponde del registro e chi sta in cucina. */
export const HACCP_ALERT_ROLES = ['OWNER', 'GENERAL_MANAGER', 'MANAGER', 'KITCHEN'];

const HACCP_OIL_ACTIONS = ['SOSTITUITO', 'FILTRATO', 'UTILIZZABILE'] as const;
type HaccpOilAction = (typeof HACCP_OIL_ACTIONS)[number];

// ---- Errori e piccoli parser ---------------------------------------------------

class HaccpError extends Error {
    constructor(public status: number, public body: Record<string, unknown>) {
        super(String(body.error));
    }
}

const reasonRequired = (): HaccpError => new HaccpError(409, {
    error: 'Serve il motivo della correzione',
    code: 'reason_required',
});

const fail = (res: Response, err: unknown, where: string) => {
    if (err instanceof HaccpError) return res.status(err.status).json(err.body);
    console.error(`[haccp] ${where}:`, err);
    return res.status(500).json({ error: 'Internal server error' });
};

const isValidDate = (s: unknown): s is string =>
    typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

const parseNumericOrNull = (v: unknown): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
};

const cleanText = (v: unknown, max = 2000): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s ? s.slice(0, max) : null;
};

const parseId = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const isUuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ---- Chi scrive -----------------------------------------------------------------

interface Actor {
    userId: number | null;
    name: string | null;
}

// Il nome completo, non l'email: sul foglio che legge l'ispettore «Marco
// Rossi» dice chi ha controllato la cella, «m.rossi82» no. Cache breve per
// non rileggere users a ogni campo salvato.
const actorNames = new Map<number, { name: string; at: number }>();
const ACTOR_NAME_TTL_MS = 10 * 60 * 1000;

async function actorOf(req: Request): Promise<Actor> {
    const userId = req.user?.userId ?? null;
    const email = req.user?.email ?? null;
    if (!userId) return { userId: null, name: email };
    const cached = actorNames.get(userId);
    if (cached && Date.now() - cached.at < ACTOR_NAME_TTL_MS) return { userId, name: cached.name };
    let name = email || `utente ${userId}`;
    try {
        const r = await queryWithRetry('SELECT full_name FROM users WHERE id = $1', [userId]);
        const full = typeof r.rows[0]?.full_name === 'string' ? r.rows[0].full_name.trim() : '';
        if (full) name = full;
    } catch {
        // Nome non leggibile (utente di piattaforma sotto RLS): resta l'email.
    }
    actorNames.set(userId, { name, at: Date.now() });
    return { userId, name };
}

async function canManage(req: Request): Promise<boolean> {
    if (!req.user) return false;
    if (isPlatformScopedSession(req.user)) return true;
    return RolePermissionService.hasPermission(req.user.tenantId, req.user.role, 'haccp:manage');
}

// ---- Correzioni -----------------------------------------------------------------

interface AuditedRow {
    recordedByUserId?: number | null;
    recordedAt?: string | Date | null;
    updatedByUserId?: number | null;
    updatedAt?: string | Date | null;
}

/** Libera senza motivo solo la correzione di chi ha scritto per ultimo la
 *  riga, entro la tolleranza. */
const withinGrace = (row: AuditedRow, actor: Actor): boolean => {
    const lastBy = row.updatedByUserId ?? row.recordedByUserId ?? null;
    const lastAt = row.updatedAt ?? row.recordedAt ?? null;
    if (!actor.userId || lastBy !== actor.userId || !lastAt) return false;
    const elapsedMs = Date.now() - new Date(lastAt).getTime();
    return elapsedMs >= 0 && elapsedMs <= HACCP_CORRECTION_GRACE_MINUTES * 60 * 1000;
};

const assertCorrectable = (row: AuditedRow, actor: Actor, reason: string | null): void => {
    if (!reason && !withinGrace(row, actor)) throw reasonRequired();
};

type ChangeAction = 'CREATE' | 'UPDATE' | 'VOID';

async function logChange(
    client: PoolClient,
    tenantId: number,
    change: {
        entity: string;
        entityId: string | number;
        action: ChangeAction;
        recordDate: string | null;
        before?: unknown;
        after?: unknown;
        reason?: string | null;
        actor: Actor;
    },
): Promise<void> {
    await client.query(
        `INSERT INTO haccp_changes (tenant_id, entity, entity_id, action, record_date, before, after, reason, user_id, user_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
            tenantId, change.entity, String(change.entityId), change.action, change.recordDate,
            change.before === undefined ? null : JSON.stringify(stripAudit(change.before)),
            change.after === undefined ? null : JSON.stringify(stripAudit(change.after)),
            change.reason ?? null, change.actor.userId, change.actor.name,
        ],
    );
}

// Nello storico serve il dato, non la firma: chi e quando stanno già sulla
// riga di haccp_changes, ripeterli nel JSON lo renderebbe illeggibile.
const AUDIT_KEYS = new Set([
    'recordedByUserId', 'recordedByUserName', 'recordedAt', 'updatedAt', 'updatedByUserId',
    'updatedByUserName', 'voidedAt', 'voidedByUserName', 'voidReason',
]);
const stripAudit = (row: unknown): unknown => {
    if (!row || typeof row !== 'object') return row;
    return Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([k]) => !AUDIT_KEYS.has(k)));
};

// ---- Colonne in uscita --------------------------------------------------------------

const AUDIT_COLUMNS = `
    recorded_by_user_id AS "recordedByUserId",
    recorded_by_user_name AS "recordedByUserName",
    recorded_at AS "recordedAt",
    updated_at AS "updatedAt",
    updated_by_user_id AS "updatedByUserId",
    updated_by_user_name AS "updatedByUserName",
    voided_at AS "voidedAt",
    voided_by_user_name AS "voidedByUserName",
    void_reason AS "voidReason"`;

const TEMP_COLUMNS = `
    id, TO_CHAR(date, 'YYYY-MM-DD') AS date, point_id AS "pointId", location, slot,
    temperature::float8 AS temperature, target_min::float8 AS "targetMin", target_max::float8 AS "targetMax",
    note, ${AUDIT_COLUMNS}`;

const OIL_COLUMNS = `
    id, TO_CHAR(date, 'YYYY-MM-DD') AS date, point_id AS "pointId", fryer_label AS "fryerLabel",
    action, note, ${AUDIT_COLUMNS}`;

const CLEANING_COLUMNS = `
    id, TO_CHAR(date, 'YYYY-MM-DD') AS date, point_id AS "pointId", point, done, note, ${AUDIT_COLUMNS}`;

const RECEIPT_COLUMNS = `
    id, TO_CHAR(date, 'YYYY-MM-DD') AS date, product, lot_number AS "lotNumber",
    temperature::float8 AS temperature, accepted, note, ${AUDIT_COLUMNS}`;

const PRODUCTION_COLUMNS = `
    id, TO_CHAR(date, 'YYYY-MM-DD') AS date, product, blast_temp_range AS "blastTempRange",
    blast_duration AS "blastDuration", internal_lot AS "internalLot", note, ${AUDIT_COLUMNS}`;

const POINT_COLUMNS = `
    id, register, label, min_temp::float8 AS "minTemp", max_temp::float8 AS "maxTemp",
    checks_per_day AS "checksPerDay", frequency, instructions, sort_order AS "sortOrder", active`;

const NC_COLUMNS = `
    id, TO_CHAR(date, 'YYYY-MM-DD') AS date, source, source_id AS "sourceId", point_id AS "pointId",
    title, detail, status, corrective_action AS "correctiveAction",
    opened_by_user_name AS "openedByUserName", opened_at AS "openedAt",
    closed_by_user_name AS "closedByUserName", closed_at AS "closedAt",
    void_reason AS "voidReason", updated_at AS "updatedAt"`;

const CHANGE_COLUMNS = `
    id, entity, entity_id AS "entityId", action, TO_CHAR(record_date, 'YYYY-MM-DD') AS "recordDate",
    before, after, reason, user_name AS "userName", created_at AS "createdAt"`;

// ---- Punti di controllo ----------------------------------------------------------------

interface PointRow {
    id: number;
    register: HaccpRegister;
    label: string;
    minTemp: number | null;
    maxTemp: number | null;
    checksPerDay: number;
    frequency: HaccpFrequency;
    instructions: string | null;
    sortOrder: number;
    active: boolean;
}

/** Il punto di una registrazione: per id (client nuovo) o per nome (client
 *  della versione precedente, che conosce solo le etichette). Un punto
 *  archiviato non si compila più. */
async function resolvePoint(
    client: PoolClient,
    tenantId: number,
    register: HaccpRegister,
    pointId: unknown,
    label: unknown,
): Promise<PointRow> {
    const id = parseId(pointId);
    let r;
    if (id) {
        r = await client.query(
            `SELECT ${POINT_COLUMNS} FROM haccp_points WHERE tenant_id = $1 AND register = $2 AND id = $3`,
            [tenantId, register, id],
        );
    } else if (typeof label === 'string' && label.trim()) {
        r = await client.query(
            `SELECT ${POINT_COLUMNS} FROM haccp_points
              WHERE tenant_id = $1 AND register = $2 AND active AND lower(label) = lower($3)`,
            [tenantId, register, label.trim()],
        );
    }
    const point = r?.rows[0] as PointRow | undefined;
    if (!point) throw new HaccpError(400, { error: 'Punto di controllo sconosciuto', code: 'unknown_point' });
    if (!point.active) throw new HaccpError(400, { error: 'Punto di controllo archiviato', code: 'archived_point' });
    return point;
}

// ---- Non conformità ------------------------------------------------------------------

type NcSource = 'TEMPERATURE' | 'OIL' | 'CLEANING' | 'RECEIPT' | 'PROCESS' | 'MANUAL';

/** Tiene allineata la non conformità di una registrazione: aperta finché il
 *  valore è fuori, annullata se la registrazione torna in regola o viene
 *  annullata prima che qualcuno abbia scritto l'azione correttiva. Una non
 *  conformità già chiusa non si tocca e non se ne apre un'altra: l'azione è
 *  stata fatta per quello scostamento, e correggere di nuovo la lettura (8 °C
 *  diventa 8,5 °C) non è un fatto nuovo da rimediare.
 *
 *  `closedWith`: lo scostamento nasce già rimediato (il termometro fuori
 *  taratura e già sostituito) — la non conformità si registra chiusa, con
 *  quell'azione. */
async function syncSourceNc(
    client: PoolClient,
    tenantId: number,
    nc: {
        source: NcSource;
        sourceId: string;
        date: string;
        pointId: number | null;
        open: boolean;
        title: string;
        detail: string | null;
        actor: Actor;
        closingReason: string;
        closedWith?: string | null;
    },
): Promise<void> {
    const existing = await client.query(
        `SELECT ${NC_COLUMNS} FROM haccp_nonconformities
          WHERE tenant_id = $1 AND source = $2 AND source_id = $3 AND status IN ('OPEN', 'CLOSED')
          ORDER BY (status = 'OPEN') DESC, opened_at DESC
          LIMIT 1
          FOR UPDATE`,
        [tenantId, nc.source, nc.sourceId],
    );
    const found = existing.rows[0];
    if (found?.status === 'CLOSED') return;
    const current = found;
    if (nc.open) {
        if (current && nc.closedWith) {
            const upd = await client.query(
                `UPDATE haccp_nonconformities
                    SET title = $1, detail = $2, status = 'CLOSED', corrective_action = $3, closed_at = now(),
                        closed_by_user_id = $4, closed_by_user_name = $5, updated_at = now()
                  WHERE id = $6 RETURNING ${NC_COLUMNS}`,
                [nc.title, nc.detail, nc.closedWith, nc.actor.userId, nc.actor.name, current.id],
            );
            await logChange(client, tenantId, {
                entity: 'nonconformity', entityId: current.id, action: 'UPDATE', recordDate: nc.date,
                before: current, after: upd.rows[0], actor: nc.actor,
            });
            return;
        }
        if (current) {
            if (current.title === nc.title && (current.detail ?? null) === nc.detail) return;
            const upd = await client.query(
                `UPDATE haccp_nonconformities SET title = $1, detail = $2, updated_at = now()
                  WHERE id = $3 RETURNING ${NC_COLUMNS}`,
                [nc.title, nc.detail, current.id],
            );
            await logChange(client, tenantId, {
                entity: 'nonconformity', entityId: current.id, action: 'UPDATE', recordDate: nc.date,
                before: current, after: upd.rows[0], actor: nc.actor,
            });
            return;
        }
        const closed = !!nc.closedWith;
        const ins = await client.query(
            `INSERT INTO haccp_nonconformities
                (tenant_id, date, source, source_id, point_id, title, detail, opened_by_user_id, opened_by_user_name,
                 status, corrective_action, closed_at, closed_by_user_id, closed_by_user_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             RETURNING ${NC_COLUMNS}`,
            [
                tenantId, nc.date, nc.source, nc.sourceId, nc.pointId, nc.title, nc.detail, nc.actor.userId, nc.actor.name,
                closed ? 'CLOSED' : 'OPEN', closed ? nc.closedWith : null, closed ? new Date() : null,
                closed ? nc.actor.userId : null, closed ? nc.actor.name : null,
            ],
        );
        await logChange(client, tenantId, {
            entity: 'nonconformity', entityId: ins.rows[0].id, action: 'CREATE', recordDate: nc.date,
            after: ins.rows[0], actor: nc.actor,
        });
        return;
    }
    if (!current) return;
    const upd = await client.query(
        `UPDATE haccp_nonconformities
            SET status = 'VOID', void_reason = $1, closed_at = now(),
                closed_by_user_id = $2, closed_by_user_name = $3, updated_at = now()
          WHERE id = $4 RETURNING ${NC_COLUMNS}`,
        [nc.closingReason, nc.actor.userId, nc.actor.name, current.id],
    );
    await logChange(client, tenantId, {
        entity: 'nonconformity', entityId: current.id, action: 'VOID', recordDate: nc.date,
        before: current, after: upd.rows[0], reason: nc.closingReason, actor: nc.actor,
    });
}

const limitText = (min: number | null, max: number | null): string => {
    const hasMin = typeof min === 'number';
    const hasMax = typeof max === 'number';
    if (hasMin && hasMax) return `limiti ${formatHaccpTemperature(min as number).replace(' °C', '')} / ${formatHaccpTemperature(max as number)}`;
    if (hasMax) return `limite ${formatHaccpTemperature(max as number)}`;
    if (hasMin) return `minimo ${formatHaccpTemperature(min as number)}`;
    return '';
};

const temperatureTitle = (label: string, slot: number, checksPerDay: number, temperature: number, min: number | null, max: number | null): string =>
    `${label}${checksPerDay > 1 ? ` (${slot}ª)` : ''} · ${formatHaccpTemperature(temperature)} (${limitText(min, max)})`;

// ---- Il router -------------------------------------------------------------------------------

export function createHaccpRouter(deps: HaccpDeps): express.Router {
    const router = express.Router();
    const view = [authenticate, requirePermission('haccp:view')];
    const record = [authenticate, requirePermission('haccp:record')];
    const manage = [authenticate, requirePermission('haccp:manage')];

    const socketIdOf = (req: Request): string | undefined => {
        const v = req.headers['x-socket-id'];
        return typeof v === 'string' && v ? v : undefined;
    };
    const changed = (req: Request, date: string | null, register: string) => {
        try {
            deps.broadcast(req.tenantId!, 'haccp:changed', { date, register }, socketIdOf(req));
        } catch (err) {
            console.warn('[haccp] broadcast fallito:', (err as Error)?.message || err);
        }
    };

    /** Un giorno di registro valido e non nel futuro. Il passato si compila
     *  (il foglio dimenticato ieri), e la riga lo dice: recorded_at è del
     *  giorno in cui è stata scritta, e modulo e report lo mostrano. */
    const registerDate = async (tenantId: number, v: unknown): Promise<string> => {
        if (!isValidDate(v)) throw new HaccpError(400, { error: 'date (YYYY-MM-DD) is required' });
        const today = await deps.todayIso(tenantId);
        if (v > today) throw new HaccpError(400, { error: 'Non si registra un giorno che deve ancora venire', code: 'future_date' });
        return v;
    };

    /** Il ritento sulla gara fra due telefoni che salvano la stessa
     *  postazione nello stesso istante: il secondo INSERT urta l'indice
     *  unico, e al giro dopo trova la riga e la aggiorna. */
    const withConflictRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
            return await fn();
        } catch (err: any) {
            if (err?.code === '23505') return fn();
            throw err;
        }
    };

    // =====================================================================
    // Punti di controllo
    // =====================================================================

    router.get('/points', ...view, async (req, res) => {
        try {
            const all = req.query.all === '1';
            const r = await queryWithRetry(
                `SELECT ${POINT_COLUMNS} FROM haccp_points
                  WHERE tenant_id = $1 ${all ? '' : 'AND active'}
                  ORDER BY register, sort_order, id`,
                [req.tenantId!],
            );
            res.json({ points: r.rows, canManage: await canManage(req) });
        } catch (err) {
            fail(res, err, 'GET /points');
        }
    });

    const readPointInput = (body: any, register: HaccpRegister, current?: PointRow) => {
        const label = body.label !== undefined ? cleanText(body.label, 100) : current?.label ?? null;
        if (!label) throw new HaccpError(400, { error: 'Serve il nome del punto' });
        const minTemp = body.minTemp !== undefined ? parseNumericOrNull(body.minTemp) : current?.minTemp ?? null;
        const maxTemp = body.maxTemp !== undefined ? parseNumericOrNull(body.maxTemp) : current?.maxTemp ?? null;
        let checksPerDay = body.checksPerDay !== undefined ? parseInt(String(body.checksPerDay), 10) : current?.checksPerDay ?? 1;
        let frequency = (body.frequency !== undefined ? body.frequency : current?.frequency ?? 'DAILY') as HaccpFrequency;
        const instructions = body.instructions !== undefined ? cleanText(body.instructions, 1000) : current?.instructions ?? null;
        if (register === 'TEMPERATURE') {
            if (minTemp === null && maxTemp === null) {
                throw new HaccpError(400, { error: 'Una postazione di temperatura ha almeno un limite' });
            }
            if (minTemp !== null && maxTemp !== null && minTemp > maxTemp) {
                throw new HaccpError(400, { error: 'Il minimo supera il massimo' });
            }
            if (!Number.isInteger(checksPerDay) || checksPerDay < 1 || checksPerDay > 3) {
                throw new HaccpError(400, { error: 'Da una a tre rilevazioni al giorno' });
            }
        } else {
            checksPerDay = 1;
        }
        if (register === 'CLEANING') {
            if (!HACCP_FREQUENCIES.includes(frequency)) throw new HaccpError(400, { error: 'Frequenza non valida' });
        } else {
            frequency = 'DAILY';
        }
        return {
            label,
            minTemp: register === 'TEMPERATURE' ? minTemp : null,
            maxTemp: register === 'TEMPERATURE' ? maxTemp : null,
            checksPerDay,
            frequency,
            instructions,
        };
    };

    const duplicateLabel = (err: any): boolean => err?.code === '23505' && String(err?.constraint || '').includes('haccp_points_label_active');

    router.post('/points', ...manage, async (req, res) => {
        try {
            const register = req.body?.register as HaccpRegister;
            if (!HACCP_POINT_REGISTERS.includes(register)) throw new HaccpError(400, { error: 'Registro non valido' });
            const input = readPointInput(req.body ?? {}, register);
            const actor = await actorOf(req);
            const tenantId = req.tenantId!;
            const point = await withTenant(tenantId, async client => {
                const ins = await client.query(
                    `INSERT INTO haccp_points (tenant_id, register, label, min_temp, max_temp, checks_per_day, frequency, instructions, sort_order)
                     VALUES ($1::bigint, $2::varchar, $3, $4, $5, $6, $7, $8,
                             COALESCE((SELECT MAX(sort_order) + 1 FROM haccp_points WHERE tenant_id = $1::bigint AND register = $2::varchar), 1))
                     RETURNING ${POINT_COLUMNS}`,
                    [tenantId, register, input.label, input.minTemp, input.maxTemp, input.checksPerDay, input.frequency, input.instructions],
                );
                await logChange(client, tenantId, {
                    entity: 'point', entityId: ins.rows[0].id, action: 'CREATE', recordDate: null,
                    after: ins.rows[0], actor,
                });
                return ins.rows[0];
            });
            changed(req, null, 'POINTS');
            res.status(201).json(point);
        } catch (err: any) {
            if (duplicateLabel(err)) return res.status(409).json({ error: 'Esiste già un punto con questo nome', code: 'duplicate_label' });
            fail(res, err, 'POST /points');
        }
    });

    router.put('/points/:id', ...manage, async (req, res) => {
        try {
            const id = parseId(req.params.id);
            if (!id) throw new HaccpError(400, { error: 'id non valido' });
            const actor = await actorOf(req);
            const tenantId = req.tenantId!;
            const point = await withTenant(tenantId, async client => {
                const cur = await client.query(
                    `SELECT ${POINT_COLUMNS} FROM haccp_points WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
                    [tenantId, id],
                );
                const current = cur.rows[0] as PointRow | undefined;
                if (!current) throw new HaccpError(404, { error: 'Punto non trovato' });
                const input = readPointInput(req.body ?? {}, current.register, current);
                const active = typeof req.body?.active === 'boolean' ? req.body.active : current.active;
                const upd = await client.query(
                    `UPDATE haccp_points
                        SET label = $1, min_temp = $2, max_temp = $3, checks_per_day = $4, frequency = $5,
                            instructions = $6, active = $7, updated_at = now()
                      WHERE id = $8 AND tenant_id = $9
                      RETURNING ${POINT_COLUMNS}`,
                    [input.label, input.minTemp, input.maxTemp, input.checksPerDay, input.frequency, input.instructions, active, id, tenantId],
                );
                await logChange(client, tenantId, {
                    entity: 'point', entityId: id, action: 'UPDATE', recordDate: null,
                    before: current, after: upd.rows[0], reason: cleanText(req.body?.reason, 500), actor,
                });
                return upd.rows[0];
            });
            changed(req, null, 'POINTS');
            res.json(point);
        } catch (err: any) {
            if (duplicateLabel(err)) return res.status(409).json({ error: 'Esiste già un punto con questo nome', code: 'duplicate_label' });
            fail(res, err, 'PUT /points/:id');
        }
    });

    router.post('/points/reorder', ...manage, async (req, res) => {
        try {
            const register = req.body?.register as HaccpRegister;
            if (!HACCP_POINT_REGISTERS.includes(register)) throw new HaccpError(400, { error: 'Registro non valido' });
            const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(parseId).filter((n: number | null): n is number => !!n) : [];
            if (ids.length === 0) throw new HaccpError(400, { error: 'ids richiesti' });
            const tenantId = req.tenantId!;
            await withTenant(tenantId, async client => {
                for (let i = 0; i < ids.length; i++) {
                    await client.query(
                        `UPDATE haccp_points SET sort_order = $1, updated_at = now()
                          WHERE tenant_id = $2 AND register = $3 AND id = $4`,
                        [i + 1, tenantId, register, ids[i]],
                    );
                }
            });
            changed(req, null, 'POINTS');
            res.json({ ok: true });
        } catch (err) {
            fail(res, err, 'POST /points/reorder');
        }
    });

    // =====================================================================
    // Il giorno: tutti i registri in una lettura
    // =====================================================================

    router.get('/day', ...view, async (req, res) => {
        try {
            const date = req.query.date;
            if (!isValidDate(date)) throw new HaccpError(400, { error: 'date (YYYY-MM-DD) is required' });
            const tenantId = req.tenantId!;
            // Le pulizie settimanali e mensili valgono per il loro periodo: una
            // fatta martedì copre la settimana, e il modulo di giovedì deve
            // saperlo. La finestra più larga è il mese.
            const monthStart = `${date.slice(0, 7)}-01`;
            const weekBack = new Date(`${date}T00:00:00Z`);
            weekBack.setUTCDate(weekBack.getUTCDate() - 6);
            const cleaningFrom = [monthStart, weekBack.toISOString().slice(0, 10)].sort()[0];
            const [points, temps, oil, cleaning, receipts, production, ncs] = await Promise.all([
                queryWithRetry(
                    `SELECT ${POINT_COLUMNS} FROM haccp_points WHERE tenant_id = $1 ORDER BY register, sort_order, id`,
                    [tenantId],
                ),
                queryWithRetry(
                    `SELECT ${TEMP_COLUMNS} FROM haccp_temperature_readings
                      WHERE tenant_id = $1 AND date = $2 AND voided_at IS NULL ORDER BY slot, location`,
                    [tenantId, date],
                ),
                queryWithRetry(
                    `SELECT ${OIL_COLUMNS} FROM haccp_oil_checks
                      WHERE tenant_id = $1 AND date = $2 AND voided_at IS NULL ORDER BY fryer_label`,
                    [tenantId, date],
                ),
                queryWithRetry(
                    `SELECT ${CLEANING_COLUMNS} FROM haccp_cleaning_checks
                      WHERE tenant_id = $1 AND date BETWEEN $2::date AND $3::date AND voided_at IS NULL AND done
                      ORDER BY date DESC`,
                    [tenantId, cleaningFrom, date],
                ),
                queryWithRetry(
                    `SELECT ${RECEIPT_COLUMNS} FROM haccp_goods_receipts
                      WHERE tenant_id = $1 AND date = $2 AND voided_at IS NULL ORDER BY recorded_at`,
                    [tenantId, date],
                ),
                queryWithRetry(
                    `SELECT ${PRODUCTION_COLUMNS} FROM haccp_production_logs
                      WHERE tenant_id = $1 AND date = $2 AND voided_at IS NULL ORDER BY recorded_at`,
                    [tenantId, date],
                ),
                queryWithRetry(
                    `SELECT ${NC_COLUMNS} FROM haccp_nonconformities
                      WHERE tenant_id = $1 AND status <> 'VOID' AND (date = $2 OR status = 'OPEN')
                      ORDER BY opened_at DESC`,
                    [tenantId, date],
                ),
            ]);
            res.json({
                date,
                points: points.rows,
                temperatures: temps.rows,
                oil: oil.rows,
                cleaning: cleaning.rows,
                receipts: receipts.rows,
                production: production.rows,
                nonconformities: ncs.rows,
                canManage: await canManage(req),
            });
        } catch (err) {
            fail(res, err, 'GET /day');
        }
    });

    // =====================================================================
    // Temperature
    // =====================================================================

    router.get('/temperatures', ...view, async (req, res) => {
        try {
            const { date } = req.query;
            if (!isValidDate(date)) throw new HaccpError(400, { error: 'date (YYYY-MM-DD) is required' });
            const r = await queryWithRetry(
                `SELECT ${TEMP_COLUMNS} FROM haccp_temperature_readings
                  WHERE tenant_id = $1 AND date = $2 AND voided_at IS NULL
                  ORDER BY location ASC, slot ASC`,
                [req.tenantId!, date],
            );
            res.json(r.rows);
        } catch (err) {
            fail(res, err, 'GET /temperatures');
        }
    });

    /** Dopo il salvataggio di una rilevazione: fuori soglia → avviso a chi
     *  risponde del registro (non a chi l'ha scritta: la vede già in rosso);
     *  di nuovo in soglia → l'avviso si chiude per tutti. Solo il giorno di
     *  oggi suona: correggere il foglio di ieri non è un'emergenza, ma chiude
     *  comunque l'avviso rimasto aperto. */
    const notifyTemperature = async (
        tenantId: number,
        point: PointRow,
        row: any,
        before: any | null,
        actorId: number | null,
    ): Promise<void> => {
        try {
            const tag = haccpTemperatureTag(row.date, point.label, row.slot);
            const out = isOutOfRange(row.temperature, row.targetMin, row.targetMax);
            if (!out) {
                await deps.markNotificationsRead(tenantId, [tag]);
            } else {
                const sameAlert = before !== null && before.temperature === row.temperature
                    && isOutOfRange(before.temperature, before.targetMin ?? null, before.targetMax ?? null);
                const today = await deps.todayIso(tenantId);
                if (!sameAlert && row.date === today) {
                    await deps.pushToRoles(tenantId, HACCP_ALERT_ROLES, {
                        category: 'system',
                        title: 'Temperatura fuori soglia',
                        body: `${point.label} · ${formatHaccpTemperature(row.temperature)} (${limitText(row.targetMin, row.targetMax)})`,
                        url: '/?view=HACCP',
                        tag,
                    }, actorId ? { excludeUserId: actorId } : undefined);
                }
            }
            await closeMissingIfComplete(tenantId, row.date);
        } catch (err) {
            console.error('[haccp] notifica temperatura fallita:', err);
        }
    };

    /** Registro del giorno completo (prima rilevazione di ogni postazione
     *  attiva): il promemoria delle mancanti è superato. */
    const closeMissingIfComplete = async (tenantId: number, date: string): Promise<void> => {
        const r = await queryWithRetry(
            `SELECT COUNT(*)::int AS expected,
                    COUNT(*) FILTER (WHERE EXISTS (
                        SELECT 1 FROM haccp_temperature_readings t
                         WHERE t.tenant_id = p.tenant_id AND t.point_id = p.id AND t.date = $2
                           AND t.slot = 1 AND t.voided_at IS NULL
                    ))::int AS done
               FROM haccp_points p
              WHERE p.tenant_id = $1 AND p.register = 'TEMPERATURE' AND p.active`,
            [tenantId, date],
        );
        const { expected, done } = r.rows[0] ?? { expected: 0, done: 0 };
        if (expected > 0 && done >= expected) await deps.markNotificationsRead(tenantId, [haccpMissingTag(date)]);
    };

    const temperatureNc = async (client: PoolClient, tenantId: number, point: PointRow, row: any, actor: Actor, reason: string | null) => {
        const out = row.voidedAt ? false : isOutOfRange(row.temperature, row.targetMin, row.targetMax);
        await syncSourceNc(client, tenantId, {
            source: 'TEMPERATURE',
            sourceId: row.id,
            date: row.date,
            pointId: point.id,
            open: out,
            title: temperatureTitle(point.label, row.slot, point.checksPerDay, row.temperature, row.targetMin, row.targetMax),
            detail: row.note ?? null,
            actor,
            closingReason: row.voidedAt
                ? `Rilevazione annullata${reason ? `: ${reason}` : ''}`
                : `Rilevazione corretta, di nuovo in soglia${reason ? `: ${reason}` : ''}`,
        });
    };

    // Upsert sulla riga viva di (giorno, postazione, rilevazione). Il modulo
    // salva a ogni uscita dal campo: lo stesso valore ripubblicato non è una
    // correzione e non lascia traccia.
    router.post('/temperatures', ...record, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const body = req.body ?? {};
            const date = await registerDate(tenantId, body.date);
            const temperature = parseNumericOrNull(body.temperature);
            if (temperature === null) throw new HaccpError(400, { error: 'temperature is required' });
            if (temperature < -60 || temperature > 300) throw new HaccpError(400, { error: 'Temperatura fuori scala' });
            const slot = body.slot === undefined ? 1 : parseInt(String(body.slot), 10);
            const note = cleanText(body.note, 1000);
            const reason = cleanText(body.reason, 500);
            const actor = await actorOf(req);

            const result = await withConflictRetry(() => withTenant(tenantId, async client => {
                const point = await resolvePoint(client, tenantId, 'TEMPERATURE', body.pointId, body.location);
                if (!Number.isInteger(slot) || slot < 1 || slot > point.checksPerDay) {
                    throw new HaccpError(400, { error: `Rilevazione ${slot} non prevista per ${point.label}` });
                }
                const found = await client.query(
                    `SELECT ${TEMP_COLUMNS} FROM haccp_temperature_readings
                      WHERE tenant_id = $1 AND date = $2 AND point_id = $3 AND slot = $4 AND voided_at IS NULL
                      FOR UPDATE`,
                    [tenantId, date, point.id, slot],
                );
                const existing = found.rows[0] ?? null;
                if (existing) {
                    if (existing.temperature === temperature && (existing.note ?? null) === note) {
                        return { point, row: existing, before: existing, changed: false };
                    }
                    assertCorrectable(existing, actor, reason);
                    const upd = await client.query(
                        `UPDATE haccp_temperature_readings
                            SET temperature = $1, note = $2, target_min = $3, target_max = $4, location = $5,
                                updated_at = now(), updated_by_user_id = $6, updated_by_user_name = $7
                          WHERE id = $8
                          RETURNING ${TEMP_COLUMNS}`,
                        [temperature, note, point.minTemp, point.maxTemp, point.label, actor.userId, actor.name, existing.id],
                    );
                    const row = upd.rows[0];
                    await logChange(client, tenantId, {
                        entity: 'temperature', entityId: row.id, action: 'UPDATE', recordDate: date,
                        before: existing, after: row, reason, actor,
                    });
                    await temperatureNc(client, tenantId, point, row, actor, reason);
                    return { point, row, before: existing, changed: true };
                }
                const ins = await client.query(
                    `INSERT INTO haccp_temperature_readings
                        (tenant_id, date, point_id, location, slot, temperature, target_min, target_max, note,
                         recorded_by_user_id, recorded_by_user_name)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                     RETURNING ${TEMP_COLUMNS}`,
                    [tenantId, date, point.id, point.label, slot, temperature, point.minTemp, point.maxTemp, note, actor.userId, actor.name],
                );
                const row = ins.rows[0];
                await logChange(client, tenantId, {
                    entity: 'temperature', entityId: row.id, action: 'CREATE', recordDate: date, after: row, actor,
                });
                await temperatureNc(client, tenantId, point, row, actor, null);
                return { point, row, before: null, changed: true };
            }));

            if (result.changed) {
                // Prima della risposta, come per le altre letture condivise: chi
                // salva e poi apre il centro notifiche deve già trovarlo aggiornato.
                await notifyTemperature(tenantId, result.point, result.row, result.before, actor.userId);
                changed(req, date, 'TEMPERATURE');
            }
            res.status(201).json(result.row);
        } catch (err) {
            fail(res, err, 'POST /temperatures');
        }
    });

    const voidTemperature = async (req: Request, res: Response, legacyDelete: boolean) => {
        try {
            const tenantId = req.tenantId!;
            const id = req.params.id;
            if (!isUuid(id)) throw new HaccpError(400, { error: 'id non valido' });
            const reason = cleanText(req.body?.reason ?? req.query.reason, 500);
            const actor = await actorOf(req);
            const result = await withTenant(tenantId, async client => {
                const found = await client.query(
                    `SELECT ${TEMP_COLUMNS} FROM haccp_temperature_readings
                      WHERE tenant_id = $1 AND id = $2 AND voided_at IS NULL FOR UPDATE`,
                    [tenantId, id],
                );
                const existing = found.rows[0];
                if (!existing) throw new HaccpError(404, { error: 'Not found' });
                assertCorrectable(existing, actor, reason);
                const upd = await client.query(
                    `UPDATE haccp_temperature_readings
                        SET voided_at = now(), voided_by_user_id = $1, voided_by_user_name = $2, void_reason = $3
                      WHERE id = $4 RETURNING ${TEMP_COLUMNS}`,
                    [actor.userId, actor.name, reason, id],
                );
                const row = upd.rows[0];
                await logChange(client, tenantId, {
                    entity: 'temperature', entityId: id, action: 'VOID', recordDate: row.date,
                    before: existing, reason, actor,
                });
                const point = row.pointId
                    ? (await client.query(`SELECT ${POINT_COLUMNS} FROM haccp_points WHERE tenant_id = $1 AND id = $2`, [tenantId, row.pointId])).rows[0]
                    : null;
                if (point) await temperatureNc(client, tenantId, point, row, actor, reason);
                return row;
            });
            await deps.markNotificationsRead(tenantId, [haccpTemperatureTag(result.date, result.location, result.slot)]);
            changed(req, result.date, 'TEMPERATURE');
            if (legacyDelete) return res.status(204).send();
            res.json(result);
        } catch (err) {
            fail(res, err, 'void temperature');
        }
    };
    router.post('/temperatures/:id/void', ...record, (req, res) => voidTemperature(req, res, false));
    router.delete('/temperatures/:id', ...record, (req, res) => voidTemperature(req, res, true));

    // =====================================================================
    // Olio delle friggitrici
    // =====================================================================

    router.get('/oil', ...view, async (req, res) => {
        try {
            const { date } = req.query;
            if (!isValidDate(date)) throw new HaccpError(400, { error: 'date (YYYY-MM-DD) is required' });
            const r = await queryWithRetry(
                `SELECT ${OIL_COLUMNS} FROM haccp_oil_checks
                  WHERE tenant_id = $1 AND date = $2 AND voided_at IS NULL ORDER BY fryer_label ASC`,
                [req.tenantId!, date],
            );
            res.json(r.rows);
        } catch (err) {
            fail(res, err, 'GET /oil');
        }
    });

    router.post('/oil', ...record, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const body = req.body ?? {};
            const date = await registerDate(tenantId, body.date);
            const action = body.action as HaccpOilAction;
            if (!HACCP_OIL_ACTIONS.includes(action)) {
                throw new HaccpError(400, { error: `action must be one of ${HACCP_OIL_ACTIONS.join(', ')}` });
            }
            const note = cleanText(body.note, 1000);
            const reason = cleanText(body.reason, 500);
            const actor = await actorOf(req);
            const result = await withConflictRetry(() => withTenant(tenantId, async client => {
                const point = await resolvePoint(client, tenantId, 'OIL', body.pointId, body.fryerLabel);
                const found = await client.query(
                    `SELECT ${OIL_COLUMNS} FROM haccp_oil_checks
                      WHERE tenant_id = $1 AND date = $2 AND point_id = $3 AND voided_at IS NULL FOR UPDATE`,
                    [tenantId, date, point.id],
                );
                const existing = found.rows[0] ?? null;
                if (existing) {
                    if (existing.action === action && (existing.note ?? null) === note) return { row: existing, changed: false };
                    assertCorrectable(existing, actor, reason);
                    const upd = await client.query(
                        `UPDATE haccp_oil_checks
                            SET action = $1, note = $2, fryer_label = $3,
                                updated_at = now(), updated_by_user_id = $4, updated_by_user_name = $5
                          WHERE id = $6 RETURNING ${OIL_COLUMNS}`,
                        [action, note, point.label, actor.userId, actor.name, existing.id],
                    );
                    await logChange(client, tenantId, {
                        entity: 'oil', entityId: existing.id, action: 'UPDATE', recordDate: date,
                        before: existing, after: upd.rows[0], reason, actor,
                    });
                    return { row: upd.rows[0], changed: true };
                }
                const ins = await client.query(
                    `INSERT INTO haccp_oil_checks
                        (tenant_id, date, point_id, fryer_label, action, note, recorded_by_user_id, recorded_by_user_name)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${OIL_COLUMNS}`,
                    [tenantId, date, point.id, point.label, action, note, actor.userId, actor.name],
                );
                await logChange(client, tenantId, {
                    entity: 'oil', entityId: ins.rows[0].id, action: 'CREATE', recordDate: date, after: ins.rows[0], actor,
                });
                return { row: ins.rows[0], changed: true };
            }));
            if (result.changed) changed(req, date, 'OIL');
            res.status(201).json(result.row);
        } catch (err) {
            fail(res, err, 'POST /oil');
        }
    });

    // =====================================================================
    // Pulizie
    // =====================================================================

    router.get('/cleaning', ...view, async (req, res) => {
        try {
            const { date } = req.query;
            if (!isValidDate(date)) throw new HaccpError(400, { error: 'date (YYYY-MM-DD) is required' });
            const r = await queryWithRetry(
                `SELECT ${CLEANING_COLUMNS} FROM haccp_cleaning_checks
                  WHERE tenant_id = $1 AND date = $2 AND voided_at IS NULL ORDER BY point ASC`,
                [req.tenantId!, date],
            );
            res.json(r.rows);
        } catch (err) {
            fail(res, err, 'GET /cleaning');
        }
    });

    // Una pulizia si segna fatta; togliere la spunta annulla la riga (con le
    // regole delle correzioni). Le righe «done = false» del vecchio modulo non
    // si creano più: «non fatta» è l'assenza della registrazione.
    router.post('/cleaning', ...record, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const body = req.body ?? {};
            const date = await registerDate(tenantId, body.date);
            const done = body.done !== false;
            const note = cleanText(body.note, 1000);
            const reason = cleanText(body.reason, 500);
            const actor = await actorOf(req);
            const result = await withConflictRetry(() => withTenant(tenantId, async client => {
                const point = await resolvePoint(client, tenantId, 'CLEANING', body.pointId, body.point);
                const found = await client.query(
                    `SELECT ${CLEANING_COLUMNS} FROM haccp_cleaning_checks
                      WHERE tenant_id = $1 AND date = $2 AND point_id = $3 AND voided_at IS NULL FOR UPDATE`,
                    [tenantId, date, point.id],
                );
                const existing = found.rows[0] ?? null;
                if (!done) {
                    if (!existing) {
                        return { row: { id: null, date, pointId: point.id, point: point.label, done: false, note }, changed: false };
                    }
                    assertCorrectable(existing, actor, reason);
                    const upd = await client.query(
                        `UPDATE haccp_cleaning_checks
                            SET voided_at = now(), voided_by_user_id = $1, voided_by_user_name = $2, void_reason = $3
                          WHERE id = $4 RETURNING ${CLEANING_COLUMNS}`,
                        [actor.userId, actor.name, reason, existing.id],
                    );
                    await logChange(client, tenantId, {
                        entity: 'cleaning', entityId: existing.id, action: 'VOID', recordDate: date,
                        before: existing, reason, actor,
                    });
                    return { row: { ...upd.rows[0], done: false }, changed: true };
                }
                if (existing) {
                    if ((existing.note ?? null) === note && existing.done) return { row: existing, changed: false };
                    assertCorrectable(existing, actor, reason);
                    const upd = await client.query(
                        `UPDATE haccp_cleaning_checks
                            SET done = true, note = $1, point = $2,
                                updated_at = now(), updated_by_user_id = $3, updated_by_user_name = $4
                          WHERE id = $5 RETURNING ${CLEANING_COLUMNS}`,
                        [note, point.label, actor.userId, actor.name, existing.id],
                    );
                    await logChange(client, tenantId, {
                        entity: 'cleaning', entityId: existing.id, action: 'UPDATE', recordDate: date,
                        before: existing, after: upd.rows[0], reason, actor,
                    });
                    return { row: upd.rows[0], changed: true };
                }
                const ins = await client.query(
                    `INSERT INTO haccp_cleaning_checks
                        (tenant_id, date, point_id, point, done, note, recorded_by_user_id, recorded_by_user_name)
                     VALUES ($1, $2, $3, $4, true, $5, $6, $7) RETURNING ${CLEANING_COLUMNS}`,
                    [tenantId, date, point.id, point.label, note, actor.userId, actor.name],
                );
                await logChange(client, tenantId, {
                    entity: 'cleaning', entityId: ins.rows[0].id, action: 'CREATE', recordDate: date, after: ins.rows[0], actor,
                });
                return { row: ins.rows[0], changed: true };
            }));
            if (result.changed) changed(req, date, 'CLEANING');
            res.status(201).json(result.row);
        } catch (err) {
            fail(res, err, 'POST /cleaning');
        }
    });

    // =====================================================================
    // Ricevimento merci e produzione: registrazioni libere, più al giorno
    // =====================================================================

    interface FreeLog {
        entity: 'receipt' | 'production';
        table: string;
        columns: string;
        register: string;
        /** Campi del body → colonna, con il parser. */
        fields: Record<string, { column: string; parse: (v: unknown) => unknown }>;
        required: string;
        /** La non conformità che la riga apre (merce respinta), o null. */
        nc?: (row: any) => { open: boolean; title: string; detail: string | null } | null;
    }

    const asBool = (v: unknown) => v !== false;
    const FREE_LOGS: FreeLog[] = [
        {
            entity: 'receipt',
            table: 'haccp_goods_receipts',
            columns: RECEIPT_COLUMNS,
            register: 'RECEIPT',
            required: 'product',
            fields: {
                product: { column: 'product', parse: v => cleanText(v, 255) },
                lotNumber: { column: 'lot_number', parse: v => cleanText(v, 100) },
                temperature: { column: 'temperature', parse: parseNumericOrNull },
                accepted: { column: 'accepted', parse: asBool },
                note: { column: 'note', parse: v => cleanText(v, 1000) },
            },
            nc: row => ({
                open: row.accepted === false && !row.voidedAt,
                title: `Merce respinta · ${row.product}${row.lotNumber ? ` (lotto ${row.lotNumber})` : ''}`,
                detail: row.note ?? null,
            }),
        },
        {
            entity: 'production',
            table: 'haccp_production_logs',
            columns: PRODUCTION_COLUMNS,
            register: 'PRODUCTION',
            required: 'product',
            fields: {
                product: { column: 'product', parse: v => cleanText(v, 255) },
                blastTempRange: { column: 'blast_temp_range', parse: v => cleanText(v, 20) },
                blastDuration: { column: 'blast_duration', parse: v => cleanText(v, 20) },
                internalLot: { column: 'internal_lot', parse: v => cleanText(v, 100) },
                note: { column: 'note', parse: v => cleanText(v, 1000) },
            },
        },
    ];

    for (const log of FREE_LOGS) {
        const path = log.entity === 'receipt' ? '/receipts' : '/production';
        const ncSync = async (client: PoolClient, tenantId: number, row: any, actor: Actor, reason: string | null) => {
            if (!log.nc) return;
            const nc = log.nc(row);
            if (!nc) return;
            await syncSourceNc(client, tenantId, {
                source: 'RECEIPT',
                sourceId: row.id,
                date: row.date,
                pointId: null,
                open: nc.open,
                title: nc.title,
                detail: nc.detail,
                actor,
                closingReason: row.voidedAt
                    ? `Registrazione annullata${reason ? `: ${reason}` : ''}`
                    : `Merce accettata dopo la correzione${reason ? `: ${reason}` : ''}`,
            });
        };

        router.get(path, ...view, async (req, res) => {
            try {
                const { date } = req.query;
                if (!isValidDate(date)) throw new HaccpError(400, { error: 'date (YYYY-MM-DD) is required' });
                const r = await queryWithRetry(
                    `SELECT ${log.columns} FROM ${log.table}
                      WHERE tenant_id = $1 AND date = $2 AND voided_at IS NULL ORDER BY recorded_at ASC`,
                    [req.tenantId!, date],
                );
                res.json(r.rows);
            } catch (err) {
                fail(res, err, `GET ${path}`);
            }
        });

        router.post(path, ...record, async (req, res) => {
            try {
                const tenantId = req.tenantId!;
                const body = req.body ?? {};
                const date = await registerDate(tenantId, body.date);
                const values: Record<string, unknown> = {};
                for (const [key, f] of Object.entries(log.fields)) values[f.column] = f.parse(body[key]);
                if (!values[log.fields[log.required].column]) throw new HaccpError(400, { error: `${log.required} is required` });
                const actor = await actorOf(req);
                const cols = Object.keys(values);
                const row = await withTenant(tenantId, async client => {
                    const ins = await client.query(
                        `INSERT INTO ${log.table} (tenant_id, date, ${cols.join(', ')}, recorded_by_user_id, recorded_by_user_name)
                         VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}, $${cols.length + 3}, $${cols.length + 4})
                         RETURNING ${log.columns}`,
                        [tenantId, date, ...cols.map(c => values[c]), actor.userId, actor.name],
                    );
                    await logChange(client, tenantId, {
                        entity: log.entity, entityId: ins.rows[0].id, action: 'CREATE', recordDate: date, after: ins.rows[0], actor,
                    });
                    await ncSync(client, tenantId, ins.rows[0], actor, null);
                    return ins.rows[0];
                });
                changed(req, date, log.register);
                res.status(201).json(row);
            } catch (err) {
                fail(res, err, `POST ${path}`);
            }
        });

        router.put(`${path}/:id`, ...record, async (req, res) => {
            try {
                const tenantId = req.tenantId!;
                const id = req.params.id;
                if (!isUuid(id)) throw new HaccpError(400, { error: 'id non valido' });
                const body = req.body ?? {};
                const reason = cleanText(body.reason, 500);
                const actor = await actorOf(req);
                const row = await withTenant(tenantId, async client => {
                    const found = await client.query(
                        `SELECT ${log.columns} FROM ${log.table} WHERE tenant_id = $1 AND id = $2 AND voided_at IS NULL FOR UPDATE`,
                        [tenantId, id],
                    );
                    const existing = found.rows[0];
                    if (!existing) throw new HaccpError(404, { error: 'Not found' });
                    const sets: string[] = [];
                    const params: unknown[] = [];
                    for (const [key, f] of Object.entries(log.fields)) {
                        if (body[key] === undefined) continue;
                        const v = f.parse(body[key]);
                        if (key === log.required && !v) throw new HaccpError(400, { error: `${log.required} is required` });
                        params.push(v);
                        sets.push(`${f.column} = $${params.length}`);
                    }
                    if (sets.length === 0) return existing;
                    assertCorrectable(existing, actor, reason);
                    params.push(actor.userId, actor.name, id);
                    const upd = await client.query(
                        `UPDATE ${log.table}
                            SET ${sets.join(', ')}, updated_at = now(),
                                updated_by_user_id = $${params.length - 2}, updated_by_user_name = $${params.length - 1}
                          WHERE id = $${params.length} RETURNING ${log.columns}`,
                        params,
                    );
                    await logChange(client, tenantId, {
                        entity: log.entity, entityId: id, action: 'UPDATE', recordDate: existing.date,
                        before: existing, after: upd.rows[0], reason, actor,
                    });
                    await ncSync(client, tenantId, upd.rows[0], actor, reason);
                    return upd.rows[0];
                });
                changed(req, row.date, log.register);
                res.json(row);
            } catch (err) {
                fail(res, err, `PUT ${path}/:id`);
            }
        });

        const voidRow = async (req: Request, res: Response, legacyDelete: boolean) => {
            try {
                const tenantId = req.tenantId!;
                const id = req.params.id;
                if (!isUuid(id)) throw new HaccpError(400, { error: 'id non valido' });
                const reason = cleanText(req.body?.reason ?? req.query.reason, 500);
                const actor = await actorOf(req);
                const row = await withTenant(tenantId, async client => {
                    const found = await client.query(
                        `SELECT ${log.columns} FROM ${log.table} WHERE tenant_id = $1 AND id = $2 AND voided_at IS NULL FOR UPDATE`,
                        [tenantId, id],
                    );
                    const existing = found.rows[0];
                    if (!existing) throw new HaccpError(404, { error: 'Not found' });
                    assertCorrectable(existing, actor, reason);
                    const upd = await client.query(
                        `UPDATE ${log.table}
                            SET voided_at = now(), voided_by_user_id = $1, voided_by_user_name = $2, void_reason = $3
                          WHERE id = $4 RETURNING ${log.columns}`,
                        [actor.userId, actor.name, reason, id],
                    );
                    await logChange(client, tenantId, {
                        entity: log.entity, entityId: id, action: 'VOID', recordDate: existing.date,
                        before: existing, reason, actor,
                    });
                    await ncSync(client, tenantId, upd.rows[0], actor, reason);
                    return upd.rows[0];
                });
                changed(req, row.date, log.register);
                if (legacyDelete) return res.status(204).send();
                res.json(row);
            } catch (err) {
                fail(res, err, `void ${path}`);
            }
        };
        router.post(`${path}/:id/void`, ...record, (req, res) => voidRow(req, res, false));
        router.delete(`${path}/:id`, ...record, (req, res) => voidRow(req, res, true));
    }

    // =====================================================================
    // Non conformità
    // =====================================================================

    router.get('/nonconformities', ...view, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const status = req.query.status === 'all' ? 'all' : 'open';
            const from = isValidDate(req.query.from) ? req.query.from : null;
            const to = isValidDate(req.query.to) ? req.query.to : null;
            const params: unknown[] = [tenantId];
            const where = ['tenant_id = $1'];
            if (status === 'open') where.push(`status = 'OPEN'`);
            if (from) { params.push(from); where.push(`date >= $${params.length}`); }
            if (to) { params.push(to); where.push(`date <= $${params.length}`); }
            const r = await queryWithRetry(
                `SELECT ${NC_COLUMNS} FROM haccp_nonconformities
                  WHERE ${where.join(' AND ')}
                  ORDER BY (status = 'OPEN') DESC, opened_at DESC
                  LIMIT 500`,
                params,
            );
            res.json({ nonconformities: r.rows });
        } catch (err) {
            fail(res, err, 'GET /nonconformities');
        }
    });

    router.post('/nonconformities', ...record, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const body = req.body ?? {};
            const date = await registerDate(tenantId, body.date);
            const title = cleanText(body.title, 255);
            if (!title) throw new HaccpError(400, { error: 'Serve una descrizione della non conformità' });
            const detail = cleanText(body.detail, 2000);
            const correctiveAction = cleanText(body.correctiveAction, 2000);
            const actor = await actorOf(req);
            const row = await withTenant(tenantId, async client => {
                // Una non conformità trovata e risolta subito (lo scaffale
                // sporco, ripulito) nasce già chiusa: azione e chiusura insieme.
                const closedNow = correctiveAction !== null;
                const ins = await client.query(
                    `INSERT INTO haccp_nonconformities
                        (tenant_id, date, source, title, detail, opened_by_user_id, opened_by_user_name,
                         status, corrective_action, closed_at, closed_by_user_id, closed_by_user_name)
                     VALUES ($1, $2, 'MANUAL', $3, $4, $5, $6, $7, $8, $9, $10, $11)
                     RETURNING ${NC_COLUMNS}`,
                    [
                        tenantId, date, title, detail, actor.userId, actor.name,
                        closedNow ? 'CLOSED' : 'OPEN', correctiveAction,
                        closedNow ? new Date() : null,
                        closedNow ? actor.userId : null,
                        closedNow ? actor.name : null,
                    ],
                );
                await logChange(client, tenantId, {
                    entity: 'nonconformity', entityId: ins.rows[0].id, action: 'CREATE', recordDate: date, after: ins.rows[0], actor,
                });
                return ins.rows[0];
            });
            changed(req, date, 'NONCONFORMITY');
            res.status(201).json(row);
        } catch (err) {
            fail(res, err, 'POST /nonconformities');
        }
    });

    // Chiude scrivendo l'azione correttiva. Su una già chiusa corregge
    // l'azione, e allora vale la regola delle correzioni.
    router.post('/nonconformities/:id/close', ...record, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const id = parseId(req.params.id);
            if (!id) throw new HaccpError(400, { error: 'id non valido' });
            const correctiveAction = cleanText(req.body?.correctiveAction, 2000);
            if (!correctiveAction) throw new HaccpError(400, { error: 'Serve l\'azione correttiva', code: 'action_required' });
            const reason = cleanText(req.body?.reason, 500);
            const actor = await actorOf(req);
            const row = await withTenant(tenantId, async client => {
                const found = await client.query(
                    `SELECT ${NC_COLUMNS}, closed_by_user_id AS "closedByUserId" FROM haccp_nonconformities
                      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
                    [tenantId, id],
                );
                const existing = found.rows[0];
                if (!existing) throw new HaccpError(404, { error: 'Non conformità non trovata' });
                if (existing.status === 'VOID') throw new HaccpError(409, { error: 'Non conformità annullata' });
                if (existing.status === 'CLOSED') {
                    if (existing.correctiveAction === correctiveAction) return existing;
                    assertCorrectable({ updatedByUserId: existing.closedByUserId, updatedAt: existing.closedAt }, actor, reason);
                }
                const upd = await client.query(
                    `UPDATE haccp_nonconformities
                        SET status = 'CLOSED', corrective_action = $1, closed_at = now(),
                            closed_by_user_id = $2, closed_by_user_name = $3, updated_at = now()
                      WHERE id = $4 RETURNING ${NC_COLUMNS}`,
                    [correctiveAction, actor.userId, actor.name, id],
                );
                const { closedByUserId: _omit, ...before } = existing;
                await logChange(client, tenantId, {
                    entity: 'nonconformity', entityId: id, action: 'UPDATE', recordDate: existing.date,
                    before, after: upd.rows[0], reason, actor,
                });
                return upd.rows[0];
            });
            changed(req, row.date, 'NONCONFORMITY');
            res.json(row);
        } catch (err) {
            fail(res, err, 'POST /nonconformities/:id/close');
        }
    });

    // Annullare una non conformità (aperta per errore) è da responsabile, e
    // sempre motivato: è l'unico modo di farne sparire una dal conteggio.
    router.post('/nonconformities/:id/void', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const id = parseId(req.params.id);
            if (!id) throw new HaccpError(400, { error: 'id non valido' });
            const reason = cleanText(req.body?.reason, 500);
            if (!reason) throw reasonRequired();
            const actor = await actorOf(req);
            const row = await withTenant(tenantId, async client => {
                const found = await client.query(
                    `SELECT ${NC_COLUMNS} FROM haccp_nonconformities WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
                    [tenantId, id],
                );
                const existing = found.rows[0];
                if (!existing) throw new HaccpError(404, { error: 'Non conformità non trovata' });
                if (existing.status === 'VOID') return existing;
                const upd = await client.query(
                    `UPDATE haccp_nonconformities
                        SET status = 'VOID', void_reason = $1, closed_at = COALESCE(closed_at, now()),
                            closed_by_user_id = COALESCE(closed_by_user_id, $2),
                            closed_by_user_name = COALESCE(closed_by_user_name, $3), updated_at = now()
                      WHERE id = $4 RETURNING ${NC_COLUMNS}`,
                    [reason, actor.userId, actor.name, id],
                );
                await logChange(client, tenantId, {
                    entity: 'nonconformity', entityId: id, action: 'VOID', recordDate: existing.date,
                    before: existing, reason, actor,
                });
                return upd.rows[0];
            });
            changed(req, row.date, 'NONCONFORMITY');
            res.json(row);
        } catch (err) {
            fail(res, err, 'POST /nonconformities/:id/void');
        }
    });

    // =====================================================================
    // Storico e report
    // =====================================================================

    router.get('/changes', ...view, async (req, res) => {
        try {
            const entity = cleanText(req.query.entity, 30);
            const entityId = cleanText(req.query.entityId, 64);
            if (!entity || !entityId) throw new HaccpError(400, { error: 'entity ed entityId richiesti' });
            const r = await queryWithRetry(
                `SELECT ${CHANGE_COLUMNS} FROM haccp_changes
                  WHERE tenant_id = $1 AND entity = $2 AND entity_id = $3 ORDER BY created_at ASC, id ASC`,
                [req.tenantId!, entity, entityId],
            );
            res.json({ changes: r.rows });
        } catch (err) {
            fail(res, err, 'GET /changes');
        }
    });

    // Tutto il periodo in una risposta: il report si stampa da qui, e
    // l'ispettore chiede mesi, non giorni. Le righe annullate ci sono,
    // marcate: sul foglio si vede che c'erano e perché sono state tolte.
    router.get('/report', ...view, async (req, res) => {
        try {
            const { from, to } = req.query;
            if (!isValidDate(from) || !isValidDate(to) || from > to) {
                throw new HaccpError(400, { error: 'from e to (YYYY-MM-DD) richiesti, from ≤ to' });
            }
            const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
            if (days > 400) throw new HaccpError(400, { error: 'Periodo troppo lungo: al massimo un anno' });
            const tenantId = req.tenantId!;
            const range = [tenantId, from, to];
            const between = 'tenant_id = $1 AND date BETWEEN $2::date AND $3::date';
            const [tenant, points, temps, oil, cleaning, receipts, production, ncs, changes] = await Promise.all([
                // Il nome in testa al foglio: è la prima cosa che l'ispettore
                // controlla, che il registro sia di questo locale.
                queryWithRetry(`SELECT name FROM tenants WHERE id = $1`, [tenantId]).catch(() => ({ rows: [] as any[] })),
                queryWithRetry(`SELECT ${POINT_COLUMNS} FROM haccp_points WHERE tenant_id = $1 ORDER BY register, sort_order, id`, [tenantId]),
                queryWithRetry(`SELECT ${TEMP_COLUMNS} FROM haccp_temperature_readings WHERE ${between} ORDER BY date, location, slot`, range),
                queryWithRetry(`SELECT ${OIL_COLUMNS} FROM haccp_oil_checks WHERE ${between} ORDER BY date, fryer_label`, range),
                queryWithRetry(`SELECT ${CLEANING_COLUMNS} FROM haccp_cleaning_checks WHERE ${between} ORDER BY date, point`, range),
                queryWithRetry(`SELECT ${RECEIPT_COLUMNS} FROM haccp_goods_receipts WHERE ${between} ORDER BY date, recorded_at`, range),
                queryWithRetry(`SELECT ${PRODUCTION_COLUMNS} FROM haccp_production_logs WHERE ${between} ORDER BY date, recorded_at`, range),
                queryWithRetry(
                    `SELECT ${NC_COLUMNS} FROM haccp_nonconformities
                      WHERE tenant_id = $1 AND (date BETWEEN $2::date AND $3::date OR (status = 'OPEN' AND date < $2::date))
                      ORDER BY date, opened_at`,
                    range,
                ),
                queryWithRetry(
                    `SELECT ${CHANGE_COLUMNS} FROM haccp_changes
                      WHERE tenant_id = $1 AND record_date BETWEEN $2::date AND $3::date AND action <> 'CREATE'
                        AND entity <> 'nonconformity'
                      ORDER BY created_at, id`,
                    range,
                ),
            ]);
            res.json({
                from, to,
                restaurantName: tenant.rows[0]?.name ?? null,
                points: points.rows,
                temperatures: temps.rows,
                oil: oil.rows,
                cleaning: cleaning.rows,
                receipts: receipts.rows,
                production: production.rows,
                nonconformities: ncs.rows,
                changes: changes.rows,
                generatedAt: new Date().toISOString(),
            });
        } catch (err) {
            fail(res, err, 'GET /report');
        }
    });

    return router;
}

/** Promemoria di sistema HACCP_TEMPERATURES: all'orario scelto in
 *  Impostazioni → Promemoria avvisa solo se manca la prima rilevazione di
 *  qualche postazione attiva. Tace nei giorni di chiusura, per chi non ha
 *  postazioni e per chi il registro non l'ha usato nell'ultimo mese — il seed
 *  crea il promemoria per ogni ristorante. */
export async function runHaccpMissingReminder(deps: HaccpDeps, tenantId: number, targetRoles: string[]): Promise<void> {
    const today = await deps.todayIso(tenantId);
    if (!(await deps.isServiceDay(tenantId, today))) return;
    const used = await queryWithRetry(
        `SELECT 1 FROM haccp_temperature_readings
          WHERE tenant_id = $1 AND date >= $2::date - 30 LIMIT 1`,
        [tenantId, today],
    );
    if (used.rows.length === 0) return;
    const r = await queryWithRetry(
        `SELECT p.label
           FROM haccp_points p
          WHERE p.tenant_id = $1 AND p.register = 'TEMPERATURE' AND p.active
            AND NOT EXISTS (
                SELECT 1 FROM haccp_temperature_readings t
                 WHERE t.tenant_id = p.tenant_id AND t.point_id = p.id AND t.date = $2
                   AND t.slot = 1 AND t.voided_at IS NULL
            )
          ORDER BY p.sort_order, p.id`,
        [tenantId, today],
    );
    const missing: string[] = r.rows.map((row: any) => row.label);
    if (missing.length === 0) return;
    const total = await queryWithRetry(
        `SELECT COUNT(*)::int AS n FROM haccp_points WHERE tenant_id = $1 AND register = 'TEMPERATURE' AND active`,
        [tenantId],
    );
    const shown = missing.slice(0, 3).join(', ');
    const rest = missing.length > 3 ? ` e altre ${missing.length - 3}` : '';
    await deps.pushToRoles(tenantId, targetRoles.length > 0 ? targetRoles : HACCP_ALERT_ROLES, {
        category: 'system',
        title: missing.length === (total.rows[0]?.n ?? 0)
            ? 'Temperature di oggi da registrare'
            : missing.length === 1 ? 'Manca una temperatura' : `Mancano ${missing.length} temperature`,
        body: `${shown}${rest}`,
        url: '/?view=HACCP',
        tag: haccpMissingTag(today),
    });
}
