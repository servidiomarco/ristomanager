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
  width_cm?: number | null;
  length_cm?: number | null;
  notes?: string | null;
}

export interface Room {
  id: number;
  name: string;
  width: number;
  height: number;
  is_closed?: boolean;
}

export interface Dish {
  id: number;
  name: string;
  description?: string;
  price: number;
  category?: string;
  allergens?: string[];
  photo_url?: string;
}

export const COMMON_ALLERGENS = [
  "Glutine", "Crostacei", "Uova", "Pesce", "Arachidi",
  "Soia", "Latte", "Frutta a guscio", "Sedano", "Senape",
  "Sesamo", "Solfiti", "Lupini", "Molluschi"
];

export interface BanquetCourse {
  name: string;          // e.g. "1ª Uscita", "Antipasti"
  dish_ids: number[];
  notes?: string;
}

export interface BanquetMenu {
  id: number;
  name: string;
  description: string;
  price_per_person: number;
  dish_ids: number[];          // flat list, derived from courses for backward compat
  courses?: BanquetCourse[];   // new structured composition
  event_date: string;          // YYYY-MM-DD
  shift?: Shift;
  deposit_amount?: number;
  guests?: number;
  children?: number;
  children_price?: number | null;
  notes_courses?: string;
  notes_service?: string;
  notes_mise_en_place?: string;
  customer_id?: number | null;
  total_paid?: number;
  table_ids?: number[];
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  PAID_DEPOSIT = 'PAID_DEPOSIT',
  PAID_FULL = 'PAID_FULL',
  REFUNDED = 'REFUNDED'
}

export enum BanquetPaymentType {
  DEPOSIT = 'DEPOSIT',
  BALANCE = 'BALANCE',
  OTHER = 'OTHER'
}

export enum BanquetPaymentMethod {
  CASH = 'CASH',
  CARD = 'CARD',
  TRANSFER = 'TRANSFER',
  OTHER = 'OTHER'
}

export interface BanquetPayment {
  id: number;
  banquet_id: number;
  amount: number;
  payment_date: string; // YYYY-MM-DD
  payment_type: BanquetPaymentType;
  payment_method: BanquetPaymentMethod;
  notes?: string | null;
  created_by_user_id?: number | null;
  created_by_user_name?: string;
  created_at?: string;
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

export interface TableHiddenOverride {
  id: number;
  date: string; // YYYY-MM-DD
  shift: Shift;
  table_id: number;
}

export enum ArrivalStatus {
  WAITING = 'WAITING',      // In attesa - green border
  ARRIVED = 'ARRIVED',      // Arrivato - orange border
  DEPARTED = 'DEPARTED'     // Tavolo liberato - gray, table is free again
}

export enum ReservationSource {
  MANUAL = 'MANUAL',        // Created via CRM UI
  WHATSAPP = 'WHATSAPP',    // Created from Vonage WhatsApp inbound
  VOICE = 'VOICE',          // Created from ElevenLabs voice agent
  GOOGLE = 'GOOGLE'         // Created from the public booking page (Google Business link)
}

export enum ReservationStatus {
  PENDING = 'PENDING',      // Booking request awaiting staff approval (public form)
  CONFIRMED = 'CONFIRMED',  // Booking is on
  NO_SHOW = 'NO_SHOW',      // Customer did not show up
  CANCELLED = 'CANCELLED'   // Cancelled by customer (e.g. via voice agent)
}

export interface Reservation {
  id: number;
  customer_name: string;
  reservation_time: string;
  shift: Shift;
  // Service turn within the shift (e.g. 'T1' for primo turno, 'T2' for secondo).
  // A table can host one reservation per (date, shift, turn). Null/undefined
  // is treated as "occupies all turns" for legacy rows that pre-date the field.
  turn?: string | null;
  guests: number;
  children?: number;
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
  source?: ReservationSource;
  requires_review?: boolean;
  reservation_status?: ReservationStatus;
  created_by_user_id?: number | null;
  created_by_user_name?: string | null;
  created_at?: string;
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
    action?: { label: string; onClick: () => void };
}

export enum ViewState {
  DASHBOARD = 'DASHBOARD',
  FLOOR_PLAN = 'FLOOR_PLAN',
  MENU = 'MENU',
  RESERVATIONS = 'RESERVATIONS',
  STAFF = 'STAFF',
  CLIENTI = 'CLIENTI',
  INVENTARIO = 'INVENTARIO',
  USERS = 'USERS',
  SETTINGS = 'SETTINGS'
}

export interface Customer {
  id: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  postal_code?: string | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
  no_show_count?: number;
}

// ============================================
// USER & AUTHENTICATION TYPES
// ============================================

export enum UserRole {
  OWNER = 'OWNER',
  GENERAL_MANAGER = 'GENERAL_MANAGER',
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
  preferred_landing_view?: string | null;
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
  STAFF_TIME_OFF = 'STAFF_TIME_OFF',
  CUSTOMER = 'CUSTOMER'
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
  search?: string;
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
  linkedBanquetIds?: number[];
  banquetReminderHours?: number;
  autoKind?: string;
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

// ============================================
// INVENTORY TYPES
// ============================================

export enum InventoryArea {
  CUCINA = 'CUCINA',
  SALA = 'SALA',
  BAR = 'BAR'
}

// A storage location within an area — e.g. "Cella 1" / "Cella 2" for CUCINA,
// "Bancone" / "Magazzino" for BAR. Areas are fixed; locations are user-managed.
export interface InventoryLocation {
  id: number;
  area: InventoryArea;
  name: string;
  sort_order: number;
  created_at?: string;
}

// A category groups products within an area (e.g. "Verdure", "Pesce" for CUCINA).
// Categories are user-managed and optional.
export interface InventoryCategory {
  id: number;
  area: InventoryArea;
  name: string;
  sort_order: number;
  created_at?: string;
}

// A product belongs to one area (CUCINA / SALA / BAR) but its quantity is
// distributed across that area's locations.
export interface InventoryProduct {
  id: number;
  area: InventoryArea;
  name: string;
  unit?: string | null;
  notes?: string | null;
  category_id?: number | null;
  category_name?: string | null;
  created_at?: string;
}

// Per-(product, location) quantity. Returned aggregated by GET /inventory/stock.
export interface InventoryStockRow {
  product_id: number;
  location_id: number;
  quantity: number;
}

// One audit entry per carico/scarico operation. Sum of deltas == stock.
export enum InventoryMovementReason {
  CARICO = 'CARICO',          // stock in
  SCARICO = 'SCARICO',        // stock out (consumption)
  RETTIFICA = 'RETTIFICA',    // manual correction (set to specific value)
  TRASFERIMENTO = 'TRASFERIMENTO' // moved between cells
}

export interface InventoryMovement {
  id: number;
  product_id: number;
  location_id: number;
  delta: number;
  reason: InventoryMovementReason;
  notes?: string | null;
  user_id?: number | null;
  user_name?: string | null;
  created_at: string;
}

export interface StaffTimeOff {
  id: string;
  staffId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  type: TimeOffType;
  shift?: Shift | null; // null/undefined = full day; LUNCH or DINNER = single shift
  notes?: string;
  approved: boolean;
  createdAt?: string;
}