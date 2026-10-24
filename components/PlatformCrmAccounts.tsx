import React, { useMemo, useState } from 'react';
import { AlertTriangle, Building2, Download, Plus, RefreshCw, Upload } from 'lucide-react';
import {
  Callout, EmptyState, FormCard, ModalShell, PanePlaceholder, SearchField, SegmentedControl, SplitPane, StatusPill,
  dsButton, dsIconButton, dsSelect, dsTextarea,
} from './ds';
import { Loader } from './Loader';
import {
  platformCrmApi, CRM_PRESALE_STAGES, CRM_STAGES,
  type CrmAccount, type CrmAccountDetail, type CrmImportRow, type CrmStage,
} from '../services/platformCrmApiService';
import type { AdminTenant } from '../services/apiService';
import {
  HealthPill, STAGE_LABEL, StagePill, downloadText, dueLabel, eur, parseCsv, parseEuroInput, todayRome, toCsv,
  type ShowToast,
} from './PlatformCrmShared';
import { AccountFormModal, PlatformCrmAccountDetail } from './PlatformCrmAccountDetail';
import { relativeTime } from '../utils/relativeTime';
import type { ApiError } from '../services/apiError';

/* ============================================
   PANNELLO PIATTAFORMA — CRM, Clienti
   ============================================
   Lead e ristoranti in una lista sola, con la scheda accanto (a schermo
   intero su telefono, come le altre liste del pannello). I ristoranti
   compaiono da soli: il server dà una scheda a ogni tenant che non ce l'ha.
   La lista arriva dal pannello, che la tiene anche per Pipeline e
   Promemoria (scelta dell'azienda). */

type Filter = 'tutti' | 'lead' | 'prova' | 'clienti' | 'seguire' | 'chiusi' | 'interni';
type Sort = 'nome' | 'attivita' | 'mrr' | 'salute' | 'promemoria';

const FILTERS: Record<Filter, (a: CrmAccount) => boolean> = {
  tutti: a => !a.internal,
  lead: a => !a.internal && CRM_PRESALE_STAGES.includes(a.stage),
  prova: a => !a.internal && a.stage === 'prova',
  clienti: a => !a.internal && a.stage === 'cliente',
  seguire: a => !a.internal && (a.stage === 'cliente' || a.stage === 'prova') && !!a.health && a.health.level !== 'sano',
  chiusi: a => !a.internal && (a.stage === 'perso' || a.stage === 'disdetto'),
  interni: a => a.internal,
};

const SORTERS: Record<Sort, (a: CrmAccount, b: CrmAccount) => number> = {
  nome: (a, b) => a.name.localeCompare(b.name, 'it'),
  attivita: (a, b) => (b.last_activity_at ?? b.updated_at).localeCompare(a.last_activity_at ?? a.updated_at),
  mrr: (a, b) => (b.mrr_cents || b.expected_mrr_cents || 0) - (a.mrr_cents || a.expected_mrr_cents || 0),
  salute: (a, b) => (a.health?.score ?? 101) - (b.health?.score ?? 101),
  promemoria: (a, b) => (a.next_task_due ?? '9999').localeCompare(b.next_task_due ?? '9999'),
};

const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/* ── Import CSV ──────────────────────────────────────────────────────────
   Le intestazioni si riconoscono per nome (italiano o inglese, maiuscole e
   accenti a parte); le colonne sconosciute si ignorano e lo si dice. */
const IMPORT_HEADERS: Record<string, keyof CrmImportRow> = {};
const alias = (key: keyof CrmImportRow, names: string[]) => names.forEach(n => { IMPORT_HEADERS[normalize(n)] = key; });
alias('name', ['nome', 'name', 'locale', 'ristorante', 'azienda', 'insegna']);
alias('city', ['citta', 'city', 'comune', 'localita']);
alias('address', ['indirizzo', 'address', 'via']);
alias('phone', ['telefono', 'phone', 'tel', 'telefono locale']);
alias('email', ['email', 'e-mail', 'mail']);
alias('website', ['sito', 'website', 'web', 'url']);
alias('business_type', ['tipo', 'tipologia', 'categoria', 'tipo locale']);
alias('source', ['fonte', 'origine', 'source', 'canale']);
alias('current_software', ['software', 'gestionale', 'usa oggi']);
alias('vat_number', ['partita iva', 'p.iva', 'piva', 'vat']);
alias('legal_name', ['ragione sociale']);
alias('seats', ['coperti', 'posti', 'seats']);
alias('stage', ['fase', 'stage', 'stato']);
alias('tags', ['tag', 'tags', 'etichette']);
alias('notes', ['note', 'notes']);
alias('expected_mrr_cents', ['canone', 'mrr', 'canone mensile']);
alias('contact_name', ['referente', 'contatto', 'titolare', 'contact']);
alias('contact_role', ['ruolo', 'role']);
alias('contact_phone', ['telefono referente', 'cellulare', 'cellulare referente']);
alias('contact_email', ['email referente']);

const ImportModal: React.FC<{ open: boolean; onClose: () => void; onDone: () => void; showToast: ShowToast }> = ({ open, onClose, onDone, showToast }) => {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number; errors: Array<{ row: number; message: string }> } | null>(null);

  const parsed = useMemo(() => {
    const rows = parseCsv(text);
    if (rows.length < 2) return null;
    const header = rows[0].map(h => IMPORT_HEADERS[normalize(h.trim())] ?? null);
    const unknown = rows[0].filter((_, i) => header[i] === null).map(h => h.trim()).filter(Boolean);
    const out: CrmImportRow[] = rows.slice(1).map(r => {
      const row: CrmImportRow = {};
      header.forEach((key, i) => {
        const value = (r[i] ?? '').trim();
        if (!key || !value) return;
        if (key === 'expected_mrr_cents') {
          const cents = parseEuroInput(value);
          if (cents !== null && !Number.isNaN(cents)) row.expected_mrr_cents = String(cents);
        } else if (key === 'stage') {
          const stage = normalize(value);
          const match = CRM_STAGES.find(s => s === stage || normalize(STAGE_LABEL[s]) === stage);
          if (match) row.stage = match;
        } else {
          row[key] = value;
        }
      });
      return row;
    });
    return { rows: out, hasName: header.includes('name'), unknown };
  }, [text]);

  const close = () => { setText(''); setResult(null); onClose(); };

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const submit = async () => {
    if (!parsed?.hasName || busy) return;
    setBusy(true);
    try {
      const res = await platformCrmApi.importAccounts(parsed.rows);
      setResult(res);
      if (res.created > 0) onDone();
    } catch (err) {
      showToast((err as ApiError).message || 'Importazione non riuscita', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <ModalShell
      open
      onClose={close}
      title="Importa aziende"
      subtitle="Da un file CSV o da un foglio incollato"
      size="md"
      bodyClassName="p-5 sm:p-6"
      footer={result ? (
        <button type="button" className={dsButton.primary} onClick={close}>Fatto</button>
      ) : (
        <>
          <button type="button" className={dsButton.secondary} onClick={close}>Annulla</button>
          <button type="button" className={dsButton.primary} onClick={submit} disabled={!parsed?.hasName || busy}>
            {busy ? 'Importo…' : parsed ? `Importa ${parsed.rows.length}` : 'Importa'}
          </button>
        </>
      )}
    >
      {result ? (
        <div className="space-y-3">
          <Callout tone={result.created > 0 ? 'positive' : 'info'} icon={Building2}>
            {result.created} nuove · {result.skipped} già presenti (stesso nome e città)
          </Callout>
          {result.errors.length > 0 && (
            <Callout tone="critical" icon={AlertTriangle} title={`${result.errors.length} righe scartate`}>
              <ul className="mt-1 space-y-0.5">
                {result.errors.slice(0, 10).map(e => <li key={e.row}>Riga {e.row}: {e.message}</li>)}
              </ul>
            </Callout>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <FormCard>
            <label className={`${dsButton.secondary} cursor-pointer`}>
              <Upload className="h-4 w-4" aria-hidden />Scegli un file .csv
              <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={e => e.target.files?.[0] && readFile(e.target.files[0])} />
            </label>
            <textarea
              className={`${dsTextarea} mt-3 min-h-[140px] font-mono text-[13px]`}
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={'nome;città;telefono;referente;fonte\nOsteria del Ponte;Bologna;051 123456;Marco Rossi;fiera'}
              aria-label="Righe da importare"
            />
            <p className="mt-2 text-[13px] text-[var(--ds-text-muted)]">
              Colonne riconosciute: nome, città, indirizzo, telefono, email, sito, tipo, fonte, software, partita iva, coperti, fase, tag, note, canone, referente, ruolo, cellulare, email referente.
            </p>
          </FormCard>
          {parsed && !parsed.hasName && <Callout tone="critical" icon={AlertTriangle}>Manca la colonna «nome».</Callout>}
          {parsed?.hasName && (
            <Callout tone="info" icon={Building2}>
              {parsed.rows.length} righe pronte{parsed.unknown.length ? ` · ignorate: ${parsed.unknown.join(', ')}` : ''}
            </Callout>
          )}
        </div>
      )}
    </ModalShell>
  );
};

export const PlatformCrmAccounts: React.FC<{
  accounts: CrmAccount[] | null;
  error: string | null;
  onReload: () => void;
  onAccountChanged: (detail: CrmAccountDetail) => void;
  onAccountRemoved: (id: number) => void;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  tenants: AdminTenant[];
  onTenantPatched: (next: AdminTenant) => void;
  onTenantsChanged: () => void;
  showToast: ShowToast;
}> = ({
  accounts, error, onReload, onAccountChanged, onAccountRemoved, selectedId, onSelect,
  tenants, onTenantPatched, onTenantsChanged, showToast,
}) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('tutti');
  const [sort, setSort] = useState<Sort>('nome');
  const [tag, setTag] = useState('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  const all = accounts ?? [];
  const counts = useMemo(() => {
    const out = {} as Record<Filter, number>;
    (Object.keys(FILTERS) as Filter[]).forEach(f => { out[f] = all.filter(FILTERS[f]).length; });
    return out;
  }, [all]);
  const tags = useMemo(() => [...new Set(all.flatMap(a => a.tags))].sort(), [all]);

  const visible = useMemo(() => {
    const q = normalize(query.trim());
    return all
      .filter(FILTERS[filter])
      .filter(a => !tag || a.tags.includes(tag))
      .filter(a => !q || normalize([
        a.name, a.city, a.email, a.phone, a.tenant?.slug, a.primary_contact?.full_name, a.primary_contact?.email,
        a.primary_contact?.phone, a.vat_number, a.source, ...a.tags,
      ].filter(Boolean).join(' ')).includes(q))
      .sort(SORTERS[sort]);
  }, [all, filter, tag, query, sort]);

  const exportCsv = () => {
    const rows = visible.map(a => ({
      name: a.name, stage: STAGE_LABEL[a.stage], city: a.city, phone: a.phone, email: a.email,
      contact: a.primary_contact?.full_name, contact_phone: a.primary_contact?.phone, contact_email: a.primary_contact?.email,
      business_type: a.business_type, source: a.source, seats: a.seats,
      mrr: ((a.mrr_cents || a.expected_mrr_cents || 0) / 100).toString().replace('.', ','),
      health: a.health ? a.health.score : '', slug: a.tenant?.slug, vat: a.vat_number, tags: a.tags.join(', '),
      last_activity: a.last_activity_at?.slice(0, 10), next_task: a.next_task_due,
    }));
    const csv = toCsv(rows, [
      ['name', 'nome'], ['stage', 'fase'], ['city', 'città'], ['phone', 'telefono'], ['email', 'email'],
      ['contact', 'referente'], ['contact_phone', 'cellulare'], ['contact_email', 'email referente'],
      ['business_type', 'tipo'], ['source', 'fonte'], ['seats', 'coperti'], ['mrr', 'canone'], ['health', 'salute'],
      ['slug', 'slug'], ['vat', 'partita iva'], ['tags', 'tag'], ['last_activity', 'ultima attività'], ['next_task', 'prossimo promemoria'],
    ]);
    downloadText(`clienti-sympotia-${todayRome()}.csv`, csv);
  };

  const renderRow = (a: CrmAccount) => {
    const mrr = a.mrr_cents || a.expected_mrr_cents || 0;
    return (
      <button
        key={a.id}
        type="button"
        onClick={() => onSelect(a.id)}
        aria-current={selectedId === a.id ? 'true' : undefined}
        className={`flex w-full flex-col gap-1 rounded-[var(--ds-radius)] px-3.5 py-3 text-left shadow-[var(--ds-shadow-card)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
          selectedId === a.id ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)] hover:bg-[var(--ds-surface-row)]'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">{a.name}</span>
          {mrr > 0 && (
            <span className={`flex-shrink-0 text-[13px] tabular-nums ${a.mrr_source ? 'font-semibold text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-muted)]'}`}>
              {eur(mrr)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StagePill stage={a.stage} />
          <HealthPill health={a.health} />
          {a.tenant?.status === 'suspended' && <StatusPill tone="critical">sospeso</StatusPill>}
          <span className="min-w-0 truncate text-[13px] text-[var(--ds-text-muted)]">
            {[a.city, a.primary_contact?.full_name].filter(Boolean).join(' · ')}
          </span>
        </div>
        {(() => {
          const parts: React.ReactNode[] = [];
          if (a.next_task_due) {
            parts.push(
              <span key="task" className={a.overdue_tasks > 0 ? 'font-medium text-[var(--ds-critical-text)]' : ''}>
                promemoria {dueLabel(a.next_task_due)}
              </span>,
            );
          }
          if (a.open_deals > 0) parts.push(`${a.open_deals} opportunità`);
          if (a.last_activity_at) parts.push(`sentito ${relativeTime(a.last_activity_at)}`);
          return parts.length > 0 ? (
            <p className="truncate text-[12px] text-[var(--ds-text-muted)]">
              {parts.map((part, i) => <React.Fragment key={i}>{i > 0 && ' · '}{part}</React.Fragment>)}
            </p>
          ) : null;
        })()}
      </button>
    );
  };

  const filterOptions: Array<{ value: Filter; label: string; badge?: number; badgeTone?: 'neutral' | 'alert' }> = [
    { value: 'tutti', label: 'Tutti', badge: counts.tutti, badgeTone: 'neutral' },
    { value: 'lead', label: 'Lead', badge: counts.lead, badgeTone: 'neutral' },
    { value: 'prova', label: 'In prova', badge: counts.prova, badgeTone: 'neutral' },
    { value: 'clienti', label: 'Clienti', badge: counts.clienti, badgeTone: 'neutral' },
    { value: 'seguire', label: 'Da seguire', badge: counts.seguire, badgeTone: 'alert' },
    { value: 'chiusi', label: 'Chiusi' },
    ...(counts.interni > 0 ? [{ value: 'interni' as Filter, label: 'Demo e interni' }] : []),
  ];

  return (
    <>
      <SplitPane
        detailOpen={selectedId !== null}
        toolbar={
          <div className="space-y-2">
            <div className="flex gap-2">
              <SearchField value={query} onChange={setQuery} placeholder="Nome, città, referente, telefono…" className="min-w-0 flex-1" />
              <button type="button" className={dsIconButton} onClick={() => setCreating(true)} aria-label="Nuova azienda" title="Nuova azienda">
                <Plus className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <SegmentedControl
              value={filter}
              onChange={next => setFilter(next as Filter)}
              options={filterOptions}
              ariaLabel="Filtra le aziende"
              equalWidth={false}
              overflow="scroll"
              size="sm"
            />
            <div className="flex gap-2">
              <select className={`${dsSelect} !h-9 min-w-0 flex-1 text-[13px]`} value={sort} onChange={e => setSort(e.target.value as Sort)} aria-label="Ordina">
                <option value="nome">Per nome</option>
                <option value="attivita">Sentiti di recente</option>
                <option value="promemoria">Prossimo promemoria</option>
                <option value="mrr">Canone</option>
                <option value="salute">Salute peggiore</option>
              </select>
              {tags.length > 0 && (
                <select className={`${dsSelect} !h-9 min-w-0 flex-1 text-[13px]`} value={tag} onChange={e => setTag(e.target.value)} aria-label="Tag">
                  <option value="">Tutti i tag</option>
                  {tags.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
              <button type="button" className={`${dsIconButton} !h-9 !w-9`} onClick={() => setImporting(true)} aria-label="Importa CSV" title="Importa CSV">
                <Upload className="h-4 w-4" aria-hidden />
              </button>
              <button type="button" className={`${dsIconButton} !h-9 !w-9`} onClick={exportCsv} disabled={visible.length === 0} aria-label="Esporta CSV" title="Esporta la lista in CSV">
                <Download className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
        }
        list={
          error ? (
            <Callout
              tone="critical"
              icon={AlertTriangle}
              action={<button type="button" className={dsButton.secondary} onClick={onReload}><RefreshCw className="h-4 w-4" aria-hidden />Riprova</button>}
            >
              {error}
            </Callout>
          ) : !accounts ? (
            <div className="flex h-32 items-center justify-center"><Loader /></div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={Building2}
              action={all.length === 0 ? <button type="button" className={dsButton.primary} onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden />Nuova azienda</button> : undefined}
            >
              {query || tag ? 'Nessuna azienda corrisponde.' : 'Nessuna azienda qui.'}
            </EmptyState>
          ) : (
            <div className="space-y-1.5">{visible.map(renderRow)}</div>
          )
        }
        detail={
          selectedId === null ? (
            <PanePlaceholder icon={Building2}>Scegli un'azienda</PanePlaceholder>
          ) : (
            <PlatformCrmAccountDetail
              key={selectedId}
              accountId={selectedId}
              tenants={tenants}
              onTenantPatched={onTenantPatched}
              onTenantsChanged={onTenantsChanged}
              onBack={() => onSelect(null)}
              onChanged={onAccountChanged}
              onDeleted={id => { onSelect(null); onAccountRemoved(id); }}
              showToast={showToast}
            />
          )
        }
      />
      <AccountFormModal
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={detail => { onAccountChanged(detail); onSelect(detail.id); }}
      />
      <ImportModal open={importing} onClose={() => setImporting(false)} onDone={onReload} showToast={showToast} />
    </>
  );
};

export default PlatformCrmAccounts;
