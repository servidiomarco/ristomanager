import { useCallback, useEffect, useRef, useState } from 'react';
import { billsApiService } from '../../services/billsApiService';
import { socketClient } from '../../services/socketClient';
import type { CashClosureReport } from '../../types';

// Il report di chiusura del giorno, vivo: rilegge a ogni evento di conto,
// con debounce perché una chiusura emette più eventi in raffica. Vive qui e
// non dentro ChiusuraCassa perché lo leggono in due: il report stesso e la
// riga «Giornata» sempre a vista sopra i tab.
export const useCashClosure = (date?: string) => {
  const [report, setReport] = useState<CashClosureReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    try {
      setError(null);
      setReport(await billsApiService.getCashClosure(date));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [date]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onEvent = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { fetchReport(); }, 500);
    };
    const socket = socketClient.getSocket();
    const events = ['bill:closed', 'bill:settled', 'bill:split-paid', 'bill:payment-recorded', 'bill:payment-voided', 'bill:split-refunded', 'fiscal:updated'];
    events.forEach(e => socket?.on(e, onEvent));
    return () => {
      if (timer.current) clearTimeout(timer.current);
      events.forEach(e => socket?.off(e, onEvent));
    };
  }, [fetchReport]);

  return { report, error };
};
