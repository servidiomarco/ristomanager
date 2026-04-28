import { TodoItem, TodoPriority, TodoCategory, UserRole } from '../types';
import { authApiService } from './authApiService';
import { socketClient } from './socketClient';

const API_URL = "https://ristomanager-production.up.railway.app";

// Helper function to get headers with socket ID and auth token
const getHeaders = (includeContentType = true): HeadersInit => {
  const headers: HeadersInit = {};

  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }

  // Add socket ID to prevent duplicate broadcasts
  const socketId = socketClient.getSocket()?.id;
  if (socketId) {
    headers['X-Socket-ID'] = socketId;
  }

  // Add authorization header
  const token = authApiService.getAccessToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
};

// Fetch with automatic token refresh on 401
const fetchWithAuth = async (
  url: string,
  options: RequestInit = {},
  retried = false
): Promise<Response> => {
  const response = await fetch(url, options);

  // If unauthorized and not already retried, try to refresh token
  if (response.status === 401 && !retried) {
    console.log('Token expired, attempting refresh...');
    const refreshed = await authApiService.refreshToken();

    if (refreshed) {
      console.log('Token refreshed successfully, retrying request...');
      const newHeaders = { ...options.headers } as Record<string, string>;
      newHeaders['Authorization'] = `Bearer ${refreshed.accessToken}`;
      return fetchWithAuth(url, { ...options, headers: newHeaders }, true);
    }
  }

  return response;
};

// Helper to make authenticated requests with error handling
const apiRequest = async <T>(
  url: string,
  options: RequestInit = {},
  expectJson = true
): Promise<T> => {
  const response = await fetchWithAuth(url, options);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(errorData.error || `Request failed with status ${response.status}`);
  }

  if (expectJson) {
    return response.json();
  }

  return undefined as T;
};

export interface CreateTodoInput {
  title: string;
  description?: string;
  priority: TodoPriority;
  category: TodoCategory;
  dueDate?: string;
  assignedToUserId?: number;
  assignedToUserName?: string;
  assignedToTeam?: UserRole;
  linkedReservationId?: number;
}

export interface UpdateTodoInput {
  title?: string;
  description?: string;
  priority?: TodoPriority;
  category?: TodoCategory;
  dueDate?: string;
  completed?: boolean;
  assignedToUserId?: number;
  assignedToUserName?: string;
  assignedToTeam?: UserRole;
}

class TodoApiService {
  /**
   * Get all todos
   */
  async getTodos(): Promise<TodoItem[]> {
    return apiRequest<TodoItem[]>(`${API_URL}/todos`, {
      headers: getHeaders(false)
    });
  }

  /**
   * Get todos for a specific date
   */
  async getTodosByDate(date: string): Promise<TodoItem[]> {
    return apiRequest<TodoItem[]>(`${API_URL}/todos?date=${date}`, {
      headers: getHeaders(false)
    });
  }

  /**
   * Get todos assigned to current user or their team
   */
  async getMyTodos(): Promise<TodoItem[]> {
    return apiRequest<TodoItem[]>(`${API_URL}/todos/my`, {
      headers: getHeaders(false)
    });
  }

  /**
   * Create a new todo
   */
  async createTodo(todo: CreateTodoInput): Promise<TodoItem> {
    return apiRequest<TodoItem>(`${API_URL}/todos`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(todo),
    });
  }

  /**
   * Update a todo
   */
  async updateTodo(id: string, updates: UpdateTodoInput): Promise<TodoItem> {
    return apiRequest<TodoItem>(`${API_URL}/todos/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(updates),
    });
  }

  /**
   * Delete a todo
   */
  async deleteTodo(id: string): Promise<void> {
    return apiRequest<void>(`${API_URL}/todos/${id}`, {
      method: 'DELETE',
      headers: getHeaders(false),
    }, false);
  }

  /**
   * Toggle todo completion status
   */
  async toggleTodoComplete(id: string): Promise<TodoItem> {
    return apiRequest<TodoItem>(`${API_URL}/todos/${id}/toggle`, {
      method: 'PUT',
      headers: getHeaders(false),
    });
  }
}

export const todoApiService = new TodoApiService();
