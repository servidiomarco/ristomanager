import React from 'react';
import { useTranslation } from 'react-i18next';
import { Wheat } from 'lucide-react';

/* ── Pane oggi ────────────────────────────────────────────────────────────
   Not a shopping line: a quantity the kitchen derives from tonight's covers,
   one kilo per ten. It lived only in the desktop column, which is the one
   place it is least needed — the person who has to remember the bread is the
   one holding the phone. */

export const BreadBanner: React.FC<{
  bread: { coperti: number; kg: number };
  className?: string;
}> = ({ bread, className = '' }) => {
  const { t } = useTranslation('spesa', { useSuspense: false });
  return (
  <div className={`flex items-start gap-3 rounded-[var(--ds-radius)] bg-[var(--ds-pending-tint)] p-4 ${className}`}>
    <Wheat className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--ds-pending-text)]" aria-hidden />
    <div className="min-w-0">
      <p className="text-[15px] font-semibold text-[var(--ds-pending-text)]">
        {t('bread.title', 'Pane oggi {{quanto}}', { quanto: bread.coperti > 0 ? `${bread.kg} kg` : '—' })}
      </p>
      <p className="mt-0.5 text-[13px] text-[var(--ds-pending-text)]">
        {bread.coperti > 0
          ? t('bread.covers', '{{count}} coperti previsti · 1 kg ogni 10', { count: bread.coperti })
          : t('bread.noCovers', 'Nessun coperto previsto per oggi')}
      </p>
    </div>
  </div>
  );
};
