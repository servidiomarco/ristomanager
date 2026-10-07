import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { FormCard, SegmentedControl, StatusPill, dsButton } from './ds';
import {
  adminListAgentReleases, adminPromoteAgentRelease, adminSetAgentChannel, adminWithdrawAgentRelease,
  type AdminAgentReleases,
} from '../services/apiService';
import { relativeTime } from '../utils/relativeTime';
import type { ApiError } from '../services/apiError';

/* ============================================
   PANNELLO PIATTAFORMA — Agente della cassa
   ============================================
   I pacchetti dell'agente della cassa Passepartout che la CI carica a ogni
   merge (canale pilota), da promuovere a stabile quando il pilota ha
   girato bene; ripromuovere un rilascio vecchio è il modo di tornare
   indietro. Sotto, i ristoranti con la cassa: chi fa da pilota e che
   versione gira sul loro PC adesso. */

type ShowToast = (message: string, type?: 'success' | 'error' | 'info') => void;

export const PlatformAgentReleases: React.FC<{ showToast: ShowToast }> = ({ showToast }) => {
  const { t } = useTranslation('piattaforma', { useSuspense: false });
  const [dati, setDati] = useState<AdminAgentReleases | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Doppio tocco sul ritiro: il pilota torna al rilascio precedente.
  const [ritiroArmato, setRitiroArmato] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDati(await adminListAgentReleases());
    } catch (err) {
      // Backend più vecchio del pannello: la sezione semplicemente non c'è.
      if ((err as ApiError).status === 404) setDati({ rilasci: [], ristoranti: [] });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const azione = async (chiave: string, fn: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(chiave);
    try {
      await fn();
      showToast(ok, 'success');
      await load();
    } catch (err) {
      showToast((err as ApiError).message || t('errSave', 'Salvataggio non riuscito'), 'error');
    } finally {
      setBusy(null);
      setRitiroArmato(null);
    }
  };

  if (!dati) return null;

  return (
    <FormCard
      title={t('agentReleases.title', 'Agente della cassa')}
      aside={
        <button type="button" className={dsButton.quiet} onClick={load} aria-label={t('retry', 'Riprova')}>
          <RefreshCw className="h-4 w-4" aria-hidden />
        </button>
      }
    >
      {dati.rilasci.length === 0 ? (
        <p className="text-[14px] text-[var(--ds-text-muted)]">{t('agentReleases.empty', 'Nessun rilascio: la CI li carica a ogni merge su main.')}</p>
      ) : (
        <div className="divide-y divide-[var(--ds-border)]">
          {dati.rilasci.map(r => (
            <div key={r.sha} className="flex flex-wrap items-center gap-2 py-2.5">
              <span className="font-mono text-[14px] text-[var(--ds-text-primary)]">{r.sha}</span>
              {r.stabile_in_uso
                ? <StatusPill tone="positive">{t('agentReleases.stableNow', 'stabile in uso')}</StatusPill>
                : <StatusPill tone={r.canale === 'stabile' ? 'neutral' : 'pending'}>{r.canale}</StatusPill>}
              <span className="text-[13px] text-[var(--ds-text-muted)]">
                {relativeTime(r.created_at, t)} · {Math.round(r.dimensione / 1024)} KB
              </span>
              <span className="ml-auto flex gap-2">
                {!r.stabile_in_uso && (
                  <button
                    type="button"
                    className={dsButton.secondary}
                    disabled={busy != null}
                    onClick={() => azione(`p:${r.sha}`, () => adminPromoteAgentRelease(r.sha), t('agentReleases.promoted', 'Promosso a stabile'))}
                  >
                    {t('agentReleases.promote', 'Promuovi a stabile')}
                  </button>
                )}
                {!r.stabile_in_uso && (
                  <button
                    type="button"
                    className={dsButton.quiet}
                    disabled={busy != null}
                    onClick={() => (ritiroArmato === r.sha
                      ? azione(`r:${r.sha}`, () => adminWithdrawAgentRelease(r.sha), t('agentReleases.withdrawn', 'Rilascio ritirato'))
                      : setRitiroArmato(r.sha))}
                  >
                    {t(ritiroArmato === r.sha ? 'agentReleases.withdrawConfirm' : 'agentReleases.withdraw', ritiroArmato === r.sha ? 'Tocca di nuovo' : 'Ritira')}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {dati.ristoranti.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">{t('agentReleases.restaurants', 'Ristoranti con la cassa')}</p>
          {dati.ristoranti.map(x => (
            <div key={x.id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-[14px] text-[var(--ds-text-primary)]">
                {x.name}
                <span className="ml-2 text-[13px] text-[var(--ds-text-muted)]">
                  {x.collegato
                    ? t('agentReleases.running', 'agente {{v}}', { v: x.versione_agente ?? '—' })
                    : t('agentReleases.offline', 'PC non collegato')}
                </span>
              </span>
              <SegmentedControl<'pilota' | 'stabile'>
                value={x.canale}
                onChange={next => azione(`c:${x.id}`, () => adminSetAgentChannel(x.id, next), t('agentReleases.channelSaved', 'Canale salvato'))}
                ariaLabel={t('agentReleases.channelAria', 'Canale degli aggiornamenti di {{name}}', { name: x.name })}
                options={[
                  { value: 'stabile', label: t('agentReleases.stable', 'Stabile') },
                  { value: 'pilota', label: t('agentReleases.pilot', 'Pilota') },
                ]}
                equalWidth={false}
                size="sm"
              />
            </div>
          ))}
        </div>
      )}
    </FormCard>
  );
};

export default PlatformAgentReleases;
