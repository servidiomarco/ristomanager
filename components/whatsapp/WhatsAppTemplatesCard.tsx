import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Callout, StatusPill, dsButton, type PillTone } from '../ds';
import { useAuth } from '../../contexts/AuthContext';
import {
  getWhatsAppTemplates, provisionWhatsAppTemplates,
  type WhatsAppTemplateRow, type TemplateApproval, type WhatsAppTemplatesResponse,
} from '../../services/whatsappApiService';

/* ── Template ─────────────────────────────────────────────────────────────
   I messaggi che partono dal locale fuori dalla finestra di 24 ore: ognuno
   vuole un template approvato da Meta. Un template mancante non blocca
   niente — il messaggio scende su SMS o email — ma senza questa scheda non
   lo si vedeva da nessuna parte.
   Col numero Meta del locale i template stanno nel suo account: Sympotia li
   crea al collegamento, e il tasto rimanda quelli che non sono arrivati. */

const GROUP_ORDER: WhatsAppTemplateRow['group'][] = ['prenotazioni', 'caparre', 'conto', 'asporto', 'recensioni', 'banchetti', 'marketing'];

const tone = (configured: boolean, approval: TemplateApproval | null): PillTone => {
  if (!configured) return 'neutral';
  if (approval === 'approved') return 'positive';
  if (approval === 'rejected') return 'critical';
  if (approval === 'pending' || approval === 'unsubmitted') return 'pending';
  return 'neutral';
};

export const WhatsAppTemplatesCard: React.FC = () => {
  const { t } = useTranslation('whatsapp', { useSuspense: false });
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');
  const [rows, setRows] = useState<WhatsAppTemplateRow[] | null>(null);
  const [provider, setProvider] = useState<WhatsAppTemplatesResponse['provider']>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWhatsAppTemplates()
      .then(r => { if (!cancelled) { setRows(r.templates); setProvider(r.provider ?? null); } })
      .catch((err: any) => { if (!cancelled) setError(err?.message || t('templates.loadError', 'Template non disponibili')); });
    return () => { cancelled = true; };
  }, [t]);

  const meta = provider === 'meta';
  const unsent = !!rows?.some(r => r.languages.some(l => l.approval === 'unsubmitted'));

  const sendToMeta = async () => {
    setSending(true);
    setSendError(null);
    try {
      const r = await provisionWhatsAppTemplates();
      setRows(r.templates);
    } catch (err: any) {
      setSendError(err?.message || t('templates.sendError', 'Meta non ha accettato i template'));
    } finally {
      setSending(false);
    }
  };

  const stateLabel = (configured: boolean, approval: TemplateApproval | null): string => {
    if (!configured) return t('templates.missing', 'non impostato');
    switch (approval) {
      case 'approved': return t('templates.approved', 'attivo');
      case 'pending': return t('templates.pending', 'in approvazione');
      case 'unsubmitted': return t('templates.unsubmitted', 'da inviare a Meta');
      case 'rejected': return t('templates.rejected', 'rifiutato');
      default: return t('templates.unknown', 'impostato');
    }
  };

  if (error) return <Callout tone="critical">{error}</Callout>;
  if (!rows) {
    return (
      <div className="flex items-center gap-2 py-2 text-[13px] text-[var(--ds-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('loading', 'Caricamento…')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-[var(--ds-text-muted)]">
        {meta
          ? t('templates.hintMeta', 'Li approva Meta, di solito in pochi minuti. Senza un template attivo il messaggio parte via email.')
          : t('templates.hint', 'Senza un template attivo il messaggio parte via SMS o email.')}
      </p>
      {meta && canEdit && unsent && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={dsButton.secondary} onClick={sendToMeta} disabled={sending}>
            {sending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('templates.send', 'Manda a Meta quelli mancanti')}
          </button>
        </div>
      )}
      {sendError && <Callout tone="critical">{sendError}</Callout>}
      {GROUP_ORDER.map(group => {
        const items = rows.filter(r => r.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group}>
            <div className="mb-1 text-[12px] font-semibold text-[var(--ds-text-muted)]">
              {t(`templates.group.${group}`, group)}
            </div>
            <ul className="divide-y divide-[var(--ds-border)]">
              {items.map(row => (
                <li key={row.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0 text-[14px] text-[var(--ds-text-primary)]">
                    {t(`templates.name.${row.key}`, row.label)}
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {row.languages.map(l => (
                      <StatusPill
                        key={l.language}
                        tone={tone(l.configured, l.approval)}
                        title={l.rejectionReason ?? undefined}
                      >
                        {l.language} · {stateLabel(l.configured, l.approval)}
                      </StatusPill>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
};
