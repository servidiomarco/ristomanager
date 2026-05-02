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
        const { name, shape, seats, x, y, room_id, status, rotation } = req.body;
        const result = await pool.query(
            'INSERT INTO tables (name, shape, seats, x, y, room_id, status, rotation) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [name, shape, seats, x, y, room_id, status, rotation || 0]
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

        const allowedFields = ['name', 'shape', 'seats', 'x', 'y', 'room_id', 'status', 'is_locked', 'merged_with', 'temp_lock_expires_at', 'rotation'];

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


// ============================================
// PER-SHIFT TABLE MERGES
// ============================================

// GET /table-merges?date=YYYY-MM-DD&shift=LUNCH|DINNER
app.get('/table-merges', authenticate, async (req, res) => {
    try {
        const { date, shift } = req.query;
        if (!date || !shift) {
            return res.status(400).json({ error: 'date and shift query params are required' });
        }
        if (shift !== 'LUNCH' && shift !== 'DINNER') {
            return res.status(400).json({ error: 'shift must be LUNCH or DINNER' });
        }
        const result = await pool.query(
            'SELECT id, date, shift, primary_id, merged_ids FROM table_merges WHERE date = $1 AND shift = $2',
            [date, shift]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching table merges:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /table-merges  body: { date, shift, primary_id, merged_ids }
// Idempotent — replaces an existing merge for the same (date, shift, primary_id).
app.post('/table-merges', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { date, shift, primary_id, merged_ids } = req.body;
        if (!date || !shift || primary_id == null || !Array.isArray(merged_ids) || merged_ids.length === 0) {
            return res.status(400).json({ error: 'date, shift, primary_id and non-empty merged_ids are required' });
        }
        if (shift !== 'LUNCH' && shift !== 'DINNER') {
            return res.status(400).json({ error: 'shift must be LUNCH or DINNER' });
        }
        const result = await pool.query(
            `INSERT INTO table_merges (date, shift, primary_id, merged_ids)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (date, shift, primary_id)
             DO UPDATE SET merged_ids = EXCLUDED.merged_ids
             RETURNING id, date, shift, primary_id, merged_ids`,
            [date, shift, primary_id, merged_ids]
        );
        const merge = result.rows[0];

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.TABLE,
                primary_id,
                `Merge ${date} ${shift}`,
                { date, shift, merged_ids }
            );
        }

        // Broadcast to ALL clients (including originator) so the originating
        // client's local merge state updates from the socket event without
        // needing an extra refetch. The client listener upserts idempotently.
        if (socketService) socketService.broadcastTableMergeCreated(merge);

        res.status(201).json(merge);
    } catch (err) {
        console.error('Error creating table merge:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /table-merges  body: { date, shift, primary_id }
app.delete('/table-merges', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { date, shift, primary_id } = req.body;
        if (!date || !shift || primary_id == null) {
            return res.status(400).json({ error: 'date, shift and primary_id are required' });
        }
        const result = await pool.query(
            `DELETE FROM table_merges
             WHERE date = $1 AND shift = $2 AND primary_id = $3
             RETURNING id, date, shift, primary_id, merged_ids`,
            [date, shift, primary_id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Merge not found' });
        }
        const deleted = result.rows[0];

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.TABLE,
                primary_id,
                `Unmerge ${date} ${shift}`,
                { date, shift }
            );
        }

        if (socketService) socketService.broadcastTableMergeDeleted(deleted);

        res.json(deleted);
    } catch (err) {
        console.error('Error deleting table merge:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// Rooms - require authentication
app.get('/rooms', authenticate, async (req, res) => {
    try {
        // Custom display order: Veranda, Macine, Fiume, Fuori, Tettoia, Pergolato.
        // Names not in the list fall to the end, alphabetically.
        const result = await pool.query(`
            SELECT * FROM rooms
            ORDER BY
                CASE LOWER(TRIM(name))
                    WHEN 'veranda'   THEN 1
                    WHEN 'macine'    THEN 2
                    WHEN 'fiume'     THEN 3
                    WHEN 'fuori'     THEN 4
                    WHEN 'tettoia'   THEN 5
                    WHEN 'pergolato' THEN 6
                    ELSE 99
                END,
                name
        `);
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
        const { name, description, price, category, allergens, photo_url } = req.body;
        const result = await pool.query(
            'INSERT INTO dishes (name, description, price, category, allergens, photo_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [name, description, price, category, allergens, photo_url || null]
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
        const { name, description, price, category, allergens, photo_url } = req.body;
        const result = await pool.query(
            'UPDATE dishes SET name = $1, description = $2, price = $3, category = $4, allergens = $5, photo_url = $6 WHERE id = $7 RETURNING *',
            [name, description, price, category, allergens, photo_url || null, id]
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
        const result = await pool.query(
            "SELECT id, name, description, price_per_person, dish_ids, courses, TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date, deposit_amount FROM banquet_menus ORDER BY event_date NULLS LAST, name"
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/banquet-menus', authenticate, requirePermission('menu:full'), async (req, res) => {
    try {
        const { name, description, price_per_person, dish_ids, courses, event_date, deposit_amount } = req.body;
        if (!event_date) {
            return res.status(400).json({ error: 'event_date is required' });
        }
        // Derive flat dish_ids from courses if courses provided, else use the supplied flat list
        const flatDishIds: number[] = Array.isArray(courses) && courses.length > 0
            ? courses.flatMap((c: any) => Array.isArray(c.dish_ids) ? c.dish_ids : [])
            : (Array.isArray(dish_ids) ? dish_ids : []);
        const coursesJson = Array.isArray(courses) ? JSON.stringify(courses) : null;
        const result = await pool.query(
            "INSERT INTO banquet_menus (name, description, price_per_person, dish_ids, courses, event_date, deposit_amount) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id, name, description, price_per_person, dish_ids, courses, TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date, deposit_amount",
            [name, description, price_per_person, flatDishIds, coursesJson, event_date, deposit_amount ?? null]
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
                { price_per_person, dish_count: flatDishIds.length }
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
        const { name, description, price_per_person, dish_ids, courses, event_date, deposit_amount } = req.body;
        if (!event_date) {
            return res.status(400).json({ error: 'event_date is required' });
        }
        const flatDishIds: number[] = Array.isArray(courses) && courses.length > 0
            ? courses.flatMap((c: any) => Array.isArray(c.dish_ids) ? c.dish_ids : [])
            : (Array.isArray(dish_ids) ? dish_ids : []);
        const coursesJson = Array.isArray(courses) ? JSON.stringify(courses) : null;
        const result = await pool.query(
            "UPDATE banquet_menus SET name = $1, description = $2, price_per_person = $3, dish_ids = $4, courses = $5::jsonb, event_date = $6, deposit_amount = $7 WHERE id = $8 RETURNING id, name, description, price_per_person, dish_ids, courses, TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date, deposit_amount",
            [name, description, price_per_person, flatDishIds, coursesJson, event_date, deposit_amount ?? null, id]
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
                { price_per_person, dish_count: flatDishIds.length }
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
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
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

        console.log('🛒 POST /shopping - req.user:', req.user);

        if (!name || !date) {
            return res.status(400).json({ error: 'Name and date are required' });
        }

        const creatorEmail = req.user?.email || null;
        console.log('🛒 Creator email:', creatorEmail);

        const result = await pool.query(`
            INSERT INTO shopping_items (name, category, date, created_by_user_id, created_by_user_name)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING
                id,
                name,
                category,
                checked,
                TO_CHAR(date, 'YYYY-MM-DD') as date,
                created_at as "createdAt",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
        `, [name, category || 'ALTRO', date, req.user?.userId || null, creatorEmail]);

        console.log('🛒 Created item:', result.rows[0]);

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
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
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
// STAFF MANAGEMENT ROUTES
// ============================================

// Get all staff members
app.get('/staff', authenticate, async (req, res) => {
    try {
        const { category } = req.query;
        let query = 'SELECT * FROM staff_members';
        const params: any[] = [];

        if (category) {
            query += ' WHERE category = $1';
            params.push(category);
        }

        query += ' ORDER BY surname, name';

        const result = await pool.query(query, params);

        const staff = result.rows.map(row => ({
            id: row.id,
            name: row.name,
            surname: row.surname,
            category: row.category,
            staffType: row.staff_type,
            phone: row.phone,
            email: row.email,
            role: row.role,
            hireDate: row.hire_date,
            contractEndDate: row.contract_end_date,
            weeklyRestDay: row.weekly_rest_day,
            notes: row.notes,
            isActive: row.is_active,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));

        res.json(staff);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create staff member
app.post('/staff', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { name, surname, category, staffType, phone, email, role, hireDate, contractEndDate, weeklyRestDay, notes } = req.body;

        if (!name || !surname || !category || !staffType) {
            return res.status(400).json({ error: 'Name, surname, category, and staffType are required' });
        }

        const result = await pool.query(
            `INSERT INTO staff_members (name, surname, category, staff_type, phone, email, role, hire_date, contract_end_date, weekly_rest_day, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING *`,
            [name, surname, category, staffType, phone || null, email || null, role || null, hireDate || null, contractEndDate || null, weeklyRestDay ?? null, notes || null]
        );

        const row = result.rows[0];
        const staffMember = {
            id: row.id,
            name: row.name,
            surname: row.surname,
            category: row.category,
            staffType: row.staff_type,
            phone: row.phone,
            email: row.email,
            role: row.role,
            hireDate: row.hire_date,
            contractEndDate: row.contract_end_date,
            weeklyRestDay: row.weekly_rest_day,
            notes: row.notes,
            isActive: row.is_active,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('staff:created', staffMember, socketId);

        res.status(201).json(staffMember);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// STAFF SHIFTS ROUTES
// IMPORTANT: These specific paths must be defined BEFORE /staff/:id routes
// otherwise Express will match /staff/shifts as /staff/:id with id="shifts"
// ============================================

// Get shifts (optionally filtered by date and/or staffId)
app.get('/staff/shifts', authenticate, async (req, res) => {
    try {
        const { date, staffId, startDate, endDate } = req.query;
        let query = 'SELECT * FROM staff_shifts WHERE 1=1';
        const params: any[] = [];
        let paramCount = 0;

        if (date) {
            paramCount++;
            query += ` AND date = $${paramCount}`;
            params.push(date);
        }

        if (startDate && endDate) {
            paramCount++;
            query += ` AND date >= $${paramCount}`;
            params.push(startDate);
            paramCount++;
            query += ` AND date <= $${paramCount}`;
            params.push(endDate);
        }

        if (staffId) {
            paramCount++;
            query += ` AND staff_id = $${paramCount}`;
            params.push(staffId);
        }

        query += ' ORDER BY date, shift';

        const result = await pool.query(query, params);

        const shifts = result.rows.map(row => ({
            id: row.id,
            staffId: row.staff_id,
            date: row.date,
            shift: row.shift,
            present: row.present,
            notes: row.notes,
            createdAt: row.created_at
        }));

        res.json(shifts);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create shift
app.post('/staff/shifts', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { staffId, date, shift, present, notes } = req.body;

        if (!staffId || !date || !shift) {
            return res.status(400).json({ error: 'staffId, date, and shift are required' });
        }

        const result = await pool.query(
            `INSERT INTO staff_shifts (staff_id, date, shift, present, notes)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (staff_id, date, shift) DO UPDATE SET present = $4, notes = $5
             RETURNING *`,
            [staffId, date, shift, present !== false, notes || null]
        );

        const row = result.rows[0];
        const shiftData = {
            id: row.id,
            staffId: row.staff_id,
            date: row.date,
            shift: row.shift,
            present: row.present,
            notes: row.notes,
            createdAt: row.created_at
        };

        // Broadcast
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('shift:created', shiftData, socketId);

        res.status(201).json(shiftData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Bulk create shifts
app.post('/staff/shifts/bulk', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { shifts } = req.body;

        if (!Array.isArray(shifts) || shifts.length === 0) {
            return res.status(400).json({ error: 'shifts array is required' });
        }

        const createdShifts = [];
        for (const shift of shifts) {
            const result = await pool.query(
                `INSERT INTO staff_shifts (staff_id, date, shift, present, notes)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (staff_id, date, shift) DO UPDATE SET present = $4, notes = $5
                 RETURNING *`,
                [shift.staffId, shift.date, shift.shift, shift.present !== false, shift.notes || null]
            );
            const row = result.rows[0];
            createdShifts.push({
                id: row.id,
                staffId: row.staff_id,
                date: row.date,
                shift: row.shift,
                present: row.present,
                notes: row.notes,
                createdAt: row.created_at
            });
        }

        res.status(201).json(createdShifts);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update shift
app.put('/staff/shifts/:id', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { present, notes } = req.body;

        const result = await pool.query(
            `UPDATE staff_shifts SET
                present = COALESCE($1, present),
                notes = COALESCE($2, notes)
             WHERE id = $3
             RETURNING *`,
            [present, notes, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Shift not found' });
        }

        const row = result.rows[0];
        const shiftData = {
            id: row.id,
            staffId: row.staff_id,
            date: row.date,
            shift: row.shift,
            present: row.present,
            notes: row.notes,
            createdAt: row.created_at
        };

        // Broadcast
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('shift:updated', shiftData, socketId);

        res.json(shiftData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete shift
app.delete('/staff/shifts/:id', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM staff_shifts WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Shift not found' });
        }

        // Broadcast
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('shift:deleted', { id }, socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// STAFF TIME OFF ROUTES
// ============================================

// Get time off (optionally filtered by staffId and date range)
app.get('/staff/time-off', authenticate, async (req, res) => {
    try {
        const { staffId, startDate, endDate } = req.query;
        let query = 'SELECT * FROM staff_time_off WHERE 1=1';
        const params: any[] = [];
        let paramCount = 0;

        if (staffId) {
            paramCount++;
            query += ` AND staff_id = $${paramCount}`;
            params.push(staffId);
        }

        if (startDate && endDate) {
            paramCount++;
            query += ` AND start_date <= $${paramCount}`;
            params.push(endDate);
            paramCount++;
            query += ` AND end_date >= $${paramCount}`;
            params.push(startDate);
        }

        query += ' ORDER BY start_date DESC';

        const result = await pool.query(query, params);

        const timeOffs = result.rows.map(row => ({
            id: row.id,
            staffId: row.staff_id,
            startDate: row.start_date,
            endDate: row.end_date,
            type: row.type,
            notes: row.notes,
            approved: row.approved,
            createdAt: row.created_at
        }));

        res.json(timeOffs);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create time off
app.post('/staff/time-off', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { staffId, startDate, endDate, type, notes, approved } = req.body;

        if (!staffId || !startDate || !endDate || !type) {
            return res.status(400).json({ error: 'staffId, startDate, endDate, and type are required' });
        }

        const result = await pool.query(
            `INSERT INTO staff_time_off (staff_id, start_date, end_date, type, notes, approved)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [staffId, startDate, endDate, type, notes || null, approved !== false]
        );

        const row = result.rows[0];
        const timeOff = {
            id: row.id,
            staffId: row.staff_id,
            startDate: row.start_date,
            endDate: row.end_date,
            type: row.type,
            notes: row.notes,
            approved: row.approved,
            createdAt: row.created_at
        };

        // Broadcast
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('timeoff:created', timeOff, socketId);

        res.status(201).json(timeOff);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update time off
app.put('/staff/time-off/:id', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { startDate, endDate, type, notes, approved } = req.body;

        const result = await pool.query(
            `UPDATE staff_time_off SET
                start_date = COALESCE($1, start_date),
                end_date = COALESCE($2, end_date),
                type = COALESCE($3, type),
                notes = COALESCE($4, notes),
                approved = COALESCE($5, approved)
             WHERE id = $6
             RETURNING *`,
            [startDate, endDate, type, notes, approved, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Time off record not found' });
        }

        const row = result.rows[0];
        const timeOff = {
            id: row.id,
            staffId: row.staff_id,
            startDate: row.start_date,
            endDate: row.end_date,
            type: row.type,
            notes: row.notes,
            approved: row.approved,
            createdAt: row.created_at
        };

        // Broadcast
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('timeoff:updated', timeOff, socketId);

        res.json(timeOff);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete time off
app.delete('/staff/time-off/:id', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM staff_time_off WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Time off record not found' });
        }

        // Broadcast
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('timeoff:deleted', { id }, socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get staff presence for a specific date.
// FISSO staff are implicitly present on both shifts during their hire period
// unless covered by a time-off entry or an explicit shift with present=false.
app.get('/staff/presence', authenticate, async (req, res) => {
    try {
        const { date } = req.query;

        if (!date) {
            return res.status(400).json({ error: 'date is required' });
        }

        const dateStr = String(date);

        const [staffResult, shiftsResult, timeOffResult] = await Promise.all([
            pool.query('SELECT * FROM staff_members WHERE is_active = true ORDER BY category, surname, name'),
            pool.query('SELECT staff_id, shift, present FROM staff_shifts WHERE date = $1', [dateStr]),
            pool.query('SELECT staff_id FROM staff_time_off WHERE start_date <= $1 AND end_date >= $1', [dateStr])
        ]);

        const onTimeOff = new Set(timeOffResult.rows.map(r => r.staff_id));
        const explicitShifts = new Map<string, boolean>();
        for (const row of shiftsResult.rows) {
            explicitShifts.set(`${row.staff_id}-${row.shift}`, row.present);
        }

        const staffByShift = {
            sala: { lunch: [] as any[], dinner: [] as any[] },
            cucina: { lunch: [] as any[], dinner: [] as any[] }
        };

        // Day of week for the requested date (0=Sunday … 6=Saturday)
        const dayOfWeek = new Date(`${dateStr}T00:00:00`).getDay();

        for (const row of staffResult.rows) {
            if (onTimeOff.has(row.id)) continue;
            // Weekly rest day overrides implicit presence (explicit shifts can still override below)
            const isWeeklyRest = row.weekly_rest_day !== null && row.weekly_rest_day === dayOfWeek;

            const isFisso = row.staff_type === 'FISSO';
            // Open boundaries: no hire_date means "always active until contract end",
            // no contract_end_date means "no end". Without this, a FISSO added without
            // explicit dates would never appear in the presence list.
            const inHirePeriod = isFisso
                && !isWeeklyRest
                && (!row.hire_date || row.hire_date <= dateStr)
                && (!row.contract_end_date || row.contract_end_date >= dateStr);

            const staff = {
                id: row.id,
                name: row.name,
                surname: row.surname,
                category: row.category,
                staffType: row.staff_type,
                role: row.role
            };

            const categoryKey = row.category === 'SALA' ? 'sala' : 'cucina';

            for (const shift of ['LUNCH', 'DINNER'] as const) {
                const explicit = explicitShifts.get(`${row.id}-${shift}`);
                const present = explicit !== undefined ? explicit : inHirePeriod;
                if (present) {
                    const shiftKey = shift === 'LUNCH' ? 'lunch' : 'dinner';
                    staffByShift[categoryKey][shiftKey].push(staff);
                }
            }
        }

        res.json(staffByShift);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// STAFF MEMBER BY-ID ROUTES
// IMPORTANT: These parameterized routes must be defined AFTER all specific
// /staff/* paths (shifts, time-off, presence) to avoid route shadowing
// ============================================

// Get single staff member
app.get('/staff/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM staff_members WHERE id = $1', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff member not found' });
        }

        const row = result.rows[0];
        res.json({
            id: row.id,
            name: row.name,
            surname: row.surname,
            category: row.category,
            staffType: row.staff_type,
            phone: row.phone,
            email: row.email,
            role: row.role,
            hireDate: row.hire_date,
            contractEndDate: row.contract_end_date,
            weeklyRestDay: row.weekly_rest_day,
            notes: row.notes,
            isActive: row.is_active,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update staff member
app.put('/staff/:id', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, surname, category, staffType, phone, email, role, hireDate, contractEndDate, weeklyRestDay, notes, isActive } = req.body;

        // weeklyRestDay needs explicit handling so the client can clear it (null clears, undefined keeps)
        const result = await pool.query(
            `UPDATE staff_members SET
                name = COALESCE($1, name),
                surname = COALESCE($2, surname),
                category = COALESCE($3, category),
                staff_type = COALESCE($4, staff_type),
                phone = COALESCE($5, phone),
                email = COALESCE($6, email),
                role = COALESCE($7, role),
                hire_date = COALESCE($8, hire_date),
                contract_end_date = COALESCE($9, contract_end_date),
                weekly_rest_day = CASE WHEN $10::text = 'KEEP' THEN weekly_rest_day ELSE $11::smallint END,
                notes = COALESCE($12, notes),
                is_active = COALESCE($13, is_active),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $14
             RETURNING *`,
            [
                name, surname, category, staffType, phone, email, role, hireDate, contractEndDate,
                weeklyRestDay === undefined ? 'KEEP' : 'SET',
                weeklyRestDay === undefined ? null : weeklyRestDay,
                notes, isActive, id
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff member not found' });
        }

        const row = result.rows[0];
        const staffMember = {
            id: row.id,
            name: row.name,
            surname: row.surname,
            category: row.category,
            staffType: row.staff_type,
            phone: row.phone,
            email: row.email,
            role: row.role,
            hireDate: row.hire_date,
            contractEndDate: row.contract_end_date,
            weeklyRestDay: row.weekly_rest_day,
            notes: row.notes,
            isActive: row.is_active,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('staff:updated', staffMember, socketId);

        res.json(staffMember);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete staff member
app.delete('/staff/:id', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM staff_members WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff member not found' });
        }

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('staff:deleted', { id }, socketId);

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