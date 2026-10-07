import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Link2, PlugZap, Unlink } from 'lucide-react';
import { Callout, Field, SegmentedControl, StatusPill, dsButton, dsSelect } from '../ds';
import { formatDateTime } from '../../utils/formatLocale';
import { sessionTimeZone } from '../../utils/displayTime';
import {
  PP_SERVER_URL, creaCodiceAbbinamento, getPpConfig, getPpTipiPagamento, scollegaPcCassa, setPpConfig, type PpConfig,
} from '../../services/passepartoutApiService';
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
export const CAPACITA: Record<string, string> = {
  'chiudi-riprendi': 'pp.capRiprendi',
  prenotazioni: 'pp.capPrenotazioni',
  conti: 'pp.capConti',
  'tavoli-aperti': 'pp.capAperti',
  'chiudi-preconto': 'pp.capChiudiPreconto',
  preconto: 'pp.capPreconto',
  specchio: 'pp.capSpecchio',
  diagnosi: 'pp.capDiagnosi',
  'sconto-cassa': 'pp.capSconto',
};

const oraBreve = (iso: string) =>
  formatDateTime(iso, { timeZone: sessionTimeZone(), hour: '2-digit', minute: '2-digit' });

export const CollegamentoCassa: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('impostazioni', { useSuspense: false });
  const [config, setConfig] = useState<PpConfig | null>(null);
  const [tipi, setTipi] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  // Il codice appena generato: in chiaro solo qui, il server tiene l'hash.
  const [codice, setCodice] = useState<{ codice: string; scade_at: string } | null>(null);
  const [scollegaArmato, setScollegaArmato] = useState(false);

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

  const ricarica = async () => {
    try { setConfig(await getPpConfig()); } catch { /* resta la vista di prima */ }
  };

  const generaCodice = async () => {
    if (saving) return;
    setSaving(true);
    try {
      setCodice(await creaCodiceAbbinamento());
      setScollegaArmato(false);
    } catch (err: any) {
      showToastRef.current(err?.message || t('pp.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  // Doppio tocco: «Scollega» arma, il secondo conferma.
  const scollega = async () => {
    if (saving) return;
    if (!scollegaArmato) { setScollegaArmato(true); return; }
    setSaving(true);
    try {
      await scollegaPcCassa();
      setCodice(null);
      setScollegaArmato(false);
      await ricarica();
      showToastRef.current(t('pp.pairUnlinked'), 'success');
    } catch (err: any) {
      showToastRef.current(err?.message || t('pp.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  // PC nuovo: l'installatore (PowerShell da amministratore). Agente già
  // installato a mano: lo scambio del codice dalla sua cartella.
  const comandoInstalla = codice
    ? `$env:SYMPOTIA_CODICE='${codice.codice}'; irm ${PP_SERVER_URL}/installa/cassa.ps1 | iex`
    : '';
  const comandoAbbina = codice
    ? `node passepartout-agent.js --abbina ${codice.codice} --server ${PP_SERVER_URL}`
    : '';
  const copia = async (testo: string) => {
    try {
      await navigator.clipboard.writeText(testo);
      showToastRef.current(t('pp.pairCopied'), 'success');
    } catch { /* appunti non disponibili: il testo resta selezionabile */ }
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
                {agente.versione_agente ? ` · ${t('pp.agentVersion', { versione: agente.versione_agente })}` : ''}
              </p>
            )}
            {!agente.connected && config.abbinamento?.hostname && (
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                {t('pp.pairLast', { pc: config.abbinamento.hostname })}
              </p>
            )}
          </div>

          {/* Abbinamento del PC della cassa: un codice da 15 minuti, usato
              una volta dall'agente sul PC. Il token resta un segreto di
              macchina; abbinare un altro PC stacca quello di prima. */}
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <button type="button" className={dsButton.secondary} onClick={generaCodice} disabled={saving}>
                <Link2 className="h-4 w-4" aria-hidden /> {t(agente.connected ? 'pp.pairAnother' : 'pp.pairNew')}
              </button>
              {(agente.connected || config.abbinamento?.hostname) && (
                <button type="button" className={dsButton.secondary} onClick={scollega} disabled={saving}>
                  <Unlink className="h-4 w-4" aria-hidden /> {t(scollegaArmato ? 'pp.pairUnlinkConfirm' : 'pp.pairUnlink')}
                </button>
              )}
            </div>
            {codice && (
              <div className="rounded-[var(--ds-radius)] border border-[var(--ds-border)] p-3 space-y-2">
                <p className="text-[13px] text-[var(--ds-text-secondary)]">{t('pp.pairCodeLabel', { ora: oraBreve(codice.scade_at) })}</p>
                <p className="font-mono text-[24px] font-semibold tracking-[0.12em] text-[var(--ds-text-primary)]">{codice.codice}</p>
                {[
                  { testo: t('pp.pairInstallHowTo'), comando: comandoInstalla },
                  { testo: t('pp.pairHowTo'), comando: comandoAbbina },
                ].map(({ testo, comando }) => (
                  <div key={comando} className="space-y-1.5">
                    <p className="text-[13px] text-[var(--ds-text-secondary)]">{testo}</p>
                    <div className="flex items-start gap-2">
                      <code className="min-w-0 flex-1 break-all rounded-[var(--ds-radius-control)] bg-[var(--ds-canvas)] px-2 py-1.5 text-[12px] text-[var(--ds-text-primary)]">{comando}</code>
                      <button type="button" className={dsButton.secondary} onClick={() => copia(comando)} aria-label={t('pp.pairCopy')}>
                        <Copy className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                  </div>
                ))}
                <p className="text-[12px] text-[var(--ds-text-muted)]">{t('pp.pairReplaces')}</p>
              </div>
            )}
            {!codice && config.abbinamento?.codice_scade_at && (
              <p className="text-[13px] text-[var(--ds-text-muted)]">{t('pp.pairPending', { ora: oraBreve(config.abbinamento.codice_scade_at) })}</p>
            )}
            {config.abbinamento?.token_storico && (
              <p className="text-[12px] text-[var(--ds-text-muted)]">{t('pp.pairLegacy')}</p>
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
