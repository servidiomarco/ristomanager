import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Megaphone, Users } from 'lucide-react';
import { Callout, StatusPill, dsButton, dsInput, dsSelect, dsTextarea, type PillTone } from '../ds';
import {
  listCampaigns, previewCampaign, createCampaign, startCampaign, cancelCampaign,
  type CampaignRow, type CampaignSegment, type CampaignsReadiness,
} from '../../services/whatsappApiService';

/* ── Campagne WhatsApp ────────────────────────────────────────────────────
   Un messaggio promozionale ai clienti che hanno dato il consenso, filtrati
   per quanto tempo non tornano, quante volte sono venuti, VIP, lingua. Il
   costo si vede prima e si conferma col tasto: parte solo dopo. L'invio va
   a piccoli gruppi, nella fascia oraria scelta, e si ferma al tetto del mese.
   Chi risponde «STOP» non riceve più niente. */

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const euro = (cents: number) => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100);

const STATUS_TONE: Record<CampaignRow['status'], PillTone> = {
  draft: 'neutral', sending: 'info', paused: 'pending', done: 'positive', cancelled: 'neutral',
};

export const CampagnePage: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('whatsapp', { useSuspense: false });
  const [rows, setRows] = useState<CampaignRow[] | null>(null);
  const [ready, setReady] = useState<CampaignsReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [segment, setSegment] = useState<CampaignSegment>({ vip_only: false, language: null });
  const [preview, setPreview] = useState<{ count: number; sample: string[]; estimated_cost_cents: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await listCampaigns();
      setRows(r.campaigns);
      setReady(r.readiness);
    } catch (err: any) {
      setError(err?.message || t('campaigns.loadError', 'Campagne non disponibili'));
    }
  }, [t]);
  useEffect(() => { load(); }, [load]);

  const setSeg = (patch: Partial<CampaignSegment>) => { setSegment(s => ({ ...s, ...patch })); setPreview(null); };
  const calcola = async () => {
    setBusy(true);
    try { setPreview(await previewCampaign(segment)); }
    catch (err: any) { showToast(err?.message || t('campaigns.previewError', 'Anteprima non riuscita'), 'error'); }
    finally { setBusy(false); }
  };
  const crea = async () => {
    setBusy(true);
    try {
      await createCampaign({ name, message, segment });
      setName(''); setMessage(''); setPreview(null);
      showToast(t('campaigns.created', 'Campagna salvata: controlla e avviala'), 'success');
      await load();
    } catch (err: any) {
      showToast(err?.data?.message || err?.message || t('campaigns.createError', 'Non salvata'), 'error');
    } finally { setBusy(false); }
  };
  const avvia = async (c: CampaignRow) => {
    // Primo tocco: si vede la cifra. Secondo: parte.
    if (confirming !== c.id) { setConfirming(c.id); return; }
    setConfirming(null);
    try {
      await startCampaign(c.id, c.estimated_cost_cents);
      showToast(t('campaigns.started', 'Campagna avviata'), 'success');
    } catch (err: any) {
      const code = err?.data?.error;
      showToast(code === 'estimate_changed'
        ? t('campaigns.estimateChanged', 'I destinatari sono cambiati: ricontrolla la cifra e riprova')
        : (err?.data?.message || err?.message || t('campaigns.startError', 'Non avviata')), 'error');
    }
    await load();
  };
  const annulla = async (c: CampaignRow) => {
    try { await cancelCampaign(c.id); } catch (err: any) { showToast(err?.message || t('campaigns.cancelError', 'Non annullata'), 'error'); }
    await load();
  };

  if (error) return <Callout tone="critical">{error}</Callout>;
  if (!rows || !ready) {
    return (
      <div className="flex items-center gap-2 py-4 text-[13px] text-[var(--ds-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('loading', 'Caricamento…')}
      </div>
    );
  }

  const blocchi = [
    !ready.legal_ok && t('campaigns.needLegal', 'Serve la modalità legale avanzata (Impostazioni › Privacy).'),
    !ready.enabled && t('campaigns.needEnabled', 'Accendi le campagne in Impostazioni › WhatsApp › Campagne.'),
    !ready.template_ready && t('campaigns.needTemplate', 'Il template della campagna non è ancora approvato da Meta.'),
  ].filter(Boolean) as string[];
  const canCreate = name.trim().length > 0 && message.trim().length > 0 && message.length <= 600;

  return (
    <div className="space-y-5">
      {blocchi.length > 0 && <Callout tone="pending">{blocchi.join(' ')}</Callout>}
      <p className="text-[13px] text-[var(--ds-text-muted)]">
        {t('campaigns.spent', 'Speso questo mese: {{speso}} su {{tetto}}. Un messaggio costa circa {{unit}}. Invio dalle {{da}} alle {{a}}, mai due volte allo stesso numero entro {{giorni}} giorni.', {
          speso: euro(ready.month_spent_cents), tetto: euro(ready.monthly_budget_cents), unit: euro(ready.unit_cost_cents),
          da: ready.send_window[0], a: ready.send_window[1], giorni: ready.pause_days,
        })}
      </p>

      <section className="space-y-3 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-4">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold text-[var(--ds-text-primary)]">
          <Megaphone className="h-4 w-4" /> {t('campaigns.new', 'Nuova campagna')}
        </h3>
        <label className="block">
          <span className="block text-[13px] text-[var(--ds-text-secondary)]">{t('campaigns.name', 'Nome (lo vedi solo tu)')}</span>
          <input className={dsInput} value={name} maxLength={120} onChange={e => setName(e.target.value)} placeholder={t('campaigns.namePlaceholder', 'Es. Cena al tartufo')} />
        </label>
        <label className="block">
          <span className="block text-[13px] text-[var(--ds-text-secondary)]">{t('campaigns.message', 'Il messaggio')}</span>
          <textarea className={`${dsTextarea} min-h-[88px]`} value={message} maxLength={600} onChange={e => setMessage(e.target.value)}
            placeholder={t('campaigns.messagePlaceholder', 'Es. venerdì 24 cena al tartufo, 45 € a persona. Rispondi qui per prenotare.')} />
          <span className="mt-1 block text-[12px] text-[var(--ds-text-muted)]">
            {t('campaigns.messageHint', 'Arriva come «Ciao Mario, una novità da [nome del locale]: …», col tasto «Stop promozioni».')}
          </span>
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="block text-[13px] text-[var(--ds-text-secondary)]">{t('campaigns.segDays', 'Non tornano da almeno (giorni)')}</span>
            <input className={dsInput} type="number" min={1} max={3650} value={segment.last_visit_days_min ?? ''}
              onChange={e => setSeg({ last_visit_days_min: e.target.value ? Number(e.target.value) : null })} placeholder={t('campaigns.any', 'Tutti')} />
          </label>
          <label className="block">
            <span className="block text-[13px] text-[var(--ds-text-secondary)]">{t('campaigns.segVisits', 'Almeno queste visite')}</span>
            <input className={dsInput} type="number" min={1} max={1000} value={segment.min_visits ?? ''}
              onChange={e => setSeg({ min_visits: e.target.value ? Number(e.target.value) : null })} placeholder={t('campaigns.any', 'Tutti')} />
          </label>
          <label className="block">
            <span className="block text-[13px] text-[var(--ds-text-secondary)]">{t('campaigns.segLanguage', 'Lingua')}</span>
            <select className={dsSelect} value={segment.language ?? ''} onChange={e => setSeg({ language: (e.target.value || null) as CampaignSegment['language'] })}>
              <option value="">{t('campaigns.allLanguages', 'Tutte')}</option>
              <option value="it">{t('campaigns.italian', 'Italiano')}</option>
              <option value="en">{t('campaigns.english', 'Inglese')}</option>
            </select>
          </label>
          <label className="flex min-h-[44px] items-center gap-2 self-end">
            <input type="checkbox" className="h-4 w-4" checked={segment.vip_only === true} onChange={e => setSeg({ vip_only: e.target.checked })} />
            <span className="text-[13px] text-[var(--ds-text-primary)]">{t('campaigns.segVip', 'Solo VIP')}</span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={dsButton.secondary} disabled={busy} onClick={calcola}>
            <Users className="h-4 w-4" /> {t('campaigns.preview', 'Calcola i destinatari')}
          </button>
          {preview && (
            <span className="text-[13px] text-[var(--ds-text-secondary)]">
              {t('campaigns.previewResult', '{{n}} destinatari, circa {{costo}}', { n: preview.count, costo: euro(preview.estimated_cost_cents) })}
              {preview.sample.length > 0 && ` · ${preview.sample.join(', ')}${preview.count > preview.sample.length ? '…' : ''}`}
            </span>
          )}
        </div>
        <p className="text-[12px] text-[var(--ds-text-muted)]">
          {t('campaigns.rules', 'Solo clienti col consenso alle promozioni, mai chi ha detto STOP, chi è in blacklist o ha un no-show negli ultimi 90 giorni.')}
        </p>
        <div className="flex justify-end">
          <button type="button" className={dsButton.primary} disabled={!canCreate || busy} onClick={crea}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t('campaigns.save', 'Salva la campagna')}
          </button>
        </div>
      </section>

      <section className="space-y-2">
        {rows.length === 0 && <p className="text-[13px] text-[var(--ds-text-muted)]">{t('campaigns.empty', 'Nessuna campagna, per ora.')}</p>}
        {rows.map(c => (
          <div key={c.id} className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-3 ring-1 ring-[var(--ds-border)]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-semibold text-[var(--ds-text-primary)]">{c.name}</span>
              <StatusPill tone={STATUS_TONE[c.status]}>{t(`campaigns.status.${c.status}`, c.status)}</StatusPill>
              {c.pause_reason && <span className="text-[12px] text-[var(--ds-pending-text)]">{c.pause_reason}</span>}
            </div>
            <p className="mt-1 line-clamp-2 text-[13px] text-[var(--ds-text-secondary)]">{c.message}</p>
            <p className="mt-1 text-[12px] text-[var(--ds-text-muted)]">
              {c.status === 'draft'
                ? t('campaigns.draftInfo', '{{n}} destinatari stimati, circa {{costo}}', { n: c.recipients_count, costo: euro(c.estimated_cost_cents) })
                : t('campaigns.counts', '{{sent}} inviati · {{waiting}} in coda · {{skipped}} saltati · {{failed}} non riusciti', { sent: c.sent, waiting: c.waiting, skipped: c.skipped, failed: c.failed })}
            </p>
            {(c.status === 'draft' || c.status === 'paused' || c.status === 'sending') && (
              <div className="mt-2 flex flex-wrap gap-2">
                {(c.status === 'draft' || c.status === 'paused') && (
                  <button type="button" className={dsButton.primary} disabled={blocchi.length > 0} onClick={() => avvia(c)}>
                    {confirming === c.id
                      ? t('campaigns.confirmStart', 'Conferma: {{n}} messaggi, circa {{costo}}', { n: c.recipients_count, costo: euro(c.estimated_cost_cents) })
                      : (c.status === 'paused' ? t('campaigns.resume', 'Riprendi') : t('campaigns.start', 'Avvia'))}
                  </button>
                )}
                <button type="button" className={dsButton.secondary} onClick={() => annulla(c)}>{t('campaigns.cancel', 'Annulla la campagna')}</button>
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
};
