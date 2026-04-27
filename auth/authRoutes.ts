import { Router, Request, Response } from 'express';
import { AuthService } from './authService.js';
import { authenticate, authorize } from './authMiddleware.js';
import { UserRole } from '../types.js';
import { RolePermissionService, ALL_PERMISSIONS, Permission } from './permissionService.js';
import { LogService, ActivityAction, ResourceType } from '../activityLogs/logService.js';

const router = Router();

// POST /auth/login - User login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await AuthService.login(email, password);

    if (!result) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Get user's permissions from database
    const permissions = await RolePermissionService.getPermissionsForRole(result.user.role);

    // Log login activity
    LogService.logActivity(
      result.user.id,
      result.user.email,
      result.user.full_name,
      ActivityAction.LOGIN,
      ResourceType.AUTH,
      result.user.id,
      result.user.email
    );

    res.json({
      user: result.user,
      permissions,
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/logout - User logout
router.post('/logout', authenticate, async (req: Request, res: Response) => {
  try {
    if (req.user) {
      // Log logout activity
      LogService.logActivity(
        req.user.userId,
        req.user.email,
        req.user.email,
        ActivityAction.LOGOUT,
        ResourceType.AUTH,
        req.user.userId,
        req.user.email
      );

      await AuthService.logout(req.user.userId);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/refresh - Refresh access token
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token is required' });
    }

    const tokens = await AuthService.refreshAccessToken(refreshToken);

    if (!tokens) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    res.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auth/me - Get current user with permissions
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await AuthService.getUserById(req.user.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get user's permissions from database
    const permissions = await RolePermissionService.getPermissionsForRole(user.role);

    res.json({ ...user, permissions });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// USER MANAGEMENT ROUTES (Owner only)
// ============================================

// GET /auth/users - List all users
router.get('/users', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    console.log('Fetching all users...');
    const users = await AuthService.getAllUsers();
    console.log(`Found ${users.length} users`);
    res.json(users);
  } catch (error: any) {
    console.error('Get users error:', error.message, error.stack);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /auth/users - Create new user
router.post('/users', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    const { email, password, full_name, role } = req.body;

    if (!email || !password || !full_name || !role) {
      return res.status(400).json({ error: 'Email, password, full_name, and role are required' });
    }

    if (!Object.values(UserRole).includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const user = await AuthService.createUser(email, password, full_name, role);

    // Log activity
    if (req.user) {
      LogService.logActivity(
        req.user.userId,
        req.user.email,
        req.user.email,
        ActivityAction.CREATE,
        ResourceType.USER,
        user.id,
        user.email,
        { role, full_name }
      );
    }

    res.status(201).json(user);
  } catch (error: any) {
    console.error('Create user error:', error);
    if (error.code === '23505') { // Unique violation
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /auth/users/:id - Update user
router.put('/users/:id', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { email, password, full_name, role, is_active } = req.body;

    if (role && !Object.values(UserRole).includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const user = await AuthService.updateUser(userId, {
      email,
      password,
      full_name,
      role,
      is_active
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Log activity
    if (req.user) {
      LogService.logActivity(
        req.user.userId,
        req.user.email,
        req.user.email,
        ActivityAction.UPDATE,
        ResourceType.USER,
        userId,
        user.email,
        { role, full_name, is_active }
      );
    }

    res.json(user);
  } catch (error: any) {
    console.error('Update user error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /auth/users/:id - Delete user
router.delete('/users/:id', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);

    // Prevent deleting yourself
    if (req.user && req.user.userId === userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Get user email before deleting
    const userToDelete = await AuthService.getUserById(userId);
    const userEmail = userToDelete?.email;

    const deleted = await AuthService.deleteUser(userId);

    if (!deleted) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Log activity
    if (req.user) {
      LogService.logActivity(
        req.user.userId,
        req.user.email,
        req.user.email,
        ActivityAction.DELETE,
        ResourceType.USER,
        userId,
        userEmail
      );
    }

    res.status(204).send();
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ROLE PERMISSIONS MANAGEMENT (Owner only)
// ============================================

// GET /auth/permissions - Get all available permissions
router.get('/permissions', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    res.json({
      features: ALL_PERMISSIONS,
      roles: Object.values(UserRole)
    });
  } catch (error) {
    console.error('Get permissions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auth/permissions/roles - Get all role permissions
router.get('/permissions/roles', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    const permissions = await RolePermissionService.getAllRolePermissions();
    res.json(permissions);
  } catch (error) {
    console.error('Get role permissions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auth/permissions/roles/:role - Get permissions for a specific role
router.get('/permissions/roles/:role', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    const role = req.params.role.toUpperCase() as UserRole;

    if (!Object.values(UserRole).includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const permissions = await RolePermissionService.getPermissionsForRole(role);
    res.json({ role, permissions });
  } catch (error) {
    console.error('Get role permissions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /auth/permissions/roles/:role - Update permissions for a role
router.put('/permissions/roles/:role', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    const role = req.params.role.toUpperCase() as UserRole;
    const { permissions } = req.body;

    if (!Object.values(UserRole).includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'Permissions must be an array' });
    }

    // Prevent removing critical permissions from OWNER role
    if (role === UserRole.OWNER) {
      const requiredOwnerPermissions = ['users:full', 'settings:full'];
      for (const required of requiredOwnerPermissions) {
        if (!permissions.includes(required)) {
          return res.status(400).json({
            error: `Cannot remove ${required} permission from OWNER role`
          });
        }
      }
    }

    await RolePermissionService.setPermissionsForRole(role, permissions as Permission[]);

    const updatedPermissions = await RolePermissionService.getPermissionsForRole(role);
    res.json({ role, permissions: updatedPermissions });
  } catch (error) {
    console.error('Update role permissions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
