import React, { useEffect, useRef, useState } from 'react';
import { Globe, Phone, Loader2, ChevronDown, Users, PauseCircle, Clock, CalendarClock, Plus, Trash2, Percent, MessageSquare } from 'lucide-react';
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
    VoiceDateBlock,
    RoomOccupancyCap,
    RoomOccupancyRow,
    RoomOccupancyShift,
    getRoomsOccupancy,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import { SHIFT_WINDOWS } from './BookingChannelsBar';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The shift shown in a suspension row is derived from its times, never stored:
// an entry whose window matches a full service reads as Pranzo/Cena (including
// the ones created from the reception header's channel toggles), anything else
// is a custom window.
type SuspensionShift = 'LUNCH' | 'DINNER' | 'CUSTOM';
function suspensionShiftOf(row: ScheduledSuspension): SuspensionShift {
    for (const shift of ['LUNCH', 'DINNER'] as const) {
        const w = SHIFT_WINDOWS[shift];
        if (row.start_time === w.start && row.end_time === w.end) return shift;
    }
    return 'CUSTOM';
}

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

    // Messaggio iniziale di Sofia. Testo libero, salvato in ChannelSettings;
    // vuoto = default di sistema. Draft separato per digitazione fluida.
    const [voiceFirstMessageDraft, setVoiceFirstMessageDraft] = useState<string>('');
    const [savingVoiceFirstMessage, setSavingVoiceFirstMessage] = useState(false);

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

    // Blocchi dell'agente vocale sulla data richiesta (giorni "solo operatore",
    // es. festività a menù fisso). Stesso pattern draft dei blocchi web.
    const [voiceBlocksDraft, setVoiceBlocksDraft] = useState<VoiceDateBlock[]>([]);
    const [savingVoiceBlocks, setSavingVoiceBlocks] = useState(false);

    // Limiti di occupazione per sala. `occupancy` è solo informativo (quanto
    // è piena ogni sala oggi) e serve anche a elencare le sale disponibili,
    // dato che il draft contiene solo quelle con un limite attivo.
    const [occupancy, setOccupancy] = useState<RoomOccupancyRow[]>([]);
    const [capsDraft, setCapsDraft] = useState<RoomOccupancyCap[]>([]);
    const [savingCaps, setSavingCaps] = useState(false);

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
                setVoiceFirstMessageDraft(channelsData.voice_first_message ?? '');
                setScheduleDraft(channelsData.voice_bookings_suspension_schedule ?? []);
                setBlocksDraft(channelsData.public_bookings_blocks ?? []);
                setVoiceBlocksDraft(channelsData.voice_bookings_date_blocks ?? []);
                setCapsDraft(channelsData.room_occupancy_caps ?? []);
                // L'occupazione è un di più: se fallisce mostriamo comunque i
                // limiti, senza le percentuali live accanto.
                try {
                    const occ = await getRoomsOccupancy();
                    if (!cancelled) setOccupancy(occ.rooms ?? []);
                } catch (occErr) {
                    console.warn('[channels] room occupancy unavailable:', occErr);
                }
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
        // Idem: gestito da AiMessagesSettingsManager.
        ai_messages_enabled: { title: 'Messaggi con AI', on: 'attivi', off: 'disattivati' },
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

    const saveVoiceFirstMessage = async () => {
        if (!channels || !canEdit || savingVoiceFirstMessage) return;
        const raw = voiceFirstMessageDraft.trim();
        if (raw.length > 500) {
            showToast('Il messaggio può essere al massimo 500 caratteri', 'error');
            return;
        }
        setSavingVoiceFirstMessage(true);
        try {
            const updated = await updateChannelSettings({ voice_first_message: raw });
            setChannels(updated);
            setVoiceFirstMessageDraft(updated.voice_first_message ?? '');
            showToast(raw ? 'Messaggio iniziale aggiornato' : 'Messaggio iniziale ripristinato al default', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento messaggio', 'error');
        } finally {
            setSavingVoiceFirstMessage(false);
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
            { date: todayISO(), start_time: SHIFT_WINDOWS.LUNCH.start, end_time: SHIFT_WINDOWS.LUNCH.end, callback_time: SHIFT_WINDOWS.LUNCH.end },
        ]);
    };
    const removeScheduleRow = (idx: number) => {
        setScheduleDraft(prev => prev.filter((_, i) => i !== idx));
    };
    const updateScheduleRow = (idx: number, patch: Partial<ScheduledSuspension>) => {
        setScheduleDraft(prev => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
    };
    const setScheduleRowShift = (idx: number, shift: SuspensionShift) => {
        if (shift === 'CUSTOM') {
            // Nudge the start so the times stop matching a full shift and the
            // row stays in "fascia oraria" mode with the inputs visible.
            setScheduleDraft(prev => prev.map((row, i) => {
                if (i !== idx || suspensionShiftOf(row) === 'CUSTOM') return row;
                return { ...row, start_time: '12:00', end_time: '15:00', callback_time: row.callback_time ?? '15:00' };
            }));
            return;
        }
        const w = SHIFT_WINDOWS[shift];
        updateScheduleRow(idx, { start_time: w.start, end_time: w.end, callback_time: w.end });
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

    // Blocchi voce sulla data richiesta: stesse operazioni draft dei blocchi
    // web, con in più il testo libero "quando richiamare" letto da Sofia.
    const addVoiceBlockRow = () => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        setVoiceBlocksDraft(prev => [...prev, { date: `${y}-${m}-${day}`, shift: 'ALL' }]);
    };
    const removeVoiceBlockRow = (idx: number) => {
        setVoiceBlocksDraft(prev => prev.filter((_, i) => i !== idx));
    };
    const updateVoiceBlockRow = (idx: number, patch: Partial<VoiceDateBlock>) => {
        setVoiceBlocksDraft(prev => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
    };
    const saveVoiceBlocks = async () => {
        if (!channels || !canEdit || savingVoiceBlocks) return;
        for (const [i, row] of voiceBlocksDraft.entries()) {
            if (!ISO_DATE_RE.test(row.date)) {
                showToast(`Blocco #${i + 1}: data non valida`, 'error'); return;
            }
            if (row.shift !== 'LUNCH' && row.shift !== 'DINNER' && row.shift !== 'ALL') {
                showToast(`Blocco #${i + 1}: turno non valido`, 'error'); return;
            }
            if (row.callback_hours && row.callback_hours.length > 120) {
                showToast(`Blocco #${i + 1}: testo "quando richiamare" troppo lungo (max 120 caratteri)`, 'error'); return;
            }
        }
        setSavingVoiceBlocks(true);
        try {
            const updated = await updateChannelSettings({ voice_bookings_date_blocks: voiceBlocksDraft });
            setChannels(updated);
            setVoiceBlocksDraft(updated.voice_bookings_date_blocks ?? []);
            showToast('Giorni bloccati per Sofia aggiornati', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento blocchi', 'error');
        } finally {
            setSavingVoiceBlocks(false);
        }
    };

    // Riempimento di un turno: "chiusa" quando la sala non apre (per sempre o
    // solo per quel turno), altrimenti la percentuale, in ambra se ha già
    // raggiunto il limite.
    const renderShiftFill = (shift: RoomOccupancyShift, percent: number, roomClosed: boolean) => {
        if (roomClosed || shift.closed_for_shift) {
            return <em className="not-italic text-[var(--ds-text-subtle)]">chiusa</em>;
        }
        return (
            <strong className={shift.at_cap ? 'text-[var(--ds-pending-text)]' : 'text-[var(--ds-text-muted)]'}>
                {percent}%
            </strong>
        );
    };

    // Limiti per sala: il draft contiene una riga solo per le sale limitate.
    // Attivare il limite su una sala nuova parte da 70% sui tavoli — la
    // soglia dell'esempio più comune, comunque modificabile subito.
    const DEFAULT_CAP_PERCENT = 70;
    const capFor = (roomId: number): RoomOccupancyCap | undefined => capsDraft.find(c => c.room_id === roomId);
    const toggleCap = (roomId: number) => {
        setCapsDraft(prev => prev.some(c => c.room_id === roomId)
            ? prev.filter(c => c.room_id !== roomId)
            : [...prev, { room_id: roomId, percent: DEFAULT_CAP_PERCENT, basis: 'TABLES' }]);
    };
    const updateCap = (roomId: number, patch: Partial<RoomOccupancyCap>) => {
        setCapsDraft(prev => prev.map(c => (c.room_id === roomId ? { ...c, ...patch } : c)));
    };
    const saveCaps = async () => {
        if (!channels || !canEdit || savingCaps) return;
        for (const cap of capsDraft) {
            if (!Number.isInteger(cap.percent) || cap.percent < 1 || cap.percent > 100) {
                const roomName = occupancy.find(r => r.room_id === cap.room_id)?.room_name ?? `sala ${cap.room_id}`;
                showToast(`${roomName}: la percentuale deve essere un intero tra 1 e 100`, 'error');
                return;
            }
        }
        setSavingCaps(true);
        try {
            const updated = await updateChannelSettings({ room_occupancy_caps: capsDraft });
            setChannels(updated);
            setCapsDraft(updated.room_occupancy_caps ?? []);
            // Le percentuali live non cambiano salvando, ma il flag "al
            // limite" sì: ricaricalo così la UI non mente.
            try {
                const occ = await getRoomsOccupancy();
                setOccupancy(occ.rooms ?? []);
            } catch (occErr) {
                console.warn('[channels] room occupancy refresh failed:', occErr);
            }
            showToast('Limiti di occupazione aggiornati', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento limiti', 'error');
        } finally {
            setSavingCaps(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-[var(--ds-text-muted)] text-[13px] py-2">
                <CookingPotLoader label="Caricamento…" size={40} />
            </div>
        );
    }
    if (!flags || !channels) return null;

    const voiceThresholdDirty = String(channels.voice_large_group_threshold) !== voiceThresholdDraft.trim();
    const suspensionCallbackDirty = channels.voice_bookings_suspension_callback_time !== suspensionCallbackDraft.trim();
    const voiceFirstMessageDirty = (channels.voice_first_message ?? '') !== voiceFirstMessageDraft.trim();
    const suspended = flags.voice_bookings_suspended;
    const suspensionSaving = savingKey === 'voice_bookings_suspended';
    const scheduleDirty = JSON.stringify(channels.voice_bookings_suspension_schedule ?? []) !== JSON.stringify(scheduleDraft);
    const blocksDirty = JSON.stringify(channels.public_bookings_blocks ?? []) !== JSON.stringify(blocksDraft);
    const voiceBlocksDirty = JSON.stringify(channels.voice_bookings_date_blocks ?? []) !== JSON.stringify(voiceBlocksDraft);
    // Il backend riordina i cap per room_id: confronta ordinato, altrimenti
    // togliere e rimettere lo stesso limite lascerebbe il tasto Salva acceso.
    const sortCaps = (list: RoomOccupancyCap[]) => [...list].sort((a, b) => a.room_id - b.room_id);
    const capsDirty = JSON.stringify(sortCaps(channels.room_occupancy_caps ?? [])) !== JSON.stringify(sortCaps(capsDraft));
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
                        className="group bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] overflow-hidden"
                    >
                        <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--ds-surface-row)] transition-colors">
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-text-primary)] flex-shrink-0">
                                    {meta.icon}
                                </div>
                                <div className="min-w-0">
                                    <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">{meta.title}</h4>
                                    <p className="text-[12px] text-[var(--ds-text-muted)] truncate">{meta.description}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                                <span className={`text-[12px] font-medium ${enabled ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-text-subtle)]'}`}>
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
                                    className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                                        enabled ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                                    }`}
                                >
                                    <span
                                        aria-hidden="true"
                                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                                            enabled ? 'translate-x-5' : 'translate-x-0.5'
                                        } translate-y-0.5`}
                                    />
                                </button>
                                <ChevronDown className="w-4 h-4 text-[var(--ds-text-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                            </div>
                        </summary>
                        <div className="px-4 pb-4 pt-3 border-t border-[var(--ds-border)] space-y-3">
                            <p className="text-[13px] text-[var(--ds-text-muted)] leading-relaxed">{meta.description}</p>

                            {isVoice && (
                                <>
                                    <div className="rounded-md bg-[var(--ds-surface-row)] border border-[var(--ds-border)] p-3">
                                        <label className="flex items-start gap-2 text-[13px] text-[var(--ds-text-primary)] font-medium">
                                            <MessageSquare className="h-4 w-4 mt-0.5 text-[var(--ds-text-muted)] flex-shrink-0" />
                                            <span>Messaggio iniziale di Sofia</span>
                                        </label>
                                        <p className="text-[12px] text-[var(--ds-text-muted)] mt-1 mb-2 leading-relaxed">
                                            La prima frase che Sofia pronuncia alla risposta. Modificalo qui invece che su ElevenLabs. Usa <code className="px-1 rounded bg-[var(--ds-surface)] text-[var(--ds-text-secondary)]">{'{nome}'}</code> per inserire il nome del cliente quando il numero è riconosciuto (viene tolto per i chiamanti sconosciuti). Lascia vuoto per usare il messaggio predefinito.
                                        </p>
                                        <textarea
                                            rows={3}
                                            maxLength={500}
                                            value={voiceFirstMessageDraft}
                                            onChange={(e) => setVoiceFirstMessageDraft(e.target.value)}
                                            disabled={!canEdit || savingVoiceFirstMessage}
                                            placeholder="Es. Ciao {nome}, sono Sofia del ristorante, come posso aiutarti?"
                                            className="w-full px-2.5 py-2 rounded-md border border-[var(--ds-border-strong)] bg-[var(--ds-surface)] text-[13px] text-[var(--ds-text-primary)] leading-relaxed resize-y focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                        />
                                        <div className="flex items-center gap-2 mt-2">
                                            <span className="text-[12px] text-[var(--ds-text-muted)] tabular">{voiceFirstMessageDraft.trim().length}/500</span>
                                            <button
                                                type="button"
                                                onClick={saveVoiceFirstMessage}
                                                disabled={!canEdit || savingVoiceFirstMessage || !voiceFirstMessageDirty}
                                                className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] font-medium bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                            >
                                                {savingVoiceFirstMessage && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                                Salva
                                            </button>
                                        </div>
                                    </div>

                                    <div className="rounded-md bg-[var(--ds-surface-row)] border border-[var(--ds-border)] p-3">
                                        <label className="flex items-start gap-2 text-[13px] text-[var(--ds-text-primary)] font-medium">
                                            <Users className="h-4 w-4 mt-0.5 text-[var(--ds-text-muted)] flex-shrink-0" />
                                            <span>Soglia handoff gruppi grandi</span>
                                        </label>
                                        <p className="text-[12px] text-[var(--ds-text-muted)] mt-1 mb-2 leading-relaxed">
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
                                                className="w-20 h-9 px-2 rounded-md border border-[var(--ds-border-strong)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] tabular focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                            />
                                            <span className="text-[12px] text-[var(--ds-text-muted)]">
                                                Attualmente: prenotazioni fino a <strong className="text-[var(--ds-text-primary)]">{channels.voice_large_group_threshold}</strong> ospiti gestite dall'agent.
                                            </span>
                                            <button
                                                type="button"
                                                onClick={saveVoiceThreshold}
                                                disabled={!canEdit || savingVoiceThreshold || !voiceThresholdDirty}
                                                className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] font-medium bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                            >
                                                {savingVoiceThreshold && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                                Salva
                                            </button>
                                        </div>
                                    </div>

                                    <div className={`rounded-md border p-3 transition-colors ${
                                        suspended
                                            ? 'bg-[var(--ds-pending-tint)] border-[var(--ds-pending-solid)]'
                                            : 'bg-[var(--ds-surface-row)] border-[var(--ds-border)]'
                                    }`}>
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <label className="flex items-start gap-2 text-[13px] text-[var(--ds-text-primary)] font-medium">
                                                    <PauseCircle className={`h-4 w-4 mt-0.5 flex-shrink-0 ${suspended ? 'text-[var(--ds-pending-text)]' : 'text-[var(--ds-text-muted)]'}`} />
                                                    <span>Prenotazioni momentaneamente sospese</span>
                                                </label>
                                                <p className="text-[12px] text-[var(--ds-text-muted)] mt-1 leading-relaxed">
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
                                                className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                                                    suspended ? 'bg-[var(--ds-pending-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
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
                                            <Clock className="h-4 w-4 text-[var(--ds-text-muted)] flex-shrink-0" />
                                            <span className="text-[12px] text-[var(--ds-text-muted)]">Richiamare dopo le</span>
                                            <input
                                                type="time"
                                                value={suspensionCallbackDraft}
                                                onChange={(e) => setSuspensionCallbackDraft(e.target.value)}
                                                disabled={!canEdit || savingSuspensionCallback}
                                                className="w-28 h-9 px-2 rounded-md border border-[var(--ds-border-strong)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] tabular focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                            />
                                            <button
                                                type="button"
                                                onClick={saveSuspensionCallback}
                                                disabled={!canEdit || savingSuspensionCallback || !suspensionCallbackDirty}
                                                className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] font-medium bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                            >
                                                {savingSuspensionCallback && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                                Salva
                                            </button>
                                        </div>
                                    </div>

                                    <div className="rounded-md bg-[var(--ds-surface-row)] border border-[var(--ds-border)] p-3">
                                        <label className="flex items-start gap-2 text-[13px] text-[var(--ds-text-primary)] font-medium">
                                            <CalendarClock className="h-4 w-4 mt-0.5 text-[var(--ds-text-muted)] flex-shrink-0" />
                                            <span>Sospensioni programmate</span>
                                        </label>
                                        <p className="text-[12px] text-[var(--ds-text-muted)] mt-1 mb-3 leading-relaxed">
                                            Attiva la sospensione automaticamente in una o più finestre programmate: scegli il giorno e un turno intero (pranzo o cena), oppure una fascia oraria personalizzata. Quando l'orario corrente entra in una finestra, Sofia annuncia la sospensione e invita il cliente a richiamare dopo l'orario di fine di quella finestra. Il toggle immediato qui sopra ha comunque la precedenza se acceso.
                                        </p>
                                        {scheduleDraft.length === 0 ? (
                                            <p className="text-[12px] text-[var(--ds-text-subtle)] italic mb-3">Nessuna sospensione programmata.</p>
                                        ) : (
                                            <div className="space-y-2 mb-3">
                                                {scheduleDraft.map((row, idx) => {
                                                    const isPast = row.date < todayKey;
                                                    const rowShift = suspensionShiftOf(row);
                                                    return (
                                                        <div key={idx} className={`flex flex-wrap items-center gap-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] p-2 ${isPast ? 'opacity-60' : ''}`}>
                                                            <input
                                                                type="date"
                                                                value={row.date}
                                                                onChange={(e) => updateScheduleRow(idx, { date: e.target.value })}
                                                                disabled={!canEdit || savingSchedule}
                                                                className="h-9 px-2 rounded-md border border-[var(--ds-border-strong)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] tabular focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                                            />
                                                            <select
                                                                value={rowShift}
                                                                onChange={(e) => setScheduleRowShift(idx, e.target.value as SuspensionShift)}
                                                                disabled={!canEdit || savingSchedule}
                                                                aria-label="Turno della sospensione"
                                                                className="h-9 px-2 rounded-md border border-[var(--ds-border-strong)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                                            >
                                                                <option value="LUNCH">Pranzo</option>
                                                                <option value="DINNER">Cena</option>
                                                                <option value="CUSTOM">Fascia oraria</option>
                                                            </select>
                                                            {rowShift === 'CUSTOM' ? (
                                                                <>
                                                                    <span className="text-[12px] text-[var(--ds-text-muted)]">dalle</span>
                                                                    <input
                                                                        type="time"
                                                                        value={row.start_time}
                                                                        onChange={(e) => updateScheduleRow(idx, { start_time: e.target.value })}
                                                                        disabled={!canEdit || savingSchedule}
                                                                        className="w-24 h-9 px-2 rounded-md border border-[var(--ds-border-strong)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] tabular focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                                                    />
                                                                    <span className="text-[12px] text-[var(--ds-text-muted)]">alle</span>
                                                                    <input
                                                                        type="time"
                                                                        value={row.end_time}
                                                                        onChange={(e) => updateScheduleRow(idx, { end_time: e.target.value })}
                                                                        disabled={!canEdit || savingSchedule}
                                                                        className="w-24 h-9 px-2 rounded-md border border-[var(--ds-border-strong)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] tabular focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                                                    />
                                                                </>
                                                            ) : (
                                                                <span className="text-[12px] text-[var(--ds-text-muted)] tabular whitespace-nowrap" title="Finestra coperta dal turno">
                                                                    {row.start_time}–{row.end_time}
                                                                </span>
                                                            )}
                                                            <span className="text-[12px] text-[var(--ds-text-muted)] whitespace-nowrap" title="Orario che Sofia comunica al cliente per richiamare">richiamare dopo le</span>
                                                            <input
                                                                type="time"
                                                                value={row.callback_time ?? row.end_time}
                                                                onChange={(e) => updateScheduleRow(idx, { callback_time: e.target.value })}
                                                                disabled={!canEdit || savingSchedule}
                                                                className="w-24 h-9 px-2 rounded-md border border-[var(--ds-border-strong)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] tabular focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                                            />
                                                            {isPast && (
                                                                <span className="text-[11px] text-[var(--ds-text-subtle)] italic">passata</span>
                                                            )}
                                                            <button
                                                                type="button"
                                                                onClick={() => removeScheduleRow(idx)}
                                                                disabled={!canEdit || savingSchedule}
                                                                aria-label="Rimuovi sospensione programmata"
                                                                className="ml-auto inline-flex items-center justify-center h-9 w-9 rounded-md text-[var(--ds-text-muted)] hover:text-[var(--ds-critical-text)] hover:bg-[var(--ds-critical-tint)] dark:hover:bg-[var(--ds-critical-tint)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
                                                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] font-medium border border-[var(--ds-border-strong)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                                Aggiungi
                                            </button>
                                            <button
                                                type="button"
                                                onClick={saveSchedule}
                                                disabled={!canEdit || savingSchedule || !scheduleDirty}
                                                className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] font-medium bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                            >
                                                {savingSchedule && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                                Salva programma
                                            </button>
                                        </div>
                                    </div>

                                    <div className="rounded-md bg-[var(--ds-surface-row)] border border-[var(--ds-border)] p-3">
                                        <div className="flex items-start justify-between gap-2">
                                            <div>
                                                <div className="flex items-center gap-2 text-[13px] text-[var(--ds-text-primary)] font-medium">
                                                    <CalendarClock className="h-4 w-4 text-[var(--ds-text-muted)]" />
                                                    <span>Giorni gestiti solo da operatore</span>
                                                </div>
                                                <p className="text-[12px] text-[var(--ds-text-muted)] mt-1 leading-relaxed">
                                                    Sofia non prende prenotazioni <em>per</em> questi giorni (o turni), qualunque sia il momento della chiamata: utile quando c'è un menù fisso o un evento che vuoi gestire a mano. Al cliente che chiede una data bloccata Sofia dice che se ne occupa lo staff e lo invita a richiamare negli orari indicati. Le altre date restano prenotabili normalmente. I blocchi già passati spariscono da soli.
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={addVoiceBlockRow}
                                                disabled={!canEdit || savingVoiceBlocks}
                                                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-[12px] font-medium border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                                Aggiungi
                                            </button>
                                        </div>

                                        <div className="mt-3 space-y-2">
                                            {voiceBlocksDraft.length === 0 ? (
                                                <p className="text-[12px] text-[var(--ds-text-subtle)] italic py-1">
                                                    Nessun giorno bloccato. Sofia prenota per qualsiasi data.
                                                </p>
                                            ) : (
                                                voiceBlocksDraft.map((row, idx) => {
                                                    const inPast = row.date && row.date < todayKey;
                                                    return (
                                                        <div key={idx} className={`flex flex-wrap items-center gap-2 rounded-md border p-2 ${inPast ? 'border-[var(--ds-pending-solid)] bg-[var(--ds-pending-tint)]' : 'border-[var(--ds-border)] bg-[var(--ds-surface)]'}`}>
                                                            <input
                                                                type="date"
                                                                value={row.date}
                                                                min={todayKey}
                                                                onChange={(e) => updateVoiceBlockRow(idx, { date: e.target.value })}
                                                                disabled={!canEdit || savingVoiceBlocks}
                                                                className="h-8 px-2 rounded border border-[var(--ds-border-strong)] bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] text-[12px] tabular focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                                            />
                                                            <select
                                                                value={row.shift}
                                                                onChange={(e) => updateVoiceBlockRow(idx, { shift: e.target.value as VoiceDateBlock['shift'] })}
                                                                disabled={!canEdit || savingVoiceBlocks}
                                                                className="h-8 px-2 rounded border border-[var(--ds-border-strong)] bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] text-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                                            >
                                                                <option value="ALL">Intera giornata</option>
                                                                <option value="LUNCH">Solo pranzo</option>
                                                                <option value="DINNER">Solo cena</option>
                                                            </select>
                                                            <span className="text-[12px] text-[var(--ds-text-muted)] whitespace-nowrap" title="Quando Sofia invita a richiamare per parlare con un operatore">richiamare</span>
                                                            <input
                                                                type="text"
                                                                value={row.callback_hours ?? ''}
                                                                onChange={(e) => updateVoiceBlockRow(idx, { callback_hours: e.target.value })}
                                                                placeholder="es. dalle 9:00 alle 12:00"
                                                                maxLength={120}
                                                                disabled={!canEdit || savingVoiceBlocks}
                                                                className="flex-1 min-w-[160px] h-8 px-2 rounded border border-[var(--ds-border-strong)] bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] text-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50 placeholder:text-[var(--ds-text-subtle)]"
                                                            />
                                                            {inPast && (
                                                                <span className="text-[11px] text-[var(--ds-pending-text)]">Data già passata</span>
                                                            )}
                                                            <button
                                                                type="button"
                                                                onClick={() => removeVoiceBlockRow(idx)}
                                                                disabled={!canEdit || savingVoiceBlocks}
                                                                className="ml-auto inline-flex items-center justify-center h-7 w-7 rounded-md text-[var(--ds-text-muted)] hover:text-[var(--ds-critical-text)] hover:bg-[var(--ds-critical-tint)] dark:hover:bg-[var(--ds-critical-tint)] disabled:opacity-50 transition-colors"
                                                                aria-label="Rimuovi giorno bloccato"
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
                                                onClick={saveVoiceBlocks}
                                                disabled={!canEdit || savingVoiceBlocks || !voiceBlocksDirty}
                                                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] font-medium bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                            >
                                                {savingVoiceBlocks && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                                Salva blocchi
                                            </button>
                                        </div>
                                    </div>
                                </>
                            )}

                            {isWeb && (
                                <div className="rounded-md bg-[var(--ds-surface-row)] border border-[var(--ds-border)] p-3">
                                    <div className="flex items-start justify-between gap-2">
                                        <div>
                                            <div className="flex items-center gap-2 text-[13px] text-[var(--ds-text-primary)] font-medium">
                                                <CalendarClock className="h-4 w-4 text-[var(--ds-text-muted)]" />
                                                <span>Blocca prenotazioni web per giorni specifici</span>
                                            </div>
                                            <p className="text-[12px] text-[var(--ds-text-muted)] mt-1 leading-relaxed">
                                                Chiudi il canale web per un turno (pranzo o cena) o per l'intera giornata. Il modulo /prenota nasconde gli slot bloccati e rifiuta eventuali tentativi POST diretti. I blocchi già scaduti vengono rimossi automaticamente al prossimo caricamento.
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={addBlockRow}
                                            disabled={!canEdit || savingBlocks}
                                            className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-[12px] font-medium border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                            Aggiungi
                                        </button>
                                    </div>

                                    <div className="mt-3 space-y-2">
                                        {blocksDraft.length === 0 ? (
                                            <p className="text-[12px] text-[var(--ds-text-subtle)] italic py-1">
                                                Nessun blocco programmato. Il canale web è aperto tutti i giorni.
                                            </p>
                                        ) : (
                                            blocksDraft.map((row, idx) => {
                                                const inPast = row.date && row.date < todayKey;
                                                return (
                                                    <div key={idx} className={`flex flex-wrap items-center gap-2 rounded-md border p-2 ${inPast ? 'border-[var(--ds-pending-solid)] bg-[var(--ds-pending-tint)]' : 'border-[var(--ds-border)] bg-[var(--ds-surface)]'}`}>
                                                        <input
                                                            type="date"
                                                            value={row.date}
                                                            min={todayKey}
                                                            onChange={(e) => updateBlockRow(idx, { date: e.target.value })}
                                                            disabled={!canEdit || savingBlocks}
                                                            className="h-8 px-2 rounded border border-[var(--ds-border-strong)] bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] text-[12px] tabular focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                                        />
                                                        <select
                                                            value={row.shift}
                                                            onChange={(e) => updateBlockRow(idx, { shift: e.target.value as PublicBookingBlock['shift'] })}
                                                            disabled={!canEdit || savingBlocks}
                                                            className="h-8 px-2 rounded border border-[var(--ds-border-strong)] bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] text-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                                        >
                                                            <option value="ALL">Intera giornata</option>
                                                            <option value="LUNCH">Solo pranzo</option>
                                                            <option value="DINNER">Solo cena</option>
                                                        </select>
                                                        {inPast && (
                                                            <span className="text-[11px] text-[var(--ds-pending-text)]">Data già passata</span>
                                                        )}
                                                        <button
                                                            type="button"
                                                            onClick={() => removeBlockRow(idx)}
                                                            disabled={!canEdit || savingBlocks}
                                                            className="ml-auto inline-flex items-center justify-center h-7 w-7 rounded-md text-[var(--ds-text-muted)] hover:text-[var(--ds-critical-text)] hover:bg-[var(--ds-critical-tint)] dark:hover:bg-[var(--ds-critical-tint)] disabled:opacity-50 transition-colors"
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
                                            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] font-medium bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                        >
                                            {savingBlocks && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                            Salva blocchi
                                        </button>
                                    </div>
                                </div>
                            )}

                            {!isVoice && !isWeb && (
                                <p className="text-[12px] text-[var(--ds-text-subtle)] italic">
                                    Nessuna impostazione specifica al momento oltre a Attivo / Sospeso.
                                </p>
                            )}
                        </div>
                    </details>
                );
            })}

            {/* Limiti di occupazione per sala — vale per entrambi i canali
                self-service, quindi sta fuori dalle due schede canale. */}
            <details className="group bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] overflow-hidden">
                <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--ds-surface-row)] transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-text-primary)] flex-shrink-0">
                            <Percent className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                            <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Limiti di occupazione per sala</h4>
                            <p className="text-[12px] text-[var(--ds-text-muted)] truncate">
                                Quota di tavoli o coperti oltre la quale le prenotazioni automatiche passano dallo staff.
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`text-[12px] font-medium ${capsDraft.length > 0 ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-text-subtle)]'}`}>
                            {capsDraft.length > 0 ? `${capsDraft.length} ${capsDraft.length === 1 ? 'attivo' : 'attivi'}` : 'Nessun limite'}
                        </span>
                        <ChevronDown className="w-4 h-4 text-[var(--ds-text-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                    </div>
                </summary>
                <div className="px-4 pb-4 pt-3 border-t border-[var(--ds-border)] space-y-3">
                    <p className="text-[13px] text-[var(--ds-text-muted)] leading-relaxed">
                        Riserva una quota di ogni sala ai canali gestiti da voi. Esempio con il 70% sulla sala Macine: finché
                        Macine sta sotto il 70%, le prenotazioni web di quella sala vengono confermate subito con il tavolo
                        assegnato in automatico; appena tocca il 70% le nuove richieste restano da confermare a mano e
                        l'agente telefonico smette di proporre la sala. Lo staff continua a prenotare senza limiti dal
                        gestionale.
                    </p>
                    <p className="text-[12px] text-[var(--ds-text-subtle)] leading-relaxed">
                        <strong className="text-[var(--ds-text-muted)]">Tavoli</strong>: tavoli occupati sul totale della sala (un tavolo accorpato o
                        tenuto da un banchetto conta come occupato). <strong className="text-[var(--ds-text-muted)]">Coperti</strong>: ospiti prenotati
                        sul totale dei posti. Le richieste web ancora senza tavolo pesano sulla sala che il cliente ha scelto.
                    </p>

                    {occupancy.length === 0 ? (
                        <p className="text-[12px] text-[var(--ds-text-subtle)] italic">Nessuna sala configurata.</p>
                    ) : (
                        <div className="space-y-2">
                            {occupancy.map(room => {
                                const cap = capFor(room.room_id);
                                const useSeats = cap?.basis === 'SEATS';
                                const lunchPct = useSeats ? room.lunch.percent_seats : room.lunch.percent_tables;
                                const dinnerPct = useSeats ? room.dinner.percent_seats : room.dinner.percent_tables;
                                // Un turno chiuso non è "al limite": non accetta niente da nessun
                                // canale, quindi non ha senso segnalarlo come soglia raggiunta.
                                const atCapShifts = [
                                    room.lunch.at_cap && !room.lunch.closed_for_shift && !room.is_closed ? 'pranzo' : null,
                                    room.dinner.at_cap && !room.dinner.closed_for_shift && !room.is_closed ? 'cena' : null,
                                ].filter(Boolean) as string[];
                                return (
                                    <div
                                        key={room.room_id}
                                        className={`rounded-md border p-3 ${cap ? 'border-[var(--ds-border-strong)] bg-[var(--ds-surface-row)]' : 'border-[var(--ds-border)] bg-[var(--ds-surface)]'}`}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-[13px] font-medium text-[var(--ds-text-primary)]">{room.room_name}</span>
                                                    {room.is_closed && (
                                                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--ds-surface-row)] text-[var(--ds-text-subtle)]">chiusa</span>
                                                    )}
                                                </div>
                                                <p className="text-[12px] text-[var(--ds-text-muted)] mt-0.5">
                                                    {room.capacity_tables} tavoli · {room.capacity_seats} coperti
                                                </p>
                                                {/* Un turno chiuso dice "chiusa", non "0%": a zero per cento
                                                    la sala sembra vuota e disponibile, ed è l'opposto. */}
                                                <p className="text-[12px] text-[var(--ds-text-subtle)] mt-0.5">
                                                    Oggi — pranzo {renderShiftFill(room.lunch, lunchPct, room.is_closed)}
                                                    {' · '}cena {renderShiftFill(room.dinner, dinnerPct, room.is_closed)}
                                                    {atCapShifts.length > 0 && (
                                                        <span className="ml-1.5 text-[11px] text-[var(--ds-pending-text)]">
                                                            limite raggiunto ({atCapShifts.join(' e ')})
                                                        </span>
                                                    )}
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                role="switch"
                                                aria-checked={!!cap}
                                                aria-label={`${cap ? 'Disattiva' : 'Attiva'} limite per ${room.room_name}`}
                                                onClick={() => toggleCap(room.room_id)}
                                                disabled={!canEdit || savingCaps}
                                                className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                                                    cap ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                                                }`}
                                            >
                                                <span
                                                    aria-hidden="true"
                                                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                                                        cap ? 'translate-x-5' : 'translate-x-0.5'
                                                    } translate-y-0.5`}
                                                />
                                            </button>
                                        </div>

                                        {cap && (
                                            <div className="flex flex-wrap items-center gap-2 mt-3">
                                                <span className="text-[12px] text-[var(--ds-text-muted)]">Limite</span>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    max={100}
                                                    value={cap.percent}
                                                    onChange={(e) => {
                                                        const n = Number(e.target.value);
                                                        updateCap(room.room_id, { percent: Number.isFinite(n) ? Math.trunc(n) : cap.percent });
                                                    }}
                                                    disabled={!canEdit || savingCaps}
                                                    aria-label={`Percentuale massima per ${room.room_name}`}
                                                    className="w-20 h-9 px-2 rounded-md border border-[var(--ds-border-strong)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] tabular focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                                />
                                                <span className="text-[12px] text-[var(--ds-text-muted)]">% dei</span>
                                                <select
                                                    value={cap.basis}
                                                    onChange={(e) => updateCap(room.room_id, { basis: e.target.value as RoomOccupancyCap['basis'] })}
                                                    disabled={!canEdit || savingCaps}
                                                    aria-label={`Base di calcolo per ${room.room_name}`}
                                                    className="h-9 px-2 rounded-md border border-[var(--ds-border-strong)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] text-[13px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
                                                >
                                                    <option value="TABLES">tavoli</option>
                                                    <option value="SEATS">coperti</option>
                                                </select>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <div className="flex items-center justify-end">
                        <button
                            type="button"
                            onClick={saveCaps}
                            disabled={!canEdit || savingCaps || !capsDirty}
                            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] font-medium bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                        >
                            {savingCaps && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            Salva limiti
                        </button>
                    </div>
                </div>
            </details>

            {!canEdit && (
                <p className="text-[12px] text-[var(--ds-text-subtle)] mt-1">
                    Solo gli amministratori possono modificare queste impostazioni.
                </p>
            )}
        </div>
    );
};
