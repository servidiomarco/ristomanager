import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Loader2 } from 'lucide-react';
import { getVoiceUsage, updateVoiceExtraCap, updateVoiceAlertPercents, type VoiceUsageResponse } from '../services/apiService';
import { VOICE_ALERT_PERCENT_OPTIONS } from '../services/voicePlan';
import { useAuth } from '../contexts/AuthContext';
import { dsButton } from './ds';

/* ── Minuti di Sofia ──────────────────────────────────────────────────────
   Il ristoratore vede i minuti del mese contro quelli inclusi nell'add-on,
   dove arriverà a fine mese a questo ritmo, quante prenotazioni ha preso
   Sofia, e sceglie il tetto di spesa per i minuti extra e a quale
   percentuale dei minuti inclusi ricevere l'avviso. Costo e margine
   restano nella pagina Consumi AI: sono numeri della piattaforma, non suoi. */

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const eur = (cents: number): string => {
    const v = cents / 100;
    return Number.isInteger(v) ? `${v} €` : `${v.toFixed(2).replace('.', ',')} €`;
};

export const VoiceUsageCard: React.FC<Props> = ({ showToast }) => {
    const { t } = useTranslation('canali', { useSuspense: false });
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [data, setData] = useState<VoiceUsageResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [alertsSaving, setAlertsSaving] = useState(false);
    const [capDraft, setCapDraft] = useState('');

    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const d = await getVoiceUsage();
                if (cancelled) return;
                setData(d);
                setCapDraft(String(d.plan.extraCapCents / 100));
            } catch (err: any) {
                if (!cancelled) showToastRef.current(err?.message || t('vu.err.load', 'Errore nel caricamento dei minuti'), 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    if (loading) {
        return (
            <div className="flex items-center gap-2 rounded-[var(--ds-radius)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-4 py-3 text-[13px] text-[var(--ds-text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> {t('vu.loading', 'Caricamento…')}
            </div>
        );
    }
    if (!data) return null;

    const { plan, month } = data;
    const used = month.billable_minutes;
    const pct = plan.includedMinutes > 0 ? Math.min(100, Math.round((used / plan.includedMinutes) * 100)) : 100;
    const barClass = pct >= 100
        ? 'bg-[var(--ds-critical-solid)]'
        : pct >= 80 ? 'bg-[var(--ds-pending-solid)]' : 'bg-[var(--ds-seated-solid)]';
    const monthName = new Date(`${month.month}T12:00:00`).toLocaleDateString(undefined, { month: 'long' });
    const maxDaily = Math.max(1, ...month.daily.map(d => d.billable_minutes));

    const capCents = Math.round(Number(capDraft.replace(',', '.')) * 100);
    const capValid = capDraft.trim() !== '' && Number.isInteger(capCents) && capCents >= 0 && capCents <= 100000;
    const capDirty = capValid && capCents !== plan.extraCapCents;

    const saveCap = async () => {
        if (!capDirty || saving) return;
        setSaving(true);
        try {
            const d = await updateVoiceExtraCap(capCents);
            setData(d);
            setCapDraft(String(d.plan.extraCapCents / 100));
            showToast(t('vu.capSaved', 'Tetto aggiornato'), 'success');
        } catch (err: any) {
            showToast(err?.message || t('vu.err.save', 'Salvataggio non riuscito'), 'error');
        } finally {
            setSaving(false);
        }
    };

    // Un backend precedente non manda le soglie e non saprebbe salvarle: la
    // sezione resta nascosta finché il server nuovo non è in produzione.
    const alertPercents = Array.isArray(plan.alertPercents) ? plan.alertPercents : null;

    const toggleAlert = async (percent: number) => {
        if (!alertPercents || alertsSaving) return;
        const next = alertPercents.includes(percent)
            ? alertPercents.filter(p => p !== percent)
            : [...alertPercents, percent].sort((a, b) => a - b);
        const previous = data;
        setData({ ...data, plan: { ...plan, alertPercents: next } });
        setAlertsSaving(true);
        try {
            setData(await updateVoiceAlertPercents(next));
        } catch (err: any) {
            setData(previous);
            showToast(err?.message || t('vu.err.save', 'Salvataggio non riuscito'), 'error');
        } finally {
            setAlertsSaving(false);
        }
    };

    return (
        <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
            <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]">
                    <Clock className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                    <h4 className="text-[14px] font-medium text-[var(--ds-text-primary)]">{t('vu.title', 'Minuti di Sofia')}</h4>
                    <p className="text-[13px] text-[var(--ds-text-muted)]">
                        {t('vu.plan', '{{price}} al mese · {{included}} minuti inclusi · poi {{overage}} al minuto', {
                            price: eur(plan.priceCents), included: plan.includedMinutes, overage: eur(plan.overageCentsPerMinute),
                        })}
                    </p>
                </div>
            </div>

            <div className="mt-4">
                <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px]">
                    <span className="text-[var(--ds-text-secondary)]">{monthName}</span>
                    <span className="tabular-nums font-semibold text-[var(--ds-text-primary)]">
                        {t('vu.used', '{{used}} / {{included}} minuti', { used, included: plan.includedMinutes })}
                    </span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--ds-border)]">
                    <div className={`h-full rounded-full ${barClass}`} style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-1.5 text-[13px] text-[var(--ds-text-muted)]">
                    {month.projected_minutes > used
                        ? t('vu.projected', 'A questo ritmo circa {{minutes}} minuti a fine mese', { minutes: month.projected_minutes })
                        : t('vu.noProjection', 'Stima a fine mese non ancora disponibile')}
                </p>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2">
                <div className="rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] px-3 py-2">
                    <div className="text-[12px] text-[var(--ds-text-muted)]">{t('vu.calls', 'Chiamate')}</div>
                    <div className="tabular-nums text-[16px] font-semibold text-[var(--ds-text-primary)]">{month.calls}</div>
                </div>
                <div className="rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] px-3 py-2">
                    <div className="text-[12px] text-[var(--ds-text-muted)]">{t('vu.bookings', 'Prenotazioni')}</div>
                    <div className="tabular-nums text-[16px] font-semibold text-[var(--ds-text-primary)]">{month.bookings}</div>
                </div>
                <div className="rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] px-3 py-2">
                    <div className="text-[12px] text-[var(--ds-text-muted)]">{t('vu.extra', 'Extra')}</div>
                    <div className="tabular-nums text-[16px] font-semibold text-[var(--ds-text-primary)]">
                        {month.extra_minutes > 0 ? eur(month.extra_cents) : '—'}
                    </div>
                </div>
            </div>

            {month.daily.length > 0 && (
                <div className="mt-4">
                    <div className="mb-1 text-[12px] text-[var(--ds-text-muted)]">{t('vu.daily', 'Minuti al giorno')}</div>
                    <div className="flex h-16 items-end gap-[3px]" role="img" aria-label={t('vu.daily', 'Minuti al giorno')}>
                        {month.daily.map(d => (
                            <div
                                key={d.day}
                                title={t('vu.dayTip', '{{day}}: {{minutes}} min, {{calls}} chiamate', { day: d.day.slice(8), minutes: d.billable_minutes, calls: d.calls })}
                                className="min-w-0 flex-1 rounded-t-[var(--ds-radius-sm)] bg-[var(--ds-seated-solid)]"
                                style={{ height: `${Math.max(4, Math.round((d.billable_minutes / maxDaily) * 100))}%` }}
                            />
                        ))}
                    </div>
                </div>
            )}

            {month.over_cap && (
                <p className="mt-3 rounded-[var(--ds-radius-sm)] bg-[var(--ds-critical-tint)] px-3 py-2 text-[13px] text-[var(--ds-critical-text)]">
                    {t('vu.overCap', 'Gli extra hanno raggiunto il tetto di {{cap}}: alzalo per non perdere prenotazioni.', { cap: eur(plan.extraCapCents) })}
                </p>
            )}

            <div className="mt-4 border-t border-[var(--ds-border)] pt-3">
                <label htmlFor="voice-extra-cap" className="text-[13px] font-medium text-[var(--ds-text-primary)]">
                    {t('vu.capLabel', 'Tetto di spesa per i minuti extra')}
                </label>
                <p className="text-[12px] text-[var(--ds-text-muted)]">
                    {t('vu.capHint', 'Al mese, oltre il canone. 0 = nessun minuto extra.')}
                </p>
                <div className="mt-2 flex items-center gap-2">
                    <div className="relative w-32">
                        <input
                            id="voice-extra-cap"
                            inputMode="decimal"
                            value={capDraft}
                            disabled={!canEdit || saving}
                            onChange={e => setCapDraft(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') saveCap(); }}
                            className="h-11 w-full rounded-[var(--ds-radius-control)] border border-[var(--ds-border)] bg-[var(--ds-surface)] pl-3 pr-8 text-[14px] tabular-nums disabled:opacity-50"
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[14px] text-[var(--ds-text-muted)]">€</span>
                    </div>
                    {canEdit && (
                        <button
                            type="button"
                            onClick={saveCap}
                            disabled={!capDirty || saving}
                            className={`${dsButton.primary} h-11 px-4 text-[14px]`}
                        >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('vu.save', 'Salva')}
                        </button>
                    )}
                </div>
                {!capValid && capDraft.trim() !== '' && (
                    <p className="mt-1 text-[12px] text-[var(--ds-critical-text)]">{t('vu.capInvalid', 'Inserisci un importo da 0 a 1.000 €.')}</p>
                )}
            </div>

            {alertPercents && (
                <div className="mt-4 border-t border-[var(--ds-border)] pt-3">
                    <div id="voice-alerts-label" className="text-[13px] font-medium text-[var(--ds-text-primary)]">
                        {t('vu.alertsLabel', 'Avvisi sui minuti inclusi')}
                    </div>
                    <p className="text-[12px] text-[var(--ds-text-muted)]">
                        {t('vu.alertsHint', 'Notifica a titolare e direzione quando Sofia arriva a:')}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2" role="group" aria-labelledby="voice-alerts-label">
                        {VOICE_ALERT_PERCENT_OPTIONS.map(p => {
                            const on = alertPercents.includes(p);
                            return (
                                <button
                                    key={p}
                                    type="button"
                                    onClick={() => toggleAlert(p)}
                                    disabled={!canEdit || alertsSaving}
                                    aria-pressed={on}
                                    className={`inline-flex h-11 items-center rounded-[var(--ds-radius-control)] px-4 text-[14px] font-semibold tabular-nums transition-colors disabled:opacity-50 ${
                                        on
                                            ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                                            : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]'
                                    }`}
                                >
                                    {p}%
                                </button>
                            );
                        })}
                    </div>
                    {alertPercents.length === 0 && (
                        <p className="mt-1.5 text-[12px] text-[var(--ds-text-muted)]">
                            {t('vu.alertsNone', "Arriverà solo l'avviso sul tetto degli extra.")}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};
