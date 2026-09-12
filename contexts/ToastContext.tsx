import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { ToastCard, ToastPill, ToastViewport } from '../components/ds/Toast';
import type { ToastTone } from '../components/ds/Toast';

/* ── Un solo canale per le notifiche (§Toast, §11.4) ──────────────────────
   Lo stato dei toast viveva in App e scendeva per props (showToast) fino a
   trenta componenti — con il costo documentato del pattern showToastRef nei
   mount-only effect. Qui diventa contesto: chiunque chiama useToast() e
   parla nello stesso viewport, con la stessa grammatica.

   Un toast con azione singola e senza titolo/dettagli esce come pillola
   solida (il linguaggio dell'Annulla della Lista della spesa); il resto come
   card. Gli errori non si auto-dismettono — persistono finché non vengono
   chiusi (§Toast) — a meno che il chiamante non passi una duration sua. */

export interface ToastOptions {
  title?: string;
  details?: string[];
  /** ms. Default 5000; per gli errori il default è "resta finché chiuso". */
  duration?: number;
  action?: { label: string; onClick: () => void | Promise<void> };
  /** Glifo in testa (es. Trash2 sull'undo di un'eliminazione). */
  icon?: LucideIcon;
  /** Slot esclusivo: un nuovo toast con la stessa chiave sostituisce il
   *  precedente invece di accodarsi — l'undo superato non deve restare. */
  replaceKey?: string;
}

export type AddToast = (message: string, type?: ToastTone, options?: ToastOptions) => void;

interface ToastEntry extends ToastOptions {
  id: string;
  message: string;
  type: ToastTone;
  /** Nessun timer: resta finché non viene chiuso (gli errori). */
  persistent?: boolean;
}

interface ToastContextType {
  addToast: AddToast;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

// Handler + socket:event innescano lo stesso feedback due volte (o StrictMode
// raddoppia un effect in dev): entro questa finestra il duplicato collassa.
// 2500ms copre il roundtrip socket tipico senza inghiottire ripetizioni
// legittime ("Salva" premuto due volte apposta).
const TOAST_DEDUP_WINDOW_MS = 2500;
const DEFAULT_DURATION_MS = 5000;
const DETAILS_DURATION_MS = 6000;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const lastToastAtRef = useRef<Map<string, number>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) { clearTimeout(timer); timersRef.current.delete(id); }
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback<AddToast>((message, type = 'info', options) => {
    // Il dedup esiste per il feedback passivo doppio (handler + socket:event,
    // StrictMode). Un toast con azione nasce da un gesto diretto: sopprimerlo
    // butterebbe via anche l'undo nuovo, quindi passa sempre.
    if (!options?.action) {
      // La chiave ignora il tono di proposito: «Prenotazione eliminata» dal
      // handler locale (success) e dall'eco socket (info) è la stessa notizia
      // e deve collassare in un toast solo.
      const dedupKey = `${options?.title ?? ''}|${message}`;
      const now = Date.now();
      const lastAt = lastToastAtRef.current.get(dedupKey);
      if (lastAt !== undefined && now - lastAt < TOAST_DEDUP_WINDOW_MS) {
        // Duplicato soppresso. Il timestamp si rinfresca, così trigger a
        // raffica tengono viva la soppressione invece di sfuggirle appena
        // scade la finestra.
        lastToastAtRef.current.set(dedupKey, now);
        return;
      }
      lastToastAtRef.current.set(dedupKey, now);
      for (const [k, ts] of lastToastAtRef.current) {
        if (now - ts > TOAST_DEDUP_WINDOW_MS * 4) lastToastAtRef.current.delete(k);
      }
    }

    const id = Math.random().toString(36).substr(2, 9);
    const duration = options?.duration
      ?? (type === 'error' ? null : options?.details?.length ? DETAILS_DURATION_MS : DEFAULT_DURATION_MS);

    setToasts(prev => {
      const kept = options?.replaceKey ? prev.filter(t => t.replaceKey !== options.replaceKey) : prev;
      for (const dropped of prev) {
        if (!kept.includes(dropped)) {
          const timer = timersRef.current.get(dropped.id);
          if (timer) { clearTimeout(timer); timersRef.current.delete(dropped.id); }
        }
      }
      return [...kept, { id, message, type, ...options, persistent: duration === null }];
    });

    if (duration !== null) {
      timersRef.current.set(id, setTimeout(() => removeToast(id), duration));
    }
  }, [removeToast]);

  const value = useMemo(() => ({ addToast }), [addToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <ToastViewport>
          {toasts.map(t =>
            !t.title && !t.details?.length ? (
              <ToastPill
                key={t.id}
                icon={t.icon}
                tone={t.type}
                message={t.message}
                action={t.action}
                dismissible={t.persistent}
                onDismiss={() => removeToast(t.id)}
              />
            ) : (
              <ToastCard
                key={t.id}
                tone={t.type}
                message={t.message}
                title={t.title}
                details={t.details}
                icon={t.icon}
                action={t.action}
                dismissible={t.persistent}
                onDismiss={() => removeToast(t.id)}
              />
            ),
          )}
        </ToastViewport>,
        document.body,
      )}
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextType => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
};
