import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QrCode } from 'lucide-react';
import { Callout, Field, StatusPill } from '../ds';
import { getQrPagamentoConfig, setQrPagamentoConfig, type PpQrPagamentoConfig } from '../../services/passepartoutApiService';
import { InterruttorePassepartout, SchedaPassepartout } from './SchedaPassepartout';

/* ===========================================================================
   Impostazioni → Passepartout → Pagamento dal QR.

   Il QR del tavolo mostra «Paga il conto» anche a un tavolo battuto tutto in
   cassa: al tocco il CRM legge la comanda e ne fa il conto, l'ospite paga
   (tutto, alla romana o per piatti) e al saldo la cassa chiude il tavolo col
   tipo di pagamento esterno. Se dopo il pagamento in cassa si aggiunge
   qualcosa, il tavolo non si chiude da solo e la cassa riceve un avviso.
   ========================================================================= */

interface Props {
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export const PagaDalQr: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('impostazioni', { useSuspense: false });
  const [stato, setStato] = useState<PpQrPagamentoConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    let cancelled = false;
    getQrPagamentoConfig()
      .then((s) => { if (!cancelled) setStato(s); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const salva = async (enabled: boolean) => {
    if (!stato || busy) return;
    setBusy(true);
    try {
      await setQrPagamentoConfig({ enabled });
      setStato(await getQrPagamentoConfig());
      showToastRef.current(t('pp.saved'), 'success');
    } catch (err: any) {
      showToastRef.current(err?.message || t('pp.saveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const req = stato?.requisiti;
  // Si può sempre spegnere; accendere solo con tutto quello che serve.
  const pronto = !!req && req.conto_al_tavolo && !!req.tipo_pagamento && !req.conti_in_sala;

  return (
    <SchedaPassepartout
      icon={QrCode}
      title={t('pp.qrTitle')}
      subtitle={t('pp.qrSubtitle')}
      badge={stato?.enabled ? t('pp.on') : null}
      busy={busy}
    >
      {loadError && <Callout tone="critical">{t('pp.loadFailed')}</Callout>}
      {stato && req && (
        <>
          {!stato.agente.collegato
            ? <div><StatusPill tone="critical">{t('pp.agentOffline')}</StatusPill></div>
            : !stato.agente.aggiornato
              ? <div><StatusPill tone="pending">{t('pp.agentOld')}</StatusPill></div>
              : null}

          {!req.conto_al_tavolo && <Callout tone="pending">{t('pp.qrNeedPay')}</Callout>}
          {!req.tipo_pagamento && <Callout tone="pending">{t('pp.qrNeedType')}</Callout>}
          {req.conti_in_sala && <Callout tone="pending">{t('pp.qrNodo')}</Callout>}

          <Field
            label={t('pp.qrSend')}
            hint={req.tipo_pagamento ? t('pp.qrHint', { tipo: req.tipo_pagamento }) : t('pp.qrHintNoType')}
            aside={
              <InterruttorePassepartout
                checked={stato.enabled}
                label={t('pp.qrSend')}
                disabled={busy || (!stato.enabled && !pronto)}
                onToggle={() => salva(!stato.enabled)}
              />
            }
          >
            {null}
          </Field>

          {stato.enabled && (
            <span className="text-[14px] text-[var(--ds-text-primary)]">{t('pp.qrNow', { count: stato.aperti })}</span>
          )}
        </>
      )}
    </SchedaPassepartout>
  );
};
