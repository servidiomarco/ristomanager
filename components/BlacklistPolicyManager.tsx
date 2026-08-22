import React, { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import {
    getBlacklistPolicySettings,
    updateBlacklistPolicySettings,
    type BlacklistPolicySettings,
    type BlacklistPolicySource,
    type BlacklistBehavior,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

/* ── Comportamento della blacklist per fonte (card #27) ───────────────────
   Ogni fonte di prenotazione decide da sola cosa succede quando il numero è
   in blacklist: bloccare, o far entrare la prenotazione lasciando allo staff
   gli indicatori (banner nel modal, badge su card e rubrica). I default
   riproducono il primo rilascio: blocco su web e voce, avviso su manuale e
   WhatsApp. */

const SOURCES: { key: BlacklistPolicySource; label: string; hint: string }[] = [
    { key: 'MANUAL', label: 'Manuale (CRM)', hint: 'Con il blocco il salvataggio viene rifiutato anche allo staff.' },
    { key: 'GOOGLE', label: 'Booking web', hint: 'Con il blocco il form risponde con un invito a chiamare.' },
    { key: 'VOICE', label: 'Agente vocale', hint: 'Con il blocco Sofia declina con una frase di cortesia.' },
    { key: 'WHATSAPP', label: 'Agente WhatsApp', hint: 'Con il blocco le proposte di prenotazione vengono rifiutate.' },
];

export const BlacklistPolicyManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [settings, setSettings] = useState<BlacklistPolicySettings | null>(null);
    const [draft, setDraft] = useState<Partial<BlacklistPolicySettings>>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getBlacklistPolicySettings();
                if (!cancelled) setSettings(data);
            } catch (err: any) {
                if (!cancelled) showToast(err?.message || 'Errore nel caricamento delle impostazioni', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [showToast]);

    const effective = (key: BlacklistPolicySource): BlacklistBehavior =>
        draft[key] ?? settings?.[key] ?? 'warn';
    const isDirty = settings
        ? SOURCES.some(s => draft[s.key] !== undefined && draft[s.key] !== settings[s.key])
        : false;

    const save = async () => {
        if (!canEdit || saving || !settings) return;
        const payload: Partial<BlacklistPolicySettings> = {};
        for (const s of SOURCES) {
            if (draft[s.key] !== undefined && draft[s.key] !== settings[s.key]) payload[s.key] = draft[s.key];
        }
        if (Object.keys(payload).length === 0) return;
        setSaving(true);
        try {
            const updated = await updateBlacklistPolicySettings(payload);
            setSettings(updated);
            setDraft({});
            showToast('Comportamento blacklist aggiornato', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento blacklist', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-[var(--ds-text-muted)] text-[13px] py-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Caricamento…
            </div>
        );
    }
    if (!settings) return null;

    return (
        <div className="space-y-4">
            <p className="text-[12px] text-[var(--ds-text-muted)]">
                Cosa succede quando arriva una prenotazione da un numero segnato in blacklist. Gli indicatori in sala (banner, badge, rubrica) restano sempre visibili, qualunque sia la scelta.
            </p>

            <div className="space-y-3">
                {SOURCES.map(s => (
                    <div key={s.key} className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-[13px] font-medium text-[var(--ds-text-primary)]">{s.label}</p>
                            <p className="text-[11px] text-[var(--ds-text-subtle)]">{s.hint}</p>
                        </div>
                        <select
                            value={effective(s.key)}
                            onChange={e => setDraft(prev => ({ ...prev, [s.key]: e.target.value as BlacklistBehavior }))}
                            disabled={!canEdit || saving}
                            aria-label={`Comportamento blacklist per ${s.label}`}
                            className="w-56 flex-shrink-0 px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                        >
                            <option value="block">Blocca la prenotazione</option>
                            <option value="warn">Consenti con avviso</option>
                        </select>
                    </div>
                ))}
            </div>

            {canEdit && (
                <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--ds-border)]">
                    <button
                        type="button"
                        onClick={save}
                        disabled={!isDirty || saving}
                        className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] text-[13px] font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Salva modifiche
                    </button>
                </div>
            )}

            {!canEdit && (
                <p className="text-[12px] text-[var(--ds-text-subtle)]">
                    Solo gli amministratori possono modificare questa impostazione.
                </p>
            )}
        </div>
    );
};
