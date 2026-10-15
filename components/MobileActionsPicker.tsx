import React from 'react';
import { useTranslation } from 'react-i18next';
import { CirclePlus } from 'lucide-react';
import { SettingsStatus, SettingsSummary, settingsCardClass } from './SettingsCard';

// Impostazioni → Menu: quali azioni compaiono nel pannello «+» del telefono.
// I riquadri sono quelli del foglio «+» (scatola quadrata da 80px, icona da
// 28, nome sotto), così la scelta si fa guardando quello che poi si vedrà;
// acceso = pieno nel colore delle azioni, spento = la scatola di sempre con
// l'icona spenta.
// L'ultimo acceso non si spegne: un «+» con il pannello vuoto non serve a
// niente, e il server rifiuta comunque l'elenco vuoto.
// Una card chiusa come le altre di Impostazioni: da chiusa dice quante
// azioni sono accese.

export interface MobileActionOption {
  key: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}

interface MobileActionsPickerProps {
  options: MobileActionOption[];
  selected: string[];
  onToggle: (key: string) => void;
}

const MobileActionsPicker: React.FC<MobileActionsPickerProps> = ({ options, selected, onToggle }) => {
  const { t } = useTranslation('common', { useSuspense: false });
  const selectedVisible = options.filter(o => selected.includes(o.key)).length;
  return (
    <details
      className={settingsCardClass}
      data-imp-parole="barra telefono piu crea azioni rapide pannello icone"
    >
      <SettingsSummary
        icon={CirclePlus}
        title={t('settings.mobileActions', 'Azioni del «+»')}
        description={t('settings.mobileActionsSummary', 'Cosa apre il «+» della barra del telefono')}
        trailing={<SettingsStatus>{t('settings.mobileActionsCount', { count: selectedVisible, defaultValue: '{{count}} attive' })}</SettingsStatus>}
      />
      <div className="border-t border-[var(--ds-border)] px-4 pb-4 pt-3">
        <p className="mb-4 text-[13px] text-[var(--ds-text-muted)]">
          {t('settings.mobileActionsHint', 'Tocca per mostrarle o toglierle dal pannello. Almeno una resta.')}
        </p>
        <div className="grid grid-cols-3 gap-x-2 gap-y-3 sm:grid-cols-4 @2xl:grid-cols-6">
          {options.map(({ key, label, Icon }) => {
            const on = selected.includes(key);
            const last = on && selectedVisible <= 1;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                disabled={last}
                onClick={() => onToggle(key)}
                className="pressable flex min-w-0 flex-col items-center gap-1.5 rounded-[var(--ds-radius-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:cursor-not-allowed"
              >
                <span
                  className={`flex aspect-square w-full max-w-[80px] items-center justify-center rounded-[var(--ds-radius)] transition-colors ${
                    on
                      ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                      : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]'
                  }`}
                >
                  <Icon className="h-7 w-7" />
                </span>
                <span className={`line-clamp-2 max-w-full text-center text-[12px] leading-tight ${on ? 'font-semibold text-[var(--ds-text-primary)]' : 'font-medium text-[var(--ds-text-muted)]'}`}>
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </details>
  );
};

export default MobileActionsPicker;
