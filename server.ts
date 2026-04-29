import dotenv from 'dotenv';
dotenv.config();

// Build version identifier - change this to verify deployments
const BUILD_VERSION = '2026-04-29-v3';
console.log(`🚀 Server starting - Build version: ${BUILD_VERSION}`);

import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import pool, { createSchema } from './db.js';
import { SocketService } from './services/socketService.js';
import { Shift, PaymentStatus, UserRole } from './types.js';
import authRoutes from './auth/authRoutes.js';
import logRoutes from './activityLogs/logRoutes.js';
import { authenticate, authorize, requirePermission } from './auth/authMiddleware.js';
import { LogService, ActivityAction, ResourceType } from './activityLogs/logService.js';

const app = express();
const port = process.env.PORT || 3000;

// Create HTTP server from Express app
const httpServer = createServer(app);

// Socket service instance (initialized in startServer)
let socketService: SocketService | undefined;

// Flexible CORS configuration - temporarily allow all for debugging
const corsOptions = {
  origin: true,  // Allow all origins temporarily
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check endpoint for Railway
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'RistoManager API is running' });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    server: 'running',
    socketio: socketService ? 'initialized' : 'not initialized'
  });
});

// ============================================
// AUTHENTICATION ROUTES
// ============================================
app.use('/auth', authRoutes);

// ============================================
// ACTIVITY LOGS ROUTES
// ============================================
app.use('/activity-logs', logRoutes);

// ============================================
// WHATSAPP WEBHOOK ENDPOINTS (Vonage)
// ============================================

// Vonage WhatsApp inbound messages webhook
app.post('/webhook/vonage-inbound', async (req, res) => {
    console.log('[Vonage] Incoming message:', JSON.stringify(req.body, null, 2));

    try {
        // Acknowledge immediately to Vonage
        res.status(200).send();

        // Vonage sends two different formats:
        // Format 1 (actual): { from, message_type: "text", text: "..." }
        // Format 2 (sandbox): { from, message: { content: { type: "text", text: "..." } } }

        const from = req.body.from;
        let messageText = null;

        // Check actual Vonage format first
        if (req.body.message_type === 'text' && req.body.text) {
            messageText = req.body.text;
        }
        // Check sandbox/alternative format
        else if (req.body.message?.content?.type === 'text') {
            messageText = req.body.message.content.text;
        }

        if (messageText) {
            await processWhatsAppBooking(from, messageText);
        } else {
            console.log('[Vonage] Non-text message received, ignoring');
        }

    } catch (error) {
        console.error('[Vonage] Error processing message:', error);
        // Still respond 200 to Vonage to avoid retries
        res.status(200).send();
    }
});

// Vonage WhatsApp status updates webhook
app.post('/webhook/vonage-status', (req, res) => {
    console.log('[Vonage] Message status:', JSON.stringify(req.body, null, 2));
    res.status(200).send();
});

// ============================================
// PROTECTED ENDPOINTS
// ============================================

// Reservations - require authentication
app.get('/reservations', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM reservations ORDER BY reservation_time DESC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/reservations', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        const { customer_name, reservation_time, shift, guests, table_id, notes, email, phone, payment_status, arrival_status } = req.body;
        const result = await pool.query(
            'INSERT INTO reservations (customer_name, reservation_time, shift, guests, table_id, notes, email, phone, payment_status, arrival_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
            [customer_name, reservation_time, shift, guests, table_id, notes, email, phone, payment_status, arrival_status || 'WAITING']
        );
        const newReservation = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.RESERVATION,
                newReservation.id,
                customer_name,
                { guests, reservation_time, shift }
            );
        }

        // Broadcast to all connected clients except the one who created it
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastReservationCreated(newReservation, socketId);

        res.status(201).json(newReservation);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/reservations/:id', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { customer_name, reservation_time, shift, guests, table_id, notes, email, phone, payment_status, arrival_status } = req.body;
        const result = await pool.query(
            'UPDATE reservations SET customer_name = $1, reservation_time = $2, shift = $3, guests = $4, table_id = $5, notes = $6, email = $7, phone = $8, payment_status = $9, arrival_status = $10 WHERE id = $11 RETURNING *',
            [customer_name, reservation_time, shift, guests, table_id, notes, email, phone, payment_status, arrival_status, id]
        );
        const updatedReservation = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.RESERVATION,
                parseInt(id, 10),
                customer_name,
                { guests, reservation_time, shift, payment_status, arrival_status }
            );
        }

        // Broadcast to all connected clients except the one who updated it
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastReservationUpdated(updatedReservation, socketId);

        res.json(updatedReservation);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/reservations/:id', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        const { id } = req.params;

        // Get reservation name before deleting
        const existing = await pool.query('SELECT customer_name FROM reservations WHERE id = $1', [id]);
        const resourceName = existing.rows[0]?.customer_name;

        await pool.query('DELETE FROM reservations WHERE id = $1', [id]);

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.RESERVATION,
                parseInt(id, 10),
                resourceName
            );
        }

        // Broadcast to all connected clients except the one who deleted it
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastReservationDeleted(Number(id), socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Send WhatsApp confirmation for reservation
app.post('/reservations/:id/confirm-whatsapp', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        const { id } = req.params;

        // Get reservation details
        const result = await pool.query(
            'SELECT customer_name, reservation_time, guests, phone FROM reservations WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Reservation not found' });
        }

        const reservation = result.rows[0];

        if (!reservation.phone) {
            return res.status(400).json({ error: 'No phone number for this reservation' });
        }

        // Format date and time in Italian format
        const reservationDate = new Date(reservation.reservation_time);
        const day = String(reservationDate.getDate()).padStart(2, '0');
        const month = String(reservationDate.getMonth() + 1).padStart(2, '0');
        const year = reservationDate.getFullYear();
        const hours = String(reservationDate.getHours()).padStart(2, '0');
        const minutes = String(reservationDate.getMinutes()).padStart(2, '0');

        const formattedDate = `${day}/${month}/${year}`;
        const formattedTime = `${hours}:${minutes}`;

        // Send WhatsApp confirmation
        await sendVonageWhatsApp(
            reservation.phone,
            `La prenotazione per ${formattedDate} ${formattedTime} e' confermata. A presto!`
        );

        console.log(`[WhatsApp] ✅ Confirmation sent for reservation ${id} to ${reservation.phone}`);

        res.json({ success: true, message: 'Confirmation sent via WhatsApp' });
    } catch (err) {
        console.error('Error sending WhatsApp confirmation:', err);
        res.status(500).json({ error: 'Failed to send confirmation' });
    }
});


// Tables - require authentication
app.get('/tables', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tables ORDER BY name');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/tables', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { name, shape, seats, x, y, room_id, status } = req.body;
        const result = await pool.query(
            'INSERT INTO tables (name, shape, seats, x, y, room_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [name, shape, seats, x, y, room_id, status]
        );
        const newTable = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.TABLE,
                newTable.id,
                name,
                { shape, seats, room_id }
            );
        }

        // Broadcast to all connected clients except the one who created it
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastTableCreated(newTable, socketId);

        res.status(201).json(newTable);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/tables/:id', authenticate, requirePermission('floorplan:update_status'), async (req, res) => {
    try {
        const { id } = req.params;

        console.log('PUT /tables/:id - Request body:', JSON.stringify(req.body, null, 2));

        // Build dynamic update query based on provided fields
        const fields: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        const allowedFields = ['name', 'shape', 'seats', 'x', 'y', 'room_id', 'status', 'is_locked', 'merged_with', 'temp_lock_expires_at'];

        allowedFields.forEach(field => {
            if (req.body.hasOwnProperty(field)) {
                fields.push(`${field} = $${paramIndex}`);

                // Special handling for merged_with - ensure it's null if undefined/empty
                if (field === 'merged_with') {
                    const mergedWith = req.body[field];
                    values.push(mergedWith && Array.isArray(mergedWith) && mergedWith.length > 0 ? mergedWith : null);
                    console.log('Setting merged_with to:', values[values.length - 1]);
                } else {
                    values.push(req.body[field]);
                }

                paramIndex++;
            }
        });

        if (fields.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        values.push(id);
        const query = `UPDATE tables SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

        console.log('SQL Query:', query);
        console.log('Values:', values);

        const result = await pool.query(query, values);
        const updatedTable = result.rows[0];

        console.log('Updated table merged_with:', updatedTable.merged_with);

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.TABLE,
                parseInt(id, 10),
                updatedTable.name,
                req.body
            );
        }

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastTableUpdated(updatedTable, socketId);

        res.json(updatedTable);
    } catch (err) {
        console.error('Error updating table:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/tables/:id', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { id } = req.params;

        // Get table name before deleting
        const existing = await pool.query('SELECT name FROM tables WHERE id = $1', [id]);
        const resourceName = existing.rows[0]?.name;

        await pool.query('DELETE FROM tables WHERE id = $1', [id]);

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.TABLE,
                parseInt(id, 10),
                resourceName
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastTableDeleted(Number(id));

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// Rooms - require authentication
app.get('/rooms', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM rooms ORDER BY name');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/rooms', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { name, width, height } = req.body;
        const result = await pool.query(
            'INSERT INTO rooms (name, width, height) VALUES ($1, $2, $3) RETURNING *',
            [name, width, height]
        );
        const newRoom = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.ROOM,
                newRoom.id,
                name,
                { width, height }
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastRoomCreated(newRoom);

        res.status(201).json(newRoom);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/rooms/:id', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { id } = req.params;

        // Get room name before deleting
        const existing = await pool.query('SELECT name FROM rooms WHERE id = $1', [id]);
        const resourceName = existing.rows[0]?.name;

        await pool.query('DELETE FROM rooms WHERE id = $1', [id]);

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.ROOM,
                parseInt(id, 10),
                resourceName
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastRoomDeleted(Number(id));

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// Dishes - require authentication
app.get('/dishes', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM dishes ORDER BY category, name');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/dishes', authenticate, requirePermission('menu:full'), async (req, res) => {
    try {
        const { name, description, price, category, allergens } = req.body;
        const result = await pool.query(
            'INSERT INTO dishes (name, description, price, category, allergens) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [name, description, price, category, allergens]
        );
        const newDish = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.DISH,
                newDish.id,
                name,
                { price, category }
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastDishCreated(newDish);

        res.status(201).json(newDish);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/dishes/:id', authenticate, requirePermission('menu:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, price, category, allergens } = req.body;
        const result = await pool.query(
            'UPDATE dishes SET name = $1, description = $2, price = $3, category = $4, allergens = $5 WHERE id = $6 RETURNING *',
            [name, description, price, category, allergens, id]
        );
        const updatedDish = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.DISH,
                parseInt(id, 10),
                name,
                { price, category }
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastDishUpdated(updatedDish);

        res.json(updatedDish);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/dishes/:id', authenticate, requirePermission('menu:full'), async (req, res) => {
    try {
        const { id } = req.params;

        // Get dish name before deleting
        const existing = await pool.query('SELECT name FROM dishes WHERE id = $1', [id]);
        const resourceName = existing.rows[0]?.name;

        await pool.query('DELETE FROM dishes WHERE id = $1', [id]);

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.DISH,
                parseInt(id, 10),
                resourceName
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastDishDeleted(Number(id));

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// Banquet Menus - require authentication
app.get('/banquet-menus', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM banquet_menus ORDER BY name');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/banquet-menus', authenticate, requirePermission('menu:full'), async (req, res) => {
    try {
        const { name, description, price_per_person, dish_ids } = req.body;
        const result = await pool.query(
            'INSERT INTO banquet_menus (name, description, price_per_person, dish_ids) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, description, price_per_person, dish_ids]
        );
        const newMenu = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.BANQUET_MENU,
                newMenu.id,
                name,
                { price_per_person, dish_count: dish_ids?.length || 0 }
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastBanquetCreated(newMenu);

        res.status(201).json(newMenu);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/banquet-menus/:id', authenticate, requirePermission('menu:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, price_per_person, dish_ids } = req.body;
        const result = await pool.query(
            'UPDATE banquet_menus SET name = $1, description = $2, price_per_person = $3, dish_ids = $4 WHERE id = $5 RETURNING *',
            [name, description, price_per_person, dish_ids, id]
        );
        const updatedMenu = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.BANQUET_MENU,
                parseInt(id, 10),
                name,
                { price_per_person, dish_count: dish_ids?.length || 0 }
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastBanquetUpdated(updatedMenu);

        res.json(updatedMenu);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/banquet-menus/:id', authenticate, requirePermission('menu:full'), async (req, res) => {
    try {
        const { id } = req.params;

        // Get menu name before deleting
        const existing = await pool.query('SELECT name FROM banquet_menus WHERE id = $1', [id]);
        const resourceName = existing.rows[0]?.name;

        await pool.query('DELETE FROM banquet_menus WHERE id = $1', [id]);

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.BANQUET_MENU,
                parseInt(id, 10),
                resourceName
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastBanquetDeleted(Number(id));

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// TODOS - require authentication
// ============================================
app.get('/todos', authenticate, async (req, res) => {
    try {
        const { date } = req.query;
        let query = `
            SELECT
                id,
                title,
                description,
                completed,
                priority,
                category,
                TO_CHAR(due_date, 'YYYY-MM-DD') as "dueDate",
                created_at as "createdAt",
                completed_at as "completedAt",
                linked_reservation_id as "linkedReservationId",
                assigned_to_user_id as "assignedToUserId",
                assigned_to_user_name as "assignedToUserName",
                assigned_to_team as "assignedToTeam",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
            FROM todos
        `;
        const params: string[] = [];

        if (date) {
            query += ' WHERE due_date = $1';
            params.push(date as string);
        }

        query += ' ORDER BY created_at DESC';

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/todos/my', authenticate, async (req, res) => {
    try {
        const userId = req.user?.userId;
        const userRole = req.user?.role;

        const result = await pool.query(`
            SELECT
                id,
                title,
                description,
                completed,
                priority,
                category,
                TO_CHAR(due_date, 'YYYY-MM-DD') as "dueDate",
                created_at as "createdAt",
                completed_at as "completedAt",
                linked_reservation_id as "linkedReservationId",
                assigned_to_user_id as "assignedToUserId",
                assigned_to_user_name as "assignedToUserName",
                assigned_to_team as "assignedToTeam",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
            FROM todos
            WHERE (assigned_to_user_id = $1 OR assigned_to_team = $2)
              AND completed = false
            ORDER BY
                CASE priority
                    WHEN 'HIGH' THEN 1
                    WHEN 'MEDIUM' THEN 2
                    WHEN 'LOW' THEN 3
                END,
                due_date ASC NULLS LAST,
                created_at DESC
        `, [userId, userRole]);

        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/todos', authenticate, async (req, res) => {
    try {
        const {
            title,
            description,
            priority,
            category,
            dueDate,
            assignedToUserId,
            assignedToUserName,
            assignedToTeam,
            linkedReservationId
        } = req.body;

        const result = await pool.query(`
            INSERT INTO todos (
                title, description, priority, category, due_date,
                assigned_to_user_id, assigned_to_user_name, assigned_to_team,
                linked_reservation_id, created_by_user_id, created_by_user_name
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING
                id,
                title,
                description,
                completed,
                priority,
                category,
                TO_CHAR(due_date, 'YYYY-MM-DD') as "dueDate",
                created_at as "createdAt",
                completed_at as "completedAt",
                linked_reservation_id as "linkedReservationId",
                assigned_to_user_id as "assignedToUserId",
                assigned_to_user_name as "assignedToUserName",
                assigned_to_team as "assignedToTeam",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
        `, [
            title,
            description || null,
            priority || 'MEDIUM',
            category || 'GENERAL',
            dueDate || null,
            assignedToUserId || null,
            assignedToUserName || null,
            assignedToTeam || null,
            linkedReservationId || null,
            req.user?.userId || null,
            req.user?.email || null
        ]);

        const newTodo = result.rows[0];

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        console.log('📝 Broadcasting todo:created', { todoId: newTodo.id, socketService: !!socketService });
        if (socketService) {
            socketService.broadcastToAll('todo:created', newTodo, socketId);
        } else {
            console.error('📝 socketService is undefined, cannot broadcast!');
        }

        res.status(201).json(newTodo);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/todos/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            title,
            description,
            priority,
            category,
            dueDate,
            completed,
            assignedToUserId,
            assignedToUserName,
            assignedToTeam
        } = req.body;

        // Build dynamic update query
        const fields: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        const fieldMappings: Record<string, { dbField: string; value: any }> = {
            title: { dbField: 'title', value: title },
            description: { dbField: 'description', value: description },
            priority: { dbField: 'priority', value: priority },
            category: { dbField: 'category', value: category },
            dueDate: { dbField: 'due_date', value: dueDate },
            completed: { dbField: 'completed', value: completed },
            assignedToUserId: { dbField: 'assigned_to_user_id', value: assignedToUserId },
            assignedToUserName: { dbField: 'assigned_to_user_name', value: assignedToUserName },
            assignedToTeam: { dbField: 'assigned_to_team', value: assignedToTeam },
        };

        for (const [key, mapping] of Object.entries(fieldMappings)) {
            if (req.body.hasOwnProperty(key)) {
                fields.push(`${mapping.dbField} = $${paramIndex}`);
                values.push(mapping.value ?? null);
                paramIndex++;
            }
        }

        // Handle completed_at based on completed status
        if (req.body.hasOwnProperty('completed')) {
            if (completed) {
                fields.push(`completed_at = CURRENT_TIMESTAMP`);
            } else {
                fields.push(`completed_at = NULL`);
            }
        }

        if (fields.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        values.push(id);
        const query = `
            UPDATE todos
            SET ${fields.join(', ')}
            WHERE id = $${paramIndex}
            RETURNING
                id,
                title,
                description,
                completed,
                priority,
                category,
                TO_CHAR(due_date, 'YYYY-MM-DD') as "dueDate",
                created_at as "createdAt",
                completed_at as "completedAt",
                linked_reservation_id as "linkedReservationId",
                assigned_to_user_id as "assignedToUserId",
                assigned_to_user_name as "assignedToUserName",
                assigned_to_team as "assignedToTeam",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
        `;

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Todo not found' });
        }

        const updatedTodo = result.rows[0];

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('todo:updated', updatedTodo, socketId);

        res.json(updatedTodo);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/todos/:id/toggle', authenticate, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
            UPDATE todos
            SET
                completed = NOT completed,
                completed_at = CASE
                    WHEN NOT completed THEN CURRENT_TIMESTAMP
                    ELSE NULL
                END
            WHERE id = $1
            RETURNING
                id,
                title,
                description,
                completed,
                priority,
                category,
                TO_CHAR(due_date, 'YYYY-MM-DD') as "dueDate",
                created_at as "createdAt",
                completed_at as "completedAt",
                linked_reservation_id as "linkedReservationId",
                assigned_to_user_id as "assignedToUserId",
                assigned_to_user_name as "assignedToUserName",
                assigned_to_team as "assignedToTeam",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Todo not found' });
        }

        const updatedTodo = result.rows[0];

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('todo:updated', updatedTodo, socketId);

        res.json(updatedTodo);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/todos/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query('DELETE FROM todos WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Todo not found' });
        }

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('todo:deleted', { id }, socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// SHOPPING LIST - require authentication
// ============================================
app.get('/shopping', authenticate, async (req, res) => {
    try {
        const { date } = req.query;

        if (!date) {
            return res.status(400).json({ error: 'Date parameter is required' });
        }

        const result = await pool.query(`
            SELECT
                id,
                name,
                category,
                checked,
                TO_CHAR(date, 'YYYY-MM-DD') as date,
                created_at as "createdAt",
                created_by_user_id as "createdByUserId"
            FROM shopping_items
            WHERE date = $1
            ORDER BY
                CASE category
                    WHEN 'CUCINA' THEN 1
                    WHEN 'BAR' THEN 2
                    WHEN 'ALTRO' THEN 3
                END,
                created_at ASC
        `, [date]);

        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/shopping', authenticate, async (req, res) => {
    try {
        const { name, category, date } = req.body;

        if (!name || !date) {
            return res.status(400).json({ error: 'Name and date are required' });
        }

        const result = await pool.query(`
            INSERT INTO shopping_items (name, category, date, created_by_user_id)
            VALUES ($1, $2, $3, $4)
            RETURNING
                id,
                name,
                category,
                checked,
                TO_CHAR(date, 'YYYY-MM-DD') as date,
                created_at as "createdAt",
                created_by_user_id as "createdByUserId"
        `, [name, category || 'ALTRO', date, req.user?.userId || null]);

        const newItem = result.rows[0];

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        console.log('🛒 Broadcasting shopping:created', { itemId: newItem.id, socketService: !!socketService, excludeSocketId: socketId });
        if (socketService) {
            socketService.broadcastToAll('shopping:created', newItem, socketId);
            console.log('🛒 Broadcast sent successfully');
        } else {
            console.error('🛒 socketService is undefined, cannot broadcast!');
        }

        res.status(201).json(newItem);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/shopping/:id/toggle', authenticate, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
            UPDATE shopping_items
            SET checked = NOT checked
            WHERE id = $1
            RETURNING
                id,
                name,
                category,
                checked,
                TO_CHAR(date, 'YYYY-MM-DD') as date,
                created_at as "createdAt",
                created_by_user_id as "createdByUserId"
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

        const updatedItem = result.rows[0];

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('shopping:updated', updatedItem, socketId);

        res.json(updatedItem);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/shopping/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query('DELETE FROM shopping_items WHERE id = $1 RETURNING id, TO_CHAR(date, \'YYYY-MM-DD\') as date', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('shopping:deleted', { id, date: result.rows[0].date }, socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/shopping/clear-checked', authenticate, async (req, res) => {
    try {
        const { date } = req.query;

        if (!date) {
            return res.status(400).json({ error: 'Date parameter is required' });
        }

        await pool.query('DELETE FROM shopping_items WHERE date = $1 AND checked = true', [date]);

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('shopping:cleared', { date }, socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// WHATSAPP HELPER FUNCTIONS
// ============================================

// Process WhatsApp booking message
async function processWhatsAppBooking(phoneNumber: string, messageText: string) {
    console.log(`[WhatsApp] Processing booking from ${phoneNumber}: ${messageText}`);

    // Parse the message
    const bookingData = parseBookingMessage(messageText);

    if (!bookingData) {
        await sendVonageWhatsApp(phoneNumber,
            "❌ Non ho capito il messaggio. Per favore usa questo formato:\n\n" +
            "DATA ORA OSPITI NOME\n\n" +
            "Esempio: 15/12 20:00 4 Marco Rossi"
        );
        return;
    }

    // Check if we have all required info
    const missingFields = [];
    if (!bookingData.date) missingFields.push("data");
    if (!bookingData.time) missingFields.push("ora");
    if (!bookingData.guests) missingFields.push("numero ospiti");
    if (!bookingData.name) missingFields.push("nome");

    if (missingFields.length > 0) {
        await sendVonageWhatsApp(phoneNumber,
            `⚠️ Mancano alcune informazioni: ${missingFields.join(", ")}\n\n` +
            "Per favore invia: DATA ORA OSPITI NOME\n\n" +
            "Esempio: 15/12 20:00 4 Marco Rossi"
        );
        return;
    }

    try {
        // TypeScript assertions - we've already validated these fields exist
        const date = bookingData.date!;
        const time = bookingData.time!;
        const name = bookingData.name!;
        const guests = bookingData.guests!;

        // Send immediate acknowledgment
        await sendVonageWhatsApp(phoneNumber,
            "Grazie per la richiesta di prenotazione, a breve ricevera la conferma della disponibilita del tavolo per la data e ora richiesta."
        );

        // Determine shift based on time
        const shift = determineShift(time);

        // Create reservation in database
        const result = await pool.query(
            'INSERT INTO reservations (customer_name, reservation_time, shift, guests, phone, payment_status, arrival_status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [
                name,
                `${date}T${time}`,
                shift,
                guests,
                phoneNumber,
                PaymentStatus.PENDING,
                'WAITING'
            ]
        );

        const newReservation = result.rows[0];

        // Broadcast via Socket.IO
        if (socketService) {
            socketService.broadcastReservationCreated(newReservation);
        }

        console.log(`[WhatsApp] ✅ Reservation created successfully for ${name}. Waiting for manual confirmation.`);

    } catch (error) {
        console.error('[WhatsApp] Error creating reservation:', error);
        await sendVonageWhatsApp(phoneNumber,
            "❌ Si è verificato un errore durante la creazione della prenotazione.\n\n" +
            "Per favore riprova o contattaci telefonicamente."
        );
    }
}

// Parse booking message (supports both structured and natural language)
function parseBookingMessage(text: string): { date: string | null, time: string | null, guests: number | null, name: string | null } | null {
    if (!text || text.trim().length === 0) return null;

    // Try structured format first: "15/12 20:00 4 Marco Rossi"
    const structuredMatch = text.match(/(\d{1,2}\/\d{1,2}(?:\/\d{4})?)\s+(\d{1,2}:\d{2})\s+(\d+)\s+(.+)/i);
    if (structuredMatch) {
        return {
            date: normalizeDate(structuredMatch[1]),
            time: structuredMatch[2],
            guests: parseInt(structuredMatch[3]),
            name: structuredMatch[4].trim()
        };
    }

    // Try natural language patterns
    const dateMatch = text.match(/(\d{1,2}\/\d{1,2}(?:\/\d{4})?)/);
    const timeMatch = text.match(/(\d{1,2}:\d{2})/);
    const guestsMatch = text.match(/(\d+)\s*(?:persone?|ospiti?|pax)/i);
    const nameMatch = text.match(/(?:nome[:\s]+|per\s+)([A-Za-zÀ-ÿ\s]+?)(?:\s+tel|\s+\d|$)/i);

    if (dateMatch || timeMatch || guestsMatch || nameMatch) {
        return {
            date: dateMatch ? normalizeDate(dateMatch[1]) : null,
            time: timeMatch ? timeMatch[1] : null,
            guests: guestsMatch ? parseInt(guestsMatch[1]) : null,
            name: nameMatch ? nameMatch[1].trim() : null
        };
    }

    return null;
}

// Normalize date to YYYY-MM-DD format
function normalizeDate(dateStr: string): string {
    const parts = dateStr.split('/');
    const day = parts[0].padStart(2, '0');
    const month = parts[1].padStart(2, '0');
    const year = parts[2] || new Date().getFullYear().toString();
    return `${year}-${month}-${day}`;
}

// Determine shift (LUNCH or DINNER) based on time
function determineShift(time: string): Shift {
    const hour = parseInt(time.split(':')[0]);
    return (hour >= 11 && hour < 17) ? Shift.LUNCH : Shift.DINNER;
}

// Send WhatsApp message via Vonage API
async function sendVonageWhatsApp(to: string, text: string): Promise<void> {
    const VONAGE_API_KEY = process.env.VONAGE_API_KEY;
    const VONAGE_API_SECRET = process.env.VONAGE_API_SECRET;
    const VONAGE_WHATSAPP_NUMBER = process.env.VONAGE_WHATSAPP_NUMBER;

    if (!VONAGE_API_KEY || !VONAGE_API_SECRET || !VONAGE_WHATSAPP_NUMBER) {
        console.error('[Vonage] Missing configuration. Set VONAGE_API_KEY, VONAGE_API_SECRET, and VONAGE_WHATSAPP_NUMBER');
        return;
    }

    // Ensure phone number is in E.164 format (with + prefix)
    const formattedTo = to.startsWith('+') ? to : `+${to}`;
    const formattedFrom = VONAGE_WHATSAPP_NUMBER.startsWith('+') ? VONAGE_WHATSAPP_NUMBER : `+${VONAGE_WHATSAPP_NUMBER}`;

    console.log(`[Vonage] Sending message to ${formattedTo} from ${formattedFrom}`);

    try {
        const auth = Buffer.from(`${VONAGE_API_KEY}:${VONAGE_API_SECRET}`).toString('base64');

        const response = await fetch('https://messages-sandbox.nexmo.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`
            },
            body: JSON.stringify({
                from: formattedFrom,
                to: formattedTo,
                message_type: 'text',
                text: text,
                channel: 'whatsapp'
            })
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Vonage API error: ${response.status} - ${errorBody}`);
        }

        const result = await response.json();
        console.log(`[Vonage] ✅ Message sent to ${to}`, result);

    } catch (error) {
        console.error('[Vonage] ❌ Error sending message:', error);
        throw error;
    }
}


const startServer = async () => {
    try {
        // Start HTTP server
        const portNumber = Number(port);
        console.log(`Starting server on port ${portNumber}...`);

        httpServer.listen(portNumber, '0.0.0.0', () => {
            console.log(`✅ Server listening on port ${portNumber}`);

            // Initialize Socket.IO
            try {
                socketService = new SocketService(httpServer);
                console.log('✅ Socket.IO initialized');
            } catch (socketError) {
                console.error('Socket.IO initialization failed:', socketError);
            }

            // Initialize database schema in background
            createSchema()
                .then(() => console.log('✅ Database schema initialized'))
                .catch((dbError) => {
                    console.error('Database initialization failed:', dbError);
                    console.error('Server will continue running, but database operations may fail');
                });
        }).on('error', (error) => {
            console.error('❌ Failed to start server:', error);
            process.exit(1);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

startServer();