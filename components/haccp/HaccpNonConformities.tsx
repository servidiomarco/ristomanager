import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, History, Plus, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import {
  haccpApiService,
  HaccpNcSource,
  HaccpNonConformity,
} from '../../services/haccpApiService';
import { useAuth } from '../../contexts/AuthContext';
import { Callout, EmptyState, ModalShell, SegmentedControl, StatusPill, dsButton, dsInput, dsTextarea } from '../ds';
import {
  Card, CloseNcDialog, HistoryDialog, ReasonDialog, ReasonRequest, chip, emptyNote, formatLongDate,
  formatTime, personName, todayISO,
} from './haccpUi';

/* Le non conformità: lo scostamento e cosa si è fatto per rimediare (5°
   principio HACCP). Le aperte stanno in cima e restano finché qualcuno non
   scrive l'azione correttiva; le chiuse sono lo storico che l'ispettore
   legge. Annullarne una (aperta per errore) è da responsabile e va motivato. */

const SOURCE_LABELS_IT: Record<HaccpNcSource, string> = {
  TEMPERATURE: 'Temperatura',
  OIL: 'Olio',
  CLEANING: 'Pulizie',
  RECEIPT: 'Ricevimento',
  PROCESS: 'Processo',
  CALIBRATION: 'Taratura',
  SENSOR: 'Sensore',
  INTERVENTION: 'Intervento',
  RECALL: 'Richiamo',
  MANUAL: 'Segnalazione',
};

type Filter = 'open' | 'all';

export const HaccpNonConformities: React.FC<{ refreshKey: number; canManage: boolean; onCountChange?: (open: number) => void }> = ({
  refreshKey, canManage, onCountChange,
}) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const { user, hasPermission } = useAuth();
  const canRecord = hasPermission('haccp:record');
  const [filter, setFilter] = useState<Filter>('open');
  const [items, setItems] = useState<HaccpNonConformity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<HaccpNonConformity | null>(null);
  const [creating, setCreating] = useState(false);
  const [reasonRequest, setReasonRequest] = useState<ReasonRequest | null>(null);
  const [history, setHistory] = useState<{ entity: string; entityId: string; title: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await haccpApiService.getNonConformities({ status: filter });
      setItems(r.nonconformities);
      setError(null);
      if (filter === 'open') onCountChange?.(r.nonconformities.length);
      else onCountChange?.(r.nonconformities.filter(n => n.status === 'OPEN').length);
    } catch (e: any) {
      setError(e?.message || t('err.load', 'Errore nel caricamento'));
    }
  }, [filter, onCountChange, t]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const sourceLabel = (s: HaccpNcSource) => t(`ncSource.${s}`, SOURCE_LABELS_IT[s]);

  const askVoid = (nc: HaccpNonConformity) => setReasonRequest({
    title: t('nc.voidTitle', 'Annullare la non conformità?'),
    subtitle: nc.title,
    required: true,
    destructive: true,
    confirmLabel: t('nc.voidConfirm', 'Annulla non conformità'),
    onConfirm: async reason => {
      await haccpApiService.voidNonConformity(nc.id, reason ?? '');
      load();
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <SegmentedControl<Filter>
            value={filter}
            onChange={setFilter}
            ariaLabel={t('nc.filter', 'Quali non conformità')}
            equalWidth={false}
            options={[
              { value: 'open', label: t('nc.filterOpen', 'Da chiudere') },
              { value: 'all', label: t('nc.filterAll', 'Tutte') },
            ]}
          />
        </div>
        {canRecord && (
          <button type="button" className={dsButton.primary} onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            <span>{t('nc.new', 'Segnala')}</span>
          </button>
        )}
      </div>

      {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}

      {items === null && !error ? (
        <p className={emptyNote}>{t('loading', 'Caricamento…')}</p>
      ) : items && items.length === 0 ? (
        <EmptyState icon={ShieldCheck}>
          {filter === 'open'
            ? t('nc.noneOpen', 'Nessuna non conformità da chiudere.')
            : t('nc.none', 'Nessuna non conformità registrata.')}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {items?.map(nc => (
            <Card key={nc.id}>
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] ${
                  nc.status === 'OPEN'
                    ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]'
                    : nc.status === 'CLOSED'
                      ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
                      : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]'
                }`}>
                  {nc.status === 'OPEN' ? <ShieldAlert className="h-4 w-4" /> : nc.status === 'CLOSED' ? <CheckCircle2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 text-[15px] font-semibold text-[var(--ds-text-primary)]">{nc.title}</h3>
                    <StatusPill>{sourceLabel(nc.source)}</StatusPill>
                    {nc.status === 'VOID' && <StatusPill>{t('nc.voided', 'Annullata')}</StatusPill>}
                  </div>
                  <p className="mt-0.5 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                    {formatLongDate(nc.date)} · {t('nc.openedBy', 'aperta da {{nome}} alle {{ora}}', { nome: personName(nc.openedByUserName), ora: formatTime(nc.openedAt) })}
                  </p>
                  {nc.detail && <p className="mt-1.5 text-[14px] text-[var(--ds-text-secondary)]">{nc.detail}</p>}
                  {nc.status === 'CLOSED' && (
                    <div className="mt-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3">
                      <p className="text-[14px] text-[var(--ds-text-primary)]">{nc.correctiveAction}</p>
                      <p className="mt-1 text-[12px] tabular-nums text-[var(--ds-text-muted)]">
                        {t('nc.closedBy', 'chiusa da {{nome}} il {{giorno}} alle {{ora}}', {
                          nome: personName(nc.closedByUserName),
                          giorno: nc.closedAt ? formatLongDate(nc.closedAt.slice(0, 10)) : '',
                          ora: formatTime(nc.closedAt),
                        })}
                      </p>
                    </div>
                  )}
                  {nc.status === 'VOID' && nc.voidReason && (
                    <p className="mt-1.5 text-[13px] text-[var(--ds-text-muted)]">{t('historyReason', 'Motivo: {{motivo}}', { motivo: nc.voidReason })}</p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {nc.status === 'OPEN' && canRecord && (
                      <button type="button" className={`${dsButton.primary} h-9 px-4 text-[14px]`} onClick={() => setClosing(nc)}>
                        {t('nc.writeAction', 'Scrivi l\'azione')}
                      </button>
                    )}
                    {nc.status === 'CLOSED' && canRecord && (
                      <button type="button" className={`${dsButton.quiet} h-9 px-4 text-[14px]`} onClick={() => setClosing(nc)}>
                        {t('nc.editActionShort', 'Correggi l\'azione')}
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${dsButton.quiet} h-9 px-4 text-[14px]`}
                      onClick={() => setHistory({ entity: 'nonconformity', entityId: String(nc.id), title: nc.title })}
                    >
                      <History className="h-4 w-4" aria-hidden />
                      {t('history', 'Storico')}
                    </button>
                    {nc.status !== 'VOID' && canManage && (
                      <button type="button" className={`${dsButton.quiet} h-9 px-4 text-[14px]`} onClick={() => askVoid(nc)}>
                        {t('void', 'Annulla')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <CloseNcDialog nc={closing} userId={user?.id} onClose={() => setClosing(null)} onSaved={() => load()} />
      <NewNcDialog open={creating} onClose={() => setCreating(false)} onSaved={() => load()} />
      <ReasonDialog request={reasonRequest} onDone={() => setReasonRequest(null)} />
      <HistoryDialog target={history} onClose={() => setHistory(null)} />
    </div>
  );
};

/** Una non conformità trovata a occhio: lo scaffale sporco, l'insetto nella
 *  dispensa, il prodotto scaduto in cella. Se è già stata risolta si scrive
 *  subito anche l'azione, e nasce chiusa. */
const NewNcDialog: React.FC<{ open: boolean; onClose: () => void; onSaved: () => void }> = ({ open, onClose, onSaved }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [date, setDate] = useState(todayISO());
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDate(todayISO()); setTitle(''); setDetail(''); setAction(''); setError(null); setBusy(false);
  }, [open]);

  if (!open) return null;

  const examples = [
    t('nc.example.expired', 'Prodotto scaduto in cella'),
    t('nc.example.pests', 'Tracce di infestanti'),
    t('nc.example.unlabeled', 'Semilavorato senza etichetta'),
    t('nc.example.dirty', 'Attrezzatura non pulita'),
  ];

  const save = async () => {
    if (!title.trim()) {
      setError(t('nc.titleRequired', 'Scrivi cosa non va.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await haccpApiService.createNonConformity({
        date,
        title: title.trim(),
        detail: detail.trim() || null,
        correctiveAction: action.trim() || null,
      });
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title={t('nc.newTitle', 'Segnala una non conformità')}
      size="sm"
      bodyClassName="px-5 py-5 sm:px-6"
      footer={
        <>
          <button type="button" className={dsButton.quiet} onClick={onClose} disabled={busy}>{t('cancel', 'Annulla')}</button>
          <button type="button" className={dsButton.primary} onClick={save} disabled={busy}>
            {action.trim() ? t('nc.saveClosed', 'Registra e chiudi') : t('nc.saveOpen', 'Registra')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="haccp-nc-date" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('day', 'Giorno')}</label>
          <input id="haccp-nc-date" type="date" value={date} max={todayISO()} onChange={e => e.target.value && setDate(e.target.value)} className={dsInput} />
        </div>
        <div>
          <label htmlFor="haccp-nc-title" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('nc.what', 'Cosa non va')}</label>
          <input id="haccp-nc-title" value={title} onChange={e => setTitle(e.target.value)} className={dsInput} autoFocus />
          <div className="mt-2 flex flex-wrap gap-2">
            {examples.map(x => <button key={x} type="button" className={chip} onClick={() => setTitle(x)}>{x}</button>)}
          </div>
        </div>
        <div>
          <label htmlFor="haccp-nc-detail" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('nc.detail', 'Dettagli (facoltativo)')}</label>
          <textarea id="haccp-nc-detail" rows={2} value={detail} onChange={e => setDetail(e.target.value)} className={dsTextarea} />
        </div>
        <div>
          <label htmlFor="haccp-nc-now" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('nc.actionIfDone', 'Azione correttiva, se già fatta')}</label>
          <textarea id="haccp-nc-now" rows={2} value={action} onChange={e => setAction(e.target.value)} className={dsTextarea} />
        </div>
        {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
};
