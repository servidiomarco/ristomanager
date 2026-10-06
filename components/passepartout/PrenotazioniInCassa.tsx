import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarCheck, Loader2, RefreshCw } from 'lucide-react';
import { Callout, Field, StatusPill, dsButton, dsSelect } from '../ds';
import { formatDateTime } from '../../utils/formatLocale';
import { sessionTimeZone } from '../../utils/displayTime';
import {
  abbinaPpTavoli, getPpPrenotazioni, getPpTavoli, setPpPrenotazioniEnabled, setPpTavolo, sincronizzaPpPrenotazioni,
  type PpPrenotazioniStato, type PpTavoli, type PpTavolo,
} from '../../services/passepartoutApiService';
import { InterruttorePassepartout, SchedaPassepartout } from './SchedaPassepartout';

/* ===========================================================================
   Impostazioni → Passepartout → Prenotazioni in cassa.

   Le prenotazioni con un tavolo vanno nel planning di Passepartout (nome,
   coperti, telefono, nota); quando la cassa apre il tavolo dalla
   prenotazione, qui risulta «Arrivato». Prima dell'interruttore vanno
   abbinati i tavoli: in cassa i nomi non sono sempre gli stessi del CRM
   («80-», «24.», «3BIS»), e il nome identico nella sala giusta vale da
   solo, la somiglianza aspetta un «Conferma».
   Visibile solo con l'add-on passepartout e settings:full (lo monta App).
   ========================================================================= */

interface Props {
  showToast: (message: string, type?: 'success' | 'error') => void;
}

const opzione = (sala: string | null, tavolo: string | null) => (sala && tavolo ? JSON.stringify([sala, tavolo]) : '');
const ordinaNomi = (a: string, b: string) => a.localeCompare(b, 'it', { numeric: true, sensitivity: 'base' });

export const PrenotazioniInCassa: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('impostazioni', { useSuspense: false });
  const [stato, setStato] = useState<PpPrenotazioniStato | null>(null);
  const [tavoli, setTavoli] = useState<PpTavoli | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<null | 'toggle' | 'abbina' | 'sync' | number>(null);
  const [tutti, setTutti] = useState(false);

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  const ricarica = async () => {
    const [s, tv] = await Promise.all([getPpPrenotazioni(), getPpTavoli()]);
    setStato(s);
    setTavoli(tv);
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPpPrenotazioni(), getPpTavoli()])
      .then(([s, tv]) => { if (!cancelled) { setStato(s); setTavoli(tv); } })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const quando = (iso: string | null) => (iso
    ? formatDateTime(iso, { timeZone: sessionTimeZone(), day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '');

  const esegui = async (chi: typeof busy, fn: () => Promise<void>) => {
    if (busy != null) return;
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
    const r = await setPpPrenotazioniEnabled(!stato.enabled);
    setStato({ ...stato, enabled: r.enabled });
    showToastRef.current(t('pp.saved'), 'success');
  });

  const abbina = () => esegui('abbina', async () => {
    setTavoli(await abbinaPpTavoli());
    setStato(await getPpPrenotazioni());
  });

  const salvaTavolo = (row: PpTavolo, valore: string) => esegui(row.table_id, async () => {
    const [sala, tavolo] = valore ? (JSON.parse(valore) as [string, string]) : [null, null];
    await setPpTavolo(row.table_id, sala, tavolo);
    await ricarica();
  });

  const sincronizza = () => esegui('sync', async () => {
    const r = await sincronizzaPpPrenotazioni();
    if (r.saltato) {
      const msg = r.saltato === 'spento' ? t('pp.syncOff') : r.saltato === 'in_corso' ? t('pp.syncBusy') : t('pp.syncAgent');
      showToastRef.current(msg, 'error');
    } else if (r.errori > 0) {
      showToastRef.current(t('pp.syncErrors', { count: r.errori }), 'error');
    } else if (r.scritte + r.annullate + r.arrivi === 0) {
      showToastRef.current(t('pp.syncNothing'), 'success');
    } else {
      showToastRef.current(t('pp.syncDone', { scritte: r.scritte, annullate: r.annullate, arrivi: r.arrivi }), 'success');
    }
    await ricarica();
  });

  const righe = useMemo(() => {
    const tutte = [...(tavoli?.tavoli ?? [])].sort((a, b) =>
      ordinaNomi(a.room_name ?? '', b.room_name ?? '') || ordinaNomi(a.table_name, b.table_name));
    return tutti ? tutte : tutte.filter(r => !r.confermato);
  }, [tavoli, tutti]);

  const sale = useMemo(() => (tavoli?.pianta ?? []).map(s => ({
    sala: s.sala,
    tavoli: [...s.tavoli].sort((a, b) => ordinaNomi(a.nome, b.nome)),
  })), [tavoli]);

  const agente = stato?.agente;
  const senzaTavoli = stato != null && stato.tavoli.abbinati === 0;

  return (
    <SchedaPassepartout
      icon={CalendarCheck}
      title={t('pp.title')}
      subtitle={t('pp.subtitle')}
      badge={stato?.enabled ? t('pp.on') : null}
      busy={busy != null}
    >
      {loadError && <Callout tone="critical">{t('pp.loadFailed')}</Callout>}

      {stato && (
        <>
          <div>
            {!agente?.collegato
              ? <StatusPill tone="critical">{t('pp.agentOffline')}</StatusPill>
              : !agente.aggiornato
                ? <StatusPill tone="pending">{t('pp.agentOld')}</StatusPill>
                : <StatusPill tone="positive">{t('pp.agentOk')}</StatusPill>}
          </div>

          <Field
            label={t('pp.send')}
            hint={senzaTavoli && !stato.enabled ? t('pp.needTables') : t('pp.sendHint')}
            aside={
              <InterruttorePassepartout
                checked={stato.enabled}
                label={t('pp.send')}
                disabled={busy != null || (senzaTavoli && !stato.enabled)}
                onToggle={toggle}
              />
            }
          >
            {null}
          </Field>

          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h5 className="text-[14px] font-semibold text-[var(--ds-text-primary)]">{t('pp.tables')}</h5>
              <span className="text-[13px] text-[var(--ds-text-muted)]">
                {t('pp.tablesCount', { abbinati: stato.tavoli.abbinati, totali: stato.tavoli.totali })}
                {stato.tavoli.da_confermare > 0 && <> · {t('pp.toConfirm', { count: stato.tavoli.da_confermare })}</>}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={dsButton.secondary} onClick={abbina} disabled={busy != null || !agente?.aggiornato}>
                {busy === 'abbina' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                {t('pp.readTables')}
              </button>
              {tavoli?.pianta_at && (
                <span className="text-[13px] text-[var(--ds-text-muted)]">{t('pp.plantAt', { when: quando(tavoli.pianta_at) })}</span>
              )}
            </div>

            {!tavoli?.pianta ? (
              <p className="text-[13px] text-[var(--ds-text-muted)]">{t('pp.noPlant')}</p>
            ) : (
              <>
                {righe.length === 0 ? (
                  <p className="text-[13px] text-[var(--ds-text-muted)]">{t('pp.allMatched')}</p>
                ) : (
                  <ul className="divide-y divide-[var(--ds-border)]">
                    {righe.map(row => {
                      const proposto = !row.confermato && row.pp_sala != null;
                      // Abbinato a un tavolo che nell'ultima lettura non c'è più:
                      // senza la sua opzione la tendina mostrerebbe «Non inviare».
                      const sparito = row.pp_sala != null && !sale.some(s => s.sala === row.pp_sala && s.tavoli.some(tv => tv.nome === row.pp_tavolo));
                      return (
                        <li key={row.table_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
                          {/* Al telefono il nome sta su una riga sua e i controlli
                              sotto: affiancati, tendina e bottone lo schiacciavano. */}
                          <span className="min-w-0 basis-full text-[14px] text-[var(--ds-text-primary)] sm:flex-1">
                            <span className="font-medium">{row.room_name ? `${row.room_name} · ` : ''}{row.table_name}</span>
                            {!row.confermato && (
                              <StatusPill tone={proposto ? 'pending' : 'neutral'} className="ml-2">
                                {proposto ? t('pp.badgeConfirm') : t('pp.badgeMissing')}
                              </StatusPill>
                            )}
                          </span>
                          <div className="w-[180px] flex-none">
                            <select
                              className={dsSelect}
                              aria-label={t('pp.selectFor', { table: row.table_name })}
                              value={opzione(row.pp_sala, row.pp_tavolo)}
                              disabled={busy != null}
                              onChange={e => salvaTavolo(row, e.target.value)}
                            >
                              <option value="">{t('pp.notSent')}</option>
                              {sparito && (
                                <option value={opzione(row.pp_sala, row.pp_tavolo)}>
                                  {t('pp.notInPlant', { table: `${row.pp_sala} · ${row.pp_tavolo}` })}
                                </option>
                              )}
                              {sale.map(s => (
                                <optgroup key={s.sala} label={s.sala}>
                                  {s.tavoli.map(tv => (
                                    <option key={`${s.sala}/${tv.nome}`} value={opzione(s.sala, tv.nome)}>{`${s.sala} · ${tv.nome}`}</option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                          </div>
                          {proposto && (
                            <button
                              type="button"
                              className={dsButton.quiet}
                              disabled={busy != null}
                              onClick={() => salvaTavolo(row, opzione(row.pp_sala, row.pp_tavolo))}
                            >
                              {busy === row.table_id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : t('pp.confirm')}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <button type="button" className="text-[13px] font-medium text-[var(--ds-text-secondary)] underline-offset-2 hover:underline" onClick={() => setTutti(v => !v)}>
                  {tutti ? t('pp.showPending') : t('pp.showAll')}
                </button>
              </>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h5 className="text-[14px] font-semibold text-[var(--ds-text-primary)]">{t('pp.sending')}</h5>
              <span className="text-[13px] text-[var(--ds-text-muted)]">
                {t('pp.sendingCount', { inCassa: stato.invio.in_cassa, arrivi: stato.invio.arrivi_oggi })}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={dsButton.secondary} onClick={sincronizza} disabled={busy != null || !stato.enabled || !agente?.aggiornato}>
                {busy === 'sync' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                {t('pp.syncNow')}
              </button>
              {stato.invio.ultimo_invio && (
                <span className="text-[13px] text-[var(--ds-text-muted)]">{t('pp.lastSync', { when: quando(stato.invio.ultimo_invio) })}</span>
              )}
            </div>
            {stato.errori.length > 0 && (
              <Callout tone="critical" title={t('pp.errors')}>
                <ul className="space-y-1">
                  {stato.errori.map((e, i) => (
                    <li key={`${e.reservation_id ?? 'x'}-${i}`}>
                      {e.customer_name ? <span className="font-medium">{e.customer_name}{e.reservation_time ? ` · ${quando(e.reservation_time)}` : ''}: </span> : null}
                      {e.last_error}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
          </section>
        </>
      )}
    </SchedaPassepartout>
  );
};
