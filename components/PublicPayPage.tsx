import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { publicPayApiService, PublicBillView, ClaimResponse } from '../services/publicPayApiService';
import { PAY_NAMESPACE, SUPPORTED_LANGUAGES, SupportedLanguage } from '../i18n/config';
import { Loader2, Users, CheckCircle2, AlertTriangle, ExternalLink, X } from 'lucide-react';

// Extract the share_token from the current URL. Kept as a plain function
// so the page can be mounted directly without a router.
const tokenFromPath = (): string => {
  const m = window.location.pathname.match(/^\/pay\/([^\/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
};

// Stesso simbolo, formato diverso per lingua (12,34 € vs €12.34): l'ospite
// straniero legge un numero che riconosce, non un'italianizzazione forzata.
const formatEur = (cents: number, lang: SupportedLanguage): string =>
  new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100);

// Il server (services/publicPayApiService.ts → jsonRequest) restituisce
// sempre l'`error` grezzo in inglese: senza questa mappa, un ospite con la
// pagina in italiano vedeva comunque un pezzo di errore in inglese.
// Occorrenze note da server.ts — non esaustivo: quelle non mappate cadono
// sul messaggio generico tradotto, mai sul testo grezzo del server.
const SERVER_ERROR_KEYS: Record<string, string> = {
  'Bill already fully claimed': 'errors.billFullyClaimed',
  'Per-item split not available for this bill': 'errors.perItemUnavailable',
  'Some items are already claimed': 'errors.itemsAlreadyClaimed',
};

interface Props {
  token: string;
}

type Mode = 'menu' | 'equal' | 'fixed' | 'items' | 'claimed' | 'error';

export const PublicPayPage: React.FC<Props> = ({ token }) => {
  const { t, i18n, ready } = useTranslation(PAY_NAMESPACE, { useSuspense: false });
  const lang: SupportedLanguage = (i18n.language || '').toLowerCase().startsWith('en') ? 'en' : 'it';
  const resolveErrorMessage = useCallback((err: any, fallbackKey: string): string => {
    const serverError = err?.data?.error;
    const key = (typeof serverError === 'string' && SERVER_ERROR_KEYS[serverError]) || fallbackKey;
    return t(key);
  }, [t]);

  const [bill, setBill] = useState<PublicBillView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [mode, setMode] = useState<Mode>('menu');
  const [claimantLabel, setClaimantLabel] = useState('');
  const [fixedAmountInput, setFixedAmountInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [claim, setClaim] = useState<ClaimResponse | null>(null);
  // Righe scelte per lo split per piatto: è così che la gente divide davvero
  // il conto — «io ho preso solo l'antipasto».
  const [pickedItems, setPickedItems] = useState<number[]>([]);

  useEffect(() => {
    if (ready) document.title = t('meta.title');
  }, [ready, t, lang]);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    if (!background) setErrorMsg(null);
    try {
      const data = await publicPayApiService.getBill(token);
      if (!data) { setNotFound(true); return; }
      setBill(data);
    } catch (err: any) {
      if (!background) setErrorMsg(resolveErrorMessage(err, 'errors.network'));
    } finally {
      if (!background) setLoading(false);
    }
  }, [token, resolveErrorMessage]);

  useEffect(() => { load(); }, [load]);

  // Keep the shared bill fresh: guests come BACK to this page after the
  // Revolut redirect, often a couple of seconds before the webhook flips
  // their split to PAID — and the other diners' progress moves on its own.
  // No socket here (public page, no auth), so a light poll while visible.
  useEffect(() => {
    if (notFound) return;
    const tick = () => { if (document.visibilityState === 'visible') load(true); };
    const id = setInterval(tick, 5000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [load, notFound]);

  const handleEqualShare = () => { setMode('equal'); setErrorMsg(null); };
  const handleFixedAmount = () => { setMode('fixed'); setErrorMsg(null); };
  const handlePerItem = () => { setMode('items'); setErrorMsg(null); setPickedItems([]); };
  const handleBack = () => { setMode('menu'); setErrorMsg(null); };

  const submitClaim = async (kind: 'equal_share' | 'fixed_amount' | 'per_item') => {
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const payload: any = { kind, claimant_label: claimantLabel.trim() || undefined };
      if (kind === 'per_item') {
        if (pickedItems.length === 0) {
          setErrorMsg(t('errors.pickAtLeastOne'));
          setSubmitting(false);
          return;
        }
        payload.item_ids = pickedItems;
      }
      if (kind === 'fixed_amount') {
        const euros = Number(String(fixedAmountInput).replace(',', '.'));
        if (!Number.isFinite(euros) || euros <= 0) {
          setErrorMsg(t('errors.invalidAmount'));
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
        setErrorMsg(t('errors.amountTooHigh', { amount: formatEur(err.data.max_allowed_cents, lang) }));
      } else {
        setErrorMsg(resolveErrorMessage(err, 'errors.generic'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleRelease = async () => {
    if (!claim) return;
    if (!window.confirm(t('confirm.release'))) return;
    setSubmitting(true);
    try {
      await publicPayApiService.release(token, claim.split_id);
      setClaim(null);
      setMode('menu');
      setClaimantLabel('');
      setFixedAmountInput('');
      await load();
    } catch (err: any) {
      setErrorMsg(resolveErrorMessage(err, 'errors.releaseFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // Card dev board #35 — stesso pattern del selettore IT/EN del widget
  // /prenota (public/prenota.html): pillola in header, un bottone per
  // lingua supportata, il cambio è immediato e globale sull'istanza i18n.
  const LanguageToggle: React.FC = () => (
    <div
      role="group"
      aria-label={t('header.langGroupAria')}
      className="inline-flex gap-0.5 rounded-full border border-slate-200 bg-white p-0.5 shadow-sm"
    >
      {SUPPORTED_LANGUAGES.map(code => (
        <button
          key={code}
          type="button"
          aria-pressed={lang === code}
          onClick={() => i18n.changeLanguage(code)}
          className={`min-h-[30px] rounded-full px-3 text-xs font-semibold tracking-wide transition ${
            lang === code ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );

  if (!ready) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-slate-500">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-sm">{t('loading.text')}</span>
        </div>
      </div>
    );
  }

  if (notFound || !bill) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <div className="flex justify-end mb-4">
            <LanguageToggle />
          </div>
          <AlertTriangle className="h-10 w-10 text-amber-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-slate-800 mb-2">{t('notFound.title')}</h1>
          <p className="text-sm text-slate-600">{t('notFound.text')}</p>
        </div>
      </div>
    );
  }

  const totalEur = formatEur(bill.bill.total_cents, lang);
  const paidEur = formatEur(bill.paid_cents, lang);
  const residualEur = formatEur(bill.residual_cents, lang);
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
        <header className="mb-6">
          <div className="flex justify-end">
            <LanguageToggle />
          </div>
          <div className="text-center mt-1">
            <h1 className="text-xl font-semibold text-slate-800">{t('header.title')}</h1>
            <p className="text-xs text-slate-500 mt-1">{t('header.subtitle')}</p>
          </div>
        </header>

        <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-5 mb-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-slate-500">{t('bill.total')}</span>
            <span className="text-3xl font-bold tracking-tight">{totalEur}</span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
            <Users className="h-3.5 w-3.5" />
            <span>{t('bill.cover', { count: bill.bill.covers })}</span>
          </div>

          {bill.deposit_credit_cents != null && bill.deposit_credit_cents > 0 && (
            <div className="mt-3 flex items-baseline justify-between border-t border-slate-100 pt-3 text-sm">
              <span className="text-emerald-700">{t('bill.depositPaid')}</span>
              <span className="font-semibold text-emerald-700 tabular-nums">− {formatEur(bill.deposit_credit_cents, lang)}</span>
            </div>
          )}

          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
              <span>{t('bill.paidLabel', { amount: paidEur })}</span>
              <span>{paidPct}%</span>
            </div>
            <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${paidPct}%` }} />
            </div>
            <div className="mt-1.5 text-xs text-slate-500">
              {t('bill.remaining')} <span className="font-medium text-slate-700">{residualEur}</span>
            </div>
          </div>
        </div>

        {bill.splits.length > 0 && (
          <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-4 mb-4">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">{t('splits.title')}</div>
            <ul className="space-y-1.5">
              {bill.splits.filter(s => s.status === 'CLAIMED' || s.status === 'PAID').map((s, idx) => (
                <li key={idx} className="flex items-center gap-2 text-sm">
                  {s.status === 'PAID'
                    ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    : <Loader2 className="h-4 w-4 text-amber-500 animate-spin-slow" />}
                  <span className="text-slate-700 truncate flex-1">{s.claimant_label || t('splits.anonymous')}</span>
                  <span className="text-xs text-slate-500">{s.status === 'PAID' ? t('splits.statusPaid') : t('splits.statusPending')}</span>
                  <span className="text-sm font-medium tabular-nums">{formatEur(s.amount_cents, lang)}</span>
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
              {t('menu.myShare', { amount: formatEur(equalShareCents, lang) })}
            </button>
            {bill.per_item_available && (bill.items ?? []).some(i => !i.taken) && (
              <button
                type="button"
                onClick={handlePerItem}
                className="w-full h-14 rounded-xl bg-white border border-slate-300 text-slate-800 font-semibold text-base hover:bg-slate-50 active:scale-[0.99] transition"
              >
                {t('menu.perItem')}
              </button>
            )}
            <button
              type="button"
              onClick={handleFixedAmount}
              className="w-full h-14 rounded-xl bg-white border border-slate-300 text-slate-800 font-semibold text-base hover:bg-slate-50 active:scale-[0.99] transition"
            >
              {t('menu.customAmount')}
            </button>
          </div>
        )}

        {mode === 'items' && (
          <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-4 space-y-3">
            <button
              type="button"
              onClick={handleBack}
              className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
            >
              {t('items.back')}
            </button>
            <div className="text-sm font-semibold">{t('items.question')}</div>
            <ul className="divide-y divide-slate-100 -mx-1">
              {(bill.items ?? []).map(it => {
                const picked = pickedItems.includes(it.id);
                return (
                  <li key={it.id}>
                    <button
                      type="button"
                      disabled={it.taken}
                      onClick={() => setPickedItems(prev =>
                        prev.includes(it.id) ? prev.filter(x => x !== it.id) : [...prev, it.id])}
                      className={`w-full flex items-center gap-3 px-1 py-3 text-left transition
                        ${it.taken ? 'opacity-40 cursor-not-allowed' : ''}
                        ${picked ? 'bg-sky-50' : ''}`}
                    >
                      <span className={`h-5 w-5 shrink-0 rounded border flex items-center justify-center
                        ${picked ? 'bg-sky-600 border-sky-600 text-white' : 'border-slate-300'}`}>
                        {picked ? '✓' : ''}
                      </span>
                      <span className="flex-1 text-sm">
                        {it.qty}× {it.name}
                        {it.taken && <span className="block text-[11px] text-slate-500">{t('items.alreadyTaken')}</span>}
                      </span>
                      <span className="text-sm tabular-nums">{formatEur(it.total_cents, lang)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-baseline justify-between border-t border-slate-100 pt-3">
              <span className="text-xs text-slate-500">{t('items.yourShare')}</span>
              <span className="text-xl font-bold tabular-nums">
                {formatEur((bill.items ?? []).filter(i => pickedItems.includes(i.id))
                             .reduce((n, i) => n + i.total_cents, 0), lang)}
              </span>
            </div>
            <div>
              <label className="text-xs text-slate-600 font-medium">{t('items.nameLabel')}</label>
              <input
                type="text"
                placeholder={t('items.namePlaceholder')}
                value={claimantLabel}
                onChange={e => setClaimantLabel(e.target.value.slice(0, 40))}
                className="mt-1 w-full h-11 px-3 rounded-lg border border-slate-300 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => submitClaim('per_item')}
              disabled={submitting || pickedItems.length === 0}
              className="w-full h-12 rounded-xl bg-sky-600 text-white font-semibold hover:bg-sky-700 active:scale-[0.99] transition disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('items.continue')}
            </button>
          </div>
        )}

        {mode === 'menu' && bill.residual_cents === 0 && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 p-4 text-center">
            <CheckCircle2 className="h-6 w-6 mx-auto mb-1" />
            <div className="font-semibold">{t('paidInFull.title')}</div>
            <p className="text-xs mt-1">{t('paidInFull.text')}</p>
          </div>
        )}

        {(mode === 'equal' || mode === 'fixed') && (
          <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-4 space-y-3">
            <button
              type="button"
              onClick={handleBack}
              className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
            >
              <X className="h-3.5 w-3.5" /> {t('amountForm.changeOption')}
            </button>

            {mode === 'fixed' && (
              <div>
                <label className="text-xs text-slate-600 font-medium">{t('amountForm.amountLabel')}</label>
                <div className="relative mt-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">€</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder={t('amountForm.amountPlaceholder')}
                    value={fixedAmountInput}
                    onChange={e => setFixedAmountInput(e.target.value)}
                    className="w-full h-12 pl-8 pr-3 text-lg rounded-lg border border-slate-300 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 outline-none tabular-nums"
                  />
                </div>
                <div className="mt-1 text-[11px] text-slate-500">{t('amountForm.maxAvailable', { amount: residualEur })}</div>
              </div>
            )}

            <div>
              <label className="text-xs text-slate-600 font-medium">{t('amountForm.nameLabel')}</label>
              <input
                type="text"
                placeholder={t('amountForm.namePlaceholder')}
                value={claimantLabel}
                onChange={e => setClaimantLabel(e.target.value.slice(0, 40))}
                className="mt-1 w-full h-11 px-3 rounded-lg border border-slate-300 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 outline-none"
              />
              <p className="mt-1 text-[11px] text-slate-500">{t('amountForm.visibleNote')}</p>
            </div>

            <button
              type="button"
              onClick={() => submitClaim(mode === 'equal' ? 'equal_share' : 'fixed_amount')}
              disabled={submitting}
              className="w-full h-12 rounded-xl bg-sky-600 text-white font-semibold hover:bg-sky-700 active:scale-[0.99] transition disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('amountForm.continue')}
            </button>
          </div>
        )}

        {mode === 'claimed' && claim && (
          <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-5 space-y-4">
            <div className="text-center">
              <div className="text-xs text-slate-500 mb-1">{t('claimed.yourShare')}</div>
              <div className="text-3xl font-bold">{formatEur(claim.amount_cents, lang)}</div>
              {claim.claimant_label && (
                <div className="text-sm text-slate-600 mt-1">{t('claimed.forName', { name: claim.claimant_label })}</div>
              )}
            </div>

            {claim.checkout_url ? (
              <a
                href={claim.checkout_url}
                className="w-full inline-flex items-center justify-center gap-2 h-14 rounded-xl bg-emerald-600 text-white font-semibold text-base shadow-sm hover:bg-emerald-700 active:scale-[0.99] transition"
              >
                <ExternalLink className="h-4 w-4" /> {t('claimed.goToPayment')}
              </a>
            ) : (
              <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 p-3 text-sm">
                {t('claimed.noCheckoutLink')}
              </div>
            )}

            <button
              type="button"
              onClick={handleRelease}
              disabled={submitting}
              className="w-full h-11 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
            >
              {submitting ? t('claimed.cancelling') : t('claimed.cancelShare')}
            </button>

            <p className="text-[11px] text-slate-500 text-center">{t('claimed.holdNotice')}</p>
          </div>
        )}

        <footer className="mt-8 text-center text-[11px] text-slate-400">
          {t('footer.text')}
        </footer>
      </div>
    </div>
  );
};

export const PublicPayPageEntry: React.FC = () => {
  const { t, ready } = useTranslation(PAY_NAMESPACE, { useSuspense: false });
  const token = tokenFromPath();
  if (!token) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-center text-sm text-slate-600">
        {ready ? t('invalidLink.text') : null}
      </div>
    );
  }
  return <PublicPayPage token={token} />;
};
