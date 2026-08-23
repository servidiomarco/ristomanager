import React from 'react';

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
  label = 'Carico…',
  size = 48,
  className = '',
}) => (
  <div
    className={`flex flex-col items-center justify-center gap-3 text-[var(--color-fg-muted)] ${className}`}
    role="status"
    aria-live="polite"
    aria-label={label ?? 'Caricamento in corso'}
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
    {label != null && <span className="text-sm">{label}</span>}
  </div>
);

export default Loader;
