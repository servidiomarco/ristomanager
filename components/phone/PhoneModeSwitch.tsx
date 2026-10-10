import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { PhoneCall, Wand2 } from 'lucide-react';
import { dsButton } from '../ds';
import { socketClient } from '../../services/socketClient';
import { voiceCallsApiService, type PhoneModeState } from '../../services/voiceCallsApiService';
import type { PhoneAnswerMode } from '../../utils/phoneSchedule';

/* Chi risponde adesso (docs/telefono-piano.md, Fase 3). Durante il servizio
   il personale passa il telefono a Sofia, o lo riprende, con un tocco dalla
   testata invece di entrare nelle Impostazioni; allo scadere torna da solo
   alla regola (fasce orarie comprese). Lo stato vero è sul server: qui si
   rilegge all'avvio, a ogni phoneRouting:changed e quando scade. */

const DURATIONS: { key: string; body: { minutes?: number; until?: 'tonight' } }[] = [
  { key: 'oneHour', body: { minutes: 60 } },
  { key: 'twoHours', body: { minutes: 120 } },
  { key: 'tonight', body: { until: 'tonight' } },
];

export const PhoneModeSwitch: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { t, i18n } = useTranslation(undefined, { useSuspense: false });
  const [state, setState] = useState<PhoneModeState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // Il pannello sta in un portal: la testata su telefono ha uno z-index basso
  // e il contenuto della pagina lo copriva. Da md si aggancia alla pastiglia.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) { setState(null); return; }
    let alive = true;
    // Un 403 (ruolo senza telefono) o un server senza la rotta: niente pastiglia.
    const refresh = () => {
      voiceCallsApiService.phoneMode()
        .then(s => { if (alive) setState(s); })
        .catch(() => { if (alive) setState(null); });
    };
    const onChanged = (s: PhoneModeState) => { if (alive && s?.effective) setState(s); };
    let attached: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attached === s) return;
      attached?.off('phoneRouting:changed', onChanged);
      attached = s;
      if (attached) {
        attached.on('phoneRouting:changed', onChanged);
        refresh();
      }
    };
    refresh();
    attach(socketClient.getSocket());
    const unsub = socketClient.onSocketChange(s => attach(s));
    // Le fasce cambiano con l'ora: una rilettura al minuto basta.
    const tick = setInterval(refresh, 60_000);
    return () => { alive = false; clearInterval(tick); unsub(); attach(null); };
  }, [enabled]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!btnRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!enabled || !state) return null;

  const { effective } = state;
  const sofia = effective.mode === 'solo_sofia';
  const other: PhoneAnswerMode = sofia ? 'prima_locale' : 'solo_sofia';
  const Icon = sofia ? Wand2 : PhoneCall;
  const time = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  const apply = async (body: { mode: PhoneAnswerMode | null; minutes?: number; until?: 'tonight' }) => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      setState(await voiceCallsApiService.setPhoneMode(body));
      setOpen(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const who = t(sofia ? 'phone.mode.sofia' : 'phone.mode.locale');
  const why = effective.source === 'override'
    ? t('phone.mode.byHandUntil', { time: time(effective.until!) })
    : effective.source === 'slot'
      ? t('phone.mode.slotUntil', { time: time(effective.until!) })
      : t('phone.mode.rule');

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          const r = btnRef.current?.getBoundingClientRect();
          setAnchor(r && window.matchMedia('(min-width: 768px)').matches ? { top: r.bottom + 8, right: window.innerWidth - r.right } : null);
          setOpen(v => !v);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('phone.mode.aria', { who })}
        title={`${who} · ${why}`}
        className={`relative inline-flex h-11 items-center gap-2 rounded-[var(--ds-radius-control)] px-3 text-[13px] font-semibold transition-colors ${
          open
            ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
            : sofia
              ? 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]'
              : 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
        }`}
      >
        <Icon className="h-[18px] w-[18px] flex-shrink-0" aria-hidden />
        <span className="max-lg:hidden">{t(sofia ? 'phone.mode.pillSofia' : 'phone.mode.pillLocale')}</span>
        {/* Acceso a mano: si spegne da solo, ma va ricordato che c'è. */}
        {effective.source === 'override' && !open && (
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--ds-pending-solid)] ring-2 ring-[var(--ds-surface)]" aria-hidden />
        )}
      </button>

      {/* Sul telefono la pastiglia sta a metà testata: il pannello va a tutta
          larghezza invece di uscire dallo schermo a sinistra. */}
      {open && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label={t('phone.mode.title')}
          style={anchor ? { top: anchor.top, right: anchor.right, width: 300 } : undefined}
          className={`fixed z-[60] rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-raised)] ${anchor ? '' : 'inset-x-4 top-20'}`}
        >
          <p className="text-[12px] font-medium text-[var(--ds-text-muted)]">{t('phone.mode.title')}</p>
          <p className="mt-1 flex items-center gap-2 text-[16px] font-semibold text-[var(--ds-text-primary)]">
            <Icon className="h-4 w-4 flex-shrink-0" aria-hidden /> {who}
          </p>
          <p className="text-[13px] text-[var(--ds-text-secondary)]">{why}</p>

          {effective.source === 'override' && (
            <button type="button" onClick={() => apply({ mode: null })} disabled={busy} className={`${dsButton.secondary} mt-3 w-full`}>
              {t('phone.mode.backToRule')}
            </button>
          )}

          <p className="mt-4 text-[13px] font-medium text-[var(--ds-text-primary)]">
            {t(other === 'solo_sofia' ? 'phone.mode.switchToSofia' : 'phone.mode.switchToLocale')}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {DURATIONS.map(d => (
              <button
                key={d.key}
                type="button"
                disabled={busy}
                onClick={() => apply({ mode: other, ...d.body })}
                className="inline-flex h-9 items-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-3 text-[13px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
              >
                {t(`phone.mode.${d.key}`)}
              </button>
            ))}
          </div>
          {error && <p className="mt-2 text-[13px] text-[var(--ds-critical-text)]">{t('phone.mode.error')}</p>}
        </div>,
        document.body,
      )}
    </>
  );
};
