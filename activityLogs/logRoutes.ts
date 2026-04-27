import { Router, Request, Response } from 'express';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';
import { LogService, ResourceType, ActivityAction } from './logService.js';

const router = Router();

// GET /activity-logs - Get activity logs with filters and pagination
router.get('/', authenticate, requirePermission('logs:view'), async (req: Request, res: Response) => {
  try {
    const {
      user_id,
      resource_type,
      action,
      from_date,
      to_date,
      limit,
      offset
    } = req.query;

    const filters = {
      user_id: user_id ? parseInt(user_id as string, 10) : undefined,
      resource_type: resource_type as ResourceType | undefined,
      action: action as ActivityAction | undefined,
      from_date: from_date as string | undefined,
      to_date: to_date as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : 50,
      offset: offset ? parseInt(offset as string, 10) : 0
    };

    const result = await LogService.getActivityLogs(filters);
    res.json(result);
  } catch (error) {
    console.error('Error fetching activity logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /activity-logs/stats - Get activity statistics
router.get('/stats', authenticate, requirePermission('logs:view'), async (req: Request, res: Response) => {
  try {
    const stats = await LogService.getActivityStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching activity stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /activity-logs/users - Get list of users with activity logs (for filter)
router.get('/users', authenticate, requirePermission('logs:view'), async (req: Request, res: Response) => {
  try {
    const users = await LogService.getLogUsers();
    res.json(users);
  } catch (error) {
    console.error('Error fetching log users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
