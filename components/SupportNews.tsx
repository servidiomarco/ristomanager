import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Newspaper } from 'lucide-react';
import { ModalShell } from './ds';
import { supportApiService } from '../services/supportApiService';
import { displayLocale } from '../utils/formatLocale';
import type { NewsEntry } from '../services/supportShared';

/* ============================================
   NOVITÀ (supporto, fase 4)
   ============================================
   Cosa è cambiato nell'app, dal registro delle modifiche del catalogo: si
   scrive da solo a ogni PR. Discreto per scelta — le modifiche sono una
   decina al giorno, e un banner a ognuna sarebbe rumore in pieno servizio.
   Un punto sulle voci nuove dall'ultima visita della vista Aiuto. */

const SEEN_KEY = 'ristocrm_news_seen';

const entryKey = (e: NewsEntry): string => `${e.date}|${e.text.slice(0, 60)}`;

const readSeen = (): string | null => {
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
};
const writeSeen = (key: string): void => {
  try { localStorage.setItem(SEEN_KEY, key); } catch { /* niente: tornerà il punto */ }
};

/** «Oggi», «Ieri» o la data: il registro porta solo il giorno. */
const dayLabel = (iso: string, t: (k: string, d: string) => string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const day = new Date(y, (m || 1) - 1, d || 1);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((startOfToday.getTime() - day.getTime()) / 86_400_000);
  if (diff === 0) return t('news.today', 'Oggi');
  if (diff === 1) return t('news.yesterday', 'Ieri');
  try {
    return day.toLocaleDateString(displayLocale(), { day: 'numeric', month: 'long' });
  } catch {
    return iso;
  }
};

const EntryRow: React.FC<{ entry: NewsEntry; isNew: boolean; clamp?: boolean }> = ({ entry, isNew, clamp }) => (
  <div className="flex gap-2.5 py-2.5">
    <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${isNew ? 'bg-[var(--ds-arriving-solid)]' : 'bg-transparent'}`} aria-hidden />
    <div className="min-w-0">
      <p className="text-[13px] font-medium text-[var(--ds-text-secondary)]">{entry.section}</p>
      <p className={`text-[14px] leading-snug text-[var(--ds-text-primary)] ${clamp ? 'line-clamp-3' : ''}`}>{entry.text}</p>
    </div>
  </div>
);

export const SupportNews: React.FC = () => {
  const { t } = useTranslation('supporto', { useSuspense: false });
  const [entries, setEntries] = useState<NewsEntry[]>([]);
  const [open, setOpen] = useState(false);
  // Fotografato al montaggio: le voci restano «nuove» per tutta la visita,
  // e si segnano viste uscendo dalla vista.
  const [seenAtMount] = useState<string | null>(readSeen);

  useEffect(() => {
    let cancelled = false;
    supportApiService.news(40)
      .then(list => { if (!cancelled) setEntries(list); })
      .catch(() => { /* backend più vecchio: niente scheda */ });
    return () => { cancelled = true; };
  }, []);

  // La prima volta non c'è un «visto»: tutto il registro come «nuovo»
  // sarebbe rumore, quindi si parte da adesso. Se la voce vista non c'è più
  // (riga del registro riscritta, o uscita dalle ultime 40) vale la sua
  // data: prima contava tutto come nuovo — «40 nuove» dopo una correzione.
  const newCount = useMemo(() => {
    if (entries.length === 0 || seenAtMount == null) return 0;
    const idx = entries.findIndex(e => entryKey(e) === seenAtMount);
    if (idx >= 0) return idx;
    const seenDate = seenAtMount.split('|')[0];
    return entries.filter(e => e.date > seenDate).length;
  }, [entries, seenAtMount]);

  useEffect(() => {
    if (entries.length === 0) return;
    const latest = entryKey(entries[0]);
    if (seenAtMount == null) writeSeen(latest);
    return () => writeSeen(latest);
  }, [entries, seenAtMount]);

  const groups = useMemo(() => {
    const out: Array<{ date: string; items: Array<{ entry: NewsEntry; index: number }> }> = [];
    entries.forEach((entry, index) => {
      const last = out[out.length - 1];
      if (last && last.date === entry.date) last.items.push({ entry, index });
      else out.push({ date: entry.date, items: [{ entry, index }] });
    });
    return out;
  }, [entries]);

  if (entries.length === 0) return null;

  return (
    <>
      <section className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-3.5 shadow-[var(--ds-shadow-card)]">
        <div className="flex items-center gap-2">
          <Newspaper className="h-4 w-4 text-[var(--ds-arriving-text)]" aria-hidden />
          <h3 className="text-[15px] font-semibold text-[var(--ds-text-primary)]">{t('news.title', 'Novità')}</h3>
          {newCount > 0 && (
            <span className="text-[13px] text-[var(--ds-arriving-text)]">
              {t('news.newCount', '{{count}} nuove', { count: newCount })}
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ml-auto inline-flex min-h-[44px] items-center rounded-[var(--ds-radius-sm)] px-2 text-[14px] font-medium text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            {t('news.all', 'Tutte')}
          </button>
        </div>
        <div className="divide-y divide-[var(--ds-border)]">
          {entries.slice(0, 3).map((e, i) => <EntryRow key={entryKey(e)} entry={e} isNew={i < newCount} clamp />)}
        </div>
      </section>

      {open && (
        <ModalShell
          open
          onClose={() => setOpen(false)}
          closeOnEscape
          title={t('news.title', 'Novità')}
          subtitle={t('news.subtitle', 'Cosa è cambiato in Sympotia di recente.')}
          size="md"
          bodyClassName="p-4 sm:p-5"
        >
          <div className="space-y-4">
            {groups.map(g => (
              <div key={g.date} className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] px-4 py-2 shadow-[var(--ds-shadow-card)]">
                <p className="pt-2 text-[13px] font-semibold text-[var(--ds-text-muted)]">{dayLabel(g.date, t)}</p>
                <div className="divide-y divide-[var(--ds-border)]">
                  {g.items.map(({ entry, index }) => <EntryRow key={entryKey(entry)} entry={entry} isNew={index < newCount} />)}
                </div>
              </div>
            ))}
          </div>
        </ModalShell>
      )}
    </>
  );
};

export default SupportNews;
