import React, { useEffect, useRef, useState } from 'react';
import { Wand2, Save, Loader2, ChevronDown } from 'lucide-react';
import { Loader } from './Loader';
import { getTableAssignmentAiPrompt, updateTableAssignmentAiPrompt } from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const PROMPT_MAX = 4000;

// Card dev board #26: questo testo alimenta la proposta AI di assegnazione
// tavolo per le prenotazioni che arrivano senza tavolo da sito, WhatsApp o
// Sofia. Affianca la logica esistente, non la sostituisce — e con il campo
// vuoto la proposta resta spenta.
export const TableAssignmentAiPromptCard: React.FC<Props> = ({ showToast }) => {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');

  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await getTableAssignmentAiPrompt();
        if (!cancelled) setPrompt(p);
      } catch {
        if (!cancelled) showToastRef.current('Impossibile caricare il prompt logica tavoli', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      const saved = await updateTableAssignmentAiPrompt(prompt);
      setPrompt(saved);
      showToast('Prompt logica tavoli salvato', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore durante il salvataggio', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="group bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] overflow-hidden"
      open={expanded} onToggle={e => setExpanded((e.target as HTMLDetailsElement).open)}>
      <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--ds-surface-row)] transition-colors">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-text-primary)] flex-shrink-0">
            <Wand2 className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Prompt logica tavoli per AI</h4>
            <p className="text-[13px] text-[var(--ds-text-muted)]">Istruzioni su come assegnare o unire i tavoli: alimentano il suggerimento AI per le prenotazioni senza tavolo dal sito, WhatsApp e Sofia.</p>
          </div>
        </div>
        <ChevronDown className="w-5 h-5 text-[var(--ds-text-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
      </summary>

      <div className="px-4 pb-4 pt-1 border-t border-[var(--ds-border)]">
        {loading ? (
          <div className="py-10 flex justify-center"><Loader label="Carico…" size={40} /></div>
        ) : (
          <>
            {!canEdit && (
              <div className="mb-4 text-[13px] text-[var(--ds-text-muted)] bg-[var(--ds-surface-row)] rounded-lg p-3">
                Solo in lettura: la modifica richiede il permesso di gestione impostazioni.
              </div>
            )}

            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value.slice(0, PROMPT_MAX))}
              disabled={!canEdit}
              rows={8}
              placeholder={'Es: privilegia i tavoli vicino alla vetrata per i gruppi oltre 6 persone; non assegnare il tavolo 12 dopo le 21:00; per gli habitué usa sempre il tavolo preferito se libero…'}
              className="w-full text-[13px] rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-2 resize-y focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
            />
            <p className="text-[12px] text-[var(--ds-text-muted)] mt-1">{prompt.length}/{PROMPT_MAX}</p>

            {canEdit && (
              <div className="flex items-center gap-2 mt-3">
                <button onClick={handleSave} disabled={saving}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] text-[14px] font-medium hover:opacity-90 disabled:opacity-50">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {saving ? 'Salvataggio…' : 'Salva'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
};
