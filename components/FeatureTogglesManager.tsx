import React, { useEffect, useState } from 'react';
import { Globe, Phone, Loader2 } from 'lucide-react';
import { CookingPotLoader } from './CookingPotLoader';
import { getFeatureFlags, updateFeatureFlags, FeatureFlags } from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

type FlagKey = keyof FeatureFlags;

const TOGGLE_META: Record<FlagKey, { icon: React.ReactNode; title: string; description: string; onLabel: string; offLabel: string }> = {
    public_bookings_enabled: {
        icon: <Globe className="w-5 h-5" />,
        title: 'Prenotazioni web',
        description: 'Modulo /prenota pubblico raggiungibile da Google e siti esterni.',
        onLabel: 'Attive',
        offLabel: 'Sospese',
    },
    voice_agent_enabled: {
        icon: <Phone className="w-5 h-5" />,
        title: 'Prenotazioni telefoniche (Voice agent)',
        description: 'Agente ElevenLabs che gestisce prenotazioni e cancellazioni via telefono.',
        onLabel: 'Attivo',
        offLabel: 'Sospeso',
    },
};

export const FeatureTogglesManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [flags, setFlags] = useState<FeatureFlags | null>(null);
    const [loading, setLoading] = useState(true);
    const [savingKey, setSavingKey] = useState<FlagKey | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getFeatureFlags();
                if (!cancelled) setFlags(data);
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
        // Optimistic update — revert on failure.
        const previous = flags;
        setFlags({ ...flags, [key]: nextValue });
        setSavingKey(key);
        try {
            const updated = await updateFeatureFlags({ [key]: nextValue } as Partial<FeatureFlags>);
            setFlags(updated);
            showToast(
                nextValue
                    ? `${TOGGLE_META[key].title} ${TOGGLE_META[key].onLabel.toLowerCase()}`
                    : `${TOGGLE_META[key].title} ${TOGGLE_META[key].offLabel.toLowerCase()}`,
                'success'
            );
        } catch (err: any) {
            setFlags(previous);
            showToast(err?.message || 'Errore aggiornamento impostazione', 'error');
        } finally {
            setSavingKey(null);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-[var(--color-fg-muted)] text-[13px] py-2">
                <CookingPotLoader label="Caricamento…" size={40} />
            </div>
        );
    }
    if (!flags) return null;

    return (
        <div className="space-y-3">
            {(Object.keys(TOGGLE_META) as FlagKey[]).map((key) => {
                const meta = TOGGLE_META[key];
                const enabled = flags[key];
                const isSaving = savingKey === key;
                return (
                    <div key={key} className="flex items-center justify-between gap-3 py-2">
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center text-[var(--color-fg)] flex-shrink-0">
                                {meta.icon}
                            </div>
                            <div className="min-w-0">
                                <h4 className="font-medium text-[14px] text-[var(--color-fg)]">{meta.title}</h4>
                                <p className="text-[13px] text-[var(--color-fg-muted)]">{meta.description}</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                            <span className={`text-[11px] font-medium uppercase tracking-wide ${enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--color-fg-subtle)]'}`}>
                                {enabled ? meta.onLabel : meta.offLabel}
                            </span>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={enabled}
                                aria-label={`${enabled ? 'Disattiva' : 'Attiva'} ${meta.title}`}
                                onClick={() => toggle(key)}
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
                        </div>
                    </div>
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
