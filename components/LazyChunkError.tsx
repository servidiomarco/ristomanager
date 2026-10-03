import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Callout, dsButton } from './ds';

/**
 * Una vista caricata a richiesta il cui chunk non è arrivato: offline al primo
 * accesso, o un hash sparito col deploy successivo. Sta nel bundle principale
 * di proposito, perché deve esserci proprio quando il chunk non c'è.
 *
 * L'unica via d'uscita è ricaricare la pagina: un React.lazy rifiutato resta
 * rifiutato per sempre, e rimontare la vista ridarebbe lo stesso errore.
 */
export const LazyChunkError: React.FC = () => {
  const { t } = useTranslation('common', { useSuspense: false });
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <Callout
        tone="critical"
        icon={AlertTriangle}
        action={
          <button type="button" onClick={() => window.location.reload()} className={dsButton.secondary}>
            {t('actions.reload')}
          </button>
        }
      >
        {t('lazy.chunkError')}
      </Callout>
    </div>
  );
};

export default LazyChunkError;
