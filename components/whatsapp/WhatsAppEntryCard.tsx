import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Download, Loader2 } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { Callout, dsButton, dsInput } from '../ds';
import { useAuth } from '../../contexts/AuthContext';
import {
  getWhatsAppSettings, saveWhatsAppSettings, getWhatsAppStatus, waMeUrl, DEFAULT_WA_PREFILL,
  type EntryPolicy,
} from '../../services/whatsappApiService';

/* ── Farsi trovare ────────────────────────────────────────────────────────
   Il link wa.me del locale col testo già scritto, il suo QR da stampare, e
   dove mostrarlo: la pagina /prenota e il menu digitale. Più i testi pronti
   per Google e Instagram. Senza un numero collegato non c'è niente da
   mostrare: un link a un numero che non risponde è peggio di nessun link. */

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const DEFAULT_ENTRY: EntryPolicy = { show_on_booking_page: false, show_on_menu: false, prefill_text: '' };

export const WhatsAppEntryCard: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('whatsapp', { useSuspense: false });
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');
  const [phone, setPhone] = useState<string | null | undefined>(undefined);
  const [policy, setPolicy] = useState<EntryPolicy | null>(null);
  const [draft, setDraft] = useState<EntryPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qrRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getWhatsAppStatus(), getWhatsAppSettings()])
      .then(([st, s]) => {
        if (cancelled) return;
        setPhone(st.connected ? st.phone : null);
        const entry = s.entry ?? DEFAULT_ENTRY;
        setPolicy(entry);
        setDraft(entry);
      })
      .catch((err: any) => { if (!cancelled) setError(err?.message || t('entry.loadError', 'Impostazioni non disponibili')); });
    return () => { cancelled = true; };
  }, [t]);

  if (error) return <Callout tone="critical">{error}</Callout>;
  if (phone === undefined || !policy || !draft) {
    return (
      <div className="flex items-center gap-2 py-2 text-[13px] text-[var(--ds-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('loading', 'Caricamento…')}
      </div>
    );
  }
  if (!phone) {
    return <Callout tone="info">{t('entry.noNumber', 'Collega prima un numero WhatsApp: il link porta a quello.')}</Callout>;
  }

  const link = waMeUrl(phone, draft.prefill_text || DEFAULT_WA_PREFILL);
  const dirty = JSON.stringify(draft) !== JSON.stringify(policy);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('entry.copied', 'Copiato'), 'success');
    } catch {
      showToast(t('entry.copyFailed', 'Non copiato: selezionalo a mano'), 'error');
    }
  };
  const save = async () => {
    setSaving(true);
    try {
      const r = await saveWhatsAppSettings({ entry: draft });
      const entry = r.entry ?? draft;
      setPolicy(entry);
      setDraft(entry);
      showToast(t('entry.saved', 'Salvato'), 'success');
    } catch (err: any) {
      showToast(err?.message || t('entry.saveError', 'Non salvato'), 'error');
    } finally {
      setSaving(false);
    }
  };
  const downloadQr = () => {
    const canvas = qrRef.current;
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'whatsapp-qr.png';
    a.click();
  };

  const testi = [
    { key: 'google', label: t('entry.google', 'Google Business: link per le prenotazioni'), text: link },
    // Nella bio conta la lunghezza: il link corto, senza testo già scritto.
    { key: 'instagram', label: t('entry.instagram', 'Instagram: bio'), text: t('entry.instagramText', 'Prenota su WhatsApp 👉 {{link}}', { link: waMeUrl(phone).replace(/^https:\/\//, '') }) },
  ];

  const toggleRow = (key: 'show_on_booking_page' | 'show_on_menu', label: string) => (
    <label className="flex min-h-[44px] items-center justify-between gap-3">
      <span className="text-[13px] text-[var(--ds-text-primary)]">{label}</span>
      <button
        type="button" role="switch" aria-checked={draft[key]} aria-label={label}
        disabled={!canEdit}
        onClick={() => setDraft({ ...draft, [key]: !draft[key] })}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
          draft[key] ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
        }`}
      >
        <span aria-hidden="true" className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${draft[key] ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
      </button>
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex flex-col items-center gap-2">
          <div className="rounded-[var(--ds-radius-sm)] bg-white p-2">
            <QRCodeCanvas value={link} size={136} level="M" ref={qrRef} />
          </div>
          <button type="button" className={dsButton.secondary} onClick={downloadQr}>
            <Download className="h-4 w-4" /> {t('entry.downloadQr', 'Scarica il QR')}
          </button>
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <label className="block">
            <span className="block text-[13px] text-[var(--ds-text-secondary)]">{t('entry.prefill', 'Testo già scritto')}</span>
            <input
              className={dsInput}
              value={draft.prefill_text}
              maxLength={200}
              placeholder={DEFAULT_WA_PREFILL}
              disabled={!canEdit}
              onChange={e => setDraft({ ...draft, prefill_text: e.target.value })}
            />
          </label>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] px-2.5 py-2 text-[12px] text-[var(--ds-text-secondary)]">{link}</code>
            <button type="button" className={dsButton.secondary} onClick={() => copy(link)} aria-label={t('entry.copy', 'Copia')}>
              <Copy className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="divide-y divide-[var(--ds-border)]">
        {toggleRow('show_on_booking_page', t('entry.onBooking', 'Mostra su /prenota'))}
        {toggleRow('show_on_menu', t('entry.onMenu', 'Mostra nel menu digitale'))}
      </div>

      {canEdit && (
        <div className="flex justify-end">
          <button type="button" className={dsButton.primary} disabled={!dirty || saving} onClick={save}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('entry.save', 'Salva')}
          </button>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">{t('entry.readyTexts', 'Testi pronti')}</p>
        {testi.map(x => (
          <div key={x.key} className="flex items-start gap-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-[var(--ds-text-muted)]">{x.label}</p>
              <p className="break-all text-[13px] text-[var(--ds-text-primary)]">{x.text}</p>
            </div>
            <button type="button" className={dsButton.secondary} onClick={() => copy(x.text)} aria-label={t('entry.copy', 'Copia')}>
              <Copy className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
