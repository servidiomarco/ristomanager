import React, { useEffect, useState } from 'react';
import { Globe, Phone, Loader2, ChevronDown, Users } from 'lucide-react';
import { CookingPotLoader } from './CookingPotLoader';
import {
    getFeatureFlags,
    updateFeatureFlags,
    FeatureFlags,
    getChannelSettings,
    updateChannelSettings,
    ChannelSettings,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

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
            } catch (err: any) {
                if (!cancelled) showToast(err?.message || 'Errore nel caricamento delle impostazioni', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [showToast]);

    const toggle = async (key: FlagKey) => {
        if (!flags || !canEdit || savingKey) return;
        const nextValue = !flags[key];
        const previous = flags;
        setFlags({ ...flags, [key]: nextValue });
        setSavingKey(key);
        try {
            const updated = await updateFeatureFlags({ [key]: nextValue } as Partial<FeatureFlags>);
            setFlags(updated);
            const meta = CHANNELS.find(c => c.key === key)!;
            showToast(
                nextValue
                    ? `${meta.title}: ${meta.onLabel.toLowerCase()}`
                    : `${meta.title}: ${meta.offLabel.toLowerCase()}`,
                'success'
            );
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

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-[var(--color-fg-muted)] text-[13px] py-2">
                <CookingPotLoader label="Caricamento…" size={40} />
            </div>
        );
    }
    if (!flags || !channels) return null;

    const voiceThresholdDirty = String(channels.voice_large_group_threshold) !== voiceThresholdDraft.trim();

    return (
        <div className="space-y-3">
            {CHANNELS.map((meta) => {
                const enabled = flags[meta.key];
                const isSaving = savingKey === meta.key;
                const isVoice = meta.key === 'voice_agent_enabled';
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
                            )}

                            {!isVoice && (
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
