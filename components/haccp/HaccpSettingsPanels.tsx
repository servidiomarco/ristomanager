import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { haccpApiService, HaccpPoint } from '../../services/haccpApiService';
import { onSocketEvent } from '../../services/socketEvents';
import { Callout } from '../ds';
import { HaccpLimitsCard } from './HaccpLimitsCard';
import { HaccpSensorsCard } from './HaccpSensorsCard';
import { HaccpLabelPresetsCard } from './HaccpLabels';
import { HaccpPointsConfig } from './HaccpPointsConfig';
import { HaccpCardStyle, emptyNote } from './haccpUi';

/* Impostazioni › HACCP: le card di HACCP › Configura, una per blocco che si
   apre. Ogni blocco è un componente a sé (App.tsx li mette nei suoi
   SettingsDisclosure), ma postazioni e sensori leggono la stessa lista: una
   postazione aggiunta nel blocco Postazioni compare subito nel menu dei
   sensori. Il socket `haccp:changed` le fa rileggere quando scrive qualcun
   altro — da qui o dal modulo HACCP su un altro telefono. */

const pointsListeners = new Set<() => void>();
const reloadSharedPoints = () => pointsListeners.forEach(fn => fn());

const useSharedPoints = (): { points: HaccpPoint[] | null; error: string | null } => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [points, setPoints] = useState<HaccpPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await haccpApiService.getPoints(true);
      setPoints(r.points);
      setError(null);
    } catch (e: any) {
      setError(e?.message || t('err.load', 'Errore nel caricamento'));
    }
  }, [t]);
  useEffect(() => {
    load();
    pointsListeners.add(load);
    return () => { pointsListeners.delete(load); };
  }, [load]);
  useEffect(() => onSocketEvent('haccp:changed', () => { load(); }), [load]);
  return { points, error };
};

const useRefreshKey = (): number => {
  const [key, setKey] = useState(0);
  useEffect(() => onSocketEvent('haccp:changed', () => setKey(k => k + 1)), []);
  return key;
};

const EMBEDDED = { flat: true, hideTitle: true };
const EMBEDDED_WITH_TITLES = { flat: true, hideTitle: false };

export const HaccpSettingsSensors: React.FC = () => {
  const { points } = useSharedPoints();
  const refreshKey = useRefreshKey();
  return (
    <HaccpCardStyle.Provider value={EMBEDDED}>
      <HaccpSensorsCard points={points ?? []} refreshKey={refreshKey} />
    </HaccpCardStyle.Provider>
  );
};

export const HaccpSettingsPoints: React.FC = () => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const { points, error } = useSharedPoints();
  return (
    // Qui i titoli restano: dentro il blocco ci sono cinque registri.
    <HaccpCardStyle.Provider value={EMBEDDED_WITH_TITLES}>
      {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}
      {points === null && !error && <p className={emptyNote}>{t('loading', 'Caricamento…')}</p>}
      {points && <HaccpPointsConfig points={points} onChanged={reloadSharedPoints} />}
    </HaccpCardStyle.Provider>
  );
};

export const HaccpSettingsLimits: React.FC = () => {
  const refreshKey = useRefreshKey();
  return (
    <HaccpCardStyle.Provider value={EMBEDDED}>
      <HaccpLimitsCard refreshKey={refreshKey} />
    </HaccpCardStyle.Provider>
  );
};

export const HaccpSettingsLabels: React.FC = () => {
  const refreshKey = useRefreshKey();
  return (
    <HaccpCardStyle.Provider value={EMBEDDED}>
      <HaccpLabelPresetsCard refreshKey={refreshKey} />
    </HaccpCardStyle.Provider>
  );
};
