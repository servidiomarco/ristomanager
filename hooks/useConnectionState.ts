import { useEffect, useState } from 'react';
import { socketClient } from '../services/socketClient';

export const useConnectionState = () => {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isConnected, setIsConnected] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  useEffect(() => {
    // Monitor browser online/offline status
    const handleOnline = () => {
      console.log('Browser is online');
      setIsOnline(true);
      // Force socket reconnection when browser comes back online
      socketClient.connect();
    };

    const handleOffline = () => {
      console.log('Browser is offline');
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Monitor socket connection status
    const socket = socketClient.getSocket();
    if (socket) {
      const handleConnect = () => {
        setIsConnected(true);
        setLastSync(new Date());
      };

      const handleDisconnect = () => {
        setIsConnected(false);
      };

      socket.on('connect', handleConnect);
      socket.on('disconnect', handleDisconnect);

      // Set initial state
      setIsConnected(socket.connected);

      return () => {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
        socket.off('connect', handleConnect);
        socket.off('disconnect', handleDisconnect);
      };
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return {
    isOnline,
    isConnected,
    lastSync,
    isFullyConnected: isOnline && isConnected
  };
};
