import React from 'react';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES, SupportedLanguage } from '../i18n/config';

// Pillola IT/EN delle pagine pubbliche React: stesso pattern del selettore
// di /pay (PublicPayPage) e del widget /prenota. Il namespace arriva dal
// chiamante perché la chiave header.langGroupAria vive nel dizionario di
// ogni pagina («una pagina, un file», vedi i18n/config.ts). /pay tiene la
// sua copia locale: pagina già in produzione, si unifica quando si ritocca.
export const PublicLanguageToggle: React.FC<{ namespace: string }> = ({ namespace }) => {
  const { t, i18n } = useTranslation(namespace, { useSuspense: false });
  const lang: SupportedLanguage = (i18n.language || '').toLowerCase().startsWith('en') ? 'en' : 'it';
  return (
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
};
