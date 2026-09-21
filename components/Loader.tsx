import React from 'react';
import { useTranslation } from 'react-i18next';

interface LoaderProps {
  /** Text shown under the ring. Pass null to render the ring on its own. */
  label?: string | null;
  /** Pixel size of the ring. Defaults to 48. */
  size?: number;
  className?: string;
}

/**
 * The loading indicator: a track ring with a rotating arc. Neutral on
 * purpose — this spins on every surface of the product, not just the
 * kitchen ones, and it inherits `currentColor` so it takes whatever muted
 * foreground the caller sets. Motion stops under `prefers-reduced-motion`
 * via the global rule in index.css; the static arc still reads as
 * "working" on its own.
 */
export const Loader: React.FC<LoaderProps> = ({
  label,
  size = 48,
  className = '',
}) => {
  const { t } = useTranslation('common', { useSuspense: false });
  /* `undefined` prende il testo di default tradotto; `null` resta l'anello
     nudo, come prima. */
  const testo = label === undefined ? t('loaderDefault') : label;
  return (
  <div
    className={`flex flex-col items-center justify-center gap-3 text-[var(--ds-text-muted)] ${className}`}
    role="status"
    aria-live="polite"
    aria-label={testo ?? t('loadingAria')}
  >
    <svg
      className="animate-spin"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="4" opacity="0.15" />
      <path
        d="M44 24c0-11.046-8.954-20-20-20"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
    {testo != null && <span className="text-sm">{testo}</span>}
    </div>
  );
};

export default Loader;
