import { useEffect, useRef, useState } from 'react';
import { Shift } from '../types';
import type { LiveService, StaffOnShift } from '../components/salaVivo/types';
import { staffApiService } from '../services/staffApiService';
import { onSocketEvent } from '../services/socketEvents';

/* Il personale di sala di turno nel servizio in corso, per la Sala dal vivo:
 * i camerieri che girano fra pass e tavoli e il nome dell'hostess. Lo dice
 * GET /staff/presence, che legge il giorno come la pagina Personale (la riga
 * esplicita, poi l'assenza, il riposo, la presenza da contratto di fissi e
 * stagionali): in sala girano le stesse persone che il responsabile vede di
 * turno in griglia.
 *
 * Gli eventi del personale dicono solo che qualcosa è cambiato, non chi è di
 * turno adesso: si rilegge tutto, 1,5 s dopo l'ultimo. La griglia salva una
 * settimana con decine di scritture, e una lettura per ognuna sarebbe una
 * raffica. Anche a ogni epoca nuova delle prenotazioni (riconnessione,
 * ritorno in primo piano): gli eventi persi mentre la linea era giù non
 * tornano. Nessun three e nessuna scena: sta nel chunk della pagina
 * (tests/unit/boundaries.test.ts). */

// Tutti gli eventi che cambiano chi è di turno: schede, turni, assenze, e le
// ferie decise (diventano assenze, con un timeoff:* che arriva insieme).
// Il salvataggio in blocco della griglia (/staff/shifts/bulk) non manda
// eventi: lo recupera la prossima epoca.
const STAFF_EVENTS = [
  'staff:created', 'staff:updated', 'staff:deleted',
  'shift:created', 'shift:updated', 'shift:deleted',
  'timeoff:created', 'timeoff:updated', 'timeoff:deleted',
  'leave:changed',
] as const;
const REFETCH_DEBOUNCE_MS = 1500;

/** La lista di sala del turno, letta in difesa: un server diverso o una riga
 *  monca non devono arrivare al regista come un cameriere senza nome. Il
 *  nome è staff_members.name, già il nome di battesimo (il cognome sta a
 *  parte): niente tagli, un nome doppio resta intero. */
const toStaffList = (body: unknown, shift: Shift): StaffOnShift[] => {
  const sala = (body as { sala?: unknown } | null | undefined)?.sala;
  const rows = sala && typeof sala === 'object'
    ? (sala as Record<string, unknown>)[shift === Shift.LUNCH ? 'lunch' : 'dinner']
    : undefined;
  if (!Array.isArray(rows)) return [];
  const out: StaffOnShift[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const r = row as { id?: unknown; name?: unknown; role?: unknown } | null;
    if (!r || (typeof r.id !== 'string' && typeof r.id !== 'number')) continue;
    const id = String(r.id);
    const name = typeof r.name === 'string' ? r.name.trim().replace(/\s+/g, ' ') : '';
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, role: typeof r.role === 'string' ? r.role : null });
  }
  return out;
};

// Una lista uguale tiene l'oggetto di prima: il regista non rimescola i
// camerieri a ogni rilettura che non cambia niente.
const sameStaff = (a: readonly StaffOnShift[] | null | undefined, b: readonly StaffOnShift[]): boolean =>
  Array.isArray(a)
  && a.length === b.length
  && a.every((s, i) => s.id === b[i].id && s.name === b[i].name && s.role === b[i].role);

/** Chi è di sala nel servizio. undefined finché non arriva la prima
 *  risposta (il regista aspetta: niente camerieri senza nome che poi
 *  cambiano); null se la lettura fallisce e non c'è una lista buona di
 *  questo servizio da tenere; altrimenti la lista, nell'ordine del server.
 *  Al cambio di servizio resta quella di prima finché arriva la nuova. */
export function useStaffOnShift(
  service: Pick<LiveService, 'date' | 'shift' | 'key'> | null,
  epoch: number,
): readonly StaffOnShift[] | null | undefined {
  const [staff, setStaff] = useState<readonly StaffOnShift[] | null | undefined>(undefined);
  // Per quale servizio vale la lista che si ha: un errore la tiene solo se è
  // di questo servizio, se no il pranzo resterebbe in sala a cena.
  const staffKeyRef = useRef<string | null>(null);
  const [nudge, setNudge] = useState(0);
  // Una risposta superata da una richiesta più nuova non si applica: una
  // lettura lenta del pranzo non deve arrivare dopo quella della cena.
  const requestRef = useRef(0);
  const date = service?.date ?? null;
  const shift = service?.shift ?? null;
  const key = service?.key ?? null;

  useEffect(() => {
    if (date === null || shift === null || key === null) return;
    const request = ++requestRef.current;
    staffApiService.getStaffPresence(date).then(
      body => {
        if (request !== requestRef.current) return;
        const next = toStaffList(body, shift);
        staffKeyRef.current = key;
        setStaff(prev => (sameStaff(prev, next) ? prev : next));
      },
      (err: unknown) => {
        if (request !== requestRef.current) return;
        console.warn('[sala-dal-vivo] personale di turno non letto', err);
        // Una lista buona di questo servizio vale più di due camerieri senza
        // nome: un errore passeggero non cambia le persone in sala.
        if (staffKeyRef.current === key) return;
        staffKeyRef.current = null;
        setStaff(null);
      },
    );
  }, [date, shift, key, epoch, nudge]);

  useEffect(() => {
    let timer: number | null = null;
    const changed = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        setNudge(n => n + 1);
      }, REFETCH_DEBOUNCE_MS);
    };
    // Handler con nome attraverso onSocketEvent: sopravvivono al cambio
    // d'istanza del socket a ogni token nuovo (come useFloorMarkers).
    const offs = STAFF_EVENTS.map(event => onSocketEvent(event, changed));
    return () => {
      for (const off of offs) off();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return staff;
}
