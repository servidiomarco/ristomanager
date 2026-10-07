import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { haccpApiService, HaccpPoint } from '../../services/haccpApiService';
import { Callout } from '../ds';
import { HaccpLimitsCard } from './HaccpLimitsCard';
import { HaccpSensorsCard } from './HaccpSensorsCard';
import { HaccpLabelPresetsCard } from './HaccpLabels';
import { HaccpPointsConfig } from './HaccpPointsConfig';
import { emptyNote } from './haccpUi';

/* HACCP › Configura: postazioni, limiti, etichette e sensori. Le stesse card
   stanno in Impostazioni › HACCP; qui restano per chi gestisce l'HACCP senza
   accesso alle Impostazioni (di base direttore e responsabile di sala). */

export const HaccpConfig: React.FC<{ refreshKey: number }> = ({ refreshKey }) => {
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
  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <div className="space-y-4">
      <p className="text-[14px] text-[var(--ds-text-muted)]">
        {t('config.intro', 'I punti di controllo del tuo manuale di autocontrollo. Il registro del giorno chiede questi, con questi limiti.')}
      </p>
      {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}
      {points === null && !error && <p className={emptyNote}>{t('loading', 'Caricamento…')}</p>}
      {points && <HaccpPointsConfig points={points} onChanged={load} />}
      <HaccpLimitsCard refreshKey={refreshKey} />
      <HaccpLabelPresetsCard refreshKey={refreshKey} />
      <HaccpSensorsCard points={points ?? []} refreshKey={refreshKey} />
    </div>
  );
};
