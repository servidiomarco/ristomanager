import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SegmentedControl } from './ds';
import { useAuth } from '../contexts/AuthContext';
import { haccpApiService } from '../services/haccpApiService';
import { onSocketEvent } from '../services/socketEvents';
import { HaccpToday } from './haccp/HaccpToday';
import { HaccpNonConformities } from './haccp/HaccpNonConformities';
import { HaccpReport } from './haccp/HaccpReport';
import { HaccpConfig } from './haccp/HaccpConfig';

/* Il registro HACCP (docs/haccp-piano.md). Quattro schede: il modulo del
   giorno, le non conformità da chiudere, il report per periodo e — per chi
   gestisce l'HACCP — i punti di controllo del locale.

   ATTENZIONE — quello che NON si traduce: i nomi dei punti di controllo
   («Frigo antipasti», «Friggitrice 3») sono dati del ristorante, scritti da
   lui nella sua lingua; e il foglio stampato (utils/printHaccpReport.ts) è un
   documento per l'ASL, in italiano. */

type Tab = 'today' | 'nc' | 'report' | 'config';

export const HaccpPage: React.FC = () => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const { hasPermission } = useAuth();
  const canManage = hasPermission('haccp:manage');
  const [tab, setTab] = useState<Tab>('today');
  const [openNc, setOpenNc] = useState(0);
  // Un altro telefono ha scritto nel registro: ogni scheda rilegge in
  // silenzio. Senza, la cuoca che registra la cella 1 non vede la cella 2
  // appena registrata dal collega finché non ricarica.
  const [refreshKey, setRefreshKey] = useState(0);

  const loadOpenCount = useCallback(() => {
    haccpApiService.getNonConformities({ status: 'open' })
      .then(r => setOpenNc(r.nonconformities.length))
      .catch(() => { /* il contatore è un di più: senza, la scheda si apre lo stesso */ });
  }, []);

  useEffect(() => { loadOpenCount(); }, [loadOpenCount, refreshKey]);
  useEffect(() => onSocketEvent('haccp:changed', () => setRefreshKey(k => k + 1)), []);

  const options: Array<{ value: Tab; label: string; badge?: number; badgeTone?: 'neutral' | 'alert' }> = [
    { value: 'today', label: t('tab.today', 'Registro') },
    { value: 'nc', label: t('tab.nc', 'Non conformità'), badge: openNc || undefined, badgeTone: 'alert' },
    { value: 'report', label: t('tab.report', 'Report') },
    ...(canManage ? [{ value: 'config' as const, label: t('tab.config', 'Configura') }] : []),
  ];

  return (
    // Scorrimento della pagina, non del contenitore dell'app: è quello che
    // tiene il contenuto sopra la barra di navigazione flottante del telefono
    // invece di lasciarlo passare dietro e ricomparire sotto.
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="space-y-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)] sm:text-[26px]">HACCP</h1>
            <p className="mt-1 text-[15px] text-[var(--ds-text-muted)]">
              {t('subtitle', 'Controlli giornalieri di igiene e sicurezza alimentare.')}
            </p>
          </div>

          <SegmentedControl<Tab>
            value={tab}
            onChange={setTab}
            ariaLabel={t('tabs', 'Sezioni HACCP')}
            overflow="scroll"
            equalWidth={false}
            options={options}
          />

          {tab === 'today' && (
            <HaccpToday
              refreshKey={refreshKey}
              onOpenNonConformities={() => setTab('nc')}
              onNcCountChange={setOpenNc}
              onConfigure={canManage ? () => setTab('config') : undefined}
            />
          )}
          {tab === 'nc' && <HaccpNonConformities refreshKey={refreshKey} canManage={canManage} onCountChange={setOpenNc} />}
          {tab === 'report' && <HaccpReport refreshKey={refreshKey} />}
          {tab === 'config' && canManage && <HaccpConfig refreshKey={refreshKey} />}
        </div>
      </div>
    </div>
  );
};
