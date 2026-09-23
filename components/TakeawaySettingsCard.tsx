import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { displayLocale } from '../utils/formatLocale';
import { Ban, Copy, Loader2, ShoppingBag } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { asportoApiService, TakeawayConfig } from '../services/asportoApiService';
import { Callout, Field, SegmentedControl, Stepper } from './ds';
import { sessionTimeZone } from '../utils/displayTime';

/* ===========================================================================
   Impostazioni → Asporto.

   Le manopole di servizio del modulo: capienza per slot (quanti ordini
   regge la cucina in un quarto d'ora), minuti di preparazione (quanto prima
   dell'ora di ritiro un ordine diventa «Da produrre»), lo stop per data e
   il giorno che la board mostra.
   La modifica sta su takeaway:manage come le route: sono decisioni del
   servizio, non del contratto.
   ========================================================================= */

interface TakeawaySettingsCardProps {
  showToast: (message: string, type?: 'success' | 'error') => void;
}

/** Oggi in Italia — lo stop dal pannello si mette quasi sempre per stasera. */
const todayIso = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: sessionTimeZone() }).format(new Date());

/** La pagina pubblica vive sul dominio del backend, come /prenota. */
const API_BASE = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export const TakeawaySettingsCard: React.FC<TakeawaySettingsCardProps> = ({ showToast }) => {
  const { t } = useTranslation('asporto', { useSuspense: false });
  const { hasPermission, hasFeature, user } = useAuth();
  // Base pubblica dal profilo (prenota.sympotia.com): è il nome pensato per
  // gli ospiti; VITE_API_URL è il ripiego (stesso server, nome tecnico).
  // Sempre con lo slug: /ordina nudo risolve il tenant dal dominio e ripiega
  // sul tenant 1 — copiato da un altro ristorante aprirebbe la pagina del
  // Frantoio. La forma /ordina/<slug> vale per tutti, tenant 1 compreso.
  const base = user?.tenant?.public_base_url || API_BASE;
  const slug = user?.tenant?.slug;
  const ordinaUrl = slug ? `${base}/ordina/${slug}` : `${base}/ordina`;
  const canEdit = hasPermission('takeaway:manage');
  const hasVoice = hasFeature('voice');
  const [config, setConfig] = useState<TakeawayConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // addToast è ricreata a ogni render di App: come dep resetterebbe il
  // fetch a ogni giro, quindi passa da una ref.
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    let cancelled = false;
    asportoApiService.getConfig()
      .then(c => { if (!cancelled) setConfig(c); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const save = async (patch: Partial<TakeawayConfig>) => {
    if (!config) return;
    const before = config;
    setConfig({ ...config, ...patch });
    setSaving(true);
    try {
      setConfig(await asportoApiService.updateConfig(patch));
      showToastRef.current(t('card.saved'), 'success');
    } catch {
      setConfig(before);
      showToastRef.current(t('card.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="group rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
      <summary className="flex cursor-pointer list-none items-center gap-3 p-4 [&::-webkit-details-marker]:hidden">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)]">
          <ShoppingBag className="h-5 w-5 text-[var(--ds-text-secondary)]" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold text-[var(--ds-text-primary)]">{t('card.title')}</span>
          <span className="block truncate text-[13px] text-[var(--ds-text-muted)]">
            {t('card.subtitle')}
          </span>
        </span>
        {saving && <Loader2 className="h-4 w-4 animate-spin text-[var(--ds-text-muted)]" aria-hidden />}
      </summary>

      <div className="space-y-4 px-4 pb-4">
        {loadError && (
          <Callout tone="critical">{t('card.loadFailed')}</Callout>
        )}
        {!canEdit && config && (
          <Callout tone="info">{t('card.readOnly')}</Callout>
        )}
        {config && (
          <>
            <Field
              label={t('card.online')}
              hint={t('card.onlineHint')}
              aside={
                <button
                  type="button"
                  role="switch"
                  aria-checked={config.online_enabled}
                  disabled={!canEdit}
                  onClick={() => save({ online_enabled: !config.online_enabled })}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                    config.online_enabled ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                      config.online_enabled ? 'translate-x-5' : 'translate-x-0.5'
                    } translate-y-0.5`}
                  />
                </button>
              }
            >
              {config.online_enabled ? (
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(ordinaUrl).then(
                      () => showToastRef.current(t('card.linkCopied'), 'success'),
                      () => showToastRef.current(t('card.copyFailed'), 'error')
                    );
                  }}
                  title={t('card.copyPageLink')}
                  className="inline-flex h-11 max-w-full items-center gap-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-4 text-[13px] font-medium text-[var(--ds-text-primary)]"
                >
                  <Copy className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                  <span className="truncate">{ordinaUrl}</span>
                </button>
              ) : (
                <p className="text-[13px] text-[var(--ds-text-muted)]">{t('card.switchOnWhenReady')}</p>
              )}
            </Field>

            {hasVoice && (
              <Field
                label={t('card.byPhone')}
                hint={t('card.byPhoneHint')}
                aside={
                  <button
                    type="button"
                    role="switch"
                    aria-checked={config.voice_enabled}
                    disabled={!canEdit}
                    onClick={() => save({ voice_enabled: !config.voice_enabled })}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                      config.voice_enabled ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                        config.voice_enabled ? 'translate-x-5' : 'translate-x-0.5'
                      } translate-y-0.5`}
                    />
                  </button>
                }
              >
                <p className="text-[13px] text-[var(--ds-text-muted)]">
                  {t(config.voice_enabled ? 'card.voiceOn' : 'card.voiceOff')}
                </p>
              </Field>
            )}

            <Field
              label={t('card.boardDay')}
              hint={t('card.boardDayHint')}
            >
              {/* ?? 'own': il campo nasce oggi e il backend schierato può non
                  mandarlo ancora. Senza ripiego nessuno dei due segmenti
                  risulterebbe acceso finché il server non sale. */}
              <SegmentedControl<'global' | 'own'>
                value={config.date_mode ?? 'own'}
                onChange={next => { if (canEdit && next !== (config.date_mode ?? 'own')) save({ date_mode: next }); }}
                ariaLabel={t('card.boardDay')}
                options={[
                  { value: 'own', label: t('card.dayOwn') },
                  { value: 'global', label: t('card.dayGlobal') },
                ]}
              />
              <p className="mt-2 text-[13px] text-[var(--ds-text-muted)]">
                {config.date_mode === 'global'
                  ? t('card.dayGlobalHint')
                  : t('card.dayOwnHint')}
              </p>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('card.perSlot')}
                hint={t('card.perSlotHint')}
              >
                <Stepper
                  value={config.capacity_per_slot}
                  min={1}
                  max={50}
                  ariaLabel={t('card.perSlot')}
                  onChange={n => { if (canEdit && n != null && n !== config.capacity_per_slot) save({ capacity_per_slot: n }); }}
                />
              </Field>
              <Field
                label={t('card.prepMinutes')}
                hint={t('card.prepMinutesHint')}
              >
                <Stepper
                  value={config.prep_minutes}
                  min={5}
                  max={180}
                  ariaLabel={t('card.prepMinutes')}
                  onChange={n => { if (canEdit && n != null && n !== config.prep_minutes) save({ prep_minutes: n }); }}
                />
              </Field>
            </div>

            <Field
              label={t('card.stop')}
              hint={t('card.stopHint')}
            >
              {config.stop_date ? (
                <Callout
                  tone="pending"
                  icon={Ban}
                  action={
                    canEdit ? (
                      <button
                        type="button"
                        onClick={() => save({ stop_date: null })}
                        className="rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-3 py-1.5 text-[13px] font-medium text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)]"
                      >
                        {t('card.reopen')}
                      </button>
                    ) : undefined
                  }
                >
                  {t('card.stoppedFor', { giorno: new Date(`${config.stop_date}T12:00:00`).toLocaleDateString(displayLocale(), { weekday: 'long', day: 'numeric', month: 'long' }) })}
                </Callout>
              ) : (
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => save({ stop_date: todayIso() })}
                  className="inline-flex h-11 items-center gap-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Ban className="h-4 w-4" aria-hidden />
                  {t('card.stopToday')}
                </button>
              )}
            </Field>
          </>
        )}
      </div>
    </details>
  );
};

export default TakeawaySettingsCard;
