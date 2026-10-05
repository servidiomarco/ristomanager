import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Battery, Copy, Radio, RefreshCw } from 'lucide-react';
import { haccpApiService, HaccpPoint, HaccpSensor } from '../../services/haccpApiService';
import { HACCP_DEFAULT_LIMITS } from '../../utils/haccp';
import { Callout, StatusPill, dsButton, dsInput, dsSelect } from '../ds';
import { Card, CardHeader, emptyNote, formatNumber, formatShortDate, formatTime, quietIconButton, rowList, todayISO } from './haccpUi';

/* I sensori wireless: il gateway del produttore manda le letture a un
   indirizzo del locale, con un token. Un sensore mai visto compare qui da
   solo, non assegnato; assegnato a una postazione, compila la rilevazione
   della fascia e apre la non conformità sull'escursione lunga. Il token sta
   solo qui: chi lo vede può scrivere temperature nel registro. */

const lastSeen = (iso: string | null): string => {
  if (!iso) return '';
  const day = iso.slice(0, 10);
  const time = formatTime(iso);
  return day === todayISO() ? time : `${formatShortDate(day)} ${time}`;
};

export const HaccpSensorsCard: React.FC<{ points: HaccpPoint[]; refreshKey: number }> = ({ points, refreshKey }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [sensors, setSensors] = useState<HaccpSensor[] | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [offlineMinutes, setOfflineMinutes] = useState(HACCP_DEFAULT_LIMITS.sensors.offlineMinutes);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [copied, setCopied] = useState<'url' | 'token' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await haccpApiService.getSensors();
      setSensors(r.sensors);
      setToken(r.token);
      setError(null);
    } catch (e: any) {
      setError(e?.message || t('err.load', 'Errore nel caricamento'));
    }
  }, [t]);
  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    haccpApiService.getSettings()
      .then(s => { if (typeof s.limits?.sensors?.offlineMinutes === 'number') setOfflineMinutes(s.limits.sensors.offlineMinutes); })
      .catch(() => { /* resta il valore di riferimento */ });
  }, [refreshKey]);

  const regenerate = async () => {
    try {
      const r = await haccpApiService.regenerateSensorToken();
      setToken(r.token);
      setConfirmRegenerate(false);
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
    }
  };

  const copy = (what: 'url' | 'token', text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(c => (c === what ? null : c)), 2000);
    }).catch(() => { /* niente appunti: il testo resta selezionabile */ });
  };

  const update = async (s: HaccpSensor, input: { pointId?: number | null; label?: string | null; active?: boolean }) => {
    setSensors(prev => prev && prev.map(x => (x.id === s.id ? { ...x, ...input } : x)));
    try {
      await haccpApiService.updateSensor(s.id, input);
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
      load();
    }
  };

  const temperaturePoints = points.filter(p => p.register === 'TEMPERATURE' && p.active);
  const url = haccpApiService.sensorIngestUrl();
  const offlineSince = Date.now() - offlineMinutes * 60_000;

  return (
    <Card>
      <CardHeader title={t('sensors.title', 'Sensori di temperatura')} icon={<Radio className="h-4 w-4" />} />
      {error && <div className="mb-3"><Callout tone="critical" icon={AlertTriangle}>{error}</Callout></div>}
      {!token ? (
        <div className="space-y-3 py-2">
          <p className="text-[14px] text-[var(--ds-text-muted)]">
            {t('sensors.intro', 'Con i sensori wireless le temperature si scrivono da sole. Serve un indirizzo da dare al gateway dei sensori.')}
          </p>
          <button type="button" className={dsButton.secondary} onClick={regenerate}>
            {t('sensors.create', 'Crea l\'indirizzo')}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label htmlFor="haccp-sensor-url" className="mb-1.5 block text-[13px] text-[var(--ds-text-muted)]">{t('sensors.url', 'Indirizzo del gateway')}</label>
            <div className="flex items-center gap-2">
              <input id="haccp-sensor-url" readOnly value={url} onFocus={e => e.currentTarget.select()} className={`${dsInput} font-mono text-[13px]`} />
              <button type="button" className={quietIconButton} onClick={() => copy('url', url)} aria-label={t('sensors.copyUrl', 'Copia l\'indirizzo')}>
                <Copy className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div>
            <label htmlFor="haccp-sensor-token" className="mb-1.5 block text-[13px] text-[var(--ds-text-muted)]">{t('sensors.token', 'Token (intestazione X-Haccp-Sensor-Token)')}</label>
            <div className="flex items-center gap-2">
              <input id="haccp-sensor-token" readOnly value={token} onFocus={e => e.currentTarget.select()} className={`${dsInput} font-mono text-[13px]`} />
              <button type="button" className={quietIconButton} onClick={() => copy('token', token)} aria-label={t('sensors.copyToken', 'Copia il token')}>
                <Copy className="h-4 w-4" />
              </button>
            </div>
          </div>
          {copied && <p className="text-[13px] text-[var(--ds-seated-text)]" role="status">{t('sensors.copied', 'Copiato')}</p>}
          <details className="text-[14px] text-[var(--ds-text-secondary)]">
            <summary className="flex h-11 cursor-pointer items-center text-[var(--ds-text-muted)]">{t('sensors.formats', 'Formati accettati')}</summary>
            <div className="space-y-2 pb-2">
              <p>{t('sensors.formatGeneric', 'JSON con una lettura o un elenco: valore in °C, ora facoltativa.')}</p>
              <pre className="overflow-x-auto rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3 font-mono text-[12px] leading-relaxed">{'{ "readings": [ { "sensor": "cella-01", "value": 3.2, "at": "2026-10-05T09:00:00Z", "battery": 90 } ] }'}</pre>
              <p>{t('sensors.formatMonnit', 'Il webhook dei gateway Monnit (iMonnit) si incolla così com\'è. Se il gateway non manda intestazioni, il token va in fondo all\'indirizzo: ?token=…')}</p>
            </div>
          </details>
          {confirmRegenerate ? (
            <Callout
              tone="pending"
              icon={AlertTriangle}
              action={
                <div className="flex gap-2">
                  <button type="button" className={`${dsButton.quiet} h-9 px-3 text-[14px]`} onClick={() => setConfirmRegenerate(false)}>{t('cancel', 'Annulla')}</button>
                  <button type="button" className={`${dsButton.primary} h-9 px-3 text-[14px]`} onClick={regenerate}>{t('sensors.regenerate', 'Rigenera')}</button>
                </div>
              }
            >
              {t('sensors.regenerateWarn', 'Il gateway col token vecchio smette di scrivere finché non lo aggiorni.')}
            </Callout>
          ) : (
            <button type="button" className={`${dsButton.quiet} h-9 px-3 text-[14px]`} onClick={() => setConfirmRegenerate(true)}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              {t('sensors.regenerateToken', 'Rigenera il token')}
            </button>
          )}
        </div>
      )}

      {token && sensors !== null && (
        sensors.length === 0 ? (
          <p className={`${emptyNote} mt-2 border-t border-[var(--ds-border)]`}>{t('sensors.none', 'Nessun sensore ancora: compaiono qui alla prima lettura.')}</p>
        ) : (
          <ul className={`${rowList} mt-3 border-t border-[var(--ds-border)]`}>
            {sensors.map(s => {
              const offline = s.active && (!s.lastSeenAt || new Date(s.lastSeenAt).getTime() < offlineSince);
              return (
                <li key={s.id} className="grid grid-cols-12 items-center gap-2 py-3">
                  <div className="col-span-12 min-w-0 sm:col-span-5">
                    <input
                      defaultValue={s.label ?? ''}
                      placeholder={s.externalId}
                      aria-label={t('sensors.name', 'Nome del sensore {{id}}', { id: s.externalId })}
                      onBlur={e => {
                        const v = e.target.value.trim();
                        if (v !== (s.label ?? '')) update(s, { label: v || null });
                      }}
                      className={dsInput}
                    />
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                      <span className="font-mono">{s.externalId}</span>
                      {s.lastValue !== null && <span>· {formatNumber(s.lastValue)} °C {lastSeen(s.lastSeenAt)}</span>}
                      {s.battery !== null && (
                        <span className={`inline-flex items-center gap-1 ${s.battery <= 20 ? 'text-[var(--ds-pending-text)]' : ''}`}>
                          · <Battery className="h-3.5 w-3.5" aria-hidden /> {s.battery}%
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="col-span-8 sm:col-span-4">
                    <select
                      value={s.pointId ?? ''}
                      onChange={e => update(s, { pointId: e.target.value ? Number(e.target.value) : null })}
                      aria-label={t('sensors.point', 'Postazione di {{nome}}', { nome: s.label || s.externalId })}
                      className={dsSelect}
                    >
                      <option value="">{t('sensors.unassigned', 'Non assegnato')}</option>
                      {temperaturePoints.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                  </div>
                  <div className="col-span-4 flex flex-col items-end gap-1 sm:col-span-3">
                    {!s.active ? (
                      <StatusPill>{t('sensors.paused', 'In pausa')}</StatusPill>
                    ) : s.pointId === null ? (
                      <StatusPill tone="pending">{t('sensors.toAssign', 'Da assegnare')}</StatusPill>
                    ) : offline ? (
                      <StatusPill tone="critical">{t('sensors.offline', 'Senza segnale')}</StatusPill>
                    ) : s.outSince ? (
                      <StatusPill tone="critical">{t('sensors.out', 'Fuori soglia')}</StatusPill>
                    ) : (
                      <StatusPill tone="positive">{t('sensors.ok', 'Attivo')}</StatusPill>
                    )}
                    <button
                      type="button"
                      className="h-9 text-[13px] text-[var(--ds-text-muted)] underline-offset-2 hover:text-[var(--ds-text-primary)] hover:underline"
                      onClick={() => update(s, { active: !s.active })}
                    >
                      {s.active ? t('sensors.pause', 'Metti in pausa') : t('sensors.resume', 'Riattiva')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )
      )}
    </Card>
  );
};
