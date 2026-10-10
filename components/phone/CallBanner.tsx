import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, BellOff, CalendarDays, Phone, Wand2, X } from 'lucide-react';
import { Avatar, StatusPill } from '../ds';
import { socketClient } from '../../services/socketClient';
import { voiceCallsApiService, type LiveCall, type LiveCallEnded } from '../../services/voiceCallsApiService';
import { getRomeDatePart } from '../../utils/reservationTime';
import { chime } from '../../utils/chime';

/* «Chi chiama» (docs/telefono-piano.md, Fase 1). Mentre Sofia è al telefono
   il CRM mostra il chiamante con la sua scheda: nome, VIP, allergie,
   no-show, visite e prossime prenotazioni. Prima lo staff lo scopriva solo a
   chiamata finita, in Chiamate.

   Montato nella radice di App, non nella testata: la testata sparisce in
   cucina, in modalità immersiva e in Comande su schermo largo. Da md sta a
   destra appena sotto la testata, per non coprirne ricerca, campanella e
   «+» (i toast stanno in basso); su telefono in alto, a tutta larghezza.

   Il telaio che gira è .ds-ai-frame: «la macchina sta lavorando, guarda».
   Si ferma quando la chiamata finisce, e la card mostra l'esito per qualche
   secondo prima di sparire. */

const ENDED_VISIBLE_MS = 15_000;
// Specchio del TTL del server: una chiamata senza post-call non resta a vita.
const STALE_MS = 20 * 60 * 1000;
const MAX_VISIBLE = 3;
const MUTE_KEY = 'sympotia.callBanner.muted';

type BannerCall = LiveCall & { ended?: LiveCallEnded };

// Italiani senza +39 e a gruppi, come li si detta: lo staff richiama da qui.
// I fissi non hanno un prefisso di lunghezza fissa, restano interi.
const displayPhone = (e164: string): string => {
  if (!e164.startsWith('+39')) return e164;
  const national = e164.slice(3);
  return /^3\d{9}$/.test(national)
    ? `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`
    : national;
};

const readMuted = (): boolean => {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
};

export const CallBanner: React.FC<{
  enabled: boolean;
  onOpenCustomer: (phone: string) => void;
  onOpenReservation: (r: { id: number; reservation_time: string }) => void;
  onOpenCalls: () => void;
}> = ({ enabled, onOpenCustomer, onOpenReservation, onOpenCalls }) => {
  const { t, i18n } = useTranslation(undefined, { useSuspense: false });
  const [calls, setCalls] = useState<BannerCall[]>([]);
  const [muted, setMuted] = useState<boolean>(readMuted);
  // Chiuse a mano: una rilettura di /phone/live non deve farle ricomparire.
  const dismissed = useRef<Set<string>>(new Set());
  const announced = useRef<Set<string>>(new Set());
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const callsRef = useRef(calls);
  callsRef.current = calls;

  const dismiss = useCallback((id: string) => {
    dismissed.current.add(id);
    setCalls(prev => prev.filter(c => c.id !== id));
  }, []);

  const toggleMuted = () => {
    setMuted(prev => {
      const next = !prev;
      try { localStorage.setItem(MUTE_KEY, next ? '1' : '0'); } catch { /* resta per la sessione */ }
      return next;
    });
  };

  useEffect(() => {
    if (!enabled) { setCalls([]); return; }
    let alive = true;

    // All'avvio e a ogni nuovo socket (riconnessione): un CRM aperto a metà
    // chiamata la mostra lo stesso. Un 403 (ruolo senza banner) resta muto.
    const refresh = () => {
      voiceCallsApiService.live()
        .then(({ calls: live }) => {
          if (!alive) return;
          setCalls(prev => {
            const ended = prev.filter(c => c.ended);
            const fresh = live.filter(c => !dismissed.current.has(c.id) && !ended.some(e => e.id === c.id));
            return [...ended, ...fresh];
          });
        })
        .catch(() => {});
    };

    const onStarted = (call: LiveCall) => {
      if (!call?.id || dismissed.current.has(call.id)) return;
      // Lo stesso evento può arrivare due volte (cloud e nodo di sala):
      // suona solo la prima.
      const isNew = !announced.current.has(call.id);
      announced.current.add(call.id);
      setCalls(prev => [...prev.filter(c => c.id !== call.id), call]);
      if (isNew && !mutedRef.current) chime();
    };

    const onEnded = (end: LiveCallEnded) => {
      const open = callsRef.current.filter(c => !c.ended);
      const match =
        open.find(c => end.id && c.id === end.id) ??
        open.find(c => end.call_sid && c.call_sid === end.call_sid) ??
        open.find(c => end.phone && c.phone === end.phone);
      if (!match) return;
      setCalls(prev => prev.map(c => (c.id === match.id ? { ...c, ended: end } : c)));
      setTimeout(() => {
        if (alive) setCalls(prev => prev.filter(c => c.id !== match.id));
      }, ENDED_VISIBLE_MS);
    };

    let attached: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attached === s) return;
      if (attached) {
        attached.off('phoneCall:started', onStarted);
        attached.off('phoneCall:ended', onEnded);
      }
      attached = s;
      if (attached) {
        attached.on('phoneCall:started', onStarted);
        attached.on('phoneCall:ended', onEnded);
        refresh();
      }
    };
    attach(socketClient.getSocket());
    const unsub = socketClient.onSocketChange((s) => attach(s));

    const sweep = setInterval(() => {
      const cutoff = Date.now() - STALE_MS;
      setCalls(prev => prev.filter(c => c.ended || Date.parse(c.started_at) > cutoff));
    }, 60_000);

    return () => { alive = false; clearInterval(sweep); unsub(); attach(null); };
  }, [enabled]);

  if (!enabled || calls.length === 0) return null;

  const todayRome = getRomeDatePart(new Date());
  const tomorrowRome = getRomeDatePart(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const dayLabel = (iso: string): string => {
    const day = getRomeDatePart(iso);
    if (day === todayRome) return t('date.today');
    if (day === tomorrowRome) return t('date.tomorrow');
    return new Intl.DateTimeFormat(i18n.language, { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
  };
  const timeLabel = (iso: string): string =>
    new Intl.DateTimeFormat(i18n.language, { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const shortDate = (iso: string): string =>
    new Intl.DateTimeFormat(i18n.language, { timeZone: 'Europe/Rome', day: 'numeric', month: 'short' }).format(new Date(iso));

  // Le più recenti in alto; oltre tre si vedono le ultime.
  const visible = calls.slice(-MAX_VISIBLE).reverse();

  return (
    <div className="pointer-events-none fixed inset-x-2 top-2 z-[58] flex flex-col gap-2 md:inset-x-auto md:right-4 md:top-[88px] md:w-[380px]">
      {visible.map(call => {
        const { card, ended } = call;
        const customer = card.customer;
        const name = customer?.name || '';
        const phoneLabel = card.phone ? displayPhone(card.phone) : '';
        const title = name || phoneLabel || t('phone.hiddenNumber');
        const booking = ended?.reservation;
        const headline = ended ? t(`phone.outcome.${ended.outcome}`) : t('phone.sofiaTalking');
        return (
          <div
            key={call.id}
            role="status"
            aria-live="polite"
            className={`pointer-events-auto shadow-[var(--ds-shadow-raised)] ${ended ? 'rounded-[var(--ds-radius)] border border-[var(--ds-border)]' : 'ds-ai-frame'}`}
            style={{ animation: 'tileIn 200ms ease-out both' }}
          >
            <div className={`${ended ? 'rounded-[var(--ds-radius)]' : 'rounded-[calc(var(--ds-radius)-1.5px)]'} bg-[var(--ds-surface)] p-3`}>
              <div className="flex items-start gap-3">
                {/* La cornetta e non le iniziali: è una chiamata, non una scheda. */}
                <Avatar icon={Phone} tone={customer?.is_blacklisted ? 'critical' : 'info'} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--ds-arriving-text)]">
                    <Wand2 className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                    <span className="truncate">{headline}</span>
                  </p>
                  {customer?.phone ? (
                    <button
                      type="button"
                      onClick={() => onOpenCustomer(customer.phone!)}
                      className="block max-w-full truncate text-left text-[16px] font-semibold text-[var(--ds-text-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] rounded-[var(--ds-radius-sm)]"
                    >
                      {title}
                    </button>
                  ) : (
                    <p className="truncate text-[16px] font-semibold text-[var(--ds-text-primary)]">{title}</p>
                  )}
                  {name && phoneLabel && (
                    <p className="truncate text-[13px] tabular-nums text-[var(--ds-text-secondary)]">{phoneLabel}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={toggleMuted}
                  aria-label={muted ? t('phone.unmute') : t('phone.mute')}
                  title={muted ? t('phone.unmute') : t('phone.mute')}
                  className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  {muted ? <BellOff className="h-4 w-4" aria-hidden /> : <Bell className="h-4 w-4" aria-hidden />}
                </button>
                <button
                  type="button"
                  onClick={() => dismiss(call.id)}
                  aria-label={t('phone.close')}
                  className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                {customer?.is_blacklisted && <StatusPill tone="critical">{t('phone.blacklisted')}</StatusPill>}
                {customer?.is_vip && <StatusPill tone="pending">{t('phone.vip')}</StatusPill>}
                {card.no_shows > 0 && <StatusPill tone="critical">{t('phone.noShows', { count: card.no_shows })}</StatusPill>}
                {card.visits > 0 ? (
                  <StatusPill>
                    {t('phone.visits', { count: card.visits })}
                    {card.last_visit && ` · ${t('phone.lastVisit', { date: shortDate(card.last_visit) })}`}
                  </StatusPill>
                ) : (
                  <StatusPill>{customer ? t('phone.firstVisit') : t('phone.notInBook')}</StatusPill>
                )}
              </div>

              {customer?.dietary_notes && (
                <p className="mt-2 line-clamp-2 text-[13px] text-[var(--ds-critical-text)]">
                  {t('phone.allergies', { text: customer.dietary_notes })}
                </p>
              )}

              {(booking ? [{ id: booking.id, reservation_time: booking.reservation_time, guests: booking.guests }] : card.upcoming.slice(0, 2)).map(r => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onOpenReservation({ id: r.id, reservation_time: r.reservation_time })}
                  className="mt-2 flex w-full items-center gap-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] px-2.5 py-2 text-left text-[13px] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  <CalendarDays className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-secondary)]" aria-hidden />
                  <span className="truncate tabular-nums">
                    {t('phone.booking', { day: dayLabel(r.reservation_time), time: timeLabel(r.reservation_time), count: r.guests })}
                  </span>
                </button>
              ))}

              {ended && (ended.outcome === 'callback' || ended.outcome === 'follow_up') && (
                <button
                  type="button"
                  onClick={() => { dismiss(call.id); onOpenCalls(); }}
                  className="mt-2 inline-flex h-9 items-center rounded-[var(--ds-radius-control)] px-3 text-[13px] font-semibold text-[var(--ds-arriving-text)] transition-colors hover:bg-[var(--ds-arriving-tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  {t('phone.openCalls')}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
