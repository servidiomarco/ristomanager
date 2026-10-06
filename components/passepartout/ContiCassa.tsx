import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, ReceiptText, RefreshCw } from 'lucide-react';
import { Callout, Field, StatusPill, dsButton } from '../ds';
import { formatDateTime } from '../../utils/formatLocale';
import { sessionTimeZone } from '../../utils/displayTime';
import { formatMoneyMinor } from '../../utils/money';
import { getPpConti, importaPpConti, setPpContiEnabled, type PpContiStato } from '../../services/passepartoutApiService';
import { InterruttorePassepartout, SchedaPassepartout } from './SchedaPassepartout';

/* ===========================================================================
   Impostazioni → Passepartout → Conti della cassa.

   Sola lettura: il CRM legge i conti chiusi in cassa ogni 10 minuti e li
   usa nei report incassi (riquadro «Chiusi solo in cassa»), nella spesa del
   cliente, nel dettaglio della prenotazione e nel riscontro della chiusura
   di cassa. Alla prima accensione recupera da solo gli ultimi 30 giorni.
   ========================================================================= */

interface Props {
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export const ContiCassa: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('impostazioni', { useSuspense: false });
  const [stato, setStato] = useState<PpContiStato | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<null | 'toggle' | 'importa'>(null);

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    let cancelled = false;
    getPpConti()
      .then((s) => { if (!cancelled) setStato(s); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const quando = (iso: string) =>
    formatDateTime(iso, { timeZone: sessionTimeZone(), day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const giorno = (d: string) => d.split('-').reverse().join('/');

  const esegui = async (chi: 'toggle' | 'importa', fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(chi);
    try {
      await fn();
    } catch (err: any) {
      showToastRef.current(err?.message || t('pp.saveFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggle = () => esegui('toggle', async () => {
    if (!stato) return;
    const r = await setPpContiEnabled(!stato.enabled);
    setStato({ ...stato, enabled: r.enabled });
    showToastRef.current(t('pp.saved'), 'success');
  });

  const importa = () => esegui('importa', async () => {
    const r = await importaPpConti();
    const conti = r.esiti.reduce((s, e) => s + e.conti, 0);
    showToastRef.current(t('pp.contiDone', { count: conti }), 'success');
    setStato(await getPpConti());
  });

  return (
    <SchedaPassepartout
      icon={ReceiptText}
      title={t('pp.contiTitle')}
      subtitle={t('pp.contiSubtitle')}
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
            label={t('pp.contiSend')}
            hint={t('pp.contiHint')}
            aside={
              <InterruttorePassepartout
                checked={stato.enabled}
                label={t('pp.contiSend')}
                disabled={busy != null}
                onToggle={toggle}
              />
            }
          >
            {null}
          </Field>

          {stato.enabled && (
            <section className="space-y-2">
              <p className="text-[14px] text-[var(--ds-text-primary)]">
                {t('pp.contiToday', { count: stato.oggi.conti, totale: formatMoneyMinor(stato.oggi.totale_cents) })}
              </p>
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                {stato.completo_fino
                  ? t('pp.contiStorico', { giorno: giorno(stato.completo_fino) })
                  : t('pp.contiStoricoInArrivo')}
                {stato.importati_at ? ` · ${t('pp.contiLast', { when: quando(stato.importati_at) })}` : ''}
              </p>
              <button
                type="button"
                className={dsButton.secondary}
                onClick={importa}
                disabled={busy != null || !stato.agente.aggiornato}
              >
                {busy === 'importa' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                {t('pp.contiImport')}
              </button>
            </section>
          )}
        </>
      )}
    </SchedaPassepartout>
  );
};
