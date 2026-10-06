import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PlugZap } from 'lucide-react';
import { Callout, Field, SegmentedControl, StatusPill, dsSelect } from '../ds';
import { formatDateTime } from '../../utils/formatLocale';
import { sessionTimeZone } from '../../utils/displayTime';
import { getPpConfig, getPpTipiPagamento, setPpConfig, type PpConfig } from '../../services/passepartoutApiService';
import { SchedaPassepartout } from './SchedaPassepartout';

/* ===========================================================================
   Impostazioni → Passepartout → Collegamento e chiusura in cassa.

   Lo stato dell'agente sul PC di sala del ristorante e come la cassa chiude
   i conti saldati nel CRM: sotto quale tipo di pagamento (uno dedicato,
   così la cassa non conta l'incasso due volte) e con quale documento. Il
   tipo si sceglie fra quelli veri della cassa: un nome sbagliato lascerebbe
   i conti a sospeso. Vuoto = la chiusura automatica è spenta e i tavoli si
   chiudono in cassa a mano.
   ========================================================================= */

interface Props {
  showToast: (message: string, type?: 'success' | 'error') => void;
}

/** Le capacità che l'agente annuncia, dette per esteso. */
const CAPACITA: Record<string, string> = {
  'chiudi-riprendi': 'pp.capRiprendi',
  prenotazioni: 'pp.capPrenotazioni',
  conti: 'pp.capConti',
};

export const CollegamentoCassa: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('impostazioni', { useSuspense: false });
  const [config, setConfig] = useState<PpConfig | null>(null);
  const [tipi, setTipi] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    let cancelled = false;
    getPpConfig()
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        // I tipi si leggono dalla cassa: solo con l'agente collegato.
        if (c.agente.connected) {
          getPpTipiPagamento()
            .then((list) => { if (!cancelled) setTipi(list.map((x) => x.codice)); })
            .catch(() => { if (!cancelled) setTipi(null); });
        }
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const salva = async (patch: { tipo_pagamento_esterno?: string | null; tipo_documento?: 'Scontrino' | 'Proforma' | null }) => {
    if (!config || saving) return;
    const prima = config;
    setConfig({ ...config, ...patch });
    setSaving(true);
    try {
      const r = await setPpConfig(patch);
      setConfig((c) => (c ? { ...c, ...patch, effettivo: r.effettivo } : c));
      showToastRef.current(t('pp.saved'), 'success');
    } catch (err: any) {
      setConfig(prima);
      showToastRef.current(err?.message || t('pp.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const agente = config?.agente;
  // Il valore in uso: quello salvato, o quello ereditato dal server.
  const tipoInUso = config?.tipo_pagamento_esterno ?? config?.effettivo.tipo_pagamento ?? '';
  const opzioniTipo = [...new Set([...(tipi ?? []), ...(tipoInUso ? [tipoInUso] : [])])];

  return (
    <SchedaPassepartout
      icon={PlugZap}
      title={t('pp.connTitle')}
      subtitle={t('pp.connSubtitle')}
      busy={saving}
    >
      {loadError && <Callout tone="critical">{t('pp.loadFailed')}</Callout>}
      {config && agente && (
        <>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {agente.connected
                ? <StatusPill tone="positive">{t('pp.agentOk')}</StatusPill>
                : <StatusPill tone="critical">{t('pp.agentOffline')}</StatusPill>}
              {agente.capabilities.map((c) => (
                <StatusPill key={c} tone="neutral">{CAPACITA[c] ? t(CAPACITA[c]) : c}</StatusPill>
              ))}
            </div>
            {agente.connected && (
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                {t('pp.connDetail', {
                  pc: agente.hostname ?? '—',
                  versione: agente.versione_gestionale ?? '—',
                  when: agente.connected_at
                    ? formatDateTime(agente.connected_at, { timeZone: sessionTimeZone(), day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                    : '—',
                })}
              </p>
            )}
          </div>

          <Field
            label={t('pp.payType')}
            htmlFor="pp-tipo-pagamento"
            hint={!config.tipo_pagamento_esterno && config.effettivo.tipo_pagamento
              ? t('pp.payTypeFromServer', { tipo: config.effettivo.tipo_pagamento })
              : t('pp.payTypeHint')}
          >
            <select
              id="pp-tipo-pagamento"
              className={dsSelect}
              value={tipoInUso}
              disabled={saving || (tipi == null && opzioniTipo.length === 0)}
              onChange={(e) => salva({ tipo_pagamento_esterno: e.target.value || null })}
            >
              <option value="">{t('pp.payTypeNone')}</option>
              {opzioniTipo.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          {tipi == null && (
            <p className="text-[13px] text-[var(--ds-text-muted)]">{t('pp.payTypeNeedsAgent')}</p>
          )}

          <Field label={t('pp.docType')} hint={t('pp.docTypeHint')}>
            <SegmentedControl<'Scontrino' | 'Proforma'>
              ariaLabel={t('pp.docType')}
              value={(config.tipo_documento ?? config.effettivo.tipo_documento) === 'Proforma' ? 'Proforma' : 'Scontrino'}
              onChange={(v) => salva({ tipo_documento: v })}
              options={[
                { value: 'Scontrino', label: t('pp.docReceipt') },
                { value: 'Proforma', label: t('pp.docProforma') },
              ]}
            />
          </Field>
        </>
      )}
    </SchedaPassepartout>
  );
};
