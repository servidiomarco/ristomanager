import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  StaffMember, StaffType,
  StaffCompensationProfile, StaffCompensationPayment,
  StaffCompensationSummary, StaffCompensationSummaryRow
} from '../types';
import {
  staffCompensationApiService, isStepUpRequired, CreateCompensationPaymentInput
} from '../services/staffCompensationApiService';
import {
  Lock, ChevronLeft, ChevronRight, Loader2, Trash2, AlertTriangle, Wallet
} from 'lucide-react';
import { ModalShell, Field, EmptyState, dsButton, dsInput, dsSelect, dsIconButton } from './ds';

// ── Compensi ─────────────────────────────────────────────────────────────
// La sezione economica del Personale. Il token step-up vive SOLO nello
// stato di questo componente: cambiare area o vista lo smonta e lo sblocco
// muore con lui — è il comportamento chiesto dal titolare, non un limite.
// Il mese selezionato invece sopravvive a un riblocco: alla riscadenza dei
// 15 minuti si ridigita la password e si riparte da dove si era.

interface StaffCompensationProps {
  staffMembers: StaffMember[];
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

const TYPE_LABELS: Record<StaffType, string> = {
  [StaffType.FISSO]: 'Fissi',
  [StaffType.STAGIONALE]: 'Stagionali',
  [StaffType.EXTRA]: 'Extra'
};
const TYPE_ORDER: StaffType[] = [StaffType.FISSO, StaffType.STAGIONALE, StaffType.EXTRA];

const METHOD_LABELS = { CONTANTI: 'Contanti', BONIFICO: 'Bonifico', ALTRO: 'Altro' } as const;

const formatEuro = (cents: number): string =>
  (cents / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });

// «1.234,56», «1234,56» e «1234.56» sono tutti importi validi: la virgola
// vince come separatore decimale quando c'è, i punti diventano migliaia.
const parseEuroToCents = (raw: string): number | null => {
  const s = raw.trim().replace(/[€\s]/g, '');
  if (!s) return null;
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
};

const centsToEuroInput = (cents: number | null | undefined): string =>
  cents == null ? '' : (cents / 100).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });

const currentMonth = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const addMonths = (month: string, delta: number): string => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const monthLabel = (month: string): string =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });

const todayIso = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

interface Grant { token: string; expiresAt: number }

export const StaffCompensation: React.FC<StaffCompensationProps> = ({ staffMembers, showToast }) => {
  const [grant, setGrant] = useState<Grant | null>(null);
  const [password, setPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const [month, setMonth] = useState(currentMonth());
  const [summary, setSummary] = useState<StaffCompensationSummary | null>(null);
  const [profiles, setProfiles] = useState<StaffCompensationProfile[]>([]);
  const [payments, setPayments] = useState<StaffCompensationPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [paymentModal, setPaymentModal] = useState<{ staffId: string; kind: 'ACCONTO' | 'SALDO' } | null>(null);
  const [overrideModal, setOverrideModal] = useState<string | null>(null);
  const [ratesModal, setRatesModal] = useState<string | null>(null);

  const passwordRef = useRef<HTMLInputElement | null>(null);

  const membersById = useMemo(() => new Map(staffMembers.map(s => [s.id, s])), [staffMembers]);
  const profilesById = useMemo(() => new Map(profiles.map(p => [p.staffId, p])), [profiles]);

  // Il riblocco chiude anche i fogli aperti: sotto password non deve
  // restare visibile nemmeno un importo a metà digitazione.
  const lock = useCallback((expired = false) => {
    setGrant(null);
    setSummary(null);
    setProfiles([]);
    setPayments([]);
    setPaymentModal(null);
    setOverrideModal(null);
    setRatesModal(null);
    if (expired) setUnlockError('Lo sblocco è scaduto: ridigita la password.');
  }, []);

  // Scadenza anticipata di qualche secondo rispetto al server: meglio un
  // prompt pulito che una richiesta partita e rimbalzata.
  useEffect(() => {
    if (!grant) return;
    const ms = Math.max(0, grant.expiresAt - Date.now() - 5000);
    const timer = window.setTimeout(() => lock(true), ms);
    return () => window.clearTimeout(timer);
  }, [grant, lock]);

  const handleApiError = useCallback((err: unknown) => {
    if (isStepUpRequired(err)) {
      lock(true);
      return;
    }
    showToast(err instanceof Error ? err.message : 'Operazione non riuscita', 'error');
  }, [lock, showToast]);

  const reload = useCallback(async (token: string, m: string) => {
    setLoading(true);
    try {
      const [summaryData, profilesData, paymentsData] = await Promise.all([
        staffCompensationApiService.getSummary(token, m),
        staffCompensationApiService.getProfiles(token),
        staffCompensationApiService.getPayments(token, m),
      ]);
      setSummary(summaryData);
      setProfiles(profilesData);
      setPayments(paymentsData);
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }, [handleApiError]);

  useEffect(() => {
    if (grant) void reload(grant.token, month);
  }, [grant, month, reload]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || unlocking) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      const result = await staffCompensationApiService.stepUp(password);
      setGrant({ token: result.stepUpToken, expiresAt: Date.now() + result.expiresIn * 1000 });
      setPassword('');
    } catch (err: any) {
      const code = err?.data?.error;
      setUnlockError(
        code === 'wrong_password' ? 'La password non è corretta.'
        : code === 'rate_limited' ? 'Troppi tentativi: riprova tra qualche minuto.'
        : 'Sblocco non riuscito, riprova.'
      );
      passwordRef.current?.focus();
    } finally {
      setUnlocking(false);
    }
  };

  // ── Schermata di sblocco ───────────────────────────────────────────────
  if (!grant) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <form onSubmit={handleUnlock} className="w-full max-w-sm rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-6 shadow-[var(--ds-shadow-card)]">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--ds-surface-row)]">
            <Lock className="h-5 w-5 text-[var(--ds-text-secondary)]" aria-hidden />
          </div>
          <h2 className="text-[17px] font-semibold text-[var(--ds-text-primary)]">Sezione riservata</h2>
          <p className="mt-1 text-[14px] text-[var(--ds-text-secondary)]">
            Conferma la password del tuo account. Lo sblocco dura 15 minuti e scade uscendo dalla sezione.
          </p>
          <Field className="mt-4" label="Password" htmlFor="compensation-password" error={unlockError}>
            <input
              ref={passwordRef}
              id="compensation-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={e => setPassword(e.target.value)}
              className={dsInput}
            />
          </Field>
          <button type="submit" disabled={!password || unlocking} className={`${dsButton.primary} mt-4 w-full`}>
            {unlocking && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Sblocca
          </button>
        </form>
      </div>
    );
  }

  const rows = summary?.rows ?? [];
  const rowsByType = TYPE_ORDER.map(type => ({
    type,
    rows: rows
      .filter(r => {
        const member = membersById.get(r.staffId);
        if (!member || member.staffType !== type) return false;
        // I disattivati restano visibili finché hanno numeri nel mese:
        // un extra uscito a metà stagione ha ancora un residuo da saldare.
        return member.isActive || r.paidCents > 0 || (r.dueCents ?? 0) > 0 || r.singleDays > 0 || r.doubleDays > 0;
      })
      .sort((a, b) => {
        const ma = membersById.get(a.staffId)!;
        const mb = membersById.get(b.staffId)!;
        return `${ma.surname} ${ma.name}`.localeCompare(`${mb.surname} ${mb.name}`, 'it');
      })
  })).filter(g => g.rows.length > 0);

  const isCurrentMonth = month === currentMonth();

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
      {/* ── Mese e totali ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setMonth(addMonths(month, -1))} aria-label="Mese precedente" className={dsIconButton}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[150px] text-center text-[16px] font-semibold capitalize text-[var(--ds-text-primary)]">
            {monthLabel(month)}
          </span>
          <button type="button" onClick={() => setMonth(addMonths(month, 1))} aria-label="Mese successivo" className={dsIconButton}>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        {!isCurrentMonth && (
          <button type="button" onClick={() => setMonth(currentMonth())} className={dsButton.secondary}>
            Oggi
          </button>
        )}
      </div>

      {summary && (
        <div className="grid grid-cols-3 overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
          {([
            ['Dovuto', summary.totals.dueCents, 'text-[var(--ds-text-primary)]'],
            ['Pagato', summary.totals.paidCents, 'text-[var(--ds-text-primary)]'],
            ['Residuo', summary.totals.residualCents,
              summary.totals.residualCents > 0 ? 'text-[var(--ds-pending-text)]' : 'text-[var(--ds-seated-text)]'],
          ] as const).map(([label, cents, tone]) => (
            <div key={label} className="border-r border-[var(--ds-border)] px-4 py-3 last:border-r-0">
              <div className="text-[12px] text-[var(--ds-text-muted)]">{label}</div>
              <div className={`text-[17px] font-semibold tabular-nums ${tone}`}>{formatEuro(cents)}</div>
            </div>
          ))}
        </div>
      )}

      {loading && !summary && (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--ds-text-muted)]" aria-hidden />
        </div>
      )}

      {summary && rowsByType.length === 0 && (
        <EmptyState icon={Wallet}>
          Nessun compenso nel mese. Le tariffe si impostano dal dipendente, i turni fanno il resto.
        </EmptyState>
      )}

      {/* ── Righe per dipendente ── */}
      {rowsByType.map(group => (
        <section key={group.type}>
          <h3 className="mb-2 px-1 text-[13px] font-medium text-[var(--ds-text-muted)]">{TYPE_LABELS[group.type]}</h3>
          <div className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
            {group.rows.map(row => {
              const member = membersById.get(row.staffId)!;
              const expanded = expandedId === row.staffId;
              const staffPayments = payments.filter(p => p.staffId === row.staffId);
              return (
                <div key={row.staffId} className="border-b border-[var(--ds-border)] last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : row.staffId)}
                    aria-expanded={expanded}
                    className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--ds-surface-row)]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">
                        {member.surname} {member.name}
                        {!member.isActive && <span className="ml-2 text-[12px] text-[var(--ds-text-muted)]">non attivo</span>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-[var(--ds-text-muted)]">
                        {member.staffType === StaffType.EXTRA && (
                          <span>{row.singleDays} singoli · {row.doubleDays} doppi</span>
                        )}
                        {row.dueSource === 'OVERRIDE' && (
                          <span className="text-[var(--ds-arriving-text)]">dovuto corretto a mano</span>
                        )}
                        {row.missingRate && (
                          <span className="inline-flex items-center gap-1 text-[var(--ds-pending-text)]">
                            <AlertTriangle className="h-3 w-3" aria-hidden />
                            tariffa mancante
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-right tabular-nums">
                      <div>
                        <div className="text-[11px] text-[var(--ds-text-muted)]">dovuto</div>
                        <div className="text-[14px] font-medium text-[var(--ds-text-primary)]">
                          {row.dueCents == null ? '—' : formatEuro(row.dueCents)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] text-[var(--ds-text-muted)]">pagato</div>
                        <div className="text-[14px] font-medium text-[var(--ds-text-primary)]">{formatEuro(row.paidCents)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] text-[var(--ds-text-muted)]">residuo</div>
                        <div className={`text-[14px] font-semibold ${
                          row.residualCents == null ? 'text-[var(--ds-text-muted)]'
                          : row.residualCents > 0 ? 'text-[var(--ds-pending-text)]'
                          : row.residualCents < 0 ? 'text-[var(--ds-critical-text)]'
                          : 'text-[var(--ds-seated-text)]'
                        }`}>
                          {row.residualCents == null ? '—' : formatEuro(row.residualCents)}
                        </div>
                      </div>
                    </div>
                  </button>

                  {expanded && (
                    <div className="space-y-3 bg-[var(--ds-canvas)] px-4 py-3">
                      {/* Con la tariffa mancante il primo gesto sensato è
                          impostarla: il bottone pieno segue il lavoro, non
                          l'ordine fisso delle azioni. */}
                      <div className="flex flex-wrap gap-2">
                        {row.missingRate && (
                          <button type="button" onClick={() => setRatesModal(row.staffId)} className={dsButton.primary}>
                            Tariffe
                          </button>
                        )}
                        <button type="button" onClick={() => setPaymentModal({ staffId: row.staffId, kind: 'ACCONTO' })} className={row.missingRate ? dsButton.secondary : dsButton.primary}>
                          Acconto
                        </button>
                        <button type="button" onClick={() => setPaymentModal({ staffId: row.staffId, kind: 'SALDO' })} className={dsButton.secondary}>
                          Saldo
                        </button>
                        <button type="button" onClick={() => setOverrideModal(row.staffId)} className={dsButton.secondary}>
                          Correggi dovuto
                        </button>
                        {!row.missingRate && (
                          <button type="button" onClick={() => setRatesModal(row.staffId)} className={dsButton.secondary}>
                            Tariffe
                          </button>
                        )}
                      </div>

                      {staffPayments.length > 0 && (
                        <ul className="overflow-hidden rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)]">
                          {staffPayments.map(p => (
                            <li key={p.id} className="flex items-center gap-3 border-b border-[var(--ds-border)] px-3 py-2 last:border-b-0">
                              <div className="min-w-0 flex-1 text-[13px]">
                                <span className="font-medium text-[var(--ds-text-primary)]">
                                  {p.kind === 'ACCONTO' ? 'Acconto' : 'Saldo'} · {formatEuro(p.amountCents)}
                                </span>
                                <span className="ml-2 text-[var(--ds-text-muted)]">
                                  {new Date(`${p.paidOn}T00:00:00`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                                  {p.method ? ` · ${METHOD_LABELS[p.method]}` : ''}
                                  {p.note ? ` · ${p.note}` : ''}
                                </span>
                              </div>
                              <button
                                type="button"
                                aria-label="Elimina movimento"
                                onClick={async () => {
                                  try {
                                    await staffCompensationApiService.deletePayment(grant.token, p.id);
                                    await reload(grant.token, month);
                                  } catch (err) { handleApiError(err); }
                                }}
                                className={`${dsIconButton} !h-8 !w-8 text-[var(--ds-critical-text)]`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}

                      {row.dueSource === 'OVERRIDE' && (
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await staffCompensationApiService.deleteOverride(grant.token, row.staffId, month);
                              await reload(grant.token, month);
                              showToast('Dovuto tornato al calcolo automatico', 'success');
                            } catch (err) { handleApiError(err); }
                          }}
                          className="text-[13px] font-medium text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text-primary)]"
                        >
                          Torna al calcolo automatico
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {paymentModal && (
        <PaymentSheet
          key={`${paymentModal.staffId}-${paymentModal.kind}`}
          member={membersById.get(paymentModal.staffId)!}
          kind={paymentModal.kind}
          month={month}
          onClose={() => setPaymentModal(null)}
          onSubmit={async input => {
            try {
              await staffCompensationApiService.createPayment(grant.token, input);
              setPaymentModal(null);
              await reload(grant.token, month);
              showToast('Movimento registrato', 'success');
            } catch (err) { handleApiError(err); }
          }}
        />
      )}

      {overrideModal && (
        <OverrideSheet
          key={overrideModal}
          member={membersById.get(overrideModal)!}
          row={rows.find(r => r.staffId === overrideModal)}
          month={month}
          onClose={() => setOverrideModal(null)}
          onSubmit={async (cents, note) => {
            try {
              await staffCompensationApiService.setOverride(grant.token, overrideModal, month, cents, note);
              setOverrideModal(null);
              await reload(grant.token, month);
              showToast('Dovuto corretto', 'success');
            } catch (err) { handleApiError(err); }
          }}
        />
      )}

      {ratesModal && (
        <RatesSheet
          key={ratesModal}
          member={membersById.get(ratesModal)!}
          profile={profilesById.get(ratesModal)}
          onClose={() => setRatesModal(null)}
          onSubmit={async updates => {
            try {
              await staffCompensationApiService.updateProfile(grant.token, ratesModal, updates);
              setRatesModal(null);
              await reload(grant.token, month);
              showToast('Tariffe salvate', 'success');
            } catch (err) { handleApiError(err); }
          }}
        />
      )}
    </div>
  );
};

// ── Fogli ────────────────────────────────────────────────────────────────

const PaymentSheet: React.FC<{
  member: StaffMember;
  kind: 'ACCONTO' | 'SALDO';
  month: string;
  onClose: () => void;
  onSubmit: (input: CreateCompensationPaymentInput) => Promise<void>;
}> = ({ member, kind, month, onClose, onSubmit }) => {
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso());
  const [method, setMethod] = useState<'CONTANTI' | 'BONIFICO' | 'ALTRO' | ''>('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const cents = parseEuroToCents(amount);
  const valid = cents != null && cents > 0;

  return (
    <ModalShell
      open
      onClose={onClose}
      title={kind === 'ACCONTO' ? 'Acconto' : 'Saldo'}
      subtitle={`${member.surname} ${member.name} · ${monthLabel(month)}`}
      bodyClassName="px-5 pb-5 pt-4 sm:px-6"
      footer={
        <button
          type="button"
          disabled={!valid || saving}
          onClick={async () => { setSaving(true); await onSubmit({
            staffId: member.id, periodMonth: month, kind,
            amountCents: cents!, paidOn,
            method: method || undefined,
            note: note.trim() || undefined,
          }); setSaving(false); }}
          className={`${dsButton.primary} w-full`}
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Registra
        </button>
      }
    >
      <div className="space-y-4">
        <Field label="Importo" htmlFor="comp-amount" required>
          <input id="comp-amount" inputMode="decimal" placeholder="0,00 €" autoFocus value={amount}
            onChange={e => setAmount(e.target.value)} className={dsInput} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Data" htmlFor="comp-paid-on">
            <input id="comp-paid-on" type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)} className={dsInput} />
          </Field>
          <Field label="Metodo" htmlFor="comp-method">
            <select id="comp-method" value={method} onChange={e => setMethod(e.target.value as typeof method)} className={dsSelect}>
              <option value="">—</option>
              <option value="CONTANTI">Contanti</option>
              <option value="BONIFICO">Bonifico</option>
              <option value="ALTRO">Altro</option>
            </select>
          </Field>
        </div>
        <Field label="Nota" htmlFor="comp-note">
          <input id="comp-note" value={note} onChange={e => setNote(e.target.value)} className={dsInput} />
        </Field>
      </div>
    </ModalShell>
  );
};

const OverrideSheet: React.FC<{
  member: StaffMember;
  row?: StaffCompensationSummaryRow;
  month: string;
  onClose: () => void;
  onSubmit: (cents: number, note?: string) => Promise<void>;
}> = ({ member, row, month, onClose, onSubmit }) => {
  const [amount, setAmount] = useState(centsToEuroInput(row?.dueSource === 'OVERRIDE' ? row.dueCents : null));
  const [note, setNote] = useState(row?.overrideNote ?? '');
  const [saving, setSaving] = useState(false);
  const cents = parseEuroToCents(amount);

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Correggi dovuto"
      subtitle={`${member.surname} ${member.name} · ${monthLabel(month)}`}
      bodyClassName="px-5 pb-5 pt-4 sm:px-6"
      footer={
        <button
          type="button"
          disabled={cents == null || saving}
          onClick={async () => { setSaving(true); await onSubmit(cents!, note.trim() || undefined); setSaving(false); }}
          className={`${dsButton.primary} w-full`}
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Salva
        </button>
      }
    >
      <div className="space-y-4">
        <Field label="Dovuto del mese" htmlFor="ovr-amount" required
          hint="Sostituisce il calcolo automatico solo per questo mese.">
          <input id="ovr-amount" inputMode="decimal" placeholder="0,00 €" autoFocus value={amount}
            onChange={e => setAmount(e.target.value)} className={dsInput} />
        </Field>
        <Field label="Nota" htmlFor="ovr-note">
          <input id="ovr-note" value={note} onChange={e => setNote(e.target.value)} className={dsInput} />
        </Field>
      </div>
    </ModalShell>
  );
};

const RatesSheet: React.FC<{
  member: StaffMember;
  profile?: StaffCompensationProfile;
  onClose: () => void;
  onSubmit: (updates: { monthlyCents?: number | null; singleServiceCents?: number | null; doubleServiceCents?: number | null; notes?: string }) => Promise<void>;
}> = ({ member, profile, onClose, onSubmit }) => {
  const isExtra = member.staffType === StaffType.EXTRA;
  const [monthly, setMonthly] = useState(centsToEuroInput(profile?.monthlyCents));
  const [single, setSingle] = useState(centsToEuroInput(profile?.singleServiceCents));
  const [double, setDouble] = useState(centsToEuroInput(profile?.doubleServiceCents));
  const [notes, setNotes] = useState(profile?.notes ?? '');
  const [saving, setSaving] = useState(false);

  const monthlyCents = monthly.trim() ? parseEuroToCents(monthly) : null;
  const singleCents = single.trim() ? parseEuroToCents(single) : null;
  const doubleCents = double.trim() ? parseEuroToCents(double) : null;
  const invalid = (monthly.trim() !== '' && monthlyCents == null)
    || (single.trim() !== '' && singleCents == null)
    || (double.trim() !== '' && doubleCents == null);

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Tariffe"
      subtitle={`${member.surname} ${member.name}`}
      bodyClassName="px-5 pb-5 pt-4 sm:px-6"
      footer={
        <button
          type="button"
          disabled={invalid || saving}
          onClick={async () => {
            setSaving(true);
            await onSubmit({
              monthlyCents, singleServiceCents: singleCents, doubleServiceCents: doubleCents,
              notes: notes.trim() || undefined,
            });
            setSaving(false);
          }}
          className={`${dsButton.primary} w-full`}
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Salva
        </button>
      }
    >
      <div className="space-y-4">
        {isExtra ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Servizio singolo" htmlFor="rate-single" hint="giorno con un servizio">
              <input id="rate-single" inputMode="decimal" placeholder="0,00 €" value={single}
                onChange={e => setSingle(e.target.value)} className={dsInput} />
            </Field>
            <Field label="Servizio doppio" htmlFor="rate-double" hint="pranzo e cena, totale giorno">
              <input id="rate-double" inputMode="decimal" placeholder="0,00 €" value={double}
                onChange={e => setDouble(e.target.value)} className={dsInput} />
            </Field>
          </div>
        ) : (
          <Field label="Mensile" htmlFor="rate-monthly"
            hint={member.staffType === StaffType.STAGIONALE ? 'pieno nei mesi di contratto' : undefined}>
            <input id="rate-monthly" inputMode="decimal" placeholder="0,00 €" value={monthly}
              onChange={e => setMonthly(e.target.value)} className={dsInput} />
          </Field>
        )}
        <Field label="Nota" htmlFor="rate-notes">
          <input id="rate-notes" value={notes} onChange={e => setNotes(e.target.value)} className={dsInput} />
        </Field>
      </div>
    </ModalShell>
  );
};
