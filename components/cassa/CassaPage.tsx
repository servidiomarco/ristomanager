import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Customer, Dish, RestaurantMenu, OrderItem, OrderWithItems, Reservation, Room, Table } from '../../types';
import { ArrivalStatus, PaymentStatus, ReservationSource, ReservationStatus } from '../../types';
import type { CashSessionView, CashTransactionsView } from '../../types';
import { Shift } from '../../types';
import { getRomeDatePart } from '../../utils/reservationTime';
import { getTableMerges } from '../../services/apiService';
import {
  ordersApiService, getOpenOrderTables, getMenuCatalogue, newIdempotencyKey,
  updateOrder, voidItem, closeOrder, setOrderDiscount,
  type MenuCatalogue, type NewOrderItem, type ServiceBill,
} from '../../services/ordersApiService';
import { billsApiService, getOpenBills, printBill, type OpenBillRow } from '../../services/billsApiService';
import { cashApiService } from '../../services/cashApiService';
import { socketClient } from '../../services/socketClient';
import { useOpenBills } from '../pagamenti/useOpenBills';
import { VariantSheet } from '../VariantSheet';
import { BillSheet, type SettleOpts } from '../pagamenti/BillSheet';
import {
  buildMergeGroups, buildRows, makeReservationForTable, type TableFilter,
} from '../comande/tablesView';
import { ReasonDialog } from '../comande/ReasonDialog';
import { cartKey, type CartLine } from '../comande/orderView';
import { CodaServizio } from './CodaServizio';
import { SelezionaTavolo } from './SelezionaTavolo';
import { TavoloAttivo } from './TavoloAttivo';
import { Pagamento } from './Pagamento';
import { DividiConto } from './DividiConto';
import { EsitoChiusura, esitoOf, type Esito } from './EsitoChiusura';
import { Transazioni } from './Transazioni';
import { ClienteVisita } from './ClienteVisita';
import { CustomerPickerModal } from '../CustomerPickerModal';
import { DiscountDialog } from '../comande/DiscountDialog';
import { createReservation } from '../../services/apiService';
import { FondoEChiusura } from './FondoEChiusura';
import { printCashClosure } from '../../utils/printCashClosure';
import { useAuth } from '../../contexts/AuthContext';
import { buildQueue, tablesInService } from './cassaView';

/* ── Cassa ────────────────────────────────────────────────────────────────
   Il banco del cassiere: la coda dei conti del servizio, il tavolo, l'incasso.
   Vedi docs/cassa-plan.md.

   Il modulo NON possiede lo scope del servizio: data e turno arrivano dalla
   barra globale, come per Comande, Cucina e Passe. Il selettore di servizio
   dentro al titolo, nei mockup, era un errore del mockup.

   Questo file tiene lo stato e le chiamate; come si leggono le schermate sta
   nei componenti accanto. */

interface CassaPageProps {
  dishes: Dish[];
  /** Serve solo Alla carta: la griglia batte gli stessi piatti di Comande. */
  menus: RestaurantMenu[];
  tables: Table[];
  rooms: Room[];
  reservations: Reservation[];
  globalDate: Date;
  globalShiftFilter: 'ALL' | 'LUNCH' | 'DINNER';
  /** Dentro un tavolo il telefono serve tutto alla cassa. */
  onImmersive?: (on: boolean) => void;
  /** Apre Comande sul tavolo: uscite e lanci restano di là (scorciatoia). */
  onOpenInComande?: (tableId: number) => void;
  /** Apre Pagamenti · Chiusura: il riscontro per documento vive di là. */
  onOpenPagamenti?: () => void;
}

type Screen = 'queue' | 'tables' | 'table' | 'payment' | 'split' | 'esito' | 'transazioni' | 'cassetto';

export const CassaPage: React.FC<CassaPageProps> = ({
  dishes: allDishes, menus, tables, rooms, reservations, globalDate, globalShiftFilter, onImmersive, onOpenInComande, onOpenPagamenti,
}) => {
  const [screen, setScreen] = useState<Screen>('queue');
  const [roomId, setRoomId] = useState<string>('ALL');
  const [tablesView, setTablesView] = useState<'griglia' | 'piantina'>('griglia');
  const [filter, setFilter] = useState<TableFilter>('ALL');
  const [query, setQuery] = useState('');
  const [busyBillId, setBusyBillId] = useState<number | null>(null);
  const [session, setSession] = useState<CashSessionView | null>(null);
  const [openTables, setOpenTables] = useState<Set<number>>(new Set());
  const [serviceBills, setServiceBills] = useState<Map<number, ServiceBill>>(new Map());
  const [tableMerges, setTableMerges] = useState<any[]>([]);
  const [openBill, setOpenBill] = useState<OpenBillRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Il tavolo aperto e la sua comanda.
  const [tableId, setTableId] = useState<number | null>(null);
  const [order, setOrder] = useState<OrderWithItems | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [catalogue, setCatalogue] = useState<MenuCatalogue | null>(null);
  const [dishQuery, setDishQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [voidTarget, setVoidTarget] = useState<OrderItem | null>(null);
  const [payingBill, setPayingBill] = useState<OpenBillRow | null>(null);
  const [fiscalReady, setFiscalReady] = useState(false);
  // L'importo scelto in «Dividi conto»: precompila il pannello di incasso.
  const [quotaCents, setQuotaCents] = useState<number | null>(null);
  const [esito, setEsito] = useState<{ kind: Esito; bill: OpenBillRow } | null>(null);

  // L'emissione dello scontrino è asincrona: l'esito si apre spesso col
  // documento ancora PENDING. Quando la conferma arriva via socket, i campi
  // fiscali della schermata si aggiornano da soli — è il momento in cui
  // compare il QR per l'ospite, col cliente ancora davanti alla cassa.
  useEffect(() => {
    const socket = socketClient.getSocket();
    if (!socket) return;
    const onFiscal = (p: any) => {
      const doc = p?.doc;
      if (!doc || !p?.bill_id) return;
      setEsito(prev => prev && prev.bill.id === p.bill_id
        ? {
            ...prev,
            bill: {
              ...prev.bill,
              fiscal_status: doc.status ?? prev.bill.fiscal_status,
              fiscal_doc_type: doc.doc_type ?? prev.bill.fiscal_doc_type,
              fiscal_doc_number: doc.doc_number ?? prev.bill.fiscal_doc_number,
              fiscal_ref: doc.provider_ref ?? prev.bill.fiscal_ref,
              fiscal_provider: doc.provider ?? prev.bill.fiscal_provider,
              fiscal_public_token: doc.public_token ?? prev.bill.fiscal_public_token,
            },
          }
        : prev);
    };
    socket.on('fiscal:updated', onFiscal);
    return () => { socket.off('fiscal:updated', onFiscal); };
  }, []);
  const [tx, setTx] = useState<CashTransactionsView | null>(null);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [txLoading, setTxLoading] = useState(false);

  // Contare il cassetto è della direzione: senza il permesso la schermata
  // resta leggibile ma non si tocca (il server rifiuta comunque).
  const { hasPermission } = useAuth();
  const canCloseSession = hasPermission('cash:close_session');

  useEffect(() => {
    billsApiService.getFiscalSettings()
      .then(f => setFiscalReady(f.provider !== 'none'))
      .catch(() => setFiscalReady(false));
  }, []);

  // I piatti spenti restano in anagrafica per lo storico ma non si battono
  // più: stesso filtro di Comande, così le due griglie mostrano lo stesso
  // menu — incluso il perimetro Alla carta (le liste banchetti e i menu
  // stagionali non si battono nemmeno qui).
  const cartaMenuId = useMemo(() => menus.find(m => m.system_key === 'ALLA_CARTA')?.id ?? null, [menus]);
  const dishes = useMemo(() => allDishes.filter(d => d.is_active !== false
    && (cartaMenuId == null || !Array.isArray(d.menu_ids) || d.menu_ids.includes(cartaMenuId))), [allDishes, cartaMenuId]);

  useEffect(() => {
    getMenuCatalogue().then(setCatalogue).catch(() => setCatalogue(null));
  }, []);

  // Varianti o ingredienti cambiati in gestione menu: il catalogo si
  // ricarica da solo, senza reload di pagina.
  useEffect(() => {
    const socket = socketClient.getSocket();
    if (!socket) return;
    const onCatalogue = () => { getMenuCatalogue().then(setCatalogue).catch(() => {}); };
    socket.on('catalogue:updated', onCatalogue);
    return () => { socket.off('catalogue:updated', onCatalogue); };
  }, []);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const d of dishes) if (d.category) seen.add(d.category);
    return [...seen].sort();
  }, [dishes]);

  useEffect(() => {
    if (category === null && categories.length > 0) setCategory(categories[0]);
  }, [categories, category]);

  // Varianti di un piatto, risolte dal catalogo — stessa derivazione di
  // Comande: il legame piatto→gruppi sta in `dish_modifier_groups`.
  const groupsForDish = useCallback((dishId: number) => {
    if (!catalogue) return [];
    const ids = catalogue.dish_modifier_groups.filter(l => l.dish_id === dishId).map(l => l.group_id);
    return catalogue.modifier_groups.filter(g => ids.includes(g.id));
  }, [catalogue]);

  const componentsForDish = useCallback(
    (dishId: number) => (catalogue?.dish_components ?? []).filter(c => c.dish_id === dishId),
    [catalogue]
  );

  // Il foglio serve anche ai composti senza gruppi (ingredienti da togliere)
  // e, soprattutto, ai gruppi obbligatori: senza foglio la cassa manderebbe
  // il piatto nudo e la validazione min del server risponderebbe 400.
  const needsVariantSheet = useCallback(
    (dishId: number) => groupsForDish(dishId).length > 0
      || (dishes.find(d => d.id === dishId)?.dish_type === 'COMPOSED' && componentsForDish(dishId).length > 0)
      // Al peso: i grammi si chiedono nel foglio, il server li pretende.
      || dishes.find(d => d.id === dishId)?.sold_by_weight === true,
    [groupsForDish, componentsForDish, dishes]
  );
  const [variantFor, setVariantFor] = useState<Dish | null>(null);

  const selectedDateRome = useMemo(() => getRomeDatePart(globalDate), [globalDate]);

  const serviceFilter = useMemo(() => ({
    service_date: selectedDateRome,
    shift: globalShiftFilter !== 'ALL' ? globalShiftFilter : undefined,
  }), [selectedDateRome, globalShiftFilter]);

  const serviceQuery = useMemo(() => ({
    date: selectedDateRome,
    shift: globalShiftFilter !== 'ALL' ? (globalShiftFilter as 'LUNCH' | 'DINNER') : undefined,
  }), [selectedDateRome, globalShiftFilter]);

  const serviceLabel = useMemo(() => {
    const turno = globalShiftFilter === 'LUNCH' ? 'Pranzo'
      : globalShiftFilter === 'DINNER' ? 'Cena' : 'Servizio';
    return `${turno} · ${globalDate.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })}`;
  }, [globalShiftFilter, globalDate]);

  const bills = useOpenBills(serviceFilter, 'open');
  const queue = useMemo(() => buildQueue(bills.bills), [bills.bills]);

  /* ── Sessione di cassa ───────────────────────────────────────────────── */

  const reloadSession = useCallback(async () => {
    try {
      setSession(await cashApiService.getSession(serviceFilter));
    } catch {
      // La coda vive anche senza: i totali del cassetto sono un di più
      // rispetto ai conti, che sono il lavoro.
      setSession(null);
    }
  }, [serviceFilter]);

  useEffect(() => { reloadSession(); }, [reloadSession]);

  useEffect(() => {
    const socket = socketClient.getSocket();
    const onChange = () => { reloadSession(); };
    const events = [
      'bill:payment-recorded', 'bill:payment-voided', 'bill:closed', 'bill:settled',
      'cash:session-opened', 'cash:session-closed',
    ];
    events.forEach(e => socket?.on(e, onChange));
    return () => { events.forEach(e => socket?.off(e, onChange)); };
  }, [reloadSession]);

  /* ── Stato dei tavoli ────────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    const shifts: Shift[] = globalShiftFilter === 'ALL'
      ? [Shift.LUNCH, Shift.DINNER]
      : [globalShiftFilter as Shift];
    Promise.all(shifts.map(s => getTableMerges(selectedDateRome, s)))
      .then(results => { if (!cancelled) setTableMerges(results.flat()); })
      .catch(() => { if (!cancelled) setTableMerges([]); });
    return () => { cancelled = true; };
  }, [selectedDateRome, globalShiftFilter]);

  const mergeGroups = useMemo(() => buildMergeGroups(tableMerges), [tableMerges]);
  const reservationForTable = useMemo(
    () => makeReservationForTable(reservations, selectedDateRome, globalShiftFilter, mergeGroups),
    [reservations, selectedDateRome, globalShiftFilter, mergeGroups]
  );

  // Quali tavoli hanno una comanda aperta, e quali un conto. Servono a
  // entrambe le schermate — il contatore «tavoli in servizio» in testa alla
  // coda li conta tutti e due — quindi si caricano sempre, non solo quando il
  // selettore è aperto: contarli a metà darebbe un numero più basso del vero
  // senza dirlo.
  //
  // Una chiamata sola per i tavoli con comanda (GET /orders/open): la via per
  // tavolo che usa la griglia di Comande costerebbe sessanta richieste.
  const reloadTableState = useCallback(async () => {
    const [orders, bills] = await Promise.allSettled([
      getOpenOrderTables(serviceQuery),
      ordersApiService.getTablesBillsStatus(serviceQuery),
    ]);
    if (orders.status === 'fulfilled') setOpenTables(new Set(orders.value.table_ids));
    if (bills.status === 'fulfilled') {
      setServiceBills(new Map(bills.value.bills.map(b => [b.table_id, b])));
    }
  }, [serviceQuery]);

  useEffect(() => { reloadTableState(); }, [reloadTableState]);

  useEffect(() => {
    const socket = socketClient.getSocket();
    const onChange = () => { reloadTableState(); };
    const events = ['order:created', 'order:updated', 'bill:opened', 'bill:closed', 'bill:voided'];
    events.forEach(e => socket?.on(e, onChange));
    return () => { events.forEach(e => socket?.off(e, onChange)); };
  }, [reloadTableState]);

  const billTables = useMemo(() => new Set(serviceBills.keys()), [serviceBills]);
  const rows = useMemo(
    () => buildRows(tables, openTables, billTables, reservationForTable, mergeGroups, globalShiftFilter),
    [tables, openTables, billTables, reservationForTable, mergeGroups, globalShiftFilter]
  );

  const inService = useMemo(
    () => tablesInService(tables, bills.bills, openTables),
    [tables, bills.bills, openTables]
  );

  /* ── Azioni ──────────────────────────────────────────────────────────── */

  // Fuori dalla coda la chrome dell'app si toglie di mezzo, come in Comande.
  useEffect(() => {
    onImmersive?.(screen !== 'queue');
    return () => onImmersive?.(false);
  }, [screen, onImmersive]);

  const settle = useCallback(async (bill: OpenBillRow, opts?: SettleOpts) => {
    setBusyBillId(bill.id);
    setError(null);
    try {
      const closed = await billsApiService.closeBill(bill.id, opts ?? {});
      await Promise.all([bills.reload(), reloadSession(), reloadTableState()]);
      setOpenBill(null);
      // L'esito si legge dai conti chiusi: l'emissione del documento è
      // asincrona e non blocca la chiusura, quindi lo stato fiscale arriva
      // dalla riga ricaricata, non da quello che sapevamo prima.
      const closedRows = await getOpenBills(serviceFilter, { status: 'closed' });
      const row = closedRows.bills.find(b => b.id === bill.id);
      const kind = esitoOf(
        { status: closed.status },
        row?.fiscal_status ?? null,
        row?.fiscal_doc_type ?? null,
      );
      setEsito({ kind, bill: row ?? { ...bill, closed_at: closed.closed_at } });
      setScreen('esito');
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Chiusura non riuscita');
    } finally {
      setBusyBillId(null);
    }
  }, [bills, reloadSession, reloadTableState, serviceFilter]);

  const applyDiscount = useCallback(async (
    p: { discount_type: 'PERCENT' | 'AMOUNT'; discount_value: number; reason: string } | null,
  ) => {
    if (!order) return;
    setBusyBillId(-1); setError(null);
    try {
      setOrder(await setOrderDiscount(order.order.id, p));
      setDiscountOpen(false);
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Sconto non applicato');
    } finally { setBusyBillId(null); }
  }, [order]);

  /** Associare un cliente a un walk-in CREA la visita: nel modello la visita è
   *  la prenotazione, quindi si apre una prenotazione «adesso», già seduta, e
   *  la si aggancia alla comanda. Con una prenotazione già presente si cambia
   *  solo il nome sul posto. */
  const associateCustomer = useCallback(async (customer: Customer) => {
    if (!order || tableId == null) return;
    setBusyBillId(-1); setError(null);
    try {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const created = await createReservation({
        customer_name: customer.name,
        reservation_time: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`,
        shift: now.getHours() < 16 ? Shift.LUNCH : Shift.DINNER,
        guests: order.order.covers,
        phone: customer.phone ?? undefined,
        table_id: tableId,
        payment_status: PaymentStatus.PENDING,
        arrival_status: ArrivalStatus.ARRIVED,
        reservation_status: ReservationStatus.CONFIRMED,
        source: ReservationSource.MANUAL,
      } as any);
      setOrder(await updateOrder(order.order.id, { reservation_id: created.id }));
      setPickerOpen(false);
      setCustomerOpen(false);
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Cliente non associato');
    } finally { setBusyBillId(null); }
  }, [order, tableId]);

  const detachCustomer = useCallback(async () => {
    if (!order) return;
    setBusyBillId(-1); setError(null);
    try {
      // Si stacca la comanda dalla prenotazione, non si cancella niente: la
      // prenotazione resta nel suo servizio, con la sua storia.
      setOrder(await updateOrder(order.order.id, { reservation_id: null }));
      setCustomerOpen(false);
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Cliente non rimosso');
    } finally { setBusyBillId(null); }
  }, [order]);

  const loadTransactions = useCallback(async () => {
    setTxLoading(true);
    try {
      setTx(await cashApiService.getTransactions(serviceFilter));
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Movimenti non caricati');
    } finally {
      setTxLoading(false);
    }
  }, [serviceFilter]);

  const backToQueue = useCallback(() => {
    setEsito(null);
    setPayingBill(null);
    setQuotaCents(null);
    setOrder(null);
    setTableId(null);
    setError(null);
    setScreen('queue');
  }, []);

  const isTodayRome = selectedDateRome === getRomeDatePart(new Date());

  /* ── Il tavolo aperto ────────────────────────────────────────────────── */

  const loadTable = useCallback(async (id: number) => {
    setBusyBillId(-1);
    setError(null);
    try {
      let view = await ordersApiService.getOrderByTable(id, serviceQuery);
      if (!view) {
        // Nei servizi passati si riprende, non si crea: il server marcherebbe
        // comunque la comanda nuova sul servizio in corso, e il cassiere
        // crederebbe di averla aperta nel giorno che sta guardando.
        if (!isTodayRome) {
          setError('Nessuna comanda in questo servizio. Le comande nuove si aprono solo nel servizio corrente.');
          return;
        }
        const res = reservationForTable(id);
        // I coperti dalla prenotazione; per un walk-in i posti del tavolo. Uno
        // è quasi sempre sbagliato, e il numero pesa sul coperto e sullo split.
        const covers = res?.guests ?? tables.find(t => t.id === id)?.seats;
        view = await ordersApiService.openOrder(
          { table_id: id, reservation_id: res?.id, covers },
          newIdempotencyKey(),
        );
      }
      setOrder(view);
      setTableId(id);
      setCart([]);
      setDishQuery('');
      setScreen('table');
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Tavolo non aperto');
    } finally {
      setBusyBillId(null);
    }
  }, [serviceQuery, isTodayRome, reservationForTable, tables]);

  const pushLine = useCallback((
    dish: Dish, entries: { id: number; n: number }[] = [], labels: string[] = [], delta = 0,
    note?: string, removedIds: number[] = [], weightGrams?: number,
  ) => {
    // Le bozze restano locali fino all'invio, come in Comande: una sola
    // chiamata di rete invece di una per piatto. Verso, ripetizioni e
    // ingredienti tolti entrano in chiave come là. Al peso ogni pezzo è
    // una riga (qty 1 per il server): la chiave porta l'idem e non fonde.
    const idem = newIdempotencyKey();
    const key = cartKey(
      dish.id, 1,
      [...entries.map(e => `${e.id}x${e.n}`), ...removedIds.map(id => `r${id}`),
       ...(weightGrams != null ? [`w${weightGrams}#${idem}`] : [])],
      note,
    );
    setCart(prev => {
      const at = prev.findIndex(l => l.key === key);
      if (at >= 0) {
        const next = [...prev];
        next[at] = { ...next[at], qty: next[at].qty + 1 };
        return next;
      }
      return [...prev, {
        key, idem, dish, qty: 1, course_no: 1,
        modifier_ids: entries.map(e => e.id),
        modifiers: entries,
        ...(removedIds.length > 0 ? { removed_component_ids: removedIds } : {}),
        ...(weightGrams != null ? { weight_grams: weightGrams } : {}),
        modifier_labels: labels,
        modifier_delta_cents: delta, note,
      }];
    });
  }, []);

  // Conferma dal foglio varianti: etichette e delta cotti come in Comande —
  // le percentuali si mostrano risolte sul prezzo di anagrafica, il conto
  // vero lo rifà il server sul prezzo battuto.
  const addWithVariants = useCallback((dish: Dish, entries: { id: number; n: number }[], removedIds: number[], note?: string, weightGrams?: number) => {
    const byId = new Map(groupsForDish(dish.id).flatMap(g => g.modifiers).map(m => [m.id, m]));
    const chosen = entries.filter(e => byId.has(e.id));
    const deltaOf = (m: { price_delta_cents: number; price_delta_pct: string | null }) =>
      m.price_delta_pct != null
        ? Math.round(Math.round(Number(dish.price) * 100) * Number(m.price_delta_pct) / 100)
        : m.price_delta_cents;
    const signedLabel = (name: string, n: number) =>
      n === 1 ? name : n > 0 ? `${'+'.repeat(n)} ${name}` : `${'-'.repeat(-n)} ${name}`;
    const comps = componentsForDish(dish.id);
    const removed = removedIds
      .map(id => comps.find(c => c.id === id))
      .filter((c): c is NonNullable<typeof c> => c != null);
    pushLine(
      dish, chosen,
      [...chosen.map(e => signedLabel(byId.get(e.id)!.name, e.n)), ...removed.map(c => `Senza ${c.name}`)],
      chosen.reduce((s, e) => s + e.n * deltaOf(byId.get(e.id)!), 0)
        + removed.reduce((s, c) => s + c.removal_delta_cents, 0),
      note,
      removed.map(c => c.id),
      dish.sold_by_weight ? (weightGrams ?? 500) : undefined,
    );
  }, [groupsForDish, componentsForDish, pushLine]);

  const changeQty = useCallback((key: string, delta: number) => {
    setCart(prev => prev.flatMap(l => {
      if (l.key !== key) return [l];
      const qty = l.qty + delta;
      // A zero la riga sparisce: la cucina non l'ha vista, non c'è niente da
      // stornare e nessuna conferma da chiedere.
      return qty <= 0 ? [] : [{ ...l, qty }];
    }));
  }, []);

  const sendDrafts = useCallback(async (current: OrderWithItems): Promise<OrderWithItems> => {
    if (cart.length === 0) return current;
    const payload: NewOrderItem[] = cart.map(l => ({
      dish_id: l.dish.id,
      qty: l.qty,
      course_no: l.course_no,
      modifier_ids: l.modifier_ids,
      ...(l.modifiers ? { modifiers: l.modifiers } : {}),
      ...(l.removed_component_ids?.length ? { removed_component_ids: l.removed_component_ids } : {}),
      ...(l.weight_grams != null ? { weight_grams: l.weight_grams } : {}),
      note: l.note ?? null,
      idempotency_key: l.idem,
    }));
    const key = newIdempotencyKey();
    await ordersApiService.addItems(current.order.id, payload, key);
    const sent = await ordersApiService.send(current.order.id, undefined, key);
    setCart([]);
    setOrder(sent);
    return sent;
  }, [cart]);

  const goToPayment = useCallback(async () => {
    if (!order) return;
    setBusyBillId(-1);
    setError(null);
    try {
      // Nessuna bozza arriva al pagamento: non si incassa una riga che la
      // cucina non ha visto, e così totale, proforma e documento non possono
      // divergere (docs/cassa-plan.md §10).
      await sendDrafts(order);
      // Chiudere la comanda genera il conto dalle righe: da qui in poi si
      // ragiona in denaro, non in piatti.
      const closed = await closeOrder(order.order.id);
      await Promise.all([bills.reload(), reloadTableState()]);
      const fresh = await getOpenBills(serviceFilter, { status: 'open' });
      const row = fresh.bills.find(b => b.id === closed.bill?.id)
        ?? fresh.bills.find(b => b.table_id === tableId);
      if (!row) {
        setError('Conto non trovato dopo la chiusura della comanda.');
        return;
      }
      setPayingBill(row);
      setScreen('payment');
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Invio non riuscito');
    } finally {
      setBusyBillId(null);
    }
  }, [order, sendDrafts, bills, reloadTableState, serviceFilter, tableId]);

  const changeCovers = useCallback(async (delta: number) => {
    if (!order) return;
    const next = Math.max(1, order.order.covers + delta);
    if (next === order.order.covers) return;
    setBusyBillId(-1);
    try {
      setOrder(await updateOrder(order.order.id, { covers: next }));
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Coperti non aggiornati');
    } finally {
      setBusyBillId(null);
    }
  }, [order]);

  const doVoid = useCallback(async (item: OrderItem, reason: string) => {
    setBusyBillId(-1);
    try {
      setOrder(await voidItem(item.id, reason));
      setVoidTarget(null);
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Storno non riuscito');
    } finally {
      setBusyBillId(null);
    }
  }, []);

  const pickTable = useCallback((id: number) => {
    // Un tavolo con un conto da incassare apre IL CONTO, non una comanda
    // nuova: toccarlo per incassare non deve far ripartire il servizio.
    const bill = bills.bills.find(b => b.table_id === id && b.residual_cents > 0);
    if (bill) {
      setOpenBill(bill);
      return;
    }
    loadTable(id);
  }, [bills.bills, loadTable]);

  return (
    <>
      {screen === 'queue' ? (
        <CodaServizio
          queue={queue}
          session={session}
          tables={inService}
          loading={bills.loading}
          error={error ?? bills.error}
          busyBillId={busyBillId}
          onSelectTable={() => { setError(null); setScreen('tables'); }}
          onOpenBill={setOpenBill}
          onCollect={bill => { setPayingBill(bill); setError(null); setScreen('payment'); }}
          onTransactions={() => { setError(null); setScreen('transazioni'); loadTransactions(); }}
          onCashDrawer={() => { setError(null); setScreen('cassetto'); reloadSession(); }}
        />
      ) : screen === 'transazioni' ? (
        <Transazioni
          data={tx}
          loading={txLoading}
          error={error}
          onBack={backToQueue}
          onOpenBill={billId => {
            const row = bills.bills.find(b => b.id === billId);
            if (row) setOpenBill(row);
          }}
        />
      ) : screen === 'cassetto' ? (
        <FondoEChiusura
          view={session}
          loading={session == null}
          error={error}
          busy={busyBillId != null}
          canClose={canCloseSession}
          onOpenGiornale={onOpenPagamenti}
          onBack={backToQueue}
          onOpen={async cents => {
            setBusyBillId(-1); setError(null);
            try { setSession(await cashApiService.openSession(cents, serviceFilter)); }
            catch (err: any) { setError(err?.data?.error ?? err?.message ?? 'Cassa non aperta'); }
            finally { setBusyBillId(null); }
          }}
          onUpdateFloat={async cents => {
            if (!session?.session) return;
            setBusyBillId(-1); setError(null);
            try { setSession(await cashApiService.updateFloat(session.session.id, cents)); }
            catch (err: any) { setError(err?.data?.error ?? err?.message ?? 'Fondo non aggiornato'); }
            finally { setBusyBillId(null); }
          }}
          onClose={async (cents, note) => {
            if (!session?.session) return;
            setBusyBillId(-1); setError(null);
            try { setSession(await cashApiService.closeSession(session.session.id, cents, note)); }
            catch (err: any) {
              // Il 400 della nota obbligatoria porta l'atteso RICALCOLATO dal
              // server: fra l'apertura della schermata e questo click può
              // essere entrato un incasso, e quello buono è il suo.
              setError(err?.data?.error ?? err?.message ?? 'Chiusura non riuscita');
              reloadSession();
            }
            finally { setBusyBillId(null); }
          }}
          onPrint={() => { if (session) printCashClosure(session); }}
        />
      ) : screen === 'esito' && esito ? (
        <EsitoChiusura
          esito={esito.kind}
          totalCents={esito.bill.total_cents}
          tableName={esito.bill.table_name}
          closedAt={esito.bill.closed_at ?? null}
          docNumber={esito.bill.fiscal_doc_number ?? esito.bill.fiscal_ref ?? null}
          receiptToken={esito.bill.fiscal_status === 'CONFIRMED'
            && esito.bill.fiscal_doc_type === 'RECEIPT'
            && esito.bill.fiscal_provider !== 'passepartout'
            ? esito.bill.fiscal_public_token ?? null : null}
          // Niente try/catch: successo ed errore li mostra il bottone stesso,
          // vicino al dito — l'errore di pagina qui non si vede.
          onPrintReceipt={() => printBill(esito.bill.id, 'SCONTRINO')}
          busy={busyBillId != null}
          onRetryDocument={async () => {
            setBusyBillId(esito.bill.id);
            try { await billsApiService.emitFiscalDoc(esito.bill.id); backToQueue(); }
            catch (err: any) { setError(err?.data?.error ?? err?.message ?? 'Emissione non riuscita'); }
            finally { setBusyBillId(null); }
          }}
          onMarkProforma={async () => {
            setBusyBillId(esito.bill.id);
            try { await billsApiService.markProforma(esito.bill.id); backToQueue(); }
            catch (err: any) { setError(err?.data?.error ?? err?.message ?? 'Non riuscito'); }
            finally { setBusyBillId(null); }
          }}
          onIssueReceipt={async () => {
            setBusyBillId(esito.bill.id);
            try { await billsApiService.emitFiscalDoc(esito.bill.id); backToQueue(); }
            catch (err: any) { setError(err?.data?.error ?? err?.message ?? 'Emissione non riuscita'); }
            finally { setBusyBillId(null); }
          }}
          onIssueInvoice={() => {
            // La fattura vuole il cessionario: si emette dal conto in
            // Pagamenti, dove c'è il picker cliente e i dati di fatturazione.
            setError('La fattura si emette dal conto, in Pagamenti: servono i dati del cliente.');
          }}
          onReopen={async () => {
            setBusyBillId(esito.bill.id);
            try {
              await billsApiService.reopenBill(esito.bill.id);
              await Promise.all([bills.reload(), reloadSession(), reloadTableState()]);
              backToQueue();
            } catch (err: any) {
              setError(err?.data?.error ?? err?.message ?? 'Riapertura non riuscita');
            } finally { setBusyBillId(null); }
          }}
          onBackToQueue={backToQueue}
        />
      ) : screen === 'split' && payingBill ? (
        <DividiConto
          bill={payingBill}
          residualCents={payingBill.residual_cents}
          onBack={() => setScreen('payment')}
          onUseAmount={cents => { setQuotaCents(cents); setScreen('payment'); }}
        />
      ) : screen === 'payment' && payingBill ? (
        <Pagamento
          bill={payingBill}
          busy={busyBillId != null}
          error={error}
          fiscalReady={fiscalReady}
          onBack={() => { setScreen(order ? 'table' : 'queue'); setError(null); }}
          onSettle={opts => settle(payingBill, opts)}
          quotaCents={quotaCents}
          onSplit={() => setScreen('split')}
          onShowQr={() => setOpenBill(payingBill)}
        />
      ) : screen === 'table' && order ? (
        <TavoloAttivo
          tableName={tables.find(t => t.id === tableId)?.name ?? '—'}
          reservation={tableId != null ? reservationForTable(tableId) : null}
          order={order}
          cart={cart}
          dishes={dishes}
          categories={categories}
          category={category}
          onCategory={setCategory}
          query={dishQuery}
          onQuery={setDishQuery}
          hasVariants={needsVariantSheet}
          busy={busyBillId != null}
          error={error}
          serviceLabel={serviceLabel}
          onBack={() => { setScreen('queue'); setOrder(null); setTableId(null); setCart([]); }}
          // Il piatto con varianti (o composto) passa dal foglio: mandarlo
          // nudo incasserebbe un 400 dalla validazione min del server.
          onAddDish={d => { if (needsVariantSheet(d.id)) setVariantFor(d); else pushLine(d); }}
          onRemoveDish={d => {
            const line = cart.find(l => l.dish.id === d.id);
            if (line) changeQty(line.key, -1);
          }}
          onVariants={d => setVariantFor(d)}
          onCartQty={changeQty}
          onVoidItem={setVoidTarget}
          onCovers={changeCovers}
          onDiscount={() => setDiscountOpen(true)}
          onCustomer={() => setCustomerOpen(true)}
          onGoToPayment={goToPayment}
          onOpenInComande={onOpenInComande && tableId != null ? () => onOpenInComande(tableId) : undefined}
        />
      ) : (
        <SelezionaTavolo
          rows={rows}
          rooms={rooms}
          billByTable={serviceBills}
          roomId={roomId}
          onRoom={setRoomId}
          filter={filter}
          onFilter={setFilter}
          query={query}
          onQuery={setQuery}
          busy={busyBillId != null}
          onPick={pickTable}
          onBack={() => setScreen('queue')}
          view={tablesView}
          onView={setTablesView}
        />
      )}

      {order && customerOpen && (
        <ClienteVisita
          open
          tableName={tables.find(t => t.id === tableId)?.name ?? '—'}
          reservation={order.order.reservation_id != null && tableId != null ? reservationForTable(tableId) : null}
          busy={busyBillId != null}
          error={error}
          onClose={() => setCustomerOpen(false)}
          onAssociate={() => setPickerOpen(true)}
          onRemove={detachCustomer}
          onOpenProfile={() => setError('Il profilo cliente si apre da Clienti.')}
        />
      )}

      <CustomerPickerModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={associateCustomer}
      />

      {order && discountOpen && (
        <DiscountDialog
          currentReason={order.order.discount_reason ?? null}
          hasDiscount={(order.discount_cents ?? 0) > 0}
          busy={busyBillId != null}
          onCancel={() => setDiscountOpen(false)}
          onClear={() => applyDiscount(null)}
          onConfirm={applyDiscount}
        />
      )}

      {voidTarget && (
        <ReasonDialog
          title={`Storna ${voidTarget.qty}× ${voidTarget.name_snapshot}`}
          hint="Resta in comanda come riga negativa, e la motivazione ferma la cucina."
          confirmLabel="Storna la riga"
          busy={busyBillId != null}
          onCancel={() => setVoidTarget(null)}
          onConfirm={reason => doVoid(voidTarget, reason)}
        />
      )}

      {variantFor && (
        <VariantSheet
          dish={variantFor}
          groups={groupsForDish(variantFor.id)}
          components={variantFor.dish_type === 'COMPOSED' ? componentsForDish(variantFor.id) : []}
          onCancel={() => setVariantFor(null)}
          onConfirm={(entries, removedIds, note, weightGrams) => { addWithVariants(variantFor, entries, removedIds, note, weightGrams); setVariantFor(null); }}
        />
      )}

      {openBill && (
        <BillSheet
          bill={openBill}
          busy={busyBillId === openBill.id}
          onClose={() => setOpenBill(null)}
          onSettle={opts => settle(openBill, opts)}
        />
      )}
    </>
  );
};
