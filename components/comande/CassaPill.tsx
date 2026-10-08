import React from 'react';
import { useTranslation } from 'react-i18next';
import { StatusPill } from '../ds';
import type { ComandaVivaStato } from '../../types';

// ---------------------------------------------------------------------------
// Dove sta l'ordine nella cassa Passepartout, quando il ristorante manda gli
// ordini del CRM nella comanda in cassa del tavolo (services/
// passepartoutComandeVive.ts). Tre parole, nella testata del palmare:
// «In cassa», «Verso la cassa», «Errore cassa». Niente da dire, niente
// pastiglia: gli ordini che non vanno in cassa non la mostrano.
// ---------------------------------------------------------------------------

export const CassaPill: React.FC<{ stato: ComandaVivaStato | null | undefined }> = ({ stato }) => {
  const { t } = useTranslation('comande', { useSuspense: false });
  if (!stato || stato.stato === 'CHIUSA') return null;
  if (stato.stato === 'SCRITTA') {
    return <StatusPill tone="positive" title={t('cassa.scrittaTitolo')}>{t('cassa.scritta')}</StatusPill>;
  }
  if (stato.stato === 'FAILED') {
    return <StatusPill tone="critical" title={stato.error ?? undefined}>{t('cassa.errore')}</StatusPill>;
  }
  return <StatusPill tone="pending">{t('cassa.inAttesa')}</StatusPill>;
};
