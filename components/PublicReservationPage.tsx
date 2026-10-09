import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Users, Clock, Check } from 'lucide-react';
import { BOOKING_NAMESPACE, SupportedLanguage } from '../i18n/config';
import { PublicLanguageToggle } from './PublicLanguageToggle';
import { PublicBusinessCard, type PublicBusiness } from './PublicBusinessCard';

/* ── «La tua prenotazione» (pagina pubblica /r/:token) ────────────────────
   L'ospite arriva dal link «Gestisci la prenotazione» della conferma o del
   promemoria: vede la prenotazione, conferma la presenza o annulla da solo.
   Come /preventivo è un albero standalone senza AuthProvider — il token è
   la capability. Le regole (fino a quando si annulla, la caparra) le decide
   il server: la pagina mostra solo quello che lui dice possibile. */

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

type GuestState = 'confirmed' | 'pending' | 'cancelled' | 'declined' | 'past';

interface GuestView {
  business: PublicBusiness;
  currency?: string;
  reservation: {
    customer_name: string | null;
    date: string;
    time: string;
    guests: number;
    children: number;
    room_name: string | null;
    state: GuestState;
    guest_confirmed_at: string | null;
    guest_cancelled_at: string | null;
  };
  actions: {
    can_confirm: boolean;
    can_cancel: boolean;
    cancel_block: 'disabled' | 'too_late' | null;
    cancel_cutoff_hours: number;
  };
  deposit: { amount: number; on_cancel: 'refund' | 'retained' } | null;
}

const money = (n: number, lang: SupportedLanguage, currency: string = 'EUR') =>
  new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'it-IT', { style: 'currency', currency: currency || 'EUR', maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);

const dateLabel = (iso: string, lang: SupportedLanguage): string => {
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'it-IT', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
};

const tokenFromPath = (): string => {
  const m = window.location.pathname.match(/^\/r\/([^\/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
};

// Un colore per stato, con lo stesso significato che hanno nell'app:
// verde confermata, ambra in attesa, neutro per ciò che è chiuso.
const STATE_CHIP: Record<GuestState, string> = {
  confirmed: 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]',
  pending: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]',
  cancelled: 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]',
  declined: 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]',
  past: 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]',
};

export const PublicReservationPage: React.FC = () => {
  const { t, i18n, ready } = useTranslation(BOOKING_NAMESPACE, { useSuspense: false });
  const lang: SupportedLanguage = (i18n.language || '').toLowerCase().startsWith('en') ? 'en' : 'it';
  const [view, setView] = useState<GuestView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [askCancel, setAskCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = tokenFromPath();

  const load = useCallback(async () => {
    if (!token) { setNotFound(true); return; }
    try {
      const r = await fetch(`${API_URL}/r/${encodeURIComponent(token)}`);
      if (!r.ok) throw new Error(String(r.status));
      setView(await r.json() as GuestView);
    } catch {
      setNotFound(true);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!ready) return;
    document.title = view
      ? t('meta.titleFull', { business: view.business.name })
      : t('meta.title');
  }, [ready, t, lang, view]);

  const act = async (action: 'confirm' | 'cancel') => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      const r = await fetch(`${API_URL}/r/${encodeURIComponent(token)}/${action}`, { method: 'POST' });
      const body = await r.json().catch(() => null);
      if (r.ok && body) {
        setView(body as GuestView);
        setAskCancel(false);
        return;
      }
      // Rifiutata dal server (troppo tardi, nel frattempo è cambiata): la
      // pagina si rimette al dato vero e dice perché.
      setError(body?.error === 'too_late' ? t('errors.tooLate') : t('errors.generic'));
      await load();
      setAskCancel(false);
    } catch {
      setError(t('errors.generic'));
    } finally {
      setBusy(null);
    }
  };

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--ds-canvas)] p-6">
        <div className="max-w-sm rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-6 text-center shadow-[var(--ds-shadow-card)]">
          <p className="text-[15px] font-semibold text-[var(--ds-text-primary)]">{t('notFound.title')}</p>
          <p className="mt-2 text-[13px] text-[var(--ds-text-muted)]">{t('notFound.hint')}</p>
        </div>
      </div>
    );
  }

  if (!ready || !view) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--ds-canvas)]">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--ds-text-muted)]" aria-label={t('loadingAria')} />
      </div>
    );
  }

  const { business, reservation: r, actions, deposit } = view;
  const depositLabel = deposit ? money(deposit.amount, lang, view.currency) : '';
  const isOpen = r.state === 'confirmed' || r.state === 'pending';

  return (
    <div className="min-h-screen bg-[var(--ds-canvas)] pb-12">
      <div className="mx-auto max-w-lg px-4 pt-8 sm:px-6">
        <div className="mb-3 flex justify-end">
          <PublicLanguageToggle namespace={BOOKING_NAMESPACE} />
        </div>
        <header className="text-center">
          {business.logo_url && (
            <img
              src={business.logo_url}
              alt=""
              className="mx-auto mb-3 h-16 w-auto max-w-[240px] object-contain"
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          )}
          <p className="text-[15px] font-semibold text-[var(--ds-text-primary)]">{business.name}</p>
          <span className={`mt-3 inline-flex h-7 items-center rounded-[var(--ds-radius-control)] px-3 text-[13px] font-medium ${STATE_CHIP[r.state]}`}>
            {t(`state.${r.state}`)}
          </span>
          <h1 className="mt-2 text-[24px] font-semibold leading-tight tracking-[-0.015em] text-[var(--ds-text-primary)]">
            {dateLabel(r.date, lang)}
          </h1>
          <p className="mt-1.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[14px] text-[var(--ds-text-secondary)]">
            <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" aria-hidden /> {r.time}</span>
            <span className="inline-flex items-center gap-1">
              <Users className="h-3.5 w-3.5" aria-hidden />
              {t('guests', { count: r.guests })}{r.children > 0 ? t('childrenSuffix', { count: r.children }) : ''}
            </span>
            {r.room_name && <span>{r.room_name}</span>}
          </p>
          {r.customer_name && (
            <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">{t('forName', { name: r.customer_name })}</p>
          )}
        </header>

        <section className="mt-6 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-5 shadow-[var(--ds-shadow-card)]">
          {r.state === 'confirmed' && r.guest_confirmed_at && (
            <p className="flex items-center gap-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-seated-tint)] px-3 py-2.5 text-[14px] font-medium text-[var(--ds-seated-text)]">
              <Check className="h-4 w-4 flex-shrink-0" aria-hidden /> {t('confirmed.done')}
            </p>
          )}
          {r.state === 'confirmed' && !r.guest_confirmed_at && (
            <p className="text-[14px] text-[var(--ds-text-secondary)]">{t('confirmed.ask')}</p>
          )}
          {r.state === 'pending' && (
            <p className="text-[14px] text-[var(--ds-text-secondary)]">{t('pending.body')}</p>
          )}
          {r.state === 'cancelled' && (
            <p className="text-[14px] text-[var(--ds-text-secondary)]">{t('cancelled.body')}</p>
          )}
          {r.state === 'declined' && (
            <p className="text-[14px] text-[var(--ds-text-secondary)]">{t('declined.body')}</p>
          )}
          {r.state === 'past' && (
            <p className="text-[14px] text-[var(--ds-text-secondary)]">{t('past.body')}</p>
          )}

          {error && (
            <p role="alert" className="mt-3 rounded-[var(--ds-radius-sm)] bg-[var(--ds-critical-tint)] px-3 py-2.5 text-[13px] text-[var(--ds-critical-text)]">
              {error}
            </p>
          )}

          {actions.can_confirm && !askCancel && (
            <button
              type="button"
              onClick={() => act('confirm')}
              disabled={busy !== null}
              className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-action-bg)] px-4 text-[15px] font-semibold text-[var(--ds-action-fg)] hover:opacity-90 disabled:opacity-60"
            >
              {busy === 'confirm' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
              {t('confirmed.cta')}
            </button>
          )}

          {actions.can_cancel && !askCancel && (
            <button
              type="button"
              onClick={() => { setAskCancel(true); setError(null); }}
              disabled={busy !== null}
              className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-[var(--ds-radius-control)] px-4 text-[14px] font-medium text-[var(--ds-critical-text)] hover:bg-[var(--ds-surface-row)] disabled:opacity-60"
            >
              {r.state === 'pending' ? t('cancel.ctaRequest') : t('cancel.cta')}
            </button>
          )}

          {actions.can_cancel && askCancel && (
            <div className="mt-4 border-t border-[var(--ds-border)] pt-4">
              <p className="text-[15px] font-semibold text-[var(--ds-text-primary)]">
                {r.state === 'pending' ? t('cancel.askTitleRequest') : t('cancel.askTitle')}
              </p>
              {deposit && (
                <p className={`mt-2 rounded-[var(--ds-radius-sm)] px-3 py-2.5 text-[13px] ${
                  deposit.on_cancel === 'refund'
                    ? 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]'
                    : 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
                }`}>
                  {deposit.on_cancel === 'refund'
                    ? t('cancel.depositRefund', { amount: depositLabel })
                    : t('cancel.depositRetained', { amount: depositLabel })}
                </p>
              )}
              <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
                <button
                  type="button"
                  onClick={() => act('cancel')}
                  disabled={busy !== null}
                  className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-critical-solid)] px-4 text-[14px] font-semibold text-[var(--ds-critical-fg)] hover:opacity-90 disabled:opacity-60"
                >
                  {busy === 'cancel' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  {t('cancel.yes')}
                </button>
                <button
                  type="button"
                  onClick={() => setAskCancel(false)}
                  disabled={busy !== null}
                  className="inline-flex min-h-11 flex-1 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] disabled:opacity-60"
                >
                  {t('cancel.no')}
                </button>
              </div>
            </div>
          )}

          {isOpen && actions.cancel_block === 'too_late' && (
            <p className="mt-4 text-[13px] text-[var(--ds-text-muted)]">
              {t('cancel.tooLate', { count: actions.cancel_cutoff_hours })}
            </p>
          )}
          {isOpen && actions.cancel_block === 'disabled' && (
            <p className="mt-4 text-[13px] text-[var(--ds-text-muted)]">{t('cancel.contactUs')}</p>
          )}
        </section>

        <footer className="mt-6 text-center text-[13px] text-[var(--ds-text-muted)]">
          <PublicBusinessCard business={business} />
        </footer>
      </div>
    </div>
  );
};
