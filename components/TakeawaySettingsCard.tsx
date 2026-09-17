import React, { useEffect, useRef, useState } from 'react';
import { Ban, Copy, Loader2, ShoppingBag } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { asportoApiService, TakeawayConfig } from '../services/asportoApiService';
import { Callout, Field, Stepper } from './ds';

/* ===========================================================================
   Impostazioni → Asporto.

   Le tre manopole di servizio del modulo: capienza per slot (quanti ordini
   regge la cucina in un quarto d'ora), minuti di preparazione (quanto prima
   dell'ora di ritiro un ordine diventa «Da produrre»), e lo stop per data.
   La modifica sta su takeaway:manage come le route: sono decisioni del
   servizio, non del contratto.
   ========================================================================= */

interface TakeawaySettingsCardProps {
  showToast: (message: string, type?: 'success' | 'error') => void;
}

/** Oggi in Italia — lo stop dal pannello si mette quasi sempre per stasera. */
const todayIso = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());

/** La pagina pubblica vive sul dominio del backend, come /prenota. */
const API_BASE = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export const TakeawaySettingsCard: React.FC<TakeawaySettingsCardProps> = ({ showToast }) => {
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
      showToastRef.current('Impostazioni asporto salvate', 'success');
    } catch {
      setConfig(before);
      showToastRef.current('Salvataggio non riuscito', 'error');
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
          <span className="block text-[15px] font-semibold text-[var(--ds-text-primary)]">Asporto</span>
          <span className="block truncate text-[13px] text-[var(--ds-text-muted)]">
            Capienza per slot, minuti di preparazione e stop
          </span>
        </span>
        {saving && <Loader2 className="h-4 w-4 animate-spin text-[var(--ds-text-muted)]" aria-hidden />}
      </summary>

      <div className="space-y-4 px-4 pb-4">
        {loadError && (
          <Callout tone="critical">Impostazioni non caricate: riapri la card per riprovare.</Callout>
        )}
        {!canEdit && config && (
          <Callout tone="info">Solo in lettura: serve il permesso «Gestisce ordini asporto».</Callout>
        )}
        {config && (
          <>
            <Field
              label="Ordini online"
              hint="La pagina pubblica /ordina: spenta mostra la card di manutenzione coi contatti."
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
                      () => showToastRef.current('Link copiato', 'success'),
                      () => showToastRef.current('Copia non riuscita', 'error')
                    );
                  }}
                  title="Copia il link della pagina"
                  className="inline-flex h-11 max-w-full items-center gap-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-4 text-[13px] font-medium text-[var(--ds-text-primary)]"
                >
                  <Copy className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                  <span className="truncate">{ordinaUrl}</span>
                </button>
              ) : (
                <p className="text-[13px] text-[var(--ds-text-muted)]">Accendila quando la cucina è pronta a ricevere ordini dal sito.</p>
              )}
            </Field>

            {hasVoice && (
              <Field
                label="Ordini al telefono"
                hint="Sofia prende gli ordini d'asporto in chiamata, con le stesse regole di slot e capienza."
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
                  {config.voice_enabled ? 'Sofia propone e registra gli ordini da ritirare.' : 'Spento: al telefono Sofia invita a ordinare di persona o dal sito.'}
                </p>
              </Field>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Ordini per slot"
                hint="Quanti ordini regge la cucina in uno slot di ritiro. Il banco può comunque forzare."
              >
                <Stepper
                  value={config.capacity_per_slot}
                  min={1}
                  max={50}
                  ariaLabel="Ordini per slot"
                  onChange={n => { if (canEdit && n != null && n !== config.capacity_per_slot) save({ capacity_per_slot: n }); }}
                />
              </Field>
              <Field
                label="Minuti di preparazione"
                hint="Quanto prima del ritiro un ordine diventa «Da produrre»."
              >
                <Stepper
                  value={config.prep_minutes}
                  min={5}
                  max={180}
                  ariaLabel="Minuti di preparazione"
                  onChange={n => { if (canEdit && n != null && n !== config.prep_minutes) save({ prep_minutes: n }); }}
                />
              </Field>
            </div>

            <Field
              label="Stop asporto"
              hint="Ferma i nuovi ordini per una sola data: decade da solo il giorno dopo."
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
                        Riapri
                      </button>
                    ) : undefined
                  }
                >
                  Fermo per il {new Date(`${config.stop_date}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}.
                </Callout>
              ) : (
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => save({ stop_date: todayIso() })}
                  className="inline-flex h-11 items-center gap-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Ban className="h-4 w-4" aria-hidden />
                  Ferma per oggi
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
