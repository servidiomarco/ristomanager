import { io, Socket } from 'socket.io-client';
import { serviceSocketUrl, isNodeUrl, noteNodeFailure } from './apiRouting';

// Token storage key (must match authApiService)
const ACCESS_TOKEN_KEY = 'ristomanager_access_token';

type SocketChangeCallback = (socket: Socket | null, connected: boolean) => void;

class SocketClient {
  private socket: Socket | null = null;
  private reconnectAttempts = 0;
  private changeCallbacks: Set<SocketChangeCallback> = new Set();

  private getToken(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  }

  // Subscribe to socket changes
  onSocketChange(callback: SocketChangeCallback): () => void {
    this.changeCallbacks.add(callback);
    // Return unsubscribe function
    return () => this.changeCallbacks.delete(callback);
  }

  private notifyChange() {
    const connected = this.socket?.connected ?? false;
    this.changeCallbacks.forEach(cb => cb(this.socket, connected));
  }

  connect() {
    const token = this.getToken();

    // Don't connect without a token
    if (!token) {
      console.log('📡 No auth token, skipping Socket.IO connection');
      return null;
    }

    // Return existing socket if already connected
    if (this.socket?.connected) {
      return this.socket;
    }

    // Modalità ibrida: il socket vive sul nodo di sala quando è attivo, sul
    // cloud altrimenti. Deciso a ogni connect, così un reconnectWithToken
    // dopo un cambio di routing atterra dalla parte giusta.
    const socketUrl = serviceSocketUrl();
    console.log(`📡 Connecting to Socket.IO server at ${socketUrl}`);

    this.socket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      randomizationFactor: 0.5,
      timeout: 20000,
      auth: {
        token
      }
    });

    this.setupConnectionHandlers();
    return this.socket;
  }

  // Reconnect with new token (after login)
  reconnectWithToken() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    const newSocket = this.connect();
    this.notifyChange();
    return newSocket;
  }

  private setupConnectionHandlers() {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      console.log('✅ Socket connected:', this.socket?.id);
      this.reconnectAttempts = 0;
      this.notifyChange();
    });

    this.socket.on('disconnect', (reason) => {
      console.warn('⚠️ Socket disconnected:', reason);
      this.notifyChange();

      // Automatic reconnection handled by socket.io
      if (reason === 'io server disconnect') {
        // Server initiated disconnect, try to reconnect manually
        this.socket?.connect();
      }
    });

    this.socket.on('connect_error', (error) => {
      this.reconnectAttempts++;
      // Log only every 5 attempts to avoid console flooding during long outages
      if (this.reconnectAttempts <= 3 || this.reconnectAttempts % 5 === 0) {
        console.error(`❌ Connection error (attempt ${this.reconnectAttempts}):`, error.message);
      }
      // Il NODO non risponde da 5 tentativi: circuito aperto e si riconnette
      // al cloud («il downgrade è il failover»). Verso il cloud invece si
      // insiste all'infinito, com'è sempre stato: non c'è un piano B.
      const uri = (this.socket?.io as any)?.uri as string | undefined;
      if (this.reconnectAttempts >= 5 && uri && isNodeUrl(uri)) {
        noteNodeFailure();
        this.reconnectWithToken();
      }
    });

    this.socket.on('reconnect', (attemptNumber) => {
      console.log(`🔄 Reconnected after ${attemptNumber} attempts`);
      this.reconnectAttempts = 0;
    });

    this.socket.on('reconnect_attempt', (attemptNumber) => {
      if (attemptNumber <= 3 || attemptNumber % 5 === 0) {
        console.log(`🔄 Reconnection attempt ${attemptNumber}`);
      }
    });

    // Connection acknowledged by server
    this.socket.on('connection:acknowledged', (clientId: string) => {
      console.log('✅ Connection acknowledged by server, client ID:', clientId);
    });
  }

  disconnect() {
    if (this.socket) {
      console.log('📡 Disconnecting socket');
      this.socket.disconnect();
      this.socket = null;
    }
  }

  getSocket() {
    return this.socket;
  }

  isConnected() {
    return this.socket?.connected ?? false;
  }

  // Subscribe to room updates
  subscribeToRoom(roomId: number) {
    if (this.socket?.connected) {
      this.socket.emit('subscribe:room', roomId);
      console.log(`📍 Subscribed to room ${roomId}`);
    }
  }

  // Unsubscribe from room updates
  unsubscribeFromRoom(roomId: number) {
    if (this.socket?.connected) {
      this.socket.emit('unsubscribe:room', roomId);
      console.log(`📍 Unsubscribed from room ${roomId}`);
    }
  }

  // Monitor di cucina: lo schermo ascolta solo la propria partita.
  subscribeToStation(stationId: number) {
    if (this.socket?.connected) {
      this.socket.emit('subscribe:station', stationId);
      console.log(`🍳 Subscribed to station ${stationId}`);
    }
  }

  unsubscribeFromStation(stationId: number) {
    if (this.socket?.connected) {
      this.socket.emit('unsubscribe:station', stationId);
    }
  }
}

// Export singleton instance
export const socketClient = new SocketClient();
