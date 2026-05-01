export enum TableShape {
  RECTANGLE = 'RECTANGLE',
  CIRCLE = 'CIRCLE',
  SQUARE = 'SQUARE'
}

export enum TableStatus {
  FREE = 'FREE',
  OCCUPIED = 'OCCUPIED',
  RESERVED = 'RESERVED',
  DIRTY = 'DIRTY'
}

export interface Table {
  id: number;
  name: string;
  shape: TableShape;
  seats: number;
  min_seats?: number;
  max_seats?: number;
  x: number;
  y: number;
  room_id: number;
  status: TableStatus;
  is_locked?: boolean;
  merged_with?: number[];
  temp_lock_expires_at?: number;
  rotation?: number;
}

export interface Room {
  id: number;
  name: string;
  width: number;
  height: number;
}

export interface Dish {
  id: number;
  name: string;
  description?: string;
  price: number;
  category?: string;
  allergens?: string[];
}

export const COMMON_ALLERGENS = [
  "Glutine", "Crostacei", "Uova", "Pesce", "Arachidi",
  "Soia", "Latte", "Frutta a guscio", "Sedano", "Senape",
  "Sesamo", "Solfiti", "Lupini", "Molluschi"
];

export interface BanquetMenu {
  id: number;
  name: string;
  description: string;
  price_per_person: number;
  dish_ids: number[];
  event_date: string; // YYYY-MM-DD
  deposit_amount?: number;
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  PAID_DEPOSIT = 'PAID_DEPOSIT',
  PAID_FULL = 'PAID_FULL',
  REFUNDED = 'REFUNDED'
}

export enum Shift {
  LUNCH = 'LUNCH',
  DINNER = 'DINNER'
}

export interface TableMerge {
  id: number;
  date: string; // YYYY-MM-DD
  shift: Shift;
  primary_id: number;
  merged_ids: number[];
}

export enum ArrivalStatus {
  WAITING = 'WAITING',      // In attesa - green border
  ARRIVED = 'ARRIVED'       // Arrivato - orange border
}

export interface Reservation {
  id: number;
  customer_name: string;
  reservation_time: string;
  shift: Shift;
  guests: number;
  table_id?: number;
  notes?: string;
  email?: string;
  phone?: string;
  payment_status: PaymentStatus;
  deposit_amount?: number;
  total_amount?: number;
  banquet_menu_id?: number;
  enable_reminder?: boolean;
  reminder_sent?: boolean;
  arrival_status?: ArrivalStatus;
}

export interface Notification {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  timestamp: Date;
  read: boolean;
}

export interface Toast {
    id: string;
    message: string;
    type: 'success' | 'error' | 'info';
    title?: string;
    details?: string[];
    duration?: number;
}

export enum ViewState {
  DASHBOARD = 'DASHBOARD',
  FLOOR_PLAN = 'FLOOR_PLAN',
  MENU = 'MENU',
  RESERVATIONS = 'RESERVATIONS',
  STAFF = 'STAFF',
  SETTINGS = 'SETTINGS'
}

// ============================================
// USER & AUTHENTICATION TYPES
// ============================================

export enum UserRole {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  WAITER = 'WAITER',
  KITCHEN = 'KITCHEN'
}

export interface User {
  id: number;
  email: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
  last_login?: string;
}

export interface AuthUser extends User {
  token: string;
  refreshToken: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface TokenPayload {
  userId: number;
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
}

// ============================================
// ACTIVITY LOG TYPES
// ============================================

export enum ActivityAction {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  LOGIN = 'LOGIN',
  LOGOUT = 'LOGOUT'
}

export enum ResourceType {
  RESERVATION = 'RESERVATION',
  TABLE = 'TABLE',
  ROOM = 'ROOM',
  DISH = 'DISH',
  BANQUET_MENU = 'BANQUET_MENU',
  USER = 'USER',
  AUTH = 'AUTH',
  STAFF = 'STAFF',
  STAFF_SHIFT = 'STAFF_SHIFT',
  STAFF_TIME_OFF = 'STAFF_TIME_OFF'
}

export interface ActivityLog {
  id: number;
  user_id: number | null;
  user_email: string;
  user_name: string;
  action: ActivityAction;
  resource_type: ResourceType;
  resource_id?: number;
  resource_name?: string;
  details?: Record<string, any>;
  status: 'SUCCESS' | 'ERROR';
  error_message?: string;
  created_at: string;
}

export interface LogFilters {
  user_id?: number;
  resource_type?: ResourceType;
  action?: ActivityAction;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}

export interface ActivityStats {
  total_logs: number;
  logs_by_action: Record<string, number>;
  logs_by_resource: Record<string, number>;
  recent_users: { user_id: number; user_name: string; count: number }[];
}

// ============================================
// TODO TYPES
// ============================================

export enum TodoPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH'
}

export enum TodoCategory {
  GENERAL = 'GENERAL',
  RESERVATION = 'RESERVATION',
  INVENTORY = 'INVENTORY',
  STAFF = 'STAFF',
  MAINTENANCE = 'MAINTENANCE',
  EVENT = 'EVENT'
}

export interface TodoItem {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  priority: TodoPriority;
  category: TodoCategory;
  dueDate?: string;
  createdAt: string;
  completedAt?: string;
  linkedReservationId?: number;
  // Assignment fields
  assignedToUserId?: number;
  assignedToUserName?: string;
  assignedToTeam?: UserRole;
  createdByUserId?: number;
  createdByUserName?: string;
}

// ============================================
// STAFF MANAGEMENT TYPES
// ============================================

export enum StaffCategory {
  SALA = 'SALA',
  CUCINA = 'CUCINA'
}

export enum StaffType {
  FISSO = 'FISSO',
  STAGIONALE = 'STAGIONALE',
  EXTRA = 'EXTRA'
}

export enum TimeOffType {
  RIPOSO = 'RIPOSO',
  VACANZA = 'VACANZA',
  MALATTIA = 'MALATTIA',
  PERMESSO = 'PERMESSO'
}

export interface StaffMember {
  id: string;
  name: string;
  surname: string;
  category: StaffCategory;
  staffType: StaffType;
  phone?: string;
  email?: string;
  role?: string; // e.g., "Chef", "Cameriere", "Lavapiatti"
  hireDate?: string;
  contractEndDate?: string; // For seasonal staff
  weeklyRestDay?: number | null; // 0=Sunday, 1=Monday, ..., 6=Saturday (JS getDay())
  notes?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface StaffShift {
  id: string;
  staffId: string;
  date: string; // YYYY-MM-DD
  shift: Shift; // LUNCH or DINNER
  present: boolean;
  notes?: string;
  createdAt?: string;
}

export interface StaffTimeOff {
  id: string;
  staffId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  type: TimeOffType;
  notes?: string;
  approved: boolean;
  createdAt?: string;
}