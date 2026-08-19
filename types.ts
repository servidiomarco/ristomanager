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
  discount_type?: 'PERCENT' | 'AMOUNT' | null;
  discount_value?: number | null;
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

export interface RoomClosedOverride {
  id: number;
  date: string; // YYYY-MM-DD
  shift: Shift;
  room_id: number;
}

export enum ArrivalStatus {
  WAITING = 'WAITING',      // In attesa — booking is live, party not yet here
  ARRIVED = 'ARRIVED',      // Arrivato — party seated, table occupied
  DEPARTING = 'DEPARTING',  // In uscita — still seated but wrapping up (dolce/caffè/conto); table not yet free
  DEPARTED = 'DEPARTED'     // Tavolo liberato — table is free again
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
  DECLINED = 'DECLINED',    // Staff couldn't accept the request (no availability) — customer notified via SMS
  NO_SHOW = 'NO_SHOW',      // Customer did not show up
  CANCELLED = 'CANCELLED'   // Cancelled by customer (e.g. via voice agent)
}

// Structured picks made through the note-preset picker (e.g. clicking
// "Stinco" and choosing quantity=2, variant="maiale"). Sits alongside the
// free-text `notes` field so the kitchen dashboard can aggregate reliably
// across a whole service, without regex-parsing operator prose.
export interface NoteSelection {
  preset_id: number;
  label: string;
  quantity: number;
  variant?: string | null;
}

export interface Reservation {
  id: number;
  customer_name: string;
  reservation_time: string;
  shift: Shift;
  guests: number;
  children?: number;
  /**
   * How long the party is expected to keep the table, in minutes. Drives the
   * time-window overlap check that enables double-seating on the same table
   * (e.g. an early sitting followed by a later one). NULL/undefined = fall
   * back to the shift default (90 lunch / 120 dinner).
   */
  duration_minutes?: number;
  table_id?: number;
  notes?: string;
  // Structured mirror of `notes` for note presets that use has_quantity
  // (e.g. "Stinco maiale ×2"). Plain-text quick-notes stay in `notes` only.
  note_selections?: NoteSelection[];
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
  customer_is_vip?: boolean;
  customer_preferred_table_id?: number | null;
  customer_preferred_table_name?: string | null;
  customer_dietary_notes?: string | null;
  customer_preferences_notes?: string | null;
  // GDPR consents captured at booking time (proof: what + when).
  consent_marketing?: boolean | null;
  consent_data_health?: boolean | null;
  consent_updated_at?: string | null;
  confirmation_status?: ConfirmationStatus | null;
  confirmation_channel?: ConfirmationChannel | null;
  confirmation_sent_at?: string | null;
  confirmation_delivered_at?: string | null;
  confirmation_error?: string | null;
  // Snapshot of the most recent payment_request for this reservation. Powers
  // the color-coded card icon: PENDING/AUTHORISED=amber (link inviato, in
  // attesa), COMPLETED=emerald (pagato online), FAILED/CANCELLED=rose,
  // EXPIRED=slate.
  latest_payment_id?: number | null;
  latest_payment_status?: PaymentRequestStatus | null;
  latest_payment_amount_cents?: number | null;
  latest_payment_currency?: string | null;
  latest_payment_provider?: string | null;
  latest_payment_delivery_channel?: ConfirmationChannel | null;
  latest_payment_created_at?: string | null;
  latest_payment_completed_at?: string | null;
}

export type ConfirmationStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered';
export type ConfirmationChannel = 'sms' | 'whatsapp';

export type PaymentRequestStatus = 'PENDING' | 'AUTHORISED' | 'COMPLETED' | 'CANCELLED' | 'FAILED' | 'EXPIRED';

// Gateway that created (and therefore owns) a payment. New payments go to
// whichever provider is active in Settings; existing rows keep the one
// recorded here, so a mid-flight order is always handled by the gateway that
// took it.
export type PaymentProviderName = 'revolut' | 'sumup';

export interface PaymentRequest {
  id: number;
  reservation_id: number | null;
  amount_cents: number;
  currency: string;
  description: string | null;
  status: PaymentRequestStatus;
  provider: PaymentProviderName;
  provider_order_id: string | null;
  checkout_url: string | null;
  delivery_channel: ConfirmationChannel | null;
  delivery_provider_sid: string | null;
  delivery_error: string | null;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  metadata: Record<string, any> | null;
  // Back-reference to the split this payment covers when the request was
  // opened from the pay-at-table flow. NULL for classic deposit/full-payment
  // requests created before or without a bill.
  table_bill_split_id: number | null;
}

// Pay-at-table + split-bill (Fase 1 MVP). One bill per conto aperto al
// tavolo; splits track how the guests decided to divvy it up. `items` is
// JSONB reserved for Fase 2 (Passepartout), unused today.
export type TableBillStatus =
  | 'OPEN'              // waiter opened the bill, guests can claim
  | 'LOCKED'            // reserved for future use (item-level split freeze)
  | 'SETTLED'           // sum(paid) == total, waiter hasn't closed yet
  | 'SETTLED_PARTIAL'   // waiter force-closed with residual paid off-band
  | 'CLOSED'            // closed on the POS / archived
  | 'VOIDED';           // cancelled, share_token rotated

// 'deposit' = l'acconto/caparra della prenotazione portato nel conto come quota
// PAID: abbassa il residuo senza toccare il totale. Non è un claim di un cliente.
export type SplitKind = 'equal_share' | 'fixed_amount' | 'per_item' | 'deposit';

export type SplitStatus =
  | 'CLAIMED'     // guest reserved the amount, gateway order pending
  | 'PAID'        // gateway confirmed
  | 'ABANDONED'   // TTL expired or gateway cancelled/failed
  | 'RELEASED'    // guest or waiter voluntarily rilasciato prima del pagamento
  | 'REFUNDED';   // rimborsato via gateway dopo il pagamento

export interface TableBillItem {
  name: string;
  qty: number;
  unit_price_cents: number;
  category?: string | null;
}

export interface TableBill {
  id: number;
  reservation_id: number | null;
  table_id: number | null;
  total_cents: number;
  covers: number;
  currency: string;
  items: TableBillItem[] | null;
  status: TableBillStatus;
  share_token: string | null;
  opened_at: string;
  closed_at: string | null;
  opened_by_user_id: number | null;
  closed_by_user_id: number | null;
  external_ref: string | null;
  cash_settled_cents: number;
  tip_cents: number;
  notes: string | null;
}

export interface TableBillSplit {
  id: number;
  table_bill_id: number;
  kind: SplitKind;
  amount_cents: number;
  item_ids: number[] | null;
  claimant_label: string | null;
  claimed_at: string;
  expires_at: string | null;
  payment_request_id: number | null;
  status: SplitStatus;
  paid_at: string | null;
  released_at: string | null;
}

// Aggregate response for `GET /reservations/:id/bill`. Sums are computed
// server-side so the UI doesn't have to re-derive them from `splits`.
export interface TableBillWithSplits {
  bill: TableBill;
  splits: TableBillSplit[];
  paid_cents: number;
  claimed_cents: number;
  // Acconto già versato sulla prenotazione portato nel conto. Già incluso in
  // paid_cents e già scalato dal residuo; esposto a parte per la riga "Acconto".
  deposit_credit_cents?: number;
  // Acconto TOTALE versato (importo pieno) e quota da rimborsare al cliente
  // quando la caparra supera il totale del conto.
  deposit_paid_cents?: number;
  refund_due_cents?: number;
  residual_cents: number;
}

// ============================================
// GESTIONALE DI SALA — comande
// ============================================
// La comanda dice cosa si sta preparando, il conto (TableBill) quanto si
// deve. Due macchine a stati separate — vedi docs/gestionale-sala-plan.md.

export interface Station {
  id: number;
  name: string;
  color?: string | null;
  sort_order: number;
  is_active: boolean;
}

export interface MenuPriceList {
  id: number;
  name: string;
  is_default: boolean;
  is_active: boolean;
  sort_order: number;
}

export interface ModifierGroup {
  id: number;
  name: string;
  min_select: number;
  max_select: number;
  sort_order: number;
}

export interface Modifier {
  id: number;
  group_id: number;
  name: string;
  price_delta_cents: number;
  is_active: boolean;
  sort_order: number;
}

// Snapshot del modificatore sulla riga: il prezzo di ieri non si muove se
// domani il listino cambia.
export interface OrderItemModifier {
  id?: number | null;
  name: string;
  price_delta_cents: number;
}

export type OrderStatus = 'OPEN' | 'CLOSED' | 'VOIDED';

// DRAFT   → il cameriere sta componendo, solo lui la vede
// QUEUED  → la sala ha proposto, la vede solo il passe
// SENT    → il passe ha lanciato, la vede la partita
// PREPARING / READY → la lavora il cuoco di partita
// SERVED  → la sala l'ha ritirata
// VOIDED  → stornata (richiede motivazione da SENT in poi)
export type OrderItemStatus =
  | 'DRAFT' | 'QUEUED' | 'SENT' | 'PREPARING' | 'READY' | 'SERVED' | 'VOIDED';

// Stato dell'uscita: derivato dalle righe, mai materializzato.
export type CourseStatus = 'PENDING' | 'QUEUED' | 'FIRED' | 'READY' | 'SERVED';

// Come vengono lanciate le uscite. AUTO_ALL finché il passe non esiste,
// AUTO_FIRST a regime, MANUAL per i banchetti.
export type CourseFireMode = 'AUTO_ALL' | 'AUTO_FIRST' | 'MANUAL';

export interface OrderItem {
  id: number;
  order_id: number;
  /** DISH = piatto, COVER = coperto, SERVICE = servizio. Le righe di
   *  sistema non vanno mai in cucina ma pesano sul conto. */
  line_kind?: 'DISH' | 'COVER' | 'SERVICE';
  dish_id: number | null;
  name_snapshot: string;
  unit_price_cents: number;
  modifiers: OrderItemModifier[] | null;
  qty: number;
  course_no: number;
  seat_no?: number | null;
  station_id: number | null;
  status: OrderItemStatus;
  note?: string | null;
  queued_at?: string | null;
  fired_at?: string | null;
  station_start_at?: string | null;
  started_at?: string | null;
  ready_at?: string | null;
  served_at?: string | null;
  voided_at?: string | null;
  voided_by_user_id?: number | null;
  void_reason?: string | null;
  created_by_user_id?: number | null;
  created_at?: string;
  /** (unit_price_cents + Σ modifiers) * qty. Calcolato server-side. */
  line_total_cents?: number;
}

export interface Order {
  id: number;
  reservation_id: number | null;
  table_id: number | null;
  table_bill_id: number | null;
  order_type: 'DINE_IN' | 'TAKEAWAY';
  price_list_id: number | null;
  covers: number;
  status: OrderStatus;
  opened_by_user_id?: number | null;
  closed_by_user_id?: number | null;
  opened_at?: string;
  closed_at?: string | null;
  notes?: string | null;
  discount_type?: 'PERCENT' | 'AMOUNT' | null;
  discount_value?: number | null;
  discount_reason?: string | null;
}

export interface OrderCourse {
  course_no: number;
  status: CourseStatus;
  items: OrderItem[];
  total_cents: number;
}

// Risposta di GET /orders/:id — i totali sono calcolati dal server così la
// UI non li ri-deriva (e non può sbagliarli).
export interface OrderWithItems {
  order: Order;
  items: OrderItem[];
  courses: OrderCourse[];
  /** Somma delle righe non stornate, prima dello sconto. */
  subtotal_cents: number;
  discount_cents: number;
  /** Quanto si deve davvero. */
  total_cents: number;
  voided_cents: number;
}

export interface Notification {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  timestamp: Date;
  read: boolean;
  reservationId?: number;
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
  COMANDE = 'COMANDE',
  CUCINA = 'CUCINA',
  PASSE = 'PASSE',
  RESERVATIONS = 'RESERVATIONS',
  RECEPTION = 'RECEPTION',
  ATTIVITA = 'ATTIVITA',
  LISTA_DELLA_SPESA = 'LISTA_DELLA_SPESA',
  HACCP = 'HACCP',
  CONVERSAZIONI = 'CONVERSAZIONI',
  MESSAGGI = 'MESSAGGI',
  EMAIL = 'EMAIL',
  NOTIFICHE = 'NOTIFICHE',
  STAFF = 'STAFF',
  CLIENTI = 'CLIENTI',
  INVENTARIO = 'INVENTARIO',
  USERS = 'USERS',
  SETTINGS = 'SETTINGS',
  PAGAMENTI = 'PAGAMENTI',
  MONITORING = 'MONITORING',
  DEVELOPMENT = 'DEVELOPMENT'
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
  preferred_table_id?: number | null;
  preferences_notes?: string | null;
  dietary_notes?: string | null;
  is_vip?: boolean;
  consent_marketing?: boolean | null;
  consent_marketing_updated_at?: string | null;
}

// ============================================
// USER & AUTHENTICATION TYPES
// ============================================

export enum UserRole {
  OWNER = 'OWNER',
  GENERAL_MANAGER = 'GENERAL_MANAGER',
  MANAGER = 'MANAGER',
  RECEPTION = 'RECEPTION',
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
  // Ristorante di appartenenza (Fase B2). Opzionale: gli elenchi utenti
  // non lo caricano, login e /auth/me sì. `features` sono gli entitlements
  // commerciali (Fase C1): quali add-on il ristorante ha comprato. Il
  // gating della UI su questi flag arriva con la Fase D (wizard D1).
  tenant?: {
    id: number;
    slug: string;
    name: string;
    features?: { voice: boolean; whatsapp: boolean; web_booking: boolean };
  };
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
  CUSTOMER = 'CUSTOMER',
  ORDER = 'ORDER',
  SETTINGS = 'SETTINGS'
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