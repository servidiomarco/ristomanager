import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Kanban, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  Callout, EmptyState, Field, ModalShell, FormCard, SegmentedControl, dsButton, dsInput, dsSelect,
} from './ds';
import { Loader } from './Loader';
import {
  platformCrmApi, CRM_DEAL_KINDS, CRM_DEAL_STAGES,
  type CrmDeal, type CrmDealKind, type CrmDealStage,
} from '../services/platformCrmApiService';
import {
  DEAL_KIND_LABEL, DEAL_STAGE_LABEL, centsToInput, eur, formatDay, parseEuroInput, todayRome, type ShowToast,
} from './PlatformCrmShared';
import type { ApiError } from '../services/apiError';

/* ============================================
   PANNELLO PIATTAFORMA — CRM, Pipeline
   ============================================
   Le opportunità in colonne per fase, con il canone mensile che portano.
   La colonna si cambia dalla tendina della card (niente trascinamento: su
   telefono è un gesto che si sbaglia). Le chiuse degli ultimi 90 giorni
   stanno nella vista «Chiuse». */

const OPEN_STAGES: CrmDealStage[] = ['nuova', 'demo', 'proposta', 'trattativa'];
const CLOSED_STAGES: CrmDealStage[] = ['vinta', 'persa'];
const DEFAULT_PROBABILITY: Record<CrmDealStage, number> = { nuova: 10, demo: 30, proposta: 50, trattativa: 70, vinta: 100, persa: 0 };

/* ── Modale dell'opportunità ─────────────────────────────────────────────
   Nuova o da modificare; dalla scheda cliente l'azienda è già scelta, dalla
   pipeline si sceglie qui. */
export const DealFormModal: React.FC<{
  open: boolean;
  onClose: () => void;
  deal?: CrmDeal | null;
  accountId?: number | null;
  accounts?: Array<{ id: number; name: string }>;
  onSaved: (deal: CrmDeal | null) => void;
  showToast: ShowToast;
}> = ({ open, onClose, deal = null, accountId = null, accounts = [], onSaved, showToast }) => {
  const [form, setForm] = useState({
    account_id: '', title: '', kind: 'nuovo' as CrmDealKind, stage: 'nuova' as CrmDealStage,
    mrr: '', setup: '', probability: '', expected_close: '', lost_reason: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [armDelete, setArmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setArmDelete(false);
    setForm({
      account_id: String(deal?.account_id ?? accountId ?? ''),
      title: deal?.title ?? '',
      kind: deal?.kind ?? 'nuovo',
      stage: deal?.stage ?? 'nuova',
      mrr: centsToInput(deal?.mrr_cents ?? null),
      setup: deal?.setup_cents ? centsToInput(deal.setup_cents) : '',
      probability: deal?.probability != null ? String(deal.probability) : '',
      expected_close: deal?.expected_close ?? '',
      lost_reason: deal?.lost_reason ?? '',
    });
  }, [open, deal, accountId]);

  if (!open) return null;
  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }));

  const save = async () => {
    const mrr = parseEuroInput(form.mrr);
    const setup = parseEuroInput(form.setup);
    const probability = form.probability.trim() === '' ? null : Number(form.probability);
    if (!form.title.trim()) return setError('Scrivi un titolo');
    if (!deal && !Number(form.account_id)) return setError("Scegli l'azienda");
    if (Number.isNaN(mrr) || Number.isNaN(setup)) return setError('Importo non valido');
    if (probability !== null && (!Number.isInteger(probability) || probability < 0 || probability > 100)) {
      return setError('La probabilità va da 0 a 100');
    }
    const body: Partial<CrmDeal> = {
      title: form.title.trim(),
      kind: form.kind,
      stage: form.stage,
      mrr_cents: mrr ?? 0,
      setup_cents: setup ?? 0,
      probability,
      expected_close: form.expected_close || null,
      lost_reason: form.stage === 'persa' ? form.lost_reason.trim() || null : null,
    };
    setBusy(true);
    setError(null);
    try {
      const saved = deal
        ? await platformCrmApi.updateDeal(deal.id, body)
        : await platformCrmApi.createDeal(Number(form.account_id), body);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError((err as ApiError).message || 'Salvataggio non riuscito');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deal) return;
    if (!armDelete) { setArmDelete(true); return; }
    setBusy(true);
    try {
      await platformCrmApi.deleteDeal(deal.id);
      showToast('Opportunità eliminata', 'success');
      onSaved(null);
      onClose();
    } catch (err) {
      setError((err as ApiError).message || 'Eliminazione non riuscita');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title={deal ? deal.title : 'Nuova opportunità'}
      subtitle={deal?.account_name ?? undefined}
      size="md"
      bodyClassName="p-5 sm:p-6"
      footerStart={deal ? (
        <button type="button" className={armDelete ? dsButton.critical : dsButton.quiet} onClick={remove} disabled={busy}>
          <Trash2 className="h-4 w-4" aria-hidden />{armDelete ? 'Conferma' : 'Elimina'}
        </button>
      ) : undefined}
      footer={
        <>
          <button type="button" className={dsButton.secondary} onClick={onClose} disabled={busy}>Annulla</button>
          <button type="button" className={dsButton.primary} onClick={save} disabled={busy}>{busy ? 'Salvo…' : 'Salva'}</button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}
        <FormCard>
          <div className="space-y-4">
            {!deal && !accountId && (
              <Field label="Azienda" htmlFor="deal-account" required>
                <select id="deal-account" className={dsSelect} value={form.account_id} onChange={e => set({ account_id: e.target.value })}>
                  <option value="">Scegli…</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Titolo" htmlFor="deal-title" required>
              <input id="deal-title" className={dsInput} value={form.title} placeholder="Sympotia completo + Sofia" onChange={e => set({ title: e.target.value })} autoFocus={!deal} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tipo" htmlFor="deal-kind">
                <select id="deal-kind" className={dsSelect} value={form.kind} onChange={e => set({ kind: e.target.value as CrmDealKind })}>
                  {CRM_DEAL_KINDS.map(k => <option key={k} value={k}>{DEAL_KIND_LABEL[k]}</option>)}
                </select>
              </Field>
              <Field label="Fase" htmlFor="deal-stage">
                <select id="deal-stage" className={dsSelect} value={form.stage} onChange={e => set({ stage: e.target.value as CrmDealStage })}>
                  {CRM_DEAL_STAGES.map(s => <option key={s} value={s}>{DEAL_STAGE_LABEL[s]}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Canone (€/mese)" htmlFor="deal-mrr">
                <input id="deal-mrr" className={dsInput} inputMode="decimal" value={form.mrr} placeholder="99" onChange={e => set({ mrr: e.target.value })} />
              </Field>
              <Field label="Una tantum (€)" htmlFor="deal-setup">
                <input id="deal-setup" className={dsInput} inputMode="decimal" value={form.setup} placeholder="0" onChange={e => set({ setup: e.target.value })} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Probabilità (%)" htmlFor="deal-prob">
                <input id="deal-prob" className={dsInput} inputMode="numeric" value={form.probability} placeholder={String(DEFAULT_PROBABILITY[form.stage])} onChange={e => set({ probability: e.target.value })} />
              </Field>
              <Field label="Chiusura prevista" htmlFor="deal-close">
                <input id="deal-close" type="date" className={dsInput} value={form.expected_close} min={deal ? undefined : todayRome()} onChange={e => set({ expected_close: e.target.value })} />
              </Field>
            </div>
            {form.stage === 'persa' && (
              <Field label="Motivo" htmlFor="deal-lost">
                <input id="deal-lost" className={dsInput} value={form.lost_reason} placeholder="prezzo, tempi, concorrente…" onChange={e => set({ lost_reason: e.target.value })} />
              </Field>
            )}
          </div>
        </FormCard>
      </div>
    </ModalShell>
  );
};

/* ── Card nella colonna ───────────────────────────────────────────────── */
const DealCard: React.FC<{
  deal: CrmDeal;
  onOpenAccount: (id: number) => void;
  onEdit: (deal: CrmDeal) => void;
  onMove: (deal: CrmDeal, stage: CrmDealStage) => void;
}> = ({ deal, onOpenAccount, onEdit, onMove }) => {
  const late = !!deal.expected_close && deal.expected_close < todayRome() && !CLOSED_STAGES.includes(deal.stage);
  return (
    <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
      <button
        type="button"
        onClick={() => onOpenAccount(deal.account_id)}
        className="block max-w-full truncate text-left text-[13px] font-medium text-[var(--ds-text-secondary)] underline-offset-4 hover:text-[var(--ds-text-primary)] hover:underline"
      >
        {deal.account_name}
      </button>
      <button type="button" onClick={() => onEdit(deal)} className="mt-0.5 block w-full text-left">
        <span className="block text-[15px] font-semibold leading-snug text-[var(--ds-text-primary)]">{deal.title}</span>
        <span className="mt-1 block text-[13px] tabular-nums text-[var(--ds-text-muted)]">
          <span className="font-semibold text-[var(--ds-text-primary)]">{eur(deal.mrr_cents)}</span>/mese
          {deal.setup_cents > 0 && ` + ${eur(deal.setup_cents)}`}
          {!CLOSED_STAGES.includes(deal.stage) && ` · ${deal.effective_probability}%`}
        </span>
        <span className="mt-0.5 block text-[12px] text-[var(--ds-text-muted)]">
          {DEAL_KIND_LABEL[deal.kind]}
          {deal.expected_close && !CLOSED_STAGES.includes(deal.stage) && (
            <> · <span className={late ? 'font-medium text-[var(--ds-critical-text)]' : ''}>entro {formatDay(deal.expected_close)}</span></>
          )}
          {deal.closed_at && CLOSED_STAGES.includes(deal.stage) && ` · ${formatDay(deal.closed_at.slice(0, 10))}`}
          {deal.stage === 'persa' && deal.lost_reason && ` · ${deal.lost_reason}`}
        </span>
      </button>
      <select
        className={`${dsSelect} mt-2 !h-9 text-[13px]`}
        value={deal.stage}
        onChange={e => onMove(deal, e.target.value as CrmDealStage)}
        aria-label={`Fase di ${deal.title}`}
      >
        {CRM_DEAL_STAGES.map(s => <option key={s} value={s}>{DEAL_STAGE_LABEL[s]}</option>)}
      </select>
    </div>
  );
};

export const PlatformCrmPipeline: React.FC<{
  accounts: Array<{ id: number; name: string }>;
  onOpenAccount: (id: number) => void;
  showToast: ShowToast;
}> = ({ accounts, onOpenAccount, showToast }) => {
  const [deals, setDeals] = useState<CrmDeal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'aperte' | 'chiuse'>('aperte');
  const [editing, setEditing] = useState<CrmDeal | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setDeals(await platformCrmApi.listDeals());
    } catch (err) {
      setError((err as ApiError).message || 'Caricamento non riuscito');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const move = async (deal: CrmDeal, stage: CrmDealStage) => {
    if (stage === deal.stage) return;
    const prev = deals;
    setDeals(ds => ds?.map(d => (d.id === deal.id ? { ...d, stage, effective_probability: d.probability ?? DEFAULT_PROBABILITY[stage] } : d)) ?? null);
    try {
      const saved = await platformCrmApi.updateDeal(deal.id, { stage });
      setDeals(ds => ds?.map(d => (d.id === saved.id ? saved : d)) ?? null);
      if (stage === 'vinta') showToast(`Vinta: ${deal.title}`, 'success');
    } catch (err) {
      setDeals(prev);
      showToast((err as ApiError).message || 'Spostamento non riuscito', 'error');
    }
  };

  const stages = view === 'aperte' ? OPEN_STAGES : CLOSED_STAGES;
  const columns = useMemo(() => stages.map(stage => {
    const list = (deals ?? []).filter(d => d.stage === stage);
    return {
      stage,
      list,
      total: list.reduce((s, d) => s + d.mrr_cents, 0),
      weighted: list.reduce((s, d) => s + Math.round(d.mrr_cents * d.effective_probability / 100), 0),
    };
  }), [deals, stages]);

  const openTotals = useMemo(() => {
    const open = (deals ?? []).filter(d => OPEN_STAGES.includes(d.stage));
    return {
      count: open.length,
      mrr: open.reduce((s, d) => s + d.mrr_cents, 0),
      weighted: open.reduce((s, d) => s + Math.round(d.mrr_cents * d.effective_probability / 100), 0),
    };
  }, [deals]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1 sm:max-w-xs">
          <SegmentedControl
            value={view}
            onChange={v => setView(v)}
            ariaLabel="Opportunità aperte o chiuse"
            options={[
              { value: 'aperte', label: 'Aperte', badge: openTotals.count || undefined, badgeTone: 'neutral' },
              { value: 'chiuse', label: 'Chiuse' },
            ]}
          />
        </div>
        {view === 'aperte' && deals && (
          <p className="text-[13px] tabular-nums text-[var(--ds-text-muted)]">
            {eur(openTotals.mrr)}/mese in tutto · pesata {eur(openTotals.weighted)}
          </p>
        )}
        <div className="ml-auto flex gap-2">
          <button type="button" className={dsButton.quiet} onClick={load} aria-label="Aggiorna"><RefreshCw className="h-4 w-4" aria-hidden /></button>
          <button type="button" className={dsButton.primary} onClick={() => setCreating(true)} disabled={accounts.length === 0}>
            <Plus className="h-4 w-4" aria-hidden />Opportunità
          </button>
        </div>
      </div>

      {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}
      {!deals && !error && <div className="flex h-40 items-center justify-center"><Loader /></div>}
      {deals && deals.length === 0 && (
        <EmptyState icon={Kanban}>Nessuna opportunità. Aprine una da qui o dalla scheda di un'azienda.</EmptyState>
      )}
      {deals && deals.length > 0 && (
        <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
          <div className={`flex gap-3 lg:grid ${view === 'aperte' ? 'lg:grid-cols-4' : 'lg:grid-cols-2'}`}>
            {columns.map(col => (
              <section key={col.stage} className="flex w-[272px] flex-none flex-col gap-2 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-2 lg:w-auto">
                <header className="flex items-baseline gap-2 px-1 pt-1">
                  <h3 className="text-[14px] font-semibold text-[var(--ds-text-primary)]">{DEAL_STAGE_LABEL[col.stage]}</h3>
                  <span className="text-[13px] tabular-nums text-[var(--ds-text-muted)]">{col.list.length}</span>
                  <span className="ml-auto text-[12px] tabular-nums text-[var(--ds-text-muted)]" title={view === 'aperte' ? `pesata ${eur(col.weighted)}` : undefined}>
                    {eur(col.total)}
                  </span>
                </header>
                {col.list.length === 0 ? (
                  <p className="px-1 pb-2 text-[13px] text-[var(--ds-text-muted)]">—</p>
                ) : (
                  col.list.map(d => (
                    <DealCard key={d.id} deal={d} onOpenAccount={onOpenAccount} onEdit={setEditing} onMove={move} />
                  ))
                )}
              </section>
            ))}
          </div>
        </div>
      )}

      <DealFormModal
        open={creating || editing !== null}
        onClose={() => { setCreating(false); setEditing(null); }}
        deal={editing}
        accounts={accounts}
        onSaved={() => load()}
        showToast={showToast}
      />
    </div>
  );
};

export default PlatformCrmPipeline;
