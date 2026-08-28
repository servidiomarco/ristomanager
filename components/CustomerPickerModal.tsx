import React, { useEffect, useMemo, useState } from 'react';
import { Customer } from '../types';
import { createCustomer, getCustomers } from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import { Search, UserPlus, Phone, Mail, BookUser } from 'lucide-react';
import { ModalShell, dsInput, dsButton, Field, Callout, EmptyState } from './ds';

// Il form "nuovo cliente" vive nel corpo del modal, il suo submit nel footer:
// ModalShell li rende come fratelli, quindi il bottone si aggancia al form
// con l'attributo `form` invece che standoci dentro.
const CREATE_FORM_ID = 'customer-picker-create';

interface Props {
  isOpen: boolean;
  initialQuery?: string;
  onClose: () => void;
  onSelect: (customer: Customer) => void;
  onCreated?: (customer: Customer) => void;
}

interface NewCustomerDraft {
  name: string;
  phone: string;
  email: string;
}

export const CustomerPickerModal: React.FC<Props> = ({ isOpen, initialQuery, onClose, onSelect, onCreated }) => {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('customers:full');

  const [query, setQuery] = useState(initialQuery || '');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState<NewCustomerDraft>({ name: '', phone: '', email: '' });
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setQuery(initialQuery || '');
    setShowCreate(false);
    setDraft({ name: initialQuery?.trim() || '', phone: '', email: '' });
    setError(null);
  }, [isOpen, initialQuery]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const handle = setTimeout(async () => {
      try {
        const data = await getCustomers(query);
        if (!cancelled) setCustomers(data);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Errore caricamento clienti');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }, query ? 200 : 0);

    return () => { cancelled = true; clearTimeout(handle); };
  }, [isOpen, query]);

  const handleSelect = (c: Customer) => {
    onSelect(c);
    onClose();
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim() || !draft.phone.trim()) return;
    setIsSaving(true);
    setError(null);
    try {
      const created = await createCustomer({
        name: draft.name.trim(),
        phone: draft.phone.trim(),
        email: draft.email.trim() || null,
      });
      onCreated?.(created);
      onSelect(created);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Errore salvataggio cliente');
    } finally {
      setIsSaving(false);
    }
  };

  const sortedCustomers = useMemo(
    () => [...customers].sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' })),
    [customers]
  );

  if (!isOpen) return null;

  return (
    <ModalShell
      open={isOpen}
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-2">
          <BookUser className="h-5 w-5 flex-shrink-0 text-[var(--ds-text-secondary)]" aria-hidden />
          Rubrica Clienti
        </span>
      }
      size="md"
      // Si apre sopra il form prenotazione, che e' gia' portato su <body>:
      // lo z-index resta esplicito invece di dipendere dall'ordine di pittura.
      className="!z-[60]"
      bodyClassName="px-4 py-4 sm:px-5"
      subheader={!showCreate ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-text-muted)]" aria-hidden />
          <label htmlFor="customer-picker-search" className="sr-only">Cerca un cliente</label>
          <input
            id="customer-picker-search"
            type="text"
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Cerca per nome, telefono, email..."
            className={`${dsInput} bg-[var(--ds-surface)] pl-11`}
          />
        </div>
      ) : undefined}
      footer={!showCreate
        ? (canCreate ? (
            <button
              type="button"
              onClick={() => {
                setDraft({ name: query.trim(), phone: '', email: '' });
                setShowCreate(true);
              }}
              className={`${dsButton.primary} w-full`}
            >
              <UserPlus className="h-4 w-4" aria-hidden />
              Nuovo cliente
            </button>
          ) : undefined)
        : (
          <>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className={`${dsButton.secondary} flex-1`}
            >
              Annulla
            </button>
            <button
              type="submit"
              form={CREATE_FORM_ID}
              disabled={isSaving || !draft.name.trim() || !draft.phone.trim()}
              className={`${dsButton.primary} flex-1`}
            >
              {isSaving ? 'Salvataggio...' : 'Salva e seleziona'}
            </button>
          </>
        )}
    >
      {!showCreate && (
        <>
          {error && !isLoading && (
            <div role="alert" className="mb-3">
              <Callout tone="critical">{error}</Callout>
            </div>
          )}
          {isLoading && (
            <p className="p-6 text-center text-[14px] text-[var(--ds-text-muted)]">Caricamento...</p>
          )}
          {!isLoading && !error && sortedCustomers.length === 0 && (
            <EmptyState icon={BookUser}>Nessun cliente trovato.</EmptyState>
          )}
          {!isLoading && sortedCustomers.length > 0 && (
            <ul className="divide-y divide-[var(--ds-border)] overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
              {sortedCustomers.map(c => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(c)}
                    className="w-full px-4 py-3 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <div className="text-[15px] font-medium text-[var(--ds-text-primary)]">{c.name}</div>
                    <div className="mt-0.5 flex flex-wrap gap-3 text-[13px] text-[var(--ds-text-muted)]">
                      {c.phone && (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="h-3 w-3" aria-hidden /> {c.phone}
                        </span>
                      )}
                      {c.email && (
                        <span className="inline-flex items-center gap-1">
                          <Mail className="h-3 w-3" aria-hidden /> {c.email}
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {showCreate && (
        <form id={CREATE_FORM_ID} onSubmit={handleCreate}>
          <div className="space-y-4 rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
            <Field label="Nome" htmlFor="new-customer-name" required>
              <input
                id="new-customer-name"
                type="text"
                autoFocus
                required
                value={draft.name}
                onChange={e => setDraft({ ...draft, name: e.target.value })}
                className={dsInput}
              />
            </Field>
            <Field label="Telefono" htmlFor="new-customer-phone" required>
              <input
                id="new-customer-phone"
                type="tel"
                required
                value={draft.phone}
                onChange={e => setDraft({ ...draft, phone: e.target.value })}
                className={dsInput}
              />
            </Field>
            <Field label="Email" htmlFor="new-customer-email">
              <input
                id="new-customer-email"
                type="email"
                value={draft.email}
                onChange={e => setDraft({ ...draft, email: e.target.value })}
                className={dsInput}
              />
            </Field>
            {error && (
              <div role="alert">
                <Callout tone="critical">{error}</Callout>
              </div>
            )}
          </div>
        </form>
      )}
    </ModalShell>
  );
};
