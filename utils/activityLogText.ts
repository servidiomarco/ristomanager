import { ActivityAction, ActivityLog, LogRefs, ResourceType } from '../types';
import { datePart, timePart } from './displayTime';
import { formatDate } from './formatLocale';

/* ── Un log letto come frase ────────────────────────────────────────────────
   Il registro scrive id e chiavi tecniche (table_id: 86, merged_ids: [87]);
   chi indaga vuole «Roberto Donato ha unito i tavoli 26 + 27 · Cena 11/10».
   Qui sta la traduzione, una volta sola, per il registro e per la cronologia
   della prenotazione: le due viste non devono raccontare lo stesso log in due
   modi diversi.

   Le forme coperte sono quelle scritte davvero in produzione (rilevate l'11/10
   sui log di 30 giorni); quello che non si riconosce cade su «ha modificato il
   piatto» + nome, che è quanto diceva prima la tabella, in italiano. */

type TFunc = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

export interface LogChange {
  /** Chiave del campo (table_id, guests, …). */
  key: string;
  label: string;
  /** Assenti entrambi: il campo è cambiato ma il valore non si scrive nel log
   *  (nome, telefono, email, note — dati personali). */
  from?: string;
  to?: string;
}

export interface LogLine {
  /** Dopo il nome di chi ha agito: «ha unito i tavoli 26 + 27». */
  text: string;
  /** Contesto breve, in grigio: «Cena 11/10», «9 persone». */
  meta: string[];
  changes: LogChange[];
  /** Di chi parla il log: il cliente di una prenotazione, il nome di un piatto. */
  subject?: string;
  /** Presente quando il soggetto è una prenotazione: se ne apre la storia. */
  reservationId?: number;
  /** Prenotazioni sedute sui tavoli di un'unione, in quel giorno e turno. */
  related: { id: number; name: string }[];
}

const MERGE_RE = /^(Merge|Unmerge|Hide|Unhide) /;

const positiveInt = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const idList = (v: unknown): number[] =>
  Array.isArray(v) ? v.map(positiveInt).filter((n): n is number => n != null) : [];

export const actorName = (log: ActivityLog): string =>
  log.user_name || log.user_email || '—';

export function describeLog(log: ActivityLog, refs: LogRefs, t: TFunc): LogLine {
  const d: Record<string, any> = log.details && typeof log.details === 'object' ? log.details : {};
  const line: LogLine = { text: '', meta: [], changes: [], related: [] };

  const table = (id: unknown): string => {
    const n = positiveInt(id);
    return n == null ? '—' : refs.tables[String(n)] ?? `#${n}`;
  };
  const tables = (ids: number[]): string => ids.map(table).join(' + ');
  const shift = (s: unknown): string =>
    s === 'LUNCH' ? t('d.shift.LUNCH', 'Pranzo') : s === 'DINNER' ? t('d.shift.DINNER', 'Cena') : String(s ?? '');
  const day = (iso: unknown): string => {
    const m = typeof iso === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
    if (!m) return '';
    return formatDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), { day: '2-digit', month: '2-digit' });
  };
  // «Cena 11/10» da una data YYYY-MM-DD e un turno.
  const service = (date: unknown, s: unknown): string => [shift(s), day(date)].filter(Boolean).join(' ');
  // «Cena 11/10 20:30» da un istante (reservation_time) e un turno.
  const when = (iso: unknown, s: unknown): string => {
    if (typeof iso !== 'string' || !iso) return shift(s);
    return [shift(s), day(datePart(iso)), timePart(iso)].filter(Boolean).join(' ');
  };
  const guests = (n: unknown): string | null => {
    const g = positiveInt(n);
    return g == null ? null : t('d.guests', '{{count}} persone', { count: g });
  };
  const status = (v: unknown): string => {
    switch (v) {
      case 'CONFIRMED': return t('d.status.CONFIRMED', 'Confermata');
      case 'PENDING': return t('d.status.PENDING', 'Da confermare');
      case 'CANCELLED': return t('d.status.CANCELLED', 'Cancellata');
      case 'DECLINED': return t('d.status.DECLINED', 'Rifiutata');
      case 'NO_SHOW': return t('d.status.NO_SHOW', 'Non presentato');
      default: return String(v ?? '—');
    }
  };
  const arrival = (v: unknown): string => {
    switch (v) {
      case 'WAITING': return t('d.arrival.WAITING', 'In attesa');
      case 'ARRIVED': return t('d.arrival.ARRIVED', 'Arrivato');
      case 'DEPARTING': return t('d.arrival.DEPARTING', 'In uscita');
      case 'DEPARTED': return t('d.arrival.DEPARTED', 'Tavolo liberato');
      default: return String(v ?? '—');
    }
  };
  const payment = (v: unknown): string => {
    switch (v) {
      case 'PENDING': return t('d.payment.PENDING', 'Da pagare');
      case 'PAID_DEPOSIT': return t('d.payment.PAID_DEPOSIT', 'Caparra pagata');
      case 'PAID_FULL': return t('d.payment.PAID_FULL', 'Pagata');
      case 'REFUNDED': return t('d.payment.REFUNDED', 'Rimborsata');
      default: return String(v ?? '—');
    }
  };

  // Prima → dopo, da `changes` (modifiche dal CRM) o da before/after (Sofia,
  // agente WhatsApp, link dell'ospite).
  const readChanges = (): LogChange[] => {
    const pairs: Record<string, [unknown, unknown]> = {};
    if (d.changes && typeof d.changes === 'object') {
      for (const [k, v] of Object.entries(d.changes)) if (Array.isArray(v)) pairs[k] = [v[0], v[1]];
    } else if (d.before && d.after && typeof d.before === 'object' && typeof d.after === 'object') {
      for (const k of Object.keys({ ...d.before, ...d.after })) {
        if (JSON.stringify(d.before[k] ?? null) !== JSON.stringify(d.after[k] ?? null)) pairs[k] = [d.before[k], d.after[k]];
      }
    }
    const out: LogChange[] = [];
    const tm = pairs.reservation_time;
    if (tm) {
      const [a, b] = tm.map(v => (typeof v === 'string' ? v : ''));
      const sameDay = datePart(a) === datePart(b);
      out.push({
        key: 'reservation_time',
        label: t('d.f.time', 'Ora'),
        from: a ? (sameDay ? timePart(a) : `${day(datePart(a))} ${timePart(a)}`) : '—',
        to: b ? (sameDay ? timePart(b) : `${day(datePart(b))} ${timePart(b)}`) : '—',
      });
    }
    const fmt: Record<string, [string, (v: unknown) => string]> = {
      shift: [t('d.f.shift', 'Turno'), shift],
      guests: [t('d.f.guests', 'Persone'), v => (v == null ? '—' : String(v))],
      children: [t('d.f.children', 'Bambini'), v => (v == null ? '0' : String(v))],
      table_id: [t('d.f.table', 'Tavolo'), v => (v == null ? t('d.noTable', 'nessuno') : table(v))],
      reservation_status: [t('d.f.status', 'Stato'), status],
      arrival_status: [t('d.f.arrival', 'Arrivo'), arrival],
      payment_status: [t('d.f.payment', 'Pagamento'), payment],
      duration_minutes: [t('d.f.duration', 'Durata'), v => (v == null ? '—' : t('d.minutes', '{{n}} min', { n: v }))],
      banquet_menu_id: [t('d.f.banquet', 'Menù banchetto'), v => (v == null ? t('d.none', 'nessuno') : `#${v}`)],
    };
    for (const [key, [label, show]] of Object.entries(fmt)) {
      if (pairs[key]) out.push({ key, label, from: show(pairs[key][0]), to: show(pairs[key][1]) });
    }
    const privateLabels: Record<string, string> = {
      customer_name: t('d.f.name', 'Nome'),
      phone: t('d.f.phone', 'Telefono'),
      email: t('d.f.email', 'Email'),
      notes: t('d.f.notes', 'Note'),
    };
    for (const key of Array.isArray(d.changed_fields) ? d.changed_fields : []) {
      if (privateLabels[key]) out.push({ key, label: privateLabels[key] });
    }
    return out;
  };

  if (log.resource_type === ResourceType.RESERVATION) {
    // «Mario Rossi — richiesta pagamento 50 €»: il nome scritto dal server
    // porta già il fatto dopo il trattino.
    const name = log.resource_name ?? '';
    const dash = name.indexOf(' — ');
    line.subject = dash > 0 ? name.slice(0, dash) : name || undefined;
    line.reservationId = positiveInt(log.resource_id) ?? undefined;

    if (dash > 0) {
      line.text = name.slice(dash + 3);
    } else if (log.action === ActivityAction.CREATE) {
      line.text = d.walk_in
        ? t('d.walkIn', 'ha registrato un walk-in')
        : t('d.resCreated', 'ha creato la prenotazione');
      const g = guests(d.guests);
      if (g) line.meta.push(g);
      if (d.reservation_time) line.meta.push(when(d.reservation_time, d.shift));
    } else if (log.action === ActivityAction.DELETE) {
      line.text = d.cancelled_via
        ? t('d.resCancelled', 'ha cancellato la prenotazione')
        : t('d.resDeleted', 'ha eliminato la prenotazione');
      if (d.reservation_time) line.meta.push(when(d.reservation_time, d.shift));
    } else if (d.table_assignment_ai_suggestion_id != null) {
      const ids = [positiveInt(d.table_id), ...idList(d.merge_with_table_ids)].filter((n): n is number => n != null);
      line.text = ids.length > 1
        ? t('d.aiTables', 'ha confermato la proposta AI: tavoli {{tables}}', { tables: tables(ids) })
        : t('d.aiTable', 'ha confermato la proposta AI: tavolo {{table}}', { table: tables(ids) });
    } else if (d.swapped_with != null) {
      const other = refs.reservations[String(d.swapped_with)] ?? `#${d.swapped_with}`;
      line.text = t('d.swapped', 'ha scambiato il tavolo con {{name}}', { name: other });
      if (d.new_table_id != null) line.meta.push(t('d.nowAt', 'ora al tavolo {{table}}', { table: table(d.new_table_id) }));
    } else if (d.guest_confirmed) {
      line.text = t('d.guestConfirmed', 'ha confermato la presenza');
    } else if (d.cancelled_via) {
      line.text = t('d.resCancelled', 'ha cancellato la prenotazione');
    } else if (d.undo_agent_action != null) {
      line.text = t('d.undoAgent', "ha annullato l'azione dell'agente");
    } else {
      const changes = readChanges();
      const tableOnly = changes.length === 1 && changes[0].key === 'table_id';
      if (changes.length > 0 && !tableOnly) {
        line.text = t('d.resUpdated', 'ha modificato la prenotazione');
        line.changes = changes;
      } else if (tableOnly || 'prev_table_id' in d) {
        const prev = tableOnly ? d.changes?.table_id?.[0] ?? d.before?.table_id : d.prev_table_id;
        const next = tableOnly ? d.changes?.table_id?.[1] ?? d.after?.table_id : d.table_id;
        line.text = prev == null
          ? t('d.tableAssigned', 'ha assegnato il tavolo {{table}}', { table: table(next) })
          : next == null
            ? t('d.tableRemoved', 'ha tolto il tavolo {{table}}', { table: table(prev) })
            : t('d.tableMoved', 'ha spostato dal tavolo {{from}} al {{to}}', { from: table(prev), to: table(next) });
      } else if (d.arrival_status && Object.keys(d).every(k => ['arrival_status', 'via', 'table_id'].includes(k))) {
        line.text = t('d.marked', 'ha segnato: {{state}}', { state: arrival(d.arrival_status) });
        if (d.table_id != null) line.meta.push(t('d.atTable', 'tavolo {{table}}', { table: table(d.table_id) }));
      } else if (Object.keys(d).length === 1 && d.table_id != null) {
        line.text = t('d.atTableSet', 'ha messo al tavolo {{table}}', { table: table(d.table_id) });
      } else {
        // Log di prima che si scrivesse il prima/dopo: c'è solo lo stato
        // salvato, quindi si dice quello e non cosa è cambiato.
        line.text = t('d.resSaved', 'ha salvato la prenotazione');
        if (d.reservation_status) line.meta.push(status(d.reservation_status));
        const g = guests(d.guests);
        if (g) line.meta.push(g);
        if (d.table_id != null) line.meta.push(t('d.atTable', 'tavolo {{table}}', { table: table(d.table_id) }));
      }
    }
    return line;
  }

  if (log.resource_type === ResourceType.TABLE && MERGE_RE.test(log.resource_name ?? '')) {
    const kind = (log.resource_name ?? '').split(' ')[0];
    const primary = positiveInt(log.resource_id);
    const merged = idList(d.merged_ids);
    const all = primary != null ? [primary, ...merged] : merged;
    if (kind === 'Merge') {
      line.text = t('d.merged', 'ha unito i tavoli {{tables}}', { tables: tables(all) });
    } else if (kind === 'Unmerge') {
      line.text = merged.length > 0
        ? t('d.unmerged', 'ha diviso i tavoli {{tables}}', { tables: tables(all) })
        : t('d.unmergedOld', 'ha diviso i tavoli uniti al {{table}}', { table: table(primary) });
    } else if (kind === 'Hide') {
      line.text = t('d.hidden', 'ha nascosto il tavolo {{table}}', { table: table(primary) });
    } else {
      line.text = t('d.unhidden', 'ha rimesso il tavolo {{table}}', { table: table(primary) });
    }
    const svc = service(d.date, d.shift);
    if (svc) line.meta.push(svc);
    line.related = refs.merge_reservations[String(log.id)] ?? [];
    return line;
  }

  // Chiusura di una sala per un turno: «Close 2026-10-11 DINNER».
  if (log.resource_type === ResourceType.ROOM && /^(Close|Reopen) /.test(log.resource_name ?? '')) {
    const room = refs.rooms[String(log.resource_id)] ?? null;
    const closing = (log.resource_name ?? '').startsWith('Close');
    line.text = closing
      ? t('d.roomClosed', 'ha chiuso la sala per il turno')
      : t('d.roomReopened', 'ha riaperto la sala per il turno');
    line.subject = room ?? undefined;
    const svc = service(d.date, d.shift);
    if (svc) line.meta.push(svc);
    return line;
  }

  if (log.resource_type === ResourceType.AUTH) {
    line.text = log.action === ActivityAction.LOGIN
      ? t('d.login', "ha effettuato l'accesso")
      : log.action === ActivityAction.LOGOUT
        ? t('d.logout', 'ha chiuso la sessione')
        : t('d.authChange', 'ha cambiato le credenziali');
    return line;
  }

  // Tavolo creato, spostato in pianta, eliminato: il nome sta nella frase.
  if (log.resource_type === ResourceType.TABLE) {
    const name = refs.tables[String(log.resource_id)] ?? log.resource_name ?? '';
    line.text = log.action === ActivityAction.CREATE ? t('d.tableCreated', 'ha creato il tavolo {{table}}', { table: name })
      : log.action === ActivityAction.DELETE ? t('d.tableDeleted', 'ha eliminato il tavolo {{table}}', { table: name })
      : t('d.tableEdited', 'ha modificato il tavolo {{table}}', { table: name });
    return line;
  }

  const verb = log.action === ActivityAction.CREATE ? t('d.verb.CREATE', 'ha creato')
    : log.action === ActivityAction.DELETE ? t('d.verb.DELETE', 'ha eliminato')
    : t('d.verb.UPDATE', 'ha modificato');
  line.text = `${verb} ${t(`d.obj.${log.resource_type}`, OBJECT_DEFAULTS[log.resource_type] ?? log.resource_type)}`;
  line.subject = log.resource_name || undefined;
  return line;
}

// Con l'articolo: «ha modificato il piatto», non «ha modificato piatto».
const OBJECT_DEFAULTS: Partial<Record<string, string>> = {
  TABLE: 'il tavolo',
  ROOM: 'la sala',
  DISH: 'il piatto',
  BANQUET_MENU: 'il menù banchetto',
  USER: "l'utente",
  CUSTOMER: 'il cliente',
  ORDER: 'la comanda',
  SETTINGS: 'le impostazioni',
  STAFF: 'il personale',
  STAFF_SHIFT: 'il turno',
  STAFF_TIME_OFF: 'il permesso',
  INVENTORY_LOCATION: 'il magazzino',
  INVENTORY_CATEGORY: 'la categoria',
  INVENTORY_PRODUCT: 'il prodotto',
  INVENTORY_MOVEMENT: 'il movimento',
};
