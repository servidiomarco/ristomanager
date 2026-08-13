import React, { useCallback, useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Loader2, RefreshCw, Phone, Clock, Sparkles, Coins, AlertTriangle, Mic, Bot } from 'lucide-react';
import {
  getGeminiUsage, getElevenLabsUsage,
  GeminiUsage, ElevenLabsUsage,
} from '../services/monitoringApiService';

/* La pagina "Consumi AI" mette in fila i due fornitori che consumano credito a
   nostro carico: ElevenLabs (l'agente vocale Sofia) e Gemini (report/analisi AI).
   Le due sorgenti sono diverse — ElevenLabs si legge live dalla sua API, Gemini
   dalla telemetria che il client scrive a ogni chiamata — ma qui si leggono con
   lo stesso ritmo e lo stesso selettore di finestra temporale. */

const WINDOWS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOWS)[number];

// Etichette leggibili per le feature Gemini registrate dal client.
const FEATURE_LABELS: Record<string, string> = {
  dashboard_report: 'Report Dashboard',
  banquet_menu: 'Proposta menu banchetto',
};
const featureLabel = (key: string): string => FEATURE_LABELS[key] || key;

const nf = new Intl.NumberFormat('it-IT');
const formatInt = (n: number | null | undefined): string => nf.format(Math.round(n ?? 0));

// Secondi → "1h 23m" / "12m 05s" / "42s", per i minuti di conversazione di Sofia.
const formatDuration = (totalSeconds: number | null | undefined): string => {
  const s = Math.max(0, Math.round(totalSeconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
};

const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const formatResetDate = (unix: number | null | undefined): string => {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
};

// Etichetta d'asse compatta dal giorno ISO (YYYY-MM-DD → "12/08").
const shortDay = (iso: string): string => {
  const parts = iso.split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : iso;
};

const chartTooltip = {
  cursor: { fill: 'var(--color-surface-hover)' },
  contentStyle: { background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: '12px', fontSize: '13px' },
  labelStyle: { color: 'var(--color-fg-muted)' },
} as const;

// Le barre usano un solido del design system (theme-aware): --color-chart-1 in
// tema scuro cade su un blu quasi nero e sparirebbe sul canvas. Il tetto di
// larghezza evita le barre-lastra quando i punti dati sono pochissimi.
const BAR_FILL = 'var(--ds-arriving-solid)';
const BAR_MAX = 56;

// Tick asse Y compatto: 2850 → "2,8k", così non serve larghezza extra e non si
// taglia la cifra iniziale come con la formattazione a migliaia di default.
const compactTick = (v: number): string => {
  if (Math.abs(v) >= 1000) {
    const k = v / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1).replace('.', ',')}k`;
  }
  return String(v);
};

// ---- Elementi riutilizzabili -------------------------------------------------

const SectionCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}> = ({ icon, title, subtitle, children }) => (
  <section className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)] sm:p-5">
    <header className="mb-4 flex items-start gap-3">
      <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]">
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold text-[var(--ds-text-primary)]">{title}</h2>
        <p className="text-[13px] text-[var(--ds-text-muted)]">{subtitle}</p>
      </div>
    </header>
    {children}
  </section>
);

const StatTile: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}> = ({ icon, label, value, hint }) => (
  <div className="rounded-[16px] bg-[var(--ds-surface-row)] p-3">
    <div className="mb-1 flex items-center gap-2 text-[13px] font-medium text-[var(--ds-text-secondary)]">
      <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface)] text-[var(--ds-text-muted)]">
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </div>
    <div className="tabular text-[22px] font-bold leading-tight text-[var(--ds-text-primary)]">{value}</div>
    {hint && <div className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">{hint}</div>}
  </div>
);

const EmptyChart: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex h-[180px] items-center justify-center rounded-[16px] bg-[var(--ds-surface-row)] text-[13px] text-[var(--ds-text-muted)]">
    {message}
  </div>
);

// ---- Pagina ------------------------------------------------------------------

export const MonitoringPage: React.FC = () => {
  const [days, setDays] = useState<WindowDays>(30);
  const [eleven, setEleven] = useState<ElevenLabsUsage | null>(null);
  const [gemini, setGemini] = useState<GeminiUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (windowDays: WindowDays) => {
    setLoading(true);
    setError(null);
    try {
      const [e, g] = await Promise.all([
        getElevenLabsUsage(windowDays),
        getGeminiUsage(windowDays),
      ]);
      setEleven(e);
      setGemini(g);
    } catch (err: any) {
      setError(err?.message || 'Errore nel caricamento dei consumi');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(days);
  }, [days, load]);

  const quotaPct = (() => {
    const sub = eleven?.subscription;
    if (!sub || !sub.character_limit || sub.character_count == null) return null;
    if (sub.character_limit <= 0) return null;
    return Math.min(100, Math.round((sub.character_count / sub.character_limit) * 100));
  })();

  const geminiDaily = (gemini?.daily ?? []).map(d => ({ ...d, label: shortDay(d.day) }));
  const callDaily = (eleven?.calls.daily ?? []).map(d => ({ ...d, label: shortDay(d.day), minutes: +(d.seconds / 60).toFixed(1) }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">

          {/* Intestazione + selettore finestra */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-[22px] font-bold text-[var(--ds-text-primary)]">Consumi AI</h1>
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                Sofia (ElevenLabs) e le analisi AI (Gemini) a confronto.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-full bg-[var(--ds-surface-row)] p-1">
                {WINDOWS.map(w => (
                  <button
                    key={w}
                    onClick={() => setDays(w)}
                    className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${
                      days === w
                        ? 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]'
                        : 'text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                    }`}
                  >
                    {w}g
                  </button>
                ))}
              </div>
              <button
                onClick={() => load(days)}
                disabled={loading}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:text-[var(--ds-text-primary)] disabled:opacity-50"
                aria-label="Aggiorna"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-5 flex items-center gap-2 rounded-[16px] bg-[var(--ds-critical-tint)] px-4 py-3 text-[13px] text-[var(--ds-critical-text)]">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading && !eleven && !gemini ? (
            <div className="flex h-[240px] items-center justify-center text-[var(--ds-text-muted)]">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : (
            <div className="space-y-5">

              {/* ---- SOFIA / ELEVENLABS ---- */}
              <SectionCard
                icon={<Mic className="h-5 w-5" />}
                title="Sofia · Agente vocale (ElevenLabs)"
                subtitle={`Ultimi ${days} giorni · chiamate dalla nostra cronologia, quota live dal piano ElevenLabs`}
              >
                <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <StatTile
                    icon={<Phone className="h-3.5 w-3.5" />}
                    label={`Chiamate (${days}g)`}
                    value={formatInt(eleven?.calls.window.calls)}
                    hint={`${formatInt(eleven?.calls.allTime.calls)} totali`}
                  />
                  <StatTile
                    icon={<Clock className="h-3.5 w-3.5" />}
                    label={`Durata (${days}g)`}
                    value={formatDuration(eleven?.calls.window.seconds)}
                    hint={`${formatDuration(eleven?.calls.allTime.seconds)} totali`}
                  />
                  <StatTile
                    icon={<Coins className="h-3.5 w-3.5" />}
                    label="Crediti usati"
                    value={eleven?.subscription?.character_count != null ? formatInt(eleven.subscription.character_count) : '—'}
                    hint={eleven?.subscription?.character_limit != null ? `su ${formatInt(eleven.subscription.character_limit)}` : 'quota non disponibile'}
                  />
                  <StatTile
                    icon={<RefreshCw className="h-3.5 w-3.5" />}
                    label="Reset quota"
                    value={eleven?.subscription?.tier ? String(eleven.subscription.tier) : '—'}
                    hint={formatResetDate(eleven?.subscription?.next_reset_unix)}
                  />
                </div>

                {/* Barra quota crediti del piano ElevenLabs */}
                {quotaPct != null && (
                  <div className="mb-4 rounded-[16px] bg-[var(--ds-surface-row)] p-3">
                    <div className="mb-1.5 flex items-center justify-between text-[13px]">
                      <span className="font-medium text-[var(--ds-text-secondary)]">Quota crediti del ciclo corrente</span>
                      <span className="tabular font-semibold text-[var(--ds-text-primary)]">{quotaPct}%</span>
                    </div>
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--ds-border)]">
                      <div
                        className={`h-full rounded-full ${quotaPct >= 90 ? 'bg-[var(--ds-critical-solid)]' : quotaPct >= 70 ? 'bg-[var(--ds-pending-solid)]' : 'bg-[var(--ds-seated-solid)]'}`}
                        style={{ width: `${quotaPct}%` }}
                      />
                    </div>
                  </div>
                )}

                {eleven?.subscriptionError && (
                  <div className="mb-4 flex items-center gap-2 rounded-[16px] bg-[var(--ds-pending-tint)] px-4 py-2.5 text-[12px] text-[var(--ds-pending-text)]">
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                    <span>Quota ElevenLabs non disponibile: {eleven.subscriptionError}. Le statistiche chiamate restano valide.</span>
                  </div>
                )}

                {/* Chiamate per giorno */}
                {callDaily.length > 0 ? (
                  <div className="h-[200px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={callDaily} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke="var(--color-chart-grid)" />
                        <XAxis dataKey="label" axisLine={false} tickLine={false} stroke="var(--color-chart-axis)" tick={{ fill: 'var(--color-chart-axis)', fontSize: 11 }} interval="preserveStartEnd" />
                        <YAxis domain={[0, 'auto']} allowDecimals={false} axisLine={false} tickLine={false} stroke="var(--color-chart-axis)" tick={{ fill: 'var(--color-chart-axis)', fontSize: 11 }} width={30} />
                        <Tooltip {...chartTooltip} formatter={(v: number) => [`${v} chiamate`, 'Chiamate']} />
                        <Bar dataKey="calls" fill={BAR_FILL} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyChart message="Nessuna chiamata nella finestra selezionata." />
                )}
              </SectionCard>

              {/* ---- GEMINI ---- */}
              <SectionCard
                icon={<Bot className="h-5 w-5" />}
                title="Analisi AI (Gemini)"
                subtitle={`Ultimi ${days} giorni · token registrati a ogni generazione (storico dal momento dell'attivazione del tracciamento)`}
              >
                <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <StatTile
                    icon={<Coins className="h-3.5 w-3.5" />}
                    label={`Token totali (${days}g)`}
                    value={formatInt(gemini?.totals.total_tokens)}
                  />
                  <StatTile
                    icon={<Sparkles className="h-3.5 w-3.5" />}
                    label="Token input"
                    value={formatInt(gemini?.totals.prompt_tokens)}
                  />
                  <StatTile
                    icon={<Sparkles className="h-3.5 w-3.5" />}
                    label="Token output"
                    value={formatInt(gemini?.totals.output_tokens)}
                  />
                  <StatTile
                    icon={<Bot className="h-3.5 w-3.5" />}
                    label="Generazioni"
                    value={formatInt(gemini?.totals.calls)}
                    hint={`ultima: ${formatDateTime(gemini?.totals.last_at)}`}
                  />
                </div>

                {geminiDaily.some(d => d.total_tokens > 0) ? (
                  <div className="mb-4 h-[200px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={geminiDaily} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke="var(--color-chart-grid)" />
                        <XAxis dataKey="label" axisLine={false} tickLine={false} stroke="var(--color-chart-axis)" tick={{ fill: 'var(--color-chart-axis)', fontSize: 11 }} interval="preserveStartEnd" />
                        <YAxis domain={[0, 'auto']} axisLine={false} tickLine={false} stroke="var(--color-chart-axis)" tick={{ fill: 'var(--color-chart-axis)', fontSize: 11 }} width={40} tickFormatter={compactTick} />
                        <Tooltip {...chartTooltip} formatter={(v: number) => [`${formatInt(v)} token`, 'Token']} />
                        <Bar dataKey="total_tokens" fill={BAR_FILL} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyChart message="Nessun consumo Gemini registrato in questa finestra." />
                )}

                {/* Ripartizione per feature */}
                {gemini && gemini.byFeature.length > 0 && (
                  <div className="overflow-hidden rounded-[16px] bg-[var(--ds-surface-row)]">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="text-left text-[var(--ds-text-muted)]">
                          <th className="px-3 py-2 font-medium">Funzione</th>
                          <th className="px-3 py-2 text-right font-medium">Generazioni</th>
                          <th className="px-3 py-2 text-right font-medium">Token</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gemini.byFeature.map(f => (
                          <tr key={f.feature} className="border-t border-[var(--ds-border)]">
                            <td className="px-3 py-2 text-[var(--ds-text-primary)]">
                              {featureLabel(f.feature)}
                              {f.model && <span className="ml-1.5 text-[11px] text-[var(--ds-text-muted)]">{f.model}</span>}
                            </td>
                            <td className="tabular px-3 py-2 text-right text-[var(--ds-text-secondary)]">{formatInt(f.calls)}</td>
                            <td className="tabular px-3 py-2 text-right font-semibold text-[var(--ds-text-primary)]">{formatInt(f.total_tokens)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionCard>

              <p className="px-1 text-[12px] leading-relaxed text-[var(--ds-text-muted)]">
                Nota: ElevenLabs misura in crediti/caratteri del piano e i valori quota sono in tempo reale;
                Gemini è misurato in token e il conteggio parte da quando è stato attivato il tracciamento,
                quindi non include le generazioni precedenti.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
