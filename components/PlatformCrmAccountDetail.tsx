import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Building2, Check, ExternalLink, Mail, MessageCircle, Pencil, Phone, Plus, Star, Trash2,
} from 'lucide-react';
import {
  Callout, Field, FormCard, ModalShell, PaneHeader, SegmentedControl, StatusPill,
  dsButton, dsIconButton, dsInput, dsSelect, dsTextarea,
} from './ds';
import { Loader } from './Loader';
import {
  platformCrmApi, CRM_ACTIVITY_KINDS, CRM_STAGES,
  type CrmAccountDetail, type CrmAccountFields, type CrmActivityKind, type CrmContact, type CrmDeal, type CrmStage, type CrmTask,
} from '../services/platformCrmApiService';
import type { AdminTenant } from '../services/apiService';
import {
  ACTIVITY_ICON, ACTIVITY_LABEL, BUSINESS_TYPE_SUGGESTIONS, DEAL_KIND_LABEL, DEAL_STAGE_LABEL, HealthPill,
  SOFTWARE_SUGGESTIONS, SOURCE_SUGGESTIONS, STAGE_LABEL, StagePill, addDaysIso, centsToInput, eur, formatDay,
  formatInstant, parseEuroInput, telHref, todayRome, whatsappHref, type ShowToast,
} from './PlatformCrmShared';
import { CrmCard } from './PlatformCrmOverview';
import { DealFormModal } from './PlatformCrmPipeline';
import { NewTaskForm, TaskRow } from './PlatformCrmTasks';
import { NewTenantModal, TenantCard, billingPill } from './PlatformTenantAdmin';
import { relativeTime } from '../utils/relativeTime';
import type { ApiError } from '../services/apiError';

/* ============================================
   PANNELLO PIATTAFORMA — CRM, scheda dell'azienda
   ============================================
   Tutto di un cliente (o di un lead) in quattro sezioni:
   - Riepilogo: fase, salute dall'uso, canone e abbonamento, dati
     dell'azienda, referenti, avviamento.
   - Cronologia: note, chiamate, email e incontri scritti qui, più cambi di
     fase, richieste di supporto, avvisi e creazione del ristorante.
   - Da fare: promemoria e opportunità di questa azienda.
   - Gestione: la card del ristorante di sempre (feature, permessi, Sofia,
     billing, «Entra», sospensione), o come crearlo per un lead. */

type Section = 'riepilogo' | 'cronologia' | 'dafare' | 'gestione';

/* ── Modale dei dati dell'azienda ────────────────────────────────────────
   Lo stesso form crea un lead (con il primo referente) e modifica una
   scheda. I campi vuoti si salvano vuoti: niente valori inventati. */
type FormState = Record<
  'name' | 'stage' | 'business_type' | 'source' | 'current_software' | 'city' | 'address' | 'phone' | 'email' | 'website'
  | 'legal_name' | 'vat_number' | 'sdi_code' | 'pec' | 'seats' | 'locations' | 'expected_mrr' | 'contract_start'
  | 'renewal_date' | 'lost_reason' | 'notes' | 'tags' | 'contact_name' | 'contact_role' | 'contact_phone' | 'contact_email',
  string
> & { internal: boolean };

const emptyForm = (): FormState => ({
  name: '', stage: 'lead', business_type: '', source: '', current_software: '', city: '', address: '', phone: '', email: '',
  website: '', legal_name: '', vat_number: '', sdi_code: '', pec: '', seats: '', locations: '', expected_mrr: '',
  contract_start: '', renewal_date: '', lost_reason: '', notes: '', tags: '', contact_name: '', contact_role: '',
  contact_phone: '', contact_email: '', internal: false,
});

const formFrom = (a: CrmAccountDetail): FormState => ({
  ...emptyForm(),
  name: a.name, stage: a.stage, business_type: a.business_type ?? '', source: a.source ?? '',
  current_software: a.current_software ?? '', city: a.city ?? '', address: a.address ?? '', phone: a.phone ?? '',
  email: a.email ?? '', website: a.website ?? '', legal_name: a.legal_name ?? '', vat_number: a.vat_number ?? '',
  sdi_code: a.sdi_code ?? '', pec: a.pec ?? '', seats: a.seats != null ? String(a.seats) : '',
  locations: a.locations != null ? String(a.locations) : '', expected_mrr: centsToInput(a.expected_mrr_cents),
  contract_start: a.contract_start ?? '', renewal_date: a.renewal_date ?? '', lost_reason: a.lost_reason ?? '',
  notes: a.notes ?? '', tags: a.tags.join(', '), internal: a.internal,
});

export const AccountFormModal: React.FC<{
  open: boolean;
  onClose: () => void;
  account?: CrmAccountDetail | null;
  onSaved: (detail: CrmAccountDetail) => void;
}> = ({ open, onClose, account = null, onSaved }) => {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(account ? formFrom(account) : emptyForm());
  }, [open, account]);

  if (!open) return null;
  const set = (patch: Partial<FormState>) => setForm(f => ({ ...f, ...patch }));
  const text = (key: keyof FormState) => ({
    value: form[key] as string,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set({ [key]: e.target.value } as Partial<FormState>),
  });

  const save = async () => {
    if (!form.name.trim()) return setError('Il nome è obbligatorio');
    const mrr = parseEuroInput(form.expected_mrr);
    if (Number.isNaN(mrr)) return setError('Canone non valido');
    const int = (s: string) => (s.trim() === '' ? null : Number(s));
    const seats = int(form.seats), locations = int(form.locations);
    if ([seats, locations].some(n => n !== null && (!Number.isInteger(n) || n < 0))) return setError('Coperti e sedi sono numeri interi');
    const orNull = (s: string) => (s.trim() === '' ? null : s.trim());
    const body: Partial<CrmAccountFields> = {
      name: form.name.trim(),
      stage: form.stage as CrmStage,
      internal: form.internal,
      business_type: orNull(form.business_type), source: orNull(form.source), current_software: orNull(form.current_software),
      city: orNull(form.city), address: orNull(form.address), phone: orNull(form.phone), email: orNull(form.email),
      website: orNull(form.website), legal_name: orNull(form.legal_name), vat_number: orNull(form.vat_number),
      sdi_code: orNull(form.sdi_code), pec: orNull(form.pec), seats, locations, expected_mrr_cents: mrr,
      contract_start: form.contract_start || null, renewal_date: form.renewal_date || null,
      lost_reason: orNull(form.lost_reason), notes: orNull(form.notes),
      tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
    };
    setBusy(true);
    setError(null);
    try {
      const saved = account
        ? await platformCrmApi.updateAccount(account.id, body)
        : await platformCrmApi.createAccount({
          ...body,
          ...(form.contact_name.trim() ? {
            contact: {
              full_name: form.contact_name.trim(), role: orNull(form.contact_role),
              phone: orNull(form.contact_phone), email: orNull(form.contact_email),
            },
          } : {}),
        });
      onSaved(saved);
      onClose();
    } catch (err) {
      setError((err as ApiError).message || 'Salvataggio non riuscito');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title={account ? 'Dati dell\'azienda' : 'Nuova azienda'}
      subtitle={account?.name}
      size="lg"
      bodyClassName="p-5 sm:p-6"
      footer={
        <>
          <button type="button" className={dsButton.secondary} onClick={onClose} disabled={busy}>Annulla</button>
          <button type="button" className={dsButton.primary} onClick={save} disabled={busy || !form.name.trim()}>{busy ? 'Salvo…' : 'Salva'}</button>
        </>
      }
    >
      <datalist id="crm-business-types">{BUSINESS_TYPE_SUGGESTIONS.map(s => <option key={s} value={s} />)}</datalist>
      <datalist id="crm-sources">{SOURCE_SUGGESTIONS.map(s => <option key={s} value={s} />)}</datalist>
      <datalist id="crm-software">{SOFTWARE_SUGGESTIONS.map(s => <option key={s} value={s} />)}</datalist>
      <div className="space-y-4">
        {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}
        <FormCard title="Azienda">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Nome" htmlFor="crm-name" required className="sm:col-span-2">
              <input id="crm-name" className={dsInput} autoFocus={!account} {...text('name')} />
            </Field>
            <Field label="Tipo di locale" htmlFor="crm-type">
              <input id="crm-type" className={dsInput} list="crm-business-types" {...text('business_type')} />
            </Field>
            <Field label="Città" htmlFor="crm-city"><input id="crm-city" className={dsInput} {...text('city')} /></Field>
            <Field label="Telefono" htmlFor="crm-phone"><input id="crm-phone" type="tel" className={dsInput} {...text('phone')} /></Field>
            <Field label="Email" htmlFor="crm-email"><input id="crm-email" type="email" className={dsInput} {...text('email')} /></Field>
            {account && (
              <>
                <Field label="Indirizzo" htmlFor="crm-address"><input id="crm-address" className={dsInput} {...text('address')} /></Field>
                <Field label="Sito" htmlFor="crm-web"><input id="crm-web" className={dsInput} placeholder="https://" {...text('website')} /></Field>
              </>
            )}
            <Field label="Coperti" htmlFor="crm-seats"><input id="crm-seats" className={dsInput} inputMode="numeric" {...text('seats')} /></Field>
            <Field label="Sedi" htmlFor="crm-locations"><input id="crm-locations" className={dsInput} inputMode="numeric" placeholder="1" {...text('locations')} /></Field>
          </div>
        </FormCard>

        {!account && (
          <FormCard title="Referente">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Nome" htmlFor="crm-c-name"><input id="crm-c-name" className={dsInput} {...text('contact_name')} /></Field>
              <Field label="Ruolo" htmlFor="crm-c-role"><input id="crm-c-role" className={dsInput} placeholder="titolare" {...text('contact_role')} /></Field>
              <Field label="Telefono" htmlFor="crm-c-phone"><input id="crm-c-phone" type="tel" className={dsInput} {...text('contact_phone')} /></Field>
              <Field label="Email" htmlFor="crm-c-email"><input id="crm-c-email" type="email" className={dsInput} {...text('contact_email')} /></Field>
            </div>
          </FormCard>
        )}

        <FormCard title="Vendita">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Fase" htmlFor="crm-stage">
              <select id="crm-stage" className={dsSelect} value={form.stage} onChange={e => set({ stage: e.target.value })}>
                {CRM_STAGES.map(s => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
              </select>
            </Field>
            <Field label="Da dove arriva" htmlFor="crm-source"><input id="crm-source" className={dsInput} list="crm-sources" {...text('source')} /></Field>
            <Field label="Cosa usa oggi" htmlFor="crm-software"><input id="crm-software" className={dsInput} list="crm-software" {...text('current_software')} /></Field>
            <Field label="Canone (€/mese)" htmlFor="crm-mrr" hint="Atteso per un lead, accordato per un cliente senza Stripe.">
              <input id="crm-mrr" className={dsInput} inputMode="decimal" {...text('expected_mrr')} />
            </Field>
            {account && (
              <>
                <Field label="Inizio contratto" htmlFor="crm-start"><input id="crm-start" type="date" className={dsInput} {...text('contract_start')} /></Field>
                <Field label="Rinnovo" htmlFor="crm-renewal"><input id="crm-renewal" type="date" className={dsInput} {...text('renewal_date')} /></Field>
              </>
            )}
            {(form.stage === 'perso' || form.stage === 'disdetto') && (
              <Field label="Motivo" htmlFor="crm-lost" className="sm:col-span-2"><input id="crm-lost" className={dsInput} {...text('lost_reason')} /></Field>
            )}
            <Field label="Tag" htmlFor="crm-tags" hint="Separati da virgola." className="sm:col-span-2">
              <input id="crm-tags" className={dsInput} placeholder="milano, gruppo, fiera 2026" {...text('tags')} />
            </Field>
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-[14px] text-[var(--ds-text-primary)] sm:col-span-2">
              <input type="checkbox" checked={form.internal} onChange={e => set({ internal: e.target.checked })} className="h-4 w-4 accent-[var(--ds-action-bg)]" />
              Demo o locale interno: fuori da MRR e conteggi
            </label>
          </div>
        </FormCard>

        {account && (
          <FormCard title="Fatturazione" collapsible defaultOpen={!!(account.vat_number || account.legal_name)}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Ragione sociale" htmlFor="crm-legal" className="sm:col-span-2"><input id="crm-legal" className={dsInput} {...text('legal_name')} /></Field>
              <Field label="Partita IVA" htmlFor="crm-vat"><input id="crm-vat" className={dsInput} {...text('vat_number')} /></Field>
              <Field label="Codice SDI" htmlFor="crm-sdi"><input id="crm-sdi" className={`${dsInput} font-mono`} maxLength={7} {...text('sdi_code')} /></Field>
              <Field label="PEC" htmlFor="crm-pec" className="sm:col-span-2"><input id="crm-pec" type="email" className={dsInput} {...text('pec')} /></Field>
            </div>
          </FormCard>
        )}

        <FormCard title="Note">
          <textarea className={`${dsTextarea} min-h-[96px]`} aria-label="Note" {...text('notes')} />
        </FormCard>
      </div>
    </ModalShell>
  );
};

/* ── Referenti ────────────────────────────────────────────────────────── */
const ContactForm: React.FC<{
  initial?: CrmContact | null;
  busy: boolean;
  onSubmit: (input: Partial<CrmContact>) => void;
  onCancel: () => void;
}> = ({ initial = null, busy, onSubmit, onCancel }) => {
  const [c, setC] = useState({
    full_name: initial?.full_name ?? '', role: initial?.role ?? '', phone: initial?.phone ?? '', email: initial?.email ?? '',
  });
  const orNull = (s: string) => (s.trim() === '' ? null : s.trim());
  return (
    <form
      className="space-y-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3"
      onSubmit={e => {
        e.preventDefault();
        if (c.full_name.trim()) onSubmit({ full_name: c.full_name.trim(), role: orNull(c.role), phone: orNull(c.phone), email: orNull(c.email) });
      }}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input className={`${dsInput} bg-[var(--ds-surface)]`} placeholder="Nome" aria-label="Nome" value={c.full_name} autoFocus onChange={e => setC({ ...c, full_name: e.target.value })} />
        <input className={`${dsInput} bg-[var(--ds-surface)]`} placeholder="Ruolo" aria-label="Ruolo" value={c.role} onChange={e => setC({ ...c, role: e.target.value })} />
        <input className={`${dsInput} bg-[var(--ds-surface)]`} placeholder="Telefono" aria-label="Telefono" type="tel" value={c.phone} onChange={e => setC({ ...c, phone: e.target.value })} />
        <input className={`${dsInput} bg-[var(--ds-surface)]`} placeholder="Email" aria-label="Email" type="email" value={c.email} onChange={e => setC({ ...c, email: e.target.value })} />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className={dsButton.secondary} onClick={onCancel} disabled={busy}>Annulla</button>
        <button type="submit" className={dsButton.primary} disabled={busy || !c.full_name.trim()}>Salva</button>
      </div>
    </form>
  );
};

const ContactLinks: React.FC<{ phone: string | null; email: string | null; name: string; onCall?: () => void }> = ({ phone, email, name, onCall }) => (
  <>
    {phone && (
      <>
        <a href={telHref(phone)} onClick={onCall} className={dsIconButton} aria-label={`Chiama ${name}`} title={phone}><Phone className="h-4 w-4" aria-hidden /></a>
        <a href={whatsappHref(phone)} target="_blank" rel="noreferrer" className={dsIconButton} aria-label={`WhatsApp a ${name}`}><MessageCircle className="h-4 w-4" aria-hidden /></a>
      </>
    )}
    {email && <a href={`mailto:${email}`} className={dsIconButton} aria-label={`Scrivi a ${name}`} title={email}><Mail className="h-4 w-4" aria-hidden /></a>}
  </>
);

/* ── Righe chiave/valore ──────────────────────────────────────────────── */
const Facts: React.FC<{ items: Array<[string, React.ReactNode]> }> = ({ items }) => {
  const shown = items.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (shown.length === 0) return null;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {shown.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[12px] text-[var(--ds-text-muted)]">{k}</dt>
          <dd className="break-words text-[14px] text-[var(--ds-text-primary)]">{v}</dd>
        </div>
      ))}
    </dl>
  );
};

/* ── Scheda ───────────────────────────────────────────────────────────── */
export const PlatformCrmAccountDetail: React.FC<{
  accountId: number;
  tenants: AdminTenant[];
  onTenantPatched: (next: AdminTenant) => void;
  onTenantsChanged: () => void;
  onBack: () => void;
  onChanged: (detail: CrmAccountDetail) => void;
  onDeleted: (id: number) => void;
  showToast: ShowToast;
}> = ({ accountId, tenants, onTenantPatched, onTenantsChanged, onBack, onChanged, onDeleted, showToast }) => {
  const [detail, setDetail] = useState<CrmAccountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('riepilogo');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState<'new' | number | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [dealModal, setDealModal] = useState<CrmDeal | 'new' | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [linkTenant, setLinkTenant] = useState('');
  // Fase perso/disdetto: prima il motivo, poi il salvataggio.
  const [pendingStage, setPendingStage] = useState<CrmStage | null>(null);
  const [lostReason, setLostReason] = useState('');
  // Composer della cronologia.
  const [kind, setKind] = useState<CrmActivityKind>('nota');
  const [note, setNote] = useState('');
  const [noteContact, setNoteContact] = useState('');
  const [noteWhen, setNoteWhen] = useState('');
  const [followUp, setFollowUp] = useState('');

  const apply = useCallback((next: CrmAccountDetail) => {
    setDetail(next);
    onChanged(next);
  }, [onChanged]);

  const load = useCallback(async () => {
    try {
      setError(null);
      const next = await platformCrmApi.getAccount(accountId);
      setDetail(next);
      onChanged(next);
    } catch (err) {
      setError((err as ApiError).message || 'Scheda non caricata');
    }
  }, [accountId, onChanged]);

  useEffect(() => {
    setDetail(null);
    setSection('riepilogo');
    setContactForm(null);
    setPendingStage(null);
    setArmed(null);
    load();
  }, [accountId, load]);

  const run = async (key: string, fn: () => Promise<CrmAccountDetail | void>, ok?: string) => {
    if (busy) return;
    setBusy(key);
    try {
      const next = await fn();
      if (next) apply(next);
      if (ok) showToast(ok, 'success');
    } catch (err) {
      showToast((err as ApiError).message || 'Operazione non riuscita', 'error');
    } finally {
      setBusy(null);
      setArmed(null);
    }
  };

  const tenant = useMemo(
    () => (detail?.customer_tenant_id ? tenants.find(t => t.id === detail.customer_tenant_id) ?? null : null),
    [detail, tenants],
  );
  const primary = detail?.contacts.find(c => c.is_primary) ?? detail?.contacts[0] ?? null;
  const callPhone = primary?.phone || detail?.phone || null;
  const mailTo = primary?.email || detail?.email || null;

  const changeStage = (stage: CrmStage) => {
    if (!detail || stage === detail.stage) return;
    if (stage === 'perso' || stage === 'disdetto') {
      setPendingStage(stage);
      setLostReason(detail.lost_reason ?? '');
      return;
    }
    run('stage', () => platformCrmApi.updateAccount(detail.id, { stage }), `Fase: ${STAGE_LABEL[stage]}`);
  };

  const logActivity = async () => {
    if (!detail || !note.trim()) return;
    await run('note', async () => {
      const next = await platformCrmApi.addActivity(detail.id, {
        kind,
        body: note.trim(),
        contact_id: noteContact ? Number(noteContact) : null,
        ...(noteWhen ? { occurred_at: new Date(noteWhen).toISOString() } : {}),
      });
      if (followUp) {
        await platformCrmApi.createTask({ title: `Ricontattare ${detail.name}`, due_date: followUp, account_id: detail.id });
        return platformCrmApi.getAccount(detail.id);
      }
      return next;
    }, followUp ? `Registrato · promemoria per il ${formatDay(followUp)}` : 'Registrato');
    setNote('');
    setNoteWhen('');
    setFollowUp('');
  };

  const taskChanged = (task: CrmTask | null, removedId?: number) => {
    if (!detail) return;
    const tasks = task
      ? [...detail.tasks.filter(t => t.id !== task.id), task].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id - b.id)
      : detail.tasks.filter(t => t.id !== removedId);
    setDetail({ ...detail, tasks });
    // La lista e la cronologia («Promemoria fatto») si riallineano dal server.
    if (task?.done) load();
  };

  if (error) {
    return (
      <>
        <PaneHeader onBack={onBack} backLabel="Torna ai clienti" title="Scheda" />
        <div className="px-4 sm:px-6 lg:px-8"><Callout tone="critical" icon={AlertTriangle}>{error}</Callout></div>
      </>
    );
  }
  if (!detail) {
    return (
      <>
        <PaneHeader onBack={onBack} backLabel="Torna ai clienti" title="…" />
        <div className="flex h-40 items-center justify-center"><Loader /></div>
      </>
    );
  }

  const openTasks = detail.tasks.filter(t => !t.done);
  const doneTasks = detail.tasks.filter(t => t.done);
  const health = detail.health;
  const billing = detail.billing;
  const bp = billingPill(detail.tenant?.billing_status ?? null);
  const onboardingDone = detail.onboarding_steps.filter(s => s.done).length;
  const subtitle = [detail.business_type, detail.city, detail.tenant?.slug].filter(Boolean).join(' · ') || undefined;

  return (
    <>
      <PaneHeader
        onBack={onBack}
        backLabel="Torna ai clienti"
        title={detail.name}
        subtitle={subtitle}
        badge={<StagePill stage={detail.stage} />}
        actions={
          <div className="hidden items-center gap-2 sm:flex">
            {(callPhone || mailTo) && (
              <ContactLinks
                phone={callPhone}
                email={mailTo}
                name={primary?.full_name ?? detail.name}
                onCall={() => { setSection('cronologia'); setKind('chiamata'); }}
              />
            )}
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-3 px-4 pb-6 sm:px-6 lg:px-8">
          {detail.internal && (
            <Callout tone="info" icon={Building2}>Demo o locale interno: non entra in MRR, imbuto e clienti da seguire.</Callout>
          )}
          <SegmentedControl
            value={section}
            onChange={next => setSection(next as Section)}
            ariaLabel="Sezione della scheda"
            equalWidth={false}
            overflow="scroll"
            options={[
              { value: 'riepilogo', label: 'Riepilogo' },
              { value: 'cronologia', label: 'Cronologia' },
              { value: 'dafare', label: 'Da fare', badge: openTasks.length + detail.deals.filter(d => d.stage !== 'vinta' && d.stage !== 'persa').length || undefined, badgeTone: detail.overdue_tasks > 0 ? 'alert' : 'neutral' },
              { value: 'gestione', label: detail.customer_tenant_id ? 'Ristorante' : 'Attiva' },
            ]}
          />

          {/* Su telefono la testata non ha posto per i tasti: stanno qui. */}
          {(callPhone || mailTo) && (
            <div className="flex gap-2 sm:hidden">
              <ContactLinks
                phone={callPhone}
                email={mailTo}
                name={primary?.full_name ?? detail.name}
                onCall={() => { setSection('cronologia'); setKind('chiamata'); }}
              />
            </div>
          )}

          {section === 'riepilogo' && (
            <>
              <CrmCard title="Fase">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className={`${dsSelect} w-auto min-w-[180px]`}
                    value={pendingStage ?? detail.stage}
                    onChange={e => changeStage(e.target.value as CrmStage)}
                    disabled={busy === 'stage'}
                    aria-label="Fase"
                  >
                    {CRM_STAGES.map(s => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                  </select>
                  <span className="text-[13px] text-[var(--ds-text-muted)]">da {relativeTime(detail.stage_changed_at)}</span>
                </div>
                {pendingStage && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3">
                    <input
                      className={`${dsInput} min-w-[200px] flex-1 bg-[var(--ds-surface)]`}
                      placeholder="Motivo (prezzo, tempi, concorrente…)"
                      aria-label="Motivo"
                      value={lostReason}
                      autoFocus
                      onChange={e => setLostReason(e.target.value)}
                    />
                    <button type="button" className={dsButton.secondary} onClick={() => setPendingStage(null)}>Annulla</button>
                    <button
                      type="button"
                      className={dsButton.primary}
                      onClick={async () => {
                        const stage = pendingStage;
                        setPendingStage(null);
                        await run('stage', () => platformCrmApi.updateAccount(detail.id, { stage, lost_reason: lostReason.trim() || null }), `Fase: ${STAGE_LABEL[stage]}`);
                      }}
                    >
                      Segna {STAGE_LABEL[pendingStage].toLowerCase()}
                    </button>
                  </div>
                )}
                {(detail.stage === 'perso' || detail.stage === 'disdetto') && detail.lost_reason && !pendingStage && (
                  <p className="mt-2 text-[14px] text-[var(--ds-text-secondary)]">Motivo: {detail.lost_reason}</p>
                )}
              </CrmCard>

              {health && (
                <CrmCard title="Salute" action={<HealthPill health={health} />}>
                  {health.signals.length > 0 ? (
                    <ul className="mb-3 space-y-1">
                      {health.signals.map(s => (
                        <li key={s} className="flex items-start gap-2 text-[14px] text-[var(--ds-text-primary)]">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--ds-pending-text)]" aria-hidden />{s}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mb-3 text-[14px] text-[var(--ds-text-secondary)]">Nessun segnale negativo.</p>
                  )}
                  <Facts items={[
                    ['Ultimo accesso', health.metrics.last_seen_at ? relativeTime(health.metrics.last_seen_at) : 'mai'],
                    ['Attivi negli ultimi 7 giorni', `${health.metrics.active_users_7d} su ${health.metrics.users}`],
                    ['Prenotazioni in 30 giorni', `${health.metrics.reservations_30d} (prima ${health.metrics.reservations_prev_30d})`],
                    ['Chiamate di Sofia in 30 giorni', detail.tenant?.features.includes('voice') ? health.metrics.voice_calls_30d : null],
                    ['Richieste di supporto aperte', health.metrics.open_tickets || null],
                    ['Avvisi aperti', health.metrics.open_alerts || null],
                  ]} />
                </CrmCard>
              )}

              <CrmCard
                title="Canone"
                action={bp ? <StatusPill tone={bp.tone}>{bp.label}</StatusPill> : undefined}
              >
                <p className="text-[24px] font-semibold tabular-nums tracking-[-0.01em] text-[var(--ds-text-primary)]">
                  {eur(detail.mrr_cents || detail.expected_mrr_cents || 0)}
                  <span className="text-[14px] font-normal text-[var(--ds-text-muted)]">/mese</span>
                </p>
                <p className="mb-3 text-[13px] text-[var(--ds-text-muted)]">
                  {detail.mrr_source === 'stripe' ? 'da Stripe'
                    : detail.mrr_source === 'accordo' ? 'accordato, senza Stripe'
                    : detail.expected_mrr_cents ? 'atteso' : 'non indicato'}
                </p>
                <Facts items={[
                  ['Fine prova', billing?.trial_end ? formatDay(billing.trial_end.slice(0, 10)) : null],
                  [billing?.cancel_at_period_end ? 'Si chiude il' : 'Prossimo rinnovo Stripe', billing?.current_period_end ? formatDay(billing.current_period_end.slice(0, 10)) : null],
                  ['Inizio contratto', detail.contract_start ? formatDay(detail.contract_start) : null],
                  ['Rinnovo', detail.renewal_date ? formatDay(detail.renewal_date) : null],
                  ['Opportunità aperte', detail.open_deals ? `${detail.open_deals} · ${eur(detail.open_deals_mrr_cents)}/mese` : null],
                ]} />
              </CrmCard>

              <CrmCard
                title="Azienda"
                action={<button type="button" className={`${dsButton.quiet} h-9 px-3 text-[13px]`} onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" aria-hidden />Modifica</button>}
              >
                <Facts items={[
                  ['Tipo', detail.business_type],
                  ['Città', detail.city],
                  ['Indirizzo', detail.address],
                  ['Telefono', detail.phone ? <a className="underline underline-offset-4" href={telHref(detail.phone)}>{detail.phone}</a> : null],
                  ['Email', detail.email ? <a className="underline underline-offset-4" href={`mailto:${detail.email}`}>{detail.email}</a> : null],
                  ['Sito', detail.website ? <a className="inline-flex items-center gap-1 underline underline-offset-4" href={/^https?:\/\//.test(detail.website) ? detail.website : `https://${detail.website}`} target="_blank" rel="noreferrer">{detail.website.replace(/^https?:\/\//, '')}<ExternalLink className="h-3 w-3" aria-hidden /></a> : null],
                  ['Coperti', detail.seats],
                  ['Sedi', detail.locations],
                  ['Da dove arriva', detail.source],
                  ['Cosa usa oggi', detail.current_software],
                  ['Ragione sociale', detail.legal_name],
                  ['Partita IVA', detail.vat_number],
                  ['Codice SDI', detail.sdi_code],
                  ['PEC', detail.pec],
                ]} />
                {detail.tags.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {detail.tags.map(t => <StatusPill key={t}>{t}</StatusPill>)}
                  </div>
                )}
                {detail.notes && <p className="mt-3 whitespace-pre-wrap text-[14px] text-[var(--ds-text-secondary)]">{detail.notes}</p>}
              </CrmCard>

              <CrmCard
                title="Referenti"
                meta={detail.contacts.length || undefined}
                action={contactForm === null ? (
                  <button type="button" className={`${dsButton.quiet} h-9 px-3 text-[13px]`} onClick={() => setContactForm('new')}><Plus className="h-3.5 w-3.5" aria-hidden />Aggiungi</button>
                ) : undefined}
              >
                {contactForm === 'new' && (
                  <div className="mb-2">
                    <ContactForm
                      busy={busy === 'contact'}
                      onCancel={() => setContactForm(null)}
                      onSubmit={input => run('contact', async () => {
                        const next = await platformCrmApi.addContact(detail.id, input);
                        setContactForm(null);
                        return next;
                      })}
                    />
                  </div>
                )}
                {detail.contacts.length === 0 && contactForm !== 'new' && (
                  <p className="text-[14px] text-[var(--ds-text-muted)]">Nessun referente.</p>
                )}
                <ul className="-mx-1 divide-y divide-[var(--ds-border)]">
                  {detail.contacts.map(c => (
                    <li key={c.id} className="px-1 py-2">
                      {contactForm === c.id ? (
                        <ContactForm
                          initial={c}
                          busy={busy === 'contact'}
                          onCancel={() => setContactForm(null)}
                          onSubmit={input => run('contact', async () => {
                            const next = await platformCrmApi.updateContact(c.id, input);
                            setContactForm(null);
                            return next;
                          })}
                        />
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-1.5 text-[15px] font-medium text-[var(--ds-text-primary)]">
                              <span className="truncate">{c.full_name}</span>
                              {c.is_primary && detail.contacts.length > 1 && <Star className="h-3.5 w-3.5 flex-shrink-0 fill-current text-[var(--ds-pending-text)]" aria-label="principale" />}
                            </p>
                            <p className="truncate text-[13px] text-[var(--ds-text-muted)]">
                              {[c.role, c.phone, c.email].filter(Boolean).join(' · ') || '—'}
                            </p>
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-1.5">
                            <ContactLinks phone={c.phone} email={c.email} name={c.full_name} onCall={() => { setSection('cronologia'); setKind('chiamata'); setNoteContact(String(c.id)); }} />
                            {!c.is_primary && (
                              <button type="button" className={dsIconButton} aria-label={`Rendi principale ${c.full_name}`} onClick={() => run('contact', () => platformCrmApi.updateContact(c.id, { is_primary: true }))}>
                                <Star className="h-4 w-4" aria-hidden />
                              </button>
                            )}
                            <button type="button" className={dsIconButton} aria-label={`Modifica ${c.full_name}`} onClick={() => setContactForm(c.id)}>
                              <Pencil className="h-4 w-4" aria-hidden />
                            </button>
                            <button
                              type="button"
                              className={armed === `c${c.id}` ? `${dsButton.critical} h-11 px-3` : dsIconButton}
                              aria-label={`Elimina ${c.full_name}`}
                              onClick={() => (armed === `c${c.id}` ? run('contact', () => platformCrmApi.deleteContact(c.id)) : setArmed(`c${c.id}`))}
                            >
                              <Trash2 className="h-4 w-4" aria-hidden />{armed === `c${c.id}` && 'Conferma'}
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </CrmCard>

              {(detail.customer_tenant_id || detail.stage === 'prova' || detail.stage === 'cliente') && (
                <CrmCard title="Avviamento" meta={`${onboardingDone}/${detail.onboarding_steps.length}`}>
                  <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-[var(--ds-surface-row)]" aria-hidden>
                    <div className="h-full rounded-full bg-[var(--ds-seated-solid)]" style={{ width: `${(onboardingDone / Math.max(1, detail.onboarding_steps.length)) * 100}%` }} />
                  </div>
                  <ul className="-mx-1">
                    {detail.onboarding_steps.map(step => (
                      <li key={step.key}>
                        <button
                          type="button"
                          disabled={step.auto || busy === 'onboarding'}
                          onClick={() => run('onboarding', () => platformCrmApi.updateAccount(detail.id, { onboarding: { [step.key]: !step.done } }))}
                          aria-pressed={step.done}
                          className="flex min-h-[44px] w-full items-center gap-3 rounded-[var(--ds-radius-sm)] px-1 text-left transition-colors enabled:hover:bg-[var(--ds-surface-row)] disabled:cursor-default"
                        >
                          <span className={`inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-sm)] ring-1 ring-inset ${step.done ? 'bg-[var(--ds-seated-solid)] text-[var(--ds-seated-fg)] ring-[var(--ds-seated-solid)]' : 'ring-[var(--ds-border-strong)]'}`}>
                            {step.done && <Check className="h-3.5 w-3.5" aria-hidden />}
                          </span>
                          <span className={`min-w-0 flex-1 text-[14px] ${step.done ? 'text-[var(--ds-text-secondary)]' : 'text-[var(--ds-text-primary)]'}`}>{step.label}</span>
                          <span className="flex-shrink-0 text-[12px] text-[var(--ds-text-muted)]">
                            {step.auto ? 'rilevato' : ''}{step.done_at ? `${step.auto ? ' · ' : ''}${formatDay(step.done_at.slice(0, 10))}` : ''}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </CrmCard>
              )}

              {!detail.customer_tenant_id && (
                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    className={armed === 'delete' ? dsButton.critical : dsButton.quiet}
                    onClick={() => {
                      if (armed !== 'delete') { setArmed('delete'); return; }
                      run('delete', async () => {
                        await platformCrmApi.deleteAccount(detail.id);
                        onDeleted(detail.id);
                      }, 'Scheda eliminata');
                    }}
                    disabled={busy === 'delete'}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />{armed === 'delete' ? 'Conferma eliminazione' : 'Elimina scheda'}
                  </button>
                </div>
              )}
            </>
          )}

          {section === 'cronologia' && (
            <>
              <section className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)] sm:p-4">
                <SegmentedControl
                  value={kind}
                  onChange={next => setKind(next as CrmActivityKind)}
                  ariaLabel="Tipo di attività"
                  equalWidth={false}
                  overflow="scroll"
                  size="sm"
                  options={CRM_ACTIVITY_KINDS.map(k => ({ value: k, label: ACTIVITY_LABEL[k] }))}
                />
                <textarea
                  className={`${dsTextarea} mt-2 min-h-[88px]`}
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder={kind === 'chiamata' ? 'Com\'è andata la chiamata?' : kind === 'demo' ? 'Cosa ha visto, cosa ha chiesto…' : 'Cosa è successo…'}
                  aria-label="Testo dell'attività"
                />
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {detail.contacts.length > 0 ? (
                    <Field label="Con chi" htmlFor="crm-who" className="[&_label]:text-[12px]">
                      <select id="crm-who" className={dsSelect} value={noteContact} onChange={e => setNoteContact(e.target.value)}>
                        <option value="">—</option>
                        {detail.contacts.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
                      </select>
                    </Field>
                  ) : <span className="hidden sm:block" />}
                  <Field label="Quando" htmlFor="crm-when" className="[&_label]:text-[12px]">
                    <input id="crm-when" type="datetime-local" className={dsInput} value={noteWhen} onChange={e => setNoteWhen(e.target.value)} />
                  </Field>
                  <Field label="Ricontattare il" htmlFor="crm-follow" className="[&_label]:text-[12px]">
                    <input id="crm-follow" type="date" className={dsInput} min={todayRome()} value={followUp} onChange={e => setFollowUp(e.target.value)} />
                  </Field>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex gap-1.5">
                    <button type="button" className={`${dsButton.secondary} h-9 px-3 text-[13px]`} onClick={() => setFollowUp(addDaysIso(todayRome(), 2))}>fra 2 g</button>
                    <button type="button" className={`${dsButton.secondary} h-9 px-3 text-[13px]`} onClick={() => setFollowUp(addDaysIso(todayRome(), 7))}>fra 7 g</button>
                  </div>
                  <button type="button" className={dsButton.primary} onClick={logActivity} disabled={!note.trim() || busy === 'note'}>
                    {busy === 'note' ? 'Registro…' : 'Registra'}
                  </button>
                </div>
              </section>

              {detail.timeline.length === 0 ? (
                <p className="px-1 text-[14px] text-[var(--ds-text-muted)]">Ancora niente in cronologia.</p>
              ) : (
                <ol className="space-y-1.5">
                  {detail.timeline.map(item => {
                    const Icon = ACTIVITY_ICON[item.kind] ?? ACTIVITY_ICON.nota;
                    const system = item.kind === 'sistema' || item.kind === 'supporto' || item.kind === 'avviso';
                    return (
                      <li
                        key={item.id}
                        className={`flex gap-3 rounded-[var(--ds-radius)] px-3.5 py-3 ${system ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]'}`}
                      >
                        <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] text-[var(--ds-text-muted)]">
                            <span className="font-medium text-[var(--ds-text-secondary)]">{ACTIVITY_LABEL[item.kind]}</span>
                            {' · '}{formatInstant(item.occurred_at)}
                            {item.contact_name ? ` · con ${item.contact_name}` : ''}
                            {item.author_name && !system ? ` · ${item.author_name}` : ''}
                          </p>
                          <p className={`whitespace-pre-wrap break-words ${system ? 'text-[13px] text-[var(--ds-text-secondary)]' : 'text-[15px] text-[var(--ds-text-primary)]'}`}>{item.body}</p>
                        </div>
                        {item.activity_id !== null && (
                          <button
                            type="button"
                            className={armed === item.id ? `${dsButton.critical} h-9 px-3 text-[13px]` : 'inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]'}
                            aria-label="Elimina attività"
                            onClick={() => (armed === item.id ? run('activity', () => platformCrmApi.deleteActivity(item.activity_id!)) : setArmed(item.id))}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />{armed === item.id && 'Conferma'}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          )}

          {section === 'dafare' && (
            <>
              <CrmCard title="Promemoria" meta={openTasks.length || undefined}>
                <NewTaskForm accountId={detail.id} onCreated={task => taskChanged(task)} showToast={showToast} />
                {openTasks.length > 0 && (
                  <ul className="-mx-3 mt-2 divide-y divide-[var(--ds-border)]">
                    {openTasks.map(t => <TaskRow key={t.id} task={t} showAccount={false} onChanged={taskChanged} showToast={showToast} />)}
                  </ul>
                )}
                {doneTasks.length > 0 && (
                  <details className="mt-2">
                    <summary className="flex min-h-[44px] cursor-pointer items-center text-[13px] font-medium text-[var(--ds-text-muted)]">Fatti ({doneTasks.length})</summary>
                    <ul className="-mx-3 divide-y divide-[var(--ds-border)]">
                      {doneTasks.map(t => <TaskRow key={t.id} task={t} showAccount={false} onChanged={taskChanged} showToast={showToast} />)}
                    </ul>
                  </details>
                )}
              </CrmCard>

              <CrmCard
                title="Opportunità"
                meta={detail.deals.length || undefined}
                action={<button type="button" className={`${dsButton.quiet} h-9 px-3 text-[13px]`} onClick={() => setDealModal('new')}><Plus className="h-3.5 w-3.5" aria-hidden />Nuova</button>}
              >
                {detail.deals.length === 0 ? (
                  <p className="text-[14px] text-[var(--ds-text-muted)]">Nessuna opportunità.</p>
                ) : (
                  <ul className="-mx-3 divide-y divide-[var(--ds-border)]">
                    {detail.deals.map(d => (
                      <li key={d.id}>
                        <button type="button" onClick={() => setDealModal(d)} className="flex min-h-[44px] w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--ds-surface-row)]">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{d.title}</span>
                            <span className="block truncate text-[13px] text-[var(--ds-text-muted)]">
                              {DEAL_KIND_LABEL[d.kind]} · {eur(d.mrr_cents)}/mese
                              {d.stage !== 'vinta' && d.stage !== 'persa' ? ` · ${d.effective_probability}%` : ''}
                              {d.expected_close && d.stage !== 'vinta' && d.stage !== 'persa' ? ` · entro ${formatDay(d.expected_close)}` : ''}
                            </span>
                          </span>
                          <StatusPill tone={d.stage === 'vinta' ? 'positive' : d.stage === 'persa' ? 'neutral' : 'info'}>{DEAL_STAGE_LABEL[d.stage]}</StatusPill>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </CrmCard>
            </>
          )}

          {section === 'gestione' && (
            detail.customer_tenant_id ? (
              tenant ? (
                <TenantCard
                  tenant={tenant}
                  onPatched={onTenantPatched}
                  onRevert={onTenantPatched}
                  showToast={showToast}
                  embedded
                />
              ) : (
                <div className="flex h-32 items-center justify-center"><Loader /></div>
              )
            ) : (
              <CrmCard title="Ristorante su Sympotia">
                <p className="mb-3 text-[14px] text-[var(--ds-text-secondary)]">
                  Questa azienda non ha ancora un ristorante. Crealo da qui: nasce legato alla scheda e la fase passa a «in prova».
                </p>
                <button type="button" className={dsButton.primary} onClick={() => setProvisioning(true)}>
                  <Plus className="h-4 w-4" aria-hidden />Crea il ristorante
                </button>
                {tenants.length > 0 && (
                  <div className="mt-4 border-t border-[var(--ds-border)] pt-4">
                    <p className="mb-2 text-[13px] text-[var(--ds-text-muted)]">Oppure collegalo a uno che esiste già</p>
                    <div className="flex flex-wrap gap-2">
                      <select className={`${dsSelect} w-auto min-w-[200px] flex-1`} value={linkTenant} onChange={e => setLinkTenant(e.target.value)} aria-label="Ristorante">
                        <option value="">Scegli…</option>
                        {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                      <button
                        type="button"
                        className={dsButton.secondary}
                        disabled={!linkTenant || busy === 'link'}
                        onClick={() => run('link', () => platformCrmApi.linkTenant(detail.id, Number(linkTenant)), 'Ristorante collegato')}
                      >
                        Collega
                      </button>
                    </div>
                  </div>
                )}
              </CrmCard>
            )
          )}
        </div>
      </div>

      <AccountFormModal open={editing} onClose={() => setEditing(false)} account={detail} onSaved={apply} />
      <DealFormModal
        open={dealModal !== null}
        onClose={() => setDealModal(null)}
        deal={dealModal === 'new' ? null : dealModal}
        accountId={detail.id}
        onSaved={() => load()}
        showToast={showToast}
      />
      <NewTenantModal
        open={provisioning}
        onClose={() => setProvisioning(false)}
        onCreated={() => { onTenantsChanged(); load(); }}
        showToast={showToast}
        initialName={detail.name}
        initialEmail={primary?.email || detail.email || ''}
        crmAccountId={detail.id}
      />
    </>
  );
};

export default PlatformCrmAccountDetail;
