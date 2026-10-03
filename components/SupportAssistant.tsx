import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, LifeBuoy, Loader2, Send, Wand2 } from 'lucide-react';
import { ModalShell, Callout, dsButton } from './ds';
import { supportApiService } from '../services/supportApiService';
import { SUPPORT_BODY_MAX, SUPPORT_SUBJECT_MAX } from '../services/supportShared';
import type { ApiError } from '../services/apiError';

/* ============================================
   «CHIEDI A SYMPOTIA» (supporto, fase 3)
   ============================================
   L'assistente sui manuali: risposte subito ai «come si fa», prima di
   scrivere al team. La conversazione vive qui (il server non tiene stato) e,
   se non basta, diventa il primo messaggio di una richiesta precompilata.
   AI marcata col Wand2 e la famiglia `arriving`, come nel resto dell'app. */

type Turn = { role: 'user' | 'assistant'; content: string; suggestTicket?: boolean };

export interface AssistantEscalation {
  subject: string;
  body: string;
}

const MAX_QUESTION = 2000;

/** La richiesta precompilata: l'ultima domanda come oggetto (è quella che
 *  i manuali non hanno risolto — le prime possono parlare d'altro), e sotto
 *  la conversazione, così chi risponde sa già cosa è stato provato. */
const buildEscalation = (turns: Turn[], labels: { you: string; assistant: string; heading: string }): AssistantEscalation => {
  const lastQuestion = [...turns].reverse().find(t => t.role === 'user')?.content ?? '';
  const subject = lastQuestion.replace(/\s+/g, ' ').trim().slice(0, SUPPORT_SUBJECT_MAX);
  const transcript = turns
    .map(t => `${t.role === 'user' ? labels.you : labels.assistant}: ${t.content}`)
    .join('\n\n');
  const body = `\n\n— ${labels.heading} —\n${transcript}`.slice(0, SUPPORT_BODY_MAX);
  return { subject, body };
};

export const SupportAssistant: React.FC<{
  open: boolean;
  onClose: () => void;
  onEscalate: (prefill: AssistantEscalation) => void;
}> = ({ open, onClose, onEscalate }) => {
  const { t } = useTranslation('supporto', { useSuspense: false });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, asking]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || asking) return;
    const next: Turn[] = [...turns, { role: 'user', content: q }];
    setTurns(next);
    setDraft('');
    setAsking(true);
    setError(null);
    try {
      const res = await supportApiService.ask(next.map(({ role, content }) => ({ role, content })));
      setTurns([...next, { role: 'assistant', content: res.answer, suggestTicket: res.suggest_ticket === true }]);
    } catch (err) {
      setError((err as ApiError).message || t('assistant.error', "L'assistente non ha risposto: riprova o apri una richiesta."));
    } finally {
      setAsking(false);
    }
  };

  const escalate = () => {
    onEscalate(buildEscalation(turns, {
      you: t('assistant.you', 'Io'),
      assistant: t('assistant.name', 'Chiedi a Sympotia'),
      heading: t('assistant.transcriptHeading', "Conversazione con l'assistente"),
    }));
    setTurns([]);
    setDraft('');
    setError(null);
  };

  const close = () => {
    setTurns([]);
    setDraft('');
    setError(null);
    onClose();
  };

  if (!open) return null;

  const lastSuggestsTicket = turns.length > 0 && turns[turns.length - 1].suggestTicket === true;
  const examples = [
    t('assistant.example1', 'Come sposto una prenotazione in un altro tavolo?'),
    t('assistant.example2', 'Come stampo il preconto di un tavolo?'),
    t('assistant.example3', 'Come cambio gli orari di apertura?'),
  ];

  return (
    <ModalShell
      open
      onClose={close}
      closeOnEscape
      title={
        <span className="inline-flex items-center gap-2">
          <Wand2 className="h-5 w-5 text-[var(--ds-arriving-text)]" aria-hidden />
          {t('assistant.name', 'Chiedi a Sympotia')}
        </span>
      }
      subtitle={t('assistant.subtitle', 'Risposte dai manuali di Sympotia. Per un guasto, apri una richiesta.')}
      size="md"
      fixedHeight
      // «row»: il footer qui è un compositore, non una fila di bottoni, e
      // deve prendere tutta la larghezza anche su schermo largo.
      footerLayout="row"
      bodyClassName="p-4 sm:p-5"
      footer={
        <div className="flex w-full flex-col gap-2">
          <div className="flex items-end gap-2 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-1.5 focus-within:ring-2 focus-within:ring-[var(--ds-border-focus)]">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={e => setDraft(e.target.value.slice(0, MAX_QUESTION))}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void ask(draft);
                }
              }}
              rows={1}
              // L'anello di fuoco lo disegna già il contenitore (focus-within):
              // quello globale *:focus-visible, fuori dai layer di Tailwind,
              // vincerebbe sulle classi e ne farebbe due.
              style={{ outline: 'none' }}
              placeholder={t('assistant.placeholder', 'Scrivi la tua domanda…')}
              className="max-h-32 min-w-0 flex-1 resize-none border-0 bg-transparent px-3 py-2.5 text-[15px] leading-snug text-[var(--ds-text-primary)] outline-none placeholder:text-[var(--ds-text-muted)] focus:outline-none focus-visible:outline-none"
            />
            <button
              type="button"
              onClick={() => void ask(draft)}
              disabled={!draft.trim() || asking}
              aria-label={t('assistant.send', 'Chiedi')}
              className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] transition-all hover:bg-[var(--ds-action-bg-hover)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:cursor-not-allowed disabled:bg-[var(--ds-surface)] disabled:text-[var(--ds-text-subtle)]"
            >
              {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={escalate}
              disabled={asking}
              className={lastSuggestsTicket ? dsButton.primary : dsButton.secondary}
            >
              <LifeBuoy className="h-4 w-4" aria-hidden />
              {t('assistant.openTicket', 'Apri una richiesta con questa conversazione')}
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-3">
        {turns.length === 0 && (
          <div className="space-y-2">
            <p className="text-[14px] text-[var(--ds-text-muted)]">{t('assistant.examplesLabel', 'Per esempio:')}</p>
            <div className="flex flex-wrap gap-2">
              {examples.map(ex => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => void ask(ex)}
                  className="inline-flex min-h-[44px] items-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-3.5 text-left text-[14px] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className={`flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[88%] rounded-[var(--ds-radius)] px-3.5 py-2 ${
                turn.role === 'user'
                  ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                  : 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]'
              }`}
            >
              {turn.role === 'assistant' && (
                <p className="mb-0.5 inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--ds-arriving-text)]">
                  <Wand2 className="h-3 w-3" aria-hidden />
                  {t('assistant.name', 'Chiedi a Sympotia')}
                </p>
              )}
              <p className="whitespace-pre-wrap break-words text-[15px] leading-snug">{turn.content}</p>
            </div>
          </div>
        ))}

        {asking && (
          <div className="flex justify-start">
            <div className="ds-ai-frame inline-flex items-center gap-2 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] px-3.5 py-2 text-[14px] text-[var(--ds-text-muted)] shadow-[var(--ds-shadow-card)]">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {t('assistant.thinking', 'Cerco nei manuali…')}
            </div>
          </div>
        )}

        {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}
        <div ref={endRef} />
      </div>
    </ModalShell>
  );
};

export default SupportAssistant;
