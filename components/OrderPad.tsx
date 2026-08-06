import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, ArrowRightLeft, Ban, Check, ChevronDown, Loader2, Minus,
  Percent, Plus, Receipt, Send, Trash2, TriangleAlert, Users, Utensils, X,
} from 'lucide-react';
import type { Dish, Reservation, Table, OrderWithItems, OrderItem } from '../types';
import { ArrivalStatus, ReservationStatus } from '../types';
import { getRomeDatePart, getRomeTimePart } from '../utils/reservationTime';
import {
  ordersApiService, getMenuCatalogue, newIdempotencyKey, closeOrder, updateOrder,
  voidItem, setOrderDiscount, transferOrder,
  type MenuCatalogue, type NewOrderItem, type CloseOrderResult,
} from '../services/ordersApiService';
import { BillSheet } from './pagamenti/BillSheet';
import { billsApiService } from '../services/billsApiService';
import { socketClient } from '../services/socketClient';
import type { ServiceBill } from '../services/ordersApiService';
import {
  ModalShell, Sheet, Callout, StatusPill, SegmentedControl, dsInput, dsButton,
} from './ds';
import type { PillTone } from './ds';

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
// ---------------------------------------------------------------------------

interface OrderPadProps {
  dishes: Dish[];
  tables: Table[];
  reservations: Reservation[];
  /** Giorno selezionato nella barra globale — la griglia mostra le
   *  prenotazioni di questo giorno, non fissa "oggi". */
  globalDate: Date;
  /** Turno selezionato nella barra globale ('ALL' = nessun filtro). */
  globalShiftFilter: 'ALL' | 'LUNCH' | 'DINNER';
}

interface CartLine {
  key: string;
  dish: Dish;
  qty: number;
  course_no: number;
  modifier_ids: number[];
  modifier_labels: string[];
  modifier_delta_cents: number;
  note?: string;
}

const euro = (cents: number): string =>
  (cents / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });

const ORDINALS = ['', '1ª', '2ª', '3ª', '4ª', '5ª', '6ª'];
const courseLabel = (n: number): string => `${ORDINALS[n] ?? `${n}ª`} uscita`;

// Etichetta parlante per lo stato dell'uscita. Il cameriere deve sapere a
// colpo d'occhio se la sua seconda uscita è partita o è ferma al passe:
// altrimenti la ripropone, e in cucina arriva doppia.
//
// I toni sono quelli del design system, e ci cascano dentro senza forzature:
// al passe qualcuno deve agire (pending), in cucina è informativo (arriving),
// pronta è servizio vivo (seated), servita non è più uno stato (neutral).
const COURSE_BADGE: Record<string, { text: string; tone: PillTone }> = {
  QUEUED:  { text: 'al passe',  tone: 'pending' },
  FIRED:   { text: 'in cucina', tone: 'info' },
  READY:   { text: 'pronta',    tone: 'positive' },
  SERVED:  { text: 'servita',   tone: 'neutral' },
  PENDING: { text: 'in bozza',  tone: 'neutral' },
};

/* Lo stato del tavolo in griglia. Le quattro famiglie di stato del design
   system coprono esattamente i quattro casi, quindi non serve inventare tinte:
   una comanda aperta è servizio vivo, un conto da incassare chiede un'azione,
   una prenotazione è imminente, un tavolo libero non è uno stato. */
const TABLE_STATE = {
  order: 'bg-[var(--ds-seated-tint)] ring-2 ring-[var(--ds-seated-solid)]',
  bill: 'bg-[var(--ds-pending-tint)] ring-2 ring-[var(--ds-pending-solid)]',
  booked: 'bg-[var(--ds-arriving-tint)] ring-1 ring-[var(--ds-arriving-solid)]',
  free: 'bg-[var(--ds-surface)]',
} as const;

/* I bersagli del palmare: una mano sola, in piedi, poca luce. 44px non è un
   arrotondamento, è il motivo per cui non si sbaglia riga. */
const padButton =
  'inline-flex h-11 flex-shrink-0 items-center justify-center gap-1.5 rounded-full px-4 text-[15px] font-medium transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';
const padQuiet = `${padButton} bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]`;
const padStepper =
  'inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

export const OrderPad: React.FC<OrderPadProps> = ({ dishes, tables, reservations, globalDate, globalShiftFilter }) => {
  const [tableId, setTableId] = useState<number | null>(null);
  const [order, setOrder] = useState<OrderWithItems | null>(null);
  const [catalogue, setCatalogue] = useState<MenuCatalogue | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [course, setCourse] = useState(1);
  const [category, setCategory] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [variantFor, setVariantFor] = useState<Dish | null>(null);
  const [closing, setClosing] = useState(false);
  const [voidTarget, setVoidTarget] = useState<OrderItem | null>(null);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
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
  const billTables = useMemo(() => new Set(serviceBills.keys()), [serviceBills]);

  useEffect(() => {
    getMenuCatalogue().then(setCatalogue).catch(() => setCatalogue(null));
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [flash]);

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

  // La prenotazione del giorno/turno selezionati per un tavolo: nome e
  // allergeni arrivano dal CRM senza che nessuno li ridigiti. È il pezzo che
  // un POS esterno non può fare. Il filtro sul giorno (in Europe/Rome) serve
  // perché /reservations restituisce tutto lo storico; quello sul turno
  // perché con Pranzo selezionato le prenotazioni della cena in griglia
  // leggono come coperti già arrivati.
  const selectedDateRome = getRomeDatePart(globalDate);
  const reservationForTable = useCallback((id: number): Reservation | null =>
    reservations.find(r =>
      r.table_id === id
      && getRomeDatePart(r.reservation_time) === selectedDateRome
      && (globalShiftFilter === 'ALL' || r.shift === globalShiftFilter)
      && r.reservation_status !== ReservationStatus.CANCELLED
      && r.arrival_status !== ArrivalStatus.DEPARTED
    ) ?? null,
  [reservations, selectedDateRome, globalShiftFilter]);

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
      setCart([]);
      // Nuova uscita = quella dopo l'ultima già mandata, così il cameriere
      // non deve ricordarsi a che punto era.
      const maxSent = view.courses.filter(c => c.status !== 'PENDING').map(c => c.course_no);
      setCourse(maxSent.length ? Math.max(...maxSent) + 1 : 1);
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

  const addToCart = (dish: Dish, modifierIds: number[] = []) => {
    const groups = groupsForDish(dish.id);
    const all = groups.flatMap(g => g.modifiers);
    const chosen = all.filter(m => modifierIds.includes(m.id));
    const delta = chosen.reduce((s, m) => s + m.price_delta_cents, 0);
    const key = `${dish.id}|${course}|${[...modifierIds].sort().join(',')}`;
    setCart(prev => {
      const at = prev.findIndex(l => l.key === key);
      if (at >= 0) {
        const next = [...prev];
        next[at] = { ...next[at], qty: next[at].qty + 1 };
        return next;
      }
      return [...prev, {
        key, dish, qty: 1, course_no: course,
        modifier_ids: modifierIds,
        modifier_labels: chosen.map(m => m.name),
        modifier_delta_cents: delta,
      }];
    });
  };

  const onDishTap = (dish: Dish) => {
    // Se il piatto ha varianti le chiediamo: «al sangue» o «ben cotta» non è
    // un dettaglio che si aggiusta a voce dopo.
    if (groupsForDish(dish.id).length > 0) setVariantFor(dish);
    else addToCart(dish);
  };

  const bumpCart = (key: string, delta: number) => {
    setCart(prev => prev.flatMap(l => {
      if (l.key !== key) return [l];
      const qty = l.qty + delta;
      return qty <= 0 ? [] : [{ ...l, qty }];
    }));
  };

  const cartTotal = cart.reduce(
    (s, l) => s + (Math.round(Number(l.dish.price) * 100) + l.modifier_delta_cents) * l.qty, 0
  );

  // Invia: crea le righe e le propone, in due chiamate consecutive con la
  // stessa chiave di idempotenza. Se la seconda fallisce le righe restano in
  // bozza sul server — recuperabili, mai perse.
  const submit = async () => {
    if (!order || cart.length === 0 || busy) return;
    setBusy(true); setError(null);
    try {
      const payload: NewOrderItem[] = cart.map(l => ({
        dish_id: l.dish.id,
        qty: l.qty,
        course_no: l.course_no,
        modifier_ids: l.modifier_ids,
        note: l.note ?? null,
      }));
      const key = newIdempotencyKey();
      await ordersApiService.addItems(order.order.id, payload, key);
      const sent = await ordersApiService.send(order.order.id, undefined, key);
      setOrder(sent);
      setCart([]);
      setCourse(c => c + 1);
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
            paid_cents: 0, residual_cents: b.total_cents, open_orders: 0,
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
  const settleViewBill = async () => {
    if (!viewBill || busy) return;
    setBusy(true); setError(null);
    try {
      await billsApiService.closeBill(viewBill.id);
      setServiceBills(prev => { const n = new Map(prev); n.delete(viewBill.table_id); return n; });
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

  // ---------------- selezione tavolo ----------------
  if (!tableId || !order) {
    return (
      <div className="mx-auto max-w-3xl bg-[var(--ds-canvas)] p-4 lg:p-8">
        <h1 className="text-[26px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">Comande</h1>
        <p className="mb-5 mt-0.5 text-[14px] text-[var(--ds-text-muted)]">
          Scegli il tavolo per aprire o riprendere la comanda.
        </p>
        {error && (
          <div className="mb-4">
            <ErrorBar message={error} onDismiss={() => setError(null)} />
          </div>
        )}
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
              residual_cents: viewBill.residual_cents,
              open_orders: viewBill.open_orders,
            }}
            busy={busy}
            onClose={() => setViewBill(null)}
            onSettle={settleViewBill}
            footerExtra={
              <button
                type="button"
                onClick={() => { const tid = viewBill.table_id; setViewBill(null); loadTable(tid, { forceCreate: true }); }}
                disabled={busy}
                className={`w-full ${dsButton.secondary}`}
              >
                Nuova comanda su questo tavolo
              </button>
            }
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
            onClose={() => setJustClosed(null)}
          />
        )}
        {/* La conferma di chiusura arriva qui: dopo aver aperto il conto si
            torna alla scelta tavolo, e senza questo il cameriere non saprebbe
            se il conto è stato creato davvero. */}
        {flash && (
          <Callout tone="positive" icon={Check} className="mb-4">{flash}</Callout>
        )}
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {tables.map(t => {
            const res = reservationForTable(t.id);
            const hasOrder = openTables.has(t.id);
            const hasBill = !hasOrder && billTables.has(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => loadTable(t.id)}
                disabled={busy}
                className={`flex aspect-square flex-col items-center justify-center gap-0.5 rounded-[20px] p-1 shadow-[var(--ds-shadow-card)] transition-shadow disabled:opacity-50 ${
                  hasOrder ? TABLE_STATE.order
                  : hasBill ? TABLE_STATE.bill
                  : res ? TABLE_STATE.booked
                  : TABLE_STATE.free
                }`}
              >
                <span className="text-[20px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">
                  {t.name}
                </span>
                <span className="text-[12px] text-[var(--ds-text-muted)] tabular-nums">{t.seats} cop.</span>
                {res && (
                  <span className="max-w-full truncate px-1 text-[11px] font-medium text-[var(--ds-arriving-text)]">
                    {getRomeTimePart(res.reservation_time)} · {res.customer_name}
                  </span>
                )}
                {hasOrder && (
                  <span className="text-[11px] font-semibold text-[var(--ds-seated-text)]">comanda aperta</span>
                )}
                {hasBill && (
                  <span className="text-[11px] font-semibold text-[var(--ds-pending-text)]">conto da incassare</span>
                )}
              </button>
            );
          })}
        </div>
        {busy && (
          <div className="mt-6 flex items-center gap-2 text-[14px] text-[var(--ds-text-muted)]">
            <Loader2 size={16} className="animate-spin" /> Apertura…
          </div>
        )}
      </div>
    );
  }

  const table = tables.find(t => t.id === tableId);
  const allergens = reservation?.customer_dietary_notes?.trim();
  const visibleDishes = dishes.filter(d => (category ? d.category === category : true));

  return (
    <div className="flex h-full max-h-screen flex-col bg-[var(--ds-canvas)]">
      {/* Testata: chi è al tavolo e cosa non può mangiare */}
      <header className="flex-shrink-0 px-4 pb-3 pt-4">
        <div className="rounded-[20px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setTableId(null); setOrder(null); setCart([]); }}
              aria-label="Torna alla scelta del tavolo"
              className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]"
            >
              <ArrowLeft size={20} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
                Tav. {table?.name}
                {reservation ? ` · ${reservation.customer_name}` : ''}
              </div>
              <div className="text-[13px] text-[var(--ds-text-muted)] tabular-nums">
                Totale {euro(order.total_cents)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => closeAndBill(false)}
              disabled={busy}
              title="Chiudi la comanda e apri il conto"
              className={padQuiet}
            >
              <Receipt size={16} aria-hidden /> Conto
            </button>
          </div>

          {/* I coperti su una riga propria: erano due bersagli da 20px in mezzo
              a una riga di metadati, e sono il divisore del conto. */}
          <div className="mt-2 flex items-center gap-2 border-t border-[var(--ds-border)] pt-2">
            <span className="flex items-center gap-1.5 text-[14px] text-[var(--ds-text-muted)]">
              <Users size={14} aria-hidden /> Coperti
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => changeCovers(-1)}
                disabled={busy || order.order.covers <= 1}
                aria-label="Un coperto in meno"
                className={padStepper}
              >
                <Minus size={16} />
              </button>
              <span className="w-8 text-center text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                {order.order.covers}
              </span>
              <button
                type="button"
                onClick={() => changeCovers(+1)}
                disabled={busy}
                aria-label="Un coperto in più"
                className={padStepper}
              >
                <Plus size={16} />
              </button>
            </div>
          </div>

          {allergens && (
            <Callout tone="critical" icon={TriangleAlert} className="mt-2">{allergens}</Callout>
          )}
        </div>
      </header>

      {flash && (
        <div className="flex-shrink-0 px-4 pb-2">
          <Callout tone="positive" icon={Check}>{flash}</Callout>
        </div>
      )}
      {error && (
        <div className="flex-shrink-0 px-4 pb-2">
          <ErrorBar message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {/* Uscite già mandate, con lo stato scritto in chiaro */}
      {order.courses.some(c => c.status !== 'PENDING') && (
        <div className="flex flex-shrink-0 flex-wrap gap-2 px-4 pb-2">
          {order.courses.filter(c => c.status !== 'PENDING').map(c => {
            const badge = COURSE_BADGE[c.status] ?? COURSE_BADGE.PENDING;
            return (
              <StatusPill key={c.course_no} tone={badge.tone} className="h-8 px-3">
                {courseLabel(c.course_no)} · {badge.text}
                {c.status === 'QUEUED' && (
                  <button
                    type="button"
                    onClick={() => recall(c.course_no)}
                    disabled={busy}
                    title="Richiama: torna in bozza"
                    className="ml-1 font-semibold underline decoration-dotted transition-opacity hover:opacity-70"
                  >
                    richiama
                  </button>
                )}
              </StatusPill>
            );
          })}
        </div>
      )}

      {/* Righe già in cucina: da qui si stornano, con motivazione */}
      {order.items.some(i => i.status !== 'DRAFT' && i.line_kind !== 'COVER' && i.line_kind !== 'SERVICE') && (
        <details className="flex-shrink-0 px-4 pb-2">
          <summary className="cursor-pointer text-[13px] font-semibold text-[var(--ds-text-muted)]">
            Già ordinato ({order.items.filter(i => i.status !== 'DRAFT' && i.status !== 'VOIDED').length})
          </summary>
          <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-[16px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
            {order.items.filter(i => i.status !== 'DRAFT').map(i => (
              <div key={i.id} className="flex items-center gap-2 text-[14px]">
                <span
                  className={`min-w-0 flex-1 truncate ${
                    i.status === 'VOIDED'
                      ? 'text-[var(--ds-text-muted)] line-through'
                      : 'text-[var(--ds-text-primary)]'
                  }`}
                >
                  {i.qty}× {i.name_snapshot}
                  {i.line_kind !== 'DISH' && (
                    <span className="text-[13px] text-[var(--ds-text-muted)]"> · automatico</span>
                  )}
                </span>
                <span className="flex-shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                  {euro(i.line_total_cents ?? 0)}
                </span>
                {i.status !== 'VOIDED' && i.line_kind === 'DISH' && (
                  <button
                    type="button"
                    onClick={() => setVoidTarget(i)}
                    aria-label={`Storna ${i.name_snapshot}`}
                    title="Storna"
                    className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-critical-text)] transition-colors hover:bg-[var(--ds-critical-tint)]"
                  >
                    <Ban size={15} />
                  </button>
                )}
              </div>
            ))}
            {order.discount_cents > 0 && (
              <div className="flex justify-between border-t border-[var(--ds-border)] pt-2 text-[14px] font-medium text-[var(--ds-seated-text)]">
                <span>Sconto{order.order.discount_reason ? ` · ${order.order.discount_reason}` : ''}</span>
                <span className="tabular-nums">−{euro(order.discount_cents)}</span>
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setDiscountOpen(true)} className={padQuiet}>
                <Percent size={14} aria-hidden /> Sconto
              </button>
              <button type="button" onClick={() => setTransferOpen(true)} className={padQuiet}>
                <ArrowRightLeft size={14} aria-hidden /> Sposta tavolo
              </button>
            </div>
          </div>
        </details>
      )}

      {/* Catalogo */}
      <div className="flex flex-shrink-0 gap-2 overflow-x-auto px-4 pb-2">
        {categories.map(c => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            aria-pressed={category === c}
            className={`inline-flex h-11 flex-shrink-0 items-center whitespace-nowrap rounded-full px-4 text-[15px] font-medium transition-colors ${
              category === c
                ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] hover:text-[var(--ds-text-primary)]'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {visibleDishes.map(d => (
            <button
              key={d.id}
              type="button"
              onClick={() => onDishTap(d)}
              className="flex min-h-[56px] items-center justify-between gap-3 rounded-[16px] bg-[var(--ds-surface)] px-4 py-3 text-left shadow-[var(--ds-shadow-card)] transition-transform hover:bg-[var(--ds-surface-row)] active:scale-[0.99]"
            >
              <span className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{d.name}</span>
              <span className="flex flex-shrink-0 items-center gap-1 text-[14px] tabular-nums text-[var(--ds-text-muted)]">
                {euro(Math.round(Number(d.price) * 100))}
                {groupsForDish(d.id).length > 0 && <ChevronDown size={15} aria-hidden />}
              </span>
            </button>
          ))}
          {visibleDishes.length === 0 && (
            <p className="col-span-full py-8 text-center text-[14px] text-[var(--ds-text-muted)]">
              Nessun piatto in questa categoria.
            </p>
          )}
        </div>
      </div>

      {/* Carrello: l'uscita in composizione */}
      <div className="flex-shrink-0 px-4 pb-4">
        <div className="rounded-[20px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-raised)]">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-[var(--ds-text-muted)]">Sto componendo</span>
            <select
              value={course}
              onChange={e => setCourse(Number(e.target.value))}
              aria-label="Uscita in composizione"
              className="ds-select h-11 flex-1 rounded-full bg-[var(--ds-surface-row)] px-4 text-[15px] text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{courseLabel(n)}</option>)}
            </select>
          </div>

          <div className="max-h-48 overflow-y-auto py-2">
            {cart.length === 0 ? (
              <p className="py-3 text-[14px] text-[var(--ds-text-muted)]">Tocca un piatto per aggiungerlo.</p>
            ) : cart.map(l => (
              <div key={l.key} className="flex items-center gap-2 py-1">
                <span className="w-9 flex-shrink-0 text-[13px] text-[var(--ds-text-muted)]">
                  {ORDINALS[l.course_no] ?? l.course_no}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] text-[var(--ds-text-primary)]">{l.dish.name}</div>
                  {l.modifier_labels.length > 0 && (
                    <div className="truncate text-[13px] text-[var(--ds-text-muted)]">
                      ↳ {l.modifier_labels.join(', ')}
                    </div>
                  )}
                </div>
                <div className="flex flex-shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => bumpCart(l.key, -1)}
                    aria-label={`Uno in meno di ${l.dish.name}`}
                    className={padStepper}
                  >
                    <Minus size={15} />
                  </button>
                  <span className="w-7 text-center text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                    {l.qty}
                  </span>
                  <button
                    type="button"
                    onClick={() => bumpCart(l.key, +1)}
                    aria-label={`Uno in più di ${l.dish.name}`}
                    className={padStepper}
                  >
                    <Plus size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setCart(prev => prev.filter(x => x.key !== l.key))}
                    aria-label={`Togli ${l.dish.name}`}
                    className="ml-0.5 inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-critical-text)] transition-colors hover:bg-[var(--ds-critical-tint)]"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 border-t border-[var(--ds-border)] pt-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-[var(--ds-text-muted)]">Da inviare</div>
              <div className="text-[20px] font-semibold tabular-nums tracking-[-0.015em] text-[var(--ds-text-primary)]">
                {euro(cartTotal)}
              </div>
            </div>
            {/* Non "INVIA": il maiuscolo non aggiunge peso che il corpo e il
                grassetto non diano già, e si legge peggio (§5.2). */}
            <button
              type="button"
              onClick={submit}
              disabled={busy || cart.length === 0}
              className="inline-flex h-12 flex-shrink-0 items-center gap-2 rounded-full bg-[var(--ds-action-bg)] px-6 text-[17px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {busy ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              Invia
            </button>
          </div>
        </div>
      </div>

      <ModalShell
        open={closing}
        onClose={() => setClosing(false)}
        title="Righe non inviate"
        size="sm"
        closeOnEscape
        bodyClassName="p-5 sm:p-6"
        footerLayout="row"
        footer={
          <button
            type="button"
            onClick={() => closeAndBill(true)}
            disabled={busy}
            className="inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-[var(--ds-critical-solid)] px-5 text-[15px] font-semibold text-[var(--ds-critical-fg)] transition-[filter] hover:brightness-95 disabled:opacity-40 sm:flex-none"
          >
            Scarta e chiudi
          </button>
        }
      >
        <p className="text-[15px] leading-relaxed text-[var(--ds-text-secondary)]">
          Ci sono righe che non sono mai arrivate in cucina. Chiudendo ora
          vengono eliminate e non finiranno sul conto.
        </p>
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

      {discountOpen && order && (
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
        open={transferOpen && !!order}
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
          onConfirm={ids => { addToCart(variantFor, ids); setVariantFor(null); }}
        />
      )}
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
  onConfirm: (ids: number[]) => void;
}> = ({ dish, groups, onCancel, onConfirm }) => {
  const [selected, setSelected] = useState<number[]>([]);

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
          onClick={() => onConfirm(selected)}
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
    </Sheet>
  );
};

// Dialogo con motivazione obbligatoria. Usato per gli storni: senza un motivo
// scritto, a fine mese lo scarto è un ammanco che nessuno sa spiegare.
const ReasonDialog: React.FC<{
  title: string;
  hint: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}> = ({ title, hint, confirmLabel, busy, onCancel, onConfirm }) => {
  const [reason, setReason] = useState('');
  const PRESETS = ['Errore di battitura', 'Cliente ha cambiato idea', 'Piatto non riuscito', 'Ingrediente finito'];
  return (
    <ModalShell
      open
      onClose={onCancel}
      title={title}
      subtitle={hint}
      size="sm"
      closeOnEscape
      bodyClassName="space-y-3 p-5 sm:p-6"
      footer={
        <button
          type="button"
          onClick={() => onConfirm(reason.trim())}
          disabled={busy || reason.trim().length < 3}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[var(--ds-critical-solid)] px-5 text-[15px] font-semibold text-[var(--ds-critical-fg)] transition-[filter] hover:brightness-95 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {confirmLabel}
        </button>
      }
    >
      <div className="flex flex-wrap gap-2">
        {PRESETS.map(pr => (
          <button
            key={pr}
            type="button"
            onClick={() => setReason(pr)}
            aria-pressed={reason === pr}
            className={`inline-flex h-11 items-center rounded-full px-3.5 text-[14px] font-medium transition-colors ${
              reason === pr
                ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
            }`}
          >
            {pr}
          </button>
        ))}
      </div>
      <input
        value={reason}
        onChange={e => setReason(e.target.value)}
        autoFocus
        placeholder="Motivazione"
        aria-label="Motivazione"
        className={dsInput}
      />
    </ModalShell>
  );
};

const DiscountDialog: React.FC<{
  currentReason: string | null;
  hasDiscount: boolean;
  busy: boolean;
  onCancel: () => void;
  onClear: () => void;
  onConfirm: (p: { discount_type: 'PERCENT' | 'AMOUNT'; discount_value: number; reason: string }) => void;
}> = ({ currentReason, hasDiscount, busy, onCancel, onClear, onConfirm }) => {
  const [type, setType] = useState<'PERCENT' | 'AMOUNT'>('PERCENT');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState(currentReason ?? '');
  const num = Number(value.replace(',', '.'));
  const valid = Number.isFinite(num) && num > 0 && (type !== 'PERCENT' || num <= 100) && reason.trim().length >= 3;

  return (
    <ModalShell
      open
      onClose={onCancel}
      title="Sconto sulla comanda"
      subtitle="Resta a registro con il tuo nome: serve a spiegare la differenza a fine servizio."
      size="sm"
      closeOnEscape
      bodyClassName="space-y-3 p-5 sm:p-6"
      footerStart={
        hasDiscount ? (
          <button type="button" onClick={onClear} disabled={busy} className={dsButton.quiet}>
            Rimuovi
          </button>
        ) : undefined
      }
      footer={
        <button
          type="button"
          onClick={() => onConfirm({ discount_type: type, discount_value: num, reason: reason.trim() })}
          disabled={busy || !valid}
          className={dsButton.primary}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Applica
        </button>
      }
    >
      <SegmentedControl<'PERCENT' | 'AMOUNT'>
        value={type}
        onChange={setType}
        ariaLabel="Tipo di sconto"
        options={[
          { value: 'PERCENT', label: 'Percentuale' },
          { value: 'AMOUNT', label: 'Importo €' },
        ]}
      />
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        inputMode="decimal"
        autoFocus
        placeholder={type === 'PERCENT' ? '10' : '5,00'}
        aria-label={type === 'PERCENT' ? 'Percentuale di sconto' : 'Importo dello sconto'}
        className={dsInput}
      />
      <input
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Motivazione (obbligatoria)"
        aria-label="Motivazione dello sconto"
        className={dsInput}
      />
    </ModalShell>
  );
};
