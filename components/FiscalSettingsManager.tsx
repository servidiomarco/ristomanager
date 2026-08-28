import React, { useEffect, useRef, useState } from 'react';
import { Building2, FileText, Loader2, ChevronDown, AlertTriangle } from 'lucide-react';
import { billsApiService, type FiscalSettings } from '../services/billsApiService';
import { useAuth } from '../contexts/AuthContext';
import type { FiscalProviderSetting } from '../types';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

// Sezione Fiscalità: due card sulla stessa configurazione (GET/PUT
// /settings/fiscal, un solo fetch condiviso) — i dati dell'esercente che
// finiscono su scontrini e fatture, e la scelta del driver dello scontrino
// elettronico. Il token API del provider è configurazione di piattaforma
// (env), qui si vede solo se c'è.
const PROVIDER_LABELS: Record<FiscalProviderSetting, string> = {
    none: 'Disattivato',
    openapi: 'Openapi (cloud)',
    mock: 'Demo (senza trasmissione)',
};

const inputCls = 'h-10 w-full rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface-2)] px-3 text-[14px] text-[var(--ds-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)] disabled:opacity-50';

export const FiscalSettingsManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [settings, setSettings] = useState<FiscalSettings | null>(null);
    const [vat, setVat] = useState('');
    const [seller, setSeller] = useState({ business_name: '', street: '', zip: '', city: '', province: '' });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await billsApiService.getFiscalSettings();
                if (!cancelled) {
                    setSettings(data);
                    setVat(data.vat_number);
                    setSeller({
                        business_name: data.seller?.business_name ?? '',
                        street: data.seller?.address?.street ?? '',
                        zip: data.seller?.address?.zip ?? '',
                        city: data.seller?.address?.city ?? '',
                        province: data.seller?.address?.province ?? '',
                    });
                }
            } catch (err: any) {
                if (!cancelled) showToastRef.current(err?.message || 'Impostazioni fiscali non caricate', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const save = async (patch: { provider?: FiscalProviderSetting; vat_number?: string; seller?: { business_name?: string; address?: { street?: string; zip?: string; city?: string; province?: string } } }) => {
        if (!settings || saving) return;
        setSaving(true);
        try {
            const updated = await billsApiService.updateFiscalSettings(patch);
            setSettings(updated);
            setVat(updated.vat_number);
            showToast(
                patch.provider !== undefined
                    ? `Scontrino elettronico: ${PROVIDER_LABELS[updated.provider]}`
                    : patch.seller !== undefined ? 'Dati dell\'esercente aggiornati' : 'P.IVA aggiornata',
                'success'
            );
        } catch (err: any) {
            showToast(err?.data?.error ?? err?.message ?? 'Salvataggio non riuscito', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (loading || !settings) {
        return (
            <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] px-4 py-3 flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> Caricamento…
            </div>
        );
    }

    const active = settings.provider !== 'none';
    const vatDirty = vat !== settings.vat_number;
    const sellerDirty =
        seller.business_name !== (settings.seller?.business_name ?? '')
        || seller.street !== (settings.seller?.address?.street ?? '')
        || seller.zip !== (settings.seller?.address?.zip ?? '')
        || seller.city !== (settings.seller?.address?.city ?? '')
        || seller.province !== (settings.seller?.address?.province ?? '');
    const vatValid = vat === '' || /^\d{11}$/.test(vat);
    const esercenteComplete = Boolean(settings.vat_number && settings.seller?.business_name);

    return (
        <div className="space-y-3">
            {/* ── Esercente: P.IVA, denominazione e sede ─────────────────── */}
            <details className="group bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] overflow-hidden">
                <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--ds-surface-row)] transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-arriving-text)] flex-shrink-0">
                            <Building2 className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                            <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Dati dell'esercente</h4>
                            <p className="text-[13px] text-[var(--ds-text-muted)] truncate">P.IVA, denominazione e sede: compaiono su scontrini e fatture.</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`text-[12px] font-medium ${esercenteComplete ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-pending-text)]'}`}>
                            {esercenteComplete ? settings.vat_number : 'Da completare'}
                        </span>
                        <ChevronDown className="w-4 h-4 text-[var(--ds-text-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                    </div>
                </summary>
                <div className="px-4 pb-4 pt-3 border-t border-[var(--ds-border)] space-y-3">
                    <label className="block sm:max-w-xs">
                        <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-primary)]">P.IVA <span className="font-normal text-[var(--ds-text-muted)]">(11 cifre, senza IT)</span></span>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                inputMode="numeric"
                                value={vat}
                                onChange={e => setVat(e.target.value.trim())}
                                disabled={!canEdit || saving}
                                className={`${inputCls} tabular-nums`}
                            />
                            {vatDirty && (
                                <button
                                    type="button"
                                    onClick={() => save({ vat_number: vat })}
                                    disabled={!canEdit || saving || !vatValid}
                                    className="h-10 flex-shrink-0 rounded-xl bg-[var(--ds-action-bg)] px-4 text-[13px] font-semibold text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
                                >
                                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Salva'}
                                </button>
                            )}
                        </div>
                        {!vatValid && (
                            <p className="mt-1 text-[12px] text-[var(--ds-critical-text)]">Servono 11 cifre.</p>
                        )}
                    </label>

                    {/* Cedente della fattura elettronica: denominazione e sede.
                        Regime RF01 (ordinario) fisso finché non serve altro. */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between gap-2">
                            <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)]">Denominazione e sede</h5>
                            {sellerDirty && (
                                <button
                                    type="button"
                                    onClick={() => save({ seller: { business_name: seller.business_name, address: { street: seller.street, zip: seller.zip, city: seller.city, province: seller.province } } })}
                                    disabled={!canEdit || saving}
                                    className="h-8 flex-shrink-0 rounded-xl bg-[var(--ds-action-bg)] px-3 text-[12px] font-semibold text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
                                >
                                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Salva'}
                                </button>
                            )}
                        </div>
                        <label className="block">
                            <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-primary)]">Denominazione</span>
                            <input
                                type="text"
                                value={seller.business_name}
                                onChange={e => setSeller(prev => ({ ...prev, business_name: e.target.value }))}
                                disabled={!canEdit || saving}
                                className={inputCls}
                            />
                        </label>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
                            <label className="col-span-2 block sm:col-span-3">
                                <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-primary)]">Indirizzo</span>
                                <input
                                    type="text"
                                    value={seller.street}
                                    onChange={e => setSeller(prev => ({ ...prev, street: e.target.value }))}
                                    disabled={!canEdit || saving}
                                    className={inputCls}
                                />
                            </label>
                            <label className="block">
                                <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-primary)]">CAP</span>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    value={seller.zip}
                                    onChange={e => setSeller(prev => ({ ...prev, zip: e.target.value }))}
                                    disabled={!canEdit || saving}
                                    className={`${inputCls} tabular-nums`}
                                />
                            </label>
                            <label className="block">
                                <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-primary)]">Comune</span>
                                <input
                                    type="text"
                                    value={seller.city}
                                    onChange={e => setSeller(prev => ({ ...prev, city: e.target.value }))}
                                    disabled={!canEdit || saving}
                                    className={inputCls}
                                />
                            </label>
                            <label className="block">
                                <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-primary)]">Provincia</span>
                                <input
                                    type="text"
                                    maxLength={2}
                                    value={seller.province}
                                    onChange={e => setSeller(prev => ({ ...prev, province: e.target.value.toUpperCase() }))}
                                    disabled={!canEdit || saving}
                                    className={inputCls}
                                />
                            </label>
                        </div>
                        <p className="text-[12px] text-[var(--ds-text-subtle)]">Regime fiscale: ordinario (RF01).</p>
                    </div>

                    {!canEdit && (
                        <p className="text-[12px] text-[var(--ds-text-subtle)] italic">
                            Solo gli amministratori possono modificare queste impostazioni.
                        </p>
                    )}
                </div>
            </details>

            {/* ── Scontrino elettronico: scelta del driver fiscale ────────── */}
            <details className="group bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] overflow-hidden">
                <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--ds-surface-row)] transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-arriving-text)] flex-shrink-0">
                            <FileText className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                            <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Scontrino elettronico</h4>
                            <p className="text-[13px] text-[var(--ds-text-muted)] truncate">Documento commerciale alla chiusura del conto, via provider cloud.</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`text-[12px] font-medium ${active ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-text-subtle)]'}`}>
                            {active ? PROVIDER_LABELS[settings.provider] : 'Disattivato'}
                        </span>
                        <ChevronDown className="w-4 h-4 text-[var(--ds-text-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                    </div>
                </summary>
                <div className="px-4 pb-4 pt-3 border-t border-[var(--ds-border)] space-y-3">
                    <p className="text-[13px] text-[var(--ds-text-muted)] leading-relaxed">
                        Con un provider attivo, alla chiusura di un conto saldato per intero lo scontrino parte da solo verso l'Agenzia delle Entrate. Un documento fallito si ritenta dal conto, nella sezione Pagamenti.
                    </p>

                    <label className="block sm:max-w-xs">
                        <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-primary)]">Provider</span>
                        <select
                            value={settings.provider}
                            onChange={e => save({ provider: e.target.value as FiscalProviderSetting })}
                            disabled={!canEdit || saving}
                            className={inputCls}
                        >
                            {settings.providers.map(p => (
                                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                            ))}
                        </select>
                    </label>

                    {settings.provider === 'openapi' && !settings.openapi_token_configured && (
                        <p className="flex items-start gap-2 rounded-md bg-[var(--ds-surface-row)] border border-[var(--ds-border)] p-3 text-[13px] text-[var(--ds-pending-text)]">
                            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                            Manca il token Openapi sul server (variabile OPENAPI_INVOICE_TOKEN): gli scontrini falliranno finché non viene configurato.
                        </p>
                    )}
                    {settings.provider === 'openapi' && !settings.vat_number && (
                        <p className="flex items-start gap-2 rounded-md bg-[var(--ds-surface-row)] border border-[var(--ds-border)] p-3 text-[13px] text-[var(--ds-pending-text)]">
                            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                            Manca la P.IVA nei dati dell'esercente: senza, lo scontrino non parte.
                        </p>
                    )}
                    {!canEdit && (
                        <p className="text-[12px] text-[var(--ds-text-subtle)] italic">
                            Solo gli amministratori possono modificare queste impostazioni.
                        </p>
                    )}
                </div>
            </details>
        </div>
    );
};
