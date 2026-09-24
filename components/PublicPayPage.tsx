import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { publicPayApiService, PublicBillView, ClaimResponse } from '../services/publicPayApiService';
import { PAY_NAMESPACE, SUPPORTED_LANGUAGES, SupportedLanguage } from '../i18n/config';
import { Loader2, Users, CheckCircle2, AlertTriangle, ExternalLink, X, ChevronDown, Minus, Plus } from 'lucide-react';
import { currencySymbol } from '../utils/money';

// Extract the share_token from the current URL. Kept as a plain function
// so the page can be mounted directly without a router.
const tokenFromPath = (): string => {
  const m = window.location.pathname.match(/^\/pay\/([^\/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
};

// Formato diverso per lingua (12,34 € vs €12.34): l'ospite straniero legge un
// numero che riconosce, non un'italianizzazione forzata. La VALUTA invece non
// dipende dalla lingua: è quella scritta sul conto, che arriva nel payload —
// un inglese che paga a Roma paga in euro, non in sterline.
const formatEur = (cents: number, lang: SupportedLanguage, currency: string = 'EUR'): string =>
  new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'it-IT', { style: 'currency', currency: currency || 'EUR' }).format(cents / 100);

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

type Mode = 'menu' | 'equal' | 'full' | 'fixed' | 'items' | 'claimed' | 'error';

export const PublicPayPage: React.FC<Props> = ({ token }) => {
  const { t, i18n, ready } = useTranslation(PAY_NAMESPACE, { useSuspense: false });
  const lang: SupportedLanguage = (i18n.language || '').toLowerCase().startsWith('en') ? 'en' : 'it';
  const resolveErrorMessage = useCallback((err: any, fallbackKey: string): string => {
    const serverError = err?.data?.error;
    const key = (typeof serverError === 'string' && SERVER_ERROR_KEYS[serverError]) || fallbackKey;
    return t(key);
  }, [t]);

  const [bill, setBill] = useState<PublicBillView | null>(null);
  // La valuta del conto vale per tutti gli importi della pagina.
  const eur = (cents: number): string => formatEur(cents, lang, bill?.bill?.currency);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [mode, setMode] = useState<Mode>('menu');
  const [claimantLabel, setClaimantLabel] = useState('');
  const [fixedAmountInput, setFixedAmountInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [claim, setClaim] = useState<ClaimResponse | null>(null);
  // Pezzi scelti per riga nello split per piatto: è così che la gente divide
  // davvero il conto — «io ho preso solo l'antipasto». A pezzi, non a righe:
  // al tavolo da quattro ognuno si prende il suo dei «4× Coperto» (24/09).
  const [pickedUnits, setPickedUnits] = useState<Record<number, number>>({});
  // Dettaglio del conto sotto il totale: oltre la soglia parte ripiegato,
  // così su un conto lungo totale e bottoni restano a portata di pollice.
  const [itemsExpanded, setItemsExpanded] = useState(false);

  useEffect(() => {
    if (ready) document.title = t(bill?.takeaway === true ? 'header.takeawayTitle' : 'meta.title');
  }, [ready, t, lang, bill?.takeaway]);

  // Sul conto d'asporto: via i coperti e la quota equa (dividono per i
  // covers, che sull'asporto sono un 1 tecnico), ma il per-piatto RESTA —
  // gli ordini online di gruppo si dividono così, girandosi il link.
  // Letto in modo difensivo: il backend deployato può non mandarlo ancora.
  const isTakeaway = bill?.takeaway === true;
  const branding = bill?.branding ?? null;
  // Il backend che divide le righe a pezzi manda `taken_units`; uno vecchio
  // no, e allora il picker resta a righe intere come prima.
  const unitsSupported = (bill?.items ?? []).some(i => typeof i.taken_units === 'number');

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
  const handleFullBill = () => { setMode('full'); setErrorMsg(null); };
  const handleFixedAmount = () => { setMode('fixed'); setErrorMsg(null); };
  const handlePerItem = () => { setMode('items'); setErrorMsg(null); setPickedUnits({}); };
  const handleBack = () => { setMode('menu'); setErrorMsg(null); };

  const submitClaim = async (kind: 'equal_share' | 'full_bill' | 'fixed_amount' | 'per_item') => {
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const payload: any = { kind, claimant_label: claimantLabel.trim() || undefined };
      if (kind === 'per_item') {
        const picked = Object.entries(pickedUnits)
          .map(([id, units]) => ({ order_item_id: Number(id), units }))
          .filter(u => u.units > 0);
        if (picked.length === 0) {
          setErrorMsg(t('errors.pickAtLeastOne'));
          setSubmitting(false);
          return;
        }
        // Un backend che non conosce ancora le unità (finestra fra i deploy)
        // riceve le righe intere, com'era: lì la pagina non offre i pezzi.
        if (unitsSupported) payload.item_units = picked;
        else payload.item_ids = picked.map(u => u.order_item_id);
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
        setErrorMsg(t('errors.amountTooHigh', { amount: eur(err.data.max_allowed_cents) }));
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
      className="inline-flex gap-0.5 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] p-0.5 shadow-[var(--ds-shadow-card)]"
    >
      {SUPPORTED_LANGUAGES.map(code => (
        <button
          key={code}
          type="button"
          aria-pressed={lang === code}
          onClick={() => i18n.changeLanguage(code)}
          className={`min-h-[30px] rounded-[var(--ds-radius-control)] px-3 text-xs font-semibold tracking-wide transition ${
            lang === code ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]' : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]'
          }`}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );

  if (!ready) {
    return (
      <div className="min-h-screen bg-[var(--ds-canvas)] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--ds-text-subtle)]" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--ds-canvas)] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-[var(--ds-text-muted)]">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-sm">{t('loading.text')}</span>
        </div>
      </div>
    );
  }

  if (notFound || !bill) {
    return (
      <div className="min-h-screen bg-[var(--ds-canvas)] flex items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <div className="flex justify-end mb-4">
            <LanguageToggle />
          </div>
          <AlertTriangle className="h-10 w-10 text-[var(--ds-pending-solid)] mx-auto mb-3" aria-hidden />
          <h1 className="text-lg font-semibold text-[var(--ds-text-primary)] mb-2">{t('notFound.title')}</h1>
          <p className="text-sm text-[var(--ds-text-secondary)]">{t('notFound.text')}</p>
        </div>
      </div>
    );
  }

  const totalEur = eur(bill.bill.total_cents);
  const paidEur = eur(bill.paid_cents);
  const residualEur = eur(bill.residual_cents);
  const paidPct = bill.bill.total_cents > 0
    ? Math.min(100, Math.round((bill.paid_cents / bill.bill.total_cents) * 100))
    : 0;
  const equalShareCents = Math.min(
    bill.residual_cents,
    Math.ceil(bill.bill.total_cents / Math.max(1, bill.bill.covers))
  );
  // Il dettaglio righe arriva anche quando lo split per piatto non c'è; le
  // righe senza id (snapshot Passepartout) si mostrano ma non si scelgono.
  const allItems = bill.items ?? [];
  const pickableItems = allItems.filter((i): i is typeof i & { id: number } => i.id != null);
  // Letti in modo difensivo: il backend deployato può non mandarli ancora.
  const takenOf = (i: { qty: number; taken: boolean; taken_units?: number }) =>
    typeof i.taken_units === 'number' ? i.taken_units : (i.taken ? i.qty : 0);
  const unitCentsOf = (i: { qty: number; total_cents: number; unit_cents?: number }) =>
    typeof i.unit_cents === 'number' ? i.unit_cents : Math.round(i.total_cents / Math.max(1, i.qty));
  const COLLAPSED_ITEM_ROWS = 5;
  const itemsCollapsible = allItems.length > COLLAPSED_ITEM_ROWS + 1;
  const visibleItems = itemsCollapsible && !itemsExpanded ? allItems.slice(0, COLLAPSED_ITEM_ROWS) : allItems;

  return (
    <div className="min-h-screen bg-[var(--ds-canvas)] text-[var(--ds-text-primary)]">
      <div className="max-w-md mx-auto px-4 py-6">
        <header className="mb-6">
          <div className="flex justify-end">
            <LanguageToggle />
          </div>
          <div className="text-center mt-1">
            {/* La pagina pubblica resta in tema chiaro (nessuna classe .dark
                fuori dall'app), quindi basta la variante light del logo. */}
            {branding?.logo_url && (
              <img src={branding.logo_url} alt={branding.name ?? ''} className="mx-auto mb-2 h-12 w-auto max-w-[200px] object-contain" />
            )}
            {branding?.name && (
              <div className="text-sm font-semibold text-[var(--ds-text-secondary)]">{branding.name}</div>
            )}
            <h1 className="text-xl font-semibold text-[var(--ds-text-primary)]">{t(isTakeaway ? 'header.takeawayTitle' : 'header.title')}</h1>
            <p className="text-xs text-[var(--ds-text-muted)] mt-1">{t(isTakeaway ? 'header.takeawaySubtitle' : 'header.subtitle')}</p>
          </div>
        </header>

        <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] p-5 mb-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-[var(--ds-text-muted)]">{t('bill.total')}</span>
            <span className="text-3xl font-bold tracking-tight">{totalEur}</span>
          </div>
          {!isTakeaway && (
            <div className="mt-2 flex items-center gap-2 text-xs text-[var(--ds-text-muted)]">
              <Users className="h-3.5 w-3.5" />
              <span>{t('bill.cover', { count: bill.bill.covers })}</span>
            </div>
          )}

          {allItems.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t border-[var(--ds-border)] pt-3">
              {visibleItems.map((it, idx) => (
                <li key={idx} className="flex items-baseline gap-2 text-[13px]">
                  <span className="shrink-0 tabular-nums text-[var(--ds-text-muted)]">{it.qty}×</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--ds-text-secondary)]">{it.name}</span>
                  <span className="tabular-nums text-[var(--ds-text-secondary)]">{eur(it.total_cents)}</span>
                </li>
              ))}
              {itemsCollapsible && (
                <li>
                  <button
                    type="button"
                    onClick={() => setItemsExpanded(v => !v)}
                    className="mt-0.5 inline-flex min-h-[32px] items-center gap-1 text-xs font-medium text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text-primary)]"
                  >
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${itemsExpanded ? 'rotate-180' : ''}`} aria-hidden />
                    {itemsExpanded ? t('bill.showFewerItems') : t('bill.showAllItems', { count: allItems.length })}
                  </button>
                </li>
              )}
            </ul>
          )}

          {bill.deposit_credit_cents != null && bill.deposit_credit_cents > 0 && (
            <div className="mt-3 flex items-baseline justify-between border-t border-[var(--ds-border)] pt-3 text-sm">
              <span className="text-[var(--ds-seated-text)]">{t('bill.depositPaid')}</span>
              <span className="font-semibold text-[var(--ds-seated-text)] tabular-nums">− {eur(bill.deposit_credit_cents)}</span>
            </div>
          )}

          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-[var(--ds-text-muted)] mb-1">
              <span>{t('bill.paidLabel', { amount: paidEur })}</span>
              <span>{paidPct}%</span>
            </div>
            <div className="h-2 rounded-full bg-[var(--ds-border)] overflow-hidden">
              <div className="h-full bg-[var(--ds-seated-solid)] transition-all" style={{ width: `${paidPct}%` }} />
            </div>
            <div className="mt-1.5 text-xs text-[var(--ds-text-muted)]">
              {t('bill.remaining')} <span className="font-medium text-[var(--ds-text-secondary)]">{residualEur}</span>
            </div>
          </div>
        </div>

        {bill.splits.length > 0 && (
          <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] p-4 mb-4">
            <div className="text-[13px] font-semibold text-[var(--ds-text-secondary)] mb-2">{t('splits.title')}</div>
            <ul className="space-y-1.5">
              {bill.splits.filter(s => s.status === 'CLAIMED' || s.status === 'PAID').map((s, idx) => (
                <li key={idx} className="flex items-center gap-2 text-sm">
                  {s.status === 'PAID'
                    ? <CheckCircle2 className="h-4 w-4 text-[var(--ds-seated-solid)]" aria-hidden />
                    : <Loader2 className="h-4 w-4 text-[var(--ds-pending-solid)] animate-spin-slow" aria-hidden />}
                  <span className="text-[var(--ds-text-secondary)] truncate flex-1">{s.claimant_label || t('splits.anonymous')}</span>
                  <span className="text-xs text-[var(--ds-text-muted)]">{s.status === 'PAID' ? t('splits.statusPaid') : t('splits.statusPending')}</span>
                  <span className="text-sm font-medium tabular-nums">{eur(s.amount_cents)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {errorMsg && (
          <div className="mb-4 rounded-[var(--ds-radius)] bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] px-4 py-3 text-[15px] flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        {mode === 'menu' && bill.residual_cents > 0 && (
          <div className="space-y-2">
            {isTakeaway ? (
              /* Asporto: un solo pagante, «pago tutto» è LA scelta e prende
                 lo stile primario che al tavolo ha «la mia parte». */
              <button
                type="button"
                onClick={handleFullBill}
                className="w-full h-14 rounded-[var(--ds-radius)] bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] font-semibold text-base shadow-[var(--ds-shadow-card)] hover:bg-[var(--ds-action-bg-hover)] active:scale-[0.99] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                {t('menu.fullBill', { amount: residualEur })}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleEqualShare}
                  className="w-full h-14 rounded-[var(--ds-radius)] bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] font-semibold text-base shadow-[var(--ds-shadow-card)] hover:bg-[var(--ds-action-bg-hover)] active:scale-[0.99] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  {t('menu.myShare', { amount: eur(equalShareCents) })}
                </button>
                {/* Nascosto quando coincide con «La mia parte» (es. un solo coperto
                    o residuo sotto la quota): due bottoni con lo stesso importo
                    confonderebbero e basta. */}
                {bill.residual_cents !== equalShareCents && (
                  <button
                    type="button"
                    onClick={handleFullBill}
                    className="w-full h-14 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] font-semibold text-base hover:bg-[var(--ds-surface-row)] active:scale-[0.99] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    {t('menu.fullBill', { amount: residualEur })}
                  </button>
                )}
              </>
            )}
            {bill.per_item_available && pickableItems.some(i => !i.taken) && (
              <button
                type="button"
                onClick={handlePerItem}
                className="w-full h-14 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] font-semibold text-base hover:bg-[var(--ds-surface-row)] active:scale-[0.99] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                {t('menu.perItem')}
              </button>
            )}
            <button
              type="button"
              onClick={handleFixedAmount}
              className="w-full h-14 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] font-semibold text-base hover:bg-[var(--ds-surface-row)] active:scale-[0.99] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {t('menu.customAmount')}
            </button>
          </div>
        )}

        {mode === 'items' && (
          <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] p-4 space-y-3">
            <button
              type="button"
              onClick={handleBack}
              className="inline-flex items-center gap-1 text-xs text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]"
            >
              {t('items.back')}
            </button>
            <div className="text-sm font-semibold">{t('items.question')}</div>
            <ul className="divide-y divide-[var(--ds-border)] -mx-1">
              {pickableItems.map(it => {
                const taken = takenOf(it);
                const free = Math.max(0, it.qty - taken);
                const units = pickedUnits[it.id] ?? 0;
                const unitCents = unitCentsOf(it);
                const multi = unitsSupported && free > 1;
                const setUnits = (n: number) => setPickedUnits(prev => ({ ...prev, [it.id]: Math.max(0, Math.min(free, n)) }));
                // Il tocco sulla riga prende UN pezzo (il proprio coperto), o
                // lo toglie; lo stepper ne aggiunge altri. Senza le unità, o su
                // un pezzo solo, resta la spunta della riga intera.
                const toggle = () => setUnits(units > 0 ? 0 : (unitsSupported ? 1 : free));
                return (
                  <li key={it.id} className={`flex items-center gap-2 px-1 ${units > 0 ? 'bg-[var(--ds-surface-row)]' : ''}`}>
                    <button
                      type="button"
                      disabled={free === 0}
                      onClick={toggle}
                      className={`flex min-h-[48px] min-w-0 flex-1 items-center gap-3 py-2 text-left transition
                        ${free === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      <span className={`h-5 w-5 shrink-0 rounded border flex items-center justify-center
                        ${units > 0 ? 'bg-[var(--ds-action-bg)] border-[var(--ds-action-bg)] text-[var(--ds-action-fg)]' : 'border-[var(--ds-border-strong)]'}`}>
                        {units > 0 ? '✓' : ''}
                      </span>
                      <span className="min-w-0 flex-1 text-sm">
                        {(free > 1 || (free === 0 && it.qty > 1)) ? `${free > 0 ? free : it.qty}× ` : ''}{it.name}
                        {free === 0 ? (
                          <span className="block text-[11px] text-[var(--ds-text-muted)]">{t('items.alreadyTaken')}</span>
                        ) : (multi || taken > 0) && (
                          <span className="block text-[11px] tabular-nums text-[var(--ds-text-muted)]">
                            {multi ? t('items.each', { amount: eur(unitCents) }) : ''}
                            {multi && taken > 0 ? ' · ' : ''}
                            {taken > 0 ? t('items.takenUnits', { count: taken }) : ''}
                          </span>
                        )}
                      </span>
                      {!multi && (
                        <span className="text-sm tabular-nums">
                          {eur(free === 0 ? it.total_cents : unitCents * (unitsSupported ? 1 : free))}
                        </span>
                      )}
                    </button>
                    {multi && (
                      <div className="flex shrink-0 items-center gap-0.5 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] p-0.5">
                        <button
                          type="button"
                          onClick={() => setUnits(units - 1)}
                          disabled={units <= 0}
                          aria-label={t('items.oneLess', { name: it.name })}
                          className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
                        >
                          <Minus className="h-4 w-4" />
                        </button>
                        <span className="min-w-[40px] text-center text-sm font-semibold tabular-nums">
                          {units}/{free}
                        </span>
                        <button
                          type="button"
                          onClick={() => setUnits(units + 1)}
                          disabled={units >= free}
                          aria-label={t('items.oneMore', { name: it.name })}
                          className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="flex items-baseline justify-between border-t border-[var(--ds-border)] pt-3">
              <span className="text-xs text-[var(--ds-text-muted)]">{t('items.yourShare')}</span>
              <span className="text-xl font-bold tabular-nums">
                {eur(pickableItems.reduce((n, i) => n + (pickedUnits[i.id] ?? 0) * unitCentsOf(i), 0))}
              </span>
            </div>
            <div>
              <label className="text-xs text-[var(--ds-text-secondary)] font-medium">{t('items.nameLabel')}</label>
              <input
                type="text"
                placeholder={t('items.namePlaceholder')}
                value={claimantLabel}
                onChange={e => setClaimantLabel(e.target.value.slice(0, 40))}
                className="mt-1 w-full h-11 px-3 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[15px] text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              />
            </div>
            <button
              type="button"
              onClick={() => submitClaim('per_item')}
              disabled={submitting || !Object.values(pickedUnits).some(u => u > 0)}
              className="w-full h-12 rounded-[var(--ds-radius)] bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] font-semibold hover:bg-[var(--ds-action-bg-hover)] active:scale-[0.99] transition disabled:opacity-40 flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('items.continue')}
            </button>
          </div>
        )}

        {mode === 'menu' && bill.residual_cents === 0 && (
          <div className="rounded-[var(--ds-radius)] bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] p-4 text-center">
            <CheckCircle2 className="h-6 w-6 mx-auto mb-1" />
            <div className="font-semibold">{t('paidInFull.title')}</div>
            <p className="text-xs mt-1">{t(isTakeaway ? 'paidInFull.takeawayText' : 'paidInFull.text')}</p>
          </div>
        )}

        {(mode === 'equal' || mode === 'full' || mode === 'fixed') && (
          <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] p-4 space-y-3">
            <button
              type="button"
              onClick={handleBack}
              className="inline-flex items-center gap-1 text-xs text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]"
            >
              <X className="h-3.5 w-3.5" /> {t('amountForm.changeOption')}
            </button>

            {mode === 'fixed' && (
              <div>
                <label className="text-xs text-[var(--ds-text-secondary)] font-medium">{t('amountForm.amountLabel')}</label>
                <div className="relative mt-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-subtle)] text-sm">{currencySymbol(bill?.bill?.currency)}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder={t('amountForm.amountPlaceholder')}
                    value={fixedAmountInput}
                    onChange={e => setFixedAmountInput(e.target.value)}
                    className="w-full h-12 pl-8 pr-3 text-lg rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] tabular-nums"
                  />
                </div>
                <div className="mt-1 text-[11px] text-[var(--ds-text-muted)]">{t('amountForm.maxAvailable', { amount: residualEur })}</div>
              </div>
            )}

            <div>
              <label className="text-xs text-[var(--ds-text-secondary)] font-medium">{t('amountForm.nameLabel')}</label>
              <input
                type="text"
                placeholder={t('amountForm.namePlaceholder')}
                value={claimantLabel}
                onChange={e => setClaimantLabel(e.target.value.slice(0, 40))}
                className="mt-1 w-full h-11 px-3 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[15px] text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              />
              <p className="mt-1 text-[11px] text-[var(--ds-text-muted)]">{t(isTakeaway ? 'amountForm.visibleNoteTakeaway' : 'amountForm.visibleNote')}</p>
            </div>

            <button
              type="button"
              onClick={() => submitClaim(mode === 'equal' ? 'equal_share' : mode === 'full' ? 'full_bill' : 'fixed_amount')}
              disabled={submitting}
              className="w-full h-12 rounded-[var(--ds-radius)] bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] font-semibold hover:bg-[var(--ds-action-bg-hover)] active:scale-[0.99] transition disabled:opacity-40 flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('amountForm.continue')}
            </button>
          </div>
        )}

        {mode === 'claimed' && claim && (
          <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] p-5 space-y-4">
            <div className="text-center">
              <div className="text-xs text-[var(--ds-text-muted)] mb-1">{t('claimed.yourShare')}</div>
              <div className="text-3xl font-bold">{eur(claim.amount_cents)}</div>
              {claim.claimant_label && (
                <div className="text-sm text-[var(--ds-text-secondary)] mt-1">{t('claimed.forName', { name: claim.claimant_label })}</div>
              )}
            </div>

            {claim.checkout_url ? (
              <a
                href={claim.checkout_url}
                className="w-full inline-flex items-center justify-center gap-2 h-14 rounded-[var(--ds-radius)] bg-[var(--ds-seated-solid)] text-[var(--ds-seated-fg)] font-semibold text-base shadow-[var(--ds-shadow-card)] hover:opacity-90 active:scale-[0.99] transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                <ExternalLink className="h-4 w-4" /> {t('claimed.goToPayment')}
              </a>
            ) : (
              <div className="rounded-[var(--ds-radius)] bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] p-3 text-[15px]">
                {t('claimed.noCheckoutLink')}
              </div>
            )}

            <button
              type="button"
              onClick={handleRelease}
              disabled={submitting}
              className="w-full h-11 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] ring-1 ring-inset ring-[var(--ds-border-strong)] text-[var(--ds-text-primary)] text-[15px] font-medium hover:bg-[var(--ds-surface-row)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {submitting ? t('claimed.cancelling') : t('claimed.cancelShare')}
            </button>

            <p className="text-[11px] text-[var(--ds-text-muted)] text-center">{t('claimed.holdNotice')}</p>
          </div>
        )}

        <footer className="mt-8 space-y-1 text-center text-[11px] text-[var(--ds-text-subtle)]">
          {(branding?.name || branding?.address || branding?.phone) && (
            <div className="space-y-0.5 text-[var(--ds-text-muted)]">
              {branding?.name && <div className="font-medium">{branding.name}</div>}
              {branding?.address && (
                branding.maps_url ? (
                  <a href={branding.maps_url} target="_blank" rel="noreferrer" className="block underline underline-offset-2">
                    {branding.address}
                  </a>
                ) : (
                  <div>{branding.address}</div>
                )
              )}
              {branding?.phone && (
                <a href={`tel:${branding.phone.replace(/\s+/g, '')}`} className="block">{branding.phone}</a>
              )}
            </div>
          )}
          <div>{t('footer.text')}</div>
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
      <div className="min-h-screen bg-[var(--ds-canvas)] flex items-center justify-center p-6 text-center text-sm text-[var(--ds-text-secondary)]">
        {ready ? t('invalidLink.text') : null}
      </div>
    );
  }
  return <PublicPayPage token={token} />;
};
