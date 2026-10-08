import React from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList } from 'lucide-react';
import { dsButton } from '../ds';
import type { Dish } from '../../types';
import type { FoodCostState } from '../../hooks/useFoodCost';
import { money } from '../../utils/displayMoney';
import { foodCostPct, margineCents, semaforo } from '../../utils/foodCost';
import { FoodCostPill } from './FoodCostPill';

/* Il food cost nella scheda del piatto del Menu: costo, percentuale e
   margine in una riga, e la porta per la scheda tecnica. Solo per chi ha
   foodcost:view (fc.enabled). */

export const PiattoFoodCost: React.FC<{
  fc: FoodCostState;
  dish: Dish;
  onOpenScheda: () => void;
}> = ({ fc, dish, onOpenScheda }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  if (!fc.enabled || !fc.dati) return null;
  const c = fc.costoDi(dish.id);
  const iva = dish.vat_rate ?? 10;
  const pct = foodCostPct(c?.cents ?? null, Number(dish.price) || 0, iva);
  const margine = margineCents(c?.cents ?? null, Number(dish.price) || 0, iva);
  const target = fc.dati.impostazioni.targetPct;
  const senza = !c || c.stato === 'senza_scheda';

  return (
    <div>
      <h4 className="mb-2 text-[13px] font-semibold text-[var(--ds-text-muted)]">{t('dish.title', 'Food cost')}</h4>
      {senza ? (
        <p className="rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] px-3 py-2.5 text-[13px] text-[var(--ds-text-muted)]">
          {t('dish.noCard', 'Nessuna scheda tecnica.')}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] px-3 py-2.5 text-[14px] tabular-nums text-[var(--ds-text-secondary)]">
          <span>{t('dish.cost', 'Costo')} <strong className="text-[var(--ds-text-primary)]">{money(Math.round(c!.cents ?? 0))}</strong></span>
          <FoodCostPill pct={pct} tone={semaforo(pct, target)} />
          {margine != null && <span>{t('dish.margin', 'Margine')} <strong className="text-[var(--ds-text-primary)]">{money(Math.round(margine))}</strong></span>}
          {c!.stato === 'incompleto' && <span className="w-full text-[13px] text-[var(--ds-pending-text)]">{t('dishes.missingPrices', 'mancano prezzi')}</span>}
        </div>
      )}
      <button type="button" onClick={onOpenScheda} className={`${dsButton.quiet} mt-2 w-full`}>
        <ClipboardList className="h-4 w-4" aria-hidden /> {t('dish.openCard', 'Scheda tecnica')}
      </button>
    </div>
  );
};
