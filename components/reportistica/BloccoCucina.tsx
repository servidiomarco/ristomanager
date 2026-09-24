import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChefHat, Trash2 } from 'lucide-react';
import { SegmentedControl } from '../ds';
import { DishesReport } from '../../services/reportsApiService';
import { downloadCsv } from '../../utils/downloadCsv';
import { SectionCard, CsvButton, EmptyChart, formatInt, formatEuroCents } from './shared';

type Ordinamento = 'qty' | 'ricavo';

export const BloccoCucina: React.FC<{ data: DishesReport }> = ({ data }) => {
  const { t } = useTranslation('reportistica', { useSuspense: false });
  const [ordina, setOrdina] = React.useState<Ordinamento>('qty');

  if (!data.enabled) {
    return (
      <SectionCard
        icon={<ChefHat className="h-5 w-5" />}
        title={t('cuc.title', 'Cucina e piatti')}
        subtitle={t('cuc.subtitleEmpty', 'Piatti più venduti, tempi per partita e scarti')}
      >
        <EmptyChart message="Il modulo comande è disattivato: qui compariranno piatti, tempi e scarti." />
      </SectionCard>
    );
  }

  const piatti = [...(data.top_piatti ?? [])]
    .sort((a, b) => (ordina === 'qty' ? b.qty - a.qty : b.ricavo_cents - a.ricavo_cents))
    .slice(0, 15);
  const partite = data.partite ?? [];
  const scarti = data.scarti ?? [];
  const scartiTot = scarti.reduce((n, s) => n + (s.valore_cents ?? 0), 0);

  const esporta = () => downloadCsv(
    `top-piatti-${data.from}-${data.to}`,
    ['piatto', 'quantita', 'ricavo_eur'],
    [...(data.top_piatti ?? [])].map(p => [p.piatto, p.qty, (p.ricavo_cents / 100).toFixed(2)])
  );

  return (
    <SectionCard
      icon={<ChefHat className="h-5 w-5" />}
      title={t('cuc.title', 'Cucina e piatti')}
      subtitle={t('cuc.subtitle', 'Dalle comande lanciate nel periodo · righe stornate escluse dai venduti, contate negli scarti')}
      actions={<CsvButton onClick={esporta} />}
    >
      <div className="mb-4 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-[var(--ds-text-secondary)]">Piatti più venduti</span>
          <SegmentedControl<Ordinamento>
            value={ordina}
            onChange={setOrdina}
            ariaLabel="Ordina i piatti per quantità o ricavo"
            size="sm"
            options={[
              { value: 'qty', label: t('cuc.qty', 'Quantità') },
              { value: 'ricavo', label: t('cuc.revenue', 'Ricavo') },
            ]}
          />
        </div>
        {piatti.length > 0 ? (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[var(--ds-text-muted)]">
                <th className="py-1.5 pr-2 font-medium">{t('cuc.dish', 'Piatto')}</th>
                <th className="py-1.5 pr-2 text-right font-medium">{t('cuc.qty', 'Quantità')}</th>
                <th className="py-1.5 text-right font-medium">{t('cuc.revenue', 'Ricavo')}</th>
              </tr>
            </thead>
            <tbody>
              {piatti.map(p => (
                <tr key={p.piatto} className="border-t border-[var(--ds-border)]">
                  <td className="py-1.5 pr-2 text-[var(--ds-text-primary)]">{p.piatto}</td>
                  <td className="tabular py-1.5 pr-2 text-right text-[var(--ds-text-secondary)]">{formatInt(p.qty)}</td>
                  <td className="tabular py-1.5 text-right font-semibold text-[var(--ds-text-primary)]">{formatEuroCents(p.ricavo_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="py-6 text-center text-[13px] text-[var(--ds-text-muted)]">Nessun piatto lanciato nel periodo.</div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-3">
          <div className="mb-1 text-[13px] font-medium text-[var(--ds-text-secondary)]">Tempi per partita</div>
          {partite.length > 0 ? (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[var(--ds-text-muted)]">
                  <th className="py-1.5 pr-2 font-medium">{t('cuc.station', 'Partita')}</th>
                  <th className="py-1.5 pr-2 text-right font-medium">{t('cuc.lines', 'Righe')}</th>
                  <th className="py-1.5 pr-2 text-right font-medium">{t('cuc.mean', 'Media')}</th>
                  <th className="py-1.5 text-right font-medium">{t('cuc.median', 'Mediana')}</th>
                </tr>
              </thead>
              <tbody>
                {partite.map(p => (
                  <tr key={p.station_id ?? 'senza'} className="border-t border-[var(--ds-border)]">
                    <td className="py-1.5 pr-2 text-[var(--ds-text-primary)]">{p.station_name ?? 'Senza partita'}</td>
                    <td className="tabular py-1.5 pr-2 text-right text-[var(--ds-text-secondary)]">{formatInt(p.righe)}</td>
                    <td className="tabular py-1.5 pr-2 text-right text-[var(--ds-text-secondary)]">{p.media_min ?? '—'} min</td>
                    <td className="tabular py-1.5 text-right font-semibold text-[var(--ds-text-primary)]">{p.mediana_min ?? '—'} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-4 text-center text-[13px] text-[var(--ds-text-muted)]">Nessuna riga pronta nel periodo.</div>
          )}
        </div>
        <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-[var(--ds-text-secondary)]">
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            {t('cuc.wasteByReason', 'Scarti per motivo')}
            {scartiTot > 0 && <span className="ml-auto tabular font-semibold text-[var(--ds-text-primary)]">{formatEuroCents(scartiTot)}</span>}
          </div>
          {scarti.length > 0 ? (
            <table className="w-full text-[13px]">
              <tbody>
                {scarti.map(s => (
                  <tr key={s.motivo ?? 'altro'} className="border-t border-[var(--ds-border)]">
                    <td className="py-1.5 pr-2 text-[var(--ds-text-primary)]">{s.motivo || 'Senza motivo'}</td>
                    <td className="tabular py-1.5 pr-2 text-right text-[var(--ds-text-secondary)]">{formatInt(s.righe)}</td>
                    <td className="tabular py-1.5 text-right font-semibold text-[var(--ds-text-primary)]">{formatEuroCents(s.valore_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-4 text-center text-[13px] text-[var(--ds-text-muted)]">Nessuno storno nel periodo.</div>
          )}
        </div>
      </div>
    </SectionCard>
  );
};
