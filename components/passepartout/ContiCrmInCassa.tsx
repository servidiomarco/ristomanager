import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, ReceiptText, RotateCcw } from 'lucide-react';
import { Callout, Field, StatusPill, dsButton, dsSelect } from '../ds';
import {
  getSpecchioConfig, riprovaSpecchio, setSpecchioConfig, type PpSpecchioConfig,
} from '../../services/passepartoutApiService';
import { InterruttorePassepartout, SchedaPassepartout } from './SchedaPassepartout';

/* ===========================================================================
   Impostazioni → Passepartout → Conti del CRM in cassa.

   I conti chiusi nel CRM (scontrino dal registratore del CRM) entrano anche
   in cassa, per le sue statistiche per articolo e il magazzino: una comanda
   sul tavolo scelto, senza stampe in cucina, chiusa come proforma pagata col
   tipo esterno — nessuno scontrino dalla cassa, l'incasso non conta due
   volte. In cassa esce il foglio della proforma.
   ========================================================================= */

interface Props {
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export const ContiCrmInCassa: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('impostazioni', { useSuspense: false });
  const [stato, setStato] = useState<PpSpecchioConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<null | 'salva' | 'riprova'>(null);

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    let cancelled = false;
    getSpecchioConfig()
      .then((s) => { if (!cancelled) setStato(s); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const salva = async (patch: Parameters<typeof setSpecchioConfig>[0]) => {
    if (!stato || busy) return;
    setBusy('salva');
    try {
      await setSpecchioConfig(patch);
      setStato(await getSpecchioConfig());
      showToastRef.current(t('pp.saved'), 'success');
    } catch (err: any) {
      showToastRef.current(err?.message || t('pp.saveFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const riprova = async () => {
    if (busy) return;
    setBusy('riprova');
    try {
      const r = await riprovaSpecchio();
      showToastRef.current(t('pp.specchioRetried', { count: r.rimessi }), 'success');
      setStato(await getSpecchioConfig());
    } catch (err: any) {
      showToastRef.current(err?.message || t('pp.saveFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const tavoliDellaSala = useMemo(
    () => stato?.pianta.find((s) => s.sala === stato.sala)?.tavoli ?? [],
    [stato],
  );
  const acceso = stato?.mode === 'statistiche';
  const pronto = !!stato?.sala && !!stato?.tavolo && !!stato?.tipo_pagamento;

  return (
    <SchedaPassepartout
      icon={ReceiptText}
      title={t('pp.specchioTitle')}
      subtitle={t('pp.specchioSubtitle')}
      badge={acceso ? t('pp.on') : null}
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
          {!stato.tipo_pagamento && <Callout tone="pending">{t('pp.qrNeedType')}</Callout>}

          <Field label={t('pp.specchioTable')} hint={t('pp.specchioTableHint')}>
            <div className="flex flex-wrap gap-2">
              <select
                aria-label={t('pp.specchioRoom')}
                className={dsSelect}
                value={stato.sala ?? ''}
                disabled={busy != null || stato.pianta.length === 0}
                onChange={(e) => salva({ sala: e.target.value || null, tavolo: null })}
              >
                <option value="">{t('pp.specchioRoom')}</option>
                {stato.pianta.map((s) => <option key={s.sala} value={s.sala}>{s.sala}</option>)}
              </select>
              <select
                aria-label={t('pp.specchioTableShort')}
                className={dsSelect}
                value={stato.tavolo ?? ''}
                disabled={busy != null || !stato.sala}
                onChange={(e) => salva({ tavolo: e.target.value || null })}
              >
                <option value="">{t('pp.specchioTableShort')}</option>
                {tavoliDellaSala.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </Field>
          {stato.pianta.length === 0 && (
            <p className="text-[13px] text-[var(--ds-text-muted)]">{t('pp.specchioNoPlant')}</p>
          )}

          <Field label={t('pp.specchioGeneric')} hint={t('pp.specchioGenericHint')}>
            <select
              aria-label={t('pp.specchioGeneric')}
              className={dsSelect}
              value={stato.articolo_generico_id ?? ''}
              disabled={busy != null}
              onChange={(e) => salva({ articolo_generico_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">{t('pp.specchioGenericNone')}</option>
              {stato.piatti.map((p) => <option key={p.pp_id} value={p.pp_id}>{p.name}</option>)}
            </select>
          </Field>

          <Field
            label={t('pp.specchioSend')}
            hint={stato.tipo_pagamento ? t('pp.specchioHint', { tipo: stato.tipo_pagamento }) : t('pp.specchioHintNoType')}
            aside={
              <InterruttorePassepartout
                checked={acceso}
                label={t('pp.specchioSend')}
                disabled={busy != null || (!acceso && !pronto)}
                onToggle={() => salva({ mode: acceso ? 'off' : 'statistiche' })}
              />
            }
          >
            {null}
          </Field>

          {acceso && (
            <div className="space-y-2">
              <span className="block text-[14px] text-[var(--ds-text-primary)]">
                {t('pp.specchioToday', { count: stato.stato.confermati_oggi })}
                {stato.stato.in_coda > 0 ? ` · ${t('pp.specchioQueued', { count: stato.stato.in_coda })}` : ''}
              </span>
              {stato.stato.falliti > 0 && (
                <Callout tone="critical">
                  <div className="space-y-2">
                    <p>{t('pp.specchioFailed', { count: stato.stato.falliti })}</p>
                    {stato.falliti.slice(0, 3).map((f) => (
                      <p key={f.table_bill_id} className="text-[13px]">#{f.table_bill_id}: {f.error}</p>
                    ))}
                    <button type="button" className={dsButton.secondary} onClick={riprova} disabled={busy != null}>
                      {busy === 'riprova' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
                      {t('pp.specchioRetry')}
                    </button>
                  </div>
                </Callout>
              )}
            </div>
          )}
        </>
      )}
    </SchedaPassepartout>
  );
};
