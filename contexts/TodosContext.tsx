import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { TodoItem, UserRole } from '../types';
import { todoApiService, CreateTodoInput, UpdateTodoInput } from '../services/todoApiService';
import { authApiService } from '../services/authApiService';
import { socketClient } from '../services/socketClient';
import { useAuth } from './AuthContext';

export interface AssignableUser {
  id: number;
  full_name: string;
  role: UserRole;
}

interface TodosContextType {
  todos: TodoItem[];
  loading: boolean;
  assignableUsers: AssignableUser[];
  addTodo: (input: CreateTodoInput) => Promise<TodoItem>;
  updateTodo: (id: string, input: UpdateTodoInput) => Promise<TodoItem>;
  toggleTodo: (id: string) => Promise<void>;
  deleteTodo: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const TodosContext = createContext<TodosContextType | undefined>(undefined);

export const TodosProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuth();
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [socketConnected, setSocketConnected] = useState(socketClient.isConnected());

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const fetched = await todoApiService.getTodos();
      setTodos(fetched);
    } catch (error) {
      console.error('Error fetching todos:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setTodos([]);
      setAssignableUsers([]);
      setLoading(false);
      return;
    }
    refresh();
    authApiService
      .getAssignableUsers()
      .then(users => setAssignableUsers(users))
      .catch(() => {
        // Roles without assignment access (waiter/kitchen) just see an empty list.
      });
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
    if (!socket) return;

    const handleCreated = (todo: TodoItem) => {
      setTodos(prev => (prev.some(t => t.id === todo.id) ? prev : [todo, ...prev]));
    };
    const handleUpdated = (todo: TodoItem) => {
      setTodos(prev => {
        const exists = prev.some(t => t.id === todo.id);
        return exists ? prev.map(t => (t.id === todo.id ? todo : t)) : [todo, ...prev];
      });
    };
    const handleDeleted = ({ id }: { id: string }) => {
      setTodos(prev => prev.filter(t => t.id !== id));
    };

    socket.on('todo:created', handleCreated);
    socket.on('todo:updated', handleUpdated);
    socket.on('todo:deleted', handleDeleted);

    return () => {
      socket.off('todo:created', handleCreated);
      socket.off('todo:updated', handleUpdated);
      socket.off('todo:deleted', handleDeleted);
    };
  }, [socketConnected, isAuthenticated]);

  const addTodo = useCallback(async (input: CreateTodoInput) => {
    const created = await todoApiService.createTodo(input);
    setTodos(prev => (prev.some(t => t.id === created.id) ? prev : [created, ...prev]));
    return created;
  }, []);

  const updateTodo = useCallback(async (id: string, input: UpdateTodoInput) => {
    const updated = await todoApiService.updateTodo(id, input);
    setTodos(prev => prev.map(t => (t.id === id ? updated : t)));
    return updated;
  }, []);

  const toggleTodo = useCallback(async (id: string) => {
    const updated = await todoApiService.toggleTodoComplete(id);
    setTodos(prev => prev.map(t => (t.id === id ? updated : t)));
  }, []);

  const deleteTodo = useCallback(async (id: string) => {
    await todoApiService.deleteTodo(id);
    setTodos(prev => prev.filter(t => t.id !== id));
  }, []);

  const value: TodosContextType = {
    todos,
    loading,
    assignableUsers,
    addTodo,
    updateTodo,
    toggleTodo,
    deleteTodo,
    refresh,
  };

  return <TodosContext.Provider value={value}>{children}</TodosContext.Provider>;
};

export const useTodos = (): TodosContextType => {
  const ctx = useContext(TodosContext);
  if (!ctx) throw new Error('useTodos must be used within a TodosProvider');
  return ctx;
};
