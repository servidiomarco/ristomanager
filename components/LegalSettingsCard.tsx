import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Scale, Save, Loader2, Copy, Check, Download, FileText, Phone, Cookie, ScrollText, ChevronDown,
  ShieldCheck, Megaphone,
} from 'lucide-react';
import { CookingPotLoader } from './CookingPotLoader';
import { getLegalSettings, updateLegalSettings, type LegalSettings } from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const EMPTY: LegalSettings = {
  legal_mode: 'advanced',
  company_name: '', company_address: '', vat_number: '', fiscal_code: '',
  privacy_email: '', privacy_phone: '', dpo_name: '', dpo_contact: '',
  website_url: '', app_name: 'RistoManager', voice_business_name: '',
  data_processors: '', retention_customer: '', retention_calls: '',
  retention_marketing: '', extra_eu_note: '', governing_law: '', last_updated: '',
  uses_analytics_cookies: false, records_calls: true, ask_health_consent: true,
};

// ---------------------------------------------------------------------------
// Document generators — pure functions that template the legal texts from the
// tenant's data. Empty required fields fall back to a bracketed placeholder so
// the operator immediately sees what still needs to be filled in.
// ---------------------------------------------------------------------------
const ph = (v: string, placeholder: string) => (v && v.trim() ? v.trim() : `[${placeholder}]`);

const titolareBlock = (s: LegalSettings): string => {
  const lines = [
    `${ph(s.company_name, 'Ragione sociale')}`,
    `Sede: ${ph(s.company_address, 'Indirizzo completo')}`,
    `P.IVA: ${ph(s.vat_number, 'Partita IVA')}${s.fiscal_code ? ` — C.F.: ${s.fiscal_code}` : ''}`,
    `E-mail privacy: ${ph(s.privacy_email, 'E-mail privacy')}${s.privacy_phone ? ` — Tel.: ${s.privacy_phone}` : ''}`,
  ];
  if (s.dpo_name || s.dpo_contact) {
    lines.push(`Responsabile della protezione dei dati (DPO): ${[s.dpo_name, s.dpo_contact].filter(Boolean).join(' — ')}`);
  }
  return lines.join('\n');
};

const dateLine = (s: LegalSettings) =>
  `Ultimo aggiornamento: ${s.last_updated && s.last_updated.trim() ? s.last_updated.trim() : new Date().toLocaleDateString('it-IT')}`;

export function genPrivacyPolicy(s: LegalSettings): string {
  const app = ph(s.app_name, 'Nome app');
  const adv = s.legal_mode !== 'simple';
  const facolt = ['i dati sulle allergie'];
  if (s.records_calls) facolt.push('il consenso alla registrazione delle chiamate');
  if (adv) facolt.push('il consenso al marketing');
  const facoltList = facolt.length > 1
    ? `${facolt.slice(0, -1).join(', ')} e ${facolt[facolt.length - 1]}`
    : facolt[0];
  return `INFORMATIVA SUL TRATTAMENTO DEI DATI PERSONALI
Clienti e prenotazioni — ${app}
Resa ai sensi degli artt. 13-14 del Reg. (UE) 2016/679 (GDPR) e del D.Lgs. 196/2003 (come mod. dal D.Lgs. 101/2018)
${dateLine(s)}

1. TITOLARE DEL TRATTAMENTO
${titolareBlock(s)}

2. CATEGORIE DI DATI TRATTATI
- Dati identificativi e di contatto: nome, telefono, e-mail.
- Dati di recapito: indirizzo, città, CAP (per eventi e banchetti).
- Preferenze e note di servizio: tavolo preferito, preferenze, stato "VIP", note.
- Dati relativi alla salute (categoria particolare, art. 9 GDPR): allergie e intolleranze, conferiti volontariamente per la sicurezza alimentare.
- Storico del rapporto: prenotazioni, banchetti, mancate presentazioni (no-show).
${s.records_calls ? '- Registrazioni e trascrizioni delle chiamate gestite dall\'assistente vocale.\n' : ''}- Comunicazioni inviate (es. WhatsApp / e-mail) per conferme e promemoria${adv ? ' e, previo consenso, comunicazioni commerciali' : ''}.

3. FINALITÀ E BASE GIURIDICA
- Gestione della prenotazione e del servizio — esecuzione del contratto (art. 6.1.b).
- Gestione di allergie/intolleranze — consenso esplicito (art. 9.2.a).
${s.records_calls ? '- Registrazione e trascrizione delle chiamate — consenso, comunicato all\'inizio della chiamata (art. 6.1.a).\n' : ''}- Conferme e promemoria di prenotazione — esecuzione del contratto (art. 6.1.b).
${adv ? '- Comunicazioni commerciali (marketing) — consenso revocabile (art. 6.1.a).\n' : ''}- Monitoraggio dei no-show e prevenzione abusi — legittimo interesse (art. 6.1.f).
- Adempimenti di legge (fiscali/contabili) — obbligo legale (art. 6.1.c).

4. NATURA DEL CONFERIMENTO
Il conferimento dei dati di contatto è necessario per gestire la prenotazione. Sono invece facoltativi ${facoltList}; il rifiuto non pregiudica la prenotazione ma può limitare i relativi servizi.

5. DESTINATARI E RESPONSABILI DEL TRATTAMENTO
I dati possono essere trattati, per conto del Titolare e sulla base di accordi ex art. 28 GDPR, dai seguenti fornitori:
${s.data_processors && s.data_processors.trim()
    ? s.data_processors.trim().split('\n').map(l => `- ${l.trim()}`).join('\n')
    : '- [Elencare i fornitori: hosting, assistente vocale, messaggistica, provider e-mail, ...]'}
I dati non sono diffusi. Possono essere comunicati ad autorità competenti ove previsto dalla legge.

6. TRASFERIMENTI EXTRA-UE
${s.extra_eu_note && s.extra_eu_note.trim()
    ? s.extra_eu_note.trim()
    : 'Alcuni fornitori possono trattare i dati fuori dallo Spazio Economico Europeo (anche negli USA). In tali casi il trasferimento avviene sulla base di garanzie adeguate ex artt. 44 ss. GDPR (Data Privacy Framework UE-USA o Clausole Contrattuali Standard).'}

7. PERIODO DI CONSERVAZIONE
- Dati cliente e storico prenotazioni: ${ph(s.retention_customer, 'es. 24 mesi dall\'ultima interazione')}.
${s.records_calls ? `- Registrazioni delle chiamate: ${ph(s.retention_calls, 'es. 6 mesi')}.\n` : ''}${adv ? `- Dati per marketing: ${ph(s.retention_marketing, 'fino a revoca del consenso')}.\n` : ''}- Dati con obbligo fiscale: 10 anni.

8. DIRITTI DELL'INTERESSATO
Puoi esercitare i diritti ex artt. 15-22 GDPR (accesso, rettifica, cancellazione, limitazione, portabilità, opposizione) e revocare il consenso in ogni momento scrivendo a ${ph(s.privacy_email, 'E-mail privacy')}. Hai inoltre diritto di reclamo al Garante per la protezione dei dati personali (www.garanteprivacy.it).`;
}

export function genVoiceNotice(s: LegalSettings): string {
  const biz = s.voice_business_name && s.voice_business_name.trim()
    ? s.voice_business_name.trim()
    : (s.company_name && s.company_name.trim() ? s.company_name.trim() : '[Nome attività]');
  if (s.records_calls) {
    return `Salve, e benvenuto a ${biz}. La chiamata è gestita da un assistente vocale automatico e può essere registrata e trascritta per gestire la Sua richiesta di prenotazione e migliorare il servizio, nel rispetto della normativa sulla protezione dei dati (Reg. UE 2016/679). Proseguendo con la conversazione acconsente alla registrazione; se preferisce non essere registrato può riagganciare e contattarci di persona. Trova l'informativa completa su ${ph(s.website_url, 'sito web')}. Come posso aiutarLa?`;
  }
  return `Salve, e benvenuto a ${biz}. La chiamata è gestita da un assistente vocale automatico che tratta i Suoi dati solo per gestire la richiesta di prenotazione, nel rispetto della normativa sulla protezione dei dati (Reg. UE 2016/679). Trova l'informativa completa su ${ph(s.website_url, 'sito web')}. Come posso aiutarLa?`;
}

export function genCookiePolicy(s: LegalSettings): string {
  const app = ph(s.app_name, 'Nome app');
  return `COOKIE POLICY — ${app}
${dateLine(s)}

Titolare: ${ph(s.company_name, 'Ragione sociale')} — ${ph(s.privacy_email, 'E-mail privacy')}
Sito: ${ph(s.website_url, 'sito web')}

1. COSA SONO I COOKIE
I cookie sono piccoli file di testo che i siti visitati inviano al dispositivo dell'utente, dove vengono memorizzati per essere ritrasmessi agli stessi siti alla visita successiva.

2. COOKIE TECNICI (sempre attivi)
Necessari al funzionamento del sito e del servizio di prenotazione. Non richiedono consenso (art. 122 D.Lgs. 196/2003).

3. COOKIE ANALITICI E DI TERZE PARTI
${s.uses_analytics_cookies
    ? 'Il sito utilizza cookie analitici e/o di terze parti per misurare l\'utilizzo e migliorare il servizio. Questi cookie vengono installati solo previo consenso, prestato tramite il banner o le impostazioni.'
    : 'Il sito NON utilizza cookie analitici o di profilazione di terze parti. Vengono impiegati esclusivamente cookie tecnici.'}

4. GESTIONE DEL CONSENSO
Puoi modificare o revocare le tue preferenze in ogni momento tramite il banner o le impostazioni del browser.

5. TITOLARE E CONTATTI
Per informazioni sul trattamento dei dati scrivi a ${ph(s.privacy_email, 'E-mail privacy')}. Vedi anche l'informativa privacy completa.`;
}

export function genCookieBanner(s: LegalSettings): string {
  if (s.uses_analytics_cookies) {
    return `Questo sito utilizza cookie tecnici necessari al funzionamento e, previo consenso, cookie analitici e di terze parti per migliorare il servizio. Cliccando "Accetta" acconsenti; cliccando "Rifiuta" resteranno attivi solo i cookie tecnici. Maggiori informazioni nella Cookie Policy.  [Accetta]  [Rifiuta]  [Preferenze]`;
  }
  return `Questo sito utilizza esclusivamente cookie tecnici necessari al funzionamento e alla gestione delle prenotazioni. Non è richiesto il consenso. Maggiori informazioni nella Cookie Policy.  [Ho capito]`;
}

export function genTerms(s: LegalSettings): string {
  const app = ph(s.app_name, 'Nome app');
  return `TERMINI E CONDIZIONI DI SERVIZIO — ${app}
${dateLine(s)}

Titolare: ${ph(s.company_name, 'Ragione sociale')}, ${ph(s.company_address, 'Indirizzo')} — P.IVA ${ph(s.vat_number, 'Partita IVA')}.
Contatti: ${ph(s.privacy_email, 'E-mail')}${s.privacy_phone ? ` — ${s.privacy_phone}` : ''}.

1. OGGETTO
Le presenti condizioni disciplinano l'utilizzo del servizio di prenotazione e dei servizi correlati offerti da ${ph(s.company_name, 'Ragione sociale')}.

2. PRENOTAZIONI
La prenotazione si intende confermata al ricevimento della relativa conferma. Il cliente si impegna a fornire dati veritieri e a comunicare tempestivamente eventuali variazioni o cancellazioni.

3. CANCELLAZIONI, RITARDI E MANCATE PRESENTAZIONI (NO-SHOW)
In caso di mancata presentazione o cancellazione tardiva, il Titolare può applicare le condizioni indicate al momento della prenotazione (es. trattenimento dell'eventuale caparra). Il tavolo può essere riassegnato dopo [__] minuti di ritardo non comunicato.

4. CAPARRA / ACCONTO
Per determinate prenotazioni può essere richiesto un acconto o una caparra confirmatoria, secondo quanto comunicato al momento della prenotazione.

5. RESPONSABILITÀ E ALLERGIE
Il cliente è tenuto a comunicare eventuali allergie o intolleranze. Il Titolare adotta le misure ragionevoli ma non può garantire l'assenza assoluta di contaminazioni crociate.

6. TRATTAMENTO DEI DATI
Il trattamento dei dati personali è disciplinato dall'informativa privacy, che costituisce parte integrante delle presenti condizioni.

7. LEGGE APPLICABILE E FORO
${s.governing_law && s.governing_law.trim()
    ? s.governing_law.trim()
    : 'Le presenti condizioni sono regolate dalla legge italiana. Per ogni controversia è competente il foro del luogo in cui ha sede il Titolare, salvo il foro del consumatore ove applicabile.'}`;
}

type DocKey = 'privacy' | 'voice' | 'cookie' | 'banner' | 'terms';
const DOC_TABS: { key: DocKey; label: string; Icon: React.ComponentType<{ className?: string }>; gen: (s: LegalSettings) => string; file: string }[] = [
  { key: 'privacy', label: 'Privacy Policy', Icon: FileText, gen: genPrivacyPolicy, file: 'privacy-policy.txt' },
  { key: 'voice', label: 'Avviso vocale', Icon: Phone, gen: genVoiceNotice, file: 'avviso-vocale.txt' },
  { key: 'cookie', label: 'Cookie Policy', Icon: Cookie, gen: genCookiePolicy, file: 'cookie-policy.txt' },
  { key: 'banner', label: 'Banner cookie', Icon: Cookie, gen: genCookieBanner, file: 'cookie-banner.txt' },
  { key: 'terms', label: 'Termini di Servizio', Icon: ScrollText, gen: genTerms, file: 'termini-di-servizio.txt' },
];

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const inputCls =
  'w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)] disabled:opacity-60';

const Field: React.FC<{
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
  disabled?: boolean; textarea?: boolean; hint?: string; wide?: boolean;
}> = ({ label, value, onChange, placeholder, disabled, textarea, hint, wide }) => (
  <div className={wide ? 'sm:col-span-2' : ''}>
    <label className="block text-[13px] font-medium text-[var(--color-fg)] mb-1">{label}</label>
    {textarea ? (
      <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        disabled={disabled} rows={3} className={`${inputCls} resize-y`} />
    ) : (
      <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        disabled={disabled} className={inputCls} />
    )}
    {hint && <p className="text-[12px] text-[var(--color-fg-muted)] mt-1">{hint}</p>}
  </div>
);

export const LegalSettingsCard: React.FC<Props> = ({ showToast }) => {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');

  const [data, setData] = useState<LegalSettings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [activeDoc, setActiveDoc] = useState<DocKey>('privacy');
  const [copied, setCopied] = useState(false);

  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await getLegalSettings();
        if (!cancelled) setData({ ...EMPTY, ...d, app_name: d.app_name || 'RistoManager' });
      } catch {
        if (!cancelled) showToastRef.current('Impossibile caricare le impostazioni legali', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const set = (k: keyof LegalSettings) => (v: string) => setData(d => ({ ...d, [k]: v }));
  const setBool = (k: keyof LegalSettings) => (v: boolean) => setData(d => ({ ...d, [k]: v }));

  const handleSave = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      const payload: LegalSettings = { ...data, last_updated: new Date().toLocaleDateString('it-IT') };
      const saved = await updateLegalSettings(payload);
      setData({ ...EMPTY, ...saved });
      showToast('Impostazioni legali salvate', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore durante il salvataggio', 'error');
    } finally {
      setSaving(false);
    }
  };

  // In "simple" mode only the strict-minimum documents are surfaced; the
  // marketing/cookie/terms extras belong to "advanced".
  const isAdvanced = data.legal_mode !== 'simple';
  const visibleDocs = isAdvanced ? DOC_TABS : DOC_TABS.filter(t => t.key === 'privacy' || t.key === 'voice');
  const currentDoc = visibleDocs.find(t => t.key === activeDoc) ?? visibleDocs[0];
  const generatedText = useMemo(() => currentDoc.gen(data), [currentDoc, data]);

  const setMode = (mode: 'simple' | 'advanced') => setData(d => ({ ...d, legal_mode: mode }));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(generatedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      showToast('Copia non riuscita', 'error');
    }
  };

  const download = () => {
    const blob = new Blob([generatedText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = currentDoc.file;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <details className="group bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden"
      open={expanded} onToggle={e => setExpanded((e.target as HTMLDetailsElement).open)}>
      <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--color-surface-2)] transition-colors">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center text-[var(--color-fg)] flex-shrink-0">
            <Scale className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h4 className="font-medium text-[14px] text-[var(--color-fg)]">Documenti legali</h4>
            <p className="text-[13px] text-[var(--color-fg-muted)]">Compila i dati del titolare per generare privacy policy, avviso vocale, cookie policy e termini di servizio.</p>
          </div>
        </div>
        <ChevronDown className="w-5 h-5 text-[var(--color-fg-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
      </summary>

      <div className="px-4 pb-4 pt-1 border-t border-[var(--color-line)]">
        {loading ? (
          <div className="py-10 flex justify-center"><CookingPotLoader label="Carico…" size={40} /></div>
        ) : (
          <>
            {!canEdit && (
              <div className="mb-4 text-[13px] text-[var(--color-fg-muted)] bg-[var(--color-surface-2)] rounded-lg p-3">
                Solo in lettura: la modifica richiede il permesso di gestione impostazioni.
              </div>
            )}

            {/* ---------- Legal mode toggle ---------- */}
            <div className="mb-6">
              <h5 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-2">Modalità</h5>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => setMode('simple')}
                  className={`text-left rounded-xl border p-3 transition-colors disabled:opacity-60 ${
                    !isAdvanced ? 'border-[var(--color-fg)] bg-[var(--color-surface-2)]' : 'border-[var(--color-line)] hover:bg-[var(--color-surface-2)]'
                  }`}
                >
                  <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
                    <ShieldCheck className="h-4 w-4" /> Semplice
                    {!isAdvanced && <Check className="h-3.5 w-3.5 text-emerald-600 ml-auto" />}
                  </div>
                  <p className="text-[12px] text-[var(--color-fg-muted)] mt-1">Solo il minimo richiesto dalla legge. Nessun marketing né trattamenti non strettamente necessari.</p>
                </button>
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => setMode('advanced')}
                  className={`text-left rounded-xl border p-3 transition-colors disabled:opacity-60 ${
                    isAdvanced ? 'border-[var(--color-fg)] bg-[var(--color-surface-2)]' : 'border-[var(--color-line)] hover:bg-[var(--color-surface-2)]'
                  }`}
                >
                  <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
                    <Megaphone className="h-4 w-4" /> Avanzata
                    {isAdvanced && <Check className="h-3.5 w-3.5 text-emerald-600 ml-auto" />}
                  </div>
                  <p className="text-[12px] text-[var(--color-fg-muted)] mt-1">Include marketing, consensi, cookie analitici e termini di servizio. I clienti senza consenso restano esclusi dai flussi marketing.</p>
                </button>
              </div>
            </div>

            {/* ---------- Consenso allergie in prenotazione ---------- */}
            <div className="mt-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3">
              <label className="flex items-start gap-2.5 text-[14px] text-[var(--color-fg)] cursor-pointer">
                <input type="checkbox" checked={data.ask_health_consent} disabled={!canEdit}
                  onChange={e => setBool('ask_health_consent')(e.target.checked)} className="mt-0.5 h-4 w-4 rounded flex-shrink-0" />
                <span>
                  Chiedi il consenso al trattamento di allergie / intolleranze in prenotazione
                  <span className="block text-[12px] text-[var(--color-fg-muted)] mt-0.5">
                    Se disattivato, la casella dei dati sanitari (art. 9 GDPR) non compare nel modal prenotazione. Utile se le allergie le raccogli solo a voce al tavolo, senza registrarle nel gestionale.
                  </span>
                </span>
              </label>
            </div>

            {/* ---------- Form fields ---------- */}
            <div className="space-y-6">
              <div>
                <h5 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Identità del titolare</h5>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Ragione sociale" value={data.company_name} onChange={set('company_name')} placeholder="Ristorante Da Mario S.r.l." disabled={!canEdit} />
                  <Field label="Nome app / servizio" value={data.app_name} onChange={set('app_name')} placeholder="RistoManager" disabled={!canEdit} />
                  <Field label="Sede legale" value={data.company_address} onChange={set('company_address')} placeholder="Via Roma 1, 00100 Roma (RM)" disabled={!canEdit} wide />
                  <Field label="Partita IVA" value={data.vat_number} onChange={set('vat_number')} placeholder="IT01234567890" disabled={!canEdit} />
                  <Field label="Codice fiscale (facoltativo)" value={data.fiscal_code} onChange={set('fiscal_code')} placeholder="—" disabled={!canEdit} />
                </div>
              </div>

              <div>
                <h5 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Contatti privacy e DPO</h5>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="E-mail per richieste privacy" value={data.privacy_email} onChange={set('privacy_email')} placeholder="privacy@ristorante.it" disabled={!canEdit} />
                  <Field label="Telefono" value={data.privacy_phone} onChange={set('privacy_phone')} placeholder="+39 06 1234567" disabled={!canEdit} />
                  <Field label="DPO — nome (facoltativo)" value={data.dpo_name} onChange={set('dpo_name')} placeholder="Eliminare se non nominato" disabled={!canEdit} />
                  <Field label="DPO — contatto (facoltativo)" value={data.dpo_contact} onChange={set('dpo_contact')} placeholder="dpo@ristorante.it" disabled={!canEdit} />
                  <Field label="Sito / canale di prenotazione online" value={data.website_url} onChange={set('website_url')} placeholder="https://www.ristorante.it" disabled={!canEdit} wide />
                </div>
              </div>

              <div>
                <h5 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Fornitori e conservazione</h5>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Responsabili / fornitori (uno per riga)" value={data.data_processors} onChange={set('data_processors')} textarea wide disabled={!canEdit}
                    placeholder={'Railway (hosting)\nElevenLabs (assistente vocale)\nMeta/WhatsApp (messaggistica)\nProvider SMTP (e-mail)'} />
                  <Field label="Conservazione dati cliente" value={data.retention_customer} onChange={set('retention_customer')} placeholder="24 mesi dall'ultima interazione" disabled={!canEdit} />
                  <Field label="Conservazione registrazioni chiamate" value={data.retention_calls} onChange={set('retention_calls')} placeholder="6 mesi" disabled={!canEdit} />
                  <Field label="Conservazione dati marketing" value={data.retention_marketing} onChange={set('retention_marketing')} placeholder="fino a revoca del consenso" disabled={!canEdit} />
                  <Field label="Nota trasferimenti extra-UE (facoltativa)" value={data.extra_eu_note} onChange={set('extra_eu_note')} textarea wide disabled={!canEdit}
                    placeholder="Lascia vuoto per usare il testo standard su DPF / Clausole Contrattuali Standard." />
                </div>
              </div>

              <div>
                <h5 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Avviso vocale, cookie e termini</h5>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Nome pronunciato nell'avviso vocale" value={data.voice_business_name} onChange={set('voice_business_name')} placeholder="Ristorante Da Mario" disabled={!canEdit} />
                  <Field label="Legge applicabile / foro (facoltativo)" value={data.governing_law} onChange={set('governing_law')} placeholder="Lascia vuoto per il testo standard (legge italiana)" disabled={!canEdit} />
                </div>
                <div className="mt-3 space-y-2">
                  <label className="flex items-center gap-2.5 text-[14px] text-[var(--color-fg)] cursor-pointer">
                    <input type="checkbox" checked={data.records_calls} disabled={!canEdit}
                      onChange={e => setBool('records_calls')(e.target.checked)} className="h-4 w-4 rounded" />
                    Le chiamate vengono registrate e trascritte
                  </label>
                  {isAdvanced && (
                    <label className="flex items-center gap-2.5 text-[14px] text-[var(--color-fg)] cursor-pointer">
                      <input type="checkbox" checked={data.uses_analytics_cookies} disabled={!canEdit}
                        onChange={e => setBool('uses_analytics_cookies')(e.target.checked)} className="h-4 w-4 rounded" />
                      Il sito usa cookie analitici / di terze parti
                    </label>
                  )}
                </div>
              </div>

              {canEdit && (
                <div className="flex items-center gap-2">
                  <button onClick={handleSave} disabled={saving}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-[14px] font-medium hover:opacity-90 disabled:opacity-50">
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {saving ? 'Salvataggio…' : 'Salva'}
                  </button>
                  {data.last_updated && <span className="text-[12px] text-[var(--color-fg-muted)]">Ultimo aggiornamento: {data.last_updated}</span>}
                </div>
              )}
            </div>

            {/* ---------- Generated documents preview ---------- */}
            <div className="mt-8 pt-6 border-t border-[var(--color-line)]">
              <h5 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Documenti generati</h5>
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 mb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {visibleDocs.map(({ key, label, Icon }) => {
                  const active = currentDoc.key === key;
                  return (
                    <button key={key} onClick={() => setActiveDoc(key)}
                      className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors whitespace-nowrap ${
                        active ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                               : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'}`}>
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center justify-end gap-2 mb-2">
                <button onClick={copy} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-line)] text-[13px] text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]">
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? 'Copiato' : 'Copia'}
                </button>
                <button onClick={download} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-line)] text-[13px] text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]">
                  <Download className="h-3.5 w-3.5" />
                  Scarica
                </button>
              </div>

              <pre className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[var(--color-fg)] bg-[var(--color-bg)] border border-[var(--color-line)] rounded-lg p-4 max-h-[420px] overflow-y-auto font-[inherit]">
{generatedText}
              </pre>
              <p className="text-[12px] text-[var(--color-fg-muted)] mt-2">
                Testi generati automaticamente dai dati inseriti. I campi tra parentesi quadre non sono ancora compilati. Fai validare i testi da un consulente privacy prima della pubblicazione.
              </p>
            </div>
          </>
        )}
      </div>
    </details>
  );
};
