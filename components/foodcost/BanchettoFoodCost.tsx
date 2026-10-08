import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { Callout, FormCard } from '../ds';
import type { BanquetCourse, BanquetMenu, Dish } from '../../types';
import type { FoodCostState } from '../../hooks/useFoodCost';
import { money } from '../../utils/displayMoney';
import { calcolaBanchetto, quotaPorzione, semaforo } from '../../utils/foodCost';
import { FoodCostPill } from './FoodCostPill';

/* Il food cost del banchetto, mentre lo si compone: costo per coperto,
   percentuale sul prezzo a persona (IVA e sconto tolti), margine, e il
   prezzo che porterebbe il banchetto al target.

   Le quote di porzione stanno nelle uscite (courses[].quote): l'antipasto
   misto da sei assaggi non è sei porzioni intere. Si cambiano qui, nel passo
   del menù, e viaggiano col banchetto quando si salva.

   Riservato a chi ha foodcost:view; il preventivo stampato e quello
   condiviso col cliente non lo vedono mai. */

const QUOTE = [1, 0.75, 0.5, 0.33, 0.25];
const quotaLabel = (q: number) => (q === 1 ? '1' : q === 0.75 ? '¾' : q === 0.5 ? '½' : q === 0.33 ? '⅓' : q === 0.25 ? '¼' : String(q).replace('.', ','));

export const BanchettoFoodCost: React.FC<{
  fc: FoodCostState;
  banquet: Partial<BanquetMenu>;
  dishById: Map<number, Dish>;
  /** Con questa, il riquadro mostra le uscite e lascia cambiare le quote. */
  onQuota?: (courseIndex: number, dishId: number, quota: number) => void;
  /** Il prezzo a persona è visibile a chi apre il banchetto. */
  showPrices: boolean;
}> = ({ fc, banquet, dishById, onQuota, showPrices }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const impostazioni = fc.dati?.impostazioni;
  const courses: BanquetCourse[] = banquet.courses ?? [];

  const esito = useMemo(() => {
    if (!impostazioni) return null;
    return calcolaBanchetto({
      courses,
      costoPiatto: fc.costoDi,
      guests: Number(banquet.guests) || 0,
      children: Number(banquet.children) || 0,
      pricePerPerson: Number(banquet.price_per_person) || 0,
      childrenPrice: banquet.children_price != null ? Number(banquet.children_price) : null,
      discountType: banquet.discount_type ?? null,
      discountValue: banquet.discount_value != null ? Number(banquet.discount_value) : null,
      ivaPct: impostazioni.ivaBanchettiPct,
      quotaBambiniPct: impostazioni.quotaBambiniPct,
      targetPct: impostazioni.targetPct,
    });
  }, [impostazioni, courses, fc.costoDi, banquet.guests, banquet.children, banquet.price_per_person, banquet.children_price, banquet.discount_type, banquet.discount_value]);

  if (!fc.enabled || !esito || !impostazioni) return null;
  const nessunPiatto = courses.every(c => (c.dish_ids ?? []).length === 0);
  const prezzo = Number(banquet.price_per_person) || 0;
  const conPrezzo = showPrices && prezzo > 0;
  const nomi = (ids: number[]) => ids.map(id => dishById.get(id)?.name).filter(Boolean).join(', ');
  const target = impostazioni.targetPct;

  return (
    <FormCard
      title={t('banquet.title', 'Food cost')}
      aside={conPrezzo ? <FoodCostPill pct={esito.foodCostPct} tone={semaforo(esito.foodCostPct, target)} /> : undefined}
    >
      {nessunPiatto ? (
        <p className="text-[14px] text-[var(--ds-text-muted)]">{t('banquet.noDishes', 'Componi il menù per vedere il costo per coperto.')}</p>
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Numero label={t('banquet.costAdult', 'Costo per coperto')} value={money(Math.round(esito.costoAdultoCents))} />
            {(Number(banquet.children) || 0) > 0 && (
              <Numero label={t('banquet.costChild', 'Costo bambino')} value={money(Math.round(esito.costoBambinoCents))} />
            )}
            {conPrezzo && (
              <>
                <Numero
                  label={t('banquet.marginAdult', 'Margine per coperto')}
                  value={esito.margineAdultoCents == null ? '—' : money(Math.round(esito.margineAdultoCents))}
                />
                {(Number(banquet.guests) || 0) > 0 && (
                  <Numero label={t('banquet.marginTotal', 'Margine totale')} value={money(Math.round(esito.margineTotaleCents))} />
                )}
              </>
            )}
            {showPrices && esito.prezzoConsigliatoAdulto != null && (
              <Numero
                label={t('banquet.suggested', 'Prezzo per stare al {{pct}}%', { pct: target })}
                value={money(Math.round(esito.prezzoConsigliatoAdulto * 100))}
              />
            )}
          </dl>

          {esito.piattiSenzaCosto.length > 0 && (
            <Callout tone="pending" icon={AlertCircle}>
              {t('banquet.noCard', 'Senza scheda, non contati: {{names}}', { names: nomi(esito.piattiSenzaCosto) })}
            </Callout>
          )}
          {esito.piattiIncompleti.length > 0 && (
            <p className="text-[13px] text-[var(--ds-pending-text)]">
              {t('banquet.incomplete', 'Con qualche prezzo mancante: {{names}}', { names: nomi(esito.piattiIncompleti) })}
            </p>
          )}

          {onQuota && (
            <div className="space-y-3">
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                {t('banquet.quotaHint', 'Quanta porzione di ogni piatto va a ospite: ½ per gli assaggi condivisi.')}
              </p>
              {courses.map((corso, ci) => (corso.dish_ids ?? []).length === 0 ? null : (
                <div key={ci}>
                  <p className="mb-1.5 text-[13px] font-semibold text-[var(--ds-text-secondary)]">{corso.name}</p>
                  <ul className="space-y-1.5">
                    {corso.dish_ids.map(id => {
                      const d = dishById.get(id);
                      const c = fc.costoDi(id);
                      const q = quotaPorzione(corso, id);
                      return (
                        <li key={id} className="flex flex-wrap items-center gap-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] px-3 py-1.5">
                          <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--ds-text-primary)]">{d?.name ?? `#${id}`}</span>
                          <span className="text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                            {c?.cents == null ? t('banquet.noCardShort', 'senza scheda') : money(Math.round(c.cents * q))}
                          </span>
                          <div className="inline-flex rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] p-0.5" role="group" aria-label={t('banquet.quota', 'Porzione')}>
                            {QUOTE.map(v => (
                              <button
                                key={v}
                                type="button"
                                aria-pressed={q === v}
                                onClick={() => onQuota(ci, id, v)}
                                className={`inline-flex h-9 min-w-[36px] items-center justify-center rounded-[var(--ds-radius-control)] px-2 text-[13px] font-semibold transition-colors ${
                                  q === v ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]' : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]'
                                }`}
                              >
                                {quotaLabel(v)}
                              </button>
                            ))}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {conPrezzo && (
            <p className="text-[13px] text-[var(--ds-text-muted)]">
              {t('banquet.note', 'Sul prezzo senza IVA ({{vat}}%), sconto compreso.', { vat: impostazioni.ivaBanchettiPct })}
            </p>
          )}
        </div>
      )}
    </FormCard>
  );
};

const Numero: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="min-w-0 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] px-3 py-2.5">
    <dt className="truncate text-[12px] text-[var(--ds-text-muted)]">{label}</dt>
    <dd className="mt-0.5 text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{value}</dd>
  </div>
);
