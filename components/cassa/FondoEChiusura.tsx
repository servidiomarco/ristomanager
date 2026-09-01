import React, { useMemo, useState } from 'react';
import { ArrowLeft, Loader2, Printer } from 'lucide-react';
import type { CashSessionView } from '../../types';
import { getRomeTimePart } from '../../utils/reservationTime';
import { Callout, FormCard } from '../ds';
import { methodLabel } from '../pagamenti/settleView';
import { euro } from './cassaView';

/* ── Fuori flusso · fondo e chiusura ──────────────────────────────────────
   Il cassetto di questo servizio: quanto c'era all'apertura, quanto è entrato,
   quanto c'è davvero contandolo.

   L'atteso si RICALCOLA sempre; la differenza invece si memorizza alla
   chiusura, perché è la fotografia del momento in cui si è contato. Uno storno
   alle 23:40 muove l'atteso ma non deve riscrivere un numero che qualcuno ha
   già firmato con una nota.

   La cassa si chiude anche con conti aperti: si avvisa, non si blocca. Quei
   conti restano incassabili anche domani — è la terza riga del Passo 1. */

interface FondoEChiusuraProps {
  view: CashSessionView | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  /** Chi può contare il cassetto: senza `cash:close_session` è sola lettura. */
  canClose: boolean;
  onBack: () => void;
  onOpen: (floatCents: number) => void;
  onUpdateFloat: (floatCents: number) => void;
  onClose: (countedCents: number, note: string) => void;
  onPrint: () => void;
  /** Il riscontro per documento (scontrini/fatture/proforma) sta in
   *  Pagamenti · Chiusura: da qui ci si arriva, non lo si duplica. */
  onOpenGiornale?: () => void;
}

const toCents = (s: string): number => {
  const n = parseFloat(s.replace(/[^\d.,]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
};

const field = 'h-12 w-full rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface-2)] px-3 text-right text-[17px] tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)]';

export const FondoEChiusura: React.FC<FondoEChiusuraProps> = ({
  view, loading, error, busy, canClose, onBack, onOpen, onUpdateFloat, onClose, onPrint, onOpenGiornale,
}) => {
  const session = view?.session ?? null;
  const closed = session?.closed_at != null;

  const [floatText, setFloatText] = useState('');
  const [editingFloat, setEditingFloat] = useState(false);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');

  const countedCents = toCents(counted);
  const expected = view?.expected_cents ?? 0;
  const difference = counted.trim() === '' ? null : countedCents - expected;
  const needsNote = difference != null && difference !== 0;

  const out = view?.out_of_totals;
  const open = view?.open_bills;

  const methods = useMemo(() => view?.methods ?? [], [view]);

  if (loading && !view) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[14px] text-[var(--ds-text-muted)]">
        <Loader2 size={16} className="animate-spin" /> Carico la cassa…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mx-auto w-full max-w-[1100px] flex-shrink-0 px-4 pb-3 pt-4 lg:px-8">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Torna alla coda"
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="flex-1 text-[20px] font-semibold tracking-[-0.02em] text-[var(--ds-text-primary)] lg:text-[26px]">
            Fondo e chiusura
          </h1>
          <button
            type="button"
            onClick={onPrint}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-[var(--ds-surface)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)]"
          >
            <Printer size={16} aria-hidden /> Stampa riepilogo
          </button>
        </div>
      </div>

      <div className="mx-auto w-full min-h-0 max-w-[1100px] flex-1 space-y-4 overflow-y-auto px-4 pb-6 lg:px-8">
        {error && <Callout tone="critical">{error}</Callout>}

        {/* Il fondo di apertura */}
        <FormCard title="Fondo di apertura">
          {session ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[26px] font-semibold tabular-nums tracking-[-0.02em] text-[var(--ds-text-primary)]">
                  {euro(session.opening_float_cents)}
                </div>
                <div className="text-[13px] text-[var(--ds-text-muted)]">
                  Aperto da {session.opened_by_name} alle {getRomeTimePart(session.opened_at)}
                </div>
              </div>
              {!closed && canClose && (
                editingFloat ? (
                  <div className="flex items-end gap-2">
                    <input
                      type="text" inputMode="decimal" autoFocus
                      value={floatText} onChange={e => setFloatText(e.target.value)}
                      className={`${field} w-32`}
                    />
                    <button
                      type="button"
                      onClick={() => { onUpdateFloat(toCents(floatText)); setEditingFloat(false); }}
                      disabled={busy}
                      className="h-12 rounded-xl bg-[var(--ds-action-bg)] px-4 text-[14px] font-semibold text-[var(--ds-action-fg)] disabled:opacity-40"
                    >
                      Salva
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setFloatText((session.opening_float_cents / 100).toFixed(2)); setEditingFloat(true); }}
                    className="inline-flex h-11 items-center rounded-full bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]"
                  >
                    Modifica
                  </button>
                )
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-[14px] text-[var(--ds-text-muted)]">
                Nessun fondo dichiarato per questo servizio.
              </p>
              {canClose && (
                <div className="flex items-end gap-2">
                  <label className="block flex-1 max-w-[200px]">
                    <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">
                      Contante all'apertura
                    </span>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[17px] text-[var(--ds-text-muted)]">€</span>
                      <input
                        type="text" inputMode="decimal" value={floatText}
                        onChange={e => setFloatText(e.target.value)} placeholder="0,00"
                        className={`${field} pl-8`}
                      />
                    </div>
                  </label>
                  <button
                    type="button"
                    onClick={() => onOpen(toCents(floatText))}
                    disabled={busy}
                    className="h-12 rounded-xl bg-[var(--ds-action-bg)] px-5 text-[15px] font-semibold text-[var(--ds-action-fg)] disabled:opacity-40"
                  >
                    Apri la cassa
                  </button>
                </div>
              )}
            </div>
          )}
        </FormCard>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Incassi per metodo */}
          <FormCard title="Incassi per metodo">
            {methods.length === 0 ? (
              <p className="text-[14px] text-[var(--ds-text-muted)]">Nessun incasso in questo servizio.</p>
            ) : (
              <dl className="space-y-1.5 text-[14px]">
                {methods.map(m => (
                  <div key={m.method} className="flex justify-between gap-2">
                    <dt className="text-[var(--ds-text-secondary)]">
                      {methodLabel(m.method)} <span className="text-[var(--ds-text-muted)]">· {m.movements}</span>
                    </dt>
                    <dd className="tabular-nums text-[var(--ds-text-primary)]">{euro(m.amount_cents)}</dd>
                  </div>
                ))}
                <div className="flex justify-between gap-2 border-t border-[var(--ds-border)] pt-2 text-[16px] font-semibold">
                  <dt className="text-[var(--ds-text-primary)]">
                    Incassato <span className="text-[13px] font-normal text-[var(--ds-text-muted)]">· {view?.movements ?? 0} movimenti</span>
                  </dt>
                  <dd className="tabular-nums text-[var(--ds-text-primary)]">{euro(view?.collected_cents ?? 0)}</dd>
                </div>
              </dl>
            )}

            {out && (out.deposits_cents > 0 || out.omaggio_cents > 0 || out.sospeso_cents > 0 || out.voided_cents > 0) && (
              <div className="mt-4 space-y-1.5 rounded-[14px] bg-[var(--ds-surface-row)] p-3 text-[13px]">
                <div className="font-semibold text-[var(--ds-text-secondary)]">Fuori dai totali</div>
                <div className="flex justify-between gap-2">
                  <span className="text-[var(--ds-text-secondary)]">Caparre a credito · {out.deposits_count}</span>
                  <span className="tabular-nums text-[var(--ds-text-secondary)]">{euro(out.deposits_cents)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[var(--ds-text-secondary)]">Omaggio</span>
                  <span className="tabular-nums text-[var(--ds-text-secondary)]">{euro(out.omaggio_cents)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[var(--ds-text-secondary)]">Sospeso</span>
                  <span className="tabular-nums text-[var(--ds-text-secondary)]">{euro(out.sospeso_cents)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[var(--ds-critical-text)]">Storni · {out.voided_count}</span>
                  <span className="tabular-nums text-[var(--ds-critical-text)]">−{euro(out.voided_cents)}</span>
                </div>
              </div>
            )}
          </FormCard>

          {/* Il contante */}
          <FormCard title="Contante in cassa">
            <dl className="space-y-1.5 text-[14px]">
              <div className="flex justify-between gap-2">
                <dt className="text-[var(--ds-text-secondary)]">Fondo di apertura</dt>
                <dd className="tabular-nums text-[var(--ds-text-secondary)]">
                  {euro(session?.opening_float_cents ?? 0)}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-[var(--ds-text-secondary)]">Incassi in contanti</dt>
                <dd className="tabular-nums text-[var(--ds-text-secondary)]">{euro(view?.cash_cents ?? 0)}</dd>
              </div>
              <div className="flex justify-between gap-2 border-t border-[var(--ds-border)] pt-2 text-[16px] font-semibold">
                <dt className="text-[var(--ds-text-primary)]">Atteso</dt>
                <dd className="tabular-nums text-[var(--ds-text-primary)]">{euro(expected)}</dd>
              </div>
            </dl>

            {closed ? (
              <div className="mt-4 space-y-2">
                <dl className="space-y-1.5 text-[14px]">
                  <div className="flex justify-between gap-2">
                    <dt className="text-[var(--ds-text-secondary)]">Contato</dt>
                    <dd className="tabular-nums text-[var(--ds-text-primary)]">{euro(session!.counted_cents ?? 0)}</dd>
                  </div>
                </dl>
                <div className={`rounded-[14px] p-3 ${
                  (session!.difference_cents ?? 0) === 0
                    ? 'bg-[var(--ds-seated-tint)]' : 'bg-[var(--ds-critical-tint)]'
                }`}>
                  <div className="flex justify-between gap-2 text-[15px] font-semibold">
                    <span className={(session!.difference_cents ?? 0) === 0 ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}>
                      Differenza
                    </span>
                    <span className={`tabular-nums ${(session!.difference_cents ?? 0) === 0 ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}`}>
                      {(session!.difference_cents ?? 0) > 0 ? '+' : ''}{euro(session!.difference_cents ?? 0)}
                    </span>
                  </div>
                  {session!.note && (
                    <p className="mt-1 text-[13px] text-[var(--ds-text-secondary)]">{session!.note}</p>
                  )}
                </div>
                <p className="text-[13px] text-[var(--ds-text-muted)]">
                  Chiusa da {session!.closed_by_name} alle {getRomeTimePart(session!.closed_at!)}.
                </p>
                {onOpenGiornale && (
                  <button
                    type="button"
                    onClick={onOpenGiornale}
                    className="inline-flex min-h-[44px] items-center text-[14px] font-semibold text-[var(--ds-text-primary)] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    Chiusura del giorno in Pagamenti
                  </button>
                )}
              </div>
            ) : session && canClose ? (
              <div className="mt-4 space-y-3">
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Contato</span>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[17px] text-[var(--ds-text-muted)]">€</span>
                    <input
                      type="text" inputMode="decimal" value={counted}
                      onChange={e => setCounted(e.target.value)} placeholder="0,00"
                      className={`${field} pl-8`}
                    />
                  </div>
                </label>

                {difference != null && (
                  <div className={`rounded-[14px] p-3 ${difference === 0 ? 'bg-[var(--ds-seated-tint)]' : 'bg-[var(--ds-critical-tint)]'}`}>
                    <div className="flex justify-between gap-2 text-[15px] font-semibold">
                      <span className={difference === 0 ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}>
                        Differenza
                      </span>
                      <span className={`tabular-nums ${difference === 0 ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}`}>
                        {difference > 0 ? '+' : ''}{euro(difference)}
                      </span>
                    </div>
                  </div>
                )}

                {needsNote && (
                  <label className="block">
                    <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">
                      Nota sulla differenza <span className="font-normal text-[var(--ds-critical-text)]">obbligatoria</span>
                    </span>
                    <textarea
                      value={note} onChange={e => setNote(e.target.value)} rows={3}
                      className="w-full rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface-2)] p-3 text-[14px] text-[var(--ds-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)]"
                    />
                    <span className="mt-1 block text-[12px] text-[var(--ds-text-muted)]">
                      Resta a registro con il tuo nome.
                    </span>
                  </label>
                )}

                {open && open.count > 0 && (
                  <Callout tone="pending">
                    {open.count === 1
                      ? `1 tavolo è ancora da incassare per ${euro(open.residual_cents)}.`
                      : `${open.count} tavoli sono ancora da incassare per ${euro(open.residual_cents)}.`}
                    {' '}La cassa si chiude comunque, ma quei conti restano aperti nel servizio.
                  </Callout>
                )}

                <button
                  type="button"
                  onClick={() => onClose(countedCents, note.trim())}
                  disabled={busy || counted.trim() === '' || (needsNote && note.trim().length === 0)}
                  className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ds-action-bg)] text-[16px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
                >
                  {busy && <Loader2 size={16} className="animate-spin" />}
                  Chiudi la cassa del servizio
                </button>
              </div>
            ) : !session ? (
              <p className="mt-4 text-[13px] text-[var(--ds-text-muted)]">
                Il conteggio si fa dopo aver dichiarato il fondo.
              </p>
            ) : (
              <p className="mt-4 text-[13px] text-[var(--ds-text-muted)]">
                La chiusura del cassetto è riservata alla direzione.
              </p>
            )}
          </FormCard>
        </div>
      </div>
    </div>
  );
};
