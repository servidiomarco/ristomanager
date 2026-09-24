import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { displayLocale } from '../utils/formatLocale';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Loader2, RefreshCw, Phone, Clock, Wand2, Coins, AlertTriangle, Mic, Bot } from 'lucide-react';
import {
  getGeminiUsage, getElevenLabsUsage,
  GeminiUsage, ElevenLabsUsage,
} from '../services/monitoringApiService';

/* La pagina "Consumi AI" mette in fila i due fornitori che consumano credito a
   nostro carico: ElevenLabs (l'agente vocale Sofia) e Claude (messaggi e
   report AI). I consumi storici di Gemini restano nel conteggio: la tabella
   tiene il fornitore riga per riga, quindi il passaggio non perde niente.
   Le due sorgenti sono diverse — ElevenLabs si legge live dalla sua API, Gemini
   dalla telemetria che il client scrive a ogni chiamata — ma qui si leggono con
   lo stesso ritmo e lo stesso selettore di finestra temporale. */

const WINDOWS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOWS)[number];

// Etichette leggibili per le feature Gemini registrate dal client.
const FEATURE_LABELS: Record<string, string> = {
  dashboard_report: 'Report Dashboard',
  banquet_menu: 'Proposta menu banchetto',
  suggest_reply: 'Risposta suggerita messaggi',
  whatsapp_agent: 'Agente WhatsApp',
};
type TFunc = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

const featureLabel = (key: string, t?: TFunc): string => {
  const it = FEATURE_LABELS[key];
  if (!it) return key;
  return t ? t(`feature.${key}`, it) : it;
};

/* Come in reportistica/shared.tsx: `nf` era su 'it-IT' a livello di modulo.
   Cache per locale perché lo chiamano le celle dei grafici. */
const formatters = new Map<string, Intl.NumberFormat>();
const nf = (): Intl.NumberFormat => {
  const loc = displayLocale();
  let f = formatters.get(loc);
  if (!f) { f = new Intl.NumberFormat(loc); formatters.set(loc, f); }
  return f;
};
// Sotto il centesimo si scrivono tre decimali: "0,00 €" su una spesa vera
// sembra un errore, e chi legge smette di fidarsi del numero.
const formatEuro = (usd: number | null | undefined, tasso: number): string => {
  const eur = (usd ?? 0) * tasso;
  if (eur === 0) return '0 €';
  if (eur < 0.01) return `${eur.toFixed(3).replace('.', ',')} €`;
  return `${eur.toFixed(2).replace('.', ',')} €`;
};
const formatInt = (n: number | null | undefined): string => nf().format(Math.round(n ?? 0));

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
  return d.toLocaleString(displayLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const formatResetDate = (unix: number | null | undefined): string => {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(displayLocale(), { day: '2-digit', month: 'long', year: 'numeric' });
};

// Etichetta d'asse compatta dal giorno ISO (YYYY-MM-DD → "12/08").
// Centesimi di euro → "61 €" / "12,40 €".
const formatCents = (cents: number): string => {
  const eur = cents / 100;
  /* L'euro resta: questi sono i conti della piattaforma, non di un
     ristorante — Sympotia fattura in euro qualunque lingua legga chi guarda.
     Il separatore decimale invece segue la lingua. */
  return new Intl.NumberFormat(displayLocale(), {
    minimumFractionDigits: Number.isInteger(eur) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(eur) + ' €';
};

const shortDay = (iso: string): string => {
  const parts = iso.split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : iso;
};

const chartTooltip = {
  cursor: { fill: 'var(--ds-surface-row)' },
  contentStyle: { background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: '12px', fontSize: '13px' },
  labelStyle: { color: 'var(--ds-text-muted)' },
} as const;

// Le barre usano un solido del design system, che si inverte da solo fra i
// temi. Il tetto di larghezza evita le barre-lastra quando i punti dati sono
// pochissimi.
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
  <section className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)] sm:p-5">
    <header className="mb-4 flex items-start gap-3">
      <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]">
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
  <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-3">
    <div className="mb-1 flex items-center gap-2 text-[13px] font-medium text-[var(--ds-text-secondary)]">
      <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] text-[var(--ds-text-muted)]">
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </div>
    <div className="tabular text-[22px] font-bold leading-tight text-[var(--ds-text-primary)]">{value}</div>
    {hint && <div className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">{hint}</div>}
  </div>
);

const EmptyChart: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex h-[180px] items-center justify-center rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] text-[13px] text-[var(--ds-text-muted)]">
    {message}
  </div>
);

// ---- Pagina ------------------------------------------------------------------

export const MonitoringPage: React.FC = () => {
  const { t } = useTranslation('consumi', { useSuspense: false });
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
      setError(err?.message || t('errLoad', 'Errore nel caricamento dei consumi'));
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
                {t('subtitle', 'Sofia (ElevenLabs) e le analisi AI (Gemini) a confronto.')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] p-1">
                {WINDOWS.map(w => (
                  <button
                    key={w}
                    onClick={() => setDays(w)}
                    className={`rounded-[var(--ds-radius-control)] px-3 py-1.5 text-[13px] font-medium transition-colors ${
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
                className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:text-[var(--ds-text-primary)] disabled:opacity-50"
                aria-label={t('reload', 'Aggiorna')}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-5 flex items-center gap-2 rounded-[var(--ds-radius)] bg-[var(--ds-critical-tint)] px-4 py-3 text-[13px] text-[var(--ds-critical-text)]">
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
                title={t('voice.title', 'Sofia · Agente vocale (ElevenLabs)')}
                subtitle={t('voice.subtitle', 'Ultimi {{giorni}} giorni · chiamate dalla nostra cronologia, quota live dal piano ElevenLabs', { giorni: days })}
              >
                <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <StatTile
                    icon={<Phone className="h-3.5 w-3.5" />}
                    label={t('voice.calls', 'Chiamate ({{giorni}}g)', { giorni: days })}
                    value={formatInt(eleven?.calls.window.calls)}
                    hint={t('total', '{{n}} totali', { n: formatInt(eleven?.calls.allTime.calls) })}
                  />
                  <StatTile
                    icon={<Clock className="h-3.5 w-3.5" />}
                    label={t('voice.duration', 'Durata ({{giorni}}g)', { giorni: days })}
                    value={formatDuration(eleven?.calls.window.seconds)}
                    hint={typeof eleven?.calls.window.cost_usd === 'number'
                      ? `costo ${formatEuro(eleven.calls.window.cost_usd, eleven.usdEur ?? 0.92)}`
                      : t('total', '{{n}} totali', { n: formatDuration(eleven?.calls.allTime.seconds) })}
                  />
                  <StatTile
                    icon={<Coins className="h-3.5 w-3.5" />}
                    label={t('voice.credits', 'Crediti usati')}
                    value={eleven?.subscription?.character_count != null ? formatInt(eleven.subscription.character_count) : '—'}
                    hint={eleven?.subscription?.character_limit != null ? `su ${formatInt(eleven.subscription.character_limit)}` : 'quota non disponibile'}
                  />
                  <StatTile
                    icon={<RefreshCw className="h-3.5 w-3.5" />}
                    label={t('voice.quotaReset', 'Reset quota')}
                    value={eleven?.subscription?.tier ? String(eleven.subscription.tier) : '—'}
                    hint={formatResetDate(eleven?.subscription?.next_reset_unix)}
                  />
                </div>

                {/* Mese in corso contro i minuti inclusi nell'add-on (Fase 1:
                    solo misura, niente di fatturato). Il costo vero viene dai
                    dati ElevenLabs di ogni chiamata; il ricavo è una stima sul
                    piano di default. */}
                {eleven?.plan && eleven.month && (() => {
                  const { plan, month } = eleven;
                  const tasso = eleven.usdEur ?? 0.92;
                  const pct = Math.min(100, Math.round((month.billable_minutes / plan.includedMinutes) * 100));
                  const costCents = Math.round(month.cost_usd * tasso * 100);
                  const extraMinutes = Math.max(0, month.billable_minutes - plan.includedMinutes);
                  const monthName = new Date().toLocaleDateString(displayLocale(), { month: 'long' });
                  return (
                    <div className="mb-4 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-3">
                      <div className="mb-1.5 flex items-center justify-between gap-2 text-[13px]">
                        <span className="font-medium text-[var(--ds-text-secondary)]">{t('voice.monthMinutes', 'Minuti di {{mese}}', { mese: monthName })}</span>
                        <span className="tabular font-semibold text-[var(--ds-text-primary)]">
                          {formatInt(month.billable_minutes)} / {formatInt(plan.includedMinutes)} inclusi
                        </span>
                      </div>
                      <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--ds-border)]">
                        <div
                          className={`h-full rounded-[var(--ds-radius-control)] ${pct >= 100 ? 'bg-[var(--ds-critical-solid)]' : pct >= 80 ? 'bg-[var(--ds-pending-solid)]' : 'bg-[var(--ds-seated-solid)]'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="mt-2 grid grid-cols-1 gap-1 text-[12px] text-[var(--ds-text-muted)] sm:grid-cols-2">
                        <span>
                          {t('voice.projected', 'A fine mese ~{{minuti}} min · ricavo stimato {{ricavo}}', { minuti: formatInt(month.projected_minutes), ricavo: formatCents(month.projected_revenue_cents) })}
                        </span>
                        <span className="sm:text-right">
                          {t('voice.soFar', 'Finora: costo {{costo}} · ricavo {{ricavo}}', { costo: formatCents(costCents), ricavo: formatCents(month.estimated_revenue_cents) })}
                          {extraMinutes > 0 && ` ${t('voice.extraMin', '({{minuti}} min extra)', { minuti: formatInt(extraMinutes) })}`}
                          {t('voice.margin', ' · margine {{margine}}', { margine: formatCents(month.estimated_revenue_cents - costCents) })}
                        </span>
                      </div>
                      {month.priced_calls < month.calls && (
                        <p className="mt-1.5 text-[12px] text-[var(--ds-pending-text)]">
                          {t('voice.pricedCalls', 'Costo noto per {{conosciute}} chiamate su {{totali}}: le altre sono precedenti al recupero dello storico.', { conosciute: formatInt(month.priced_calls), totali: formatInt(month.calls) })}
                        </p>
                      )}
                      <p className="mt-1.5 text-[12px] text-[var(--ds-text-muted)]">
                        {t('voice.plan', 'Piano: {{prezzo}} al mese, {{minuti}} minuti inclusi, poi {{extra}}/min. Non contano le chiamate sotto i 10 secondi.', { prezzo: formatCents(plan.priceCents), minuti: formatInt(plan.includedMinutes), extra: formatCents(plan.overageCentsPerMinute) })}
                      </p>
                    </div>
                  );
                })()}

                {/* Barra quota crediti del piano ElevenLabs */}
                {quotaPct != null && (
                  <div className="mb-4 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-3">
                    <div className="mb-1.5 flex items-center justify-between text-[13px]">
                      <span className="font-medium text-[var(--ds-text-secondary)]">Quota crediti del ciclo corrente</span>
                      <span className="tabular font-semibold text-[var(--ds-text-primary)]">{quotaPct}%</span>
                    </div>
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--ds-border)]">
                      <div
                        className={`h-full rounded-[var(--ds-radius-control)] ${quotaPct >= 90 ? 'bg-[var(--ds-critical-solid)]' : quotaPct >= 70 ? 'bg-[var(--ds-pending-solid)]' : 'bg-[var(--ds-seated-solid)]'}`}
                        style={{ width: `${quotaPct}%` }}
                      />
                    </div>
                  </div>
                )}

                {eleven?.subscriptionError && (
                  <div className="mb-4 flex items-center gap-2 rounded-[var(--ds-radius)] bg-[var(--ds-pending-tint)] px-4 py-2.5 text-[12px] text-[var(--ds-pending-text)]">
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                    <span>{t('voice.quotaError', 'Quota ElevenLabs non disponibile: {{errore}}. Le statistiche chiamate restano valide.', { errore: eleven.subscriptionError })}</span>
                  </div>
                )}

                {/* Chiamate per giorno */}
                {callDaily.length > 0 ? (
                  <div className="h-[200px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={callDaily} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke="var(--ds-border)" />
                        <XAxis dataKey="label" axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} interval="preserveStartEnd" />
                        <YAxis domain={[0, 'auto']} allowDecimals={false} axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} width={30} />
                        <Tooltip {...chartTooltip} formatter={(v: number) => [t('voice.callsTooltip', '{{n}} chiamate', { n: v }), t('voice.callsAxis', 'Chiamate')]} />
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
                title={t('ai.title', 'Analisi AI (modelli di testo)')}
                subtitle={t('ai.subtitle', 'Ultimi {{giorni}} giorni · costi stimati dal listino per modello, convertiti a {{cambio}} €/$ — la fattura Anthropic è in dollari', { giorni: days, cambio: nf().format(gemini?.usdEur ?? 0.92) })}
              >
                <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <StatTile
                    icon={<Coins className="h-3.5 w-3.5" />}
                    label={t('ai.tokens', 'Token totali ({{giorni}}g)', { giorni: days })}
                    value={formatInt(gemini?.totals.total_tokens)}
                  />
                  <StatTile
                    icon={<Coins className="h-3.5 w-3.5" />}
                    label={t('ai.cost', 'Costo ({{giorni}}g)', { giorni: days })}
                    value={formatEuro(gemini?.totals.cost_usd, gemini?.usdEur ?? 0.92)}
                    hint={(gemini?.totals.unpriced_calls ?? 0) > 0
                      ? `${formatInt(gemini?.totals.unpriced_calls)} generazioni senza listino, escluse`
                      : `in + out: ${formatInt(gemini?.totals.prompt_tokens)} + ${formatInt(gemini?.totals.output_tokens)}`}
                  />
                  <StatTile
                    icon={<Wand2 className="h-3.5 w-3.5" />}
                    label={t('ai.avgCost', 'Costo medio')}
                    value={gemini && gemini.totals.calls > 0
                      ? formatEuro(gemini.totals.cost_usd / gemini.totals.calls, gemini.usdEur)
                      : '—'}
                    hint="a generazione"
                  />
                  <StatTile
                    icon={<Bot className="h-3.5 w-3.5" />}
                    label={t('ai.generations', 'Generazioni')}
                    value={formatInt(gemini?.totals.calls)}
                    hint={`ultima: ${formatDateTime(gemini?.totals.last_at)}`}
                  />
                </div>

                {geminiDaily.some(d => d.total_tokens > 0) ? (
                  <div className="mb-4 h-[200px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={geminiDaily} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke="var(--ds-border)" />
                        <XAxis dataKey="label" axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} interval="preserveStartEnd" />
                        <YAxis domain={[0, 'auto']} axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} width={40} tickFormatter={compactTick} />
                        <Tooltip {...chartTooltip} formatter={(v: number) => [t('ai.tokensTooltip', '{{n}} token', { n: formatInt(v) }), t('ai.tokensAxis', 'Token')]} />
                        <Bar dataKey="total_tokens" fill={BAR_FILL} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyChart message="Nessun consumo AI registrato in questa finestra." />
                )}

                {/* Ripartizione per feature */}
                {gemini && gemini.byFeature.length > 0 && (
                  <div className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)]">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="text-left text-[var(--ds-text-muted)]">
                          <th className="px-3 py-2 font-medium">{t('ai.colFeature', 'Funzione')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('ai.colGen', 'Generazioni')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('ai.colTokens', 'Token')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('ai.colCost', 'Costo')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gemini.byFeature.map(f => (
                          <tr key={f.feature} className="border-t border-[var(--ds-border)]">
                            <td className="px-3 py-2 text-[var(--ds-text-primary)]">
                              {featureLabel(f.feature, t)}
                              {f.model && <span className="ml-1.5 text-[11px] text-[var(--ds-text-muted)]">{f.model}</span>}
                            </td>
                            <td className="tabular px-3 py-2 text-right text-[var(--ds-text-secondary)]">{formatInt(f.calls)}</td>
                            <td className="tabular px-3 py-2 text-right text-[var(--ds-text-secondary)]">{formatInt(f.total_tokens)}</td>
                            <td className="tabular px-3 py-2 text-right font-semibold text-[var(--ds-text-primary)]">
                              {f.unpriced_calls === f.calls
                                ? <span className="font-normal text-[var(--ds-text-muted)]" title={t('ai.noPrice', 'Modello senza listino in tabella')}>{t('ai.nd', 'n/d')}</span>
                                : formatEuro(f.cost_usd, gemini.usdEur)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionCard>

              <p className="px-1 text-[12px] leading-relaxed text-[var(--ds-text-muted)]">
                {t('note', 'Nota: ElevenLabs misura in crediti/caratteri del piano e i valori quota sono in tempo reale; Gemini è misurato in token e il conteggio parte da quando è stato attivato il tracciamento, quindi non include le generazioni precedenti.')}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
