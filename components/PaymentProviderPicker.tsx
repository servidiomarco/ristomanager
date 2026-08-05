import React, { useEffect, useRef, useState } from 'react';
import { CreditCard, Loader2 } from 'lucide-react';
import {
    getActivePaymentProvider,
    setPaymentProviderForFlow,
    type ActivePaymentProvider,
    type PaymentFlowId,
    type PaymentProviderId,
} from '../services/apiService';

// Selettore del provider di pagamento per un singolo flusso (caparre o conti
// al tavolo). Un solo componente per le due sezioni delle Impostazioni, così
// wording, stati e guardrail non possono divergere.
//
// "Predefinito" = nessun override: il flusso segue il provider globale, che
// resta la scelta giusta finché non serve distinguere (es. caparre su
// Revolut, conti su SumUp). I provider senza credenziali sono selezionabili
// alla vista ma disabilitati, con il perché accanto.

interface Props {
    flow: PaymentFlowId;
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
    canEdit: boolean;
}

const PROVIDER_LABELS: Record<PaymentProviderId, string> = {
    revolut: 'Revolut',
    sumup: 'SumUp',
};

export const PaymentProviderPicker: React.FC<Props> = ({ flow, showToast, canEdit }) => {
    const [state, setState] = useState<ActivePaymentProvider | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });

    const load = async () => {
        try {
            const data = await getActivePaymentProvider();
            setState(data);
        } catch (err: any) {
            showToastRef.current(err?.message || 'Errore nel caricamento del provider', 'error');
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

    const flowState = state?.flows?.[flow];

    const onChange = async (raw: string) => {
        if (!state || saving) return;
        const next: PaymentProviderId | null = raw === '' ? null : (raw as PaymentProviderId);
        setSaving(true);
        try {
            await setPaymentProviderForFlow(flow, next);
            await load();
            const label = next === null
                ? `predefinito (${state.label})`
                : PROVIDER_LABELS[next];
            showToast(`Provider ${flow === 'deposit' ? 'caparre' : 'conti al tavolo'}: ${label}`, 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento provider', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-[var(--color-fg-muted)] text-[12px] py-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Provider…
            </div>
        );
    }
    if (!state || !flowState) return null;

    return (
        <div>
            <label className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-fg)] mb-1.5">
                <CreditCard className="w-3.5 h-3.5 text-[var(--color-fg-muted)]" />
                Provider di pagamento
            </label>
            <div className="flex items-center gap-2">
                <select
                    value={flowState.override ?? ''}
                    onChange={(e) => onChange(e.target.value)}
                    disabled={!canEdit || saving}
                    className="px-3 py-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[13px] text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)] disabled:opacity-60"
                >
                    <option value="">Predefinito ({state.label})</option>
                    {state.providers.map(p => (
                        <option key={p} value={p} disabled={!state.configured[p]}>
                            {PROVIDER_LABELS[p]}{state.configured[p] ? '' : ' — non configurato'}
                        </option>
                    ))}
                </select>
                {saving && <Loader2 className="w-4 h-4 animate-spin text-[var(--color-fg-muted)]" />}
            </div>
            <p className="text-[11px] text-[var(--color-fg-subtle)] mt-1">
                I prossimi link {flow === 'deposit' ? 'di caparra' : 'dei conti al tavolo'} verranno creati con <strong>{flowState.label}</strong>.
                I pagamenti già in corso restano sul gateway che li ha creati.
            </p>
        </div>
    );
};
