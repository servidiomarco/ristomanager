import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList } from 'lucide-react';
import { Callout, Field, StatusPill, dsSelect } from '../ds';
import {
  getComandeViveConfig, setComandeViveConfig, type PpChi, type PpComandeViveConfig,
} from '../../services/passepartoutApiService';
import { InterruttorePassepartout, SchedaPassepartout } from './SchedaPassepartout';

/* ===========================================================================
   Impostazioni → Passepartout → Comande del CRM in cassa.

   Il CRM fa da palmare della cassa: la comanda presa nel CRM nasce e cresce
   nella comanda in cassa del tavolo vero (su un tavolo già aperto in cassa
   le righe si aggiungono alla stessa comanda). Due scelte del ristorante:
   chi stampa in cucina e al bar — la cassa o il CRM, mai tutti e due — e
   chi fa il conto. Si accende solo con comande, tavoli abbinati, tipo di
   pagamento in cassa e un agente che sa scrivere le comande.
   ========================================================================= */

interface Props {
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export const ComandeInCassa: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('impostazioni', { useSuspense: false });
  const [stato, setStato] = useState<PpComandeViveConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    let cancelled = false;
    getComandeViveConfig()
      .then((s) => { if (!cancelled) setStato(s); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const salva = async (patch: Parameters<typeof setComandeViveConfig>[0]) => {
    if (!stato || busy) return;
    setBusy(true);
    try {
      await setComandeViveConfig(patch);
      setStato(await getComandeViveConfig());
      showToastRef.current(t('pp.saved'), 'success');
    } catch (err: any) {
      showToastRef.current(err?.message || t('pp.saveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const mancano = stato
    ? [
      !stato.requisiti.comande && t('pp.vivoNeedOrders'),
      stato.requisiti.tavoli_abbinati === 0 && t('pp.vivoNeedTables'),
      !stato.requisiti.tipo_pagamento && t('pp.vivoNeedType'),
    ].filter((m): m is string => typeof m === 'string')
    : [];
  const pronto = !!stato && mancano.length === 0 && stato.agente.aggiornato;

  return (
    <SchedaPassepartout
      icon={ClipboardList}
      title={t('pp.vivoTitle')}
      subtitle={t('pp.vivoSubtitle')}
      badge={stato?.enabled ? t('pp.on') : null}
      busy={busy}
    >
      {loadError && <Callout tone="critical">{t('pp.loadFailed')}</Callout>}
      {stato && (
        <>
          {!stato.agente.collegato
            ? <div><StatusPill tone="critical">{t('pp.agentOffline')}</StatusPill></div>
            : !stato.agente.aggiornato
              ? <div><StatusPill tone="pending">{t('pp.agentOld')}</StatusPill></div>
              : null}
          {mancano.length > 0 && (
            <Callout tone="pending">
              <ul className="list-disc space-y-1 pl-4">
                {mancano.map((m) => <li key={m}>{m}</li>)}
              </ul>
            </Callout>
          )}

          <Field label={t('pp.vivoPrint')} hint={t(stato.stampa === 'cassa' ? 'pp.vivoPrintHintCassa' : 'pp.vivoPrintHintCrm')}>
            <select
              aria-label={t('pp.vivoPrint')}
              className={dsSelect}
              value={stato.stampa}
              disabled={busy}
              onChange={(e) => salva({ stampa: e.target.value as PpChi })}
            >
              <option value="cassa">{t('pp.vivoByCassa')}</option>
              <option value="crm">{t('pp.vivoByCrm')}</option>
            </select>
          </Field>

          <Field label={t('pp.vivoBill')} hint={t(stato.conto === 'cassa' ? 'pp.vivoBillHintCassa' : 'pp.vivoBillHintCrm')}>
            <select
              aria-label={t('pp.vivoBill')}
              className={dsSelect}
              value={stato.conto}
              disabled={busy}
              onChange={(e) => salva({ conto: e.target.value as PpChi })}
            >
              <option value="cassa">{t('pp.vivoByCassa')}</option>
              <option value="crm">{t('pp.vivoByCrm')}</option>
            </select>
          </Field>

          {!stato.requisiti.articolo_generico && (
            <p className="text-[13px] text-[var(--ds-text-muted)]">{t('pp.vivoNoGeneric')}</p>
          )}

          <Field
            label={t('pp.vivoSend')}
            hint={t('pp.vivoHint')}
            aside={
              <InterruttorePassepartout
                checked={stato.enabled}
                label={t('pp.vivoSend')}
                disabled={busy || (!stato.enabled && !pronto)}
                onToggle={() => salva({ enabled: !stato.enabled })}
              />
            }
          >
            {null}
          </Field>
        </>
      )}
    </SchedaPassepartout>
  );
};
