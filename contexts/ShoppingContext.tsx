import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { shoppingApiService, supplierApiService, ShoppingItem, ShoppingCategory, Supplier, ShoppingUnit } from '../services/shoppingApiService';
import { socketClient } from '../services/socketClient';
import { useAuth } from './AuthContext';

interface ShoppingContextType {
  items: ShoppingItem[];
  loading: boolean;
  history: string[];
  suppliers: Supplier[];
  addItem: (input: { name: string; category: ShoppingCategory; supplierId?: string | null; quantity?: number | null; unit?: ShoppingUnit | null }) => Promise<void>;
  updateItem: (id: string, patch: { name?: string; category?: ShoppingCategory; supplierId?: string | null; quantity?: number | null; unit?: ShoppingUnit | null }) => Promise<void>;
  toggleItem: (id: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  clearChecked: () => Promise<void>;
  refresh: () => Promise<void>;
  addSupplier: (input: { name: string; category: ShoppingCategory; phone?: string; note?: string }) => Promise<Supplier>;
  updateSupplier: (id: string, patch: { name?: string; phone?: string | null; note?: string | null }) => Promise<Supplier>;
  deleteSupplier: (id: string) => Promise<void>;
}

const ShoppingContext = createContext<ShoppingContextType | undefined>(undefined);

const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export const ShoppingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuth();
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [socketConnected, setSocketConnected] = useState(socketClient.isConnected());

  const history = useMemo(
    () => Array.from(new Set(items.map(i => i.name))),
    [items]
  );

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const [fetchedItems, fetchedSuppliers] = await Promise.all([
        shoppingApiService.getAllItems(),
        supplierApiService.getAll().catch(() => [] as Supplier[]),
      ]);
      setItems(fetchedItems);
      setSuppliers(fetchedSuppliers);
    } catch (error) {
      console.error('Error fetching shopping items:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setItems([]);
      setSuppliers([]);
      setLoading(false);
      return;
    }
    refresh();
  }, [isAuthenticated, refresh]);

  useEffect(() => {
    const unsubscribe = socketClient.onSocketChange((_socket, connected) => {
      setSocketConnected(connected);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    const socket = socketClient.getSocket();
    if (!socket || !socket.connected) return;

    const handleCreated = (item: ShoppingItem) => {
      setItems(prev => (prev.some(i => i.id === item.id) ? prev : [...prev, item]));
    };
    const handleUpdated = (item: ShoppingItem) => {
      setItems(prev => prev.map(i => (i.id === item.id ? item : i)));
    };
    const handleDeleted = ({ id }: { id: string }) => {
      setItems(prev => prev.filter(i => i.id !== id));
    };
    const handleCleared = () => {
      setItems(prev => prev.filter(i => !i.checked));
    };

    const handleSupplierCreated = (supplier: Supplier) => {
      setSuppliers(prev => (prev.some(s => s.id === supplier.id) ? prev : [...prev, supplier]));
    };
    const handleSupplierUpdated = (supplier: Supplier) => {
      setSuppliers(prev => prev.map(s => (s.id === supplier.id ? supplier : s)));
      // Reflect the new supplier name onto items that reference it
      setItems(prev => prev.map(i => (i.supplierId === supplier.id ? { ...i, supplierName: supplier.name } : i)));
    };
    const handleSupplierDeleted = ({ id }: { id: string }) => {
      setSuppliers(prev => prev.filter(s => s.id !== id));
      // FK is ON DELETE SET NULL on the backend; mirror locally
      setItems(prev => prev.map(i => (i.supplierId === id ? { ...i, supplierId: null, supplierName: null } : i)));
    };

    socket.on('shopping:created', handleCreated);
    socket.on('shopping:updated', handleUpdated);
    socket.on('shopping:deleted', handleDeleted);
    socket.on('shopping:cleared', handleCleared);
    socket.on('supplier:created', handleSupplierCreated);
    socket.on('supplier:updated', handleSupplierUpdated);
    socket.on('supplier:deleted', handleSupplierDeleted);

    return () => {
      socket.off('shopping:created', handleCreated);
      socket.off('shopping:updated', handleUpdated);
      socket.off('shopping:deleted', handleDeleted);
      socket.off('shopping:cleared', handleCleared);
      socket.off('supplier:created', handleSupplierCreated);
      socket.off('supplier:updated', handleSupplierUpdated);
      socket.off('supplier:deleted', handleSupplierDeleted);
    };
  }, [socketConnected, isAuthenticated]);

  const addItem = useCallback(
    async ({ name, category, supplierId, quantity, unit }: { name: string; category: ShoppingCategory; supplierId?: string | null; quantity?: number | null; unit?: ShoppingUnit | null }) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      // Don't append locally — the socket echo (including to the sender) handles it.
      // The 'created' handler dedupes on id, so this is safe even with optimistic UX.
      await shoppingApiService.createItem({
        name: trimmed,
        category,
        date: formatLocalDate(new Date()),
        supplierId: supplierId ?? null,
        quantity: quantity ?? null,
        unit: unit ?? null,
      });
    },
    [],
  );

  const updateItem = useCallback(
    async (id: string, patch: { name?: string; category?: ShoppingCategory; supplierId?: string | null; quantity?: number | null; unit?: ShoppingUnit | null }) => {
      const updated = await shoppingApiService.updateItem(id, patch);
      setItems(prev => prev.map(i => (i.id === updated.id ? updated : i)));
    },
    [],
  );

  const toggleItem = useCallback(async (id: string) => {
    const updated = await shoppingApiService.toggleItem(id);
    setItems(prev => prev.map(i => (i.id === id ? updated : i)));
  }, []);

  const deleteItem = useCallback(async (id: string) => {
    await shoppingApiService.deleteItem(id);
    setItems(prev => prev.filter(i => i.id !== id));
  }, []);

  const clearChecked = useCallback(async () => {
    await shoppingApiService.clearChecked();
    setItems(prev => prev.filter(i => !i.checked));
  }, []);

  const addSupplier = useCallback(
    async (input: { name: string; category: ShoppingCategory; phone?: string; note?: string }) => {
      const created = await supplierApiService.create(input);
      setSuppliers(prev => (prev.some(s => s.id === created.id) ? prev : [...prev, created]));
      return created;
    },
    [],
  );

  const updateSupplier = useCallback(
    async (id: string, patch: { name?: string; phone?: string | null; note?: string | null }) => {
      const updated = await supplierApiService.update(id, patch);
      setSuppliers(prev => prev.map(s => (s.id === id ? updated : s)));
      setItems(prev => prev.map(i => (i.supplierId === id ? { ...i, supplierName: updated.name } : i)));
      return updated;
    },
    [],
  );

  const deleteSupplier = useCallback(async (id: string) => {
    await supplierApiService.delete(id);
    setSuppliers(prev => prev.filter(s => s.id !== id));
    setItems(prev => prev.map(i => (i.supplierId === id ? { ...i, supplierId: null, supplierName: null } : i)));
  }, []);

  const value: ShoppingContextType = {
    items,
    loading,
    history,
    suppliers,
    addItem,
    updateItem,
    toggleItem,
    deleteItem,
    clearChecked,
    refresh,
    addSupplier,
    updateSupplier,
    deleteSupplier,
  };

  return <ShoppingContext.Provider value={value}>{children}</ShoppingContext.Provider>;
};

export const useShopping = (): ShoppingContextType => {
  const ctx = useContext(ShoppingContext);
  if (!ctx) throw new Error('useShopping must be used within a ShoppingProvider');
  return ctx;
};
