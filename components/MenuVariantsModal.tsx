import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronUp, Edit2, Loader2, Plus, Trash2 } from 'lucide-react';
import type { Modifier } from '../types';
import {
  type AdminModifierGroup,
  createModifier, createModifierGroup, deleteModifier, deleteModifierGroup,
  saveModifierGroupOrder, saveModifierOrder, updateModifier, updateModifierGroup,
} from '../services/apiService';
import { Callout, Field, ModalShell, dsButton, dsIconButton, dsInput } from './ds';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { euro } from './comande/orderView';

// ---------------------------------------------------------------------------
// Gestione dei gruppi di varianti — la sorella della modale «Categorie», e ne
// parla la lingua: righe divise, frecce col salvataggio immediato, switch,
// matita, cestino disabilitato con il perché nel title.
//
// I gruppi della cassa (external_ref pp:varianti:…) si riconoscono dalla
// pill: membri e massimo sono suoi (il sync li riscrive a ogni import, e il
// server risponde 409), ma rinomina, obbligo, interruttore e ordine sono del
// ristoratore e sopravvivono agli import.
// ---------------------------------------------------------------------------

const isPP = (g: AdminModifierGroup): boolean => !!g.external_ref?.startsWith('pp:varianti:');

const errMsg = (e: any): string => e?.data?.error ?? e?.message ?? 'Operazione non riuscita';

/** «+2,50 €» / «−1,00 €» / «+10%» — il sovrapprezzo come lo legge l'operatore. */
const deltaLabel = (m: Modifier): string | null => {
  if (m.price_delta_pct != null) {
    const pct = Number(m.price_delta_pct);
    return pct === 0 ? null : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`;
  }
  if (m.price_delta_cents === 0) return null;
  return `${m.price_delta_cents > 0 ? '+' : '−'}${euro(Math.abs(m.price_delta_cents))}`;
};

export const MenuVariantsModal: React.FC<{
  open: boolean;
  onClose: () => void;
  groups: AdminModifierGroup[];
  /** Rilettura nel padre dopo ogni scrittura: la lista è sua, la condivide
   *  con l'editor piatto. */
  onChanged: () => void;
}> = ({ open, onClose, groups, onChanged }) => {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<AdminModifierGroup | null>(null);
  // «+ Nuovo gruppo»: solo il nome, il resto si rifinisce nell'editor.
  const [createName, setCreateName] = useState<string | null>(null);

  useEffect(() => { if (!open) { setEditingId(null); setError(null); setCreateName(null); } }, [open]);

  const editing = editingId != null ? groups.find(g => g.id === editingId) ?? null : null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); onChanged(); }
    catch (e: any) { setError(errMsg(e)); }
    finally { setBusy(false); }
  };

  if (!open) return null;

  if (editing) {
    return (
      <GroupEditor
        group={editing}
        busy={busy}
        error={error}
        onBack={() => { setEditingId(null); setError(null); }}
        onClose={onClose}
        run={run}
      />
    );
  }

  return (
    <>
      <ModalShell
        open
        onClose={onClose}
        title="Varianti"
        subtitle="I gruppi si agganciano ai piatti dalla loro scheda"
        size="sm"
        bodyClassName="p-2"
      >
        <div className="divide-y divide-[var(--ds-border)]">
          {groups.length === 0 && (
            <p className="px-3 py-8 text-center text-[14px] text-[var(--ds-text-muted)]">
              Nessun gruppo di varianti. Creane uno, o importali dalla cassa.
            </p>
          )}
          {groups.map((g, i) => (
            <div key={g.id} className={`flex items-center gap-2 px-3 py-2.5 ${g.is_active ? '' : 'opacity-60'}`}>
              <div className="flex flex-shrink-0 items-center">
                <button
                  type="button"
                  disabled={busy || i === 0}
                  onClick={() => run(() => saveModifierGroupOrder(
                    groups.map(x => x.id).map((id, j) => j === i - 1 ? groups[i].id : j === i ? groups[i - 1].id : id)
                  ))}
                  className={`${dsIconButton} h-9 w-8 bg-transparent shadow-none disabled:opacity-30`}
                  title="Sposta su"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  disabled={busy || i === groups.length - 1}
                  onClick={() => run(() => saveModifierGroupOrder(
                    groups.map(x => x.id).map((id, j) => j === i ? groups[i + 1].id : j === i + 1 ? groups[i].id : id)
                  ))}
                  className={`${dsIconButton} h-9 w-8 bg-transparent shadow-none disabled:opacity-30`}
                  title="Sposta giù"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium text-[var(--ds-text-primary)]">{g.name}</div>
                {/* La pill sta coi conteggi, non accanto al nome: le etichette
                    dei gruppi pp sono lunghe e sul telefono il nome finiva
                    schiacciato a una lettera. */}
                <div className="flex flex-wrap items-center gap-x-1.5 text-[12px] tabular-nums text-[var(--ds-text-muted)]">
                  {isPP(g) && (
                    <span className="rounded-full bg-[var(--ds-surface-row)] px-1.5 py-0.5 text-[11px] font-medium">
                      dalla cassa
                    </span>
                  )}
                  <span>
                    {g.dish_ids.length} {g.dish_ids.length === 1 ? 'piatto' : 'piatti'} · {g.modifiers.length} {g.modifiers.length === 1 ? 'opzione' : 'opzioni'}
                  </span>
                  {g.min_select > 0 && <span className="text-[var(--ds-pending-text)]">· obbligatorio</span>}
                </div>
              </div>
              <button
                type="button" role="switch" aria-checked={g.is_active}
                aria-label={`${g.is_active ? 'Spegni' : 'Accendi'} ${g.name}`}
                disabled={busy}
                onClick={() => run(() => updateModifierGroup(g.id, { is_active: !g.is_active }))}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50 ${
                  g.is_active ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                }`}
              >
                <span aria-hidden="true"
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${g.is_active ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
              </button>
              <button
                type="button"
                onClick={() => { setEditingId(g.id); setError(null); }}
                className={`${dsIconButton} h-9 w-9 flex-shrink-0 bg-[var(--ds-surface-row)] shadow-none`}
                title="Apri il gruppo"
              >
                <Edit2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={isPP(g) || g.dish_ids.length > 0}
                onClick={() => setDeleteConfirm(g)}
                className={`${dsIconButton} h-9 w-9 flex-shrink-0 bg-[var(--ds-surface-row)] shadow-none disabled:opacity-30 hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)]`}
                title={isPP(g)
                  ? 'Lo gestisce la cassa: verrebbe ricreato al prossimo import'
                  : g.dish_ids.length > 0 ? 'È usato da piatti: sgancialo prima di eliminarlo' : 'Elimina gruppo'}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        {error && <p className="px-3 pt-2 text-[13px] text-[var(--ds-critical-text)]">{error}</p>}
        <div className="px-3 py-3">
          <button
            type="button"
            onClick={() => setCreateName('')}
            className={`${dsButton.quiet} h-9 px-4 text-[13px]`}
          >
            <Plus className="h-3.5 w-3.5" /> Nuovo gruppo
          </button>
        </div>
      </ModalShell>

      {createName !== null && (
        <ModalShell
          open
          onClose={() => setCreateName(null)}
          title="Nuovo gruppo di varianti"
          size="sm"
          bodyClassName="p-5"
          footer={
            <>
              <button type="button" onClick={() => setCreateName(null)} className={dsButton.secondary}>
                Annulla
              </button>
              <button
                type="submit"
                form="variant-group-form"
                disabled={busy || !createName.trim()}
                className={dsButton.primary}
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Crea gruppo
              </button>
            </>
          }
        >
          <form
            id="variant-group-form"
            onSubmit={async e => {
              e.preventDefault();
              const name = createName.trim();
              if (!name) return;
              setBusy(true); setError(null);
              try {
                const g = await createModifierGroup({ name });
                onChanged();
                setCreateName(null);
                setEditingId(g.id);
              } catch (err: any) { setError(errMsg(err)); }
              finally { setBusy(false); }
            }}
            className="space-y-3"
          >
            <Field label="Nome" required>
              <input
                autoFocus
                required
                maxLength={100}
                placeholder="es. Cottura, Aggiunte…"
                className={dsInput}
                value={createName}
                onChange={e => setCreateName(e.target.value)}
              />
            </Field>
            {error && <p className="text-[13px] text-[var(--ds-critical-text)]">{error}</p>}
          </form>
        </ModalShell>
      )}

      <ConfirmDeleteModal
        isOpen={!!deleteConfirm}
        title="Elimina gruppo"
        message="Le righe già battute non si toccano (portano una copia delle varianti). Stai per eliminare:"
        itemName={deleteConfirm?.name}
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={() => {
          if (deleteConfirm) run(() => deleteModifierGroup(deleteConfirm.id));
          setDeleteConfirm(null);
        }}
      />
    </>
  );
};

/* ── Editor di un gruppo ──────────────────────────────────────────────────
   Nome, obbligo e tetto in testa; sotto le opzioni, ognuna col suo
   sovrapprezzo in € o in % del prezzo del piatto. Ogni ritocco salva subito,
   come le frecce della modale Categorie: qui non c'è un «Salva» finale. */
const GroupEditor: React.FC<{
  group: AdminModifierGroup;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onClose: () => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}> = ({ group, busy, error, onBack, onClose, run }) => {
  const pp = isPP(group);
  const [name, setName] = useState(group.name);
  const [newMod, setNewMod] = useState('');

  useEffect(() => { setName(group.name); }, [group.id, group.name]);

  const commitName = () => {
    const next = name.trim();
    if (next && next !== group.name) run(() => updateModifierGroup(group.id, { name: next }));
    else setName(group.name);
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title={group.name}
      subtitle={pp ? undefined : 'Le modifiche si salvano da sole'}
      size="sm"
      bodyClassName="space-y-4 p-5"
      footerStart={
        <button type="button" onClick={onBack} className={dsButton.quiet}>
          <ChevronLeft className="h-4 w-4" /> Tutti i gruppi
        </button>
      }
    >
      {pp && (
        <Callout tone="pending">
          Le opzioni e il massimo arrivano dalla cassa e si riallineano a ogni
          import. Qui puoi rinominarlo, renderlo obbligatorio o spegnerlo.
        </Callout>
      )}

      <Field label="Nome">
        <input
          className={dsInput}
          maxLength={100}
          value={name}
          disabled={busy}
          onChange={e => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Scelte minime">
          <select
            className={dsInput}
            value={group.min_select}
            disabled={busy}
            onChange={e => run(() => updateModifierGroup(group.id, { min_select: Number(e.target.value) }))}
          >
            {[0, 1, 2, 3].filter(n => n <= group.max_select).map(n => (
              <option key={n} value={n}>{n === 0 ? '0 · facoltativo' : n === 1 ? '1 · obbligatorio' : n}</option>
            ))}
          </select>
        </Field>
        <Field label="Scelte massime">
          <select
            className={dsInput}
            value={group.max_select}
            disabled={busy || pp}
            title={pp ? 'Il massimo lo decide la cassa' : undefined}
            onChange={e => run(() => updateModifierGroup(group.id, { max_select: Number(e.target.value) }))}
          >
            {[1, 2, 3, 4, 5, 6, 8, 10].filter(n => n >= group.min_select || n === group.max_select).map(n => (
              <option key={n} value={n}>{n === 1 ? '1 · scelta singola' : n}</option>
            ))}
          </select>
        </Field>
      </div>

      <div>
        <div className="mb-1 text-[13px] font-semibold text-[var(--ds-text-muted)]">Opzioni</div>
        <div className="divide-y divide-[var(--ds-border)] rounded-[14px] bg-[var(--ds-surface-row)] px-3">
          {group.modifiers.length === 0 && (
            <p className="py-4 text-center text-[13px] text-[var(--ds-text-muted)]">Nessuna opzione.</p>
          )}
          {group.modifiers.map((m, i) => (
            <MemberRow
              key={m.id}
              modifier={m}
              readOnly={pp}
              busy={busy}
              first={i === 0}
              last={i === group.modifiers.length - 1}
              onMove={dir => {
                const ids = group.modifiers.map(x => x.id);
                const j = dir === 'up' ? i - 1 : i + 1;
                [ids[i], ids[j]] = [ids[j], ids[i]];
                run(() => saveModifierOrder(group.id, ids));
              }}
              run={run}
            />
          ))}
        </div>
        {!pp && (
          <form
            className="mt-2 flex gap-2"
            onSubmit={e => {
              e.preventDefault();
              const n = newMod.trim();
              if (!n) return;
              run(() => createModifier(group.id, { name: n })).then(() => setNewMod(''));
            }}
          >
            <input
              className={`${dsInput} flex-1`}
              maxLength={100}
              placeholder="Nuova opzione…"
              value={newMod}
              disabled={busy}
              onChange={e => setNewMod(e.target.value)}
            />
            <button type="submit" disabled={busy || !newMod.trim()} className={dsButton.secondary}>
              <Plus className="h-4 w-4" /> Aggiungi
            </button>
          </form>
        )}
      </div>

      {error && <p className="text-[13px] text-[var(--ds-critical-text)]">{error}</p>}
    </ModalShell>
  );
};

/* ── Riga opzione ─────────────────────────────────────────────────────────
   Nome e sovrapprezzo si ritoccano sul posto (salvataggio al blur); il
   selettore €/% cambia la natura del sovrapprezzo: in € è fisso, in % segue
   il prezzo del piatto a cui il gruppo è agganciato. */
const MemberRow: React.FC<{
  modifier: Modifier;
  readOnly: boolean;
  busy: boolean;
  first: boolean;
  last: boolean;
  onMove: (dir: 'up' | 'down') => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}> = ({ modifier: m, readOnly, busy, first, last, onMove, run }) => {
  const isPct = m.price_delta_pct != null;
  const [name, setName] = useState(m.name);
  const [amount, setAmount] = useState(() =>
    isPct ? String(Number(m.price_delta_pct)) : m.price_delta_cents === 0 ? '' : (m.price_delta_cents / 100).toFixed(2));

  useEffect(() => {
    setName(m.name);
    setAmount(m.price_delta_pct != null
      ? String(Number(m.price_delta_pct))
      : m.price_delta_cents === 0 ? '' : (m.price_delta_cents / 100).toFixed(2));
  }, [m.id, m.name, m.price_delta_cents, m.price_delta_pct]);

  const commitName = () => {
    const next = name.trim();
    if (next && next !== m.name) run(() => updateModifier(m.id, { name: next }));
    else setName(m.name);
  };

  const commitAmount = () => {
    const raw = amount.trim().replace(',', '.');
    const n = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(n)) { setAmount(''); return; }
    if (isPct) {
      if (Number(m.price_delta_pct) !== n) run(() => updateModifier(m.id, { price_delta_pct: n }));
    } else {
      const cents = Math.round(n * 100);
      if (m.price_delta_cents !== cents) run(() => updateModifier(m.id, { price_delta_cents: cents, price_delta_pct: null }));
    }
  };

  const switchKind = (toPct: boolean) => {
    if (toPct === isPct) return;
    const raw = Number(amount.trim().replace(',', '.')) || 0;
    run(() => updateModifier(m.id, toPct
      ? { price_delta_pct: raw }
      : { price_delta_pct: null, price_delta_cents: Math.round(raw * 100) }));
  };

  if (readOnly) {
    return (
      <div className={`flex min-h-[44px] items-center gap-2 py-2 ${m.is_active ? '' : 'opacity-60'}`}>
        <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--ds-text-primary)]">{m.name}</span>
        {deltaLabel(m) && <span className="flex-shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">{deltaLabel(m)}</span>}
      </div>
    );
  }

  return (
    <div className="flex min-h-[52px] flex-wrap items-center gap-2 py-2">
      <input
        className="h-9 min-w-0 flex-1 rounded-[10px] bg-[var(--ds-surface)] px-3 text-[14px] text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        maxLength={100}
        value={name}
        disabled={busy}
        onChange={e => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <div className="flex flex-shrink-0 items-center gap-1">
        <input
          className="h-9 w-20 rounded-[10px] bg-[var(--ds-surface)] px-2 text-right text-[14px] tabular-nums text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          inputMode="decimal"
          placeholder="0"
          value={amount}
          disabled={busy}
          onChange={e => setAmount(e.target.value)}
          onBlur={commitAmount}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        {(['€', '%'] as const).map(k => {
          const active = (k === '%') === isPct;
          return (
            <button
              key={k}
              type="button"
              disabled={busy}
              onClick={() => switchKind(k === '%')}
              aria-pressed={active}
              title={k === '%' ? 'Percentuale del prezzo del piatto' : 'Importo fisso'}
              className={`inline-flex h-9 w-8 items-center justify-center rounded-[10px] text-[13px] font-medium transition-colors ${
                active ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
              }`}
            >
              {k}
            </button>
          );
        })}
      </div>
      <div className="flex flex-shrink-0 items-center">
        <button
          type="button"
          disabled={busy || first}
          onClick={() => onMove('up')}
          className={`${dsIconButton} h-9 w-8 bg-transparent shadow-none disabled:opacity-30`}
          title="Sposta su"
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          disabled={busy || last}
          onClick={() => onMove('down')}
          className={`${dsIconButton} h-9 w-8 bg-transparent shadow-none disabled:opacity-30`}
          title="Sposta giù"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={m.is_active}
          aria-label={`${m.is_active ? 'Spegni' : 'Accendi'} ${m.name}`}
          disabled={busy}
          onClick={() => run(() => updateModifier(m.id, { is_active: !m.is_active }))}
          className={`${dsIconButton} h-9 w-9 bg-transparent shadow-none ${m.is_active ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-text-subtle)]'}`}
          title={m.is_active ? 'Attiva — tocca per spegnere' : 'Spenta — tocca per accendere'}
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => deleteModifier(m.id))}
          className={`${dsIconButton} h-9 w-9 bg-transparent shadow-none hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)]`}
          title="Elimina opzione"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};
