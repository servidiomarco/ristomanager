import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, Loader2, TriangleAlert, Utensils, X,
} from 'lucide-react';
import type { Dish, Reservation, Table, TableMerge, OrderWithItems, OrderItem } from '../types';
import { Shift } from '../types';
import { getRomeDatePart } from '../utils/reservationTime';
import { getTableMerges } from '../services/apiService';
import {
  ordersApiService, getMenuCatalogue, newIdempotencyKey, closeOrder, updateOrder,
  voidItem, setOrderDiscount, transferOrder,
  type MenuCatalogue, type NewOrderItem, type CloseOrderResult,
} from '../services/ordersApiService';
import { BillSheet, InvoiceDialog } from './pagamenti/BillSheet';
import { PagamentoSheet } from './cassa/PagamentoSheet';
import { useAuth } from '../contexts/AuthContext';
import { billsApiService, printBill } from '../services/billsApiService';

import { socketClient } from '../services/socketClient';
import type { ServiceBill } from '../services/ordersApiService';
import {
  ModalShell, Sheet, Callout, SectionHeader, useMediaQuery,
  dsInput, dsButton,
} from './ds';
import { TableGrid } from './comande/TableGrid';
import { OrderTopBar } from './comande/OrderTopBar';
import { DishBrowser } from './comande/DishBrowser';
import { CourseChips } from './comande/CourseChips';
import { CourseColumn, CourseList, SendFooter } from './comande/CourseColumn';
import { ComandaSheet } from './comande/ComandaSheet';
import { ReasonDialog } from './comande/ReasonDialog';
import { DiscountDialog } from './comande/DiscountDialog';
import { buildRows, buildMergeGroups, makeReservationForTable, type TableFilter } from './comande/tablesView';
import {
  MAX_COURSES, cartForCourse, cartKey, cartSum, courseLabel, euro,
  isSent, isSystemLine, rowCount,
  type CartLine, type RepeatLine,
  saveCartDraft, restoreCartDraft, dropCartDraft,
} from './comande/orderView';

// ---------------------------------------------------------------------------
// Palmare cameriere — la comanda si compone qui e parte con un tocco.
//
// Pensato per una mano sola, in piedi, con poca luce: bersagli grandi, niente
// interazioni fini, lo stato di ogni uscita scritto a lettere invece che
// affidato al colore.
//
// Il carrello resta locale finché non si preme Invia: il cameriere si corregge
// senza generare rumore in cucina, e il servizio parte con una sola chiamata
// di rete invece di una per ogni piatto — che su un WiFi di sala è la
// differenza fra usarlo e tornare al blocchetto.
//
// Questo file tiene lo stato e le chiamate; come si legge la comanda sta in
// components/comande/. Su schermo largo il menu e la comanda stanno affiancati,
// sul telefono la comanda è dietro il totale in fondo: è una differenza di
// albero, non di stile, quindi la sceglie useMediaQuery (regola 13).
// ---------------------------------------------------------------------------

interface OrderPadProps {
  /** Tavolo da aprire subito (arrivando da Cassa · «Apri in Comande»). */
  initialTableId?: number | null;
  onInitialTableConsumed?: () => void;
  dishes: Dish[];
  tables: Table[];
  reservations: Reservation[];
  /** Giorno selezionato nella barra globale — la griglia mostra le
   *  prenotazioni di questo giorno, non fissa "oggi". */
  globalDate: Date;
  /** Turno selezionato nella barra globale ('ALL' = nessun filtro). */
  globalShiftFilter: 'ALL' | 'LUNCH' | 'DINNER';
  /** Chiede alla chrome dell'app di togliersi di mezzo: dentro un tavolo il
   *  telefono serve tutto alla comanda. */
  onImmersive?: (on: boolean) => void;
}

export const OrderPad: React.FC<OrderPadProps> = ({ dishes: allDishes, tables, reservations, globalDate, globalShiftFilter, onImmersive, initialTableId, onInitialTableConsumed }) => {
  // I piatti spenti (es. articolo disattivato in cassa Passepartout) restano
  // in anagrafica per lo storico ma non si battono più.
  const dishes = useMemo(() => allDishes.filter(d => d.is_active !== false), [allDishes]);
  const [tableId, setTableId] = useState<number | null>(null);
  const [order, setOrder] = useState<OrderWithItems | null>(null);
  const [catalogue, setCatalogue] = useState<MenuCatalogue | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [course, setCourse] = useState(1);
  const [category, setCategory] = useState<string | null>(null);
  const [dishQuery, setDishQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [variantFor, setVariantFor] = useState<Dish | null>(null);
  const [closing, setClosing] = useState(false);
  const [voidTarget, setVoidTarget] = useState<OrderItem | null>(null);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [comandaOpen, setComandaOpen] = useState(false);
  // La griglia: che stato guardo e quale tavolo cerco.
  const [gridFilter, setGridFilter] = useState<TableFilter>('ALL');
  const [gridQuery, setGridQuery] = useState('');
  // Il conto appena aperto: il QR va mostrato subito, non cercato altrove
  // mentre il tavolo aspetta.
  const [justClosed, setJustClosed] = useState<CloseOrderResult['bill'] | null>(null);
  const [openTables, setOpenTables] = useState<Set<number>>(new Set());
  // Conti attivi non incassati nel servizio selezionato, per tavolo: la
  // comanda è chiusa ma il tavolo non è libero finché non si paga. Toccare
  // un tavolo in questo stato apre IL CONTO (stato pagamenti compreso),
  // non una comanda nuova.
  const [serviceBills, setServiceBills] = useState<Map<number, ServiceBill>>(new Map());
  const [viewBill, setViewBill] = useState<ServiceBill | null>(null);
  // Il pannello di incasso della Cassa, per chi ha il permesso: un solo
  // motore di pagamento, due punti d'ingresso (banco e tavolo).
  const [cassaBillId, setCassaBillId] = useState<number | null>(null);
  // Chiusura con intento «Fattura»: il conto chiude con proforma e questo
  // apre subito l'emissione, precompilata col cliente della visita.
  const [invoiceFor, setInvoiceFor] = useState<(ServiceBill & { initialQuery?: string }) | null>(null);
  const { hasPermission } = useAuth();
  const canCassa = hasPermission('cash:operate');
  const billTables = useMemo(() => new Set(serviceBills.keys()), [serviceBills]);

  const isWide = useMediaQuery('(min-width: 1024px)');

  useEffect(() => {
    getMenuCatalogue().then(setCatalogue).catch(() => setCatalogue(null));
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [flash]);

  // La barra di navigazione torna quando si torna in griglia e quando si esce
  // dalla pagina: il ritorno nel cleanup non è pignoleria, senza quello uscire
  // da Comande con un tavolo aperto lascerebbe l'app senza navigazione.
  const inPad = tableId != null && order != null;
  useEffect(() => {
    onImmersive?.(inPad);
    return () => onImmersive?.(false);
  }, [inPad, onImmersive]);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const d of dishes) if (d.category) seen.add(d.category);
    return [...seen].sort();
  }, [dishes]);

  useEffect(() => {
    if (category === null && categories.length > 0) setCategory(categories[0]);
  }, [categories, category]);

  // Varianti disponibili per un piatto, risolte dal catalogo.
  const groupsForDish = useCallback((dishId: number) => {
    if (!catalogue) return [];
    const ids = catalogue.dish_modifier_groups.filter(l => l.dish_id === dishId).map(l => l.group_id);
    return catalogue.modifier_groups.filter(g => ids.includes(g.id));
  }, [catalogue]);

  const hasVariants = useCallback(
    (dishId: number) => groupsForDish(dishId).length > 0,
    [groupsForDish]
  );

  // La prenotazione del giorno/turno selezionati per un tavolo: nome e
  // allergeni arrivano dal CRM senza che nessuno li ridigiti. È il pezzo che
  // un POS esterno non può fare. Il filtro sul giorno (in Europe/Rome) serve
  // perché /reservations restituisce tutto lo storico; quello sul turno
  // perché con Pranzo selezionato le prenotazioni della cena in griglia
  // leggono come coperti già arrivati.
  const selectedDateRome = getRomeDatePart(globalDate);

  // Unioni tavoli del giorno in griglia: la prenotazione di un'unione sta su
  // UN tavolo del gruppo (di norma il primario), ma la comanda può essere
  // aperta su un altro — senza il gruppo, nome e allergeni del cliente non
  // comparivano (gemello interno del bug import Passepartout del 25/08).
  const [tableMerges, setTableMerges] = useState<TableMerge[]>([]);
  useEffect(() => {
    let cancelled = false;
    const shifts: Shift[] = globalShiftFilter === 'ALL' ? [Shift.LUNCH, Shift.DINNER] : [globalShiftFilter as Shift];
    Promise.all(shifts.map(s => getTableMerges(selectedDateRome, s)))
      .then(results => { if (!cancelled) setTableMerges(results.flat()); })
      .catch(() => { if (!cancelled) setTableMerges([]); });
    return () => { cancelled = true; };
  }, [selectedDateRome, globalShiftFilter]);

  // Gruppo di unione per tavolo, per turno: `${shift}:${tableId}` → ids.
  const mergeGroupByTable = useMemo(() => buildMergeGroups(tableMerges), [tableMerges]);

  // La regola sta in tablesView: Cassa fa la stessa domanda sugli stessi
  // tavoli, e due copie divergerebbero al primo caso di unione.
  const reservationForTable = useMemo(
    () => makeReservationForTable(reservations, selectedDateRome, globalShiftFilter, mergeGroupByTable),
    [reservations, selectedDateRome, globalShiftFilter, mergeGroupByTable]
  );

  const reservation = useMemo(
    () => (tableId ? reservationForTable(tableId) : null),
    [reservationForTable, tableId]
  );

  // Il servizio che la griglia sta guardando: le comande si cercano LÌ, non
  // nel servizio in corso — altrimenti la comanda appesa di un pranzo passato
  // resta invisibile proprio nella schermata che dovrebbe farla riprendere.
  const serviceQuery = useMemo(() => ({
    date: selectedDateRome,
    shift: globalShiftFilter === 'ALL' ? undefined : globalShiftFilter,
  }), [selectedDateRome, globalShiftFilter]);
  const isTodayRome = selectedDateRome === getRomeDatePart(new Date());

  useEffect(() => {
    if (initialTableId == null) return;
    loadTable(initialTableId);
    onInitialTableConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTableId]);

  const loadTable = useCallback(async (id: number, opts?: { forceCreate?: boolean }) => {
    setBusy(true); setError(null);
    try {
      let view = await ordersApiService.getOrderByTable(id, serviceQuery);
      if (!view) {
        // Tavolo con conto da incassare: si apre IL CONTO, con lo stato dei
        // pagamenti. La comanda nuova solo da lì, su azione esplicita —
        // toccare il tavolo per guardare il conto non deve crearne una.
        const bill = serviceBills.get(id);
        if (bill && !opts?.forceCreate) {
          setViewBill(bill);
          return;
        }
        // Nei servizi passati si riprende, non si crea: il server marcherebbe
        // comunque la comanda nuova sul servizio in corso, e il cameriere
        // crederebbe di averla aperta il giorno che sta guardando.
        if (!isTodayRome) {
          setError('Nessuna comanda in questo servizio. Le nuove comande si aprono solo nel servizio corrente: torna a oggi per aprirne una.');
          return;
        }
        const res = reservationForTable(id);
        // I coperti arrivano dalla prenotazione; per un walk-in la stima
        // migliore sono i posti del tavolo. Uno è quasi sempre sbagliato, e
        // il numero conta: alimenterà lo split equo del conto (PR 6).
        const covers = res?.guests ?? tables.find(t => t.id === id)?.seats;
        view = await ordersApiService.openOrder(
          { table_id: id, reservation_id: res?.id, covers },
          newIdempotencyKey(),
        );
      }
      setOrder(view);
      setTableId(id);
      setOpenTables(prev => new Set(prev).add(id));
      // La bozza lasciata uscendo dal tavolo torna com'era: le righe non
      // inviate non spariscono più. E lo DICE: una bozza muta sembra
      // un'uscita già lavorata (successo al tavolo 11, «ma il passe la dà
      // servita») — il ripristino si annuncia, così si controlla prima di
      // inviare o si butta col cestino.
      const bozza = restoreCartDraft(view.order.id, allDishes.filter(d => d.is_active !== false));
      setCart(bozza);
      if (bozza.length > 0) {
        const n = bozza.reduce((sum, l) => sum + l.qty, 0);
        setFlash(`${n} piatt${n === 1 ? 'o' : 'i'} non inviat${n === 1 ? 'o' : 'i'} dall'ultima volta: bozza ripristinata, non è in cucina.`);
      }
      setDishQuery('');
      // Nuova uscita = quella dopo l'ultima già mandata, così il cameriere
      // non deve ricordarsi a che punto era.
      const maxSent = view.courses.filter(c => c.status !== 'PENDING').map(c => c.course_no);
      setCourse(maxSent.length ? Math.min(MAX_COURSES, Math.max(...maxSent) + 1) : 1);
    } catch (err: any) {
      setError(err?.message ?? 'Impossibile aprire la comanda');
    } finally {
      setBusy(false);
    }
  }, [reservationForTable, tables, serviceQuery, isTodayRome, serviceBills]);

  // Segna quali tavoli hanno già una comanda aperta NEL SERVIZIO SELEZIONATO,
  // così il cameriere sceglie consapevolmente invece di scoprirlo dopo — e
  // navigando a un servizio passato vede subito i tavoli con comande appese.
  // Rigira a OGNI ritorno in griglia (tableId → null): l'evidenza calcolata
  // solo al mount restava blu anche dopo la chiusura del conto.
  useEffect(() => {
    if (tableId != null) return; // griglia non a schermo: niente da scandire
    let cancelled = false;
    (async () => {
      const found = new Set<number>();
      await Promise.all(tables.slice(0, 60).map(async t => {
        try { if (await ordersApiService.getOrderByTable(t.id, serviceQuery)) found.add(t.id); } catch { /* ignora */ }
      }));
      if (!cancelled) setOpenTables(found);
    })();
    (async () => {
      try {
        const res = await ordersApiService.getTablesBillsStatus(serviceQuery);
        if (!cancelled) setServiceBills(new Map(res.bills.map(b => [b.table_id, b])));
      } catch { /* ignora: la griglia resta senza lo stato conti */ }
    })();
    return () => { cancelled = true; };
  }, [tables, serviceQuery, tableId]);

  /* ── Carrello ──────────────────────────────────────────────────────────── */

  const pushLine = useCallback((
    dish: Dish, courseNo: number, qty: number,
    modifierIds: number[], modifierLabels: string[], modifierDelta: number,
    note?: string,
  ) => {
    const key = cartKey(dish.id, courseNo, modifierIds, note);
    setCart(prev => {
      const at = prev.findIndex(l => l.key === key);
      if (at >= 0) {
        const next = [...prev];
        next[at] = { ...next[at], qty: next[at].qty + qty };
        return next;
      }
      return [...prev, {
        // La chiave di idempotenza nasce CON la riga, non all'invio: così il
        // retry di un invio andato in timeout ripresenta la stessa chiave e
        // il server non duplica (vedi ON CONFLICT su order_items).
        key, idem: newIdempotencyKey(), dish, qty, course_no: courseNo,
        modifier_ids: modifierIds,
        modifier_labels: modifierLabels,
        modifier_delta_cents: modifierDelta,
        ...(note ? { note } : {}),
      }];
    });
  }, []);

  const addToCart = (dish: Dish, modifierIds: number[] = [], note?: string) => {
    const all = groupsForDish(dish.id).flatMap(g => g.modifiers);
    const chosen = all.filter(m => modifierIds.includes(m.id));
    pushLine(
      dish, course, 1, modifierIds,
      chosen.map(m => m.name),
      chosen.reduce((s, m) => s + m.price_delta_cents, 0),
      note,
    );
  };

  const onDishTap = (dish: Dish) => {
    // Se il piatto ha varianti le chiediamo: «al sangue» o «ben cotta» non è
    // un dettaglio che si aggiusta a voce dopo.
    if (hasVariants(dish.id)) setVariantFor(dish);
    else addToCart(dish);
  };

  const bumpCart = (key: string, delta: number) => {
    setCart(prev => prev.flatMap(l => {
      if (l.key !== key) return [l];
      const qty = l.qty + delta;
      return qty <= 0 ? [] : [{ ...l, qty }];
    }));
  };

  const dropLine = (key: string) => setCart(prev => prev.filter(l => l.key !== key));

  // Il meno sulla riga del menu tocca solo la riga senza varianti: quale delle
  // due cotture togliere non lo sa nessuno, e quella si toglie dalla comanda.
  const removeFromCart = (dish: Dish) => bumpCart(cartKey(dish.id, course, []), -1);

  /** Ripete una riga già ordinata nell'uscita in composizione. Non tocca il
   *  server: diventa una bozza come tutte le altre, e parte con Invia. */
  const repeatLine = (line: RepeatLine, qty: number) => {
    if (!line.dish) return;
    pushLine(line.dish, course, qty, line.modifier_ids, line.modifier_labels, line.modifier_delta_cents);
  };

  const repeatAll = (lines: RepeatLine[]) => {
    for (const l of lines) repeatLine(l, l.qty);
    setComandaOpen(false);
    setFlash(`Giro ripetuto nella ${courseLabel(course)} — controlla e invia`);
  };

  const clearDrafts = () => {
    setCart([]);
    setFlash('Righe non inviate svuotate');
  };

  const courseLines = cartForCourse(cart, course);
  const cartTotal = cartSum(cart);

  // Invia: crea le righe e le propone, in due chiamate consecutive con la
  // stessa chiave di idempotenza. Se la seconda fallisce le righe restano in
  // bozza sul server — recuperabili, mai perse.
  //
  // 'course' manda solo l'uscita in composizione, 'all' tutto quello che è in
  // bozza. Sono due gesti diversi: il primo è il ritmo del servizio, il
  // secondo è «il tavolo ha finito di ordinare».
  // Ogni variazione del carrello riscrive la bozza; carrello vuoto = bozza
  // rimossa. Così l'invio (che riduce il carrello) la svuota senza codice.
  useEffect(() => {
    if (order) saveCartDraft(order.order.id, cart);
  }, [cart, order]);

  const submit = async (scope: 'course' | 'all') => {
    if (!order || busy) return;
    const lines = scope === 'course' ? courseLines : cart;
    if (lines.length === 0) return;
    setBusy(true); setError(null);
    try {
      const payload: NewOrderItem[] = lines.map(l => ({
        dish_id: l.dish.id,
        qty: l.qty,
        course_no: l.course_no,
        modifier_ids: l.modifier_ids,
        note: l.note ?? null,
        // Chiave per riga, stabile dalla nascita della riga: un retry dopo un
        // timeout rimanda le stesse chiavi e il server dedup-a invece di
        // raddoppiare la comanda in cucina.
        idempotency_key: l.idem,
      }));
      const key = newIdempotencyKey();
      await ordersApiService.addItems(order.order.id, payload, key);
      const sent = await ordersApiService.send(
        order.order.id, scope === 'course' ? course : undefined, key,
      );
      setOrder(sent);
      setCart(prev => (scope === 'course' ? prev.filter(l => l.course_no !== course) : []));
      setComandaOpen(false);
      // Si riparte dalla prima uscita libera: il cameriere non deve ricordarsi
      // dove era arrivato, e non riapre per sbaglio un'uscita già partita.
      const maxSent = sent.courses.filter(c => c.status !== 'PENDING').map(c => c.course_no);
      setCourse(Math.min(MAX_COURSES, (maxSent.length ? Math.max(...maxSent) : 0) + 1));
      const fired = sent.fired_courses.length;
      const queued = sent.queued_courses.length;
      setFlash(
        fired && queued ? `Uscita in cucina; ${queued === 1 ? "un'altra è" : `${queued} sono`} in attesa al passe`
        : fired ? 'Comanda in cucina'
        : 'Proposta al passe — in attesa di lancio'
      );
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Invio non riuscito');
    } finally {
      setBusy(false);
    }
  };

  // I coperti sono il divisore dello split equo del conto: se sono sbagliati
  // ogni ospite paga la quota sbagliata.
  const changeCovers = async (delta: number) => {
    if (!order || busy) return;
    const next = order.order.covers + delta;
    if (next < 1) return;
    setBusy(true);
    try {
      setOrder(await updateOrder(order.order.id, { covers: next }));
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Coperti non aggiornati');
    } finally {
      setBusy(false);
    }
  };

  // Chiude la comanda e consegna il totale al conto al tavolo: da qui in poi
  // valgono le regole del pagamento, non quelle della cucina.
  const closeAndBill = async (discardPending = false) => {
    if (!order || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await closeOrder(order.order.id, discardPending);
      dropCartDraft(order.order.id);
      setClosing(false);
      if (res.bill) setJustClosed(res.bill);
      else setFlash('Comanda chiusa: non c\'era nulla da pagare');
      // Ottimistico: la comanda sparisce subito; se è nato un conto, il
      // tavolo passa a "conto da incassare" invece che a libero.
      if (tableId != null) {
        setOpenTables(prev => { const n = new Set(prev); n.delete(tableId); return n; });
        if (res.bill && res.bill.total_cents > 0) {
          const tid = tableId;
          const b = res.bill;
          setServiceBills(prev => new Map(prev).set(tid, {
            id: b.id, table_id: tid,
            table_name: tables.find(t => t.id === tid)?.name ?? null,
            total_cents: b.total_cents, covers: b.covers, status: 'OPEN',
            share_token: b.share_token, items: b.items ?? null,
            // La chiusura comanda ora restituisce anche acconto/pagato/residuo:
            // se assenti (compat) si ricade sui valori a conto pieno.
            paid_cents: b.paid_cents ?? 0,
            deposit_credit_cents: b.deposit_credit_cents ?? 0,
            deposit_paid_cents: b.deposit_paid_cents ?? 0,
            refund_due_cents: b.refund_due_cents ?? 0,
            residual_cents: b.residual_cents ?? b.total_cents,
            open_orders: 0,
          }));
        }
      }
      setTableId(null); setOrder(null); setCart([]);
    } catch (err: any) {
      const data = err?.data;
      if (data?.pending_items) {
        setError(`${data.pending_items} righe non sono ancora andate in cucina. Inviale o confermale come da scartare.`);
        setClosing(true);
      } else {
        setError(data?.error ?? err?.message ?? 'Chiusura non riuscita');
        setClosing(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const doVoid = async (item: OrderItem, reason: string) => {
    setBusy(true); setError(null);
    try {
      setOrder(await voidItem(item.id, reason));
      setVoidTarget(null);
      setFlash(`Stornato: ${item.qty}× ${item.name_snapshot}`);
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Storno non riuscito');
    } finally { setBusy(false); }
  };

  const doDiscount = async (payload: { discount_type: 'PERCENT' | 'AMOUNT'; discount_value: number; reason: string } | null) => {
    if (!order) return;
    setBusy(true); setError(null);
    try {
      setOrder(await setOrderDiscount(order.order.id, payload));
      setDiscountOpen(false);
      setFlash(payload ? 'Sconto applicato' : 'Sconto rimosso');
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Sconto non applicato');
    } finally { setBusy(false); }
  };

  const doTransfer = async (targetId: number) => {
    if (!order) return;
    setBusy(true); setError(null);
    try {
      const moved = await transferOrder(order.order.id, targetId);
      setOrder(moved);
      setTableId(targetId);
      setTransferOpen(false);
      setFlash(`Comanda spostata sul tavolo ${tables.find(t => t.id === targetId)?.name ?? targetId}`);
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Trasferimento non riuscito');
    } finally { setBusy(false); }
  };

  const recall = async (courseNo: number) => {
    if (!order || busy) return;
    setBusy(true); setError(null);
    try {
      setOrder(await ordersApiService.recallCourse(order.order.id, courseNo));
      setFlash(`${courseLabel(courseNo)} richiamata: torna in bozza`);
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Richiamo non riuscito');
    } finally {
      setBusy(false);
    }
  };

  // Chiusura in cassa dal foglio conto aperto sul tavolo. Il residuo che
  // resta è una decisione dell'operatore (SETTLED_PARTIAL), quindi dopo la
  // chiusura il tavolo torna libero.
  // I verbi rapidi di Passepartout: «scontrino contanti/POS» è UN tocco che
  // incassa l'importo pieno ed emette lo scontrino — il caso che copre il
  // 90% delle chiusure. Il pannello completo resta per dividi/misto/sospeso.
  const chiusuraRapida = async (
    billId: number,
    residualCents: number,
    method: 'CONTANTI' | 'POS_FISICO',
    cleanupTableId: number | null,
  ) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await billsApiService.closeBill(billId, {
        payments: residualCents > 0 ? [{ method, amount_cents: residualCents }] : [],
        documento: 'Scontrino',
      });
      setViewBill(null);
      setJustClosed(null);
      if (cleanupTableId != null) {
        setServiceBills(prev => { const n = new Map(prev); n.delete(cleanupTableId); return n; });
      }
      setFlash(`Conto chiuso · ${method === 'CONTANTI' ? 'contanti' : 'POS'} ${euro(residualCents)} · scontrino in emissione`);
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Chiusura non riuscita');
    } finally {
      setBusy(false);
    }
  };

  const stampaPreconto = async (billId: number) => {
    try {
      await printBill(billId, 'PRECONTO');
      setFlash('Preconto in stampa');
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Stampa non riuscita');
    }
  };

  const settleViewBill = async (opts?: { cash_settled_cents?: number; tip_cents?: number }, meta?: { invoiceIntent?: boolean }) => {
    if (!viewBill || busy) return;
    setBusy(true); setError(null);
    try {
      await billsApiService.closeBill(viewBill.id, opts);
      setServiceBills(prev => { const n = new Map(prev); n.delete(viewBill.table_id); return n; });
      if (meta?.invoiceIntent) {
        setInvoiceFor({
          ...viewBill,
          initialQuery: reservationForTable(viewBill.table_id)?.customer_name ?? undefined,
        });
      }
      setViewBill(null);
      setFlash('Conto chiuso in cassa');
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Chiusura non riuscita');
    } finally {
      setBusy(false);
    }
  };

  // Lo stato dei pagamenti cambia sotto gli occhi (quote via QR, chiusure da
  // altri dispositivi): il foglio conto e la griglia si riallineano da soli.
  useEffect(() => {
    const socket = socketClient.getSocket();
    if (!socket) return;
    const refresh = async () => {
      try {
        const res = await ordersApiService.getTablesBillsStatus(serviceQuery);
        const map = new Map(res.bills.map(b => [b.table_id, b]));
        setServiceBills(map);
        setViewBill(prev => {
          if (!prev) return prev;
          const fresh = res.bills.find(b => b.id === prev.id);
          if (fresh) return fresh;
          setFlash('Conto saldato · tavolo libero');
          return null;
        });
      } catch { /* al prossimo evento o rescan */ }
    };
    socket.on('bill:updated', refresh);
    socket.on('bill:closed', refresh);
    return () => {
      socket.off('bill:updated', refresh);
      socket.off('bill:closed', refresh);
    };
  }, [serviceQuery]);

  // L'uscita cambia stato in cucina sotto gli occhi del cameriere: il badge
  // ("in cucina", "pronta", "servita") si aggiorna da solo, senza aspettare
  // il prossimo invio o una riapertura. Filtrato sulla comanda aperta: gli
  // eventi delle altre non devono far scaricare niente.
  const openOrderId = order?.order.id ?? null;
  useEffect(() => {
    const socket = socketClient.getSocket();
    if (!socket || openOrderId == null) return;
    const onCourse = (payload: any) => {
      if (payload?.order_id !== openOrderId) return;
      ordersApiService.getOrder(openOrderId).then(setOrder).catch(() => { /* al prossimo evento */ });
    };
    socket.on('course:fired', onCourse);
    socket.on('course:ready', onCourse);
    socket.on('course:served', onCourse);
    socket.on('course:unserved', onCourse);
    return () => {
      socket.off('course:fired', onCourse);
      socket.off('course:ready', onCourse);
      socket.off('course:served', onCourse);
      socket.off('course:unserved', onCourse);
    };
  }, [openOrderId]);

  const notices = (
    <>
      {error && <ErrorBar message={error} onDismiss={() => setError(null)} />}
      {flash && <Callout tone="positive" icon={Check}>{flash}</Callout>}
    </>
  );

  const billSheets = (
    <>
      {viewBill && !justClosed && (
        <BillSheet
          bill={{
            id: viewBill.id,
            table_name: viewBill.table_name,
            total_cents: viewBill.total_cents,
            covers: viewBill.covers,
            share_token: viewBill.share_token,
            items: viewBill.items,
            paid_cents: viewBill.paid_cents,
            cash_settled_cents: viewBill.cash_settled_cents,
            deposit_credit_cents: viewBill.deposit_credit_cents,
            deposit_paid_cents: viewBill.deposit_paid_cents,
            refund_due_cents: viewBill.refund_due_cents,
            residual_cents: viewBill.residual_cents,
            open_orders: viewBill.open_orders,
            external_ref: viewBill.external_ref,
          }}
          busy={busy}
          onClose={() => setViewBill(null)}
          onSettle={settleViewBill}
          footerExtra={
            <>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => chiusuraRapida(viewBill.id, viewBill.residual_cents ?? viewBill.total_cents, 'CONTANTI', viewBill.table_id)}
                  disabled={busy}
                  className={`flex-1 ${dsButton.primary}`}
                >
                  Scontrino contanti
                </button>
                <button
                  type="button"
                  onClick={() => chiusuraRapida(viewBill.id, viewBill.residual_cents ?? viewBill.total_cents, 'POS_FISICO', viewBill.table_id)}
                  disabled={busy}
                  className={`flex-1 ${dsButton.secondary}`}
                >
                  Scontrino POS
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => stampaPreconto(viewBill.id)}
                  disabled={busy}
                  className={`flex-1 ${dsButton.quiet}`}
                >
                  Preconto
                </button>
                {canCassa && (
                  <button
                    type="button"
                    onClick={() => { const bid = viewBill.id; setViewBill(null); setCassaBillId(bid); }}
                    disabled={busy}
                    className={`flex-1 ${dsButton.quiet}`}
                  >
                    Incassa con la cassa
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => { const tid = viewBill.table_id; setViewBill(null); loadTable(tid, { forceCreate: true }); }}
                disabled={busy}
                className={`w-full ${dsButton.quiet}`}
              >
                Nuova comanda su questo tavolo
              </button>
            </>
          }
        />
      )}
      {invoiceFor && (
        <InvoiceDialog
          bill={invoiceFor}
          initialQuery={invoiceFor.initialQuery}
          onCancel={() => { setInvoiceFor(null); setFlash('Conto chiuso, da fatturare: la fattura resta emettibile dal conto.'); }}
          onDone={() => { setInvoiceFor(null); setFlash('Fattura emessa'); }}
        />
      )}
      {cassaBillId != null && (
        <PagamentoSheet
          billId={cassaBillId}
          service={{ service_date: serviceQuery.date, shift: serviceQuery.shift }}
          onClose={() => setCassaBillId(null)}
          onBillClosed={async () => {
            try {
              const res = await ordersApiService.getTablesBillsStatus(serviceQuery);
              setServiceBills(new Map(res.bills.map(b => [b.table_id, b])));
            } catch { /* al prossimo focus la griglia si riallinea da sola */ }
          }}
        />
      )}
      {justClosed && (
        <BillSheet
          bill={{
            id: justClosed.id,
            table_name: tables.find(t => t.id === justClosed.table_id)?.name ?? null,
            total_cents: justClosed.total_cents,
            covers: justClosed.covers,
            share_token: justClosed.share_token,
            items: justClosed.items,
          }}
          busy={busy}
          onClose={() => setJustClosed(null)}
          footerExtra={
            <>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => chiusuraRapida(justClosed.id, justClosed.residual_cents ?? justClosed.total_cents, 'CONTANTI', justClosed.table_id ?? null)}
                  disabled={busy}
                  className={`flex-1 ${dsButton.primary}`}
                >
                  Scontrino contanti
                </button>
                <button
                  type="button"
                  onClick={() => chiusuraRapida(justClosed.id, justClosed.residual_cents ?? justClosed.total_cents, 'POS_FISICO', justClosed.table_id ?? null)}
                  disabled={busy}
                  className={`flex-1 ${dsButton.secondary}`}
                >
                  Scontrino POS
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => stampaPreconto(justClosed.id)}
                  disabled={busy}
                  className={`flex-1 ${dsButton.quiet}`}
                >
                  Preconto
                </button>
                {canCassa && (
                  <button
                    type="button"
                    onClick={() => { const bid = justClosed.id; setJustClosed(null); setCassaBillId(bid); }}
                    disabled={busy}
                    className={`flex-1 ${dsButton.quiet}`}
                  >
                    Incassa con la cassa
                  </button>
                )}
              </div>
            </>
          }
        />
      )}
    </>
  );

  // ---------------- selezione tavolo ----------------
  if (!tableId || !order) {
    return (
      <>
        <TableGrid
          rows={buildRows(tables, openTables, billTables, reservationForTable)}
          filter={gridFilter}
          onFilter={setGridFilter}
          query={gridQuery}
          onQuery={setGridQuery}
          busy={busy}
          onPick={loadTable}
          notice={(error || flash || serviceBills.size > 0) ? (
            <div className="flex flex-col gap-2">
              {notices}
              {serviceBills.size > 0 && (
                <span className="inline-flex h-8 w-fit items-baseline gap-1.5 rounded-full border border-[var(--ds-pending-solid)] bg-[var(--ds-pending-tint)] px-3 leading-8 text-[var(--ds-pending-text)]">
                  <span className="text-[15px] font-bold tabular-nums">{serviceBills.size}</span>
                  <span className="text-[13px] font-medium">{serviceBills.size === 1 ? 'conto da incassare' : 'conti da incassare'}</span>
                </span>
              )}
            </div>
          ) : undefined}
        />
        {billSheets}
      </>
    );
  }

  const table = tables.find(t => t.id === tableId);
  const allergens = reservation?.customer_dietary_notes?.trim();
  const rows = rowCount(order, cart);
  const displayTotal = order.total_cents + cartTotal;
  const sentCourses = order.courses.filter(c => isSent(c.status)).length;

  // Quante righe sparirebbero chiudendo ora: le bozze locali più quelle
  // rimaste in bozza sul server dopo un invio interrotto.
  const pendingRows =
    cart.reduce((s, l) => s + l.qty, 0)
    + order.items.reduce((s, i) => s + (i.status === 'DRAFT' && !isSystemLine(i) ? i.qty : 0), 0);

  const qtyInCourse = new Map<number, number>();
  for (const l of courseLines) {
    qtyInCourse.set(l.dish.id, (qtyInCourse.get(l.dish.id) ?? 0) + l.qty);
  }
  const markedCategories = new Set<string>();
  for (const l of courseLines) if (l.dish.category) markedCategories.add(l.dish.category);

  const listProps = {
    order, cart, course, onCourse: setCourse, busy,
    onBump: bumpCart, onDrop: dropLine,
    onVoid: (i: OrderItem) => setVoidTarget(i),
    onRecall: recall,
  };

  const browser = (
    <DishBrowser
      dishes={dishes}
      categories={categories}
      category={category}
      onCategory={setCategory}
      query={dishQuery}
      onQuery={setDishQuery}
      qtyInCourse={qtyInCourse}
      markedCategories={markedCategories}
      hasVariants={hasVariants}
      onAdd={onDishTap}
      onRemove={removeFromCart}
      onLongPress={setVariantFor}
      layout={isWide ? 'grid' : 'list'}
    />
  );

  const topBar = (
    <OrderTopBar
      tableName={table?.name ?? String(tableId)}
      guestName={reservation?.customer_name ?? null}
      totalCents={displayTotal}
      rows={rows}
      covers={order.order.covers}
      sentCourses={sentCourses}
      busy={busy}
      billDisabled={displayTotal === 0 && rows === 0}
      clearDisabled={cart.length === 0}
      wide={isWide}
      onBack={() => { setTableId(null); setOrder(null); setCart([]); setComandaOpen(false); }}
      onCovers={changeCovers}
      onBill={() => setClosing(true)}
      onDiscount={() => setDiscountOpen(true)}
      onTransfer={() => setTransferOpen(true)}
      onClearDrafts={clearDrafts}
    />
  );

  const dialogs = (
    <>
      <ModalShell
        open={closing}
        onClose={() => setClosing(false)}
        title="Chiudere la comanda?"
        size="sm"
        closeOnEscape
        bodyClassName="space-y-3 p-5 sm:p-6"
        footerStart={
          <button type="button" onClick={() => setClosing(false)} className={dsButton.quiet}>
            Annulla
          </button>
        }
        footer={
          pendingRows > 0 ? (
            <button
              type="button"
              onClick={() => closeAndBill(true)}
              disabled={busy}
              className={dsButton.critical}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Scarta e chiudi
            </button>
          ) : (
            <button
              type="button"
              onClick={() => closeAndBill(false)}
              disabled={busy}
              className={dsButton.primary}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Apri il conto
            </button>
          )
        }
      >
        <p className="text-[15px] leading-relaxed text-[var(--ds-text-secondary)]">
          Il totale di {euro(order.total_cents)} passa al conto del tavolo {table?.name}.
          Dopo non si aggiungono piatti.
        </p>
        {pendingRows > 0 && (
          <Callout tone="pending" icon={TriangleAlert}>
            {pendingRows === 1
              ? '1 riga non è ancora andata in cucina e verrà eliminata.'
              : `${pendingRows} righe non sono ancora andate in cucina e verranno eliminate.`}
          </Callout>
        )}
      </ModalShell>

      {voidTarget && (
        <ReasonDialog
          title={`Storna ${voidTarget.qty}× ${voidTarget.name_snapshot}`}
          hint="La riga resta a bilancio come scarto, con chi l'ha stornata e perché."
          confirmLabel="Storna"
          busy={busy}
          onCancel={() => setVoidTarget(null)}
          onConfirm={reason => doVoid(voidTarget, reason)}
        />
      )}

      {discountOpen && (
        <DiscountDialog
          currentReason={order.order.discount_reason ?? null}
          hasDiscount={order.discount_cents > 0}
          busy={busy}
          onCancel={() => setDiscountOpen(false)}
          onClear={() => doDiscount(null)}
          onConfirm={doDiscount}
        />
      )}

      <ModalShell
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        title="Sposta su quale tavolo?"
        subtitle="Comanda e conto si spostano insieme. Le quote già pagate restano attaccate al conto."
        size="sm"
        closeOnEscape
        bodyClassName="p-5 sm:p-6"
      >
        <div className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto">
          {tables.filter(t => t.id !== tableId).map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => doTransfer(t.id)}
              disabled={busy}
              className="h-14 rounded-[16px] bg-[var(--ds-surface-row)] text-[15px] font-semibold text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
            >
              {t.name}
            </button>
          ))}
        </div>
      </ModalShell>

      {variantFor && (
        <VariantSheet
          dish={variantFor}
          groups={groupsForDish(variantFor.id)}
          onCancel={() => setVariantFor(null)}
          onConfirm={(ids, note) => { addToCart(variantFor, ids, note); setVariantFor(null); }}
        />
      )}

      {billSheets}
    </>
  );

  // ---------------- schermo largo: menu e comanda affiancati ----------------
  if (isWide) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 bg-[var(--ds-canvas)] p-4">
        <div className="flex-shrink-0">{topBar}</div>
        {(allergens || error || flash) && (
          <div className="flex flex-shrink-0 flex-col gap-2">
            {allergens && (
              <Callout tone="critical" icon={TriangleAlert}>{allergens}</Callout>
            )}
            {notices}
          </div>
        )}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px] gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
          {browser}
          <CourseColumn
            {...listProps}
            onSend={() => submit('course')}
            onSendAll={() => submit('all')}
          />
        </div>
        {dialogs}
      </div>
    );
  }

  // ---------------- palmare: la comanda sta dietro il totale ----------------
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ds-canvas)] px-4 pt-3">
      <div className="flex-shrink-0">{topBar}</div>

      <div className="mt-4 flex-shrink-0">
        <SectionHeader>Uscita</SectionHeader>
        <div className="mt-1">
          <CourseChips order={order} cart={cart} course={course} onCourse={setCourse} />
        </div>
      </div>

      {(allergens || error || flash) && (
        <div className="mt-3 flex flex-shrink-0 flex-col gap-2">
          {allergens && <Callout tone="critical" icon={TriangleAlert}>{allergens}</Callout>}
          {notices}
        </div>
      )}

      <div className="mt-4 flex min-h-0 flex-1 flex-col">{browser}</div>

      {/* Un elemento fisso possiede lo spazio sotto di sé: il padding sta qui
          dentro, non sulla zona che scorre, altrimenti quella dipinge sopra
          l'ombra e la taglia con una linea netta (regola 10). */}
      <div className="flex-shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
        <div className="rounded-[20px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-raised)]">
          <SendFooter
            course={course}
            courseCount={courseLines.reduce((s, l) => s + l.qty, 0)}
            courseTotal={cartSum(courseLines)}
            allCount={cart.reduce((s, l) => s + l.qty, 0)}
            allTotal={cartTotal}
            busy={busy}
            onSend={() => submit('course')}
            onSendAll={() => submit('all')}
            onExpand={() => setComandaOpen(true)}
          />
        </div>
      </div>

      <ComandaSheet
        open={comandaOpen}
        onClose={() => setComandaOpen(false)}
        order={order}
        cart={cart}
        dishes={dishes}
        categories={categories}
        course={course}
        onCourse={setCourse}
        busy={busy}
        onBump={bumpCart}
        onDrop={dropLine}
        onVoid={i => setVoidTarget(i)}
        onRecall={recall}
        onSend={() => submit('course')}
        onSendAll={() => submit('all')}
        onRepeat={repeatLine}
        onRepeatAll={repeatAll}
      />

      {dialogs}
    </div>
  );
};

const ErrorBar: React.FC<{ message: string; onDismiss: () => void }> = ({ message, onDismiss }) => (
  <Callout
    tone="critical"
    icon={TriangleAlert}
    action={
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Chiudi l'errore"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ds-critical-text)] transition-[filter] hover:brightness-90"
      >
        <X size={16} />
      </button>
    }
  >
    {message}
  </Callout>
);

// Foglio varianti. I gruppi con max_select = 1 sono a scelta singola
// (cottura), gli altri multipla (aggiunte).
const VariantSheet: React.FC<{
  dish: Dish;
  groups: MenuCatalogue['modifier_groups'];
  onCancel: () => void;
  onConfirm: (ids: number[], note?: string) => void;
}> = ({ dish, groups, onCancel, onConfirm }) => {
  const [selected, setSelected] = useState<number[]>([]);
  // Variante libera: quello che in cassa il cameriere scrive a mano («senza
  // sale», «metà porzione»). Viaggia come nota di riga — KDS e comanda in
  // cucina la stampano già sotto il piatto.
  const [custom, setCustom] = useState('');

  const toggle = (groupId: number, modId: number, single: boolean) => {
    setSelected(prev => {
      const group = groups.find(g => g.id === groupId);
      const siblings = group ? group.modifiers.map(m => m.id) : [];
      if (prev.includes(modId)) return prev.filter(x => x !== modId);
      const cleaned = single ? prev.filter(x => !siblings.includes(x)) : prev;
      return [...cleaned, modId];
    });
  };

  const missing = groups.filter(g => g.min_select > 0
    && g.modifiers.filter(m => selected.includes(m.id)).length < g.min_select);

  return (
    <Sheet
      open
      onClose={onCancel}
      title={dish.name}
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <Utensils size={14} aria-hidden /> Varianti
        </span>
      }
      ariaLabel={`Varianti per ${dish.name}`}
      bodyClassName="space-y-5 px-5 py-5 sm:px-6"
      footer={
        <button
          type="button"
          onClick={() => onConfirm(selected, custom.trim() || undefined)}
          disabled={missing.length > 0}
          className={`w-full ${dsButton.primary}`}
        >
          {missing.length > 0 ? `Scegli: ${missing.map(g => g.name).join(', ')}` : 'Aggiungi'}
        </button>
      }
    >
      {groups.map(g => {
        const single = g.max_select <= 1;
        return (
          <div key={g.id}>
            <div className="mb-2 text-[13px] font-semibold text-[var(--ds-text-muted)]">
              {g.name}
              {g.min_select > 0 && (
                <span className="text-[var(--ds-critical-text)]"> · obbligatorio</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {g.modifiers.map(m => {
                const active = selected.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggle(g.id, m.id, single)}
                    aria-pressed={active}
                    className={`inline-flex h-11 items-center rounded-full px-4 text-[15px] font-medium transition-colors ${
                      active
                        ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                        : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]'
                    }`}
                  >
                    {m.name}
                    {m.price_delta_cents !== 0 && (
                      <span className="ml-1.5 tabular-nums opacity-75">
                        {m.price_delta_cents > 0 ? '+' : '−'}{euro(Math.abs(m.price_delta_cents))}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <label className="block">
        <span className="mb-2 block text-[13px] font-semibold text-[var(--ds-text-muted)]">Variante libera</span>
        <input
          type="text"
          value={custom}
          onChange={e => setCustom(e.target.value)}
          maxLength={300}
          placeholder="Es. senza sale, metà porzione…"
          className={dsInput}
          // Aperta dal tocco lungo su un piatto senza varianti, la sheet ha
          // solo questo campo: il cameriere è qui per scrivere.
          autoFocus={groups.length === 0}
        />
      </label>
    </Sheet>
  );
};
