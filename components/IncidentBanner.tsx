import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Info, X } from 'lucide-react';
import type { ActiveIncident } from '../services/healthShared';

/* ── Banner «problema noto» (supporto, fase 2) ────────────────────────────
   Quando la piattaforma sa già che qualcosa non va (Sofia giù, stampa che
   non parte per tutti), lo dice qui, sotto la testata di ogni vista: chi
   lavora sa che il problema è noto e non apre dieci richieste uguali.
   Chiudibile per banner: la scelta resta sul dispositivo, e un banner nuovo
   ricompare. Non fisso: occupa il suo spazio invece di coprire la vista. */

const DISMISSED_KEY = 'ristocrm_incidents_dismissed';

const readDismissed = (): number[] => {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
};

const writeDismissed = (ids: number[]): void => {
  try {
    // Solo gli ultimi: gli id vecchi non torneranno più.
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-20)));
  } catch { /* storage pieno o bloccato: il banner tornerà, pazienza */ }
};

export const IncidentBanner: React.FC<{ incidents: ActiveIncident[] }> = ({ incidents }) => {
  const { t } = useTranslation(undefined, { useSuspense: false });
  const [dismissed, setDismissed] = useState<number[]>(readDismissed);
  const shown = incidents.find(i => !dismissed.includes(i.id));
  if (!shown) return null;

  const critical = shown.level === 'critico';
  const Icon = critical ? AlertTriangle : Info;
  const dismiss = () => {
    const next = [...dismissed, shown.id];
    setDismissed(next);
    writeDismissed(next);
  };

  return (
    <div className="mx-4 mb-3 flex-shrink-0 md:-mt-1">
      <div
        role={critical ? 'alert' : 'status'}
        className={`flex items-start gap-3 rounded-[var(--ds-radius)] p-3 text-[14px] leading-snug ${
          critical
            ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]'
            : 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]'
        }`}
      >
        <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">
          <span className="font-semibold">{t('incident.label', 'Sympotia')}: </span>
          {shown.message}
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('incident.close', 'Chiudi avviso')}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
};

export default IncidentBanner;
