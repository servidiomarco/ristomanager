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
  x: number;
  y: number;
  room_id: number;
  status: TableStatus;
  is_locked?: boolean;
  merged_with?: number[];
  temp_lock_expires_at?: number;
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
}

export enum ViewState {
  DASHBOARD = 'DASHBOARD',
  FLOOR_PLAN = 'FLOOR_PLAN',
  MENU = 'MENU',
  RESERVATIONS = 'RESERVATIONS',
  SETTINGS = 'SETTINGS'
}