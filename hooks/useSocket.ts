import { useEffect, useState } from 'react';
import { socketClient } from '../services/socketClient';
import type { Socket } from 'socket.io-client';

export const useSocket = () => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    // Connect to socket on mount
    const socketInstance = socketClient.connect();
    setSocket(socketInstance);

    // Setup connection state handlers
    const handleConnect = () => {
      setIsConnected(true);
      console.log('useSocket: Connected');
    };

    const handleDisconnect = () => {
      setIsConnected(false);
      console.log('useSocket: Disconnected');
    };

    socketInstance.on('connect', handleConnect);
    socketInstance.on('disconnect', handleDisconnect);

    // Set initial connection state
    setIsConnected(socketInstance.connected);

    // Cleanup on unmount
    return () => {
      socketInstance.off('connect', handleConnect);
      socketInstance.off('disconnect', handleDisconnect);
      // Note: We don't disconnect here because socket is a singleton
      // It should remain connected for the lifetime of the app
    };
  }, []); // Empty dependency array - run once on mount

  return { socket, isConnected };
};
