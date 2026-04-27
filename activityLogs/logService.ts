import pool from '../db.js';

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
  AUTH = 'AUTH'
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
  action?: ActivityAction;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}

export interface ActivityStats {
  total_logs: number;
  logs_by_action: Record<string, number>;
  logs_by_resource: Record<string, number>;
  recent_users: { user_id: number; user_name: string; count: number }[];
}

export class LogService {
  /**
   * Log an activity to the database
   */
  static async logActivity(
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
      const result = await pool.query(
        `INSERT INTO activity_logs
         (user_id, user_email, user_name, action, resource_type, resource_id, resource_name, details, status, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
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
  static async getActivityLogs(filters: LogFilters = {}): Promise<{ logs: ActivityLog[]; total: number }> {
    const {
      user_id,
      resource_type,
      action,
      from_date,
      to_date,
      limit = 50,
      offset = 0
    } = filters;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (user_id) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(user_id);
    }

    if (resource_type) {
      conditions.push(`resource_type = $${paramIndex++}`);
      params.push(resource_type);
    }

    if (action) {
      conditions.push(`action = $${paramIndex++}`);
      params.push(action);
    }

    if (from_date) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(from_date);
    }

    if (to_date) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(to_date);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM activity_logs ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get paginated logs
    const logsResult = await pool.query(
      `SELECT * FROM activity_logs ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, limit, offset]
    );

    return {
      logs: logsResult.rows,
      total
    };
  }

  /**
   * Get activity statistics
   */
  static async getActivityStats(): Promise<ActivityStats> {
    // Total logs
    const totalResult = await pool.query('SELECT COUNT(*) FROM activity_logs');
    const total_logs = parseInt(totalResult.rows[0].count, 10);

    // Logs by action
    const actionResult = await pool.query(
      `SELECT action, COUNT(*) as count FROM activity_logs GROUP BY action`
    );
    const logs_by_action: Record<string, number> = {};
    for (const row of actionResult.rows) {
      logs_by_action[row.action] = parseInt(row.count, 10);
    }

    // Logs by resource type
    const resourceResult = await pool.query(
      `SELECT resource_type, COUNT(*) as count FROM activity_logs GROUP BY resource_type`
    );
    const logs_by_resource: Record<string, number> = {};
    for (const row of resourceResult.rows) {
      logs_by_resource[row.resource_type] = parseInt(row.count, 10);
    }

    // Recent active users (top 5)
    const usersResult = await pool.query(
      `SELECT user_id, user_name, COUNT(*) as count
       FROM activity_logs
       WHERE user_id IS NOT NULL
       GROUP BY user_id, user_name
       ORDER BY count DESC
       LIMIT 5`
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
  static async getLogUsers(): Promise<{ id: number; name: string; email: string }[]> {
    const result = await pool.query(
      `SELECT DISTINCT user_id as id, user_name as name, user_email as email
       FROM activity_logs
       WHERE user_id IS NOT NULL
       ORDER BY user_name`
    );
    return result.rows;
  }
}
