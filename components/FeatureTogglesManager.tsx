import React, { useEffect, useRef, useState } from 'react';
import { Globe, Phone, Loader2, ChevronDown, Users, PauseCircle, Clock, CalendarClock, Plus, Trash2 } from 'lucide-react';
import { CookingPotLoader } from './CookingPotLoader';
import {
    getFeatureFlags,
    updateFeatureFlags,
    FeatureFlags,
    getChannelSettings,
    updateChannelSettings,
    ChannelSettings,
    ScheduledSuspension,
    PublicBookingBlock,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayISO(): string {
    // Local date, not UTC, so the picker default matches the user's calendar day.
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

type FlagKey = keyof FeatureFlags;

interface ChannelMeta {
    key: FlagKey;
    icon: React.ReactNode;
    title: string;
    description: string;
    onLabel: string;
    offLabel: string;
}

const CHANNELS: ChannelMeta[] = [
    {
        key: 'voice_agent_enabled',
        icon: <Phone className="w-5 h-5" />,
        title: 'Agente vocale (ElevenLabs)',
        description: 'Sofia prende le chiamate e gestisce prenotazioni, modifiche e cancellazioni via telefono.',
        onLabel: 'Attivo',
        offLabel: 'Sospeso',
    },
    {
        key: 'public_bookings_enabled',
        icon: <Globe className="w-5 h-5" />,
        title: 'Prenotazioni web',
        description: 'Modulo /prenota pubblico raggiungibile da Google e siti esterni.',
        onLabel: 'Attive',
        offLabel: 'Sospese',
    },
];

export const FeatureTogglesManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [flags, setFlags] = useState<FeatureFlags | null>(null);
    const [channels, setChannels] = useState<ChannelSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [savingKey, setSavingKey] = useState<FlagKey | null>(null);

    // Draft state for the voice large-group threshold — separate from the
    // persisted value so the input stays responsive while the user types.
    const [voiceThresholdDraft, setVoiceThresholdDraft] = useState<string>('');
    const [savingVoiceThreshold, setSavingVoiceThreshold] = useState(false);

    // Same pattern for the suspension callback time (HH:MM). The toggle
    // itself lives in FeatureFlags, but the callback hour is a ChannelSettings
    // string field so it can be edited without flipping the toggle.
    const [suspensionCallbackDraft, setSuspensionCallbackDraft] = useState<string>('');
    const [savingSuspensionCallback, setSavingSuspensionCallback] = useState(false);

    // Scheduled suspensions — one row per {date, start, end}. Draft is edited
    // in place; on Save we ship the whole array to the backend (simpler than
    // per-row PATCH and the list stays small).
    const [scheduleDraft, setScheduleDraft] = useState<ScheduledSuspension[]>([]);
    const [savingSchedule, setSavingSchedule] = useState(false);

    // Public-booking blocks: per-day / per-shift chiusure del canale web.
    // Draft-based edit come le suspension: aggiungi/rimuovi righe e salva
    // tutto l'array in un colpo solo. Il default per una nuova riga è
    // "domani, intera giornata" — l'operatore scegli il giorno più giusto.
    const [blocksDraft, setBlocksDraft] = useState<PublicBookingBlock[]>([]);
    const [savingBlocks, setSavingBlocks] = useState(false);

    // Keep showToast in a ref so the mount-fetch effect below has empty deps.
    // Parent (App.tsx) recreates addToast on every render, so listing showToast
    // as a dep would refetch on every parent re-render — which resets
    // scheduleDraft mid-edit and makes newly-added rows vanish.
    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [flagsData, channelsData] = await Promise.all([
                    getFeatureFlags(),
                    getChannelSettings(),
                ]);
                if (cancelled) return;
                setFlags(flagsData);
                setChannels(channelsData);
                setVoiceThresholdDraft(String(channelsData.voice_large_group_threshold));
                setSuspensionCallbackDraft(channelsData.voice_bookings_suspension_callback_time);
                setScheduleDraft(channelsData.voice_bookings_suspension_schedule ?? []);
                setBlocksDraft(channelsData.public_bookings_blocks ?? []);
            } catch (err: any) {
                if (!cancelled) showToastRef.current(err?.message || 'Errore nel caricamento delle impostazioni', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Labels used by the toast when a flag is flipped. CHANNELS covers the
    // accordion entries; sub-toggles nested inside a channel body (like the
    // suspension flag) need their own label here so the toast reads naturally.
    const FLAG_LABELS: Record<FlagKey, { title: string; on: string; off: string }> = {
        voice_agent_enabled: { title: 'Agente vocale', on: 'attivo', off: 'sospeso' },
        public_bookings_enabled: { title: 'Prenotazioni web', on: 'attive', off: 'sospese' },
        voice_bookings_suspended: { title: 'Prenotazioni telefoniche', on: 'sospese', off: 'riattivate' },
        // Managed from its own settings section (PayAtTableSettingsManager),
        // not from the booking-channels list; label kept here for type safety.
        pay_at_table_enabled: { title: 'Conto al tavolo', on: 'attivo', off: 'disattivato' },
        // Idem: gestito dalla sezione Comande, etichetta qui per type safety.
        table_orders_enabled: { title: 'Comande', on: 'attive', off: 'disattivate' },
    };

    const toggle = async (key: FlagKey) => {
        if (!flags || !canEdit || savingKey) return;
        const nextValue = !flags[key];
        const previous = flags;
        setFlags({ ...flags, [key]: nextValue });
        setSavingKey(key);
        try {
            const updated = await updateFeatureFlags({ [key]: nextValue } as Partial<FeatureFlags>);
            setFlags(updated);
            const label = FLAG_LABELS[key];
            showToast(`${label.title}: ${nextValue ? label.on : label.off}`, 'success');
        } catch (err: any) {
            setFlags(previous);
            showToast(err?.message || 'Errore aggiornamento impostazione', 'error');
        } finally {
            setSavingKey(null);
        }
    };

    const saveVoiceThreshold = async () => {
        if (!channels || !canEdit || savingVoiceThreshold) return;
        const n = Number(voiceThresholdDraft);
        if (!Number.isInteger(n) || n < 1 || n > 50) {
            showToast('La soglia deve essere un intero tra 1 e 50', 'error');
            return;
        }
        setSavingVoiceThreshold(true);
        try {
            const updated = await updateChannelSettings({ voice_large_group_threshold: n });
            setChannels(updated);
            setVoiceThresholdDraft(String(updated.voice_large_group_threshold));
            showToast('Soglia handoff aggiornata', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento soglia', 'error');
        } finally {
            setSavingVoiceThreshold(false);
        }
    };

    const saveSuspensionCallback = async () => {
        if (!channels || !canEdit || savingSuspensionCallback) return;
        const raw = suspensionCallbackDraft.trim();
        if (!HHMM_RE.test(raw)) {
            showToast("L'orario deve essere in formato HH:MM (00-23:00-59)", 'error');
            return;
        }
        setSavingSuspensionCallback(true);
        try {
            const updated = await updateChannelSettings({ voice_bookings_suspension_callback_time: raw });
            setChannels(updated);
            setSuspensionCallbackDraft(updated.voice_bookings_suspension_callback_time);
            showToast('Orario di richiamo aggiornato', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento orario', 'error');
        } finally {
            setSavingSuspensionCallback(false);
        }
    };

    const addScheduleRow = () => {
        setScheduleDraft(prev => [
            ...prev,
            { date: todayISO(), start_time: '12:00', end_time: '15:00', callback_time: '15:00' },
        ]);
    };
    const removeScheduleRow = (idx: number) => {
        setScheduleDraft(prev => prev.filter((_, i) => i !== idx));
    };
    const updateScheduleRow = (idx: number, patch: Partial<ScheduledSuspension>) => {
        setScheduleDraft(prev => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
    };
    const saveSchedule = async () => {
        if (!channels || !canEdit || savingSchedule) return;
        for (const [i, row] of scheduleDraft.entries()) {
            if (!ISO_DATE_RE.test(row.date)) {
                showToast(`Riga ${i + 1}: data non valida`, 'error'); return;
            }
            if (!HHMM_RE.test(row.start_time) || !HHMM_RE.test(row.end_time)) {
                showToast(`Riga ${i + 1}: orari non validi`, 'error'); return;
            }
            if (row.start_time >= row.end_time) {
                showToast(`Riga ${i + 1}: l'orario di inizio deve essere prima della fine`, 'error'); return;
            }
            if (row.callback_time && !HHMM_RE.test(row.callback_time)) {
                showToast(`Riga ${i + 1}: orario di richiamo non valido`, 'error'); return;
            }
        }
        setSavingSchedule(true);
        try {
            const updated = await updateChannelSettings({ voice_bookings_suspension_schedule: scheduleDraft });
            setChannels(updated);
            setScheduleDraft(updated.voice_bookings_suspension_schedule ?? []);
            showToast('Sospensioni programmate aggiornate', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento programma', 'error');
        } finally {
            setSavingSchedule(false);
        }
    };

    // Public-booking blocks: draft ops mirror the voice-suspension pattern.
    const addBlockRow = () => {
        // Default to tomorrow so l'operatore non blocca oggi per errore
        // durante un servizio in corso.
        const d = new Date();
        d.setDate(d.getDate() + 1);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        setBlocksDraft(prev => [...prev, { date: `${y}-${m}-${day}`, shift: 'ALL' }]);
    };
    const removeBlockRow = (idx: number) => {
        setBlocksDraft(prev => prev.filter((_, i) => i !== idx));
    };
    const updateBlockRow = (idx: number, patch: Partial<PublicBookingBlock>) => {
        setBlocksDraft(prev => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
    };
    const saveBlocks = async () => {
        if (!channels || !canEdit || savingBlocks) return;
        for (const [i, row] of blocksDraft.entries()) {
            if (!ISO_DATE_RE.test(row.date)) {
                showToast(`Blocco #${i + 1}: data non valida`, 'error'); return;
            }
            if (row.shift !== 'LUNCH' && row.shift !== 'DINNER' && row.shift !== 'ALL') {
                showToast(`Blocco #${i + 1}: turno non valido`, 'error'); return;
            }
        }
        setSavingBlocks(true);
        try {
            const updated = await updateChannelSettings({ public_bookings_blocks: blocksDraft });
            setChannels(updated);
            setBlocksDraft(updated.public_bookings_blocks ?? []);
            showToast('Blocchi prenotazioni web aggiornati', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento blocchi', 'error');
        } finally {
            setSavingBlocks(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-[var(--color-fg-muted)] text-[13px] py-2">
                <CookingPotLoader label="Caricamento…" size={40} />
            </div>
        );
    }
    if (!flags || !channels) return null;

    const voiceThresholdDirty = String(channels.voice_large_group_threshold) !== voiceThresholdDraft.trim();
    const suspensionCallbackDirty = channels.voice_bookings_suspension_callback_time !== suspensionCallbackDraft.trim();
    const suspended = flags.voice_bookings_suspended;
    const suspensionSaving = savingKey === 'voice_bookings_suspended';
    const scheduleDirty = JSON.stringify(channels.voice_bookings_suspension_schedule ?? []) !== JSON.stringify(scheduleDraft);
    const blocksDirty = JSON.stringify(channels.public_bookings_blocks ?? []) !== JSON.stringify(blocksDraft);
    const todayKey = todayISO();

    return (
        <div className="space-y-3">
            {CHANNELS.map((meta) => {
                const enabled = flags[meta.key];
                const isSaving = savingKey === meta.key;
                const isVoice = meta.key === 'voice_agent_enabled';
                const isWeb = meta.key === 'public_bookings_enabled';
                return (
                    <details
                        key={meta.key}
                        className="group bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden"
                    >
                        <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--color-surface-2)] transition-colors">
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center text-[var(--color-fg)] flex-shrink-0">
                                    {meta.icon}
                                </div>
                                <div className="min-w-0">
                                    <h4 className="font-medium text-[14px] text-[var(--color-fg)]">{meta.title}</h4>
                                    <p className="text-[12px] text-[var(--color-fg-muted)] truncate">{meta.description}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                                <span className={`text-[11px] font-medium uppercase tracking-wide ${enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--color-fg-subtle)]'}`}>
                                    {enabled ? meta.onLabel : meta.offLabel}
                                </span>
                                {/* stopPropagation so clicking the switch doesn't toggle the accordion */}
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={enabled}
                                    aria-label={`${enabled ? 'Disattiva' : 'Attiva'} ${meta.title}`}
                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(meta.key); }}
                                    disabled={!canEdit || isSaving}
                                    className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)] focus:ring-offset-2 focus:ring-offset-[var(--color-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                                        enabled ? 'bg-emerald-500' : 'bg-[var(--color-surface-3)] border border-[var(--color-line)]'
                                    }`}
                                >
                                    <span
                                        aria-hidden="true"
                                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                                            enabled ? 'translate-x-5' : 'translate-x-0.5'
                                        } translate-y-0.5`}
                                    />
                                </button>
                                <ChevronDown className="w-4 h-4 text-[var(--color-fg-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                            </div>
                        </summary>
                        <div className="px-4 pb-4 pt-3 border-t border-[var(--color-line)] space-y-3">
                            <p className="text-[13px] text-[var(--color-fg-muted)] leading-relaxed">{meta.description}</p>

                            {isVoice && (
                                <>
                                    <div className="rounded-md bg-[var(--color-surface-2)] border border-[var(--color-line)] p-3">
                                        <label className="flex items-start gap-2 text-[13px] text-[var(--color-fg)] font-medium">
                                            <Users className="h-4 w-4 mt-0.5 text-[var(--color-fg-muted)] flex-shrink-0" />
                                            <span>Soglia handoff gruppi grandi</span>
                                        </label>
                                        <p className="text-[12px] text-[var(--color-fg-muted)] mt-1 mb-2 leading-relaxed">
                                            Fino a questo numero di ospiti Sofia prenota da sola; oltre passa la richiamata a un operatore. Il calcolo di disponibilità del backend non è affidabile per gruppi grandi (verifica per tavoli singoli), quindi la soglia esiste per evitare risposte sbagliate al cliente.
                                        </p>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="number"
                                                min={1}
                                                max={50}
                                                value={voiceThresholdDraft}
                                                onChange={(e) => setVoiceThresholdDraft(e.target.value)}
                                                disabled={!canEdit || savingVoiceThreshold}
                                                className="w-20 h-9 px-2 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-fg)] tabular focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20 disabled:opacity-50"
                                            />
                                            <span className="text-[12px] text-[var(--color-fg-muted)]">
                                                Attualmente: prenotazioni fino a <strong className="text-[var(--color-fg)]">{channels.voice_large_group_threshold}</strong> ospiti gestite dall'agent.
                                            </span>
                                            <button
                                                type="button"
                                                onClick={saveVoiceThreshold}
                                                disabled={!canEdit || savingVoiceThreshold || !voiceThresholdDirty}
                                                className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] font-medium bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                            >
                                                {savingVoiceThreshold && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                                Salva
                                            </button>
                                        </div>
                                    </div>

                                    <div className={`rounded-md border p-3 transition-colors ${
                                        suspended
                                            ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-800'
                                            : 'bg-[var(--color-surface-2)] border-[var(--color-line)]'
                                    }`}>
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <label className="flex items-start gap-2 text-[13px] text-[var(--color-fg)] font-medium">
                                                    <PauseCircle className={`h-4 w-4 mt-0.5 flex-shrink-0 ${suspended ? 'text-amber-600 dark:text-amber-400' : 'text-[var(--color-fg-muted)]'}`} />
                                                    <span>Prenotazioni momentaneamente sospese</span>
                                                </label>
                                                <p className="text-[12px] text-[var(--color-fg-muted)] mt-1 leading-relaxed">
                                                    Quando attivo, Sofia risponde alla chiamata dicendo che le prenotazioni sono sospese e invita a richiamare dopo l'orario configurato. I tool <em>check-availability</em> e <em>create-reservation</em> vengono anche disabilitati come rete di sicurezza.
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                role="switch"
                                                aria-checked={suspended}
                                                aria-label={suspended ? 'Riattiva prenotazioni' : 'Sospendi prenotazioni'}
                                                onClick={() => toggle('voice_bookings_suspended')}
                                                disabled={!canEdit || suspensionSaving}
                                                className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)] focus:ring-offset-2 focus:ring-offset-[var(--color-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                                                    suspended ? 'bg-amber-500' : 'bg-[var(--color-surface-3)] border border-[var(--color-line)]'
                                                }`}
                                            >
                                                <span
                                                    aria-hidden="true"
                                                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                                                        suspended ? 'translate-x-5' : 'translate-x-0.5'
                                                    } translate-y-0.5`}
                                                />
                                            </button>
                                        </div>
                                        <div className="flex items-center gap-2 mt-3">
                                            <Clock className="h-4 w-4 text-[var(--color-fg-muted)] flex-shrink-0" />
                                            <span className="text-[12px] text-[var(--color-fg-muted)]">Richiamare dopo le</span>
                                            <input
                                                type="time"
                                                value={suspensionCallbackDraft}
                                                onChange={(e) => setSuspensionCallbackDraft(e.target.value)}
                                                disabled={!canEdit || savingSuspensionCallback}
                                                className="w-28 h-9 px-2 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-fg)] tabular focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20 disabled:opacity-50"
                                            />
                                            <button
                                                type="button"
                                                onClick={saveSuspensionCallback}
                                                disabled={!canEdit || savingSuspensionCallback || !suspensionCallbackDirty}
                                                className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] font-medium bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                            >
                                                {savingSuspensionCallback && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                                Salva
                                            </button>
                                        </div>
                                    </div>

                                    <div className="rounded-md bg-[var(--color-surface-2)] border border-[var(--color-line)] p-3">
                                        <label className="flex items-start gap-2 text-[13px] text-[var(--color-fg)] font-medium">
                                            <CalendarClock className="h-4 w-4 mt-0.5 text-[var(--color-fg-muted)] flex-shrink-0" />
                                            <span>Sospensioni programmate</span>
                                        </label>
                                        <p className="text-[12px] text-[var(--color-fg-muted)] mt-1 mb-3 leading-relaxed">
                                            Attiva la sospensione automaticamente in una o più finestre programmate (data + fascia oraria). Quando l'orario corrente entra in una finestra, Sofia annuncia la sospensione e invita il cliente a richiamare dopo l'orario di fine di quella finestra. Il toggle immediato qui sopra ha comunque la precedenza se acceso.
                                        </p>
                                        {scheduleDraft.length === 0 ? (
                                            <p className="text-[12px] text-[var(--color-fg-subtle)] italic mb-3">Nessuna sospensione programmata.</p>
                                        ) : (
                                            <div className="space-y-2 mb-3">
                                                {scheduleDraft.map((row, idx) => {
                                                    const isPast = row.date < todayKey;
                                                    return (
                                                        <div key={idx} className={`flex flex-wrap items-center gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] p-2 ${isPast ? 'opacity-60' : ''}`}>
                                                            <input
                                                                type="date"
                                                                value={row.date}
                                                                onChange={(e) => updateScheduleRow(idx, { date: e.target.value })}
                                                                disabled={!canEdit || savingSchedule}
                                                                className="h-9 px-2 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-fg)] tabular focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20 disabled:opacity-50"
                                                            />
                                                            <span className="text-[12px] text-[var(--color-fg-muted)]">dalle</span>
                                                            <input
                                                                type="time"
                                                                value={row.start_time}
                                                                onChange={(e) => updateScheduleRow(idx, { start_time: e.target.value })}
                                                                disabled={!canEdit || savingSchedule}
                                                                className="w-24 h-9 px-2 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-fg)] tabular focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20 disabled:opacity-50"
                                                            />
                                                            <span className="text-[12px] text-[var(--color-fg-muted)]">alle</span>
                                                            <input
                                                                type="time"
                                                                value={row.end_time}
                                                                onChange={(e) => updateScheduleRow(idx, { end_time: e.target.value })}
                                                                disabled={!canEdit || savingSchedule}
                                                                className="w-24 h-9 px-2 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-fg)] tabular focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20 disabled:opacity-50"
                                                            />
                                                            <span className="text-[12px] text-[var(--color-fg-muted)] whitespace-nowrap" title="Orario che Sofia comunica al cliente per richiamare">richiamare dopo le</span>
                                                            <input
                                                                type="time"
                                                                value={row.callback_time ?? row.end_time}
                                                                onChange={(e) => updateScheduleRow(idx, { callback_time: e.target.value })}
                                                                disabled={!canEdit || savingSchedule}
                                                                className="w-24 h-9 px-2 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-fg)] tabular focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20 disabled:opacity-50"
                                                            />
                                                            {isPast && (
                                                                <span className="text-[11px] text-[var(--color-fg-subtle)] italic">passata</span>
                                                            )}
                                                            <button
                                                                type="button"
                                                                onClick={() => removeScheduleRow(idx)}
                                                                disabled={!canEdit || savingSchedule}
                                                                aria-label="Rimuovi sospensione programmata"
                                                                className="ml-auto inline-flex items-center justify-center h-9 w-9 rounded-md text-[var(--color-fg-muted)] hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                                            >
                                                                <Trash2 className="h-4 w-4" />
                                                            </button>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={addScheduleRow}
                                                disabled={!canEdit || savingSchedule}
                                                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] font-medium border border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-fg)] hover:bg-[var(--color-surface-3)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                                Aggiungi
                                            </button>
                                            <button
                                                type="button"
                                                onClick={saveSchedule}
                                                disabled={!canEdit || savingSchedule || !scheduleDirty}
                                                className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] font-medium bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                            >
                                                {savingSchedule && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                                Salva programma
                                            </button>
                                        </div>
                                    </div>
                                </>
                            )}

                            {isWeb && (
                                <div className="rounded-md bg-[var(--color-surface-2)] border border-[var(--color-line)] p-3">
                                    <div className="flex items-start justify-between gap-2">
                                        <div>
                                            <div className="flex items-center gap-2 text-[13px] text-[var(--color-fg)] font-medium">
                                                <CalendarClock className="h-4 w-4 text-[var(--color-fg-muted)]" />
                                                <span>Blocca prenotazioni web per giorni specifici</span>
                                            </div>
                                            <p className="text-[12px] text-[var(--color-fg-muted)] mt-1 leading-relaxed">
                                                Chiudi il canale web per un turno (pranzo o cena) o per l'intera giornata. Il modulo /prenota nasconde gli slot bloccati e rifiuta eventuali tentativi POST diretti. I blocchi già scaduti vengono rimossi automaticamente al prossimo caricamento.
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={addBlockRow}
                                            disabled={!canEdit || savingBlocks}
                                            className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-[12px] font-medium border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                            Aggiungi
                                        </button>
                                    </div>

                                    <div className="mt-3 space-y-2">
                                        {blocksDraft.length === 0 ? (
                                            <p className="text-[12px] text-[var(--color-fg-subtle)] italic py-1">
                                                Nessun blocco programmato. Il canale web è aperto tutti i giorni.
                                            </p>
                                        ) : (
                                            blocksDraft.map((row, idx) => {
                                                const inPast = row.date && row.date < todayKey;
                                                return (
                                                    <div key={idx} className={`flex flex-wrap items-center gap-2 rounded-md border p-2 ${inPast ? 'border-amber-300 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/[0.08]' : 'border-[var(--color-line)] bg-[var(--color-surface)]'}`}>
                                                        <input
                                                            type="date"
                                                            value={row.date}
                                                            min={todayKey}
                                                            onChange={(e) => updateBlockRow(idx, { date: e.target.value })}
                                                            disabled={!canEdit || savingBlocks}
                                                            className="h-8 px-2 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface-2)] text-[var(--color-fg)] text-[12px] tabular focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20 disabled:opacity-50"
                                                        />
                                                        <select
                                                            value={row.shift}
                                                            onChange={(e) => updateBlockRow(idx, { shift: e.target.value as PublicBookingBlock['shift'] })}
                                                            disabled={!canEdit || savingBlocks}
                                                            className="h-8 px-2 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface-2)] text-[var(--color-fg)] text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20 disabled:opacity-50"
                                                        >
                                                            <option value="ALL">Intera giornata</option>
                                                            <option value="LUNCH">Solo pranzo</option>
                                                            <option value="DINNER">Solo cena</option>
                                                        </select>
                                                        {inPast && (
                                                            <span className="text-[11px] text-amber-700 dark:text-amber-300">Data già passata</span>
                                                        )}
                                                        <button
                                                            type="button"
                                                            onClick={() => removeBlockRow(idx)}
                                                            disabled={!canEdit || savingBlocks}
                                                            className="ml-auto inline-flex items-center justify-center h-7 w-7 rounded-md text-[var(--color-fg-muted)] hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/15 disabled:opacity-50 transition-colors"
                                                            aria-label="Rimuovi blocco"
                                                            title="Rimuovi"
                                                        >
                                                            <Trash2 className="h-3.5 w-3.5" />
                                                        </button>
                                                    </div>
                                                );
                                            })
                                        )}
                                    </div>

                                    <div className="mt-3 flex items-center justify-end">
                                        <button
                                            type="button"
                                            onClick={saveBlocks}
                                            disabled={!canEdit || savingBlocks || !blocksDirty}
                                            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] font-medium bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                        >
                                            {savingBlocks && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                            Salva blocchi
                                        </button>
                                    </div>
                                </div>
                            )}

                            {!isVoice && !isWeb && (
                                <p className="text-[12px] text-[var(--color-fg-subtle)] italic">
                                    Nessuna impostazione specifica al momento oltre a Attivo / Sospeso.
                                </p>
                            )}
                        </div>
                    </details>
                );
            })}
            {!canEdit && (
                <p className="text-[12px] text-[var(--color-fg-subtle)] mt-1">
                    Solo gli amministratori possono modificare queste impostazioni.
                </p>
            )}
        </div>
    );
};
