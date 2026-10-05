import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, BookOpen, CalendarClock, FileText, GraduationCap, Paperclip, Pencil, Plus, Printer, Trash2, Wrench,
} from 'lucide-react';
import {
  haccpApiService,
  HaccpArchive as ArchiveData,
  HaccpDeadline,
  HaccpDocument,
  HaccpDocumentCategory,
  HaccpIntervention,
  HaccpInterventionType,
  HaccpTraining,
  HaccpTrainingCourse,
} from '../../services/haccpApiService';
import {
  HACCP_DOCUMENT_CATEGORIES,
  HACCP_DOCUMENT_LABELS_IT,
  HACCP_INTERVENTION_LABELS_IT,
  HACCP_INTERVENTION_TYPES,
  HACCP_TRAINING_COURSES,
  HACCP_TRAINING_LABELS_IT,
} from '../../utils/haccp';
import { printAllergenBook } from '../../utils/printAllergenBook';
import { useAuth } from '../../contexts/AuthContext';
import { Callout, ModalShell, SegmentedControl, StatusPill, dsButton, dsInput, dsSelect, dsTextarea } from '../ds';
import {
  Card, CardHeader, ReasonDialog, ReasonRequest, TFunc, chip, correctableWithoutReason, deleteButton, emptyNote,
  formatLongDate, formatNumber, parseNumber, quietIconButton, rowList, todayISO,
} from './haccpUi';

/* L'archivio dell'autocontrollo: quello che l'ispettore chiede prima dei
   registri. Formazione del personale con le scadenze, interventi delle ditte
   esterne (disinfestazione, olio esausto, analisi), documenti (manuale,
   registrazione sanitaria, schede dei detergenti) e il libro allergeni dai
   piatti del menu. Lo scadenzario in cima dice cosa è scaduto o sta per. */

export const interventionLabel = (k: HaccpInterventionType, t: TFunc) => t(`intervention.${k}`, HACCP_INTERVENTION_LABELS_IT[k]);
export const courseLabel = (k: HaccpTrainingCourse, t: TFunc) => t(`course.${k}`, HACCP_TRAINING_LABELS_IT[k]);
export const documentLabel = (k: HaccpDocumentCategory, t: TFunc) => t(`docCategory.${k}`, HACCP_DOCUMENT_LABELS_IT[k]);

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Il file scelto, in base64 per la rotta JSON (come la libreria media). */
const readFile = (file: File): Promise<{ filename: string; contentType: string; data: string }> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve({ filename: file.name, contentType: file.type || 'application/octet-stream', data: url.slice(url.indexOf(',') + 1) });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Apre il file di un documento: si scarica col token e si consegna al
 *  browser, che lo mostra o lo salva. */
export const openDocument = async (doc: { id: number; filename?: string | null; title?: string }): Promise<void> => {
  const blob = await haccpApiService.downloadDocument(doc.id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.filename || doc.title || 'documento';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

const deadlineTone = (d: { status: HaccpDeadline['status'] }) => (d.status === 'expired' ? 'critical' : 'pending');

/** Lo stato di una data di scadenza: scaduta, entro 60 giorni, valida. */
const validity = (date: string | null, today: string): 'expired' | 'soon' | 'ok' | null => {
  if (!date) return null;
  if (date < today) return 'expired';
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 60);
  return date <= soon.toISOString().slice(0, 10) ? 'soon' : 'ok';
};

const ValidityPill: React.FC<{ date: string | null; today: string }> = ({ date, today }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const v = validity(date, today);
  if (!v || !date) return null;
  if (v === 'expired') return <StatusPill tone="critical">{t('archive.expiredOn', 'scaduto il {{giorno}}', { giorno: formatLongDate(date) })}</StatusPill>;
  if (v === 'soon') return <StatusPill tone="pending">{t('archive.expiresOn', 'scade il {{giorno}}', { giorno: formatLongDate(date) })}</StatusPill>;
  return <StatusPill>{t('archive.validUntil', 'valido fino al {{giorno}}', { giorno: formatLongDate(date) })}</StatusPill>;
};

export const HaccpArchive: React.FC<{ refreshKey: number; canManage: boolean }> = ({ refreshKey, canManage }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const { user, hasPermission } = useAuth();
  const canRecord = hasPermission('haccp:record');
  const [data, setData] = useState<ArchiveData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [training, setTraining] = useState<{ row: HaccpTraining | null } | null>(null);
  const [intervention, setIntervention] = useState(false);
  const [docDialog, setDocDialog] = useState<{ row: HaccpDocument | null } | null>(null);
  const [reasonRequest, setReasonRequest] = useState<ReasonRequest | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [printingAllergens, setPrintingAllergens] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await haccpApiService.getArchive());
      setError(null);
    } catch (e: any) {
      setError(e?.message || t('err.load', 'Errore nel caricamento'));
    }
  }, [t]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const today = data?.today ?? todayISO();
  const docsById = useMemo(() => new Map((data?.documents ?? []).map(d => [d.id, d])), [data]);

  const open = async (id: number | null) => {
    if (!id) return;
    const doc = docsById.get(id);
    try {
      await openDocument({ id, filename: doc?.filename, title: doc?.title });
    } catch (e: any) {
      setError(e?.message || t('archive.downloadFailed', 'Il file non si apre'));
    }
  };

  const printAllergens = async () => {
    setPrintingAllergens(true);
    try {
      const r = await haccpApiService.getAllergens();
      printAllergenBook(r.dishes, r.restaurantName);
    } catch (e: any) {
      setError(e?.message || t('err.print', 'Stampa non riuscita'));
    } finally {
      setPrintingAllergens(false);
    }
  };

  if (!data && !error) return <p className={emptyNote}>{t('loading', 'Caricamento…')}</p>;

  const trainings = (data?.trainings ?? []).filter(tr => showArchived || !tr.archived);
  const documents = (data?.documents ?? []).filter(d => showArchived || !d.archived);
  const byPerson = new Map<string, HaccpTraining[]>();
  trainings.forEach(tr => {
    const key = tr.personName;
    byPerson.set(key, [...(byPerson.get(key) ?? []), tr]);
  });

  return (
    <div className="space-y-4">
      {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}

      {data && data.deadlines.length > 0 && (
        <Card>
          <CardHeader
            title={t('archive.deadlines', 'Scadenze')}
            icon={<CalendarClock className="h-4 w-4" />}
            status={t('archive.deadlinesCount', '{{count}} da guardare', { count: data.deadlines.length })}
            statusTone={data.deadlines.some(d => d.status === 'expired') ? 'critical' : 'pending'}
          />
          <ul className={rowList}>
            {data.deadlines.map(d => (
              <li key={`${d.kind}-${d.id}`} className="flex flex-wrap items-center gap-2 py-2.5">
                <span className="min-w-0 flex-1 text-[15px] text-[var(--ds-text-primary)]">{d.title}</span>
                <StatusPill tone={deadlineTone(d)}>
                  {d.status === 'expired'
                    ? t('archive.expiredOn', 'scaduto il {{giorno}}', { giorno: formatLongDate(d.due) })
                    : t('archive.expiresOn', 'scade il {{giorno}}', { giorno: formatLongDate(d.due) })}
                </StatusPill>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex justify-end">
        <SegmentedControl<'current' | 'all'>
          value={showArchived ? 'all' : 'current'}
          onChange={v => setShowArchived(v === 'all')}
          ariaLabel={t('archive.show', 'Cosa mostrare')}
          size="sm"
          equalWidth={false}
          options={[
            { value: 'current', label: t('archive.current', 'In uso') },
            { value: 'all', label: t('archive.withArchived', 'Anche archiviati') },
          ]}
        />
      </div>

      <Card>
        <CardHeader
          title={t('archive.training', 'Formazione del personale')}
          icon={<GraduationCap className="h-4 w-4" />}
          aside={canManage && (
            <button type="button" className={`${dsButton.quiet} h-9 px-3 text-[14px]`} onClick={() => setTraining({ row: null })}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('config.add', 'Aggiungi')}
            </button>
          )}
        />
        {byPerson.size === 0 ? (
          <p className={emptyNote}>{t('archive.noTraining', 'Nessun attestato registrato.')}</p>
        ) : (
          <ul className={rowList}>
            {[...byPerson.entries()].map(([person, rows]) => (
              <li key={person} className="py-2.5">
                <div className="text-[15px] font-medium text-[var(--ds-text-primary)]">{person}</div>
                <ul className="mt-1 space-y-1.5">
                  {rows.map(tr => (
                    <li key={tr.id} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 text-[14px] text-[var(--ds-text-secondary)]">
                        {tr.title || courseLabel(tr.course, t)}
                        <span className="text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                          {' · '}{formatLongDate(tr.completedOn)}
                          {tr.provider ? ` · ${tr.provider}` : ''}
                          {typeof tr.hours === 'number' ? ` · ${t('archive.hours', '{{n}} ore', { n: formatNumber(tr.hours) })}` : ''}
                        </span>
                      </span>
                      {tr.archived ? <StatusPill>{t('archive.archived', 'Archiviato')}</StatusPill> : <ValidityPill date={tr.expiresOn} today={today} />}
                      {tr.documentId && (
                        <button type="button" className={quietIconButton} onClick={() => open(tr.documentId)} aria-label={t('archive.openCertificate', 'Apri l\'attestato')}>
                          <Paperclip className="h-4 w-4" />
                        </button>
                      )}
                      {canManage && (
                        <button type="button" className={quietIconButton} onClick={() => setTraining({ row: tr })} aria-label={t('config.edit', 'Modifica {{nome}}', { nome: person })}>
                          <Pencil className="h-4 w-4" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={t('archive.interventions', 'Interventi esterni')}
          icon={<Wrench className="h-4 w-4" />}
          aside={canRecord && (
            <button type="button" className={`${dsButton.quiet} h-9 px-3 text-[14px]`} onClick={() => setIntervention(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('archive.recordIntervention', 'Registra')}
            </button>
          )}
        />
        {(data?.interventions ?? []).length === 0 ? (
          <p className={emptyNote}>{t('archive.noInterventions', 'Nessun intervento negli ultimi due anni.')}</p>
        ) : (
          <ul className={rowList}>
            {data!.interventions.map(iv => (
              <li key={iv.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
                <span className="w-24 flex-shrink-0 pt-0.5 text-[13px] tabular-nums text-[var(--ds-text-muted)]">{formatLongDate(iv.date)}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-medium text-[var(--ds-text-primary)]">
                    {interventionLabel(iv.type, t)}{iv.provider ? <span className="font-normal text-[var(--ds-text-muted)]"> · {iv.provider}</span> : null}
                  </div>
                  <div className="text-[13px] text-[var(--ds-text-muted)]">
                    {[
                      iv.quantity,
                      iv.reference,
                      iv.nextDue ? t('archive.nextDue', 'prossimo entro {{giorno}}', { giorno: formatLongDate(iv.nextDue) }) : null,
                      iv.findings,
                      iv.note,
                    ].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <StatusPill tone={iv.outcomeOk ? 'positive' : 'critical'}>
                  {iv.outcomeOk ? t('archive.noFindings', 'Senza rilievi') : t('archive.findings', 'Con rilievi')}
                </StatusPill>
                {iv.documentId && (
                  <button type="button" className={quietIconButton} onClick={() => open(iv.documentId)} aria-label={t('archive.openReport', 'Apri il rapporto')}>
                    <Paperclip className="h-4 w-4" />
                  </button>
                )}
                {canRecord && (
                  <button
                    type="button"
                    className={deleteButton}
                    aria-label={t('voidNamed', 'Annulla la registrazione di {{nome}}', { nome: interventionLabel(iv.type, t) })}
                    onClick={() => setReasonRequest({
                      title: t('voidTitle', 'Annullare la registrazione?'),
                      subtitle: `${interventionLabel(iv.type, t)} · ${formatLongDate(iv.date)}`,
                      required: !correctableWithoutReason(iv, user?.id),
                      destructive: true,
                      confirmLabel: t('voidConfirm', 'Annulla registrazione'),
                      onConfirm: async reason => { await haccpApiService.voidIntervention(iv.id, reason); load(); },
                    })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={t('archive.documents', 'Documenti')}
          icon={<FileText className="h-4 w-4" />}
          aside={canManage && (
            <button type="button" className={`${dsButton.quiet} h-9 px-3 text-[14px]`} onClick={() => setDocDialog({ row: null })}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('archive.upload', 'Carica')}
            </button>
          )}
        />
        {documents.length === 0 ? (
          <p className={emptyNote}>{t('archive.noDocuments', 'Nessun documento. Comincia dal manuale di autocontrollo e dalla registrazione sanitaria.')}</p>
        ) : (
          <ul className={rowList}>
            {documents.map(d => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{d.title}</div>
                  <div className="truncate text-[13px] text-[var(--ds-text-muted)]">
                    {documentLabel(d.category, t)}{d.note ? ` · ${d.note}` : ''}
                  </div>
                </div>
                {d.archived ? <StatusPill>{t('archive.archived', 'Archiviato')}</StatusPill> : <ValidityPill date={d.validUntil} today={today} />}
                {d.hasFile && (
                  <button type="button" className={quietIconButton} onClick={() => open(d.id)} aria-label={t('archive.openFile', 'Apri {{nome}}', { nome: d.title })}>
                    <Paperclip className="h-4 w-4" />
                  </button>
                )}
                {canManage && (
                  <button type="button" className={quietIconButton} onClick={() => setDocDialog({ row: d })} aria-label={t('config.edit', 'Modifica {{nome}}', { nome: d.title })}>
                    <Pencil className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={t('archive.allergens', 'Libro allergeni')}
          icon={<BookOpen className="h-4 w-4" />}
          aside={
            <button type="button" className={`${dsButton.quiet} h-9 px-3 text-[14px]`} onClick={printAllergens} disabled={printingAllergens}>
              <Printer className="h-4 w-4" aria-hidden />
              {t('archive.printAllergens', 'Stampa')}
            </button>
          }
        />
        <p className="text-[14px] text-[var(--ds-text-muted)]">
          {t('archive.allergensIntro', 'I 14 allergeni del Reg. UE 1169/2011 per ogni piatto attivo, come li dice il menu. Si correggono in Menu, sulla scheda del piatto.')}
        </p>
      </Card>

      {training && data && (
        <TrainingDialog
          row={training.row}
          staff={data.staff}
          onClose={() => setTraining(null)}
          onSaved={() => { setTraining(null); load(); }}
        />
      )}
      {intervention && (
        <InterventionDialog onClose={() => setIntervention(false)} onSaved={() => { setIntervention(false); load(); }} />
      )}
      {docDialog && (
        <DocumentDialog row={docDialog.row} onClose={() => setDocDialog(null)} onSaved={() => { setDocDialog(null); load(); }} />
      )}
      <ReasonDialog request={reasonRequest} onDone={() => setReasonRequest(null)} />
    </div>
  );
};

// =============================================================================
// Dialoghi
// =============================================================================

const label = 'mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]';

const FileField: React.FC<{ id: string; file: File | null; onChange: (f: File | null) => void; current?: string | null; error?: string | null }> = ({ id, file, onChange, current }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  return (
    <div>
      <label htmlFor={id} className={label}>{t('archive.file', 'File (PDF o foto, massimo 5 MB)')}</label>
      <input
        id={id}
        type="file"
        accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx,.odt,.ods"
        onChange={e => onChange(e.target.files?.[0] ?? null)}
        className="block w-full text-[14px] text-[var(--ds-text-secondary)] file:mr-3 file:h-11 file:rounded-[var(--ds-radius-control)] file:border-0 file:bg-[var(--ds-surface-row)] file:px-4 file:text-[14px] file:font-medium file:text-[var(--ds-text-primary)]"
      />
      {!file && current && <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">{t('archive.currentFile', 'Allegato: {{nome}}', { nome: current })}</p>}
    </div>
  );
};

const addYears = (iso: string, years: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
};

const TrainingDialog: React.FC<{
  row: HaccpTraining | null;
  staff: ArchiveData['staff'];
  onClose: () => void;
  onSaved: () => void;
}> = ({ row, staff, onClose, onSaved }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [staffId, setStaffId] = useState<string>(row?.staffMemberId ?? '');
  const [personName, setPersonName] = useState(row && !row.staffMemberId ? row.personName : '');
  const [course, setCourse] = useState<HaccpTrainingCourse>(row?.course ?? 'ALIMENTARISTA');
  const [title, setTitle] = useState(row?.title ?? '');
  const [provider, setProvider] = useState(row?.provider ?? '');
  const [hours, setHours] = useState(formatNumber(row?.hours));
  const [completedOn, setCompletedOn] = useState(row?.completedOn ?? todayISO());
  const [expiresOn, setExpiresOn] = useState(row?.expiresOn ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState(row?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (archived?: boolean) => {
    const person = staffId ? staff.find(s => s.id === staffId) : null;
    const name = person ? `${person.name} ${person.surname}`.trim() : personName.trim();
    if (!name) { setError(t('archive.personRequired', 'Scegli la persona o scrivi il nome.')); return; }
    if (file && file.size > MAX_FILE_BYTES) { setError(t('archive.fileTooBig', 'Il file supera i 5 MB.')); return; }
    setBusy(true);
    setError(null);
    try {
      let documentId = row?.documentId ?? null;
      if (file) {
        const doc = await haccpApiService.uploadDocument({
          category: 'ATTESTATO',
          // In italiano come il resto dell'archivio: è un documento per l'ASL.
          title: `Attestato · ${title.trim() || HACCP_TRAINING_LABELS_IT[course]} · ${name}`,
          validUntil: expiresOn || null,
          file: await readFile(file),
        });
        documentId = doc.id;
      }
      const input = {
        staffMemberId: staffId || null,
        personName: name,
        course,
        title: title.trim() || null,
        provider: provider.trim() || null,
        hours: parseNumber(hours),
        completedOn,
        expiresOn: expiresOn || null,
        documentId,
        note: note.trim() || null,
        ...(archived !== undefined ? { archived } : {}),
      };
      if (row) await haccpApiService.updateTraining(row.id, input);
      else await haccpApiService.createTraining(input);
      onSaved();
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title={row ? t('archive.editTraining', 'Modifica attestato') : t('archive.newTraining', 'Nuovo attestato')}
      size="sm"
      bodyClassName="px-5 py-5 sm:px-6"
      footerStart={row && (
        <button type="button" className={dsButton.quiet} onClick={() => save(!row.archived)} disabled={busy}>
          {row.archived ? t('config.restore', 'Ripristina') : t('config.archive', 'Archivia')}
        </button>
      )}
      footer={
        <>
          <button type="button" className={dsButton.quiet} onClick={onClose} disabled={busy}>{t('cancel', 'Annulla')}</button>
          <button type="button" className={dsButton.primary} onClick={() => save()} disabled={busy}>{t('save', 'Salva')}</button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="haccp-tr-person" className={label}>{t('archive.person', 'Persona')}</label>
          <select id="haccp-tr-person" value={staffId} onChange={e => setStaffId(e.target.value)} className={dsSelect}>
            <option value="">{t('archive.otherPerson', 'Un\'altra persona…')}</option>
            {staff.map(s => <option key={s.id} value={s.id}>{`${s.name} ${s.surname}`}</option>)}
          </select>
          {!staffId && (
            <input
              aria-label={t('archive.personName', 'Nome e cognome')}
              placeholder={t('archive.personName', 'Nome e cognome')}
              value={personName}
              onChange={e => setPersonName(e.target.value)}
              className={`${dsInput} mt-2`}
            />
          )}
        </div>
        <div>
          <label htmlFor="haccp-tr-course" className={label}>{t('archive.course', 'Corso')}</label>
          <select id="haccp-tr-course" value={course} onChange={e => setCourse(e.target.value as HaccpTrainingCourse)} className={dsSelect}>
            {HACCP_TRAINING_COURSES.map(c => <option key={c} value={c}>{courseLabel(c, t)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="haccp-tr-title" className={label}>{t('archive.courseTitle', 'Titolo (facoltativo)')}</label>
          <input id="haccp-tr-title" value={title} onChange={e => setTitle(e.target.value)} className={dsInput} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label htmlFor="haccp-tr-provider" className={label}>{t('archive.provider', 'Ente')}</label>
            <input id="haccp-tr-provider" value={provider} onChange={e => setProvider(e.target.value)} className={dsInput} />
          </div>
          <div>
            <label htmlFor="haccp-tr-hours" className={label}>{t('archive.hoursLabel', 'Ore')}</label>
            <input id="haccp-tr-hours" inputMode="decimal" value={hours} onChange={e => setHours(e.target.value)} className={`${dsInput} text-right tabular-nums`} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="haccp-tr-done" className={label}>{t('archive.completedOn', 'Data del corso')}</label>
            <input id="haccp-tr-done" type="date" value={completedOn} onChange={e => e.target.value && setCompletedOn(e.target.value)} className={`${dsInput} tabular-nums`} />
          </div>
          <div>
            <label htmlFor="haccp-tr-exp" className={label}>{t('archive.expiresOnLabel', 'Scadenza')}</label>
            <input id="haccp-tr-exp" type="date" value={expiresOn} onChange={e => setExpiresOn(e.target.value)} className={`${dsInput} tabular-nums`} />
          </div>
        </div>
        {/* Il rinnovo cambia da regione a regione: lo si sceglie, non lo si
            indovina. Due scorciatoie per i casi più comuni. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-[var(--ds-text-muted)]">{t('archive.renewHint', 'Il rinnovo dipende dalla regione:')}</span>
          {[3, 5].map(y => (
            <button key={y} type="button" className={chip} onClick={() => setExpiresOn(addYears(completedOn, y))}>
              {t('archive.plusYears', '+{{n}} anni', { n: y })}
            </button>
          ))}
        </div>
        <FileField id="haccp-tr-file" file={file} onChange={setFile} current={row?.documentId ? t('archive.certificate', 'attestato') : null} />
        <div>
          <label htmlFor="haccp-tr-note" className={label}>{t('notePlaceholder', 'Note (opzionale)')}</label>
          <input id="haccp-tr-note" value={note} onChange={e => setNote(e.target.value)} className={dsInput} />
        </div>
        {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
};

const InterventionDialog: React.FC<{ onClose: () => void; onSaved: () => void }> = ({ onClose, onSaved }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [type, setType] = useState<HaccpInterventionType>('DISINFESTAZIONE');
  const [date, setDate] = useState(todayISO());
  const [provider, setProvider] = useState('');
  const [outcomeOk, setOutcomeOk] = useState(true);
  const [findings, setFindings] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reference, setReference] = useState('');
  const [nextDue, setNextDue] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!outcomeOk && !findings.trim()) { setError(t('archive.findingsRequired', 'Scrivi i rilievi della ditta.')); return; }
    if (file && file.size > MAX_FILE_BYTES) { setError(t('archive.fileTooBig', 'Il file supera i 5 MB.')); return; }
    setBusy(true);
    setError(null);
    try {
      let documentId: number | null = null;
      if (file) {
        const doc = await haccpApiService.uploadDocument({
          category: 'RAPPORTO',
          title: `${HACCP_INTERVENTION_LABELS_IT[type]} · ${date}${provider.trim() ? ` · ${provider.trim()}` : ''}`,
          file: await readFile(file),
        });
        documentId = doc.id;
      }
      await haccpApiService.createIntervention({
        date, type,
        provider: provider.trim() || null,
        outcomeOk,
        findings: outcomeOk ? null : findings.trim(),
        quantity: quantity.trim() || null,
        reference: reference.trim() || null,
        nextDue: nextDue || null,
        documentId,
        note: note.trim() || null,
      });
      onSaved();
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title={t('archive.newIntervention', 'Registra un intervento')}
      size="sm"
      bodyClassName="px-5 py-5 sm:px-6"
      footer={
        <>
          <button type="button" className={dsButton.quiet} onClick={onClose} disabled={busy}>{t('cancel', 'Annulla')}</button>
          <button type="button" className={dsButton.primary} onClick={save} disabled={busy}>{t('save', 'Salva')}</button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="haccp-iv-type" className={label}>{t('archive.interventionType', 'Intervento')}</label>
            <select id="haccp-iv-type" value={type} onChange={e => setType(e.target.value as HaccpInterventionType)} className={dsSelect}>
              {HACCP_INTERVENTION_TYPES.map(k => <option key={k} value={k}>{interventionLabel(k, t)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="haccp-iv-date" className={label}>{t('day', 'Giorno')}</label>
            <input id="haccp-iv-date" type="date" value={date} max={todayISO()} onChange={e => e.target.value && setDate(e.target.value)} className={`${dsInput} tabular-nums`} />
          </div>
        </div>
        <div>
          <label htmlFor="haccp-iv-provider" className={label}>{t('archive.company', 'Ditta')}</label>
          <input id="haccp-iv-provider" value={provider} onChange={e => setProvider(e.target.value)} className={dsInput} />
        </div>
        <div>
          <span className={label}>{t('outcome', 'Esito')}</span>
          <SegmentedControl<'ok' | 'ko'>
            value={outcomeOk ? 'ok' : 'ko'}
            onChange={v => setOutcomeOk(v === 'ok')}
            ariaLabel={t('outcome', 'Esito')}
            options={[
              { value: 'ok', label: t('archive.noFindings', 'Senza rilievi') },
              { value: 'ko', label: t('archive.findings', 'Con rilievi') },
            ]}
          />
        </div>
        {!outcomeOk && (
          <div>
            <label htmlFor="haccp-iv-findings" className={label}>{t('archive.findingsLabel', 'Rilievi')}</label>
            <textarea id="haccp-iv-findings" rows={2} value={findings} onChange={e => setFindings(e.target.value)} className={dsTextarea} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          {type === 'RITIRO_OLIO' && (
            <div>
              <label htmlFor="haccp-iv-qty" className={label}>{t('quantity', 'Quantità')}</label>
              <input id="haccp-iv-qty" value={quantity} onChange={e => setQuantity(e.target.value)} className={dsInput} />
            </div>
          )}
          <div className={type === 'RITIRO_OLIO' ? '' : 'col-span-2'}>
            <label htmlFor="haccp-iv-ref" className={label}>
              {type === 'RITIRO_OLIO' ? t('archive.wasteForm', 'Formulario n.') : t('archive.reference', 'Rapporto n.')}
            </label>
            <input id="haccp-iv-ref" value={reference} onChange={e => setReference(e.target.value)} className={dsInput} />
          </div>
        </div>
        <div>
          <label htmlFor="haccp-iv-next" className={label}>{t('archive.nextDueLabel', 'Prossimo intervento entro')}</label>
          <input id="haccp-iv-next" type="date" value={nextDue} onChange={e => setNextDue(e.target.value)} className={`${dsInput} tabular-nums`} />
        </div>
        <FileField id="haccp-iv-file" file={file} onChange={setFile} />
        <div>
          <label htmlFor="haccp-iv-note" className={label}>{t('notePlaceholder', 'Note (opzionale)')}</label>
          <input id="haccp-iv-note" value={note} onChange={e => setNote(e.target.value)} className={dsInput} />
        </div>
        {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
};

const DocumentDialog: React.FC<{ row: HaccpDocument | null; onClose: () => void; onSaved: () => void }> = ({ row, onClose, onSaved }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [category, setCategory] = useState<HaccpDocumentCategory>(row?.category ?? 'MANUALE');
  const [title, setTitle] = useState(row?.title ?? '');
  const [validUntil, setValidUntil] = useState(row?.validUntil ?? '');
  const [note, setNote] = useState(row?.note ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Il titolo si propone dal tipo, finché non lo si scrive.
  const [titleTouched, setTitleTouched] = useState(!!row);
  useEffect(() => {
    if (!titleTouched) setTitle(documentLabel(category, t));
  }, [category, titleTouched, t]);

  const save = async (archived?: boolean) => {
    if (!title.trim()) { setError(t('archive.titleRequired', 'Serve un titolo.')); return; }
    if (file && file.size > MAX_FILE_BYTES) { setError(t('archive.fileTooBig', 'Il file supera i 5 MB.')); return; }
    setBusy(true);
    setError(null);
    try {
      if (row) {
        await haccpApiService.updateDocument(row.id, {
          category, title: title.trim(), validUntil: validUntil || null, note: note.trim() || null,
          ...(archived !== undefined ? { archived } : {}),
        });
      } else {
        await haccpApiService.uploadDocument({
          category, title: title.trim(), validUntil: validUntil || null, note: note.trim() || null,
          file: file ? await readFile(file) : null,
        });
      }
      onSaved();
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title={row ? t('archive.editDocument', 'Modifica documento') : t('archive.newDocument', 'Carica un documento')}
      size="sm"
      bodyClassName="px-5 py-5 sm:px-6"
      footerStart={row && (
        <button type="button" className={dsButton.quiet} onClick={() => save(!row.archived)} disabled={busy}>
          {row.archived ? t('config.restore', 'Ripristina') : t('config.archive', 'Archivia')}
        </button>
      )}
      footer={
        <>
          <button type="button" className={dsButton.quiet} onClick={onClose} disabled={busy}>{t('cancel', 'Annulla')}</button>
          <button type="button" className={dsButton.primary} onClick={() => save()} disabled={busy}>{t('save', 'Salva')}</button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="haccp-doc-cat" className={label}>{t('archive.docType', 'Tipo')}</label>
          <select id="haccp-doc-cat" value={category} onChange={e => setCategory(e.target.value as HaccpDocumentCategory)} className={dsSelect}>
            {HACCP_DOCUMENT_CATEGORIES.map(c => <option key={c} value={c}>{documentLabel(c, t)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="haccp-doc-title" className={label}>{t('archive.docTitle', 'Titolo')}</label>
          <input id="haccp-doc-title" value={title} onChange={e => { setTitle(e.target.value); setTitleTouched(true); }} className={dsInput} />
        </div>
        {!row && <FileField id="haccp-doc-file" file={file} onChange={setFile} />}
        {row && !row.hasFile && <p className="text-[13px] text-[var(--ds-text-muted)]">{t('archive.noFile', 'Senza file: solo un riferimento.')}</p>}
        <div>
          <label htmlFor="haccp-doc-valid" className={label}>{t('archive.validUntilLabel', 'Valido fino al (facoltativo)')}</label>
          <input id="haccp-doc-valid" type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} className={`${dsInput} tabular-nums`} />
        </div>
        <div>
          <label htmlFor="haccp-doc-note" className={label}>{t('notePlaceholder', 'Note (opzionale)')}</label>
          <input id="haccp-doc-note" value={note} onChange={e => setNote(e.target.value)} className={dsInput} />
        </div>
        {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
};
