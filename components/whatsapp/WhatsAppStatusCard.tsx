import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Copy, Check } from 'lucide-react';
import { Callout, Field, StatusPill, dsButton, dsInput, type PillTone } from '../ds';
import { useAuth } from '../../contexts/AuthContext';
import {
  connectMetaWhatsApp, disconnectMetaWhatsApp, getWhatsAppStatus, type WhatsAppStatus,
} from '../../services/whatsappApiService';

/* ── Numero e stato ───────────────────────────────────────────────────────
   Il numero da cui il locale scrive ai clienti, e se manda davvero. Prima
   lo sapeva solo chi aveva le variabili d'ambiente di Railway sotto gli
   occhi: un locale senza mittente vedeva i messaggi scendere su SMS o email
   senza sapere perché. */

const CopyRow: React.FC<{ label: string; value: string }> = ({ label, value }) => {
  const { t } = useTranslation('whatsapp', { useSuspense: false });
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* il testo resta selezionabile */ }
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-[var(--ds-text-muted)]">{label}</div>
        <div className="truncate font-mono text-[12px] text-[var(--ds-text-secondary)]" title={value}>{value}</div>
      </div>
      <button
        type="button"
        onClick={copy}
        className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]"
        aria-label={t('status.copy', 'Copia')}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
};

// La qualità del numero come la dà Meta: verde, gialla, rossa.
const QUALITY_TONE: Record<string, PillTone> = { GREEN: 'positive', YELLOW: 'pending', RED: 'critical' };

// Il limite d'invio di Meta («TIER_250», «TIER_1K», «TIER_UNLIMITED»): quanti
// clienti diversi il numero può contattare per primo in 24 ore.
const tierCount = (tier: string): number | 'unlimited' | null => {
  if (/UNLIMITED/i.test(tier)) return 'unlimited';
  const m = /^TIER_(\d+)(K?)$/i.exec(tier.trim());
  return m ? Number(m[1]) * (m[2] ? 1000 : 1) : null;
};

/* ── Collega un numero Meta ───────────────────────────────────────────────
   A mano, coi tre valori della console di Meta (WhatsApp › Configurazione
   API): serve alle demo col numero di prova e ai primi locali, finché il
   collegamento con un clic non arriva. Il token si salva cifrato e non
   torna più indietro. */
const MetaConnectForm: React.FC<{ onDone: (subscribed: boolean) => void; onCancel: () => void }> = ({ onDone, onCancel }) => {
  const { t } = useTranslation('whatsapp', { useSuspense: false });
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await connectMetaWhatsApp({ phone_number_id: phoneNumberId.trim(), waba_id: wabaId.trim(), access_token: token.trim() });
      setToken('');
      onDone(r.subscribed);
    } catch (err: any) {
      setError(err?.message || t('status.meta.connectError', 'Numero non collegato'));
    } finally {
      setSaving(false);
    }
  };

  const ready = /^\d{5,}$/.test(phoneNumberId.trim()) && /^\d{5,}$/.test(wabaId.trim()) && token.trim().length >= 20;
  return (
    <form onSubmit={submit} className="space-y-3 border-t border-[var(--ds-border)] pt-3">
      <p className="text-[13px] text-[var(--ds-text-muted)]">
        {t('status.meta.formHint', 'I tre valori sono nella console di Meta, in WhatsApp › Configurazione API.')}
      </p>
      <Field label={t('status.meta.phoneNumberId', 'Id del numero')} htmlFor="wa-meta-pnid">
        <input id="wa-meta-pnid" className={dsInput} inputMode="numeric" autoComplete="off"
          value={phoneNumberId} onChange={e => setPhoneNumberId(e.target.value)} />
      </Field>
      <Field label={t('status.meta.wabaId', "Id dell'account WhatsApp Business")} htmlFor="wa-meta-waba">
        <input id="wa-meta-waba" className={dsInput} inputMode="numeric" autoComplete="off"
          value={wabaId} onChange={e => setWabaId(e.target.value)} />
      </Field>
      <Field label={t('status.meta.token', "Token d'accesso")} htmlFor="wa-meta-token"
        hint={t('status.meta.tokenHint', 'Meglio quello di un utente di sistema: non scade. Si salva cifrato.')}>
        <input id="wa-meta-token" type="password" className={dsInput} autoComplete="new-password"
          value={token} onChange={e => setToken(e.target.value)} />
      </Field>
      {error && <Callout tone="critical">{error}</Callout>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={dsButton.primary} disabled={!ready || saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('status.meta.connect', 'Collega')}
        </button>
        <button type="button" className={dsButton.quiet} onClick={onCancel} disabled={saving}>
          {t('status.meta.cancel', 'Annulla')}
        </button>
      </div>
    </form>
  );
};

export const WhatsAppStatusCard: React.FC = () => {
  const { t } = useTranslation('whatsapp', { useSuspense: false });
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [notSubscribed, setNotSubscribed] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => getWhatsAppStatus().then(setStatus), []);

  useEffect(() => {
    let cancelled = false;
    getWhatsAppStatus()
      .then(s => { if (!cancelled) setStatus(s); })
      .catch((err: any) => { if (!cancelled) setError(err?.message || t('status.loadError', 'Stato non disponibile')); });
    return () => { cancelled = true; };
  }, [t]);

  const disconnect = async () => {
    setDisconnecting(true);
    setActionError(null);
    try {
      await disconnectMetaWhatsApp();
      setConfirmDisconnect(false);
      setNotSubscribed(false);
      await load();
    } catch (err: any) {
      setActionError(err?.message || t('status.meta.disconnectError', 'Numero non scollegato'));
    } finally {
      setDisconnecting(false);
    }
  };

  if (error) return <Callout tone="critical">{error}</Callout>;
  if (!status) {
    return (
      <div className="flex items-center gap-2 py-2 text-[13px] text-[var(--ds-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('loading', 'Caricamento…')}
      </div>
    );
  }

  const meta = status.provider === 'meta' ? status.meta ?? null : null;
  const canConnect = canEdit && status.meta_connect_available === true;

  return (
    <div className="space-y-3">
      {status.connected ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{status.phone}</div>
            <div className="text-[13px] text-[var(--ds-text-muted)]">
              {status.provider === 'twilio' && status.source === 'env'
                ? t('status.twilioEnv', 'Twilio · account principale')
                : status.provider === 'meta'
                  ? [meta?.display_name, t('status.meta.provider', 'Meta · API Cloud')].filter(Boolean).join(' · ')
                  : t('status.provider', 'Provider: {{p}}', { p: status.provider ?? '—' })}
            </div>
          </div>
          <StatusPill tone="positive">{t('status.connected', 'Collegato')}</StatusPill>
        </div>
      ) : (
        <Callout tone="pending" title={t('status.notConnectedTitle', 'Nessun numero collegato')}>
          {t('status.notConnectedNow', 'I messaggi ai clienti partono per email, se configurata.')}
        </Callout>
      )}

      {meta && (
        <div className="space-y-2 text-[13px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[var(--ds-text-secondary)]">{t('status.meta.quality', 'Qualità del numero')}</span>
            <StatusPill tone={QUALITY_TONE[String(meta.quality_rating ?? '').toUpperCase()] ?? 'neutral'}>
              {t(`status.meta.q.${String(meta.quality_rating ?? 'unknown').toLowerCase()}`, meta.quality_rating ?? '—')}
            </StatusPill>
          </div>
          {meta.messaging_limit && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[var(--ds-text-secondary)]">{t('status.meta.limit', "Limite d'invio")}</span>
              <span className="tabular-nums text-[var(--ds-text-primary)]">
                {(() => {
                  const n = tierCount(meta.messaging_limit);
                  if (n === 'unlimited') return t('status.meta.limitUnlimited', 'senza limite');
                  if (n == null) return meta.messaging_limit;
                  return t('status.meta.limitPerDay', '{{n}} clienti al giorno', { n: n.toLocaleString('it-IT') });
                })()}
              </span>
            </div>
          )}
        </div>
      )}

      {notSubscribed && (
        <Callout tone="pending">
          {t('status.meta.notSubscribed', "Il numero manda, ma Meta non ha iscritto l'app all'account: i messaggi dei clienti non arrivano. Collega di nuovo col token giusto.")}
        </Callout>
      )}

      {!status.connected && canConnect && !connecting && (
        <button type="button" className={dsButton.secondary} onClick={() => setConnecting(true)}>
          {t('status.meta.open', 'Collega un numero Meta')}
        </button>
      )}
      {!status.connected && canConnect && connecting && (
        <MetaConnectForm
          onCancel={() => setConnecting(false)}
          onDone={subscribed => {
            setConnecting(false);
            setNotSubscribed(!subscribed);
            load().catch(() => {});
          }}
        />
      )}

      {meta && canEdit && (
        confirmDisconnect ? (
          <div className="space-y-2 border-t border-[var(--ds-border)] pt-3">
            <p className="text-[13px] text-[var(--ds-text-secondary)]">
              {t('status.meta.disconnectConfirm', 'Da adesso i messaggi ai clienti partono per email. Il numero resta su Meta.')}
            </p>
            {actionError && <Callout tone="critical">{actionError}</Callout>}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={dsButton.critical} onClick={disconnect} disabled={disconnecting}>
                {disconnecting && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('status.meta.disconnect', 'Scollega')}
              </button>
              <button type="button" className={dsButton.quiet} onClick={() => setConfirmDisconnect(false)} disabled={disconnecting}>
                {t('status.meta.cancel', 'Annulla')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={dsButton.quiet} onClick={() => setConfirmDisconnect(true)}>
            {t('status.meta.disconnectOpen', 'Scollega il numero')}
          </button>
        )
      )}

      <div className="flex items-center justify-between gap-2 text-[13px]">
        <span className="text-[var(--ds-text-secondary)]">{t('status.sms', 'Ripiego SMS')}</span>
        <StatusPill tone={status.sms_ready ? 'positive' : 'neutral'}>
          {status.sms_ready ? t('status.on', 'Attivo') : t('status.off', 'Spento')}
        </StatusPill>
      </div>

      {status.webhooks && (
        <div className="space-y-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3">
          {status.provider === 'meta' ? (
            // Su Meta un solo indirizzo, quello dell'app: messaggi e esiti.
            <CopyRow label={t('status.meta.webhook', "Webhook dell'app Meta")} value={status.webhooks.inbound} />
          ) : (
            <>
              <CopyRow label={t('status.webhookInbound', 'Messaggi in arrivo')} value={status.webhooks.inbound} />
              <CopyRow label={t('status.webhookStatus', 'Esito dei messaggi')} value={status.webhooks.status} />
            </>
          )}
        </div>
      )}
    </div>
  );
};
