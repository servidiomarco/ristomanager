import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Send, RotateCcw, Wand2 } from 'lucide-react';
import { Callout, SegmentedControl, dsButton, dsInput, dsTextarea } from '../ds';
import { useAuth } from '../../contexts/AuthContext';
import {
  getAgentPolicy, saveAgentPolicy, simulateAgent, resetAgentSimulation,
  type AgentAutoActions, type AgentMode, type AgentPolicy, type SimulationResult,
} from '../../services/whatsappApiService';

/* ── Agente automatico ────────────────────────────────────────────────────
   Quando l'agente lavora da solo sui messaggi in arrivo: mai (si lancia
   dalla bacchetta), preparando bozze che lo staff invia, rispondendo lui,
   o anche prenotando, spostando e annullando dove le regole lo permettono
   (ogni azione si annulla dalla chat). Sotto, il simulatore: un cliente
   finto scrive, l'agente risponde, niente parte. */

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

type LimitKey = Exclude<keyof AgentPolicy, 'mode' | 'auto_actions' | 'confirm_cancel'>;
const LIMITI: Array<{ key: LimitKey; min: number; max: number; step?: number }> = [
  { key: 'debounce_seconds', min: 5, max: 300 },
  { key: 'max_wait_seconds', min: 10, max: 900 },
  { key: 'staff_quiet_minutes', min: 0, max: 240 },
  { key: 'max_replies_per_thread_24h', min: 1, max: 50 },
  { key: 'max_runs_per_day', min: 1, max: 2000 },
  { key: 'daily_budget_eur', min: 0.5, max: 100, step: 0.5 },
];

type Battuta = { da: 'cliente' | 'agente' | 'nota'; testo: string };

const AZIONI: Array<{ key: keyof AgentAutoActions; label: string }> = [
  { key: 'create', label: 'Prenota' },
  { key: 'modify', label: 'Sposta e cambia le persone' },
  { key: 'cancel', label: 'Annulla' },
  { key: 'notes', label: 'Note e allergie' },
  { key: 'takeaway', label: 'Ordini d\'asporto' },
];

/** Interruttore delle Impostazioni (stessa forma di AiMessagesSettingsManager). */
const Interruttore: React.FC<{ on: boolean; disabled: boolean; label: string; onChange: (v: boolean) => void }> = ({ on, disabled, label, onChange }) => (
  <label className="flex min-h-[44px] items-center justify-between gap-3">
    <span className="text-[13px] text-[var(--ds-text-primary)]">{label}</span>
    <button
      type="button" role="switch" aria-checked={on} aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
        on ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
      }`}
    >
      <span aria-hidden="true" className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
    </button>
  </label>
);

export const WhatsAppAgentCard: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('whatsapp', { useSuspense: false });
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');
  const [policy, setPolicy] = useState<AgentPolicy | null>(null);
  const [draft, setDraft] = useState<AgentPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [simText, setSimText] = useState('');
  const [simBusy, setSimBusy] = useState(false);
  const [simLog, setSimLog] = useState<Battuta[]>([]);
  // «Ordini d'asporto» compare solo a chi ha l'add-on asporto.
  const [takeawayAvailable, setTakeawayAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAgentPolicy()
      // Un backend precedente alla Fase 7 non manda le azioni: valori di serie.
      .then(r => {
        if (cancelled) return;
        const agent: AgentPolicy = {
          ...r.agent,
          auto_actions: { create: true, modify: true, cancel: true, notes: true, takeaway: true, ...(r.agent.auto_actions ?? {}) },
          confirm_cancel: typeof r.agent.confirm_cancel === 'boolean' ? r.agent.confirm_cancel : true,
        };
        setPolicy(agent);
        setDraft(agent);
        setTakeawayAvailable((r as { takeaway_available?: boolean }).takeaway_available === true);
      })
      .catch((err: any) => { if (!cancelled) setError(err?.message || t('agent.loadError', 'Impostazioni non disponibili')); });
    return () => { cancelled = true; };
  }, [t]);

  if (error) return <Callout tone="critical">{error}</Callout>;
  if (!policy || !draft) {
    return (
      <div className="flex items-center gap-2 py-2 text-[13px] text-[var(--ds-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('loading', 'Caricamento…')}
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(policy);
  const save = async () => {
    setSaving(true);
    try {
      const r = await saveAgentPolicy(draft);
      setPolicy(r.agent);
      setDraft(r.agent);
      showToast(t('agent.saved', 'Salvato'), 'success');
    } catch (err: any) {
      showToast(err?.data?.message || err?.message || t('agent.saveError', 'Non salvato'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const simula = async () => {
    const testo = simText.trim();
    if (!testo || simBusy) return;
    setSimBusy(true);
    setSimLog(log => [...log, { da: 'cliente', testo }]);
    setSimText('');
    try {
      const r: SimulationResult = await simulateAgent(testo, draft.mode === 'off' ? 'reply' : draft.mode);
      const righe: Battuta[] = [];
      for (const a of r.actions ?? []) righe.push({ da: 'nota', testo: `${t('agent.simAction', 'Farebbe da solo')}: ${a.summary}` });
      if (r.reply) righe.push({ da: 'agente', testo: r.outcome === 'drafted' ? `${t('agent.simDraft', 'Bozza')}: ${r.reply}` : r.reply });
      if (r.proposal) righe.push({ da: 'nota', testo: `${t('agent.simProposal', 'Da confermare')}: ${r.proposal.summary}` });
      if (r.skipped) righe.push({ da: 'nota', testo: t('agent.simSkipped', 'Nessuna risposta ({{motivo}})', { motivo: r.skipped }) });
      if (r.note && !r.reply && !r.skipped) righe.push({ da: 'nota', testo: r.note });
      if (righe.length === 0) righe.push({ da: 'nota', testo: t('agent.simNothing', "L'agente non ha risposto") });
      setSimLog(log => [...log, ...righe]);
    } catch (err: any) {
      setSimLog(log => [...log, { da: 'nota', testo: err?.data?.error || err?.message || t('agent.simError', 'Errore del simulatore') }]);
    } finally {
      setSimBusy(false);
    }
  };
  const ricomincia = async () => {
    try { await resetAgentSimulation(); } catch { /* il registro a schermo si svuota comunque */ }
    setSimLog([]);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <SegmentedControl<AgentMode>
          value={draft.mode}
          onChange={mode => canEdit && setDraft({ ...draft, mode })}
          ariaLabel={t('agent.modeLabel', 'Come lavora l\'agente')}
          options={[
            { value: 'off', label: t('agent.modeOff', 'Spento') },
            { value: 'draft', label: t('agent.modeDraft', 'Bozze') },
            { value: 'reply', label: t('agent.modeReply', 'Risposte') },
            { value: 'actions', label: t('agent.modeActions', 'Azioni') },
          ]}
        />
        <p className="text-[13px] text-[var(--ds-text-muted)]">
          {draft.mode === 'off' && t('agent.modeOffHint', 'Lavora solo quando premi la bacchetta in Messaggi.')}
          {draft.mode === 'draft' && t('agent.modeDraftHint', 'A ogni messaggio prepara la risposta: in Messaggi la trovi pronta da inviare.')}
          {draft.mode === 'reply' && t('agent.modeReplyHint', 'Risponde da solo. Le modifiche alle prenotazioni restano da confermare: ti arriva una notifica.')}
          {draft.mode === 'actions' && t('agent.modeActionsHint', 'Risponde e, quando le regole lo permettono, prenota, sposta e annulla da solo. Ogni azione ti arriva come notifica e si annulla dalla chat.')}
        </p>
      </div>

      {draft.mode === 'actions' && (
        <div className="space-y-1">
          <p className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">{t('agent.autoTitle', 'Cosa fa da solo')}</p>
          <div className="divide-y divide-[var(--ds-border)]">
            {AZIONI.filter(a => a.key !== 'takeaway' || takeawayAvailable).map(a => (
              <Interruttore
                key={a.key}
                on={draft.auto_actions[a.key] !== false}
                disabled={!canEdit}
                label={t(`agent.auto.${a.key}`, a.label)}
                onChange={v => setDraft({ ...draft, auto_actions: { ...draft.auto_actions, [a.key]: v } })}
              />
            ))}
            <Interruttore
              on={draft.confirm_cancel}
              disabled={!canEdit || !draft.auto_actions.cancel}
              label={t('agent.confirmCancel', 'Chiedi conferma prima di annullare')}
              onChange={v => setDraft({ ...draft, confirm_cancel: v })}
            />
          </div>
          <p className="text-[12px] text-[var(--ds-text-muted)]">
            {t('agent.autoRules', 'Quello che è spento lo propone. Sempre allo staff: caparre, banchetti, gruppi numerosi, cambi di sala e prenotazioni troppo vicine.')}
          </p>
        </div>
      )}

      <details className="group">
        <summary className="cursor-pointer select-none text-[13px] font-semibold text-[var(--ds-text-secondary)]">
          {t('agent.limits', 'Limiti')}
        </summary>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {LIMITI.map(l => (
            <label key={l.key} className="block">
              <span className="block text-[13px] text-[var(--ds-text-secondary)]">{t(`agent.limit.${l.key}`, l.key)}</span>
              <input
                type="number"
                className={dsInput}
                min={l.min}
                max={l.max}
                step={l.step ?? 1}
                value={draft[l.key]}
                disabled={!canEdit}
                onChange={e => setDraft({ ...draft, [l.key]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
      </details>

      {canEdit && (
        <div className="flex justify-end">
          <button type="button" className={dsButton.primary} disabled={!dirty || saving} onClick={save}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('agent.save', 'Salva')}
          </button>
        </div>
      )}

      {canEdit && (
        <div className="space-y-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--ds-text-primary)]">
              <Wand2 className="h-4 w-4 text-[var(--ds-arriving-text)]" /> {t('agent.simTitle', "Prova l'agente")}
            </span>
            {simLog.length > 0 && (
              <button type="button" className="inline-flex items-center gap-1 text-[13px] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]" onClick={ricomincia}>
                <RotateCcw className="h-3.5 w-3.5" /> {t('agent.simReset', 'Ricomincia')}
              </button>
            )}
          </div>
          <p className="text-[12px] text-[var(--ds-text-muted)]">
            {t('agent.simHint', 'Scrivi come un cliente: l\'agente risponde come farebbe sul numero vero, senza mandare niente. Le prenotazioni non cambiano.')}
          </p>
          {simLog.length > 0 && (
            <ul className="space-y-1.5">
              {simLog.map((b, i) => (
                <li
                  key={i}
                  className={`text-[13px] ${
                    b.da === 'cliente' ? 'text-[var(--ds-text-primary)]'
                    : b.da === 'agente' ? 'text-[var(--ds-arriving-text)]'
                    : 'text-[var(--ds-text-muted)] italic'
                  }`}
                >
                  {b.da === 'cliente' ? '› ' : b.da === 'agente' ? '‹ ' : ''}{b.testo}
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <textarea
              className={`${dsTextarea} min-h-[44px]`}
              rows={1}
              value={simText}
              placeholder={t('agent.simPlaceholder', 'Es. Siete aperti stasera? Siamo in 4')}
              onChange={e => setSimText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); simula(); } }}
            />
            <button type="button" className={dsButton.secondary} disabled={!simText.trim() || simBusy} onClick={simula} aria-label={t('agent.simSend', 'Prova')}>
              {simBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
