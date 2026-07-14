import React from 'react';

interface CookingPotLoaderProps {
  /** Text shown under the pot. Pass null to render the pot on its own. */
  label?: string | null;
  /** Pixel size of the pot glyph. Defaults to 48. */
  size?: number;
  className?: string;
}

/**
 * A friendlier loading indicator than a plain spinner: a little pot that
 * simmers on the stove while three steam wisps rise and fade above it.
 * Colours inherit from the surrounding text (`currentColor`), so it adapts
 * to whatever muted foreground the caller sets. Motion is disabled
 * automatically under `prefers-reduced-motion` via the global rule in
 * index.css.
 */
export const CookingPotLoader: React.FC<CookingPotLoaderProps> = ({
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
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      {/* Steam wisps, staggered so they rise one after another. */}
      <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.55">
        <path className="pot-loader-steam" style={{ animationDelay: '0s' }}
          d="M18 15c0-2 2-2.4 2-4.4S18 8.6 18 6.6" />
        <path className="pot-loader-steam" style={{ animationDelay: '0.45s' }}
          d="M24 14c0-2 2-2.4 2-4.4S24 7.6 24 5.6" />
        <path className="pot-loader-steam" style={{ animationDelay: '0.9s' }}
          d="M30 15c0-2 2-2.4 2-4.4S30 8.6 30 6.6" />
      </g>

      <g className="pot-loader-body">
        {/* Handles (ears) either side of the pot. */}
        <path d="M12 29c-3 0-5 1.4-5 3.4s2 3.4 5 3.4"
          stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M36 29c3 0 5 1.4 5 3.4s-2 3.4-5 3.4"
          stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        {/* Pot body — a gently tapered bowl. */}
        <path
          d="M12 27h24l-2 12.2A3 3 0 0 1 31 41.8H17a3 3 0 0 1-3-2.6L12 27z"
          fill="currentColor"
          opacity="0.9"
        />
        {/* Lid, drawn last so it sits on top and can rattle independently. */}
        <g className="pot-loader-lid">
          <rect x="9.5" y="22" width="29" height="5" rx="2.5" fill="currentColor" />
          <circle cx="24" cy="19" r="2.2" fill="currentColor" />
        </g>
      </g>
    </svg>
    {label != null && <span className="text-sm">{label}</span>}
  </div>
);

export default CookingPotLoader;
