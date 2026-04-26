import { useEffect, useState } from 'react';
import { socketClient } from '../services/socketClient';
import type { Socket } from 'socket.io-client';

export const useSocket = () => {
  const [socket, setSocket] = useState<Socket | null>(() => socketClient.getSocket());
  const [isConnected, setIsConnected] = useState(() => socketClient.isConnected());

  useEffect(() => {
    // Subscribe to socket changes (connect/disconnect/reconnect)
    const unsubscribe = socketClient.onSocketChange((newSocket, connected) => {
      setSocket(newSocket);
      setIsConnected(connected);
      console.log('useSocket: Socket changed, connected:', connected);
    });

    // Try to connect on mount (returns null if no auth token)
    const socketInstance = socketClient.connect();
    if (socketInstance) {
      setSocket(socketInstance);
      setIsConnected(socketInstance.connected);
    }

    return () => {
      unsubscribe();
    };
  }, []);

  return { socket, isConnected };
};
