import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { displayLocale } from '../utils/formatLocale';
import { Bell, BellOff, CookingPot, ChevronDown, Loader2, Monitor, Printer, Plus, Trash2, Wifi, WifiOff, Receipt } from 'lucide-react';
import { getFeatureFlags, updateFeatureFlags, FeatureFlags } from '../services/apiService';
import {
  getSalaConfig, setFireMode, createStation, updateStation,
  createPrinter, updatePrinter, deletePrinter, testPrinter,
  setCategoryStation,
  getSalaProfiles, createSalaProfile, updateSalaProfile,
  activateSalaProfile, detachSalaProfile, deleteSalaProfile,
  updatePrintRoutes, updateSalaNodeSettings, provisionSalaNodeCert,
  getSalaNodeAuthority, setSalaNodeAuthority,
  type SalaConfig, type FireMode, type SalaProfile, type SalaNodeAuthority,
} from '../services/salaApiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

// Il fire mode spiegato in italiano di sala, non in enum: chi configura è il
// gestore, e la differenza fra i tre modi decide come lavora la cucina.
const FIRE_MODE_LABELS: { value: FireMode; key: string; title: string; hint: string }[] = [
  { value: 'AUTO_ALL',   key: 'fireAll',    title: 'Tutto subito',        hint: 'Ogni uscita parte in cucina appena il cameriere invia. Senza passe.' },
  { value: 'AUTO_FIRST', key: 'fireFirst',  title: 'Prima uscita subito', hint: 'La 1ª parte da sola, le successive aspettano il lancio dal Passe.' },
  { value: 'AUTO_NEXT',  key: 'fireNext',   title: 'A consumo',           hint: 'La successiva parte da sola quando segni servita la precedente.' },
  { value: 'MANUAL',     key: 'fireManual', title: 'Tutto dal passe',     hint: 'Nessuna uscita parte da sola: le lancia tutte l\'expediter dal Passe.' },
];

export const SalaCucinaSettingsManager: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('salacucina', { useSuspense: false });
  const { hasPermission, hasFeature } = useAuth();
  const canEdit = hasPermission('settings:full');

  const [flags, setFlags] = useState<FeatureFlags | null>(null);
  const [config, setConfig] = useState<SalaConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [newStation, setNewStation] = useState('');
  const [newPrinter, setNewPrinter] = useState({ name: '', host: '', port: '9100' });
  const [profiles, setProfiles] = useState<SalaProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<string | null>(null);
  const [newProfile, setNewProfile] = useState('');
  // Bozza della config del nodo di sala: seminata UNA volta dal primo
  // /sala/config — il polling da 10s non deve sovrascrivere quello che il
  // gestore sta digitando.
  const [nodeDraft, setNodeDraft] = useState({ domain: '', lan_ip: '', port: '443' });
  const nodeDraftSeeded = useRef(false);
  const [certBusy, setCertBusy] = useState(false);
  // L'interruttore «Servizio completo sul nodo» (tappa 4): lo stato arriva
  // dalla sua route coi cancelli — la card lo mostra, non lo decide.
  const [authority, setAuthority] = useState<SalaNodeAuthority | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; });

  // Lo stato autorità si rilegge quando l'ibrido è acceso e il nodo online:
  // richiede una RPC verso il nodo, quindi non sta nel polling di
  // /sala/config — un giro ogni 15s mentre la card è aperta basta.
  useEffect(() => {
    if (!hasFeature('sala_node')) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const a = await getSalaNodeAuthority();
        if (!cancelled) setAuthority(a);
      } catch { /* senza permesso o errore: la riga resta muta */ }
    };
    void tick();
    const id = setInterval(() => void tick(), 15_000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    try {
      const [f, c, p] = await Promise.all([getFeatureFlags(), getSalaConfig(), getSalaProfiles()]);
      setFlags(f);
      setConfig(c);
      setProfiles(p.profiles);
      setActiveProfile(p.active_profile);
    } catch (err: any) {
      showToastRef.current(err?.message || t('loadError'), 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (!config || nodeDraftSeeded.current) return;
    nodeDraftSeeded.current = true;
    setNodeDraft({
      domain: config.sala_node?.domain ?? '',
      lan_ip: config.sala_node?.lan_ip ?? '',
      port: String(config.sala_node?.port ?? 443),
    });
  }, [config]);

  // Lo stato dell'agente invecchia da solo: finché il pannello è aperto lo
  // ricontrolliamo, così "online" non è mai una foto vecchia di dieci minuti.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => { getSalaConfig().then(setConfig).catch(() => {}); }, 10_000);
    return () => clearInterval(t);
  }, [open]);

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    if (saving) return;
    setSaving(true);
    try {
      await fn();
      if (okMsg) showToast(okMsg, 'success');
      await reload();
    } catch (err: any) {
      showToast(err?.message || t('actionFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !flags || !config) {
    return (
      <div className="bg-[var(--ds-surface)] rounded-[var(--ds-radius)] shadow-[var(--ds-shadow-card)] px-4 py-3 flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  const enabled = flags.table_orders_enabled === true;
  const thermal = config.printers.filter(p => p.kind === 'THERMAL');
  const fiscal = config.printers.filter(p => p.kind === 'FISCAL');

  // La mappa a DB può avere un maiuscolo diverso dalla categoria del piatto
  // (la cassa le scrive come vuole: "Primi" e "PRIMI" convivono): la lettura
  // è insensibile alle maiuscole, come l'aggancio all'invio lato server.
  const stationForCategory = (cat: string): number | '' => {
    const exact = config.category_stations[cat];
    if (exact != null) return exact;
    const hit = Object.keys(config.category_stations).find(k => k.toLowerCase() === cat.toLowerCase());
    return hit != null ? (config.category_stations[hit] ?? '') : '';
  };
  const uncovered = config.categories.filter(c => stationForCategory(c) === '');

  const toggleModule = () => act(
    async () => { setFlags(await updateFeatureFlags({ table_orders_enabled: !enabled })); },
    (!enabled ? t('moduleOnToast') : t('moduleOffToast'))
  );

  return (
    <details className="group bg-[var(--ds-surface)] rounded-[var(--ds-radius)] shadow-[var(--ds-shadow-card)] overflow-hidden"
             onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--ds-surface-row)] transition-colors">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-pending-text)] flex-shrink-0">
            <CookingPot className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">{t('cardTitle')}</h4>
            <p className="text-[13px] text-[var(--ds-text-muted)] truncate">{t('cardSubtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`text-[12px] font-medium ${enabled ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-text-subtle)]'}`}>
            {enabled ? t('statusOn') : t('statusOff')}
          </span>
          <button
            type="button" role="switch" aria-checked={enabled}
            aria-label={enabled ? t('toggleOffAria') : t('toggleOnAria')}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleModule(); }}
            disabled={!canEdit || saving}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
              enabled ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
            }`}
          >
            <span aria-hidden="true"
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
          </button>
          <ChevronDown className="w-4 h-4 text-[var(--ds-text-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
        </div>
      </summary>

      <div className="px-4 pb-4 pt-3 border-t border-[var(--ds-border)] space-y-5">
        {/* ---- Profilo di configurazione ---- */}
        <section>
          <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2">
            {t('profilesHeading')}
          </h5>
          <div className="rounded-[var(--ds-radius)] border border-[var(--ds-border)] divide-y divide-[var(--ds-border)]">
            {profiles.map(pr => {
              const isActive = activeProfile === pr.name;
              return (
                <div key={pr.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="flex-1 min-w-0 text-[13px] font-medium text-[var(--ds-text-primary)] truncate">
                    {pr.name}
                    {isActive && <span className="ml-2 text-[12px] font-semibold text-[var(--ds-seated-text)] tracking-wide">{t('profileActiveBadge')}</span>}
                  </span>
                  {isActive ? (
                    <button type="button" disabled={!canEdit || saving}
                      onClick={() => act(() => detachSalaProfile(), t('profileDetachedToast', { nome: pr.name }))}
                      className="text-[12px] px-2 py-1 rounded-[var(--ds-radius)] border border-[var(--ds-border)] disabled:opacity-50">
                      {t('detach')}
                    </button>
                  ) : (
                    <button type="button" disabled={!canEdit || saving}
                      onClick={() => act(() => activateSalaProfile(pr.id), t('profileAppliedToast', { nome: pr.name }))}
                      className="text-[12px] px-2.5 py-1 rounded-[var(--ds-radius)] bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] disabled:opacity-50">
                      {t('activate')}
                    </button>
                  )}
                  <button type="button" disabled={!canEdit || saving} title={t('profileOverwriteTitle')}
                    onClick={() => act(() => updateSalaProfile(pr.id), t('profileUpdatedToast', { nome: pr.name }))}
                    className="text-[12px] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] disabled:opacity-50">
                    {t('update')}
                  </button>
                  <button type="button" disabled={!canEdit || saving} aria-label={t('deleteProfileAria', { nome: pr.name })}
                    onClick={() => act(() => deleteSalaProfile(pr.id), t('profileDeletedToast'))}
                    className="text-[var(--ds-critical-text)] disabled:opacity-50"><Trash2 size={14} /></button>
                </div>
              );
            })}
            {canEdit && (
              <div className="flex items-center gap-2 px-3 py-2">
                <input value={newProfile} onChange={e => setNewProfile(e.target.value)}
                  placeholder={t('saveSetupPlaceholder')}
                  className="flex-1 text-[13px] rounded-[var(--ds-radius)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5" />
                <button type="button" disabled={!newProfile.trim() || saving}
                  onClick={() => act(() => createSalaProfile(newProfile.trim()), t('profileSavedToast')).then(() => setNewProfile(''))}
                  className="text-[13px] px-2.5 py-1.5 rounded-[var(--ds-radius)] border border-[var(--ds-border)] flex items-center gap-1 disabled:opacity-50">
                  <Plus size={13} /> {t('save')}
                </button>
              </div>
            )}
          </div>
          <p className="text-[12px] text-[var(--ds-text-muted)] mt-1.5">
            {t('profilesNote')}
          </p>
        </section>

        {/* ---- Lancio uscite ---- */}
        <section>
          <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2">
            {t('fireHeading')}
          </h5>
          <div className="grid sm:grid-cols-3 gap-2">
            {FIRE_MODE_LABELS.map(m => (
              <button key={m.value} type="button" disabled={!canEdit || saving}
                onClick={() => act(() => setFireMode(m.value), t('fireModeToast', { mode: t(`${m.key}Title`, m.title).toLowerCase() }))}
                className={`text-left px-3 py-2.5 rounded-[var(--ds-radius)] border text-[13px] transition-colors disabled:opacity-60 ${
                  config.fire_mode === m.value
                    ? 'border-[var(--ds-text-primary)]/50 bg-[var(--ds-surface-row)]'
                    : 'border-[var(--ds-border)] hover:bg-[var(--ds-surface-row)]'
                }`}>
                <div className="font-medium text-[var(--ds-text-primary)]">{t(`${m.key}Title`, m.title)}</div>
                <div className="text-[12px] text-[var(--ds-text-muted)] leading-snug mt-0.5">{t(`${m.key}Hint`, m.hint)}</div>
              </button>
            ))}
          </div>
        </section>

        {/* ---- Passe ---- */}
        <section>
          <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2">
            {t('passHeading')}
          </h5>
          <div className="flex items-start justify-between gap-3 rounded-[var(--ds-radius)] border border-[var(--ds-border)] px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--ds-text-primary)]">{t('passStation')}</div>
              <p className="text-[12px] text-[var(--ds-text-muted)] leading-snug mt-0.5">
                {t('passNote')}
              </p>
            </div>
            <button
              type="button" role="switch" aria-checked={flags.passe_enabled !== false}
              aria-label={flags.passe_enabled !== false ? t('passOffAria') : t('passOnAria')}
              onClick={() => act(
                async () => { setFlags(await updateFeatureFlags({ passe_enabled: flags.passe_enabled === false })); },
                (flags.passe_enabled === false ? t('passOnToast') : t('passOffToast'))
              )}
              disabled={!canEdit || saving}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50 ${
                flags.passe_enabled !== false ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
              }`}
            >
              <span aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${flags.passe_enabled !== false ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
            </button>
          </div>
        </section>

        {/* ---- Partite ---- */}
        <section>
          <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2">
            {t('stationsHeading')}
          </h5>
          <div className="rounded-[var(--ds-radius)] border border-[var(--ds-border)] divide-y divide-[var(--ds-border)]">
            {config.stations.map(s => (
              <div key={s.id} className={`flex items-center gap-3 px-3 py-2 ${s.is_active ? '' : 'opacity-50'}`}>
                <span className="flex-1 min-w-0 text-[13px] font-medium text-[var(--ds-text-primary)] truncate">{s.name}</span>
                <div className="flex items-center gap-1.5 text-[var(--ds-text-muted)]">
                  {s.printer ? <Printer size={13} /> : <Monitor size={13} />}
                  <select
                    value={s.printer ?? ''}
                    disabled={!canEdit || saving}
                    onChange={e => act(
                      () => updateStation(s.id, { printer: e.target.value || null }),
                      e.target.value ? t('stationPrinterToast', { partita: s.name, stampante: e.target.value }) : t('stationScreenOnlyToast', { partita: s.name })
                    )}
                    className="text-[13px] rounded-[var(--ds-radius)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1 disabled:opacity-60">
                    <option value="">{t('screenOnly')}</option>
                    {thermal.filter(p => p.is_active).map(p => (
                      <option key={p.id} value={p.name}>schermo + {p.name}</option>
                    ))}
                  </select>
                </div>
                {/* Partita senza monitor: la comanda esce solo dalla termica e
                    nessuno può premere «pronto» — col flag le righe partono
                    già pronte al lancio e l'uscita non resta ad aspettarle. */}
                <button
                  type="button" role="switch" aria-checked={s.auto_ready}
                  disabled={!canEdit || saving}
                  title={t('autoReadyTitle')}
                  onClick={() => act(
                    () => updateStation(s.id, { auto_ready: !s.auto_ready }),
                    s.auto_ready ? t('readyFromScreenToast', { partita: s.name }) : t('autoReadyToast', { partita: s.name })
                  )}
                  className={`text-[12px] px-2 py-0.5 rounded-[var(--ds-radius-control)] border transition-colors disabled:opacity-50 ${
                    s.auto_ready
                      ? 'border-transparent bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
                      : 'border-[var(--ds-border)] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]'
                  }`}>
                  {t('autoReady')}
                </button>
                {/* Solo con una termica: il flag riguarda la carta, a schermo
                    le altre partite ci sono già nel piede della card. */}
                {s.printer && (
                  <button
                    type="button" role="switch" aria-checked={s.full_course}
                    disabled={!canEdit || saving}
                    title={t('fullCourseTitle')}
                    onClick={() => act(
                      () => updateStation(s.id, { full_course: !s.full_course }),
                      s.full_course ? t('ownDishesOnlyToast', { partita: s.name }) : t('fullCourseToast', { partita: s.name })
                    )}
                    className={`text-[12px] px-2 py-0.5 rounded-[var(--ds-radius-control)] border transition-colors disabled:opacity-50 ${
                      s.full_course
                        ? 'border-transparent bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
                        : 'border-[var(--ds-border)] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]'
                    }`}>
                    {t('fullCourse')}
                  </button>
                )}
                <button type="button" disabled={!canEdit || saving}
                  onClick={() => act(() => updateStation(s.id, { is_active: !s.is_active }))}
                  className="text-[12px] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] disabled:opacity-50">
                  {s.is_active ? t('deactivate') : t('reactivate')}
                </button>
              </div>
            ))}
            {canEdit && (
              <div className="flex items-center gap-2 px-3 py-2">
                <input value={newStation} onChange={e => setNewStation(e.target.value)}
                  placeholder={t('newStationPlaceholder')}
                  className="flex-1 text-[13px] rounded-[var(--ds-radius)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5" />
                <button type="button" disabled={!newStation.trim() || saving}
                  onClick={() => act(() => createStation({ name: newStation.trim() }), t('stationCreatedToast')).then(() => setNewStation(''))}
                  className="text-[13px] px-2.5 py-1.5 rounded-[var(--ds-radius)] border border-[var(--ds-border)] flex items-center gap-1 disabled:opacity-50">
                  <Plus size={13} /> {t('add')}
                </button>
              </div>
            )}
          </div>
          <p className="text-[12px] text-[var(--ds-text-muted)] mt-1.5">
            {t('stationsNoteA')}
            {t('stationsNoteB')}
            {t('stationsNoteC')}
          </p>
        </section>

        {/* ---- Categorie → partite ---- */}
        <section>
          <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2">
            {t('categoriesHeading')}
          </h5>
          {/* Il buco si deve vedere qui, prima del servizio: un piatto di
              categoria scoperta parte e non compare su nessun monitor. */}
          {uncovered.length > 0 && (
            <div className="rounded-[var(--ds-radius)] bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] px-3 py-2 mb-2 text-[13px]">
              {uncovered.length === 1
                ? <>{t('uncoveredOneA')} <span className="font-semibold">{uncovered[0]}</span> {t('uncoveredOneB')}</>
                : <>{t('uncoveredMany', { n: uncovered.length, elenco: uncovered.join(', ') })}</>}
            </div>
          )}
          <div className="rounded-[var(--ds-radius)] border border-[var(--ds-border)] divide-y divide-[var(--ds-border)]">
            {config.categories.map(cat => (
              <div key={cat} className="flex items-center gap-3 px-3 py-2">
                <span className="flex-1 min-w-0 text-[13px] font-medium text-[var(--ds-text-primary)] truncate">{cat}</span>
                <select
                  value={stationForCategory(cat)}
                  disabled={!canEdit || saving}
                  onChange={e => act(
                    () => setCategoryStation(cat, e.target.value ? Number(e.target.value) : null),
                    e.target.value
                      ? `${cat} → ${config.stations.find(s => s.id === Number(e.target.value))?.name ?? t('stationFallback')}`
                      : t('categoryNoStationToast', { categoria: cat })
                  )}
                  className="text-[13px] rounded-[var(--ds-radius)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1 disabled:opacity-60">
                  <option value="">{t('noStation')}</option>
                  {config.stations.filter(s => s.is_active).map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            ))}
            {config.categories.length === 0 && (
              <p className="px-3 py-3 text-[13px] text-[var(--ds-text-muted)]">{t('noCategories')}</p>
            )}
          </div>
          <p className="text-[12px] text-[var(--ds-text-muted)] mt-1.5">
            {t('categoriesNote')}
          </p>
        </section>

        {/* ---- Stampanti ---- */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)]">
              {t('printersHeading')}
            </h5>
            <span className={`text-[12px] flex items-center gap-1.5 ${config.agent.online ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}`}>
              {config.agent.online ? <Wifi size={13} /> : <WifiOff size={13} />}
              {config.agent.online
                ? t('agentOnline')
                : config.agent.last_seen_seconds != null
                  ? `agente offline da ${config.agent.last_seen_seconds}s`
                  : t('agentNeverSeen')}
              {config.pending_jobs > 0 && ` · ${config.pending_jobs} in coda`}
              {config.failed_jobs > 0 && ` · ${config.failed_jobs} falliti`}
            </span>
          </div>
          <div className="rounded-[var(--ds-radius)] border border-[var(--ds-border)] divide-y divide-[var(--ds-border)]">
            {thermal.map(p => (
              <div key={p.id} className={`flex items-center gap-3 px-3 py-2 ${p.is_active ? '' : 'opacity-50'}`}>
                <Printer size={14} className="text-[var(--ds-text-muted)] flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium text-[var(--ds-text-primary)]">{p.name}</span>
                  <span className="text-[12px] text-[var(--ds-text-muted)] ml-2">{p.host}:{p.port}</span>
                </div>
                {/* Cicalino alla stampa: il flag arriva all'agente LAN via
                    config e antepone il beep ESC/POS a ogni job. Acceso in
                    cucina («la comanda si deve sentire»), spento al banco. */}
                <button type="button" disabled={!canEdit || saving || !p.is_active}
                  aria-pressed={p.buzzer}
                  title={p.buzzer ? t('buzzerOnTitle') : t('buzzerOffTitle')}
                  onClick={() => act(() => updatePrinter(p.id, { buzzer: !p.buzzer }))}
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-[var(--ds-radius-control)] transition-colors disabled:opacity-50 ${
                    p.buzzer
                      ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
                      : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]'
                  }`}>
                  {p.buzzer ? <Bell size={14} /> : <BellOff size={14} />}
                </button>
                <button type="button" disabled={!canEdit || saving || testingId === p.id || !p.is_active}
                  onClick={async () => {
                    setTestingId(p.id);
                    try {
                      await testPrinter(p.id);
                      showToast(t('testSentToast', { stampante: p.name }), 'success');
                    } catch (err: any) { showToast(err?.message || t('sendFailed'), 'error'); }
                    finally { setTestingId(null); }
                  }}
                  className="text-[12px] px-2 py-1 rounded-[var(--ds-radius)] border border-[var(--ds-border)] disabled:opacity-50">
                  {testingId === p.id ? t('sending') : t('testPrint')}
                </button>
                <button type="button" disabled={!canEdit || saving}
                  onClick={() => act(() => updatePrinter(p.id, { is_active: !p.is_active }))}
                  className="text-[12px] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] disabled:opacity-50">
                  {p.is_active ? t('deactivate') : t('reactivate')}
                </button>
                <button type="button" disabled={!canEdit || saving} aria-label={t('deletePrinterAria', { nome: p.name })}
                  onClick={() => act(() => deletePrinter(p.id), t('printerDeletedToast'))}
                  className="text-[var(--ds-critical-text)] disabled:opacity-50"><Trash2 size={14} /></button>
              </div>
            ))}
            {thermal.length === 0 && (
              <p className="px-3 py-3 text-[13px] text-[var(--ds-text-muted)]">{t('noPrinters')}</p>
            )}
            {canEdit && (
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <input value={newPrinter.name} onChange={e => setNewPrinter(v => ({ ...v, name: e.target.value }))}
                  placeholder={t('printerNamePlaceholder')} className="w-32 text-[13px] rounded-[var(--ds-radius)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5" />
                <input value={newPrinter.host} onChange={e => setNewPrinter(v => ({ ...v, host: e.target.value }))}
                  placeholder={t('printerIpPlaceholder')} className="w-40 text-[13px] rounded-[var(--ds-radius)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5" />
                <input value={newPrinter.port} onChange={e => setNewPrinter(v => ({ ...v, port: e.target.value }))}
                  placeholder={t('portPlaceholder')} className="w-20 text-[13px] rounded-[var(--ds-radius)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5" />
                <button type="button" disabled={!newPrinter.name.trim() || !newPrinter.host.trim() || saving}
                  onClick={() => act(
                    () => createPrinter({ name: newPrinter.name.trim(), host: newPrinter.host.trim(), port: Number(newPrinter.port) || 9100 }),
                    t('printerAddedToast')
                  ).then(() => setNewPrinter({ name: '', host: '', port: '9100' }))}
                  className="text-[13px] px-2.5 py-1.5 rounded-[var(--ds-radius)] border border-[var(--ds-border)] flex items-center gap-1 disabled:opacity-50">
                  <Plus size={13} /> {t('add')}
                </button>
              </div>
            )}
          </div>
        </section>

        {/* ---- Instradamento conto ---- */}
        <section>
          <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2">
            {t('billRoutingHeading')}
          </h5>
          <div className="rounded-[var(--ds-radius)] border border-[var(--ds-border)] divide-y divide-[var(--ds-border)]">
            {([
              { fn: 'preconto' as const, label: t('proformaLabel'), hint: t('proformaHint') },
              { fn: 'qr' as const, label: t('qrSlipLabel'), hint: t('qrSlipHint') },
            ]).map(({ fn, label, hint }) => (
              <div key={fn} className="flex items-center gap-3 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium text-[var(--ds-text-primary)]">{label}</span>
                  <span className="text-[12px] text-[var(--ds-text-muted)] ml-2">{hint}</span>
                </div>
                <div className="flex items-center gap-1.5 text-[var(--ds-text-muted)]">
                  <Printer size={13} />
                  <select
                    value={config.print_routes?.[fn] ?? 'preconti'}
                    disabled={!canEdit || saving}
                    onChange={e => act(
                      () => updatePrintRoutes({ [fn]: e.target.value === 'preconti' ? null : e.target.value }),
                      t('billRouteToast', { documento: label, stampante: e.target.value })
                    )}
                    className="text-[13px] rounded-[var(--ds-radius)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1 disabled:opacity-60">
                    {!thermal.some(pr => pr.is_active && pr.name === 'preconti') && (
                      <option value="preconti">{t('preconyDefaultOption')}</option>
                    )}
                    {thermal.filter(pr => pr.is_active).map(pr => (
                      <option key={pr.id} value={pr.name}>
                        {pr.name}{pr.name === 'preconti' ? ' (predefinita)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[12px] text-[var(--ds-text-muted)] mt-1.5">
            {t('billRoutingNote')}
          </p>
        </section>

        {/* ---- Nodo di sala (modalità ibrida) ---- */}
        {hasFeature('sala_node') && (
          <section>
            <div className="flex items-center justify-between mb-2">
              <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)]">
                {t('nodeHeading')}
              </h5>
              <span className={`text-[12px] flex items-center gap-1.5 ${config.sala_node.online ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}`}>
                {config.sala_node.online ? <Wifi size={13} /> : <WifiOff size={13} />}
                {config.sala_node.online
                  ? t('nodeOnline')
                  : config.sala_node.last_seen_seconds != null
                    ? t('nodeOffline', { secondi: config.sala_node.last_seen_seconds })
                    : t('nodeNeverSeen')}
                {config.sala_node.online && config.sala_node.clients != null && ` · ${config.sala_node.clients} dispositivi`}
              </span>
            </div>
            <div className="rounded-md border border-[var(--ds-border)] divide-y divide-[var(--ds-border)]">
              <div className="flex items-center gap-3 px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium text-[var(--ds-text-primary)]">{t('hybridMode')}</span>
                  <p className="text-[12px] text-[var(--ds-text-muted)]">
                    {t('hybridModeNote')}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={flags.sala_node_enabled === true}
                  disabled={!canEdit || saving || !config.sala_node.domain}
                  title={!config.sala_node.domain ? t('configureDomainFirst') : undefined}
                  onClick={() => act(
                    async () => { setFlags(await updateFeatureFlags({ sala_node_enabled: flags.sala_node_enabled !== true })); },
                    (flags.sala_node_enabled !== true ? t('hybridOnToast') : t('hybridOffToast'))
                  )}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                    flags.sala_node_enabled ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                      flags.sala_node_enabled ? 'translate-x-5' : 'translate-x-0.5'
                    } translate-y-0.5`}
                  />
                </button>
              </div>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium text-[var(--ds-text-primary)]">{t('fullServiceOnNode')}</span>
                  <p className="text-[12px] text-[var(--ds-text-muted)]">
                    {t('fullServiceNote')}
                  </p>
                  <p className="text-[12px] mt-0.5">
                    {!flags.sala_node_enabled ? (
                      <span className="text-[var(--ds-text-muted)]">{t('enableHybridFirst')}</span>
                    ) : authority == null ? (
                      <span className="text-[var(--ds-text-muted)]">{t('checking')}</span>
                    ) : authority.enabled ? (
                      <span className="text-[var(--ds-seated-text)]">{t('authorityOnSite')}{authority.aligned ? ' · repliche allineate' : ' · riallineamento in corso'}</span>
                    ) : !authority.node_online ? (
                      <span className="text-[var(--ds-critical-text)]">{t('nodeOfflineFrozen')}</span>
                    ) : authority.aligned ? (
                      <span className="text-[var(--ds-seated-text)]">{t('readyAligned')}</span>
                    ) : (
                      <span className="text-[var(--ds-pending-text)]">
                        repliche in ritardo di {Math.max(
                          authority.cloud_head - (authority.node_applied_cloud_seq ?? 0),
                          (authority.node_local_head ?? 0) - authority.cloud_applied_node_seq,
                        )} {t('eventsWord')}
                      </span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={authority?.enabled === true}
                  disabled={
                    !canEdit || authBusy || !flags.sala_node_enabled || authority == null
                    // Per accendere servono nodo online e repliche allineate;
                    // per spegnere basta il nodo online (il server drena).
                    || (!authority.enabled && !(authority.node_online && authority.aligned))
                    || (authority.enabled && !authority.node_online)
                  }
                  title={authority && !authority.node_online ? "{t('authorityFrozenTitle')}" : undefined}
                  onClick={async () => {
                    if (!authority) return;
                    setAuthBusy(true);
                    try {
                      const next = await setSalaNodeAuthority(!authority.enabled);
                      setAuthority(next);
                      showToast(next.enabled ? t('authorityToNodeToast') : t('authorityToCloudToast'), 'success');
                    } catch (err: any) {
                      showToast(err?.message || t('actionFailed'), 'error');
                      try { setAuthority(await getSalaNodeAuthority()); } catch { /* la prossima lettura periodica sistema */ }
                    } finally {
                      setAuthBusy(false);
                    }
                  }}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                    authority?.enabled ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                      authority?.enabled ? 'translate-x-5' : 'translate-x-0.5'
                    } translate-y-0.5`}
                  />
                </button>
              </div>
              <div className="flex items-center gap-3 px-3 py-2">
                <div className="flex-1 min-w-0 text-[13px]">
                  <span className="font-medium text-[var(--ds-text-primary)]">{t('tlsCertificate')}</span>
                  <span className="text-[12px] text-[var(--ds-text-muted)] ml-2">
                    {config.sala_node.cert_expires_at
                      ? t('certExpires', { data: new Date(config.sala_node.cert_expires_at).toLocaleDateString(displayLocale()) })
                      : t('certNotIssued')}
                  </span>
                </div>
                {canEdit && (
                  <button type="button" disabled={saving || certBusy || !config.sala_node.domain}
                    title={!config.sala_node.domain ? t('configureDomainFirst') : undefined}
                    onClick={async () => {
                      setCertBusy(true);
                      try {
                        const r = await provisionSalaNodeCert();
                        showToast(t('certIssuedToast', { dominio: r.domain }), 'success');
                        await reload();
                      } catch (err: any) {
                        showToast(err?.message || t('certIssueFailed'), 'error');
                      } finally { setCertBusy(false); }
                    }}
                    className="text-[12px] px-2 py-1 rounded-md border border-[var(--ds-border)] disabled:opacity-50">
                    {certBusy ? t('certIssuing') : config.sala_node.cert_expires_at ? t('renew') : t('issueCert')}
                  </button>
                )}
              </div>
              {canEdit && (
                <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <input value={nodeDraft.domain} onChange={e => setNodeDraft(v => ({ ...v, domain: e.target.value }))}
                    placeholder={t('nodeDomainPlaceholder')} className="w-72 text-[13px] rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5" />
                  <input value={nodeDraft.lan_ip} onChange={e => setNodeDraft(v => ({ ...v, lan_ip: e.target.value }))}
                    placeholder={t('nodeLanIpPlaceholder')} className="w-40 text-[13px] rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5" />
                  <input value={nodeDraft.port} onChange={e => setNodeDraft(v => ({ ...v, port: e.target.value }))}
                    placeholder="porta" className="w-20 text-[13px] rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5" />
                  <button type="button" disabled={saving}
                    onClick={() => act(
                      () => updateSalaNodeSettings({
                        domain: nodeDraft.domain.trim() || null,
                        lan_ip: nodeDraft.lan_ip.trim() || null,
                        port: Number(nodeDraft.port) || 443,
                      }),
                      t('nodeConfigSavedToast')
                    )}
                    className="text-[13px] px-2.5 py-1.5 rounded-md border border-[var(--ds-border)] disabled:opacity-50">
                    {t('save')}
                  </button>
                </div>
              )}
            </div>
            <p className="text-[12px] text-[var(--ds-text-muted)] mt-1.5">
              {t('nodeNote')}
            </p>
          </section>
        )}

        {/* ---- Fiscale (Fase 2) ---- */}
        <section>
          <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2">
            {t('fiscalHeading')}
          </h5>
          <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] border border-[var(--ds-border)] px-3 py-2.5 flex items-start gap-2.5">
            <Receipt size={15} className="mt-0.5 text-[var(--ds-text-muted)] flex-shrink-0" />
            <div className="text-[13px]">
              {fiscal.length > 0 ? (
                <div className="text-[var(--ds-text-primary)]">
                  {fiscal.map(p => <div key={p.id}><strong>{p.name}</strong> · {p.host}:{p.port}{p.notes ? ` — ${p.notes}` : ''}</div>)}
                </div>
              ) : (
                <div className="text-[var(--ds-text-primary)]">{t('noFiscalDevice')}</div>
              )}
              <p className="text-[12px] text-[var(--ds-text-muted)] mt-1">
                {t('fiscalNote')}
              </p>
            </div>
          </div>
        </section>

        {!canEdit && (
          <p className="text-[12px] text-[var(--ds-text-subtle)] italic">
            {t('adminsOnly')}
          </p>
        )}
      </div>
    </details>
  );
};
