import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import pool, { createSchema } from './db.js';
import { SocketService } from './services/socketService.js';

const app = express();
const port = process.env.PORT || 3000;

console.log('🔍 Environment check:');
console.log('  - NODE_ENV:', process.env.NODE_ENV);
console.log('  - PORT from env:', process.env.PORT);
console.log('  - Using port:', port);

// Create HTTP server from Express app
const httpServer = createServer(app);

// Add connection and error logging to HTTP server
httpServer.on('connection', (socket) => {
  console.log('📥 New connection established');
});

httpServer.on('clientError', (err, socket) => {
  console.error('❌ Client error:', err.message);
});

// Socket service instance (initialized in startServer)
let socketService: SocketService | undefined;

// Flexible CORS configuration - temporarily allow all for debugging
const corsOptions = {
  origin: true,  // Allow all origins temporarily
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Request logging middleware for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - Origin: ${req.get('origin') || 'none'}`);
  next();
});

// Health check endpoint for Railway
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'RistoManager API is running' });
});

app.get('/health', (req, res) => {
  console.log('[HEALTH] Health check endpoint called');
  try {
    const response = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      server: 'running',
      socketio: socketService ? 'initialized' : 'disabled for testing'
    };
    console.log('[HEALTH] Sending response:', JSON.stringify(response));
    res.status(200).json(response);
    console.log('[HEALTH] Response sent successfully');
  } catch (error) {
    console.error('[HEALTH] Error in health endpoint:', error);
    res.status(500).json({ error: 'Health check failed' });
  }
});

// Reservations
app.get('/reservations', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM reservations ORDER BY reservation_time DESC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/reservations', async (req, res) => {
    try {
        const { customer_name, reservation_time, shift, guests, table_id, notes, email, phone, payment_status } = req.body;
        const result = await pool.query(
            'INSERT INTO reservations (customer_name, reservation_time, shift, guests, table_id, notes, email, phone, payment_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
            [customer_name, reservation_time, shift, guests, table_id, notes, email, phone, payment_status]
        );
        const newReservation = result.rows[0];

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastReservationCreated(newReservation);

        res.status(201).json(newReservation);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/reservations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { customer_name, reservation_time, shift, guests, table_id, notes, email, phone, payment_status } = req.body;
        const result = await pool.query(
            'UPDATE reservations SET customer_name = $1, reservation_time = $2, shift = $3, guests = $4, table_id = $5, notes = $6, email = $7, phone = $8, payment_status = $9 WHERE id = $10 RETURNING *',
            [customer_name, reservation_time, shift, guests, table_id, notes, email, phone, payment_status, id]
        );
        const updatedReservation = result.rows[0];

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastReservationUpdated(updatedReservation);

        res.json(updatedReservation);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/reservations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM reservations WHERE id = $1', [id]);

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastReservationDeleted(Number(id));

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// Tables
app.get('/tables', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tables ORDER BY name');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/tables', async (req, res) => {
    try {
        const { name, shape, seats, x, y, room_id, status } = req.body;
        const result = await pool.query(
            'INSERT INTO tables (name, shape, seats, x, y, room_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [name, shape, seats, x, y, room_id, status]
        );
        const newTable = result.rows[0];

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastTableCreated(newTable);

        res.status(201).json(newTable);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/tables/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, shape, seats, x, y, room_id, status } = req.body;
        const result = await pool.query(
            'UPDATE tables SET name = $1, shape = $2, seats = $3, x = $4, y = $5, room_id = $6, status = $7 WHERE id = $8 RETURNING *',
            [name, shape, seats, x, y, room_id, status, id]
        );
        const updatedTable = result.rows[0];

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastTableUpdated(updatedTable);

        res.json(updatedTable);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/tables/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM tables WHERE id = $1', [id]);

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastTableDeleted(Number(id));

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// Rooms
app.get('/rooms', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM rooms ORDER BY name');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/rooms', async (req, res) => {
    try {
        const { name, width, height } = req.body;
        const result = await pool.query(
            'INSERT INTO rooms (name, width, height) VALUES ($1, $2, $3) RETURNING *',
            [name, width, height]
        );
        const newRoom = result.rows[0];

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastRoomCreated(newRoom);

        res.status(201).json(newRoom);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/rooms/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM rooms WHERE id = $1', [id]);

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastRoomDeleted(Number(id));

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// Dishes
app.get('/dishes', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM dishes ORDER BY category, name');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/dishes', async (req, res) => {
    try {
        const { name, description, price, category, allergens } = req.body;
        const result = await pool.query(
            'INSERT INTO dishes (name, description, price, category, allergens) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [name, description, price, category, allergens]
        );
        const newDish = result.rows[0];

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastDishCreated(newDish);

        res.status(201).json(newDish);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/dishes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM dishes WHERE id = $1', [id]);

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastDishDeleted(Number(id));

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// Banquet Menus
app.get('/banquet-menus', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM banquet_menus ORDER BY name');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/banquet-menus', async (req, res) => {
    try {
        const { name, description, price_per_person, dish_ids } = req.body;
        const result = await pool.query(
            'INSERT INTO banquet_menus (name, description, price_per_person, dish_ids) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, description, price_per_person, dish_ids]
        );
        const newMenu = result.rows[0];

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastBanquetCreated(newMenu);

        res.status(201).json(newMenu);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/banquet-menus/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, price_per_person, dish_ids } = req.body;
        const result = await pool.query(
            'UPDATE banquet_menus SET name = $1, description = $2, price_per_person = $3, dish_ids = $4 WHERE id = $5 RETURNING *',
            [name, description, price_per_person, dish_ids, id]
        );
        const updatedMenu = result.rows[0];

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastBanquetUpdated(updatedMenu);

        res.json(updatedMenu);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/banquet-menus/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM banquet_menus WHERE id = $1', [id]);

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastBanquetDeleted(Number(id));

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


const startServer = async () => {
    try {
        // Start HTTP server FIRST to ensure it can accept connections
        const portNumber = Number(port);
        console.log(`Attempting to start server on port ${portNumber}...`);

        httpServer.listen(portNumber, '0.0.0.0', () => {
            const addr = httpServer.address();
            console.log(`✅ Server listening on port ${portNumber}`);
            console.log(`✅ Server address:`, addr);
            console.log(`✅ Server ready to accept connections`);

            // TEMPORARILY DISABLE Socket.IO for testing
            console.log('⚠️ Socket.IO disabled for testing');
            // try {
            //     socketService = new SocketService(httpServer);
            //     console.log('✅ Socket.IO initialized');
            // } catch (socketError) {
            //     console.error('Socket.IO initialization failed:', socketError);
            // }

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