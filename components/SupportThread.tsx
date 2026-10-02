import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff } from 'lucide-react';
import { StatusPill, type PillTone } from './ds';
import { fetchSupportAttachmentUrl } from '../services/supportApiService';
import { displayLocale } from '../utils/formatLocale';
import type { SupportCategory, SupportMessage, SupportStatus } from '../services/supportShared';

/* ============================================
   SUPPORTO — pezzi condivisi fra le due facce
   ============================================
   La vista Aiuto del ristorante e la tab Supporto del pannello mostrano la
   stessa richiesta da due lati. Etichette, pillole e bolle stanno qui, una
   volta sola, così i due lati non possono dire cose diverse dello stesso
   stato. Cambia solo il punto di vista: «tocca a te» per il ristorante è
   «attesa cliente» per la piattaforma. */

export type SupportPerspective = 'tenant' | 'platform';

type TFunc = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

const CATEGORY_LABELS_IT: Record<SupportCategory, string> = {
  stampa: 'Stampa',
  cassa_fiscale: 'Cassa e scontrini',
  sofia: 'Sofia al telefono',
  prenotazioni: 'Prenotazioni',
  menu: 'Menu',
  fatturazione: 'Abbonamento',
  altro: 'Altro',
};

export const supportCategoryLabel = (c: SupportCategory, t: TFunc): string =>
  t(`category.${c}`, CATEGORY_LABELS_IT[c] ?? c);

/* Lo stato si legge dal lato di chi guarda: la famiglia `pending` («serve
   un'azione») va a chi deve muoversi. Per il ristorante è la richiesta che
   aspetta la sua risposta; per la piattaforma quella appena arrivata. */
const STATUS_VIEW: Record<SupportPerspective, Record<SupportStatus, { label: string; tone: PillTone }>> = {
  tenant: {
    nuovo: { label: 'Inviata', tone: 'neutral' },
    in_corso: { label: 'Presa in carico', tone: 'info' },
    attesa_cliente: { label: 'Tocca a te', tone: 'pending' },
    risolto: { label: 'Risolta', tone: 'positive' },
  },
  platform: {
    nuovo: { label: 'Nuova', tone: 'pending' },
    in_corso: { label: 'In corso', tone: 'info' },
    attesa_cliente: { label: 'Attesa cliente', tone: 'neutral' },
    risolto: { label: 'Risolta', tone: 'positive' },
  },
};

export const supportStatusLabel = (s: SupportStatus, perspective: SupportPerspective, t: TFunc): string =>
  t(`status.${perspective}.${s}`, STATUS_VIEW[perspective][s]?.label ?? s);

export const SupportStatusPill: React.FC<{ status: SupportStatus; perspective: SupportPerspective }> = ({ status, perspective }) => {
  const { t } = useTranslation('supporto', { useSuspense: false });
  const view = STATUS_VIEW[perspective][status];
  return <StatusPill tone={view?.tone ?? 'neutral'}>{supportStatusLabel(status, perspective, t)}</StatusPill>;
};

/* `critical` è «fallito / bloccato»: è esattamente quello che il ristorante
   dice con l'interruttore. */
export const SupportUrgentPill: React.FC = () => {
  const { t } = useTranslation('supporto', { useSuspense: false });
  return <StatusPill tone="critical">{t('urgent', 'Blocca il servizio')}</StatusPill>;
};

export const formatSupportDateTime = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString(displayLocale(), {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
};

/* Le foto del supporto stanno dietro login (vedi /support/attachments): si
   scaricano col token e si mostrano da un object URL, rilasciato allo
   smontaggio. */
export const AuthedImage: React.FC<{ token: string; scope: SupportPerspective; alt: string }> = ({ token, scope, alt }) => {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    fetchSupportAttachmentUrl(token, scope)
      .then(u => {
        if (cancelled) { URL.revokeObjectURL(u); return; }
        url = u;
        setSrc(u);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [token, scope]);
  if (failed) {
    return (
      <span className="flex h-24 w-32 items-center justify-center rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] text-[var(--ds-text-subtle)]">
        <ImageOff className="h-5 w-5" aria-hidden />
      </span>
    );
  }
  if (!src) {
    return <span className="block h-24 w-32 animate-pulse rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)]" />;
  }
  return (
    <a href={src} target="_blank" rel="noopener noreferrer">
      <img src={src} alt={alt} className="max-h-64 w-auto rounded-[var(--ds-radius-sm)] object-cover" />
    </a>
  );
};

/* Le bolle: il lato di chi guarda sta a destra, nel nero delle azioni come
   nella chat staff — «mio» contro «suo» non è uno stato del servizio. Dal
   lato del ristorante «mio» è tutto ciò che scrive il ristorante (il
   titolare che legge la richiesta del cameriere è dalla stessa parte). */
export const SupportMessages: React.FC<{
  messages: SupportMessage[];
  perspective: SupportPerspective;
}> = ({ messages, perspective }) => {
  const { t } = useTranslation('supporto', { useSuspense: false });
  const mineType = perspective === 'tenant' ? 'utente' : 'piattaforma';
  return (
    <div className="space-y-3">
      {messages.map(m => {
        const mine = m.author_type === mineType;
        const author = m.author_type === 'piattaforma'
          ? (perspective === 'tenant' ? t('supportTeam', 'Supporto Sympotia') : (m.author_name || t('supportTeam', 'Supporto Sympotia')))
          : (m.author_name || '');
        const attachments = Array.isArray(m.attachments) ? m.attachments : [];
        return (
          <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-[var(--ds-radius)] px-3.5 py-2 ${
                mine
                  ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                  : 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]'
              }`}
            >
              {author && (
                <p className={`text-[12px] font-semibold ${mine ? 'opacity-75' : 'text-[var(--ds-text-secondary)]'}`}>{author}</p>
              )}
              {attachments.length > 0 && (
                <div className="my-1.5 flex flex-wrap gap-1.5">
                  {attachments.map(a => (
                    <AuthedImage key={a.token} token={a.token} scope={perspective} alt={a.filename || t('photo', 'Foto')} />
                  ))}
                </div>
              )}
              <p className="whitespace-pre-wrap break-words text-[15px] leading-snug">{m.body}</p>
              <p className={`mt-1 text-right text-[12px] tabular-nums ${mine ? 'opacity-75' : 'text-[var(--ds-text-muted)]'}`}>
                {formatSupportDateTime(m.created_at)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
};
