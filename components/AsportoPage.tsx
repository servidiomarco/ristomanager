import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Ban,
  Check,
  ChefHat,
  ChevronLeft,
  ChevronRight,
  Minus,
  Pencil,
  Phone,
  Plus,
  ShoppingBag,
  X,
} from 'lucide-react';
import { Dish, TakeawayOrderView, TakeawaySlotBoard } from '../types';
import { asportoApiService, TakeawayConfig, TakeawayItemPayload } from '../services/asportoApiService';
import { socketClient } from '../services/socketClient';
import { useAuth } from '../contexts/AuthContext';
import { useNow } from '../hooks/useNow';
import {
  AsportoStateKey,
  AsportoStatusChip,
  ASPORTO_STATE_META,
  asportoStateDs,
  asportoStatusFor,
  getTimedAsportoState,
} from './asportoState';
import { euro } from './comande/orderView';
import {
  Callout,
  EmptyState,
  Field,
  FormCard,
  ModalShell,
  SearchField,
  SegmentedControl,
  StatStrip,
  Stepper,
  dsButton,
  dsIconButton,
  dsInput,
  dsTextarea,
  useMediaQuery,
} from './ds';

/* ===========================================================================
   Asporto — la board del banco.

   Lista del giorno ordinata per ora di ritiro, dettaglio a fianco (drawer a
   tutto schermo sotto lg), creazione e modifica in un ModalShell. Lo stato
   visivo è SEMPRE getTimedAsportoState: «Da produrre» e «Ritiro in ritardo»
   compaiono da soli con l'orologio, il banco muove solo gli stati veri.

   La pagina possiede i suoi dati (asportoApiService) e si tiene fresca con
   gli eventi socket takeaway:* — che il server manda a tutti, mittente
   compreso, perché la riga del server è autoritativa come una prenotazione.
   ========================================================================= */

interface AsportoPageProps {
  dishes: Dish[];
  isInitialLoading?: boolean;
}

/** Oggi in Italia, qualunque sia il fuso del dispositivo. */
const todayIso = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());

const addDaysIso = (iso: string, days: number): string => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const dateLabel = (iso: string): string => {
  if (iso === todayIso()) return 'Oggi';
  return new Date(`${iso}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
};

type ListFilter = 'attivi' | 'tutti';

const ACTIVE_STATES: AsportoStateKey[] = ['requested', 'confirmed', 'due', 'preparing', 'ready', 'late'];

/* ── Riga d'ordine in composizione (sheet nuovo/modifica) ───────────────── */
interface DraftItem {
  dish_id: number;
  name: string;
  price_cents: number;
  qty: number;
  note: string;
}

const draftFromView = (o: TakeawayOrderView): DraftItem[] =>
  o.items.map(i => ({
    dish_id: i.dish_id ?? 0,
    name: i.name_snapshot,
    price_cents: i.unit_price_cents,
    qty: i.qty,
    note: i.note ?? '',
  }));

export const AsportoPage: React.FC<AsportoPageProps> = ({ dishes, isInitialLoading }) => {
  const [date, setDate] = useState(todayIso());
  const [orders, setOrders] = useState<TakeawayOrderView[]>([]);
  const [prepMinutes, setPrepMinutes] = useState(20);
  const [stopDate, setStopDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<ListFilter>('attivi');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sheetOrder, setSheetOrder] = useState<TakeawayOrderView | null | 'new'>(null);
  const now = useNow(30_000);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const { hasPermission } = useAuth();
  const canManage = hasPermission('takeaway:manage');

  const dateRef = useRef(date);
  dateRef.current = date;

  const fetchDay = useCallback(async (day: string) => {
    setLoading(true);
    setLoadError(false);
    try {
      const [list, config] = await Promise.all([
        asportoApiService.getOrders(day),
        asportoApiService.getConfig(),
      ]);
      if (dateRef.current !== day) return;
      setOrders(list.orders);
      setPrepMinutes(config.prep_minutes);
      setStopDate(config.stop_date);
    } catch {
      if (dateRef.current === day) setLoadError(true);
    } finally {
      if (dateRef.current === day) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDay(date); }, [date, fetchDay]);

  // Upsert dal socket: se l'ordine è del giorno a schermo entra o si
  // aggiorna, se è stato spostato altrove esce. Attach/re-attach come i
  // badge di App: al primo render il socket può essere null.
  useEffect(() => {
    const onEvent = (view: TakeawayOrderView) => {
      if (!view || typeof view.id !== 'number') return;
      setOrders(prev => {
        const mine = view.pickup_date === dateRef.current;
        const without = prev.filter(o => o.id !== view.id);
        if (!mine) return without.length === prev.length ? prev : without;
        const next = [...without, view];
        next.sort((a, b) => a.pickup_time.localeCompare(b.pickup_time) || a.id - b.id);
        return next;
      });
    };
    const onConnect = () => { fetchDay(dateRef.current); };
    const onConfig = (config: TakeawayConfig) => {
      if (!config) return;
      setPrepMinutes(config.prep_minutes);
      setStopDate(config.stop_date);
    };
    const attach = (socket: ReturnType<typeof socketClient.getSocket>) => {
      if (!socket) return () => {};
      socket.on('takeaway:created', onEvent);
      socket.on('takeaway:updated', onEvent);
      socket.on('takeaway:config', onConfig);
      socket.on('connect', onConnect);
      return () => {
        socket.off('takeaway:created', onEvent);
        socket.off('takeaway:updated', onEvent);
        socket.off('takeaway:config', onConfig);
        socket.off('connect', onConnect);
      };
    };
    let detach = attach(socketClient.getSocket());
    const unsubscribe = socketClient.onSocketChange(socket => {
      detach();
      detach = attach(socket);
    });
    return () => { detach(); unsubscribe(); };
  }, [fetchDay]);

  const stateOf = useCallback(
    (o: TakeawayOrderView) => getTimedAsportoState(o, now, prepMinutes),
    [now, prepMinutes]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter(o => {
      if (filter === 'attivi' && !ACTIVE_STATES.includes(stateOf(o))) return false;
      if (!q) return true;
      return o.customer_name.toLowerCase().includes(q)
        || (o.customer_phone ?? '').replace(/\s/g, '').includes(q.replace(/\s/g, ''));
    });
  }, [orders, filter, search, stateOf]);

  const bySlot = useMemo(() => {
    const groups = new Map<string, TakeawayOrderView[]>();
    for (const o of visible) {
      if (!groups.has(o.pickup_time)) groups.set(o.pickup_time, []);
      groups.get(o.pickup_time)!.push(o);
    }
    return [...groups.entries()];
  }, [visible]);

  const counts = useMemo(() => {
    let due = 0, ready = 0, picked = 0, active = 0;
    for (const o of orders) {
      const s = stateOf(o);
      if (s === 'due' || s === 'late') due += 1;
      if (s === 'ready' || s === 'late') ready += 1;
      if (s === 'picked') picked += 1;
      if (ACTIVE_STATES.includes(s)) active += 1;
    }
    return { due, ready, picked, active };
  }, [orders, stateOf]);

  const selected = selectedId != null ? orders.find(o => o.id === selectedId) ?? null : null;

  const applyView = (view: TakeawayOrderView) => {
    setOrders(prev => {
      const without = prev.filter(o => o.id !== view.id);
      if (view.pickup_date !== dateRef.current) return without;
      const next = [...without, view];
      next.sort((a, b) => a.pickup_time.localeCompare(b.pickup_time) || a.id - b.id);
      return next;
    });
  };

  const setStatus = async (order: TakeawayOrderView, state: Exclude<AsportoStateKey, 'due' | 'late'>) => {
    try {
      applyView(await asportoApiService.setStatus(order.id, asportoStatusFor(state)));
    } catch {
      fetchDay(dateRef.current);
    }
  };

  const detail = selected && (
    <DetailPanel
      order={selected}
      state={stateOf(selected)}
      readOnly={!canManage}
      onSetStatus={state => setStatus(selected, state)}
      onEdit={() => setSheetOrder(selected)}
      onClose={() => setSelectedId(null)}
    />
  );

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 p-4 lg:p-6">
      {/* Testata: giorno + nuovo ordine */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto flex items-center gap-2 text-[22px] font-semibold text-[var(--ds-text-primary)]">
          <ShoppingBag className="h-5 w-5" aria-hidden />
          Asporto
        </h1>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setDate(d => addDaysIso(d, -1))} aria-label="Giorno precedente" className={dsIconButton}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setDate(todayIso())}
            className="h-9 min-w-[96px] rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-3 text-[14px] font-medium text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]"
          >
            {dateLabel(date)}
          </button>
          <button type="button" onClick={() => setDate(d => addDaysIso(d, 1))} aria-label="Giorno successivo" className={dsIconButton}>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        {canManage && stopDate !== date && (
          <button
            type="button"
            onClick={() => asportoApiService.updateConfig({ stop_date: date }).then(c => { setStopDate(c.stop_date); setPrepMinutes(c.prep_minutes); }).catch(() => {})}
            aria-label="Ferma asporto per questo giorno"
            title="Ferma asporto per questo giorno"
            className={dsIconButton}
          >
            <Ban className="h-4 w-4" />
          </button>
        )}
        {canManage && (
          <button type="button" onClick={() => setSheetOrder('new')} className={dsButton.primary}>
            <Plus className="h-4 w-4" aria-hidden />
            Nuovo ordine
          </button>
        )}
      </div>

      {stopDate === date && (
        <Callout
          tone="pending"
          icon={Ban}
          title="Asporto fermo per questa data"
          action={
            canManage ? (
              <button
                type="button"
                onClick={() => asportoApiService.updateConfig({ stop_date: null }).then(c => { setStopDate(c.stop_date); setPrepMinutes(c.prep_minutes); }).catch(() => {})}
                className="rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-3 py-1.5 text-[13px] font-medium text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)]"
              >
                Riapri
              </button>
            ) : undefined
          }
        >
          Niente ordini nuovi finché non si riapre.
        </Callout>
      )}

      <StatStrip
        stats={[
          { value: counts.active, label: 'attivi' },
          { value: counts.due, label: 'da produrre', tone: counts.due > 0 ? 'pending' : 'neutral', tint: counts.due > 0 },
          { value: counts.ready, label: 'pronti', tone: counts.ready > 0 ? 'positive' : 'neutral' },
          { value: counts.picked, label: 'ritirati' },
        ]}
      />

      <div className="flex flex-1 gap-4 overflow-hidden max-lg:flex-col">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-center gap-2">
            <SegmentedControl<ListFilter>
              value={filter}
              onChange={setFilter}
              ariaLabel="Filtro ordini"
              options={[
                { value: 'attivi', label: 'Attivi' },
                { value: 'tutti', label: 'Tutti' },
              ]}
              equalWidth={false}
            />
            <SearchField value={search} onChange={setSearch} placeholder="Nome o telefono" className="flex-1" />
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto pb-4">
            {loadError && (
              <Callout
                tone="critical"
                title="Ordini non caricati"
                action={<button type="button" className={dsButton.quiet} onClick={() => fetchDay(date)}>Riprova</button>}
              >
                Controlla la connessione e riprova.
              </Callout>
            )}
            {!loadError && !loading && !isInitialLoading && visible.length === 0 && (
              <EmptyState icon={ShoppingBag}>
                {orders.length === 0 ? 'Nessun ordine d’asporto per questo giorno.' : 'Nessun ordine con questi filtri.'}
              </EmptyState>
            )}
            {bySlot.map(([time, slotOrders]) => (
              <section key={time}>
                <div className="mb-2 flex items-baseline gap-2 px-1">
                  <span className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{time}</span>
                  <span className="text-[12px] text-[var(--ds-text-muted)]">
                    {slotOrders.length === 1 ? '1 ordine' : `${slotOrders.length} ordini`}
                  </span>
                </div>
                <div className="space-y-2">
                  {slotOrders.map(o => (
                    <OrderCard
                      key={o.id}
                      order={o}
                      state={stateOf(o)}
                      selected={o.id === selectedId}
                      onClick={() => setSelectedId(o.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>

        {isDesktop && (
          <aside className="hidden w-[340px] flex-shrink-0 lg:block xl:w-[380px]">
            {detail ?? (
              <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] px-6 py-12 text-center text-[14px] text-[var(--ds-text-muted)] shadow-[var(--ds-shadow-card)]">
                Scegli un ordine per vedere il dettaglio.
              </div>
            )}
          </aside>
        )}
      </div>

      {/* Dettaglio a tutto schermo sotto lg */}
      {!isDesktop && selected && (
        <ModalShell open onClose={() => setSelectedId(null)} title={selected.customer_name} bodyClassName="p-4">
          {detail}
        </ModalShell>
      )}

      {sheetOrder !== null && (
        <OrderSheet
          key={sheetOrder === 'new' ? 'new' : sheetOrder.id}
          dishes={dishes}
          initial={sheetOrder === 'new' ? null : sheetOrder}
          defaultDate={date}
          onClose={() => setSheetOrder(null)}
          onSaved={view => {
            applyView(view);
            setSheetOrder(null);
            setSelectedId(view.id);
            if (view.pickup_date !== dateRef.current) setDate(view.pickup_date);
          }}
        />
      )}
    </div>
  );
};

/* ── Card in lista ──────────────────────────────────────────────────────── */
const OrderCard: React.FC<{
  order: TakeawayOrderView;
  state: AsportoStateKey;
  selected: boolean;
  onClick: () => void;
}> = ({ order, state, selected, onClick }) => {
  const pieces = order.items.reduce((sum, i) => sum + i.qty, 0);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-3 text-left shadow-[var(--ds-shadow-card)] transition-shadow ${
        selected ? 'ring-2 ring-[var(--ds-border-focus)]' : 'hover:shadow-[var(--ds-shadow-card-hover)]'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">{order.customer_name}</div>
        <div className="mt-0.5 truncate text-[13px] text-[var(--ds-text-muted)]">
          {pieces === 1 ? '1 pezzo' : `${pieces} pezzi`} · {euro(order.total_cents)}
          {order.notes ? ` · ${order.notes}` : ''}
        </div>
      </div>
      <AsportoStatusChip state={state} />
    </button>
  );
};

/* ── Dettaglio ──────────────────────────────────────────────────────────── */
const DetailPanel: React.FC<{
  order: TakeawayOrderView;
  state: AsportoStateKey;
  readOnly?: boolean;
  onSetStatus: (state: Exclude<AsportoStateKey, 'due' | 'late'>) => void;
  onEdit: () => void;
  onClose: () => void;
}> = ({ order, state, readOnly, onSetStatus, onEdit }) => {
  const ds = asportoStateDs(state);
  // Il verbo giusto per lo stato in cui l'ordine si trova adesso: un solo
  // bottone primario, mai un menu di sette stati.
  const primary: { label: string; icon: React.ComponentType<{ className?: string }>; next: Exclude<AsportoStateKey, 'due' | 'late'> } | null =
    state === 'requested' ? { label: 'Conferma', icon: Check, next: 'confirmed' }
    : state === 'confirmed' || state === 'due' ? { label: 'In preparazione', icon: ChefHat, next: 'preparing' }
    : state === 'preparing' ? { label: 'Pronto', icon: Check, next: 'ready' }
    : state === 'ready' || state === 'late' ? { label: 'Ritirato', icon: ShoppingBag, next: 'picked' }
    : null;
  const closed = state === 'picked' || state === 'cancelled' || state === 'noshow';

  return (
    <div className="flex flex-col gap-4 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[17px] font-semibold text-[var(--ds-text-primary)]">{order.customer_name}</div>
          <div className={`mt-0.5 text-[14px] font-medium tabular-nums ${ds.text}`}>
            Ritiro {order.pickup_time} · {dateLabel(order.pickup_date)}
          </div>
        </div>
        <AsportoStatusChip state={state} />
      </div>

      {order.customer_phone && (
        <a
          href={`tel:${order.customer_phone.replace(/\s/g, '')}`}
          className="inline-flex h-11 items-center gap-2 self-start rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)]"
        >
          <Phone className="h-4 w-4" aria-hidden />
          {order.customer_phone}
        </a>
      )}

      <ul className="divide-y divide-[var(--ds-border)] rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] px-3">
        {order.items.map(item => (
          <li key={item.id} className="flex items-baseline gap-2 py-2.5 text-[14px]">
            <span className="font-semibold tabular-nums text-[var(--ds-text-primary)]">{item.qty}×</span>
            <span className="min-w-0 flex-1">
              <span className="text-[var(--ds-text-primary)]">{item.name_snapshot}</span>
              {item.note && <span className="block text-[13px] text-[var(--ds-text-muted)]">{item.note}</span>}
            </span>
            <span className="tabular-nums text-[var(--ds-text-secondary)]">{euro(item.unit_price_cents * item.qty)}</span>
          </li>
        ))}
        <li className="flex items-baseline justify-between py-2.5 text-[15px] font-semibold text-[var(--ds-text-primary)]">
          <span>Totale</span>
          <span className="tabular-nums">{euro(order.total_cents)}</span>
        </li>
      </ul>

      {order.notes && <p className="text-[14px] leading-relaxed text-[var(--ds-text-secondary)]">{order.notes}</p>}

      {!readOnly && <div className="flex flex-col gap-2">
        {primary && (
          <button type="button" onClick={() => onSetStatus(primary.next)} className={dsButton.primary}>
            <primary.icon className="h-4 w-4" aria-hidden />
            {primary.label}
          </button>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onEdit} className={`${dsButton.secondary} flex-1`}>
            <Pencil className="h-4 w-4" aria-hidden />
            Modifica
          </button>
          {state === 'late' && (
            <button type="button" onClick={() => onSetStatus('noshow')} className={`${dsButton.secondary} flex-1 text-[var(--ds-critical-text)]`}>
              Non ritirato
            </button>
          )}
          {!closed && (
            <button type="button" onClick={() => onSetStatus('cancelled')} className={`${dsButton.secondary} flex-1 text-[var(--ds-critical-text)]`}>
              Annulla
            </button>
          )}
          {closed && state !== 'picked' && (
            <button type="button" onClick={() => onSetStatus('confirmed')} className={`${dsButton.secondary} flex-1`}>
              Riattiva
            </button>
          )}
          {state === 'picked' && (
            <button type="button" onClick={() => onSetStatus('ready')} className={`${dsButton.secondary} flex-1`}>
              Torna a pronto
            </button>
          )}
        </div>
      </div>}
    </div>
  );
};

/* ── Sheet nuovo ordine / modifica ──────────────────────────────────────── */
const OrderSheet: React.FC<{
  dishes: Dish[];
  initial: TakeawayOrderView | null;
  defaultDate: string;
  onClose: () => void;
  onSaved: (view: TakeawayOrderView) => void;
}> = ({ dishes, initial, defaultDate, onClose, onSaved }) => {
  const [name, setName] = useState(initial?.customer_name ?? '');
  const [phone, setPhone] = useState(initial?.customer_phone ?? '');
  const [pickupDate, setPickupDate] = useState(initial?.pickup_date ?? defaultDate);
  const [pickupTime, setPickupTime] = useState<string | null>(initial?.pickup_time ?? null);
  const [items, setItems] = useState<DraftItem[]>(initial ? draftFromView(initial) : []);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [board, setBoard] = useState<TakeawaySlotBoard | null>(null);
  const [dishQuery, setDishQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canForce, setCanForce] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBoard(null);
    asportoApiService.getSlots(pickupDate)
      .then(b => { if (!cancelled) setBoard(b); })
      .catch(() => { if (!cancelled) setBoard(null); });
    return () => { cancelled = true; };
  }, [pickupDate]);

  const pickable = useMemo(() => {
    const q = dishQuery.trim().toLowerCase();
    if (!q) return [];
    return dishes
      .filter(d => d.is_active !== false && d.crm_enabled !== false && !d.sold_by_weight)
      .filter(d => d.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [dishes, dishQuery]);

  const addDish = (dish: Dish) => {
    setItems(prev => {
      const existing = prev.find(i => i.dish_id === dish.id && !i.note);
      if (existing) return prev.map(i => (i === existing ? { ...i, qty: i.qty + 1 } : i));
      return [...prev, { dish_id: dish.id, name: dish.name, price_cents: Math.round(Number(dish.price) * 100), qty: 1, note: '' }];
    });
    setDishQuery('');
  };

  const total = items.reduce((sum, i) => sum + i.price_cents * i.qty, 0);
  const valid = name.trim().length > 0 && pickupTime != null && items.length > 0;

  const save = async (force: boolean) => {
    if (!valid || pickupTime == null) return;
    setSaving(true);
    setError(null);
    setCanForce(false);
    const payload = {
      customer_name: name.trim(),
      customer_phone: phone.trim() || undefined,
      pickup_date: pickupDate,
      pickup_time: pickupTime,
      notes: notes.trim() || undefined,
      items: items.map<TakeawayItemPayload>(i => ({ dish_id: i.dish_id, qty: i.qty, note: i.note.trim() || undefined })),
      force: force || undefined,
    };
    try {
      const view = initial
        ? await asportoApiService.updateOrder(initial.id, payload)
        : await asportoApiService.createOrder(payload);
      onSaved(view);
    } catch (err: any) {
      if (err?.data?.error === 'slot_full') {
        setError('Slot al completo per la cucina.');
        setCanForce(true);
      } else if (err?.data?.error === 'takeaway_stopped') {
        setError('Asporto fermo per questa data.');
        setCanForce(true);
      } else if (err?.data?.error === 'invalid_slot') {
        setError('Orario fuori dalla griglia di apertura.');
      } else {
        setError('Salvataggio non riuscito. Riprova.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title={initial ? 'Modifica ordine' : 'Nuovo ordine d’asporto'}
      size="lg"
      bodyClassName="space-y-4 p-4"
      footer={
        <>
          <button type="button" onClick={onClose} className={dsButton.secondary} disabled={saving}>
            Annulla
          </button>
          {canForce && (
            <button type="button" onClick={() => save(true)} className={dsButton.secondary} disabled={saving}>
              Inserisci comunque
            </button>
          )}
          <button type="button" onClick={() => save(false)} className={dsButton.primary} disabled={!valid || saving}>
            {initial ? 'Salva' : `Crea ordine${total > 0 ? ` · ${euro(total)}` : ''}`}
          </button>
        </>
      }
    >
      <FormCard title="Cliente">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome" required>
            <input className={dsInput} value={name} onChange={e => setName(e.target.value)} autoFocus={!initial} />
          </Field>
          <Field label="Telefono">
            <input className={dsInput} type="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} />
          </Field>
        </div>
      </FormCard>

      <FormCard title="Ritiro">
        <div className="space-y-4">
          <Field label="Giorno">
            <input
              className={dsInput}
              type="date"
              value={pickupDate}
              onChange={e => { setPickupDate(e.target.value); setPickupTime(null); }}
            />
          </Field>
          {board?.stopped && (
            <Callout tone="pending" icon={Ban}>Asporto fermo per questa data.</Callout>
          )}
          <SlotGrid board={board} value={pickupTime} onChange={setPickupTime} />
        </div>
      </FormCard>

      <FormCard title="Ordine" aside={items.length > 0 ? <span className="tabular-nums text-[14px] font-semibold text-[var(--ds-text-primary)]">{euro(total)}</span> : undefined}>
        <div className="space-y-3">
          {items.map((item, idx) => (
            <div key={`${item.dish_id}-${idx}`} className="rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--ds-text-primary)]">{item.name}</span>
                <span className="tabular-nums text-[13px] text-[var(--ds-text-muted)]">{euro(item.price_cents * item.qty)}</span>
                <Stepper
                  value={item.qty}
                  min={1}
                  max={99}
                  ariaLabel={`Quantità ${item.name}`}
                  onChange={next => setItems(prev => prev.map((p, i) => (i === idx ? { ...p, qty: next ?? 1 } : p)))}
                />
                <button
                  type="button"
                  onClick={() => setItems(prev => prev.filter((_, i) => i !== idx))}
                  aria-label={`Togli ${item.name}`}
                  className={dsIconButton}
                >
                  <Minus className="h-4 w-4" />
                </button>
              </div>
              <input
                className={`${dsInput} mt-2`}
                placeholder="Nota per la cucina"
                value={item.note}
                onChange={e => setItems(prev => prev.map((p, i) => (i === idx ? { ...p, note: e.target.value } : p)))}
              />
            </div>
          ))}
          <div>
            <SearchField value={dishQuery} onChange={setDishQuery} placeholder="Cerca un piatto" recessed />
            {pickable.length > 0 && (
              <ul className="mt-2 divide-y divide-[var(--ds-border)] overflow-hidden rounded-[var(--ds-radius-sm)] ring-1 ring-inset ring-[var(--ds-border)]">
                {pickable.map(dish => (
                  <li key={dish.id}>
                    <button
                      type="button"
                      onClick={() => addDish(dish)}
                      className="flex w-full items-baseline gap-2 px-3 py-2.5 text-left text-[14px] hover:bg-[var(--ds-surface-row)]"
                    >
                      <span className="min-w-0 flex-1 truncate text-[var(--ds-text-primary)]">{dish.name}</span>
                      {dish.category && <span className="text-[12px] text-[var(--ds-text-muted)]">{dish.category}</span>}
                      <span className="tabular-nums text-[var(--ds-text-secondary)]">{euro(Math.round(Number(dish.price) * 100))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </FormCard>

      <FormCard title="Note">
        <textarea className={dsTextarea} rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
      </FormCard>

      {error && (
        <Callout tone="critical" icon={X}>{error}</Callout>
      )}
    </ModalShell>
  );
};

/* ── Griglia slot con capienza ──────────────────────────────────────────── */
const SlotGrid: React.FC<{
  board: TakeawaySlotBoard | null;
  value: string | null;
  onChange: (time: string) => void;
}> = ({ board, value, onChange }) => {
  if (!board) return <div className="text-[13px] text-[var(--ds-text-muted)]">Carico gli orari…</div>;
  const groups = [
    { label: 'Pranzo', slots: board.lunch },
    { label: 'Cena', slots: board.dinner },
  ].filter(g => g.slots.length > 0);
  if (groups.length === 0) {
    return <div className="text-[13px] text-[var(--ds-text-muted)]">Nessuno slot: giorno chiuso.</div>;
  }
  return (
    <div className="space-y-3">
      {groups.map(group => (
        <div key={group.label}>
          <div className="mb-1.5 text-[13px] font-medium text-[var(--ds-text-secondary)]">{group.label}</div>
          <div className="flex flex-wrap gap-1.5">
            {group.slots.map(slot => {
              const full = slot.booked >= slot.capacity;
              const active = value === slot.time;
              return (
                <button
                  key={slot.time}
                  type="button"
                  onClick={() => onChange(slot.time)}
                  title={`${slot.booked} su ${slot.capacity}`}
                  className={`inline-flex h-11 flex-col items-center justify-center rounded-[var(--ds-radius-control)] px-3 text-[13px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                    active
                      ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                      : full
                        ? 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]'
                        : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]'
                  }`}
                >
                  <span>{slot.time}</span>
                  <span className={`text-[10px] leading-none ${active ? 'opacity-80' : full ? 'text-[var(--ds-pending-text)]' : 'text-[var(--ds-text-muted)]'}`}>
                    {full ? 'pieno' : `${slot.booked}/${slot.capacity}`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

export default AsportoPage;
