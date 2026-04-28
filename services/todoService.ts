import { TodoItem, TodoPriority, TodoCategory } from '../types';

const STORAGE_KEY = 'ristocrm_todos';

export const getTodos = (): TodoItem[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

export const saveTodos = (todos: TodoItem[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
};

export const createTodo = (todo: Omit<TodoItem, 'id' | 'createdAt' | 'completed'>): TodoItem => {
  const newTodo: TodoItem = {
    ...todo,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    completed: false,
  };
  const todos = getTodos();
  todos.unshift(newTodo);
  saveTodos(todos);
  return newTodo;
};

export const updateTodo = (id: string, updates: Partial<TodoItem>): TodoItem | null => {
  const todos = getTodos();
  const index = todos.findIndex(t => t.id === id);
  if (index === -1) return null;

  todos[index] = { ...todos[index], ...updates };
  saveTodos(todos);
  return todos[index];
};

export const deleteTodo = (id: string): boolean => {
  const todos = getTodos();
  const filtered = todos.filter(t => t.id !== id);
  if (filtered.length === todos.length) return false;

  saveTodos(filtered);
  return true;
};

export const toggleTodoComplete = (id: string): TodoItem | null => {
  const todos = getTodos();
  const todo = todos.find(t => t.id === id);
  if (!todo) return null;

  todo.completed = !todo.completed;
  todo.completedAt = todo.completed ? new Date().toISOString() : undefined;
  saveTodos(todos);
  return todo;
};

export const getTodosByDate = (date: string): TodoItem[] => {
  const todos = getTodos();
  return todos.filter(t => t.dueDate?.startsWith(date));
};

export const getPendingTodos = (): TodoItem[] => {
  return getTodos().filter(t => !t.completed);
};

export const getCompletedTodos = (): TodoItem[] => {
  return getTodos().filter(t => t.completed);
};

export const getOverdueTodos = (): TodoItem[] => {
  const today = new Date().toISOString().split('T')[0];
  return getTodos().filter(t => !t.completed && t.dueDate && t.dueDate < today);
};

export const getTodosByCategory = (category: TodoCategory): TodoItem[] => {
  return getTodos().filter(t => t.category === category);
};

export const getTodosLinkedToReservation = (reservationId: number): TodoItem[] => {
  return getTodos().filter(t => t.linkedReservationId === reservationId);
};
