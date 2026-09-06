import React, { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import {
    getChargeSettings,
    updateChargeSettings,
    type ChargeSettings,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

// "2", "2,5", "2.50" → centesimi; NaN se non è un importo.
const parseEuroToCents = (raw: string): number => {
    const s = raw.trim().replace(',', '.');
    if (s === '' || !/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    return Math.round(parseFloat(s) * 100);
};

const formatCents = (cents: number): string =>
    (cents / 100).toFixed(2).replace('.', ',');

/* ── Coperto e servizio ───────────────────────────────────────────────────
   Gli importi delle due righe di sistema che syncSystemLines mette su ogni
   comanda: coperto fisso a persona e servizio percentuale sull'imponibile
   dei piatti. A zero la riga non compare. Le aliquote IVA delle due righe
   restano nella mappatura IVA (sezione Fiscalità). */
export const ChargeSettingsManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [settings, setSettings] = useState<ChargeSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [coverInput, setCoverInput] = useState('0,00');
    const [serviceInput, setServiceInput] = useState('0');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getChargeSettings();
                if (cancelled) return;
                setSettings(data);
                setCoverInput(formatCents(data.cover_charge_cents));
                setServiceInput(String(data.service_charge_percent));
            } catch (err: any) {
                if (!cancelled) showToast(err?.message || 'Errore nel caricamento delle impostazioni', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [showToast]);

    const parsedCover = parseEuroToCents(coverInput);
    const coverValid = Number.isInteger(parsedCover) && parsedCover >= 0 && parsedCover <= 10000;
    const parsedService = /^\d+$/.test(serviceInput.trim()) ? parseInt(serviceInput, 10) : NaN;
    const serviceValid = Number.isInteger(parsedService) && parsedService >= 0 && parsedService <= 100;
    const isDirty = settings != null && (
        (coverValid && parsedCover !== settings.cover_charge_cents)
        || (serviceValid && parsedService !== settings.service_charge_percent)
    );

    const save = async () => {
        if (!canEdit || saving || !settings) return;
        if (!coverValid) { showToast('Il coperto deve essere un importo tra 0 e 100 €', 'error'); return; }
        if (!serviceValid) { showToast('Il servizio deve essere un intero tra 0 e 100', 'error'); return; }
        const payload: Partial<ChargeSettings> = {};
        if (parsedCover !== settings.cover_charge_cents) payload.cover_charge_cents = parsedCover;
        if (parsedService !== settings.service_charge_percent) payload.service_charge_percent = parsedService;
        if (Object.keys(payload).length === 0) return;
        setSaving(true);
        try {
            const updated = await updateChargeSettings(payload);
            setSettings(updated);
            setCoverInput(formatCents(updated.cover_charge_cents));
            setServiceInput(String(updated.service_charge_percent));
            showToast('Coperto e servizio aggiornati', 'success');
        } catch (err: any) {
            showToast(err?.data?.error ?? err?.message ?? 'Salvataggio non riuscito', 'error');
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
                Compaiono come righe del conto e si scontano come le altre. A zero non compaiono. Le comande aperte si adeguano alla prossima battitura.
            </p>

            <div className="flex flex-wrap gap-4">
                <div>
                    <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">
                        Coperto a persona
                    </label>
                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            inputMode="decimal"
                            value={coverInput}
                            onChange={(e) => setCoverInput(e.target.value)}
                            disabled={!canEdit || saving}
                            className="w-24 px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                        />
                        <span className="text-[12px] text-[var(--ds-text-muted)]">€</span>
                    </div>
                    {coverInput.trim() !== '' && !coverValid && (
                        <p className="text-[11px] text-[var(--ds-critical-text)] mt-1">Importo tra 0 e 100 €.</p>
                    )}
                </div>

                <div>
                    <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">
                        Servizio
                    </label>
                    <div className="flex items-center gap-2">
                        <input
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            inputMode="numeric"
                            value={serviceInput}
                            onChange={(e) => setServiceInput(e.target.value)}
                            disabled={!canEdit || saving}
                            className="w-24 px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                        />
                        <span className="text-[12px] text-[var(--ds-text-muted)]">% sui piatti</span>
                    </div>
                    {serviceInput.trim() !== '' && !serviceValid && (
                        <p className="text-[11px] text-[var(--ds-critical-text)] mt-1">Intero tra 0 e 100.</p>
                    )}
                </div>
            </div>

            <p className="text-[11px] text-[var(--ds-text-subtle)]">
                Le aliquote IVA di coperto e servizio si regolano nella mappatura IVA, in Fiscalità.
            </p>

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
