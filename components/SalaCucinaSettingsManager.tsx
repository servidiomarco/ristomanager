import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CookingPot, ChevronDown, Loader2, Monitor, Printer, Plus, Trash2, Wifi, WifiOff, Receipt } from 'lucide-react';
import { getFeatureFlags, updateFeatureFlags, FeatureFlags } from '../services/apiService';
import {
  getSalaConfig, setFireMode, createStation, updateStation,
  createPrinter, updatePrinter, deletePrinter, testPrinter,
  setCategoryStation,
  getSalaProfiles, createSalaProfile, updateSalaProfile,
  activateSalaProfile, detachSalaProfile, deleteSalaProfile,
  updatePrintRoutes,
  type SalaConfig, type FireMode, type SalaProfile,
} from '../services/salaApiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

// Il fire mode spiegato in italiano di sala, non in enum: chi configura è il
// gestore, e la differenza fra i tre modi decide come lavora la cucina.
const FIRE_MODE_LABELS: { value: FireMode; title: string; hint: string }[] = [
  { value: 'AUTO_ALL',   title: 'Tutto subito',       hint: 'Ogni uscita parte in cucina appena il cameriere invia. Senza passe.' },
  { value: 'AUTO_FIRST', title: 'Prima uscita subito', hint: 'La 1ª parte da sola, le successive aspettano il lancio dal Passe.' },
  { value: 'AUTO_NEXT',  title: 'A consumo',          hint: 'La successiva parte da sola quando segni servita la precedente.' },
  { value: 'MANUAL',     title: 'Tutto dal passe',    hint: 'Nessuna uscita parte da sola: le lancia tutte l\'expediter dal Passe.' },
];

export const SalaCucinaSettingsManager: React.FC<Props> = ({ showToast }) => {
  const { hasPermission } = useAuth();
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

  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; });

  const reload = useCallback(async () => {
    try {
      const [f, c, p] = await Promise.all([getFeatureFlags(), getSalaConfig(), getSalaProfiles()]);
      setFlags(f);
      setConfig(c);
      setProfiles(p.profiles);
      setActiveProfile(p.active_profile);
    } catch (err: any) {
      showToastRef.current(err?.message || 'Errore nel caricamento', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

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
      showToast(err?.message || 'Operazione non riuscita', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !flags || !config) {
    return (
      <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] px-4 py-3 flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Caricamento…
      </div>
    );
  }

  const enabled = flags.table_orders_enabled === true;
  const thermal = config.printers.filter(p => p.kind === 'THERMAL');
  const fiscal = config.printers.filter(p => p.kind === 'FISCAL');

  const toggleModule = () => act(
    async () => { setFlags(await updateFeatureFlags({ table_orders_enabled: !enabled })); },
    `Gestione sala: ${!enabled ? 'attiva' : 'disattivata'}`
  );

  return (
    <details className="group bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] overflow-hidden"
             onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--ds-surface-row)] transition-colors">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-pending-text)] flex-shrink-0">
            <CookingPot className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Sala &amp; Cucina</h4>
            <p className="text-[13px] text-[var(--ds-text-muted)] truncate">Comande, partite, monitor, passe e stampanti.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`text-[12px] font-medium ${enabled ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-text-subtle)]'}`}>
            {enabled ? 'Attivo' : 'Disattivato'}
          </span>
          <button
            type="button" role="switch" aria-checked={enabled}
            aria-label={`${enabled ? 'Disattiva' : 'Attiva'} gestione sala`}
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
            Profilo di configurazione
          </h5>
          <div className="rounded-md border border-[var(--ds-border)] divide-y divide-[var(--ds-border)]">
            {profiles.map(pr => {
              const isActive = activeProfile === pr.name;
              return (
                <div key={pr.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="flex-1 min-w-0 text-[13px] font-medium text-[var(--ds-text-primary)] truncate">
                    {pr.name}
                    {isActive && <span className="ml-2 text-[12px] font-semibold text-[var(--ds-seated-text)] tracking-wide">attivo</span>}
                  </span>
                  {isActive ? (
                    <button type="button" disabled={!canEdit || saving}
                      onClick={() => act(() => detachSalaProfile(), `Profilo "${pr.name}" scollegato — la configurazione resta`)}
                      className="text-[12px] px-2 py-1 rounded-md border border-[var(--ds-border)] disabled:opacity-50">
                      scollega
                    </button>
                  ) : (
                    <button type="button" disabled={!canEdit || saving}
                      onClick={() => act(() => activateSalaProfile(pr.id), `Profilo "${pr.name}" applicato`)}
                      className="text-[12px] px-2.5 py-1 rounded-md bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] disabled:opacity-50">
                      attiva
                    </button>
                  )}
                  <button type="button" disabled={!canEdit || saving} title="Sovrascrive il profilo col setup corrente"
                    onClick={() => act(() => updateSalaProfile(pr.id), `Profilo "${pr.name}" aggiornato col setup corrente`)}
                    className="text-[12px] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] disabled:opacity-50">
                    aggiorna
                  </button>
                  <button type="button" disabled={!canEdit || saving} aria-label={`Elimina profilo ${pr.name}`}
                    onClick={() => act(() => deleteSalaProfile(pr.id), 'Profilo eliminato')}
                    className="text-[var(--ds-critical-text)] disabled:opacity-50"><Trash2 size={14} /></button>
                </div>
              );
            })}
            {canEdit && (
              <div className="flex items-center gap-2 px-3 py-2">
                <input value={newProfile} onChange={e => setNewProfile(e.target.value)}
                  placeholder="Salva il setup corrente come…"
                  className="flex-1 text-[13px] rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5" />
                <button type="button" disabled={!newProfile.trim() || saving}
                  onClick={() => act(() => createSalaProfile(newProfile.trim()), 'Profilo salvato').then(() => setNewProfile(''))}
                  className="text-[13px] px-2.5 py-1.5 rounded-md border border-[var(--ds-border)] flex items-center gap-1 disabled:opacity-50">
                  <Plus size={13} /> Salva
                </button>
              </div>
            )}
          </div>
          <p className="text-[12px] text-[var(--ds-text-muted)] mt-1.5">
            Un profilo è uno snapshot di modalità di lancio, partite e stampanti. "Attiva" lo applica
            in blocco; "scollega" toglie solo il legame, senza toccare la configurazione corrente.
          </p>
        </section>

        {/* ---- Lancio uscite ---- */}
        <section>
          <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2">
            Lancio delle uscite
          </h5>
          <div className="grid sm:grid-cols-3 gap-2">
            {FIRE_MODE_LABELS.map(m => (
              <button key={m.value} type="button" disabled={!canEdit || saving}
                onClick={() => act(() => setFireMode(m.value), `Lancio uscite: ${m.title.toLowerCase()}`)}
                className={`text-left px-3 py-2.5 rounded-md border text-[13px] transition-colors disabled:opacity-60 ${
                  config.fire_mode === m.value
                    ? 'border-[var(--ds-text-primary)]/50 bg-[var(--ds-surface-row)]'
                    : 'border-[var(--ds-border)] hover:bg-[var(--ds-surface-row)]'
                }`}>
                <div className="font-medium text-[var(--ds-text-primary)]">{m.title}</div>
                <div className="text-[12px] text-[var(--ds-text-muted)] leading-snug mt-0.5">{m.hint}</div>
              </button>
            ))}
          </div>
        </section>

        {/* ---- Passe ---- */}
        <section>
          <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2">
            Passe
          </h5>
          <div className="flex items-start justify-between gap-3 rounded-md border border-[var(--ds-border)] px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--ds-text-primary)]">Postazione passe</div>
              <p className="text-[12px] text-[var(--ds-text-muted)] leading-snug mt-0.5">
                Attiva: lanci e serviti passano dalla pagina Passe (expediter).
                Disattivata: la pagina sparisce dal menu e le icone chiama e
                servito compaiono sulle card del monitor cucina.
              </p>
            </div>
            <button
              type="button" role="switch" aria-checked={flags.passe_enabled !== false}
              aria-label={`${flags.passe_enabled !== false ? 'Disattiva' : 'Attiva'} il passe`}
              onClick={() => act(
                async () => { setFlags(await updateFeatureFlags({ passe_enabled: flags.passe_enabled === false })); },
                `Passe: ${flags.passe_enabled === false ? 'attivo' : 'disattivato — chiama e servito passano al monitor cucina'}`
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
            Centri di produzione (partite)
          </h5>
          <div className="rounded-md border border-[var(--ds-border)] divide-y divide-[var(--ds-border)]">
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
                      e.target.value ? `${s.name} → stampante "${e.target.value}"` : `${s.name}: solo schermo`
                    )}
                    className="text-[13px] rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1 disabled:opacity-60">
                    <option value="">Solo schermo</option>
                    {thermal.filter(p => p.is_active).map(p => (
                      <option key={p.id} value={p.name}>schermo + {p.name}</option>
                    ))}
                  </select>
                </div>
                <button type="button" disabled={!canEdit || saving}
                  onClick={() => act(() => updateStation(s.id, { is_active: !s.is_active }))}
                  className="text-[12px] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] disabled:opacity-50">
                  {s.is_active ? 'disattiva' : 'riattiva'}
                </button>
              </div>
            ))}
            {canEdit && (
              <div className="flex items-center gap-2 px-3 py-2">
                <input value={newStation} onChange={e => setNewStation(e.target.value)}
                  placeholder="Nuova partita (es. Pizzeria)"
                  className="flex-1 text-[13px] rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5" />
                <button type="button" disabled={!newStation.trim() || saving}
                  onClick={() => act(() => createStation({ name: newStation.trim() }), 'Partita creata').then(() => setNewStation(''))}
                  className="text-[13px] px-2.5 py-1.5 rounded-md border border-[var(--ds-border)] flex items-center gap-1 disabled:opacity-50">
                  <Plus size={13} /> Aggiungi
                </button>
              </div>
            )}
          </div>
          <p className="text-[12px] text-[var(--ds-text-muted)] mt-1.5">
            "Solo schermo" = la partita lavora dal monitor Cucina. Con una stampante, al lancio dell'uscita esce anche la comanda di carta.
          </p>
        </section>

        {/* ---- Categorie → partite ---- */}
        <section>
          <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2">
            Partita per categoria di menu
          </h5>
          <div className="rounded-md border border-[var(--ds-border)] divide-y divide-[var(--ds-border)]">
            {config.categories.map(cat => (
              <div key={cat} className="flex items-center gap-3 px-3 py-2">
                <span className="flex-1 min-w-0 text-[13px] font-medium text-[var(--ds-text-primary)] truncate">{cat}</span>
                <select
                  value={config.category_stations[cat] ?? ''}
                  disabled={!canEdit || saving}
                  onChange={e => act(
                    () => setCategoryStation(cat, e.target.value ? Number(e.target.value) : null),
                    e.target.value
                      ? `${cat} → ${config.stations.find(s => s.id === Number(e.target.value))?.name ?? 'partita'}`
                      : `${cat}: senza partita`
                  )}
                  className="text-[13px] rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1 disabled:opacity-60">
                  <option value="">Senza partita</option>
                  {config.stations.filter(s => s.is_active).map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            ))}
            {config.categories.length === 0 && (
              <p className="px-3 py-3 text-[13px] text-[var(--ds-text-muted)]">Nessuna categoria in anagrafica piatti.</p>
            )}
          </div>
          <p className="text-[12px] text-[var(--ds-text-muted)] mt-1.5">
            I piatti senza partita assegnata seguono la loro categoria — anche quelli creati in futuro.
            Vale per le comande inviate da qui in poi; un'assegnazione esplicita sul singolo piatto vince sempre.
          </p>
        </section>

        {/* ---- Stampanti ---- */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)]">
              Stampanti termiche
            </h5>
            <span className={`text-[12px] flex items-center gap-1.5 ${config.agent.online ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}`}>
              {config.agent.online ? <Wifi size={13} /> : <WifiOff size={13} />}
              {config.agent.online
                ? 'agente di stampa online'
                : config.agent.last_seen_seconds != null
                  ? `agente offline da ${config.agent.last_seen_seconds}s`
                  : 'agente mai visto'}
              {config.pending_jobs > 0 && ` · ${config.pending_jobs} in coda`}
              {config.failed_jobs > 0 && ` · ${config.failed_jobs} falliti`}
            </span>
          </div>
          <div className="rounded-md border border-[var(--ds-border)] divide-y divide-[var(--ds-border)]">
            {thermal.map(p => (
              <div key={p.id} className={`flex items-center gap-3 px-3 py-2 ${p.is_active ? '' : 'opacity-50'}`}>
                <Printer size={14} className="text-[var(--ds-text-muted)] flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium text-[var(--ds-text-primary)]">{p.name}</span>
                  <span className="text-[12px] text-[var(--ds-text-muted)] ml-2">{p.host}:{p.port}</span>
                </div>
                <button type="button" disabled={!canEdit || saving || testingId === p.id || !p.is_active}
                  onClick={async () => {
                    setTestingId(p.id);
                    try {
                      await testPrinter(p.id);
                      showToast(`Prova inviata a "${p.name}" — controlla la stampante`, 'success');
                    } catch (err: any) { showToast(err?.message || 'Invio non riuscito', 'error'); }
                    finally { setTestingId(null); }
                  }}
                  className="text-[12px] px-2 py-1 rounded-md border border-[var(--ds-border)] disabled:opacity-50">
                  {testingId === p.id ? 'invio…' : 'stampa prova'}
                </button>
                <button type="button" disabled={!canEdit || saving}
                  onClick={() => act(() => updatePrinter(p.id, { is_active: !p.is_active }))}
                  className="text-[12px] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] disabled:opacity-50">
                  {p.is_active ? 'disattiva' : 'riattiva'}
                </button>
                <button type="button" disabled={!canEdit || saving} aria-label={`Elimina ${p.name}`}
                  onClick={() => act(() => deletePrinter(p.id), 'Stampante eliminata')}
                  className="text-[var(--ds-critical-text)] disabled:opacity-50"><Trash2 size={14} /></button>
              </div>
            ))}
            {thermal.length === 0 && (
              <p className="px-3 py-3 text-[13px] text-[var(--ds-text-muted)]">Nessuna stampante censita.</p>
            )}
            {canEdit && (
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <input value={newPrinter.name} onChange={e => setNewPrinter(v => ({ ...v, name: e.target.value }))}
                  placeholder="nome (es. cucina)" className="w-32 text-[13px] rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5" />
                <input value={newPrinter.host} onChange={e => setNewPrinter(v => ({ ...v, host: e.target.value }))}
                  placeholder="IP (es. 192.168.1.30)" className="w-40 text-[13px] rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5" />
                <input value={newPrinter.port} onChange={e => setNewPrinter(v => ({ ...v, port: e.target.value }))}
                  placeholder="porta" className="w-20 text-[13px] rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5" />
                <button type="button" disabled={!newPrinter.name.trim() || !newPrinter.host.trim() || saving}
                  onClick={() => act(
                    () => createPrinter({ name: newPrinter.name.trim(), host: newPrinter.host.trim(), port: Number(newPrinter.port) || 9100 }),
                    'Stampante aggiunta'
                  ).then(() => setNewPrinter({ name: '', host: '', port: '9100' }))}
                  className="text-[13px] px-2.5 py-1.5 rounded-md border border-[var(--ds-border)] flex items-center gap-1 disabled:opacity-50">
                  <Plus size={13} /> Aggiungi
                </button>
              </div>
            )}
          </div>
        </section>

        {/* ---- Instradamento conto ---- */}
        <section>
          <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2">
            Instradamento stampe del conto
          </h5>
          <div className="rounded-md border border-[var(--ds-border)] divide-y divide-[var(--ds-border)]">
            {([
              { fn: 'preconto' as const, label: 'Preconto', hint: 'dettaglio righe con QR in fondo' },
              { fn: 'qr' as const, label: 'Foglietto QR', hint: 'solo codice, da appoggiare al tavolo' },
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
                      `${label} → stampante "${e.target.value}"`
                    )}
                    className="text-[13px] rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1 disabled:opacity-60">
                    {!thermal.some(pr => pr.is_active && pr.name === 'preconti') && (
                      <option value="preconti">preconti (predefinita)</option>
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
            Le comande delle partite si instradano qui sopra, centro per centro. Qui scegli dove escono i documenti del conto al tavolo.
          </p>
        </section>

        {/* ---- Fiscale (Fase 2) ---- */}
        <section>
          <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2">
            Stampante fiscale
          </h5>
          <div className="rounded-md bg-[var(--ds-surface-row)] border border-[var(--ds-border)] px-3 py-2.5 flex items-start gap-2.5">
            <Receipt size={15} className="mt-0.5 text-[var(--ds-text-muted)] flex-shrink-0" />
            <div className="text-[13px]">
              {fiscal.length > 0 ? (
                <div className="text-[var(--ds-text-primary)]">
                  {fiscal.map(p => <div key={p.id}><strong>{p.name}</strong> · {p.host}:{p.port}{p.notes ? ` — ${p.notes}` : ''}</div>)}
                </div>
              ) : (
                <div className="text-[var(--ds-text-primary)]">Nessun registratore telematico censito.</div>
              )}
              <p className="text-[12px] text-[var(--ds-text-muted)] mt-1">
                Lo scontrino resta al gestionale di cassa: il collegamento diretto arriva con la Fase 2
                (integrazione Passepartout). Da qui il CRM non invia mai nulla alla fiscale.
              </p>
            </div>
          </div>
        </section>

        {!canEdit && (
          <p className="text-[12px] text-[var(--ds-text-subtle)] italic">
            Solo gli amministratori possono modificare queste impostazioni.
          </p>
        )}
      </div>
    </details>
  );
};
