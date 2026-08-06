import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, ArrowRightLeft, Ban, Check, ChevronDown, Clock, Loader2, Minus,
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

// ---------------------------------------------------------------------------
// Palmare cameriere — la comanda si compone qui e parte con un tocco.
//
// Pensato per una mano sola, in piedi, con poca luce: bersagli grandi, niente
// interazioni fini, lo stato di ogni uscita scritto a lettere invece che
// affidato al colore.
//
// Il carrello resta locale finché non si preme INVIA: il cameriere si corregge
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
const COURSE_BADGE: Record<string, { text: string; cls: string }> = {
  QUEUED:  { text: '⏸ al passe',  cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
  FIRED:   { text: '✓ in cucina', cls: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200' },
  READY:   { text: '● pronta',    cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' },
  SERVED:  { text: 'servita',     cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  PENDING: { text: 'in bozza',    cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
};

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
  // Tavoli con conto attivo non incassato nel servizio selezionato: la
  // comanda è chiusa ma il tavolo non è libero finché non si paga.
  const [billTables, setBillTables] = useState<Set<number>>(new Set());

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

  const loadTable = useCallback(async (id: number) => {
    setBusy(true); setError(null);
    try {
      let view = await ordersApiService.getOrderByTable(id, serviceQuery);
      if (!view) {
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
  }, [reservationForTable, tables, serviceQuery, isTodayRome]);

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
        const bills = await ordersApiService.getTablesBillsStatus(serviceQuery);
        if (!cancelled) setBillTables(new Set(bills.tables.map(t => t.table_id)));
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

  // INVIA: crea le righe e le propone, in due chiamate consecutive con la
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
          setBillTables(prev => new Set(prev).add(tid));
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

  // ---------------- selezione tavolo ----------------
  if (!tableId || !order) {
    return (
      <div className="p-4 lg:p-8 max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold mb-1">Comande</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
          Scegli il tavolo per aprire o riprendere la comanda.
        </p>
        {error && <ErrorBar message={error} onDismiss={() => setError(null)} />}
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
          <div className="mb-4 px-3 py-2 rounded-lg bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200 text-sm flex items-center gap-2">
            <Check size={16} /> {flash}
          </div>
        )}
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {tables.map(t => {
            const res = reservationForTable(t.id);
            return (
            <button
              key={t.id}
              onClick={() => loadTable(t.id)}
              disabled={busy}
              className={`aspect-square rounded-2xl border-2 flex flex-col items-center justify-center gap-1 transition
                ${openTables.has(t.id)
                  ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40'
                  : billTables.has(t.id)
                    ? 'border-violet-500 bg-violet-50/70 dark:border-violet-600 dark:bg-violet-950/30 hover:border-violet-600'
                    : res
                      ? 'border-amber-400 bg-amber-50/60 dark:border-amber-600 dark:bg-amber-950/30 hover:border-amber-500'
                      : 'border-slate-200 dark:border-slate-700 hover:border-slate-400'}
                disabled:opacity-50`}
            >
              <span className="text-xl font-semibold">{t.name}</span>
              <span className="text-[11px] text-slate-500">{t.seats} cop.</span>
              {res && (
                <span className="text-[10px] font-medium text-amber-700 dark:text-amber-300 truncate max-w-full px-1">
                  {getRomeTimePart(res.reservation_time)} · {res.customer_name}
                </span>
              )}
              {openTables.has(t.id) && (
                <span className="text-[10px] font-medium text-sky-700 dark:text-sky-300">comanda aperta</span>
              )}
              {!openTables.has(t.id) && billTables.has(t.id) && (
                <span className="text-[10px] font-medium text-violet-700 dark:text-violet-300">conto da incassare</span>
              )}
            </button>
            );
          })}
        </div>
        {busy && <div className="mt-6 flex items-center gap-2 text-slate-500"><Loader2 size={16} className="animate-spin" /> Apertura…</div>}
      </div>
    );
  }

  const table = tables.find(t => t.id === tableId);
  const allergens = reservation?.customer_dietary_notes?.trim();
  const visibleDishes = dishes.filter(d => (category ? d.category === category : true));

  return (
    <div className="flex flex-col h-full max-h-screen">
      {/* Testata: chi è al tavolo e cosa non può mangiare */}
      <header className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => { setTableId(null); setOrder(null); setCart([]); }}
                  className="p-2 -ml-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
            <ArrowLeft size={20} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="font-semibold truncate">
              Tav. {table?.name}
              {reservation ? ` · ${reservation.customer_name}` : ''}
            </div>
            <div className="text-xs text-slate-500 flex items-center gap-2">
              <span>Totale {euro(order.total_cents)}</span>
              <span className="flex items-center gap-1">
                <Users size={12} />
                <button onClick={() => changeCovers(-1)} disabled={busy}
                        className="px-1.5 rounded border border-slate-300 dark:border-slate-600">−</button>
                <span className="tabular-nums w-4 text-center">{order.order.covers}</span>
                <button onClick={() => changeCovers(+1)} disabled={busy}
                        className="px-1.5 rounded border border-slate-300 dark:border-slate-600">+</button>
                cop.
              </span>
            </div>
          </div>
          <button onClick={() => closeAndBill(false)} disabled={busy}
                  title="Chiudi la comanda e apri il conto"
                  className="shrink-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-sm flex items-center gap-1.5">
            <Receipt size={15} /> Conto
          </button>
        </div>
        {allergens && (
          <div className="mt-2 flex items-start gap-2 text-sm px-3 py-2 rounded-lg bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" />
            <span>{allergens}</span>
          </div>
        )}
      </header>

      {flash && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200 text-sm flex items-center gap-2">
          <Check size={16} /> {flash}
        </div>
      )}
      {error && <div className="px-4 pt-3"><ErrorBar message={error} onDismiss={() => setError(null)} /></div>}

      {/* Uscite già mandate, con lo stato scritto in chiaro */}
      {order.courses.some(c => c.status !== 'PENDING') && (
        <div className="px-4 pt-3 flex flex-wrap gap-2 shrink-0">
          {order.courses.filter(c => c.status !== 'PENDING').map(c => {
            const badge = COURSE_BADGE[c.status] ?? COURSE_BADGE.PENDING;
            return (
              <div key={c.course_no} className={`px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-2 ${badge.cls}`}>
                <span>{courseLabel(c.course_no)} · {badge.text}</span>
                {c.status === 'QUEUED' && (
                  <button onClick={() => recall(c.course_no)} disabled={busy}
                          title="Richiama: torna in bozza"
                          className="underline decoration-dotted hover:opacity-70">richiama</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Righe già in cucina: da qui si stornano, con motivazione */}
      {order.items.some(i => i.status !== 'DRAFT' && i.line_kind !== 'COVER' && i.line_kind !== 'SERVICE') && (
        <details className="px-4 pt-2 shrink-0">
          <summary className="text-xs uppercase tracking-wide text-slate-500 cursor-pointer">
            Già ordinato ({order.items.filter(i => i.status !== 'DRAFT' && i.status !== 'VOIDED').length})
          </summary>
          <div className="mt-2 max-h-40 overflow-y-auto space-y-1">
            {order.items.filter(i => i.status !== 'DRAFT').map(i => (
              <div key={i.id} className="flex items-center gap-2 text-sm">
                <span className={`flex-1 truncate ${i.status === 'VOIDED' ? 'line-through text-slate-400' : ''}`}>
                  {i.qty}× {i.name_snapshot}
                  {i.line_kind !== 'DISH' && <span className="text-xs text-slate-400"> · automatico</span>}
                </span>
                <span className="text-xs text-slate-500 tabular-nums">{euro(i.line_total_cents ?? 0)}</span>
                {i.status !== 'VOIDED' && i.line_kind === 'DISH' && (
                  <button onClick={() => setVoidTarget(i)} title="Storna"
                          className="p-1 text-rose-600"><Ban size={14} /></button>
                )}
              </div>
            ))}
          </div>
          {order.discount_cents > 0 && (
            <div className="mt-2 text-sm flex justify-between text-emerald-700 dark:text-emerald-300">
              <span>Sconto{order.order.discount_reason ? ` · ${order.order.discount_reason}` : ''}</span>
              <span>−{euro(order.discount_cents)}</span>
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <button onClick={() => setDiscountOpen(true)}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 flex items-center gap-1">
              <Percent size={12} /> Sconto
            </button>
            <button onClick={() => setTransferOpen(true)}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 flex items-center gap-1">
              <ArrowRightLeft size={12} /> Sposta tavolo
            </button>
          </div>
        </details>
      )}

      {/* Catalogo */}
      <div className="px-4 pt-3 shrink-0 flex gap-2 overflow-x-auto pb-2">
        {categories.map(c => (
          <button key={c} onClick={() => setCategory(c)}
                  className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap border
                    ${category === c ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900'
                                     : 'border-slate-300 dark:border-slate-600'}`}>
            {c}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
          {visibleDishes.map(d => (
            <button key={d.id} onClick={() => onDishTap(d)}
                    className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 text-left hover:border-slate-400 active:scale-[0.99] transition">
              <span className="font-medium truncate">{d.name}</span>
              <span className="text-sm text-slate-500 shrink-0">
                {euro(Math.round(Number(d.price) * 100))}
                {groupsForDish(d.id).length > 0 && <ChevronDown size={14} className="inline ml-1" />}
              </span>
            </button>
          ))}
          {visibleDishes.length === 0 && (
            <p className="text-sm text-slate-500 py-8 text-center col-span-full">Nessun piatto in questa categoria.</p>
          )}
        </div>
      </div>

      {/* Carrello: l'uscita in composizione */}
      <div className="border-t border-slate-200 dark:border-slate-700 shrink-0 bg-white dark:bg-slate-900">
        <div className="px-4 pt-3 flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-slate-500">Sto componendo</span>
          <select value={course} onChange={e => setCourse(Number(e.target.value))}
                  className="text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent px-2 py-1">
            {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{courseLabel(n)}</option>)}
          </select>
        </div>

        <div className="px-4 py-2 max-h-48 overflow-y-auto">
          {cart.length === 0 ? (
            <p className="text-sm text-slate-400 py-3">Tocca un piatto per aggiungerlo.</p>
          ) : cart.map(l => (
            <div key={l.key} className="flex items-center gap-3 py-1.5">
              <span className="text-xs text-slate-400 w-10 shrink-0">{ORDINALS[l.course_no] ?? l.course_no}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{l.dish.name}</div>
                {l.modifier_labels.length > 0 && (
                  <div className="text-xs text-slate-500 truncate">↳ {l.modifier_labels.join(', ')}</div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => bumpCart(l.key, -1)} className="p-1.5 rounded-lg border border-slate-300 dark:border-slate-600"><Minus size={14} /></button>
                <span className="w-6 text-center text-sm font-medium">{l.qty}</span>
                <button onClick={() => bumpCart(l.key, +1)} className="p-1.5 rounded-lg border border-slate-300 dark:border-slate-600"><Plus size={14} /></button>
                <button onClick={() => setCart(prev => prev.filter(x => x.key !== l.key))} className="p-1.5 ml-1 rounded-lg text-rose-600"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>

        <div className="px-4 py-3 flex items-center gap-3 border-t border-slate-100 dark:border-slate-800">
          <div className="flex-1">
            <div className="text-xs text-slate-500">Da inviare</div>
            <div className="text-lg font-semibold">{euro(cartTotal)}</div>
          </div>
          <button onClick={submit} disabled={busy || cart.length === 0}
                  className="px-6 py-3 rounded-xl bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-semibold flex items-center gap-2 disabled:opacity-40">
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
            INVIA
          </button>
        </div>
      </div>

      {closing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
             onClick={() => setClosing(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-semibold mb-2">Righe non inviate</h2>
            <p className="text-sm text-slate-500 mb-4">
              Ci sono righe che non sono mai arrivate in cucina. Chiudendo ora
              vengono eliminate e non finiranno sul conto.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setClosing(false)}
                      className="flex-1 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600">
                Annulla
              </button>
              <button onClick={() => closeAndBill(true)} disabled={busy}
                      className="flex-1 py-2.5 rounded-xl bg-rose-600 text-white font-semibold">
                Scarta e chiudi
              </button>
            </div>
          </div>
        </div>
      )}

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

      {transferOpen && order && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
             onClick={() => setTransferOpen(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-semibold mb-1">Sposta su quale tavolo?</h2>
            <p className="text-xs text-slate-500 mb-4">
              Comanda e conto si spostano insieme. Le quote già pagate restano attaccate al conto.
            </p>
            <div className="grid grid-cols-4 gap-2 max-h-64 overflow-y-auto">
              {tables.filter(t => t.id !== tableId).map(t => (
                <button key={t.id} onClick={() => doTransfer(t.id)} disabled={busy}
                        className="py-3 rounded-xl border border-slate-300 dark:border-slate-600 font-semibold disabled:opacity-40">
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

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
  <div className="px-3 py-2 rounded-lg bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200 text-sm flex items-start gap-2">
    <TriangleAlert size={16} className="mt-0.5 shrink-0" />
    <span className="flex-1">{message}</span>
    <button onClick={onDismiss} className="shrink-0"><X size={16} /></button>
  </div>
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
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="w-full sm:max-w-md bg-white dark:bg-slate-900 rounded-t-2xl sm:rounded-2xl p-4 max-h-[80vh] overflow-y-auto"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <Utensils size={18} />
          <h2 className="font-semibold flex-1">{dish.name}</h2>
          <button onClick={onCancel} className="p-1"><X size={18} /></button>
        </div>

        {groups.map(g => {
          const single = g.max_select <= 1;
          return (
            <div key={g.id} className="mb-4">
              <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">
                {g.name}{g.min_select > 0 && <span className="text-rose-500"> · obbligatorio</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                {g.modifiers.map(m => (
                  <button key={m.id} onClick={() => toggle(g.id, m.id, single)}
                          className={`px-3 py-2 rounded-xl border text-sm
                            ${selected.includes(m.id)
                              ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900'
                              : 'border-slate-300 dark:border-slate-600'}`}>
                    {m.name}
                    {m.price_delta_cents !== 0 && (
                      <span className="ml-1 opacity-70">
                        {m.price_delta_cents > 0 ? '+' : '−'}{euro(Math.abs(m.price_delta_cents))}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        <button onClick={() => onConfirm(selected)} disabled={missing.length > 0}
                className="w-full py-3 rounded-xl bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-semibold disabled:opacity-40">
          {missing.length > 0 ? `Scegli: ${missing.map(g => g.name).join(', ')}` : 'Aggiungi'}
        </button>
      </div>
    </div>
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
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <h2 className="font-semibold mb-1">{title}</h2>
        <p className="text-xs text-slate-500 mb-3">{hint}</p>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {PRESETS.map(pr => (
            <button key={pr} onClick={() => setReason(pr)}
                    className={`text-xs px-2 py-1 rounded-lg border ${reason === pr ? 'border-slate-900 dark:border-white' : 'border-slate-300 dark:border-slate-600'}`}>
              {pr}
            </button>
          ))}
        </div>
        <input value={reason} onChange={e => setReason(e.target.value)} autoFocus
               placeholder="Motivazione"
               className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent mb-3" />
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600">
            Annulla
          </button>
          <button onClick={() => onConfirm(reason.trim())} disabled={busy || reason.trim().length < 3}
                  className="flex-1 py-2.5 rounded-xl bg-rose-600 text-white font-semibold disabled:opacity-40">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
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
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <h2 className="font-semibold mb-1">Sconto sulla comanda</h2>
        <p className="text-xs text-slate-500 mb-3">
          Resta a registro con il tuo nome: serve a spiegare la differenza a fine servizio.
        </p>
        <div className="flex gap-2 mb-3">
          {(['PERCENT', 'AMOUNT'] as const).map(t => (
            <button key={t} onClick={() => setType(t)}
                    className={`flex-1 py-2 rounded-lg border ${type === t ? 'border-slate-900 dark:border-white font-semibold' : 'border-slate-300 dark:border-slate-600'}`}>
              {t === 'PERCENT' ? 'Percentuale' : 'Importo €'}
            </button>
          ))}
        </div>
        <input value={value} onChange={e => setValue(e.target.value)} inputMode="decimal" autoFocus
               placeholder={type === 'PERCENT' ? '10' : '5,00'}
               className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent mb-3" />
        <input value={reason} onChange={e => setReason(e.target.value)}
               placeholder="Motivazione (obbligatoria)"
               className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent mb-3" />
        <div className="flex gap-2">
          {hasDiscount && (
            <button onClick={onClear} disabled={busy}
                    className="px-3 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 text-sm">
              Rimuovi
            </button>
          )}
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600">
            Annulla
          </button>
          <button onClick={() => onConfirm({ discount_type: type, discount_value: num, reason: reason.trim() })}
                  disabled={busy || !valid}
                  className="flex-1 py-2.5 rounded-xl bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-semibold disabled:opacity-40">
            Applica
          </button>
        </div>
      </div>
    </div>
  );
};
