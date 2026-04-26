import { Router, Request, Response } from 'express';
import { AuthService } from './authService.js';
import { authenticate, authorize } from './authMiddleware.js';
import { UserRole } from '../types.js';

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

    res.json({
      user: result.user,
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

// GET /auth/me - Get current user
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await AuthService.getUserById(req.user.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
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
    const users = await AuthService.getAllUsers();
    res.json(users);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
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

    const deleted = await AuthService.deleteUser(userId);

    if (!deleted) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
