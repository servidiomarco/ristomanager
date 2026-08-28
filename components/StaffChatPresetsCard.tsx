import React, { useEffect, useRef, useState } from 'react';
import { MessagesSquare, Save, Loader2, ChevronDown, Plus, X as XIcon, RotateCcw } from 'lucide-react';
import { Loader } from './Loader';
import { staffChatApiService } from '../services/staffChatApiService';
import { STAFF_MESSAGE_PRESETS } from '../services/staffChat';
import { useAuth } from '../contexts/AuthContext';
import { dsInput } from './ds';

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const MAX_PRESETS = 12;

// I messaggi rapidi della chat staff: un tap e partono, quindi vanno scritti
// come li direbbe la brigata di QUESTO ristorante. Tabella vuota = default.
export const StaffChatPresetsCard: React.FC<Props> = ({ showToast }) => {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');

  const [labels, setLabels] = useState<string[]>([]);
  const [custom, setCustom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; });

  useEffect(() => {
    let cancelled = false;
    staffChatApiService.getPresets()
      .then(({ presets, custom }) => {
        if (cancelled) return;
        setLabels(presets.map(p => p.label));
        setCustom(custom);
      })
      .catch(() => { if (!cancelled) showToastRef.current('Impossibile caricare i messaggi rapidi', 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const save = async (next: string[]) => {
    setSaving(true);
    try {
      const { presets, custom } = await staffChatApiService.savePresets(next);
      setLabels(presets.map(p => p.label));
      setCustom(custom);
      showToast(custom ? 'Messaggi rapidi salvati' : 'Ripristinati i messaggi rapidi predefiniti', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore durante il salvataggio', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    const cleaned = labels.map(l => l.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      showToast('Serve almeno un messaggio, oppure usa "Torna ai predefiniti"', 'error');
      return;
    }
    save(cleaned);
  };

  return (
    <details className="group bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] overflow-hidden"
      open={expanded} onToggle={e => setExpanded((e.target as HTMLDetailsElement).open)}>
      <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--ds-surface-row)] transition-colors">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-text-primary)] flex-shrink-0">
            <MessagesSquare className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Messaggi rapidi chat staff</h4>
            <p className="text-[13px] text-[var(--ds-text-muted)]">Le frasi a un tap del composer ("Piatto finito", "Serve un runner"…): scrivile come le direbbe la tua brigata.</p>
          </div>
        </div>
        <ChevronDown className="w-5 h-5 text-[var(--ds-text-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
      </summary>

      <div className="px-4 pb-4 pt-1 border-t border-[var(--ds-border)]">
        {loading ? (
          <div className="py-10 flex justify-center"><Loader label="Carico…" size={40} /></div>
        ) : (
          <div className="space-y-3 pt-2">
            {!canEdit && (
              <p className="text-[13px] text-[var(--ds-text-muted)] bg-[var(--ds-surface-row)] rounded-lg p-3">
                Serve il permesso impostazioni per modificarli.
              </p>
            )}
            <ul className="space-y-2">
              {labels.map((label, i) => (
                <li key={i} className="flex items-center gap-2">
                  <input
                    value={label}
                    maxLength={60}
                    disabled={!canEdit || saving}
                    onChange={e => setLabels(prev => prev.map((l, j) => j === i ? e.target.value : l))}
                    className={`${dsInput} flex-1`}
                  />
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => setLabels(prev => prev.filter((_, j) => j !== i))}
                      disabled={saving}
                      aria-label={`Togli "${label}"`}
                      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text-primary)] disabled:opacity-50"
                    >
                      <XIcon className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {canEdit && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setLabels(prev => [...prev, ''])}
                  disabled={saving || labels.length >= MAX_PRESETS}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[var(--ds-border)] px-3 text-[13px] font-medium text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" /> Aggiungi
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-action-bg)] px-3.5 text-[13px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salva
                </button>
                {custom && (
                  <button
                    type="button"
                    onClick={() => save([])}
                    disabled={saving}
                    title={`Torna a: ${STAFF_MESSAGE_PRESETS.map(p => p.label).join(', ')}`}
                    className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] disabled:opacity-50"
                  >
                    <RotateCcw className="h-4 w-4" /> Torna ai predefiniti
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </details>
  );
};
