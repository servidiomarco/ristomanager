import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import pool, { createSchema } from './db.js';
import { SocketService } from './services/socketService.js';

const app = express();
const port = process.env.PORT || 3000;

// Create HTTP server from Express app
const httpServer = createServer(app);

// Socket service instance (initialized in startServer)
let socketService: SocketService;

const allowedOrigins = [
  'http://localhost:5173',
  'https://ristomanager-production.up.railway.app',
  'https://ristomanager-phi.vercel.app',
  // Add your Vercel frontend URL here
  // e.g. 'https://your-vercel-app.vercel.app'
];

const corsOptions = {
  origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    if (allowedOrigins.indexOf(origin!) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
};

app.use(cors(corsOptions));
app.use(express.json());

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
        socketService.broadcastReservationCreated(newReservation);

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
        socketService.broadcastReservationUpdated(updatedReservation);

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
        socketService.broadcastReservationDeleted(Number(id));

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
        socketService.broadcastTableCreated(newTable);

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
        socketService.broadcastTableUpdated(updatedTable);

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
        socketService.broadcastTableDeleted(Number(id));

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
        socketService.broadcastRoomCreated(newRoom);

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
        socketService.broadcastRoomDeleted(Number(id));

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
        socketService.broadcastDishCreated(newDish);

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
        socketService.broadcastDishDeleted(Number(id));

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
        socketService.broadcastBanquetCreated(newMenu);

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
        socketService.broadcastBanquetUpdated(updatedMenu);

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
        socketService.broadcastBanquetDeleted(Number(id));

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


const startServer = async () => {
    try {
        await createSchema();

        // Initialize Socket.IO
        socketService = new SocketService(httpServer);
        console.log('Socket.IO initialized');

        httpServer.listen(port, () => {
            console.log(`Server with WebSocket support listening at http://localhost:${port}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

startServer();