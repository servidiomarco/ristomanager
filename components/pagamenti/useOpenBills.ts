import { useCallback, useEffect, useState } from 'react';
import { socketClient } from '../../services/socketClient';
import {
  billsApiService, getOpenBills, type OpenBillRow, type StaleOrderRow,
} from '../../services/billsApiService';

/* ── Conti aperti: i dati ─────────────────────────────────────────────────
   Lifted out of ContiAperti when the page went to two columns. The list and
   the detail pane are siblings now and both read the same bills, the same
   reload and the same close action — leaving the fetch inside the list would
   have meant the pane asking its sibling for state.

   Nothing about the polling changed in the move: sockets for the three bill
   events plus a 30s floor, because a bill can also move from the till app,
   which does not emit. */

export type Service = { service_date: string; shift: 'LUNCH' | 'DINNER' };

export type OpenBills = {
  bills: OpenBillRow[];
  stale: StaleOrderRow[];
  service: Service | null;
  loading: boolean;
  error: string | null;
  closingId: number | null;
  closeBill: (bill: OpenBillRow, opts?: { cash_settled_cents?: number; tip_cents?: number }) => Promise<void>;
  reload: () => Promise<void>;
};

export const useOpenBills = (
  serviceFilter?: { service_date?: string; shift?: 'LUNCH' | 'DINNER' },
  status: 'open' | 'closed' = 'open',
): OpenBills => {
  const [bills, setBills] = useState<OpenBillRow[]>([]);
  const [stale, setStale] = useState<StaleOrderRow[]>([]);
  const [service, setService] = useState<Service | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<number | null>(null);

  // Chiave stabile: la lista si ricarica quando cambia il servizio scelto in
  // topbar (data o turno), non ad ogni render.
  const svcKey = `${serviceFilter?.service_date ?? ''}|${serviceFilter?.shift ?? ''}|${status}`;
  const reload = useCallback(async () => {
    try {
      const res = await getOpenBills(serviceFilter, { status });
      setBills(res.bills);
      setStale(res.stale_orders ?? []);
      setService(res.service ?? null);
    } catch (err: any) {
      setError(err?.message ?? 'Conti non caricati');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svcKey]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const socket = socketClient.getSocket();
    const onChange = () => reload();
    socket?.on('bill:opened', onChange);
    socket?.on('bill:updated', onChange);
    socket?.on('bill:closed', onChange);
    socket?.on('connect', onChange);
    const poll = setInterval(reload, 30_000);
    return () => {
      socket?.off('bill:opened', onChange);
      socket?.off('bill:updated', onChange);
      socket?.off('bill:closed', onChange);
      socket?.off('connect', onChange);
      clearInterval(poll);
    };
  }, [reload]);

  const closeBill = useCallback(async (bill: OpenBillRow, opts?: { cash_settled_cents?: number; tip_cents?: number }) => {
    setClosingId(bill.id);
    setError(null);
    try {
      await billsApiService.closeBill(bill.id, opts);
      await reload();
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Chiusura non riuscita');
    } finally {
      setClosingId(null);
    }
  }, [reload]);

  return { bills, stale, service, loading, error, closingId, closeBill, reload };
};
