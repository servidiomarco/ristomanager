import React, { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Loader2, Printer, QrCode, Receipt, TriangleAlert, X } from 'lucide-react';
import { socketClient } from '../services/socketClient';
import { billsApiService, getOpenBills, printBill, type OpenBillRow, type StaleOrderRow } from '../services/billsApiService';
import { getFeatureFlags } from '../services/apiService';

// ---------------------------------------------------------------------------
// Conti aperti — elenco per tavolo, con e senza prenotazione.
//
// L'interfaccia del conto è sempre vissuta dentro il dettaglio prenotazione,
// quindi un walk-in generava un conto che nessuno poteva più aprire: niente
// QR, niente chiusura. Qui ci sono tutti.
// ---------------------------------------------------------------------------

const euro = (cents: number): string =>
  (cents / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });

export const OpenBillsPanel: React.FC = () => {
  const [bills, setBills] = useState<OpenBillRow[]>([]);
  const [stale, setStale] = useState<StaleOrderRow[]>([]);
  const [service, setService] = useState<{ service_date: string; shift: 'LUNCH' | 'DINNER' } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<OpenBillRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Il pannello esiste solo col conto al tavolo attivo: a modulo spento la
  // pagina Pagamenti non deve mostrare una sezione vuota. null = flag non
  // ancora noto (niente flash della sezione durante il caricamento).
  const [payAtTableEnabled, setPayAtTableEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFeatureFlags()
      .then(f => { if (!cancelled) setPayAtTableEnabled(f.pay_at_table_enabled === true); })
      .catch(() => { if (!cancelled) setPayAtTableEnabled(false); });
    const socket = socketClient.getSocket();
    const onFlags = (flags: any) => {
      if (flags && typeof flags.pay_at_table_enabled === 'boolean') {
        setPayAtTableEnabled(flags.pay_at_table_enabled);
      }
    };
    socket?.on('features:updated', onFlags);
    return () => { cancelled = true; socket?.off('features:updated', onFlags); };
  }, []);

  const reload = useCallback(async () => {
    try {
      const res = await getOpenBills();
      setBills(res.bills);
      setStale(res.stale_orders ?? []);
      setService(res.service ?? null);
      // Il conto aperto si aggiorna mentre lo guardi: rinfreschiamo anche
      // quello selezionato, altrimenti il residuo resta fermo a prima.
      setSelected(prev => (prev ? res.bills.find(b => b.id === prev.id) ?? null : null));
    } catch (err: any) {
      setError(err?.message ?? 'Conti non caricati');
    } finally {
      setLoading(false);
    }
  }, []);

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

  const closeBill = async (bill: OpenBillRow) => {
    setBusy(true); setError(null);
    try {
      await billsApiService.closeBill(bill.id);
      setSelected(null);
      await reload();
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Chiusura non riuscita');
    } finally {
      setBusy(false);
    }
  };

  // Conto al tavolo spento (o flag non ancora noto): la sezione non esiste.
  if (payAtTableEnabled !== true) return null;

  if (loading) {
    return <div className="p-6 flex items-center gap-2 text-slate-500"><Loader2 className="animate-spin" size={16} /> Caricamento conti…</div>;
  }

  // Il servizio corrente in evidenza, il resto ripiegato: la pagina serve a
  // incassare i tavoli di ADESSO, non a fare l'archivio. I conti di servizi
  // passati però sono crediti non chiusi: spariti del tutto, nessuno li
  // incasserebbe più — restano a portata di click.
  const currentBills = bills.filter(b => b.is_current_service);
  const previousBills = bills.filter(b => !b.is_current_service);

  const renderBill = (b: OpenBillRow) => {
    const settled = b.residual_cents === 0;
    return (
      <button key={b.id} onClick={() => setSelected(b)}
              className={`text-left rounded-xl border-2 p-3 transition hover:border-slate-400
                ${settled ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20'
                          : 'border-slate-200 dark:border-slate-700'}`}>
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold">Tav. {b.table_name ?? '—'}</span>
          <span className="text-xs text-slate-500 truncate">
            {b.customer_name ?? 'senza prenotazione'}
          </span>
        </div>
        <div className="mt-1 text-sm">
          <span className="font-semibold">{euro(b.total_cents)}</span>
          <span className="text-slate-500"> · {b.covers} cop.</span>
        </div>
        <div className="mt-1 text-xs">
          {settled ? (
            <span className="text-emerald-700 dark:text-emerald-300 font-medium">saldato</span>
          ) : (
            <span className="text-slate-500">
              incassato {euro(b.paid_cents)} · residuo {euro(b.residual_cents)}
            </span>
          )}
        </div>
        {/* Il tavolo sta ancora ordinando: il totale non è definitivo. */}
        {b.open_orders > 0 && (
          <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
            comanda ancora aperta
          </div>
        )}
        {!b.is_current_service && (
          <div className="mt-1 text-[11px] text-slate-500">
            {new Date(`${b.service_date}T12:00:00`).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}
            {' · '}{b.shift === 'LUNCH' ? 'pranzo' : 'cena'}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="p-4 lg:p-6">
      <div className="flex items-center gap-2 mb-4">
        <Receipt size={18} />
        <h2 className="text-lg font-semibold">Conti aperti</h2>
        <span className="text-sm text-slate-500">{currentBills.length}</span>
        {service && (
          <span className="text-xs text-slate-400 ml-1">
            servizio {service.shift === 'LUNCH' ? 'pranzo' : 'cena'} ·{' '}
            {new Date(`${service.service_date}T12:00:00`).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}
          </span>
        )}
      </div>

      {/* Comande rimaste aperte in servizi precedenti. Non compaiono più né in
          sala né in cucina: se non le mostrassimo qui, un tavolo mai chiuso
          sparirebbe senza che nessuno se ne accorga. */}
      {stale.length > 0 && (
        <div className="mb-4 rounded-xl border-2 border-amber-400 bg-amber-50/60 dark:bg-amber-950/20 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-200">
            <TriangleAlert size={15} />
            {stale.length === 1
              ? 'Una comanda di servizi precedenti mai chiusa'
              : `${stale.length} comande di servizi precedenti mai chiuse`}
          </div>
          <ul className="mt-2 text-sm space-y-1">
            {stale.map(o => (
              <li key={o.id} className="flex items-center gap-2">
                <span className="font-medium">Tav. {o.table_name ?? '—'}</span>
                <span className="text-slate-500 text-xs">
                  {new Date(`${o.service_date}T12:00:00`).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}
                  {' · '}{o.shift === 'LUNCH' ? 'pranzo' : 'cena'}
                </span>
                <span className="ml-auto tabular-nums">{euro(o.total_cents)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-800/80 dark:text-amber-200/70">
            Aprile da <strong>Comande</strong> scegliendo il tavolo nel servizio a cui appartengono, oppure chiudile dal conto se il pagamento è già avvenuto.
          </p>
        </div>
      )}

      {error && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200 text-sm">
          {error}
        </div>
      )}

      {currentBills.length === 0 ? (
        <p className="text-sm text-slate-500">
          Nessun conto aperto in questo servizio. Si apre chiudendo una comanda da <strong>Comande</strong>.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {currentBills.map(renderBill)}
        </div>
      )}

      {previousBills.length > 0 && (
        <details className="mt-5 group">
          <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 flex items-center gap-1.5">
            <span className="inline-block transition-transform group-open:rotate-90">▸</span>
            {previousBills.length === 1
              ? 'Un conto di servizi precedenti non chiuso'
              : `${previousBills.length} conti di servizi precedenti non chiusi`}
          </summary>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 mt-3">
            {previousBills.map(renderBill)}
          </div>
        </details>
      )}

      {selected && (
        <BillSheet bill={selected} busy={busy}
                   onClose={() => setSelected(null)}
                   onSettle={() => closeBill(selected)} />
      )}
    </div>
  );
};

export const BillSheet: React.FC<{
  bill: Pick<OpenBillRow, 'id' | 'table_name' | 'total_cents' | 'covers' | 'share_token' | 'items'>
      & Partial<Pick<OpenBillRow, 'paid_cents' | 'residual_cents' | 'open_orders'>>;
  busy?: boolean;
  onClose: () => void;
  onSettle?: () => void;
}> = ({ bill, busy, onClose, onSettle }) => {
  const [copied, setCopied] = useState(false);
  const [printState, setPrintState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const url = bill.share_token ? `${window.location.origin}/pay/${bill.share_token}` : null;

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* clipboard negata: resta il QR, che è il canale principale */ }
  };

  const print = async () => {
    if (printState === 'sending') return;
    setPrintState('sending');
    try {
      await printBill(bill.id);
      // "accodato", non "stampato": la conferma vera è il rumore della
      // termica. Se l'agente è giù il job resta in coda ed esce al rientro.
      setPrintState('sent');
      setTimeout(() => setPrintState('idle'), 3000);
    } catch {
      setPrintState('error');
      setTimeout(() => setPrintState('idle'), 4000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-sm max-h-[90vh] overflow-y-auto"
           onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-4 pb-3 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700">
          <div className="flex-1">
            <div className="font-semibold">Tavolo {bill.table_name ?? '—'}</div>
            <div className="text-xs text-slate-500">{bill.covers} coperti</div>
          </div>
          <button onClick={onClose} className="p-1"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {url ? (
            <div className="flex flex-col items-center gap-3">
              {/* Sfondo bianco fisso: in tema scuro un QR su fondo scuro non
                  si legge con la fotocamera. */}
              <div className="bg-white p-3 rounded-xl">
                <QRCodeSVG value={url} size={168} level="M" />
              </div>
              <p className="text-xs text-slate-500 text-center">
                L'ospite inquadra e paga la sua parte.
              </p>
              <div className="flex items-center gap-2">
                <button onClick={copy}
                        className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 flex items-center gap-1.5">
                  {copied ? <><Check size={13} /> link copiato</> : <><Copy size={13} /> copia link</>}
                </button>
                <button onClick={print} disabled={printState === 'sending'}
                        className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 flex items-center gap-1.5 disabled:opacity-50">
                  {printState === 'sending' ? <><Loader2 size={13} className="animate-spin" /> invio…</>
                    : printState === 'sent' ? <><Check size={13} /> in stampa</>
                    : printState === 'error' ? <><X size={13} /> stampa fallita</>
                    : <><Printer size={13} /> stampa preconto</>}
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500 flex items-center gap-2">
              <QrCode size={16} /> Conto chiuso: il codice non è più valido.
            </p>
          )}

          {bill.items && bill.items.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Dettaglio</div>
              <ul className="text-sm divide-y divide-slate-100 dark:divide-slate-800">
                {bill.items.map((i, idx) => (
                  <li key={idx} className="flex justify-between py-1.5">
                    <span className="truncate pr-2">{i.qty}× {i.name}</span>
                    <span className="tabular-nums shrink-0">{euro(i.unit_price_cents * i.qty)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1 text-sm border-t border-slate-200 dark:border-slate-700 pt-3">
            <div className="flex justify-between font-semibold">
              <span>Totale</span><span className="tabular-nums">{euro(bill.total_cents)}</span>
            </div>
            {bill.paid_cents != null && (
              <div className="flex justify-between text-slate-500">
                <span>Incassato</span><span className="tabular-nums">{euro(bill.paid_cents)}</span>
              </div>
            )}
            {bill.residual_cents != null && (
              <div className="flex justify-between">
                <span>Residuo</span>
                <span className={`tabular-nums font-medium ${bill.residual_cents === 0 ? 'text-emerald-600' : ''}`}>
                  {euro(bill.residual_cents)}
                </span>
              </div>
            )}
          </div>

          {bill.open_orders != null && bill.open_orders > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Il tavolo ha ancora una comanda aperta: il totale può cambiare.
            </p>
          )}

          {onSettle && (
            <button onClick={onSettle} disabled={busy}
                    className="w-full py-3 rounded-xl bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-semibold disabled:opacity-40">
              {busy ? 'Chiusura…' : 'Chiudi conto'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
