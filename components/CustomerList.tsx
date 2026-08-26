import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Customer, Reservation, BanquetMenu, Shift, Table, Room } from '../types';
import { getCustomers, createCustomer, updateCustomer, deleteCustomer, getCustomerDuplicates, mergeCustomers, CustomerDuplicateGroup, getLegalSettings, getMarketingAudience } from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import { Search, Plus, Pencil, Trash2, Phone, Mail, MapPin, BookUser, History, UtensilsCrossed, Calendar, Sun, Moon, Users as UsersIcon, Loader2, Star, Armchair, AlertTriangle, Ban, GitMerge, Download, MessageCircle, User as UserIcon, MoreVertical, ArrowLeft } from 'lucide-react';
import { toTitleCase } from '../utils/text';
import { getRomeDatePart, getRomeTimePart } from '../utils/reservationTime';
import {
  SplitPane, PanePlaceholder, SearchField, StatusPill, StatStrip, CountBadge,
  Callout, EmptyState, ModalShell, StepNav, FormCard, Field,
  SwipeRow, useFirstRunHint, useMediaQuery,
  dsButton, dsInput, dsSelect, dsTextarea,
} from './ds';

interface Props {
  reservations: Reservation[];
  banquetMenus: BanquetMenu[];
  tables: Table[];
  rooms: Room[];
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  autoOpenNew?: boolean;
  onAutoOpenNewHandled?: () => void;
  autoEditByPhone?: string | null;
  onAutoEditHandled?: () => void;
}

interface FormState {
  id?: number;
  name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  postal_code: string;
  notes: string;
  preferred_table_id: number | null;
  preferences_notes: string;
  dietary_notes: string;
  is_vip: boolean;
  is_blacklisted: boolean;
  blacklist_reason: string;
  // Dati di fatturazione (cessionario della fattura elettronica).
  billing_name: string;
  billing_vat: string;
  billing_cf: string;
  billing_sdi: string;
  billing_pec: string;
  billing_street: string;
  billing_zip: string;
  billing_city: string;
  billing_province: string;
}

const emptyForm: FormState = {
  name: '',
  phone: '',
  email: '',
  address: '',
  city: '',
  postal_code: '',
  notes: '',
  preferred_table_id: null,
  preferences_notes: '',
  dietary_notes: '',
  is_vip: false,
  is_blacklisted: false,
  blacklist_reason: '',
  billing_name: '',
  billing_vat: '',
  billing_cf: '',
  billing_sdi: '',
  billing_pec: '',
  billing_street: '',
  billing_zip: '',
  billing_city: '',
  billing_province: '',
};

const customerToForm = (c: Customer): FormState => ({
  id: c.id,
  name: c.name,
  phone: c.phone || '',
  email: c.email || '',
  address: c.address || '',
  city: c.city || '',
  postal_code: c.postal_code || '',
  notes: c.notes || '',
  preferred_table_id: c.preferred_table_id ?? null,
  preferences_notes: c.preferences_notes || '',
  dietary_notes: c.dietary_notes || '',
  is_vip: c.is_vip === true,
  is_blacklisted: c.is_blacklisted === true,
  blacklist_reason: c.blacklist_reason || '',
  billing_name: c.billing?.name || '',
  billing_vat: c.billing?.vat_number || '',
  billing_cf: c.billing?.tax_code || '',
  billing_sdi: c.billing?.sdi_code || '',
  billing_pec: c.billing?.pec || '',
  billing_street: c.billing?.address?.street || '',
  billing_zip: c.billing?.address?.zip || '',
  billing_city: c.billing?.address?.city || '',
  billing_province: c.billing?.address?.province || '',
});

// Ora italiana via gli helper condivisi, come il resto dell'app. La versione
// precedente prendeva ora e data dalla stringa ISO grezza assumendo che il
// backend salvasse l'ora locale: la colonna è timestamptz e l'API risponde in
// UTC, quindi lo storico mostrava le cene alle 18:30 invece che alle 20:30.
const formatReservationDateTime = (isoString: string): { date: string; time: string } => {
  const dateStr = getRomeDatePart(isoString); // YYYY-MM-DD
  if (!dateStr) return { date: '', time: '' };
  const [y, m, d] = dateStr.split('-');
  return { date: `${d}/${m}/${y}`, time: getRomeTimePart(isoString) };
};

// Lowercase + strip diacritics so "cafe" matches "Café" and "d'onofrio"
// matches "D'Onofrio". NFD decomposes accented chars into base+combining,
// then we drop the combining marks (U+0300–U+036F).
const foldText = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Levenshtein distance with an early-exit cap. Rows of the DP table are
// aborted when the running minimum exceeds `limit`, so this stays O(len*limit)
// in practice — plenty fast for the ~10-char customer names we search.
const editDistance = (a: string, b: string, limit: number): number => {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > limit) return limit + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > limit) return limit + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
};

// Fuzzy score for matching `term` against a customer's `name`. Higher is
// better; 0 means no match. Rules (in priority order):
//   100 — name starts with term (best: "Mario" for "mar")
//    80 — a word inside the name starts with term ("Rossi" in "Mario Rossi")
//    60 — term appears anywhere as a substring
//    40 — all chars of term appear in order in name (subsequence: "mrs"→"Mario Rossi")
//    30-  — term is a small edit distance from a word (typo tolerance,
//            scales with word length so "rosi" still finds "rossi").
// Both strings are pre-folded (no diacritics, lowercase).
// Bucket customers by initial. Non-letter first characters (numbers,
// symbols) collapse under '#'. Empty names → '#' too (charAt(0) → '').
const bucketForCustomer = (c: Customer): string => {
  const first = (c.name || '').trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
};

// Full Latin alphabet + '#'. J/K/W/X/Y are rare in Italian first names
// but common in surnames, so we keep them.
const ALPHABET = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','#'];

const fuzzyNameScore = (nameFolded: string, termFolded: string): number => {
  if (!termFolded) return 0;
  if (nameFolded.startsWith(termFolded)) return 100;
  const words = nameFolded.split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (w !== nameFolded && w.startsWith(termFolded)) return 80;
  }
  if (nameFolded.includes(termFolded)) return 60;
  // Subsequence check
  let ti = 0;
  for (let i = 0; i < nameFolded.length && ti < termFolded.length; i++) {
    if (nameFolded.charCodeAt(i) === termFolded.charCodeAt(ti)) ti++;
  }
  if (ti === termFolded.length) return 40;
  // Typo tolerance per word: allow ~1 edit per 4 chars, min 1.
  const maxDist = Math.max(1, Math.floor(termFolded.length / 4));
  let bestDist = maxDist + 1;
  for (const w of words) {
    const d = editDistance(w, termFolded, maxDist);
    if (d < bestDist) bestDist = d;
  }
  if (bestDist <= maxDist) return Math.max(1, 30 - bestDist * 5);
  return 0;
};

export const CustomerList: React.FC<Props> = ({ reservations, banquetMenus, tables, rooms, showToast, autoOpenNew, onAutoOpenNewHandled, autoEditByPhone, onAutoEditHandled }) => {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('customers:full');

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  // When set, only customers whose name starts with this letter are shown.
  // '#' bucket = names not starting with an A-Z character. Cleared by
  // tapping the active letter again or when a search is typed.
  const [letterFilter, setLetterFilter] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const [detailCustomer, setDetailCustomer] = useState<Customer | null>(null);

  // Duplicate detection: customers sharing the last 10 digits of their phone.
  // We surface them in a dedicated modal + prompt an inline merge when the
  // backend rejects a save with a 409 conflict.
  const [duplicateGroups, setDuplicateGroups] = useState<CustomerDuplicateGroup[]>([]);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [mergingIds, setMergingIds] = useState<{ source: number; target: number } | null>(null);
  // Non-null when a save was rejected because another customer already owns
  // the phone. `sourceId` is null on create (nothing to merge from) — the
  // prompt then simply offers to open the existing record.
  const [conflictPrompt, setConflictPrompt] = useState<{
    sourceId: number | null;
    sourceName: string;
    targetId: number;
    targetName: string;
  } | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  // When active, restrict the list to customers who consented to marketing —
  // i.e. the contactable subset for promotional sends.
  const [marketingOnly, setMarketingOnly] = useState(false);
  // Marketing features are only surfaced when the legal layer is in "advanced"
  // mode. Defaults to true so the UI isn't hidden while the setting loads.
  const [marketingEnabled, setMarketingEnabled] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getLegalSettings()
      .then(l => { if (!cancelled) setMarketingEnabled(l.legal_mode !== 'simple'); })
      .catch(() => { /* keep default */ });
    return () => { cancelled = true; };
  }, []);

  // Pull the sanctioned marketing audience (server excludes non-consenting) and
  // download it as CSV — a concrete, consent-safe marketing flow.
  const exportMarketingRecipients = async () => {
    setExporting(true);
    try {
      const { recipients } = await getMarketingAudience();
      if (!recipients.length) {
        showToast('Nessun destinatario con consenso marketing', 'info');
        return;
      }
      const esc = (v: string) => `"${(v || '').replace(/"/g, '""')}"`;
      const rows = [
        ['Nome', 'Telefono', 'Email', 'Consenso aggiornato'],
        ...recipients.map(r => [r.name || '', r.phone || '', r.email || '', r.consent_marketing_updated_at || '']),
      ];
      const csv = rows.map(cols => cols.map(esc).join(',')).join('\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'destinatari-marketing.csv';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      showToast(`Esportati ${recipients.length} destinatari`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Marketing non disponibile in modalità semplice', 'error');
    } finally {
      setExporting(false);
    }
  };

  const reloadDuplicates = async () => {
    try {
      const { groups } = await getCustomerDuplicates();
      setDuplicateGroups(groups);
    } catch {
      // Non-fatal: the duplicates badge just won't show.
      setDuplicateGroups([]);
    }
  };

  useEffect(() => {
    if (!canEdit) return;
    reloadDuplicates();
  }, [canEdit]);

  const duplicatesCount = useMemo(
    () => duplicateGroups.reduce((sum, g) => sum + Math.max(0, g.customers.length - 1), 0),
    [duplicateGroups]
  );

  const runMerge = async (sourceId: number, targetId: number) => {
    setIsMerging(true);
    setMergingIds({ source: sourceId, target: targetId });
    try {
      const updated = await mergeCustomers(sourceId, targetId);
      setCustomers(prev => prev.filter(c => c.id !== sourceId).map(c => c.id === updated.id ? updated : c));
      showToast('Clienti uniti', 'success');
      await reloadDuplicates();
      if (detailCustomer?.id === sourceId) setDetailCustomer(updated);
      setConflictPrompt(null);
      setFormOpen(false);
    } catch (err: any) {
      showToast(err?.message || 'Errore unione clienti', 'error');
    } finally {
      setIsMerging(false);
      setMergingIds(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    getCustomers()
      .then(data => { if (!cancelled) { setCustomers(data); setError(null); } })
      .catch(err => { if (!cancelled) setError(err?.message || 'Errore caricamento clienti'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (autoOpenNew) {
      openCreate();
      onAutoOpenNewHandled?.();
    }
  }, [autoOpenNew]);

  // Aggregate reservations/banquets per customer for the detail panel.
  // Customers are matched on phone (when available) or normalised name to
  // mirror the way the picker re-attaches them to existing reservations.
  interface CustomerStats {
    reservations: Reservation[];
    banquets: BanquetMenu[];
    lastVisit?: string;
  }

  const stats = useMemo(() => {
    const byKey = new Map<string, CustomerStats>();
    const customerKey = (c: Customer): string =>
      c.phone ? `p:${c.phone.trim()}` : `n:${c.name.trim().toLowerCase()}`;
    const reservationKey = (r: Reservation): string =>
      r.phone && r.phone.trim() ? `p:${r.phone.trim()}` : `n:${r.customer_name.trim().toLowerCase()}`;

    for (const c of customers) {
      byKey.set(customerKey(c), { reservations: [], banquets: [], lastVisit: undefined });
    }
    for (const r of reservations) {
      const entry = byKey.get(reservationKey(r));
      if (!entry) continue;
      entry.reservations.push(r);
      if (!entry.lastVisit || r.reservation_time > entry.lastVisit) {
        entry.lastVisit = r.reservation_time;
      }
    }
    for (const b of banquetMenus) {
      if (!b.customer_id) continue;
      const customer = customers.find(c => c.id === b.customer_id);
      if (!customer) continue;
      const entry = byKey.get(customerKey(customer));
      if (entry) entry.banquets.push(b);
    }

    const result = new Map<number, CustomerStats>();
    for (const c of customers) {
      const e = byKey.get(customerKey(c));
      result.set(c.id, e || { reservations: [], banquets: [], lastVisit: undefined });
    }
    return result;
  }, [customers, reservations, banquetMenus]);

  // Group active tables by room for the preferred-table picker. Rooms that
  // contain no visible tables are skipped so the dropdown stays tight.
  const tablesByRoom = useMemo(() => {
    const groups: { roomId: number | null; roomName: string; tables: Table[] }[] = [];
    const visible = tables.filter(t => t && t.id != null);
    const byRoom = new Map<number | null, Table[]>();
    for (const t of visible) {
      const key = (t as any).room_id ?? null;
      if (!byRoom.has(key)) byRoom.set(key, []);
      byRoom.get(key)!.push(t);
    }
    for (const room of rooms) {
      const list = byRoom.get(room.id);
      if (list && list.length > 0) {
        list.sort((a, b) => a.name.localeCompare(b.name, 'it', { numeric: true }));
        groups.push({ roomId: room.id, roomName: room.name, tables: list });
      }
    }
    const orphans = byRoom.get(null);
    if (orphans && orphans.length > 0) {
      orphans.sort((a, b) => a.name.localeCompare(b.name, 'it', { numeric: true }));
      groups.push({ roomId: null, roomName: 'Altri', tables: orphans });
    }
    return groups;
  }, [tables, rooms]);

  const tableLabel = (id: number | null | undefined): string => {
    if (id == null) return '';
    const t = tables.find(x => x.id === id);
    return t ? t.name : `Tav. ${id}`;
  };

  const trimmedSearch = search.trim();
  const isSearching = trimmedSearch.length > 0;

  const marketingCount = useMemo(
    () => customers.filter(c => c.consent_marketing === true).length,
    [customers]
  );

  const filtered = useMemo(() => {
    // Contactable subset first — applies to both the browse and search paths.
    const pool = (marketingOnly && marketingEnabled) ? customers.filter(c => c.consent_marketing === true) : customers;
    if (!isSearching) {
      const base = letterFilter
        ? pool.filter(c => bucketForCustomer(c) === letterFilter)
        : pool;
      return [...base].sort((a, b) =>
        a.name.localeCompare(b.name, 'it', { sensitivity: 'base' })
      );
    }
    const term = foldText(trimmedSearch);
    // Score everyone, keep positives, sort by score DESC then alphabetically.
    // Name uses fuzzy scoring; phone/email/city fall back to substring so
    // typing a phone fragment still works as before.
    const scored: { c: Customer; score: number }[] = [];
    for (const c of pool) {
      const nameFolded = foldText(c.name || '');
      let score = fuzzyNameScore(nameFolded, term);
      if (score === 0) {
        const others = foldText([c.phone, c.email, c.city].filter(Boolean).join(' '));
        if (others.includes(term)) score = 20;
      }
      if (score > 0) scored.push({ c, score });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.c.name.localeCompare(b.c.name, 'it', { sensitivity: 'base' });
    });
    return scored.map(s => s.c);
  }, [customers, trimmedSearch, isSearching, letterFilter, marketingOnly, marketingEnabled]);

  // Set of initials that actually exist across the entire address book.
  // Based on `customers` (not `filtered`) so the strip stays stable while
  // the user cycles through letters: switching letter shouldn't dim the
  // others just because the current filter emptied them out.
  const availableLetters = useMemo(() => {
    const set = new Set<string>();
    for (const c of customers) set.add(bucketForCustomer(c));
    return set;
  }, [customers]);

  const groupedByLetter = useMemo(() => {
    const map = new Map<string, Customer[]>();
    for (const c of filtered) {
      const key = bucketForCustomer(c);
      const arr = map.get(key);
      if (arr) arr.push(c);
      else map.set(key, [c]);
    }
    return map;
  }, [filtered]);

  // Typing a search clears the letter filter so the two selection
  // mechanisms don't compound each other silently.
  useEffect(() => {
    if (isSearching && letterFilter) setLetterFilter(null);
  }, [isSearching, letterFilter]);

  const openCreate = () => {
    setForm(emptyForm);
    setFormOpen(true);
  };

  const openEdit = (c: Customer) => {
    setForm(customerToForm(c));
    setFormOpen(true);
  };

  useEffect(() => {
    if (!autoEditByPhone || customers.length === 0) return;
    const normalize = (s: string): string => s.replace(/[^\d+]/g, '');
    const target = normalize(autoEditByPhone);
    if (!target) { onAutoEditHandled?.(); return; }
    const match = customers.find(c => c.phone && normalize(c.phone) === target);
    if (match) {
      openEdit(match);
    } else {
      showToast('Cliente non trovato in rubrica', 'info');
    }
    onAutoEditHandled?.();
  }, [autoEditByPhone, customers]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.phone.trim()) return;
    setIsSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim() || null,
        address: form.address.trim() || null,
        city: form.city.trim() || null,
        postal_code: form.postal_code.trim() || null,
        notes: form.notes.trim() || null,
        preferred_table_id: form.preferred_table_id,
        preferences_notes: form.preferences_notes.trim() || null,
        dietary_notes: form.dietary_notes.trim() || null,
        is_vip: form.is_vip,
        is_blacklisted: form.is_blacklisted,
        blacklist_reason: form.blacklist_reason.trim() || null,
        billing: {
          name: form.billing_name.trim(),
          vat_number: form.billing_vat.trim(),
          tax_code: form.billing_cf.trim(),
          sdi_code: form.billing_sdi.trim(),
          pec: form.billing_pec.trim(),
          address: {
            street: form.billing_street.trim(),
            zip: form.billing_zip.trim(),
            city: form.billing_city.trim(),
            province: form.billing_province.trim(),
          },
        },
      };
      if (form.id) {
        const updated = await updateCustomer(form.id, payload);
        setCustomers(prev => prev.map(c => c.id === updated.id ? updated : c));
        showToast('Cliente aggiornato', 'success');
      } else {
        const created = await createCustomer(payload);
        setCustomers(prev => [...prev, created]);
        showToast('Cliente aggiunto alla rubrica', 'success');
      }
      setFormOpen(false);
    } catch (err: any) {
      // Phone conflict: another customer already owns this number. Offer to
      // merge (only when editing an existing record — on create there is no
      // source row yet, so we just point the user at the existing customer).
      if (err?.status === 409 && err?.data?.existing_customer_id) {
        setConflictPrompt({
          sourceId: form.id ?? null,
          sourceName: form.name.trim(),
          targetId: err.data.existing_customer_id,
          targetName: err.data.existing_customer_name || 'cliente esistente',
        });
      } else {
        showToast(err?.message || 'Errore salvataggio cliente', 'error');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteCustomer(id);
      setCustomers(prev => prev.filter(c => c.id !== id));
      setConfirmDeleteId(null);
      if (detailCustomer?.id === id) setDetailCustomer(null);
      showToast('Cliente eliminato', 'info');
    } catch (err: any) {
      showToast(err?.message || 'Errore eliminazione cliente', 'error');
    }
  };

  /* ── Cifre della scheda ─────────────────────────────────────────────────
     Prenotazioni, media coperti e no-show: le tre che il dato regge davvero.
     "Speso totale" del mockup resta fuori — reservation.total_amount esiste
     in types.ts e in db.ts ma in tutta l'applicazione non lo scrive e non lo
     legge nessuno, quindi la card avrebbe mostrato € 0,00 a ogni cliente, che
     è peggio di una card in meno. Stessa ragione per la colonna € nello
     storico e per la riga "Conto aperto". */
  const figuresFor = (c: Customer) => {
    const s = stats.get(c.id);
    const list = s?.reservations ?? [];
    const covers = list.reduce((sum, r) => sum + (r.guests || 0), 0);
    return {
      reservations: list.length,
      banquets: s?.banquets.length ?? 0,
      avgCovers: list.length ? covers / list.length : 0,
      noShow: c.no_show_count ?? 0,
      lastVisit: s?.lastVisit,
    };
  };

  /* ── Pastiglia con le iniziali ──────────────────────────────────────────
     VIP è un anello d'oro attorno al cerchio più una stella appoggiata in alto
     a destra, non una stellina accanto al nome: a colpo d'occhio su una lista
     lunga il cerchio si distingue, un glifo da 14px in mezzo al testo no.
     L'oro è --ds-pending-solid, che il design system chiama "the reference
     gold"; l'anello chiaro attorno alla stella è del colore della card, così
     interrompe l'anello d'oro e la stella sembra appoggiata sopra invece che
     incollata dentro. */
  const CustomerAvatar: React.FC<{ name: string; vip?: boolean; size?: 'md' | 'lg' }> = ({ name, vip, size = 'md' }) => {
    const initials = (name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(w => w[0])
      .join('')
      .toUpperCase();
    return (
      <div className="relative flex-shrink-0">
        <div
          className={`flex items-center justify-center rounded-full font-semibold ${
            size === 'lg' ? 'h-12 w-12 text-[15px]' : 'h-10 w-10 text-[13px]'
          } ${
            vip
              ? 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] ring-2 ring-[var(--ds-pending-solid)]'
              : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]'
          }`}
        >
          {initials || '—'}
        </div>
        {vip && (
          <span
            title="Cliente VIP"
            aria-label="Cliente VIP"
            className="absolute -right-0.5 -top-0.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--ds-pending-solid)] ring-2 ring-[var(--ds-surface)]"
          >
            <Star className="h-2.5 w-2.5 fill-[#ffffff] text-[#ffffff]" aria-hidden />
          </span>
        )}
      </div>
    );
  };

  // Stessa soglia di SplitPane: sopra, la scheda è una colonna accanto alla
  // lista e il puntatore è un mouse, che non scorre le righe.
  const isWide = useMediaQuery('(min-width: 768px)');

  /* Il menu "…" della scheda. Modifica ed elimina stavano come icone sole in
     testa alla card e, sotto md, come barra in fondo: due posti diversi per le
     stesse due azioni, e il cestino a un dito dal nome. Ora stanno dietro un
     solo bottone, dove elimina è staccata in fondo e in rosso invece che
     appoggiata accanto alla matita. */
  const [cardMenuOpen, setCardMenuOpen] = useState(false);
  const cardMenuRef = useRef<HTMLDivElement | null>(null);
  const cardMenuTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!cardMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!cardMenuRef.current?.contains(t) && !cardMenuTriggerRef.current?.contains(t)) setCardMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCardMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [cardMenuOpen]);

  // Il menu appartiene alla scheda aperta: cambiando cliente si chiude, o
  // resterebbe aperto puntando a qualcun altro.
  useEffect(() => { setCardMenuOpen(false); }, [detailCustomer?.id]);
  const swipeHint = useFirstRunHint('ristocrm_clienti_swipe');

  /* Le due azioni di contatto, tonde e senza etichetta. Erano due bottoni a
     tutta larghezza sotto il nome: occupavano la riga più preziosa della
     scheda per dire due cose che la cornetta e il fumetto dicono da sole.
     Chiamare è la primaria e prende il pieno scuro; WhatsApp resta quieto nel
     verde della famiglia "seduto". */
  const contactButtons = (c: Customer) => {
    if (!c.phone) return null;
    return (
      <>
        <a
          href={telHref(c.phone)}
          title={`Chiama ${c.phone}`}
          aria-label={`Chiama ${toTitleCase(c.name)}`}
          className="inline-flex aspect-square h-11 w-11 flex-none items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          <Phone className="h-4 w-4" aria-hidden />
        </a>
        <a
          href={waHref(c.phone)}
          target="_blank"
          rel="noreferrer"
          title={`Scrivi su WhatsApp a ${c.phone}`}
          aria-label={`Scrivi su WhatsApp a ${toTitleCase(c.name)}`}
          className="inline-flex aspect-square h-11 w-11 flex-none items-center justify-center rounded-full bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          <MessageCircle className="h-4 w-4" aria-hidden />
        </a>
      </>
    );
  };

  /* Le voci del menu della scheda, una lista sola per il dropdown e per il
     foglio. "Unisci duplicati" compare solo per chi un duplicato ce l'ha
     davvero: altrove sarebbe una voce che apre un elenco in cui questa persona
     non c'è. */
  const cardMenuActions = (c: Customer) => {
    const hasDuplicate = duplicateGroups.some(g => g.customers.some(x => x.id === c.id));
    return [
      { key: 'edit', label: 'Modifica scheda', icon: Pencil, run: () => openEdit(c) },
      ...(hasDuplicate
        ? [{ key: 'merge', label: 'Unisci duplicati', icon: GitMerge, run: () => setDuplicatesOpen(true) }]
        : []),
      { key: 'sep', separator: true as const },
      { key: 'delete', label: 'Elimina cliente', icon: Trash2, danger: true, run: () => setConfirmDeleteId(c.id) },
    ];
  };

  const cardMenuItem =
    'flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] transition-colors hover:bg-[var(--ds-surface-row)]';


  const cardMenuTrigger = (c: Customer) => {
    if (!canEdit) return null;
    return (
      <div className="relative flex-shrink-0">
        <button
          ref={cardMenuTriggerRef}
          type="button"
          onClick={() => setCardMenuOpen(v => !v)}
          aria-haspopup="menu"
          aria-expanded={cardMenuOpen}
          aria-label={`Altre azioni su ${toTitleCase(c.name)}`}
          title="Altre azioni"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {/* Una tendina ancorata al bottone a ogni larghezza, come la scheda di
            Personale: il menu è corto e la card sta in alto, quindi non serve
            il foglio dal basso nemmeno col pollice. */}
        {cardMenuOpen && (
          <div
            ref={cardMenuRef}
            role="menu"
            className="absolute right-0 top-full z-30 mt-2 w-[236px] overflow-hidden rounded-[20px] bg-[var(--ds-surface)] py-1.5 shadow-[var(--ds-shadow-raised)]"
          >
            {cardMenuActions(c).map(a =>
              'separator' in a ? (
                <div key={a.key} className="my-1.5 h-px bg-[var(--ds-border)]" />
              ) : (
                <button
                  key={a.key}
                  type="button"
                  role="menuitem"
                  onClick={() => { setCardMenuOpen(false); a.run(); }}
                  className={`${cardMenuItem} ${a.danger ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-primary)]'}`}
                >
                  <a.icon className={`h-4 w-4 flex-shrink-0 ${a.danger ? '' : 'text-[var(--ds-text-muted)]'}`} aria-hidden />
                  {a.label}
                </button>
              )
            )}
          </div>
        )}
      </div>
    );
  };

  const telHref = (phone: string): string => `tel:${phone.replace(/\s+/g, '')}`;

  /* wa.me vuole cifre e basta, prefisso internazionale incluso e senza il +.
     Col + davanti il prefisso c'è già; senza, il numero in rubrica è quasi
     sempre italiano scritto come lo si detta al telefono. */
  const waHref = (phone: string): string => {
    const raw = phone.trim();
    const digits = raw.replace(/\D/g, '');
    const full = raw.startsWith('+') || digits.startsWith('39')
      ? digits
      : `39${digits.replace(/^0+/, '')}`;
    return `https://wa.me/${full}`;
  };

  // Passo corrente del form. Torna sempre al primo quando il modale si apre:
  // riaprirlo e ritrovarsi a metà di una compilazione precedente disorienta.
  const [step, setStep] = useState(0);
  useEffect(() => { if (formOpen) setStep(0); }, [formOpen]);

  const canSave = form.name.trim().length > 0 && form.phone.trim().length > 0;

  // Dalla ricerca a vuoto: il nome già digitato diventa il nome del nuovo
  // cliente. È il caso del cliente al telefono in questo momento.
  const createFromSearch = () => {
    setForm({ ...emptyForm, name: trimmedSearch });
    setFormOpen(true);
  };

  // La primissima riga a schermo, qualunque ramo la stia disegnando: è quella
  // che porta il richiamo del gesto.
  const firstRowId = filtered[0]?.id;

  /* Cambiando ricerca o lettera la colonna torna in cima. Senza, si scendeva
     in fondo alla rubrica, si digitava un nome e il risultato — magari uno
     solo — restava fuori campo sopra o sotto: la lista si accorciava ma lo
     scorrimento no, e sembrava che la ricerca non avesse trovato niente.
     Il contenitore che scorre non è sempre lo stesso — sotto md è l'intera
     colonna, sopra è il riquadro della lista, e in entrambi i casi appartiene
     a SplitPane — quindi lo si cerca risalendo dal primo nodo della lista. */
  const listTopRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let node = listTopRef.current?.parentElement ?? null;
    while (node) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        if (node.scrollTop !== 0) node.scrollTop = 0;
        return;
      }
      node = node.parentElement;
    }
  }, [trimmedSearch, letterFilter]);

  const sortedLetters = useMemo(() => (
    Array.from(groupedByLetter.keys()).sort((a, b) => {
      if (a === '#') return 1;
      if (b === '#') return -1;
      return a.localeCompare(b);
    })
  ), [groupedByLetter]);

  /* Le pastiglie della barra: Duplicati, Marketing ed Esporta. h-9 come i
     segmenti del SegmentedControl — sono comandi di secondo piano sopra la
     lista, non le azioni della pagina. */
  const chip = 'inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

  /* ── Riga della lista ───────────────────────────────────────────────────
     La scheda intera apre il dettaglio, e il numero è l'unica eccezione
     cliccabile. Un <a> dentro un <button> non è HTML valido, quindi il
     bersaglio grande è un bottone in posizione assoluta sotto il contenuto:
     il contenuto è pointer-events-none e lascia passare il clic, il numero se
     lo riprende. Niente matita e niente cestino qui — su duemila contatti due
     bersagli da 28px accanto al nome sono una cancellazione per sbaglio che
     aspetta di succedere. Modifica ed elimina vivono nel dettaglio, dove hai
     il contesto per decidere. */
  const renderRow = (c: Customer) => {
    const f = figuresFor(c);
    const active = detailCustomer?.id === c.id;
    // Col telefono in mano la riga si scorre: a destra si chiama, a sinistra
    // si apre WhatsApp. Il bottone verde fisso se ne va — occupava un angolo
    // di ogni riga per un gesto che il pollice fa già da solo. Solo sotto md e
    // solo se c'è un numero: senza, non ci sarebbe niente da rivelare.
    // .trim(): un numero fatto di soli spazi passava il controllo e apriva due
    // azioni che non avrebbero chiamato nessuno.
    const swipeable = !isWide && !!c.phone?.trim();
    const card = (
      <div
        // ring-inset, non ring: l'anello esterno cade fuori dal box della card
        // e la colonna che scorre lo taglia ai due lati, perché overflow-y su
        // un contenitore ritaglia anche in orizzontale. Disegnato dentro, il
        // bordo resta intero. Dentro SwipeRow l'ombra e il raggio li mette il
        // contenitore, sennò si sommano.
        className={`relative bg-[var(--ds-surface)] ${
          swipeable ? '' : 'rounded-[18px] shadow-[var(--ds-shadow-card)] transition-shadow'
        } ${
          active
            ? 'ring-2 ring-inset ring-[var(--ds-action-bg)]'
            : swipeable ? '' : 'hover:shadow-[var(--ds-shadow-raised)]'
        }`}
      >
        <button
          type="button"
          onClick={() => setDetailCustomer(c)}
          aria-label={`Apri la scheda di ${toTitleCase(c.name)}`}
          className="absolute inset-0 rounded-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)]"
        />
        <div className="pointer-events-none relative flex items-center gap-3 p-3">
          <CustomerAvatar name={c.name} vip={c.is_vip} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              {c.is_blacklisted && <Ban className="h-3.5 w-3.5 flex-shrink-0 text-[var(--ds-critical-text)]" aria-label="Blacklist" />}
              <span className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
                {toTitleCase(c.name)}
              </span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] text-[var(--ds-text-muted)]">
              {c.phone ? (
                <a
                  href={telHref(c.phone)}
                  className="pointer-events-auto truncate tabular-nums transition-colors hover:text-[var(--ds-text-primary)] hover:underline"
                  title={`Chiama ${c.phone}`}
                >
                  {c.phone}
                </a>
              ) : (
                <span className="truncate">Senza numero</span>
              )}
              {f.reservations > 0 && (
                <span className="flex-shrink-0 whitespace-nowrap">· {f.reservations} prenot.</span>
              )}
            </div>
          </div>
        </div>
      </div>
    );

    if (!swipeable) return <React.Fragment key={c.id}>{card}</React.Fragment>;

    return (
      <SwipeRow
        key={c.id}
        // `left` è ciò che si scopre scorrendo verso destra, `right` scorrendo
        // verso sinistra: chiamare a destra, WhatsApp a sinistra.
        // flex-shrink-0 sulle icone: il pannello che si scopre è largo 112px
        // fissi e "WhatsApp" è una parola che non si spezza — senza, la riga
        // va in overstretch e l'unica cosa che può cedere è l'svg, che si
        // schiaccia fino a sparire. "Chiama" è più corta e ci stava, ed è per
        // questo che il telefono si vedeva e il fumetto no.
        left={{
          label: 'Chiama',
          icon: <Phone className="h-4 w-4 flex-shrink-0" aria-hidden />,
          tone: 'primary',
          onAction: () => { window.location.href = telHref(c.phone!); },
        }}
        right={{
          label: 'WhatsApp',
          icon: <MessageCircle className="h-4 w-4 flex-shrink-0" aria-hidden />,
          tone: 'confirm',
          onAction: () => { window.open(waHref(c.phone!), '_blank', 'noopener,noreferrer'); },
        }}
        // Il richiamo parte una volta sola, sulla prima riga dell'elenco: serve
        // a dire che il gesto esiste, non a ripeterlo a ogni scheda.
        hint={swipeHint && c.id === firstRowId}
      >
        {card}
      </SwipeRow>
    );
  };

  /* Lettera accesa nell'indice: quella scelta col dito, oppure — mentre si
     scorre — quella del gruppo che sta passando in cima alla colonna, così
     l'indice dice sempre dove sei nella rubrica e non solo dove hai toccato. */
  const [visibleLetter, setVisibleLetter] = useState<string | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  const registerSection = useCallback((letter: string) => (el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(letter, el);
    else sectionRefs.current.delete(letter);
  }, []);

  useEffect(() => {
    // Con una ricerca o una lettera già scelta non c'è niente da seguire: la
    // colonna mostra un gruppo solo.
    if (isSearching || letterFilter) { setVisibleLetter(null); return; }
    const els = Array.from(sectionRefs.current.values());
    if (els.length === 0) return;
    // La fascia di osservazione è una striscia sottile in cima alla colonna:
    // il gruppo che la attraversa è quello che si sta leggendo. Le
    // intestazioni sono sticky e restano incollate lassù, quindi si osservano
    // le sezioni, non le intestazioni.
    const io = new IntersectionObserver(
      entries => {
        const top = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setVisibleLetter((top.target as HTMLElement).dataset.letter ?? null);
      },
      { rootMargin: '-140px 0px -78% 0px' }
    );
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, [sortedLetters, isSearching, letterFilter]);

  const highlightedLetter = letterFilter ?? visibleLetter;

  const pickLetter = (letter: string) => {
    // Toccare una lettera mentre si cerca svuota la ricerca invece di non fare
    // niente: le due selezioni si escludono a vicenda (l'effetto più sotto
    // azzera la lettera appena si digita), e un comando visibile che non
    // risponde è peggio di un comando nascosto.
    if (isSearching) setSearch('');
    setLetterFilter(letterFilter === letter ? null : letter);
  };

  /* La scatola è alta quanto la colonna visibile — 13rem è quello che si
     prendono barra in alto, ricerca e pastiglie — e le lettere ci stanno
     dentro centrate. Prima era un top in vh su un elemento sticky, ma su un
     elemento sticky l'offset si misura dalla cima della zona che scorre, non
     da quella della finestra: sommato ai pixel che stanno sopra, spingeva
     l'indice sotto il bordo inferiore e le ultime lettere sparivano. Con
     un'altezza che segue la finestra il centro cade dove deve a ogni statura
     di schermo. */
  /* Due ancoraggi, uno per breakpoint, perché sono due impaginazioni diverse.
     Da md in su la colonna ha la sua zona di scorrimento e la barra di ricerca
     sta ferma fuori: l'indice parte da zero. Sotto md scorre tutta la colonna
     e la barra è sticky dentro la stessa zona, sopra l'indice — con top-0 le
     prime lettere finivano dietro la ricerca e le pastiglie. L'offset è
     l'altezza di quella barra, e l'altezza della scatola scala di conseguenza
     così l'indice non sfora in fondo. */
  const alphabetRail = (
    <div className="sticky top-[6.75rem] flex h-[calc(100dvh-10rem)] flex-shrink-0 items-center self-start md:top-0 md:h-[calc(100dvh-13rem)]">
      <nav aria-label="Indice alfabetico" className="flex flex-col items-center">
        {ALPHABET.map(letter => {
          const has = availableLetters.has(letter);
          const active = highlightedLetter === letter;
          return (
            <button
              key={letter}
              type="button"
              onClick={() => has && pickLetter(letter)}
              disabled={!has}
              aria-pressed={letterFilter === letter}
              aria-label={
                has
                  ? letterFilter === letter
                    ? `Rimuovi filtro lettera ${letter}`
                    : `Filtra per lettera ${letter}`
                  : `Nessun cliente con lettera ${letter}`
              }
              className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px] font-semibold leading-none tabular-nums transition-colors ${
                active
                  ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                  : has
                    ? 'text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]'
                    : 'text-[var(--ds-text-subtle)] opacity-40'
              }`}
            >
              {letter}
            </button>
          );
        })}
      </nav>
    </div>
  );

  /* pt-1 fino a lg: la fascia della barra parte incollata al bordo alto della
     colonna, che sotto md è anche il bordo di ciò che scorre e quindi ritaglia.
     L'anello di focus del campo di ricerca sporge di 2px sopra il suo box e
     finiva tagliato di netto. Da lg in su lo spazio ce lo mette già SplitPane. */
  const toolbar = (
    <div className="space-y-2.5 pt-1 lg:pt-0">
      {/* Solo la ricerca. Un cliente si crea dal "+" della barra in alto, che
          è globale e sta sopra ogni pagina, oppure dalla ricerca a vuoto — che
          è il momento in cui serve davvero, col cliente al telefono. */}
      <SearchField
        value={search}
        onChange={setSearch}
        placeholder="Nome, telefono…"
        ariaLabel="Cerca cliente"
      />

      {(( canEdit && duplicateGroups.length > 0) || (marketingEnabled && marketingCount > 0)) && (
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && duplicateGroups.length > 0 && (
            <button
              type="button"
              onClick={() => setDuplicatesOpen(true)}
              title="Clienti con lo stesso numero di telefono"
              className={`${chip} bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] hover:opacity-80`}
            >
              <GitMerge className="h-4 w-4" aria-hidden />
              Duplicati
              <CountBadge count={duplicatesCount} />
            </button>
          )}
          {marketingEnabled && marketingCount > 0 && (
            <>
              <button
                type="button"
                onClick={() => setMarketingOnly(v => !v)}
                aria-pressed={marketingOnly}
                title="Mostra solo i clienti con consenso marketing (contattabili)"
                className={`${chip} ${
                  marketingOnly
                    ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                    : 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] hover:opacity-80'
                }`}
              >
                <Mail className="h-4 w-4" aria-hidden />
                Marketing
                <CountBadge count={marketingCount} />
              </button>
              {canEdit && (
                <button
                  type="button"
                  onClick={exportMarketingRecipients}
                  disabled={exporting}
                  title="Esporta i destinatari con consenso marketing (CSV)"
                  className={`${chip} bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] hover:text-[var(--ds-text-primary)] disabled:opacity-50`}
                >
                  {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" aria-hidden />}
                  Esporta
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );

  const list = (
    <>
      <div ref={listTopRef} aria-hidden />
      {error && (
        <Callout tone="critical" icon={AlertTriangle} className="mb-3">
          {error}
        </Callout>
      )}

      {/* L'indice sta fuori da tutti i rami: qualunque cosa mostri la colonna
          — caricamento, vuoto, ricerca, lettera scelta — resta al suo posto. */}
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="space-y-2" aria-hidden>
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 rounded-[18px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)] motion-safe:animate-pulse">
                  <div className="h-10 w-10 flex-shrink-0 rounded-full bg-[var(--ds-surface-row)]" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="h-3.5 w-2/5 rounded-full bg-[var(--ds-surface-row)]" />
                    <div className="h-3 w-3/5 rounded-full bg-[var(--ds-surface-row)]" />
                  </div>
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={isSearching ? Search : BookUser}
              action={isSearching && canEdit ? (
                <button type="button" onClick={createFromSearch} className={dsButton.primary}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Crea «{trimmedSearch}»
                </button>
              ) : undefined}
            >
              <span className="block text-[15px] font-semibold text-[var(--ds-text-primary)]">
                {isSearching ? 'Nessun cliente con questo nome' : 'La rubrica è vuota'}
              </span>
              <span className="mt-1 block">
                {isSearching
                  ? 'Se è al telefono adesso, aggiungilo con il nome già scritto e completa il resto dopo.'
                  : 'I clienti salvati dalle prenotazioni compaiono qui.'}
              </span>
            </EmptyState>
          ) : isSearching ? (
            // Solo in ricerca niente intestazioni: l'ordine è per pertinenza e
            // le lettere, mescolate, smetterebbero di voler dire qualcosa.
            <div className="space-y-2">{filtered.map(renderRow)}</div>
          ) : (
            // Con una lettera scelta il ramo è lo stesso: resta un gruppo solo,
            // che si porta dietro la sua intestazione e il suo conteggio.
            <div className="space-y-4">
              {sortedLetters.map(letter => {
                const group = groupedByLetter.get(letter)!;
                return (
                  <section key={letter} ref={registerSection(letter)} data-letter={letter}>
                    <div
                      id={`cust-letter-${letter}`}
                      className="sticky top-0 z-[1] mb-2 flex items-center gap-2 bg-[var(--ds-canvas)] py-1.5"
                    >
                      <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[12px] font-semibold text-[var(--ds-action-fg)]">
                        {letter}
                      </span>
                      <span className="text-[13px] text-[var(--ds-text-muted)]">
                        {group.length} client{group.length === 1 ? 'e' : 'i'}
                      </span>
                    </div>
                    <div className="space-y-2">{group.map(renderRow)}</div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
        {alphabetRail}
      </div>
    </>
  );

  /* ── Scheda ─────────────────────────────────────────────────────────────
     Di sola lettura: si guarda, si chiama, e per cambiare qualcosa si apre il
     form, che è l'unico posto dove si scrive un cliente — sia che lo si stia
     creando sia che lo si stia correggendo. */
  const renderDetail = (c: Customer) => {
    const f = figuresFor(c);
    const s = stats.get(c.id);
    const sortedReservations = [...(s?.reservations ?? [])].sort(
      (a, b) => b.reservation_time.localeCompare(a.reservation_time)
    );
    const sortedBanquets = [...(s?.banquets ?? [])].sort(
      (a, b) => (b.event_date || '').localeCompare(a.event_date || '')
    );
    const hasAddress = !!(c.address || c.city || c.postal_code);

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex-shrink-0 px-4 pb-4 pt-4 sm:px-6 lg:px-8">
          <div className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
            {/* items-center: sotto il nome non c'è più niente, quindi la riga
                è alta quanto la pastiglia e il nome le va incontro a metà
                invece di restare appeso in alto. Quello che c'è da dire in più
                — tavolo, allergie, consenso — scende sulla riga sotto, a
                tutta larghezza. */}
            <div className="flex items-center gap-3">
              {/* Il ritorno all'elenco apre la riga, come nella scheda di
                  Personale: sotto md questa card copre la lista, e la freccia
                  in testa è dove si va a cercarla. Sul desktop la lista è già
                  lì accanto. */}
              <button
                type="button"
                onClick={() => setDetailCustomer(null)}
                aria-label="Torna all'elenco clienti"
                className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] md:hidden"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <CustomerAvatar name={c.name} vip={c.is_vip} size="lg" />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[19px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
                  {toTitleCase(c.name)}
                </h2>
                {/* Tavolo, allergie e consenso stanno in colonna col nome, non
                    sotto la pastiglia: sono attributi di questa persona, e
                    rientrati come il nome si leggono come una cosa sola invece
                    che come una riga a sé che ricomincia dal bordo. */}
                {(c.is_blacklisted || c.preferred_table_id != null || (c.dietary_notes && c.dietary_notes.trim()) || (marketingEnabled && c.consent_marketing === true)) && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {c.is_blacklisted && (
                      <span title={c.blacklist_reason || undefined}>
                        <StatusPill tone="critical"><Ban className="h-3 w-3" aria-hidden />Blacklist</StatusPill>
                      </span>
                    )}
                    {c.preferred_table_id != null && (
                      <StatusPill><Armchair className="h-3 w-3" aria-hidden />{tableLabel(c.preferred_table_id)}</StatusPill>
                    )}
                    {c.dietary_notes && c.dietary_notes.trim() && (
                      <StatusPill tone="critical" title={c.dietary_notes}>
                        <AlertTriangle className="h-3 w-3" aria-hidden />
                        <span className="max-w-[14rem] truncate">{c.dietary_notes}</span>
                      </StatusPill>
                    )}
                    {marketingEnabled && c.consent_marketing === true && (
                      <StatusPill tone="positive"><Mail className="h-3 w-3" aria-hidden />Marketing</StatusPill>
                    )}
                  </div>
                )}
              </div>
              {/* Da md in su il numero e i suoi due bottoni stanno qui, sulla
                  riga del nome: c'è larghezza, e chiamare è la cosa che si fa
                  più spesso da questa scheda. Sotto md scendono sotto una
                  riga, dove il numero ci sta per intero. */}
              {c.phone && (
                <div className="hidden flex-shrink-0 items-center gap-2 md:flex">
                  <span className="text-[16px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                    {c.phone}
                  </span>
                  {contactButtons(c)}
                </div>
              )}
              {c.phone && canEdit && (
                <span className="hidden h-6 w-px flex-shrink-0 bg-[var(--ds-border)] md:block" aria-hidden />
              )}
              {cardMenuTrigger(c)}
            </div>

            {c.phone && (
              <div className="mt-3 flex items-center gap-2 border-t border-[var(--ds-border)] pt-3 md:hidden">
                <span className="min-w-0 flex-1 truncate text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                  {c.phone}
                </span>
                {contactButtons(c)}
              </div>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4 sm:px-6 lg:px-8">
          <StatStrip
            layout="stacked"
            stats={[
              { value: f.reservations, label: 'prenotazioni' },
              {
                value: f.avgCovers ? f.avgCovers.toLocaleString('it-IT', { maximumFractionDigits: 1 }) : '—',
                label: 'coperti medi',
              },
              { value: f.noShow, label: 'no-show', tone: f.noShow > 0 ? 'critical' : 'neutral' },
            ]}
          />

          {(c.email || hasAddress || c.notes) && (
            <div className="space-y-3 rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
              {c.email && (
                <div className="flex items-start gap-2.5 text-[15px]">
                  <Mail className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                  <a href={`mailto:${c.email}`} className="min-w-0 truncate text-[var(--ds-text-primary)] hover:underline">
                    {c.email}
                  </a>
                </div>
              )}
              {hasAddress && (
                <div className="flex items-start gap-2.5 text-[15px]">
                  <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                  <div className="min-w-0 text-[var(--ds-text-primary)]">
                    {c.address && <div className="truncate">{c.address}</div>}
                    {(c.postal_code || c.city) && (
                      <div className="truncate text-[var(--ds-text-muted)]">
                        {[c.postal_code, c.city].filter(Boolean).join(' ')}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {c.notes && (
                <p className="whitespace-pre-wrap text-[14px] text-[var(--ds-text-secondary)]">{c.notes}</p>
              )}
            </div>
          )}

          <div className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
            <div className="mb-3 flex items-center gap-2">
              <History className="h-4 w-4 text-[var(--ds-text-muted)]" aria-hidden />
              <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
                Storico prenotazioni
              </h3>
              {sortedReservations.length > 0 && <CountBadge count={sortedReservations.length} />}
            </div>
            {sortedReservations.length === 0 ? (
              <p className="py-2 text-[14px] text-[var(--ds-text-muted)]">Nessuna prenotazione registrata.</p>
            ) : (
              <ul className="divide-y divide-[var(--ds-border)]">
                {sortedReservations.map(r => {
                  const { date, time } = formatReservationDateTime(r.reservation_time);
                  const isLunch = r.shift === Shift.LUNCH;
                  return (
                    <li key={r.id} className="flex items-center gap-2.5 py-2.5">
                      {isLunch
                        ? <Sun className="h-4 w-4 flex-shrink-0 text-[var(--ds-pending-text)]" aria-label="Pranzo" />
                        : <Moon className="h-4 w-4 flex-shrink-0 text-[var(--ds-arriving-text)]" aria-label="Cena" />}
                      <span className="flex-shrink-0 text-[15px] font-medium tabular-nums text-[var(--ds-text-primary)]">{date}</span>
                      <span className="flex-shrink-0 text-[15px] tabular-nums text-[var(--ds-text-muted)]">{time}</span>
                      <span className="ml-auto inline-flex flex-shrink-0 items-center gap-1 text-[14px] tabular-nums text-[var(--ds-text-secondary)]">
                        <UsersIcon className="h-3.5 w-3.5" aria-hidden />
                        {r.guests} cop.
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {sortedBanquets.length > 0 && (
            <div className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
              <div className="mb-3 flex items-center gap-2">
                <UtensilsCrossed className="h-4 w-4 text-[var(--ds-text-muted)]" aria-hidden />
                <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">Banchetti</h3>
                <CountBadge count={sortedBanquets.length} />
              </div>
              <ul className="divide-y divide-[var(--ds-border)]">
                {sortedBanquets.map(b => (
                  <li key={b.id} className="flex items-center gap-2.5 py-2.5">
                    <Calendar className="h-4 w-4 flex-shrink-0 text-[var(--ds-seated-text)]" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[15px] text-[var(--ds-text-primary)]">{b.name}</span>
                    {b.event_date && (
                      <span className="flex-shrink-0 text-[14px] tabular-nums text-[var(--ds-text-muted)]">
                        {b.event_date.split('-').reverse().join('/')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    );
  };

  const stepFields = step === 0 ? (
    <FormCard title="Contatto">
      <div className="space-y-4">
        <Field label="Nome" htmlFor="cust-name" required>
          <input
            id="cust-name"
            type="text"
            autoFocus
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className={dsInput}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Telefono" htmlFor="cust-phone" required>
            <input
              id="cust-phone"
              type="tel"
              value={form.phone}
              onChange={e => setForm({ ...form, phone: e.target.value })}
              className={`${dsInput} tabular-nums`}
            />
          </Field>
          <Field label="Email" htmlFor="cust-email">
            <input
              id="cust-email"
              type="email"
              placeholder="nome@dominio.it"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              className={dsInput}
            />
          </Field>
        </div>
        <Field label="Indirizzo" htmlFor="cust-address">
          <input
            id="cust-address"
            type="text"
            placeholder="Via, numero"
            value={form.address}
            onChange={e => setForm({ ...form, address: e.target.value })}
            className={dsInput}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Città" htmlFor="cust-city" className="sm:col-span-2">
            <input
              id="cust-city"
              type="text"
              placeholder="Città"
              value={form.city}
              onChange={e => setForm({ ...form, city: e.target.value })}
              className={dsInput}
            />
          </Field>
          <Field label="CAP" htmlFor="cust-cap">
            <input
              id="cust-cap"
              type="text"
              placeholder="00000"
              value={form.postal_code}
              onChange={e => setForm({ ...form, postal_code: e.target.value })}
              className={`${dsInput} tabular-nums`}
            />
          </Field>
        </div>

        {/* Dati di fatturazione: alimentano il cessionario della fattura
            elettronica dal conto. Chiusi in un details perché servono a
            pochi clienti (le aziende) e non devono allungare la scheda di
            tutti gli altri. */}
        <details className="group rounded-[16px] bg-[var(--ds-surface-row)] p-3">
          <summary className="cursor-pointer select-none text-[14px] font-medium text-[var(--ds-text-primary)] list-none [&::-webkit-details-marker]:hidden">
            Dati fatturazione
            <span className="ml-2 text-[13px] font-normal text-[var(--ds-text-muted)]">
              {form.billing_vat || form.billing_cf ? (form.billing_vat ? `P.IVA ${form.billing_vat}` : `CF ${form.billing_cf}`) : 'per la fattura elettronica'}
            </span>
          </summary>
          <div className="mt-3 space-y-3">
            <Field label="Denominazione" htmlFor="cust-bill-name">
              <input
                id="cust-bill-name"
                type="text"
                placeholder="Ragione sociale o nome e cognome"
                value={form.billing_name}
                onChange={e => setForm({ ...form, billing_name: e.target.value })}
                className={dsInput}
              />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="P.IVA" htmlFor="cust-bill-vat">
                <input
                  id="cust-bill-vat"
                  type="text"
                  inputMode="numeric"
                  value={form.billing_vat}
                  onChange={e => setForm({ ...form, billing_vat: e.target.value })}
                  className={`${dsInput} tabular-nums`}
                />
              </Field>
              <Field label="Codice fiscale" htmlFor="cust-bill-cf">
                <input
                  id="cust-bill-cf"
                  type="text"
                  value={form.billing_cf}
                  onChange={e => setForm({ ...form, billing_cf: e.target.value.toUpperCase() })}
                  className={dsInput}
                />
              </Field>
              <Field label="Codice SDI" htmlFor="cust-bill-sdi">
                <input
                  id="cust-bill-sdi"
                  type="text"
                  maxLength={7}
                  value={form.billing_sdi}
                  onChange={e => setForm({ ...form, billing_sdi: e.target.value.toUpperCase() })}
                  className={dsInput}
                />
              </Field>
              <Field label="PEC" htmlFor="cust-bill-pec">
                <input
                  id="cust-bill-pec"
                  type="email"
                  value={form.billing_pec}
                  onChange={e => setForm({ ...form, billing_pec: e.target.value })}
                  className={dsInput}
                />
              </Field>
            </div>
            <Field label="Indirizzo sede" htmlFor="cust-bill-street">
              <input
                id="cust-bill-street"
                type="text"
                value={form.billing_street}
                onChange={e => setForm({ ...form, billing_street: e.target.value })}
                className={dsInput}
              />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <Field label="CAP" htmlFor="cust-bill-zip">
                <input
                  id="cust-bill-zip"
                  type="text"
                  inputMode="numeric"
                  value={form.billing_zip}
                  onChange={e => setForm({ ...form, billing_zip: e.target.value })}
                  className={`${dsInput} tabular-nums`}
                />
              </Field>
              <Field label="Comune" htmlFor="cust-bill-city" className="sm:col-span-2">
                <input
                  id="cust-bill-city"
                  type="text"
                  value={form.billing_city}
                  onChange={e => setForm({ ...form, billing_city: e.target.value })}
                  className={dsInput}
                />
              </Field>
              <Field label="Provincia" htmlFor="cust-bill-prov">
                <input
                  id="cust-bill-prov"
                  type="text"
                  maxLength={2}
                  value={form.billing_province}
                  onChange={e => setForm({ ...form, billing_province: e.target.value.toUpperCase() })}
                  className={dsInput}
                />
              </Field>
            </div>
          </div>
        </details>
      </div>
    </FormCard>
  ) : (
    <FormCard title="Preferenze di servizio">
      <div className="space-y-4">
        <label className="flex cursor-pointer select-none items-center gap-3 rounded-[16px] bg-[var(--ds-surface-row)] p-3">
          <input
            type="checkbox"
            checked={form.is_vip}
            onChange={e => setForm({ ...form, is_vip: e.target.checked })}
            className="h-5 w-5 flex-shrink-0 rounded-[6px] accent-[var(--ds-pending-solid)]"
          />
          <Star className={`h-4 w-4 flex-shrink-0 ${form.is_vip ? 'fill-[var(--ds-pending-solid)] text-[var(--ds-pending-solid)]' : 'text-[var(--ds-text-muted)]'}`} aria-hidden />
          <span className="min-w-0">
            <span className="block text-[15px] font-medium text-[var(--ds-text-primary)]">Cliente VIP</span>
            <span className="block text-[13px] text-[var(--ds-text-muted)]">Evidenzia la prenotazione in sala</span>
          </span>
        </label>
        <label className="flex cursor-pointer select-none items-center gap-3 rounded-[16px] bg-[var(--ds-surface-row)] p-3">
          <input
            type="checkbox"
            checked={form.is_blacklisted}
            onChange={e => setForm({ ...form, is_blacklisted: e.target.checked })}
            className="h-5 w-5 flex-shrink-0 rounded-[6px] accent-[var(--ds-critical-solid)]"
          />
          <Ban className={`h-4 w-4 flex-shrink-0 ${form.is_blacklisted ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-muted)]'}`} aria-hidden />
          <span className="min-w-0">
            <span className="block text-[15px] font-medium text-[var(--ds-text-primary)]">Blacklist</span>
            <span className="block text-[13px] text-[var(--ds-text-muted)]">Blocca web e agente vocale, avvisa in sala</span>
          </span>
        </label>
        {form.is_blacklisted && (
          <Field label="Motivo blacklist" htmlFor="cust-blacklist-reason">
            <input
              id="cust-blacklist-reason"
              type="text"
              placeholder="Es. due no-show senza avviso"
              value={form.blacklist_reason}
              onChange={e => setForm({ ...form, blacklist_reason: e.target.value })}
              className={dsInput}
            />
          </Field>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Tavolo preferito" htmlFor="cust-table">
            <select
              id="cust-table"
              value={form.preferred_table_id ?? ''}
              onChange={e => setForm({ ...form, preferred_table_id: e.target.value === '' ? null : Number(e.target.value) })}
              className={dsSelect}
            >
              <option value="">Nessuna preferenza</option>
              {tablesByRoom.map(group => (
                <optgroup key={group.roomId ?? 'none'} label={group.roomName}>
                  {group.tables.map(t => (
                    <option key={t.id} value={t.id}>{t.name} · {t.seats} posti</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Note preferenze" htmlFor="cust-prefs">
            <input
              id="cust-prefs"
              type="text"
              placeholder="Es. vicino finestra, no rumore"
              value={form.preferences_notes}
              onChange={e => setForm({ ...form, preferences_notes: e.target.value })}
              className={dsInput}
            />
          </Field>
        </div>
        <Field
          label="Allergie e note alimentari"
          htmlFor="cust-diet"
          hint="Precompilate in ogni nuova prenotazione di questo cliente."
        >
          <textarea
            id="cust-diet"
            rows={2}
            placeholder="Es. intolleranza glutine, no crostacei"
            value={form.dietary_notes}
            onChange={e => setForm({ ...form, dietary_notes: e.target.value })}
            className={`${dsTextarea} resize-none`}
          />
        </Field>
        <Field label="Note" htmlFor="cust-notes">
          <textarea
            id="cust-notes"
            rows={3}
            value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })}
            className={`${dsTextarea} resize-none`}
          />
        </Field>
      </div>
    </FormCard>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Solo sotto md. Sul desktop la colonna di sinistra è larga quanto la
          lista e la voce "Clienti" è già selezionata nella barra laterale: il
          titolo ripeterebbe l'unica cosa che lo schermo dice già, rubando la
          riga alla ricerca. Col telefono la barra laterale non c'è. */}
      <h1 className="flex-shrink-0 px-4 pt-4 text-[22px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)] md:hidden">
        Clienti
      </h1>
      <SplitPane
        detailOpen={!!detailCustomer}
        toolbar={toolbar}
        list={list}
        detail={detailCustomer
          ? renderDetail(detailCustomer)
          : <PanePlaceholder icon={BookUser}>Scegli un cliente per vederne la scheda.</PanePlaceholder>}
      />

      {/* ── Nuovo / modifica cliente ─────────────────────────────────────
          Due passi come Nuova prenotazione: contatto, poi preferenze. Nome e
          telefono sono gli unici obbligatori e stanno entrambi nel primo, così
          il cliente al telefono si salva senza arrivare in fondo. I passi non
          si sbarrano a vicenda — StepNav li tiene tutti raggiungibili e la
          validazione resta una sola, al salvataggio. */}
      <ModalShell
        open={formOpen}
        onClose={() => !isSaving && setFormOpen(false)}
        title={form.id ? 'Modifica cliente' : 'Nuovo cliente'}
        subtitle={form.id ? 'Le modifiche valgono da subito in sala' : 'Nome e telefono bastano — il resto si aggiunge dopo'}
        size="md"
        fixedHeight
        bodyClassName="px-5 pb-5 sm:px-6 sm:pb-6"
        subheader={
          <StepNav
            steps={[{ label: 'Contatto', icon: UserIcon }, { label: 'Preferenze di servizio', icon: Star }]}
            current={step}
            onSelect={setStep}
            ariaLabel="Passi del cliente"
          />
        }
        // Una sola azione, sempre la stessa e sempre primaria: si salva da
        // dove si è. Fra i due passi ci si muove dallo stepper qui sopra, che
        // è già navigabile passo per passo — Avanti e Indietro erano un
        // secondo modo di fare la stessa cosa, e mettevano tre pulsanti in
        // riga attorno a quello che conta.
        footer={
          <>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              disabled={isSaving}
              className={dsButton.quiet}
            >
              Annulla
            </button>
            <button
              type="submit"
              form="customer-form"
              disabled={isSaving || !canSave}
              className={dsButton.primary}
            >
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {isSaving ? 'Salvataggio…' : (form.id ? 'Salva modifiche' : 'Aggiungi alla rubrica')}
            </button>
          </>
        }
      >
        <form
          id="customer-form"
          // I campi obbligatori vivono nel primo passo: se manca qualcosa
          // mentre si è nel secondo, il required del browser non può puntare a
          // un input smontato. Riportiamo lì noi invece di rifiutare in
          // silenzio, che era quello che faceva il return secco di prima.
          onSubmit={e => {
            if (!form.name.trim() || !form.phone.trim()) {
              e.preventDefault();
              setStep(0);
              return;
            }
            handleSubmit(e);
          }}
        >
          {stepFields}
        </form>
      </ModalShell>

      {/* Conferma di eliminazione */}
      <ModalShell
        open={confirmDeleteId !== null}
        onClose={() => setConfirmDeleteId(null)}
        title="Eliminare il cliente?"
        size="sm"
        closeOnEscape
        bodyClassName="px-5 pb-5 sm:px-6 sm:pb-6"
        footer={
          <>
            <button type="button" onClick={() => setConfirmDeleteId(null)} className={dsButton.quiet}>
              Annulla
            </button>
            <button
              type="button"
              onClick={() => confirmDeleteId !== null && handleDelete(confirmDeleteId)}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[var(--ds-critical-solid)] px-5 text-[15px] font-semibold text-[var(--ds-critical-fg)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              Elimina
            </button>
          </>
        }
      >
        <p className="text-[15px] text-[var(--ds-text-secondary)]">
          I banchetti collegati manterranno la storia ma non saranno più associati al cliente.
        </p>
      </ModalShell>

      {/* Duplicati: gruppi di clienti che condividono le stesse cifre di telefono */}
      <ModalShell
        open={duplicatesOpen}
        onClose={() => !isMerging && setDuplicatesOpen(false)}
        title="Clienti duplicati"
        subtitle="Ogni gruppo ha lo stesso numero di telefono"
        size="md"
        bodyClassName="px-5 pb-5 sm:px-6 sm:pb-6"
      >
        {duplicateGroups.length === 0 ? (
          <EmptyState icon={GitMerge}>Nessun duplicato rilevato.</EmptyState>
        ) : (
          <div className="space-y-4">
            <p className="text-[14px] text-[var(--ds-text-muted)]">
              Scegli quale voce mantenere: le altre verranno unite in essa, storico prenotazioni e banchetti inclusi.
            </p>
            {duplicateGroups.map(group => (
              <div key={group.key} className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
                <div className="mb-3 text-[13px] text-[var(--ds-text-muted)]">
                  {group.customers.length} voci · numero terminante {group.key}
                </div>
                <div className="space-y-2">
                  {group.customers.map(c => {
                    const others = group.customers.filter(o => o.id !== c.id);
                    return (
                      <div key={c.id} className="flex items-start gap-3 rounded-[16px] bg-[var(--ds-surface-row)] p-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            {c.is_vip && <Star className="h-3.5 w-3.5 flex-shrink-0 fill-[var(--ds-pending-solid)] text-[var(--ds-pending-solid)]" aria-label="VIP" />}
                            <span className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{toTitleCase(c.name)}</span>
                          </div>
                          <div className="mt-0.5 truncate text-[13px] text-[var(--ds-text-muted)]">
                            {c.phone && <span className="tabular-nums">{c.phone}</span>}
                            {c.email && <span className="ml-2">{c.email}</span>}
                          </div>
                          <div className="mt-0.5 text-[12px] tabular-nums text-[var(--ds-text-subtle)]">ID #{c.id}</div>
                        </div>
                        <div className="flex flex-shrink-0 flex-col gap-1.5">
                          {others.map(other => {
                            const isThisPair = mergingIds?.source === other.id && mergingIds?.target === c.id;
                            return (
                              <button
                                key={other.id}
                                type="button"
                                onClick={() => runMerge(other.id, c.id)}
                                disabled={isMerging}
                                title={`Unisci "${toTitleCase(other.name)}" (#${other.id}) in questo`}
                                className={`${chip} whitespace-nowrap bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] hover:opacity-80 disabled:opacity-50`}
                              >
                                {isThisPair ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" aria-hidden />}
                                Unisci #{other.id} qui
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </ModalShell>

      {/* Conflitto di numero: il salvataggio è tornato 409 */}
      <ModalShell
        open={conflictPrompt !== null}
        onClose={() => !isMerging && setConflictPrompt(null)}
        title="Numero già in rubrica"
        size="sm"
        bodyClassName="px-5 pb-5 sm:px-6 sm:pb-6"
        footer={
          <>
            <button
              type="button"
              onClick={() => setConflictPrompt(null)}
              disabled={isMerging}
              className={dsButton.quiet}
            >
              {conflictPrompt?.sourceId != null ? 'Annulla' : 'Chiudi'}
            </button>
            {conflictPrompt?.sourceId != null && (
              <button
                type="button"
                onClick={() => runMerge(conflictPrompt.sourceId!, conflictPrompt.targetId)}
                disabled={isMerging}
                className={dsButton.primary}
              >
                {isMerging ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" aria-hidden />}
                Unisci
              </button>
            )}
          </>
        }
      >
        {conflictPrompt && (
          <Callout tone="pending" icon={AlertTriangle}>
            Questo numero è già associato a <strong>{conflictPrompt.targetName}</strong>.
            {conflictPrompt.sourceId != null ? (
              <> Vuoi unire <strong>{conflictPrompt.sourceName || 'questa voce'}</strong> in <strong>{conflictPrompt.targetName}</strong>? Storico prenotazioni e banchetti verranno mantenuti.</>
            ) : (
              <> Non è possibile creare un nuovo cliente con lo stesso numero.</>
            )}
          </Callout>
        )}
      </ModalShell>
    </div>
  );
};
