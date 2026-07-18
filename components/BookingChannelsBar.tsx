import React, { useEffect, useState, useCallback } from 'react';
import { Phone, Globe, Loader2 } from 'lucide-react';
import {
    getFeatureFlags,
    FeatureFlags,
    getChannelSettings,
    updateChannelSettings,
    ChannelSettings,
    ScheduledSuspension,
    PublicBookingBlock,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

// Full-shift time windows in Europe/Rome. Mirror the LUNCH_SLOTS/DINNER_SLOTS
// grid used everywhere else; a click on the voice icon books a suspension
// covering the whole service window on the selected date.
const SHIFT_WINDOWS: Record<'LUNCH' | 'DINNER', { start: string; end: string }> = {
    LUNCH: { start: '12:30', end: '14:30' },
    DINNER: { start: '19:30', end: '23:30' },
};

interface Props {
    date: string;                       // YYYY-MM-DD (Europe/Rome)
    shift: 'LUNCH' | 'DINNER';          // 'ALL' non è supportato — la barra
                                        //  è nascosta in quel caso
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

// Compact status widget: two icons in the header showing whether Voice and
// Web bookings are open right now for the selected (date, shift). Click
// toggles by adding/removing the corresponding scheduled entry — so a change
// made from here shows up verbatim in Settings → Prenotazioni web (or
// Agente vocale), and vice versa. Requires `settings:full` to be editable;
// read-only for other roles.
export const BookingChannelsBar: React.FC<Props> = ({ date, shift, showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [flags, setFlags] = useState<FeatureFlags | null>(null);
    const [channels, setChannels] = useState<ChannelSettings | null>(null);
    const [savingKey, setSavingKey] = useState<'voice' | 'web' | null>(null);

    const refresh = useCallback(async () => {
        try {
            const [f, c] = await Promise.all([getFeatureFlags(), getChannelSettings()]);
            setFlags(f);
            setChannels(c);
        } catch {
            // Silent — the header just doesn't render the icons on failure.
        }
    }, []);

    // Re-fetch whenever the selected day/shift changes so the color reflects
    // the effective state for what the user is looking at right now.
    useEffect(() => { refresh(); }, [refresh, date, shift]);

    if (!flags || !channels) return null;

    const shiftWindow = SHIFT_WINDOWS[shift];

    // Voice state — booleans layered from most-general to most-specific.
    const voiceGloballyOff = !flags.voice_agent_enabled || flags.voice_bookings_suspended;
    const voiceShiftSuspensions = (channels.voice_bookings_suspension_schedule || []).filter(e =>
        e.date === date && !(e.end_time <= shiftWindow.start || e.start_time >= shiftWindow.end)
    );
    const voiceShiftBlocked = voiceShiftSuspensions.length > 0;
    const voiceOpen = !voiceGloballyOff && !voiceShiftBlocked;

    // Web state
    const webGloballyOff = !flags.public_bookings_enabled;
    const webDayBlockedAll = (channels.public_bookings_blocks || []).some(b => b.date === date && b.shift === 'ALL');
    const webShiftBlocked = (channels.public_bookings_blocks || []).some(b => b.date === date && b.shift === shift);
    const webBlocked = webDayBlockedAll || webShiftBlocked;
    const webOpen = !webGloballyOff && !webBlocked;

    const toggleVoice = async () => {
        if (!canEdit || voiceGloballyOff || savingKey) return;
        setSavingKey('voice');
        try {
            const schedule = channels.voice_bookings_suspension_schedule || [];
            let updated: ScheduledSuspension[];
            if (voiceShiftBlocked) {
                // Rimuove tutte le entry che intersecano il turno su questa
                // data — comprese eventuali finestre parziali. Aggressivo
                // ma coerente con "riattiva il turno".
                updated = schedule.filter(e => !(e.date === date && !(e.end_time <= shiftWindow.start || e.start_time >= shiftWindow.end)));
            } else {
                updated = [...schedule, { date, start_time: shiftWindow.start, end_time: shiftWindow.end }];
            }
            const res = await updateChannelSettings({ voice_bookings_suspension_schedule: updated });
            setChannels(res);
            showToast(voiceShiftBlocked ? 'Agente vocale riattivato per questo turno' : 'Agente vocale sospeso per questo turno', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento agente vocale', 'error');
        } finally {
            setSavingKey(null);
        }
    };

    const toggleWeb = async () => {
        if (!canEdit || webGloballyOff || savingKey) return;
        // Un blocco intera-giornata sovrasta il concetto di turno — non è
        // rimovibile da qui perché rimuoverlo aprirebbe anche l'altro turno,
        // decisione da prendere in Impostazioni con contesto pieno.
        if (webDayBlockedAll) {
            showToast("Questo giorno ha un blocco per l'intera giornata — modifica in Impostazioni", 'info');
            return;
        }
        setSavingKey('web');
        try {
            const blocks = channels.public_bookings_blocks || [];
            let updated: PublicBookingBlock[];
            if (webShiftBlocked) {
                updated = blocks.filter(b => !(b.date === date && b.shift === shift));
            } else {
                updated = [...blocks, { date, shift }];
            }
            const res = await updateChannelSettings({ public_bookings_blocks: updated });
            setChannels(res);
            showToast(webShiftBlocked ? 'Prenotazioni web riattivate per questo turno' : 'Prenotazioni web sospese per questo turno', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento prenotazioni web', 'error');
        } finally {
            setSavingKey(null);
        }
    };

    // Styling shared da entrambi gli icon-button. `globallyOff` disables
    // interactivity and applies a muted look — l'unico modo di riabilitare
    // è cambiare il flag globale da Impostazioni.
    const iconClass = (open: boolean, globallyOff: boolean, saving: boolean) =>
        `inline-flex items-center justify-center h-9 w-9 rounded-full border transition-colors ${
            globallyOff
                ? 'border-[var(--color-line)] text-[var(--color-fg-subtle)] bg-[var(--color-surface)] opacity-60'
                : open
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300 dark:hover:bg-emerald-500/25'
                    : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-300 dark:hover:bg-rose-500/25'
        } ${canEdit && !globallyOff && !saving ? 'cursor-pointer' : 'cursor-default'} disabled:cursor-not-allowed`;

    return (
        <div className="flex items-center gap-1.5">
            <button
                type="button"
                onClick={toggleVoice}
                disabled={!canEdit || voiceGloballyOff || savingKey === 'voice'}
                className={iconClass(voiceOpen, voiceGloballyOff, savingKey === 'voice')}
                title={
                    voiceGloballyOff
                        ? "Agente vocale disattivato globalmente — riattiva da Impostazioni → Canali di prenotazione"
                        : voiceOpen
                            ? 'Agente vocale attivo per questo turno · click per sospendere'
                            : 'Agente vocale sospeso per questo turno · click per riattivare'
                }
                aria-label="Stato agente vocale per questo turno"
            >
                {savingKey === 'voice' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
            </button>
            <button
                type="button"
                onClick={toggleWeb}
                disabled={!canEdit || webGloballyOff || savingKey === 'web'}
                className={iconClass(webOpen, webGloballyOff, savingKey === 'web')}
                title={
                    webGloballyOff
                        ? "Prenotazioni web disattivate globalmente — riattiva da Impostazioni → Canali di prenotazione"
                        : webDayBlockedAll
                            ? "Bloccato per intera giornata — modifica in Impostazioni"
                            : webOpen
                                ? 'Prenotazioni web attive per questo turno · click per bloccare'
                                : 'Prenotazioni web bloccate per questo turno · click per sbloccare'
                }
                aria-label="Stato prenotazioni web per questo turno"
            >
                {savingKey === 'web' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
            </button>
        </div>
    );
};
