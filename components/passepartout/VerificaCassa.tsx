import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, ClipboardCheck, Copy, Info, XCircle } from 'lucide-react';
import { Field, dsButton, dsSelect } from '../ds';
import { formatDateTime } from '../../utils/formatLocale';
import { sessionTimeZone } from '../../utils/displayTime';
import {
  confermaPagamentoElettronico, eseguiVerificaCassa, getPpTavoli, getVerificaCassa, provaPrenotazioneInCassa,
  type EsitoVerifica, type PpTavolo, type PpVerifica, type VoceVerifica,
} from '../../services/passepartoutApiService';
import { CAPACITA } from './CollegamentoCassa';
import { SchedaPassepartout } from './SchedaPassepartout';

/* ===========================================================================
   Impostazioni → Passepartout → Verifica della cassa.

   Quello che prima si controllava a mano dal PC, con script, per attivare
   la cassa di un ristorante: PC collegato, cassa raggiungibile e versione,
   tipo di pagamento dedicato, tavoli, menu, lettura delle comande. Ogni voce
   dice cosa sistemare. In più la prova di scrittura a locale chiuso (una
   prenotazione di prova, annullata subito) e la lista di cosa chiedere al
   rivenditore della cassa.
   ========================================================================= */

interface Props {
  showToast: (message: string, type?: 'success' | 'error') => void;
}

const ICONA: Record<EsitoVerifica, { icon: React.ComponentType<{ className?: string }>; color: string }> = {
  ok: { icon: CheckCircle2, color: 'text-[var(--ds-seated-text)]' },
  attenzione: { icon: AlertTriangle, color: 'text-[var(--ds-pending-text)]' },
  errore: { icon: XCircle, color: 'text-[var(--ds-critical-text)]' },
  info: { icon: Info, color: 'text-[var(--ds-arriving-text)]' },
};

const quando = (iso: string) =>
  formatDateTime(iso, { timeZone: sessionTimeZone(), day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export const VerificaCassa: React.FC<Props> = ({ showToast }) => {
  const { t, i18n } = useTranslation('impostazioni', { useSuspense: false });
  const [stato, setStato] = useState<PpVerifica | null>(null);
  const [tavoli, setTavoli] = useState<PpTavolo[]>([]);
  const [tavoloProva, setTavoloProva] = useState<number | ''>('');
  const [provaArmata, setProvaArmata] = useState(false);
  const [busy, setBusy] = useState<'verifica' | 'conferma' | 'prova' | null>(null);

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    let cancelled = false;
    getVerificaCassa().then((s) => { if (!cancelled) setStato(s); }).catch(() => {});
    // Solo i tavoli abbinati e confermati: la prova scrive su quello.
    getPpTavoli()
      .then((r) => { if (!cancelled) setTavoli(r.tavoli.filter((x) => x.confermato && x.pp_tavolo)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const verifica = async () => {
    if (busy) return;
    setBusy('verifica');
    try {
      const r = await eseguiVerificaCassa();
      setStato((s) => ({ ...s, ...r }));
    } catch (err: any) {
      showToastRef.current(err?.message || t('pp.saveFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const conferma = async () => {
    if (busy) return;
    setBusy('conferma');
    try {
      await confermaPagamentoElettronico(true);
      setStato((s) => (s ? { ...s, elettronico_confermato: true } : s));
      setBusy(null);
      await verifica();
    } catch (err: any) {
      showToastRef.current(err?.message || t('pp.saveFailed'), 'error');
      setBusy(null);
    }
  };

  // Doppio tocco: la prova scrive davvero nel planning della cassa.
  const prova = async () => {
    if (busy || tavoloProva === '') return;
    if (!provaArmata) { setProvaArmata(true); return; }
    setBusy('prova');
    setProvaArmata(false);
    try {
      await provaPrenotazioneInCassa(tavoloProva);
      showToastRef.current(t('pp.verifica.provaOk'), 'success');
    } catch (err: any) {
      showToastRef.current(err?.message || t('pp.saveFailed'), 'error');
    } finally {
      setBusy(null);
      getVerificaCassa().then((s) => setStato((p) => ({ ...p, ...s }))).catch(() => {});
    }
  };

  const copia = async (testo: string) => {
    try {
      await navigator.clipboard.writeText(testo);
      showToastRef.current(t('pp.verifica.copiato'), 'success');
    } catch { /* appunti non disponibili: il testo resta selezionabile */ }
  };

  /** Testo e «cosa fare» di una voce: pp.verifica.<voce>.<motivo|esito>. */
  const testi = (v: VoceVerifica) => {
    const chiave = `pp.verifica.${v.voce}.${v.dati?.motivo ?? v.esito}`;
    const dati = {
      ...v.dati,
      versione: v.dati?.versione ?? '—',
      pc: v.dati?.pc ?? '—',
      categoria: v.dati?.categoria ?? '—',
      mancano: (v.dati?.mancano ?? []).map((c: string) => (CAPACITA[c] ? t(CAPACITA[c]) : c)).join(', '),
    };
    return {
      testo: t(chiave, dati),
      fare: i18n.exists(`impostazioni:${chiave}Fix`) ? t(`${chiave}Fix`, dati) : null,
    };
  };

  const voci = stato?.voci ?? null;
  const tuttoOk = !!voci && voci.every((v) => v.esito === 'ok' || v.esito === 'info');
  const pagamentoDaConfermare = voci?.some((v) => v.voce === 'pagamento' && v.dati?.motivo === 'da_confermare');
  const checklist = t('pp.verifica.rivenditoreTesto');

  return (
    <SchedaPassepartout
      icon={ClipboardCheck}
      title={t('pp.verifica.title')}
      subtitle={t('pp.verifica.subtitle')}
      badge={tuttoOk ? t('pp.verifica.badgeOk') : null}
      busy={busy != null}
    >
      <div className="space-y-3">
        {voci ? (
          <ul className="space-y-2.5">
            {voci.map((v) => {
              const { icon: Icon, color } = ICONA[v.esito];
              const { testo, fare } = testi(v);
              return (
                <li key={v.voce} className="flex items-start gap-2.5">
                  <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${color}`} aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-[14px] text-[var(--ds-text-primary)]">{testo}</span>
                    {fare && <span className="block text-[13px] text-[var(--ds-text-muted)]">{fare}</span>}
                    {v.voce === 'pagamento' && pagamentoDaConfermare && (
                      <button type="button" className={`${dsButton.secondary} mt-2`} onClick={conferma} disabled={busy != null}>
                        {t('pp.verifica.confermaElettronico')}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[13px] text-[var(--ds-text-muted)]">{t('pp.verifica.mai')}</p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={dsButton.primary} onClick={verifica} disabled={busy != null}>
            {t(voci ? 'pp.verifica.ripeti' : 'pp.verifica.esegui')}
          </button>
          {stato?.eseguita_at && (
            <span className="text-[13px] text-[var(--ds-text-muted)]">{t('pp.verifica.eseguita', { when: quando(stato.eseguita_at) })}</span>
          )}
        </div>
      </div>

      {/* Prova di scrittura: scrive davvero in cassa, perciò a locale
          chiuso e con doppio tocco. */}
      <div className="space-y-2 border-t border-[var(--ds-border)] pt-4">
        <p className="text-[14px] font-semibold text-[var(--ds-text-primary)]">{t('pp.verifica.provaTitle')}</p>
        <p className="text-[13px] text-[var(--ds-text-muted)]">{t('pp.verifica.provaHint')}</p>
        {tavoli.length === 0 ? (
          <p className="text-[13px] text-[var(--ds-text-muted)]">{t('pp.verifica.provaNoTables')}</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('pp.verifica.provaTable')} htmlFor="pp-prova-tavolo" className="min-w-[180px] flex-1">
              <select
                id="pp-prova-tavolo"
                className={dsSelect}
                value={tavoloProva}
                disabled={busy != null}
                onChange={(e) => { setTavoloProva(e.target.value ? Number(e.target.value) : ''); setProvaArmata(false); }}
              >
                <option value="">—</option>
                {tavoli.map((x) => (
                  <option key={x.table_id} value={x.table_id}>{`${x.table_name} → ${x.pp_sala} ${x.pp_tavolo}`}</option>
                ))}
              </select>
            </Field>
            <button type="button" className={dsButton.secondary} onClick={prova} disabled={busy != null || tavoloProva === ''}>
              {t(provaArmata ? 'pp.verifica.provaConfirm' : 'pp.verifica.provaSend')}
            </button>
          </div>
        )}
        {stato?.prova && (
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            {stato.prova.esito === 'ok'
              ? t('pp.verifica.provaLastOk', { when: quando(stato.prova.at) })
              : t('pp.verifica.provaLastKo', { when: quando(stato.prova.at), errore: stato.prova.esito })}
          </p>
        )}
      </div>

      {/* Da girare al rivenditore della cassa prima dell'installazione. */}
      <div className="space-y-2 border-t border-[var(--ds-border)] pt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[14px] font-semibold text-[var(--ds-text-primary)]">{t('pp.verifica.rivenditoreTitle')}</p>
          <button type="button" className={dsButton.quiet} onClick={() => copia(checklist)} aria-label={t('pp.verifica.copia')}>
            <Copy className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <p className="whitespace-pre-line text-[13px] text-[var(--ds-text-secondary)]">{checklist}</p>
      </div>
    </SchedaPassepartout>
  );
};
