import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Loader2, Monitor, PhoneForwarded, Plus, X } from 'lucide-react';
import { SegmentedControl, dsButton, dsInput } from '../ds';
import { useAuth } from '../../contexts/AuthContext';
import { voiceCallsApiService, type PhoneDevice, type PhoneRouting } from '../../services/voiceCallsApiService';
import { deviceKey, disableSoftphone, enableSoftphone, isEnabledHere, useSoftphone } from '../../services/softphone';
import { PHONE_SLOTS_MAX, isHHMM, type PhoneRoutingSlot } from '../../utils/phoneSchedule';

/* ── Chi risponde al telefono (docs/telefono-piano.md, Fase 3) ─────────────
   Con Sympotia davanti al numero di Sofia, il ristoratore sceglie se
   risponde subito Sofia o se prima squilla il locale: i browser del CRM con
   «Questo dispositivo squilla» acceso e, se servono, fino a tre cellulari.
   Se nessuno risponde entro il tempo scelto, risponde Sofia. Le fasce
   orarie cambiano la regola in certi giorni e orari (per esempio Sofia
   durante il servizio della sera); l'interruttore rapido sta in testata. */

const MAX_MOBILES = 3;
// Lunedì per primo, come il calendario italiano.
const DAYS = [1, 2, 3, 4, 5, 6, 7];
const NEW_SLOT: PhoneRoutingSlot = { days: [1, 2, 3, 4, 5, 6, 7], start: '19:30', end: '22:30', mode: 'solo_sofia' };

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const sameRouting = (a: PhoneRouting, b: PhoneRouting): boolean =>
  a.mode === b.mode && a.ring_seconds === b.ring_seconds && a.mobiles.join(',') === b.mobiles.join(',')
  && JSON.stringify(a.slots ?? []) === JSON.stringify(b.slots ?? []);

const slotValid = (s: PhoneRoutingSlot): boolean => s.days.length > 0 && isHHMM(s.start) && isHHMM(s.end) && s.start !== s.end;

// Un nome riconoscibile nell'elenco: chi e su cosa.
const deviceLabel = (userName: string): string => {
  const ua = navigator.userAgent;
  const what = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Browser';
  return userName ? `${userName} · ${what}` : what;
};

export const PhoneRoutingCard: React.FC<Props> = ({ showToast }) => {
  const { t, i18n } = useTranslation('canali', { useSuspense: false });
  const { hasPermission, user } = useAuth();
  const canEdit = hasPermission('settings:full');
  const soft = useSoftphone();

  const [saved, setSaved] = useState<PhoneRouting | null>(null);
  const [mode, setMode] = useState<PhoneRouting['mode']>('solo_sofia');
  const [mobiles, setMobiles] = useState<string[]>(['']);
  const [ring, setRing] = useState('15');
  const [slots, setSlots] = useState<PhoneRoutingSlot[]>([]);
  const [saving, setSaving] = useState(false);
  const [devices, setDevices] = useState<PhoneDevice[]>([]);
  const [configured, setConfigured] = useState(false);
  const [toggling, setToggling] = useState(false);

  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; });

  const load = (r: PhoneRouting) => {
    setSaved(r);
    setMode(r.mode);
    setMobiles(r.mobiles.length > 0 ? r.mobiles : ['']);
    setRing(String(r.ring_seconds));
    setSlots(r.slots ?? []);
  };
  const loadDevices = () =>
    voiceCallsApiService.phoneDevices(deviceKey())
      .then(d => { setDevices(d.devices); setConfigured(d.configured); })
      .catch(() => {});

  useEffect(() => {
    let cancelled = false;
    voiceCallsApiService.phoneRouting()
      .then(r => { if (!cancelled) load(r); })
      // Un server senza la rotta (deploy in corso) non mostra la card.
      .catch(() => { if (!cancelled) setSaved(null); });
    void loadDevices();
    return () => { cancelled = true; };
  }, []);

  if (!saved) {
    return null;
  }

  const draft: PhoneRouting = {
    mode,
    mobiles: mobiles.map(m => m.trim()).filter(Boolean),
    ring_seconds: Number(ring),
    slots,
  };
  const valid = Number.isInteger(draft.ring_seconds) && draft.ring_seconds >= 5 && draft.ring_seconds <= 60
    && slots.every(slotValid);
  // Squilla il locale con la regola di base o in almeno una fascia: servono
  // cellulari e secondi.
  const usesLocale = mode === 'prima_locale' || slots.some(sl => sl.mode === 'prima_locale');
  const patchSlot = (i: number, patch: Partial<PhoneRoutingSlot>) =>
    setSlots(prev => prev.map((sl, j) => (j === i ? { ...sl, ...patch } : sl)));
  const dayShort = (d: number) =>
    // 5 gennaio 2026 era un lunedì: d = 1 … 7 → lun … dom.
    new Intl.DateTimeFormat(i18n.language, { weekday: 'narrow' }).format(new Date(2026, 0, 4 + d));
  const dayLong = (d: number) =>
    new Intl.DateTimeFormat(i18n.language, { weekday: 'long' }).format(new Date(2026, 0, 4 + d));
  const dirty = !sameRouting(draft, saved);
  const mine = devices.find(d => d.mine) ?? null;
  const hereOn = !!mine && isEnabledHere();

  const save = async () => {
    if (!valid || !dirty || saving) return;
    setSaving(true);
    try {
      load(await voiceCallsApiService.updatePhoneRouting(draft));
      showToast(t('pr.saved', 'Impostazione salvata'), 'success');
    } catch (err: any) {
      showToast(err?.message || t('pr.err', 'Salvataggio non riuscito'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleHere = async () => {
    if (toggling) return;
    setToggling(true);
    try {
      if (hereOn) await disableSoftphone(mine?.id ?? null);
      else await enableSoftphone(deviceLabel(user?.full_name || ''));
      await loadDevices();
    } catch (err: any) {
      showToast(err?.message || t('pr.err', 'Salvataggio non riuscito'), 'error');
    } finally {
      setToggling(false);
    }
  };

  const removeDevice = async (d: PhoneDevice) => {
    try {
      if (d.mine) await disableSoftphone(d.id);
      else await voiceCallsApiService.deletePhoneDevice(d.id);
      await loadDevices();
    } catch (err: any) {
      showToast(err?.message || t('pr.err', 'Salvataggio non riuscito'), 'error');
    }
  };

  const statusText = !hereOn ? t('pr.hereOff', 'Spento: qui non squilla')
    : soft.status === 'ready' ? t('pr.hereReady', 'Acceso: le chiamate squillano qui')
    : soft.status === 'starting' ? t('pr.hereStarting', 'Collegamento…')
    : soft.status === 'unconfigured' ? t('pr.unconfigured', 'Il telefono del CRM non è ancora attivo sul server')
    : t('pr.hereError', 'Non riesco a collegarmi: ricarica la pagina');
  const lastSeen = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  return (
    <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]">
          <PhoneForwarded className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h4 className="text-[14px] font-medium text-[var(--ds-text-primary)]">{t('pr.title', 'Chi risponde al telefono')}</h4>
          <p className="text-[13px] text-[var(--ds-text-muted)]">{t('pr.subtitle', 'Le chiamate al numero di Sofia')}</p>
        </div>
      </div>

      <div className="mt-4">
        {slots.length > 0 && (
          <p className="mb-2 text-[13px] font-medium text-[var(--ds-text-primary)]">{t('pr.outsideSlots', 'Fuori dalle fasce')}</p>
        )}
        <SegmentedControl
          value={mode}
          onChange={next => canEdit && setMode(next)}
          ariaLabel={t('pr.title', 'Chi risponde al telefono')}
          equalWidth={false}
          options={[
            { value: 'solo_sofia', label: t('pr.soloSofia', 'Solo Sofia') },
            { value: 'prima_locale', label: t('pr.primaLocale', 'Prima il locale') },
          ]}
        />
      </div>

      {/* Fasce orarie: in quei giorni e orari vale un'altra regola. */}
      <div className="mt-4 space-y-3">
        {slots.map((sl, i) => (
          <div key={i} className="space-y-3 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-secondary)]" aria-hidden />
              <input
                type="time"
                value={sl.start}
                disabled={!canEdit}
                onChange={e => patchSlot(i, { start: e.target.value })}
                aria-label={t('pr.slotFrom', 'Dalle')}
                className="h-10 min-w-0 flex-1 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-3 text-[14px] tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              />
              <span className="flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden>→</span>
              <input
                type="time"
                value={sl.end}
                disabled={!canEdit}
                onChange={e => patchSlot(i, { end: e.target.value })}
                aria-label={t('pr.slotTo', 'Alle')}
                className="h-10 min-w-0 flex-1 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-3 text-[14px] tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              />
              {canEdit && (
                <button
                  type="button"
                  onClick={() => setSlots(prev => prev.filter((_, j) => j !== i))}
                  aria-label={t('pr.slotRemove', 'Togli questa fascia')}
                  className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('pr.slotDays', 'Giorni')}>
              {DAYS.map(d => {
                const on = sl.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={!canEdit}
                    aria-pressed={on}
                    aria-label={dayLong(d)}
                    title={dayLong(d)}
                    onClick={() => patchSlot(i, { days: on ? sl.days.filter(x => x !== d) : [...sl.days, d].sort() })}
                    className={`inline-flex h-10 w-10 items-center justify-center rounded-[var(--ds-radius-control)] text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                      on ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)]'
                    }`}
                  >
                    {dayShort(d)}
                  </button>
                );
              })}
            </div>
            <SegmentedControl
              value={sl.mode}
              onChange={next => canEdit && patchSlot(i, { mode: next })}
              ariaLabel={t('pr.slotMode', 'In questa fascia')}
              size="sm"
              equalWidth={false}
              options={[
                { value: 'solo_sofia', label: t('pr.soloSofia', 'Solo Sofia') },
                { value: 'prima_locale', label: t('pr.primaLocale', 'Prima il locale') },
              ]}
            />
            {!slotValid(sl) && (
              <p className="text-[13px] text-[var(--ds-critical-text)]">{t('pr.slotInvalid', 'Scegli almeno un giorno e due orari diversi')}</p>
            )}
          </div>
        ))}
        {canEdit && slots.length < PHONE_SLOTS_MAX && (
          <button
            type="button"
            onClick={() => setSlots(prev => [...prev, { ...NEW_SLOT, mode: mode === 'solo_sofia' ? 'prima_locale' : 'solo_sofia' }])}
            className="inline-flex h-9 items-center gap-1.5 rounded-[var(--ds-radius-control)] px-3 text-[13px] font-medium text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <Plus className="h-4 w-4" aria-hidden /> {t('pr.slotAdd', 'Fascia oraria')}
          </button>
        )}
      </div>

      {usesLocale && (
        <div className="mt-4 space-y-3">
          <p className="text-[13px] text-[var(--ds-text-secondary)]">
            {t('pr.hintLocale', 'Squillano insieme i dispositivi del CRM col telefono acceso e i cellulari qui sotto. Dal cellulare si sente chi chiama e si preme 1. Se nessuno risponde in tempo, risponde Sofia.')}
          </p>
          <p className="text-[13px] font-medium text-[var(--ds-text-primary)]">{t('pr.mobilesTitle', 'Cellulari (facoltativi)')}</p>
          {mobiles.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="tel"
                inputMode="tel"
                value={m}
                disabled={!canEdit}
                onChange={e => setMobiles(prev => prev.map((v, j) => (j === i ? e.target.value : v)))}
                placeholder={t('pr.mobilePh', 'Cellulare, es. 347 123 4567')}
                aria-label={t('pr.mobile', 'Cellulare')}
                className={dsInput}
              />
              {(mobiles.length > 1 || m.trim() !== '') && canEdit && (
                <button
                  type="button"
                  onClick={() => setMobiles(prev => (prev.length > 1 ? prev.filter((_, j) => j !== i) : ['']))}
                  aria-label={t('pr.remove', 'Togli questo cellulare')}
                  className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              )}
            </div>
          ))}
          {mobiles.length < MAX_MOBILES && canEdit && (
            <button
              type="button"
              onClick={() => setMobiles(prev => [...prev, ''])}
              className="inline-flex h-9 items-center gap-1.5 rounded-[var(--ds-radius-control)] px-3 text-[13px] font-medium text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              <Plus className="h-4 w-4" aria-hidden /> {t('pr.add', 'Un altro cellulare')}
            </button>
          )}
          <label className="flex items-center gap-2 text-[14px] text-[var(--ds-text-primary)]">
            {t('pr.ringFor', 'Squilla per')}
            <input
              type="number"
              min={5}
              max={60}
              value={ring}
              disabled={!canEdit}
              onChange={e => setRing(e.target.value)}
              className="h-11 w-20 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-3 text-center text-[15px] tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            />
            {t('pr.seconds', 'secondi, poi Sofia')}
          </label>
        </div>
      )}

      {canEdit && (
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={save} disabled={!valid || !dirty || saving} className={dsButton.primary}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t('pr.save', 'Salva')}
          </button>
        </div>
      )}

      {/* Il telefono di questo browser e degli altri dispositivi del locale. */}
      <div className="mt-4 border-t border-[var(--ds-border)] pt-4">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-[var(--ds-text-primary)]">{t('pr.here', 'Questo dispositivo squilla')}</p>
            <p className="text-[13px] text-[var(--ds-text-muted)]">{statusText}</p>
          </div>
          {configured && (
            <button
              type="button"
              role="switch"
              aria-checked={hereOn}
              aria-label={t('pr.here', 'Questo dispositivo squilla')}
              disabled={toggling}
              onClick={toggleHere}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                hereOn ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
              }`}
            >
              <span aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${hereOn ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
            </button>
          )}
        </div>
        {hereOn && (
          <p className="mt-2 text-[12px] text-[var(--ds-text-muted)]">
            {t('pr.hereHint', 'Serve il microfono (il browser lo chiede alla prima chiamata) e la pagina del CRM aperta. Meglio con una cuffia.')}
          </p>
        )}
        {devices.filter(d => !d.mine).length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {devices.filter(d => !d.mine).map(d => (
              <li key={d.id} className="flex items-center gap-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] px-3 py-2 text-[13px]">
                <Monitor className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-secondary)]" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[var(--ds-text-primary)]">{d.label || d.user_name || t('pr.device', 'Dispositivo')}</span>
                <span className="flex-shrink-0 tabular-nums text-[var(--ds-text-muted)]">{lastSeen(d.last_seen_at)}</span>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => removeDevice(d)}
                    aria-label={t('pr.removeDevice', 'Spegni questo dispositivo')}
                    className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
