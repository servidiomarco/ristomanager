import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { History, PenLine, Trash2 } from 'lucide-react';
import { ModalShell, StatusPill, dsButton, dsTextarea } from '../ds';
import { displayLocale } from '../../utils/formatLocale';
import {
  haccpApiService,
  HaccpAuditFields,
  HaccpChange,
  HaccpNonConformity,
} from '../../services/haccpApiService';
import { HACCP_CORRECTION_GRACE_MINUTES } from '../../utils/haccp';

/* Pezzi condivisi delle schede HACCP: la vestizione delle card, la firma
   delle righe, e i tre dialoghi che attraversano tutti i registri — il motivo
   della correzione, l'azione correttiva, lo storico. */

export type TFunc = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

export const todayISO = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const parseNumber = (s: string): number | null => {
  const cleaned = s.trim().replace(',', '.');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
};

export const formatNumber = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '';
  return String(n).replace('.', ',');
};

/** Il nome di chi ha scritto. Le righe di prima della Fase 1 portano l'email:
 *  se ne tiene la parte prima della chiocciola, come faceva il modulo. */
export const personName = (nameOrEmail: string | null | undefined): string => {
  if (!nameOrEmail) return '';
  return nameOrEmail.includes('@') ? nameOrEmail.split('@')[0] : nameOrEmail;
};

export const formatTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(displayLocale(), { hour: '2-digit', minute: '2-digit' });
};

export const formatShortDate = (isoDay: string): string => {
  const d = new Date(`${isoDay}T00:00:00`);
  return Number.isNaN(d.getTime()) ? isoDay : d.toLocaleDateString(displayLocale(), { day: '2-digit', month: '2-digit' });
};

export const formatLongDate = (isoDay: string): string => {
  const d = new Date(`${isoDay}T00:00:00`);
  return Number.isNaN(d.getTime()) ? isoDay : d.toLocaleDateString(displayLocale(), { weekday: 'short', day: 'numeric', month: 'short' });
};

const localDayOf = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Il giorno in cui la riga è stata scritta, se diverso dal giorno di
 *  registro: il foglio di ieri compilato oggi. Non è vietato — ma si vede. */
export const writtenOnOtherDay = (row: HaccpAuditFields & { date: string }): string | null => {
  if (!row.recordedAt) return null;
  const written = localDayOf(row.recordedAt);
  return written !== row.date ? written : null;
};

/** Lo stesso controllo del server: chi ha scritto per ultimo la riga la
 *  corregge senza motivo entro la tolleranza. Serve solo a decidere se il
 *  dialogo chiede il motivo come obbligatorio; l'ultima parola è del server. */
export const correctableWithoutReason = (row: HaccpAuditFields, userId: number | null | undefined): boolean => {
  const lastBy = row.updatedByUserId ?? row.recordedByUserId ?? null;
  const lastAt = row.updatedAt ?? row.recordedAt ?? null;
  if (!userId || lastBy !== userId || !lastAt) return false;
  const elapsed = Date.now() - new Date(lastAt).getTime();
  return elapsed >= 0 && elapsed <= HACCP_CORRECTION_GRACE_MINUTES * 60 * 1000;
};

/* ── Vestizione ───────────────────────────────────────────────────────────
   h-11, non h-9: il registro si compila col telefono in mano davanti alla
   cella frigo, e 44px è il minimo tattile del design system. */
export const field =
  'h-11 w-full rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-4 text-[15px] text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

/** Etichetta di un campo nei form di coda. Minuscolo: le maiuscole a 13px
 *  perdono la forma della parola e gli screen reader le compitano. */
export const fieldLabel = 'mb-1.5 block text-[13px] text-[var(--ds-text-muted)]';

export const rowList = 'divide-y divide-[var(--ds-border)]';
export const row = 'grid grid-cols-12 items-center gap-2 py-2.5 sm:gap-3';
export const emptyNote = 'py-6 text-center text-[14px] text-[var(--ds-text-muted)]';

export const quietIconButton =
  'inline-flex h-9 w-9 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

export const deleteButton =
  'inline-flex h-9 w-9 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

export const chip =
  'inline-flex h-9 items-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-3 text-[14px] text-[var(--ds-text-secondary)] transition-colors hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

export const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <section className={`rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)] sm:p-5 ${className}`}>
    {children}
  </section>
);

/** Icona in pastiglia, titolo, e a destra il contatore come pill. */
export const CardHeader: React.FC<{ title: string; icon: React.ReactNode; status?: string; statusTone?: 'neutral' | 'positive' | 'critical' | 'pending'; aside?: React.ReactNode }> = ({ title, icon, status, statusTone = 'neutral', aside }) => (
  <div className="mb-3 flex items-center justify-between gap-3">
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]">
        {icon}
      </span>
      <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">{title}</h2>
    </div>
    <div className="flex flex-shrink-0 items-center gap-2">
      {aside}
      {status && <StatusPill tone={statusTone} className="tabular-nums">{status}</StatusPill>}
    </div>
  </div>
);

// Le azioni nella firma: piccole di testo ma alte 36px, con margine negativo
// perché non allarghino la riga.
const stampButton =
  '-my-1.5 inline-flex h-9 items-center gap-1 rounded-[var(--ds-radius-control)] px-2 text-[12px] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

/** La firma sotto una riga: chi, a che ora, e i due segni che l'ispettore
 *  cerca — la riga corretta (con lo storico a un tocco) e la riga scritta in
 *  un giorno diverso da quello del registro. */
export const RowStamp: React.FC<{
  row: HaccpAuditFields & { date: string };
  onHistory?: () => void;
  /** Annullare una lettura: azione rara (la riga sbagliata), quindi sta nella
   *  firma e non accanto al valore, dove un tocco distratto la prenderebbe. */
  onVoid?: () => void;
  voidLabel?: string;
  className?: string;
}> = ({ row, onHistory, onVoid, voidLabel, className = 'col-span-12' }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  if (!row.recordedAt) return null;
  const other = writtenOnOtherDay(row);
  const corrected = !!row.updatedAt;
  return (
    <div className={`${className} -mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] tabular-nums text-[var(--ds-text-subtle)]`}>
      <span>
        {personName(row.recordedByUserName)} · {formatTime(row.recordedAt)}
        {other && ` · ${t('writtenOn', 'scritta il {{giorno}}', { giorno: formatShortDate(other) })}`}
      </span>
      {corrected && (
        <span className="inline-flex items-center gap-1">
          <PenLine className="h-3 w-3" aria-hidden />
          {t('correctedBy', 'corretta da {{nome}} alle {{ora}}', { nome: personName(row.updatedByUserName), ora: formatTime(row.updatedAt) })}
        </span>
      )}
      {onHistory && corrected && (
        <button type="button" onClick={onHistory} className={stampButton}>
          <History className="h-3 w-3" aria-hidden />
          {t('history', 'Storico')}
        </button>
      )}
      {onVoid && (
        <button type="button" onClick={onVoid} className={stampButton} aria-label={voidLabel}>
          <Trash2 className="h-3 w-3" aria-hidden />
          {t('void', 'Annulla')}
        </button>
      )}
    </div>
  );
};

// =============================================================================
// Motivo della correzione
// =============================================================================

export interface ReasonRequest {
  title: string;
  /** Riga di contesto sotto il titolo: cosa si sta correggendo. */
  subtitle?: string;
  confirmLabel: string;
  /** Il motivo è obbligatorio (fuori tolleranza o riga di un altro). */
  required: boolean;
  /** Annullamento: il bottone di conferma prende il peso critico. */
  destructive?: boolean;
  onConfirm: (reason: string | null) => Promise<void>;
  onCancel?: () => void;
}

export const ReasonDialog: React.FC<{ request: ReasonRequest | null; onDone: () => void }> = ({ request, onDone }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReason('');
    setError(null);
    setBusy(false);
  }, [request]);

  if (!request) return null;

  const quick = [
    t('reason.typo', 'Errore di battitura'),
    t('reason.remeasured', 'Rilevazione ripetuta'),
    t('reason.wrongRow', 'Registrata sulla riga sbagliata'),
  ];

  const cancel = () => {
    request.onCancel?.();
    onDone();
  };

  const confirm = async () => {
    const clean = reason.trim();
    if (request.required && !clean) {
      setError(t('reason.required', 'Scrivi il motivo: resta nello storico del registro.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request.onConfirm(clean || null);
      onDone();
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open
      onClose={cancel}
      title={request.title}
      subtitle={request.subtitle}
      size="sm"
      bodyClassName="px-5 py-5 sm:px-6"
      closeOnEscape
      footer={
        <>
          <button type="button" className={dsButton.quiet} onClick={cancel} disabled={busy}>
            {t('cancel', 'Annulla')}
          </button>
          <button
            type="button"
            className={request.destructive ? dsButton.critical : dsButton.primary}
            onClick={confirm}
            disabled={busy}
          >
            {request.confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label htmlFor="haccp-reason" className="block text-[14px] font-medium text-[var(--ds-text-secondary)]">
          {request.required ? t('reason.label', 'Motivo') : t('reason.labelOptional', 'Motivo (facoltativo)')}
        </label>
        <textarea
          id="haccp-reason"
          rows={3}
          value={reason}
          onChange={e => setReason(e.target.value)}
          className={dsTextarea}
          autoFocus
        />
        <div className="flex flex-wrap gap-2">
          {quick.map(q => (
            <button key={q} type="button" className={chip} onClick={() => setReason(q)}>{q}</button>
          ))}
        </div>
        {request.required && (
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            {t('reason.why', 'La correzione resta nel registro con l\'originale, chi l\'ha fatta e il motivo.')}
          </p>
        )}
        {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
};

// =============================================================================
// Azione correttiva
// =============================================================================

/** Le azioni che si scrivono più spesso, per fonte: un tocco e il testo è lì,
 *  correggibile. Aggiungono, non sostituiscono, così se ne combinano due. */
const quickActions = (nc: HaccpNonConformity, t: TFunc): string[] => {
  switch (nc.source) {
    case 'TEMPERATURE':
      return [
        t('action.moved', 'Prodotti spostati in un\'altra cella'),
        t('action.discarded', 'Prodotti eliminati'),
        t('action.thermostat', 'Termostato regolato'),
        t('action.technician', 'Chiamato il tecnico'),
        t('action.remeasuredOk', 'Ricontrollata dopo 30 minuti: in soglia'),
      ];
    case 'RECEIPT':
      return [
        t('action.returned', 'Merce resa al fornitore'),
        t('action.discarded', 'Prodotti eliminati'),
        t('action.supplierWarned', 'Fornitore avvisato'),
      ];
    default:
      return [
        t('action.fixed', 'Ripristinato subito'),
        t('action.discarded', 'Prodotti eliminati'),
        t('action.reported', 'Segnalato al responsabile'),
      ];
  }
};

export const CloseNcDialog: React.FC<{
  nc: HaccpNonConformity | null;
  userId: number | null | undefined;
  onClose: () => void;
  onSaved: (nc: HaccpNonConformity) => void;
}> = ({ nc, userId, onClose, onSaved }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [action, setAction] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAction(nc?.correctiveAction ?? '');
    setReason('');
    setError(null);
    setBusy(false);
  }, [nc]);

  if (!nc) return null;
  const editing = nc.status === 'CLOSED';
  // Correggere un'azione già scritta segue la regola delle correzioni: chi
  // l'ha appena chiusa la ritocca senza motivo, gli altri lo scrivono. Chi
  // l'ha chiusa la riga non lo dice per id, solo per nome: decide il server.
  const needsReason = editing && !(userId && nc.closedAt
    && Date.now() - new Date(nc.closedAt).getTime() <= HACCP_CORRECTION_GRACE_MINUTES * 60 * 1000);

  const add = (text: string) => setAction(prev => (prev.trim() ? `${prev.trim()}. ${text}` : text));

  const save = async () => {
    const clean = action.trim();
    if (!clean) {
      setError(t('nc.actionRequired', 'Scrivi cosa è stato fatto.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await haccpApiService.closeNonConformity(nc.id, clean, reason.trim() || null);
      onSaved(saved);
      onClose();
    } catch (e: any) {
      setError(e?.data?.code === 'reason_required'
        ? t('reason.required', 'Scrivi il motivo: resta nello storico del registro.')
        : e?.message || t('err.save', 'Salvataggio non riuscito'));
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title={editing ? t('nc.editAction', 'Correggi l\'azione correttiva') : t('nc.closeTitle', 'Azione correttiva')}
      subtitle={nc.title}
      size="sm"
      bodyClassName="px-5 py-5 sm:px-6"
      closeOnEscape
      footer={
        <>
          <button type="button" className={dsButton.quiet} onClick={onClose} disabled={busy}>
            {t('cancel', 'Annulla')}
          </button>
          <button type="button" className={dsButton.primary} onClick={save} disabled={busy}>
            {editing ? t('save', 'Salva') : t('nc.close', 'Chiudi la non conformità')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {nc.detail && <p className="text-[14px] text-[var(--ds-text-muted)]">{nc.detail}</p>}
        <label htmlFor="haccp-nc-action" className="block text-[14px] font-medium text-[var(--ds-text-secondary)]">
          {t('nc.whatDone', 'Cosa è stato fatto')}
        </label>
        <textarea
          id="haccp-nc-action"
          rows={4}
          value={action}
          onChange={e => setAction(e.target.value)}
          className={dsTextarea}
          autoFocus
        />
        <div className="flex flex-wrap gap-2">
          {quickActions(nc, t).map(q => (
            <button key={q} type="button" className={chip} onClick={() => add(q)}>{q}</button>
          ))}
        </div>
        {editing && (
          <div>
            <label htmlFor="haccp-nc-reason" className={fieldLabel}>
              {needsReason ? t('reason.label', 'Motivo') : t('reason.labelOptional', 'Motivo (facoltativo)')}
            </label>
            <input id="haccp-nc-reason" value={reason} onChange={e => setReason(e.target.value)} className={field} />
          </div>
        )}
        {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
};

// =============================================================================
// Storico di una registrazione
// =============================================================================

const FIELD_LABELS_IT: Record<string, string> = {
  temperature: 'Temperatura',
  note: 'Note',
  action: 'Olio',
  done: 'Eseguita',
  product: 'Prodotto',
  lotNumber: 'Lotto',
  accepted: 'Esito',
  internalLot: 'Lotto interno',
  blastTempRange: 'Range temp.',
  blastDuration: 'Durata',
  title: 'Descrizione',
  detail: 'Dettaglio',
  correctiveAction: 'Azione correttiva',
  status: 'Stato',
  label: 'Nome',
  minTemp: 'Minimo',
  maxTemp: 'Massimo',
  checksPerDay: 'Rilevazioni al giorno',
  frequency: 'Frequenza',
  instructions: 'Istruzioni',
  active: 'Attivo',
};

const IGNORED_DIFF_KEYS = new Set(['id', 'date', 'pointId', 'location', 'fryerLabel', 'point', 'slot', 'targetMin', 'targetMax', 'sortOrder', 'register', 'source', 'sourceId', 'openedAt', 'openedByUserName', 'closedAt', 'closedByUserName', 'updatedAt']);

const showValue = (v: unknown, t: TFunc): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? t('yes', 'sì') : t('no', 'no');
  if (typeof v === 'number') return formatNumber(v);
  return String(v);
};

const diffOf = (change: HaccpChange): Array<{ key: string; before: unknown; after: unknown }> => {
  const before = change.before ?? {};
  const after = change.after ?? {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: Array<{ key: string; before: unknown; after: unknown }> = [];
  keys.forEach(k => {
    if (IGNORED_DIFF_KEYS.has(k)) return;
    const b = (before as Record<string, unknown>)[k];
    const a = (after as Record<string, unknown>)[k];
    if (change.action === 'UPDATE' && JSON.stringify(b) === JSON.stringify(a)) return;
    if (change.action === 'CREATE' && (a === null || a === undefined || a === '')) return;
    out.push({ key: k, before: b, after: a });
  });
  return out;
};

export const HistoryDialog: React.FC<{
  target: { entity: string; entityId: string; title: string } | null;
  onClose: () => void;
}> = ({ target, onClose }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [changes, setChanges] = useState<HaccpChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    setChanges(null);
    setError(null);
    haccpApiService.getChanges(target.entity, target.entityId)
      .then(r => { if (alive) setChanges(r.changes); })
      .catch(e => { if (alive) setError(e?.message || t('err.load', 'Errore nel caricamento')); });
    return () => { alive = false; };
  }, [target, t]);

  if (!target) return null;

  const actionLabel = (a: HaccpChange['action']): string =>
    a === 'CREATE' ? t('change.create', 'Registrata') : a === 'UPDATE' ? t('change.update', 'Corretta') : t('change.void', 'Annullata');

  return (
    <ModalShell open onClose={onClose} title={t('historyTitle', 'Storico')} subtitle={target.title} size="sm" bodyClassName="px-5 py-5 sm:px-6" closeOnEscape>
      {error && <p className="text-[14px] text-[var(--ds-critical-text)]">{error}</p>}
      {!error && changes === null && <p className={emptyNote}>{t('loading', 'Caricamento…')}</p>}
      {changes && changes.length === 0 && <p className={emptyNote}>{t('historyEmpty', 'Nessuna modifica registrata.')}</p>}
      {changes && changes.length > 0 && (
        <ol className="space-y-3">
          {changes.map(c => (
            <li key={c.id} className="rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[14px] font-semibold text-[var(--ds-text-primary)]">{actionLabel(c.action)}</span>
                <span className="text-[12px] tabular-nums text-[var(--ds-text-muted)]">
                  {personName(c.userName)} · {new Date(c.createdAt).toLocaleString(displayLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              {c.reason && (
                <p className="mt-1 text-[14px] text-[var(--ds-text-secondary)]">
                  {t('historyReason', 'Motivo: {{motivo}}', { motivo: c.reason })}
                </p>
              )}
              {c.action !== 'VOID' && (
                <ul className="mt-1.5 space-y-0.5 text-[13px] text-[var(--ds-text-secondary)]">
                  {diffOf(c).map(d => (
                    <li key={d.key}>
                      <span className="text-[var(--ds-text-muted)]">{t(`fieldName.${d.key}`, FIELD_LABELS_IT[d.key] ?? d.key)}: </span>
                      {c.action === 'UPDATE' ? (
                        <>
                          <span className="line-through decoration-[var(--ds-text-subtle)]">{showValue(d.before, t)}</span>
                          {' → '}
                          <span className="font-medium text-[var(--ds-text-primary)]">{showValue(d.after, t)}</span>
                        </>
                      ) : (
                        <span>{showValue(d.after, t)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </ModalShell>
  );
};
