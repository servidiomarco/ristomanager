import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cuboid, Loader2 } from 'lucide-react';
import { getFeatureFlags, updateFeatureFlags } from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

/**
 * Interruttore «Sala dal vivo» (flag sala_dal_vivo_enabled, spento di
 * default). Per ora accende solo i segnaposto di sala sulla piantina di
 * Sale & Tavoli; le rotte dei segnaposto rispondono comunque, il flag
 * governa l'interfaccia. Il cambio arriva agli altri dispositivi con
 * features:updated, come gli altri flag.
 */
export const SalaDalVivoSettingsCard: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('salavivo', { useSuspense: false });
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');

  // null = stato non ancora noto; loadFailed lo distingue dal caricamento.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getFeatureFlags()
      .then(f => { if (!cancelled) setEnabled(f.sala_dal_vivo_enabled === true); })
      // Niente toast: le altre card leggono gli stessi flag e falliscono
      // insieme, e cinque toast uguali non dicono niente di più della riga.
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const toggle = async () => {
    if (enabled === null || !canEdit || saving) return;
    const next = !enabled;
    setEnabled(next);
    setSaving(true);
    try {
      const flags = await updateFeatureFlags({ sala_dal_vivo_enabled: next });
      const now = flags.sala_dal_vivo_enabled === true;
      setEnabled(now);
      showToast(now ? t('onToast') : t('offToast'), 'success');
    } catch (err: any) {
      setEnabled(!next);
      showToast(err?.message || t('saveError'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (enabled === null && !loadFailed) {
    return (
      <div className="bg-[var(--ds-surface)] rounded-[var(--ds-radius)] shadow-[var(--ds-shadow-card)] px-4 py-3 flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('common:loading')}
      </div>
    );
  }

  const on = enabled === true;

  return (
    <div className="bg-[var(--ds-surface)] rounded-[var(--ds-radius)] shadow-[var(--ds-shadow-card)] flex min-h-11 items-center justify-between gap-3 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        {/* Tessera neutra: la famiglia pending vorrebbe dire «da sistemare». */}
        <div className="w-10 h-10 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-text-secondary)] flex-shrink-0">
          <Cuboid className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">{t('settingsTitle')}</h4>
          <p className="text-[13px] text-[var(--ds-text-muted)]">{t('settingsHint')}</p>
        </div>
      </div>
      {loadFailed ? (
        // text-muted, non subtle: senza l'interruttore questa scritta è
        // l'unico segno che qualcosa manca, e subtle non regge l'AA.
        <span className="text-[12px] font-medium text-[var(--ds-text-muted)] flex-shrink-0">{t('loadError')}</span>
      ) : (
        <div className="flex items-center gap-1 flex-shrink-0">
          <span className={`text-[12px] font-medium ${on ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-text-subtle)]'}`}>
            {on ? t('statusOn') : t('statusOff')}
          </span>
          {/* Il binario resta quello di 24px degli altri interruttori; il
              bottone attorno lo porta a un bersaglio di 44px. */}
          <button
            type="button" role="switch" aria-checked={on}
            aria-label={on ? t('turnOff') : t('turnOn')}
            onClick={toggle}
            disabled={!canEdit || saving}
            className="group inline-flex h-11 w-14 flex-shrink-0 items-center justify-center focus:outline-none disabled:cursor-not-allowed"
          >
            <span
              aria-hidden="true"
              className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors group-focus-visible:ring-2 group-focus-visible:ring-[var(--ds-border-focus)] group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-[var(--ds-surface)] group-disabled:opacity-50 ${
                on ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
              }`}
            >
              <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
            </span>
          </button>
        </div>
      )}
    </div>
  );
};
