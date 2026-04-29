import { io, Socket } from 'socket.io-client';

// Use environment variable or default to production URL
const SOCKET_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

// Token storage key (must match authApiService)
const ACCESS_TOKEN_KEY = 'ristomanager_access_token';

type SocketChangeCallback = (socket: Socket | null, connected: boolean) => void;

class SocketClient {
  private socket: Socket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
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

    console.log(`📡 Connecting to Socket.IO server at ${SOCKET_URL}`);

    this.socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
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
      console.error('❌ Connection error:', error.message);
      this.reconnectAttempts++;

      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.error('Max reconnection attempts reached');
      }
    });

    this.socket.on('reconnect', (attemptNumber) => {
      console.log(`🔄 Reconnected after ${attemptNumber} attempts`);
      this.reconnectAttempts = 0;
    });

    this.socket.on('reconnect_attempt', (attemptNumber) => {
      console.log(`🔄 Reconnection attempt ${attemptNumber}/${this.maxReconnectAttempts}`);
    });

    this.socket.on('reconnect_failed', () => {
      console.error('❌ Reconnection failed after maximum attempts');
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
}

// Export singleton instance
export const socketClient = new SocketClient();
