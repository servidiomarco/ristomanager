import { io, Socket } from 'socket.io-client';

// Use environment variable or default to production URL
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'https://ristomanager-production.up.railway.app';

class SocketClient {
  private socket: Socket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  connect() {
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
      timeout: 20000
    });

    this.setupConnectionHandlers();
    return this.socket;
  }

  private setupConnectionHandlers() {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      console.log('✅ Socket connected:', this.socket?.id);
      this.reconnectAttempts = 0;
    });

    this.socket.on('disconnect', (reason) => {
      console.warn('⚠️ Socket disconnected:', reason);

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
