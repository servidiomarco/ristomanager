import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Armchair, Loader2, RefreshCw } from 'lucide-react';
import { Callout, Field, StatusPill, dsButton } from '../ds';
import {
  aggiornaTavoliAperti, getTavoliApertiConfig, setTavoliApertiConfig, type PpTavoliApertiConfig,
} from '../../services/passepartoutApiService';
import { InterruttorePassepartout, SchedaPassepartout } from './SchedaPassepartout';

/* ===========================================================================
   Impostazioni → Passepartout → Tavoli aperti in cassa.

   Sola lettura, ogni minuto: i tavoli con una comanda aperta in cassa
   (walk-in compresi) risultano occupati in sala, reception e mappa delle
   prenotazioni. Con «Considera nella disponibilità» Sofia e le prenotazioni
   online non li propongono finché non si liberano (stima: apertura + durata
   del turno). Lo staff che assegna a mano vede il tavolo occupato e decide
   lui: il gruppo di prima può star pagando.
   ========================================================================= */

interface Props {
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export const TavoliApertiInCassa: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('impostazioni', { useSuspense: false });
  const [stato, setStato] = useState<PpTavoliApertiConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<null | 'salva' | 'aggiorna'>(null);

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    let cancelled = false;
    getTavoliApertiConfig()
      .then((s) => { if (!cancelled) setStato(s); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const salva = async (patch: { enabled?: boolean; disponibilita?: boolean }) => {
    if (!stato || busy) return;
    setBusy('salva');
    try {
      await setTavoliApertiConfig(patch);
      setStato(await getTavoliApertiConfig());
      showToastRef.current(t('pp.saved'), 'success');
    } catch (err: any) {
      showToastRef.current(err?.message || t('pp.saveFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const aggiorna = async () => {
    if (busy) return;
    setBusy('aggiorna');
    try {
      const r = await aggiornaTavoliAperti();
      showToastRef.current(t('pp.apertiDone', { count: r.tavoli.length }), 'success');
      setStato(await getTavoliApertiConfig());
    } catch (err: any) {
      showToastRef.current(err?.message || t('pp.saveFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <SchedaPassepartout
      icon={Armchair}
      title={t('pp.apertiTitle')}
      subtitle={t('pp.apertiSubtitle')}
      badge={stato?.enabled ? t('pp.on') : null}
      busy={busy != null}
    >
      {loadError && <Callout tone="critical">{t('pp.loadFailed')}</Callout>}
      {stato && (
        <>
          {!stato.agente.collegato
            ? <div><StatusPill tone="critical">{t('pp.agentOffline')}</StatusPill></div>
            : !stato.agente.aggiornato
              ? <div><StatusPill tone="pending">{t('pp.agentOld')}</StatusPill></div>
              : null}

          <Field
            label={t('pp.apertiSend')}
            hint={t('pp.apertiHint')}
            aside={
              <InterruttorePassepartout
                checked={stato.enabled}
                label={t('pp.apertiSend')}
                disabled={busy != null}
                onToggle={() => salva({ enabled: !stato.enabled })}
              />
            }
          >
            {null}
          </Field>

          {stato.enabled && (
            <>
              <Field
                label={t('pp.apertiDisp')}
                hint={t('pp.apertiDispHint')}
                aside={
                  <InterruttorePassepartout
                    checked={stato.disponibilita}
                    label={t('pp.apertiDisp')}
                    disabled={busy != null}
                    onToggle={() => salva({ disponibilita: !stato.disponibilita })}
                  />
                }
              >
                {null}
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-[14px] text-[var(--ds-text-primary)]">{t('pp.apertiNow', { count: stato.aperti })}</span>
                <button
                  type="button"
                  className={dsButton.secondary}
                  onClick={aggiorna}
                  disabled={busy != null || !stato.agente.aggiornato}
                >
                  {busy === 'aggiorna' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                  {t('pp.apertiRefresh')}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </SchedaPassepartout>
  );
};
