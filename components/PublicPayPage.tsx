import React, { useState, useEffect, useCallback } from 'react';
import { publicPayApiService, PublicBillView, ClaimResponse } from '../services/publicPayApiService';
import { Loader2, Users, CheckCircle2, AlertTriangle, ExternalLink, X } from 'lucide-react';

// Extract the share_token from the current URL. Kept as a plain function
// so the page can be mounted directly without a router.
const tokenFromPath = (): string => {
  const m = window.location.pathname.match(/^\/pay\/([^\/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
};

const formatEur = (cents: number): string => (cents / 100).toFixed(2).replace('.', ',');

interface Props {
  token: string;
}

type Mode = 'menu' | 'equal' | 'fixed' | 'claimed' | 'error';

export const PublicPayPage: React.FC<Props> = ({ token }) => {
  const [bill, setBill] = useState<PublicBillView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [mode, setMode] = useState<Mode>('menu');
  const [claimantLabel, setClaimantLabel] = useState('');
  const [fixedAmountInput, setFixedAmountInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [claim, setClaim] = useState<ClaimResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const data = await publicPayApiService.getBill(token);
      if (!data) { setNotFound(true); return; }
      setBill(data);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Errore di rete');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleEqualShare = () => { setMode('equal'); setErrorMsg(null); };
  const handleFixedAmount = () => { setMode('fixed'); setErrorMsg(null); };
  const handleBack = () => { setMode('menu'); setErrorMsg(null); };

  const submitClaim = async (kind: 'equal_share' | 'fixed_amount') => {
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const payload: any = { kind, claimant_label: claimantLabel.trim() || undefined };
      if (kind === 'fixed_amount') {
        const euros = Number(String(fixedAmountInput).replace(',', '.'));
        if (!Number.isFinite(euros) || euros <= 0) {
          setErrorMsg('Inserisci un importo valido');
          setSubmitting(false);
          return;
        }
        payload.amount_cents = Math.round(euros * 100);
      }
      const result = await publicPayApiService.claim(token, payload);
      setClaim(result);
      setMode('claimed');
      await load();
    } catch (err: any) {
      if (err?.data?.max_allowed_cents != null) {
        setErrorMsg(`Importo troppo alto. Massimo disponibile: € ${formatEur(err.data.max_allowed_cents)}`);
      } else {
        setErrorMsg(err?.message || 'Errore durante la richiesta');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleRelease = async () => {
    if (!claim) return;
    if (!window.confirm('Annullare la richiesta? Potrai rifarla dopo.')) return;
    setSubmitting(true);
    try {
      await publicPayApiService.release(token, claim.split_id);
      setClaim(null);
      setMode('menu');
      setClaimantLabel('');
      setFixedAmountInput('');
      await load();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Errore durante l\'annullamento');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-slate-500">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-sm">Caricamento conto…</span>
        </div>
      </div>
    );
  }

  if (notFound || !bill) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <AlertTriangle className="h-10 w-10 text-amber-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-slate-800 mb-2">Conto non disponibile</h1>
          <p className="text-sm text-slate-600">
            Il link potrebbe essere scaduto o il conto è già stato chiuso. Chiedi al personale del ristorante.
          </p>
        </div>
      </div>
    );
  }

  const totalEur = formatEur(bill.bill.total_cents);
  const paidEur = formatEur(bill.paid_cents);
  const residualEur = formatEur(bill.residual_cents);
  const paidPct = bill.bill.total_cents > 0
    ? Math.min(100, Math.round((bill.paid_cents / bill.bill.total_cents) * 100))
    : 0;
  const equalShareCents = Math.min(
    bill.residual_cents,
    Math.ceil(bill.bill.total_cents / Math.max(1, bill.bill.covers))
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="max-w-md mx-auto px-4 py-6">
        <header className="text-center mb-6">
          <h1 className="text-xl font-semibold text-slate-800">Il conto del tavolo</h1>
          <p className="text-xs text-slate-500 mt-1">Paga la tua parte in sicurezza</p>
        </header>

        <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-5 mb-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-slate-500">Totale</span>
            <span className="text-3xl font-bold tracking-tight">€ {totalEur}</span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
            <Users className="h-3.5 w-3.5" />
            <span>{bill.bill.covers} coperti</span>
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
              <span>Pagato € {paidEur}</span>
              <span>{paidPct}%</span>
            </div>
            <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${paidPct}%` }} />
            </div>
            <div className="mt-1.5 text-xs text-slate-500">
              Rimanenti: <span className="font-medium text-slate-700">€ {residualEur}</span>
            </div>
          </div>
        </div>

        {bill.splits.length > 0 && (
          <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-4 mb-4">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Quote</div>
            <ul className="space-y-1.5">
              {bill.splits.filter(s => s.status === 'CLAIMED' || s.status === 'PAID').map((s, idx) => (
                <li key={idx} className="flex items-center gap-2 text-sm">
                  {s.status === 'PAID'
                    ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    : <Loader2 className="h-4 w-4 text-amber-500 animate-spin-slow" />}
                  <span className="text-slate-700 truncate flex-1">{s.claimant_label || 'Anonimo'}</span>
                  <span className="text-xs text-slate-500">{s.status === 'PAID' ? 'Pagato' : 'In attesa'}</span>
                  <span className="text-sm font-medium tabular-nums">€ {formatEur(s.amount_cents)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {errorMsg && (
          <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 px-3 py-2 text-sm flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        {mode === 'menu' && bill.residual_cents > 0 && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={handleEqualShare}
              className="w-full h-14 rounded-xl bg-sky-600 text-white font-semibold text-base shadow-sm hover:bg-sky-700 active:scale-[0.99] transition"
            >
              La mia parte · € {formatEur(equalShareCents)}
            </button>
            <button
              type="button"
              onClick={handleFixedAmount}
              className="w-full h-14 rounded-xl bg-white border border-slate-300 text-slate-800 font-semibold text-base hover:bg-slate-50 active:scale-[0.99] transition"
            >
              Un importo diverso
            </button>
          </div>
        )}

        {mode === 'menu' && bill.residual_cents === 0 && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 p-4 text-center">
            <CheckCircle2 className="h-6 w-6 mx-auto mb-1" />
            <div className="font-semibold">Conto saldato</div>
            <p className="text-xs mt-1">Il tavolo è stato pagato per intero.</p>
          </div>
        )}

        {(mode === 'equal' || mode === 'fixed') && (
          <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-4 space-y-3">
            <button
              type="button"
              onClick={handleBack}
              className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
            >
              <X className="h-3.5 w-3.5" /> Cambia opzione
            </button>

            {mode === 'fixed' && (
              <div>
                <label className="text-xs text-slate-600 font-medium">Importo</label>
                <div className="relative mt-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">€</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0,00"
                    value={fixedAmountInput}
                    onChange={e => setFixedAmountInput(e.target.value)}
                    className="w-full h-12 pl-8 pr-3 text-lg rounded-lg border border-slate-300 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 outline-none tabular-nums"
                  />
                </div>
                <div className="mt-1 text-[11px] text-slate-500">Max disponibile: € {residualEur}</div>
              </div>
            )}

            <div>
              <label className="text-xs text-slate-600 font-medium">Nome (opzionale)</label>
              <input
                type="text"
                placeholder="Es. Marco"
                value={claimantLabel}
                onChange={e => setClaimantLabel(e.target.value.slice(0, 40))}
                className="mt-1 w-full h-11 px-3 rounded-lg border border-slate-300 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 outline-none"
              />
              <p className="mt-1 text-[11px] text-slate-500">Sarà visibile agli altri ospiti del tavolo.</p>
            </div>

            <button
              type="button"
              onClick={() => submitClaim(mode === 'equal' ? 'equal_share' : 'fixed_amount')}
              disabled={submitting}
              className="w-full h-12 rounded-xl bg-sky-600 text-white font-semibold hover:bg-sky-700 active:scale-[0.99] transition disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Continua al pagamento
            </button>
          </div>
        )}

        {mode === 'claimed' && claim && (
          <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-5 space-y-4">
            <div className="text-center">
              <div className="text-xs text-slate-500 mb-1">La tua quota</div>
              <div className="text-3xl font-bold">€ {formatEur(claim.amount_cents)}</div>
              {claim.claimant_label && (
                <div className="text-sm text-slate-600 mt-1">per {claim.claimant_label}</div>
              )}
            </div>

            {claim.checkout_url ? (
              <a
                href={claim.checkout_url}
                className="w-full inline-flex items-center justify-center gap-2 h-14 rounded-xl bg-emerald-600 text-white font-semibold text-base shadow-sm hover:bg-emerald-700 active:scale-[0.99] transition"
              >
                <ExternalLink className="h-4 w-4" /> Vai al pagamento
              </a>
            ) : (
              <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 p-3 text-sm">
                Non è stato possibile creare il link di pagamento. Prova ad annullare la quota e riprovare.
              </div>
            )}

            <button
              type="button"
              onClick={handleRelease}
              disabled={submitting}
              className="w-full h-11 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
            >
              {submitting ? 'Attendere…' : 'Annulla la quota'}
            </button>

            <p className="text-[11px] text-slate-500 text-center">
              La quota è riservata per 5 minuti. Se non paghi entro questo tempo verrà rilasciata automaticamente.
            </p>
          </div>
        )}

        <footer className="mt-8 text-center text-[11px] text-slate-400">
          Pagamento sicuro tramite Revolut · Powered by Ristomanager
        </footer>
      </div>
    </div>
  );
};

export const PublicPayPageEntry: React.FC = () => {
  const token = tokenFromPath();
  if (!token) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-center text-sm text-slate-600">
        Link non valido.
      </div>
    );
  }
  return <PublicPayPage token={token} />;
};
