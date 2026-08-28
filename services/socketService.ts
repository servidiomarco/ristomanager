import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import type { Reservation, Table, Room, Dish, BanquetMenu, UserRole, TableMerge, TableHiddenOverride, RoomClosedOverride } from '../types.js';
import { AuthService, TokenPayload } from '../auth/authService.js';
import { isAllowedOrigin } from './corsAllowlist.js';

// Extended socket type with user data
interface AuthenticatedSocket extends Socket {
  user?: TokenPayload;
}

export class SocketService {
  private io: SocketIOServer;

  constructor(httpServer: HTTPServer) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        // Fase D4 — stessa allowlist dell'API Express (corsAllowlist.ts):
        // localhost, deploy preview Vercel/Railway, domini di piattaforma e
        // domini custom dei tenant da tenant_domains. Prima era una lista
        // hardcoded del solo Frantoio: ogni tenant nuovo con dominio proprio
        // avrebbe caricato la SPA senza mai ricevere gli eventi real-time.
        origin: (origin, callback) => {
          isAllowedOrigin(origin)
            .then(allow => (allow ? callback(null, true) : callback(new Error('Not allowed by CORS'))))
            .catch(() => callback(new Error('Not allowed by CORS')));
        },
        methods: ['GET', 'POST'],
        credentials: true
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.setupAuthMiddleware();
    this.setupEventHandlers();
  }

  private setupAuthMiddleware() {
    // Socket.IO authentication middleware
    this.io.use((socket: AuthenticatedSocket, next) => {
      const token = socket.handshake.auth.token || socket.handshake.query.token;

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const payload = AuthService.verifyAccessToken(token as string);
      if (!payload) {
        return next(new Error('Invalid or expired token'));
      }

      // Attach user data to socket. Il tenant serve alla Fase B5 (room
      // per tenant); i token pre-B2 non hanno il claim → fallback 1.
      socket.user = {
        ...payload,
        tenantId: Number.isInteger(payload.tenantId) && payload.tenantId > 0 ? payload.tenantId : 1,
      };
      next();
    });
  }

  private setupEventHandlers() {
    this.io.on('connection', (socket: AuthenticatedSocket) => {
      console.log(`[${new Date().toISOString()}] Client connected: ${socket.id} (User: ${socket.user?.email}, Role: ${socket.user?.role}, Tenant: ${socket.user?.tenantId})`);

      // Fase B5: ogni socket vive nella stanza del proprio ristorante e i
      // broadcast di dominio partono SOLO verso quella stanza — senza questo
      // il ristorante A vedrebbe in tempo reale le prenotazioni di B.
      // tenantId è garantito dal middleware auth qui sopra (fallback 1).
      //
      // PLATFORM_ADMIN escluso (D2): sta sopra i tenant ma il suo utente ha
      // un tenant_id storico, e senza questa guardia il suo socket entrava
      // nella stanza di quel ristorante — campanella e toast "Nuova
      // prenotazione" del Frantoio mentre lavorava nel pannello SaaS. I dati
      // di un tenant li vede solo impersonando, con un token da OWNER che
      // entra nella stanza per la via normale.
      const tenantId = socket.user!.tenantId;
      if (String(socket.user!.role) !== 'PLATFORM_ADMIN') {
        socket.join(`tenant:${tenantId}`);
        // Chat staff: room per utente e per ruolo, join automatico — la
        // membership discende dal JWT, non è una scelta della UI (a
        // differenza di subscribe:station). Un DM non può passare da
        // broadcastToAll o lo leggerebbe tutto il tenant. Un cambio ruolo
        // diventa effettivo alla riconnessione, coerente con come il ruolo
        // vive nel token.
        socket.join(`tenant:${tenantId}:user:${socket.user!.userId}`);
        socket.join(`tenant:${tenantId}:role:${socket.user!.role}`);
      }

      socket.emit('connection:acknowledged', socket.id);

      // Room subscription for room-specific updates. La stanza è composta
      // col tenant: due sale con lo stesso id in ristoranti diversi non
      // devono condividere il canale.
      socket.on('subscribe:room', (roomId: number) => {
        socket.join(`tenant:${tenantId}:room:${roomId}`);
        console.log(`[${socket.id}] Subscribed to tenant:${tenantId}:room:${roomId}`);
      });

      socket.on('unsubscribe:room', (roomId: number) => {
        socket.leave(`tenant:${tenantId}:room:${roomId}`);
        console.log(`[${socket.id}] Unsubscribed from tenant:${tenantId}:room:${roomId}`);
      });

      // Monitor di cucina: ogni schermo ascolta solo la propria partita.
      // Con tre partite non è un'ottimizzazione ma una necessità — la
      // Griglia non deve ricevere il traffico degli Antipasti, altrimenti
      // il monitor diventa illeggibile proprio nel picco del servizio.
      // Anche qui la stanza è per-tenant (vedi subscribe:room).
      socket.on('subscribe:station', (stationId: number) => {
        socket.join(`tenant:${tenantId}:station:${stationId}`);
        console.log(`[${socket.id}] Subscribed to tenant:${tenantId}:station:${stationId}`);
      });

      socket.on('unsubscribe:station', (stationId: number) => {
        socket.leave(`tenant:${tenantId}:station:${stationId}`);
        console.log(`[${socket.id}] Unsubscribed from tenant:${tenantId}:station:${stationId}`);
      });

      socket.on('disconnect', () => {
        console.log(`[${new Date().toISOString()}] Client disconnected: ${socket.id}`);
      });
    });
  }

  // Fase B5: tutti i broadcast di dominio passano da qui — mai io.emit
  // globale, sempre la stanza del tenant.
  private tenantRoom(tenantId: number): string {
    return `tenant:${tenantId}`;
  }

  // Reservation broadcast methods - emit to ALL clients of the tenant,
  // sender INCLUDED (duplicate prevention on client side): the server-side
  // row is authoritative, so the originating client gets it back too.
  broadcastReservationCreated(tenantId: number, reservation: Reservation, _excludeSocketId?: string) {
    this.io.to(this.tenantRoom(tenantId)).emit('reservation:created', reservation);
    console.log(`Broadcasting reservation:created for ${reservation.customer_name} (tenant ${tenantId})`);
  }

  broadcastReservationUpdated(tenantId: number, reservation: Reservation, _excludeSocketId?: string) {
    this.io.to(this.tenantRoom(tenantId)).emit('reservation:updated', reservation);
    console.log(`Broadcasting reservation:updated for ${reservation.customer_name} (tenant ${tenantId})`);
  }

  broadcastReservationDeleted(tenantId: number, id: number, _excludeSocketId?: string) {
    this.io.to(this.tenantRoom(tenantId)).emit('reservation:deleted', id);
    console.log(`Broadcasting reservation:deleted for ID ${id} (tenant ${tenantId})`);
  }

  // Silent variant: patch the reservation in clients' state WITHOUT a toast or
  // notification. Used when a non-reservation action denormalizes onto the
  // reservation row (e.g. a customer rename cascades customer_name) — the user
  // did that edit elsewhere and shouldn't get "Prenotazione aggiornata" spam,
  // one per affected booking.
  broadcastReservationSynced(tenantId: number, reservation: Reservation) {
    this.io.to(this.tenantRoom(tenantId)).emit('reservation:synced', reservation);
  }

  // Table broadcast methods
  broadcastTableCreated(tenantId: number, table: Table, excludeSocketId?: string) {
    // Broadcast to all tenant clients except the originating socket
    if (excludeSocketId) {
      this.io.to(this.tenantRoom(tenantId)).except(excludeSocketId).emit('table:created', table);
    } else {
      this.io.to(this.tenantRoom(tenantId)).emit('table:created', table);
    }
    console.log(`Broadcasting table:created for ${table.name} (tenant ${tenantId})`);
  }

  broadcastTableUpdated(tenantId: number, table: Table, excludeSocketId?: string) {
    // Broadcast to all tenant clients except the originating socket
    if (excludeSocketId) {
      this.io.to(this.tenantRoom(tenantId)).except(excludeSocketId).emit('table:updated', table);
      this.io.to(`tenant:${tenantId}:room:${table.room_id}`).except(excludeSocketId).emit('table:updated', table);
    } else {
      this.io.to(this.tenantRoom(tenantId)).emit('table:updated', table);
      this.io.to(`tenant:${tenantId}:room:${table.room_id}`).emit('table:updated', table);
    }
    console.log(`Broadcasting table:updated for ${table.name} (tenant ${tenantId})`);
  }

  broadcastTableDeleted(tenantId: number, id: number) {
    this.io.to(this.tenantRoom(tenantId)).emit('table:deleted', id);
    console.log(`Broadcasting table:deleted for ID ${id} (tenant ${tenantId})`);
  }

  // Per-shift table merge events
  broadcastTableMergeCreated(tenantId: number, merge: TableMerge, excludeSocketId?: string) {
    if (excludeSocketId) {
      this.io.to(this.tenantRoom(tenantId)).except(excludeSocketId).emit('tableMerge:created', merge);
    } else {
      this.io.to(this.tenantRoom(tenantId)).emit('tableMerge:created', merge);
    }
    console.log(`Broadcasting tableMerge:created for ${merge.date} ${merge.shift} primary=${merge.primary_id} (tenant ${tenantId})`);
  }

  broadcastTableMergeDeleted(tenantId: number, merge: TableMerge, excludeSocketId?: string) {
    if (excludeSocketId) {
      this.io.to(this.tenantRoom(tenantId)).except(excludeSocketId).emit('tableMerge:deleted', merge);
    } else {
      this.io.to(this.tenantRoom(tenantId)).emit('tableMerge:deleted', merge);
    }
    console.log(`Broadcasting tableMerge:deleted for ${merge.date} ${merge.shift} primary=${merge.primary_id} (tenant ${tenantId})`);
  }

  // Per-shift hidden table events
  broadcastTableHiddenCreated(tenantId: number, hidden: TableHiddenOverride) {
    this.io.to(this.tenantRoom(tenantId)).emit('tableHidden:created', hidden);
    console.log(`Broadcasting tableHidden:created for ${hidden.date} ${hidden.shift} table=${hidden.table_id} (tenant ${tenantId})`);
  }

  broadcastTableHiddenDeleted(tenantId: number, hidden: TableHiddenOverride) {
    this.io.to(this.tenantRoom(tenantId)).emit('tableHidden:deleted', hidden);
    console.log(`Broadcasting tableHidden:deleted for ${hidden.date} ${hidden.shift} table=${hidden.table_id} (tenant ${tenantId})`);
  }

  // Per-shift room closure events
  broadcastRoomClosedCreated(tenantId: number, closed: RoomClosedOverride) {
    this.io.to(this.tenantRoom(tenantId)).emit('roomClosed:created', closed);
    console.log(`Broadcasting roomClosed:created for ${closed.date} ${closed.shift} room=${closed.room_id} (tenant ${tenantId})`);
  }

  broadcastRoomClosedDeleted(tenantId: number, closed: RoomClosedOverride) {
    this.io.to(this.tenantRoom(tenantId)).emit('roomClosed:deleted', closed);
    console.log(`Broadcasting roomClosed:deleted for ${closed.date} ${closed.shift} room=${closed.room_id} (tenant ${tenantId})`);
  }

  // Room broadcast methods
  broadcastRoomCreated(tenantId: number, room: Room) {
    this.io.to(this.tenantRoom(tenantId)).emit('room:created', room);
    console.log(`Broadcasting room:created for ${room.name} (tenant ${tenantId})`);
  }

  broadcastRoomUpdated(tenantId: number, room: Room) {
    this.io.to(this.tenantRoom(tenantId)).emit('room:updated', room);
    console.log(`Broadcasting room:updated for ${room.name} (tenant ${tenantId})`);
  }

  broadcastRoomDeleted(tenantId: number, id: number) {
    this.io.to(this.tenantRoom(tenantId)).emit('room:deleted', id);
    console.log(`Broadcasting room:deleted for ID ${id} (tenant ${tenantId})`);
  }

  // Dish broadcast methods
  broadcastDishCreated(tenantId: number, dish: Dish) {
    this.io.to(this.tenantRoom(tenantId)).emit('dish:created', dish);
    console.log(`Broadcasting dish:created for ${dish.name} (tenant ${tenantId})`);
  }

  broadcastDishUpdated(tenantId: number, dish: Dish) {
    this.io.to(this.tenantRoom(tenantId)).emit('dish:updated', dish);
    console.log(`Broadcasting dish:updated for ${dish.name} (tenant ${tenantId})`);
  }

  broadcastDishDeleted(tenantId: number, id: number) {
    this.io.to(this.tenantRoom(tenantId)).emit('dish:deleted', id);
    console.log(`Broadcasting dish:deleted for ID ${id} (tenant ${tenantId})`);
  }

  // Banquet Menu broadcast methods
  broadcastBanquetCreated(tenantId: number, menu: BanquetMenu) {
    this.io.to(this.tenantRoom(tenantId)).emit('banquet:created', menu);
    console.log(`Broadcasting banquet:created for ${menu.name} (tenant ${tenantId})`);
  }

  broadcastBanquetUpdated(tenantId: number, menu: BanquetMenu) {
    this.io.to(this.tenantRoom(tenantId)).emit('banquet:updated', menu);
    console.log(`Broadcasting banquet:updated for ${menu.name} (tenant ${tenantId})`);
  }

  broadcastBanquetDeleted(tenantId: number, id: number) {
    this.io.to(this.tenantRoom(tenantId)).emit('banquet:deleted', id);
    console.log(`Broadcasting banquet:deleted for ID ${id} (tenant ${tenantId})`);
  }

  // Generic broadcast method for any event type
  // Emette alla sola partita indicata. Il passe (PR 5) si iscriverà a tutte.
  broadcastToStation(tenantId: number, stationId: number | null, event: string, data: any) {
    // Le righe senza partita assegnata finiscono nel canale generico invece
    // di sparire: un piatto non ancora configurato resta visibile a qualcuno.
    const room = stationId == null
      ? `tenant:${tenantId}:station:none`
      : `tenant:${tenantId}:station:${stationId}`;
    this.io.to(room).emit(event, data);
  }

  // Chat staff — emissione mirata sulle room per utente / per ruolo (vedi
  // join in setupEventHandlers). io.to([...]) deduplica i socket presenti in
  // più room, quindi passare mittente e destinatario insieme è sicuro.
  broadcastToUsers(tenantId: number, userIds: number[], event: string, data: any, excludeSocketId?: string) {
    const rooms = userIds.map(id => `tenant:${tenantId}:user:${id}`);
    if (rooms.length === 0) return;
    if (excludeSocketId) {
      this.io.to(rooms).except(excludeSocketId).emit(event, data);
    } else {
      this.io.to(rooms).emit(event, data);
    }
  }

  // Il nome evita la collisione con pushService.sendToRoles.
  broadcastToRolesRoom(tenantId: number, roles: string[], event: string, data: any, excludeSocketId?: string) {
    const rooms = roles.map(role => `tenant:${tenantId}:role:${role}`);
    if (rooms.length === 0) return;
    if (excludeSocketId) {
      this.io.to(rooms).except(excludeSocketId).emit(event, data);
    } else {
      this.io.to(rooms).emit(event, data);
    }
  }

  broadcastToAll(tenantId: number, event: string, data: any, excludeSocketId?: string) {
    console.log(`📡 broadcastToAll: ${event} to tenant ${tenantId} (excluding: ${excludeSocketId || 'none'})`);

    // Fase B5: "all" significa tutti i client del tenant, non tutti i socket.
    // L'excludeSocketId (header X-Socket-ID) torna onorato: chi ha originato
    // la scrittura ha già aggiornato il proprio stato in locale.
    if (excludeSocketId) {
      this.io.to(this.tenantRoom(tenantId)).except(excludeSocketId).emit(event, data);
    } else {
      this.io.to(this.tenantRoom(tenantId)).emit(event, data);
    }
  }

  // Get Socket.IO instance (for advanced usage if needed)
  getIO() {
    return this.io;
  }
}
