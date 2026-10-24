import React from 'react';
import {
  AlertTriangle, Cog, LifeBuoy, Mail, MessageCircle, Phone, Presentation, StickyNote, Users,
} from 'lucide-react';
import { StatusPill, type PillTone } from './ds';
import { getRomeDatePart } from '../utils/reservationTime';
import { displayLocale } from '../utils/formatLocale';
import type {
  CrmDealKind, CrmDealStage, CrmHealth, CrmHealthLevel, CrmStage, CrmTimelineItem,
} from '../services/platformCrmApiService';

/* ============================================
   PANNELLO PIATTAFORMA — CRM, pezzi comuni
   ============================================
   Etichette, toni e formati condivisi da Panoramica, Clienti, Pipeline e
   Promemoria, così una fase o un punteggio si leggono uguali ovunque. */

export type ShowToast = (message: string, type?: 'success' | 'error' | 'info') => void;

/* ── Fasi dell'azienda ────────────────────────────────────────────────────
   I toni seguono le famiglie, non il gusto: la vendita aperta è «in arrivo»,
   la prova chiede un'azione (convertirla), il cliente sta bene, la disdetta
   è un fallimento; il lead perso non chiede più niente. */
export const STAGE_LABEL: Record<CrmStage, string> = {
  lead: 'Lead',
  contattato: 'Contattato',
  demo: 'Demo',
  proposta: 'Proposta',
  prova: 'In prova',
  cliente: 'Cliente',
  perso: 'Perso',
  disdetto: 'Disdetto',
};

export const STAGE_TONE: Record<CrmStage, PillTone> = {
  lead: 'info',
  contattato: 'info',
  demo: 'info',
  proposta: 'info',
  prova: 'pending',
  cliente: 'positive',
  perso: 'neutral',
  disdetto: 'critical',
};

export const StagePill: React.FC<{ stage: CrmStage }> = ({ stage }) => (
  <StatusPill tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</StatusPill>
);

/* ── Salute ───────────────────────────────────────────────────────────── */
export const HEALTH_LABEL: Record<CrmHealthLevel, string> = {
  sano: 'sano',
  da_seguire: 'da seguire',
  a_rischio: 'a rischio',
};

const HEALTH_TONE: Record<CrmHealthLevel, PillTone> = {
  sano: 'positive',
  da_seguire: 'pending',
  a_rischio: 'critical',
};

/** Il numero e la parola: il colore da solo non dice abbastanza. Il title
 *  porta i motivi, per chi passa sopra col mouse. */
export const HealthPill: React.FC<{ health: CrmHealth | null }> = ({ health }) => {
  if (!health) return null;
  return (
    <StatusPill
      tone={HEALTH_TONE[health.level]}
      title={health.signals.length ? health.signals.join(' · ') : 'Nessun segnale negativo'}
    >
      <span className="tabular-nums">{health.score}</span> {HEALTH_LABEL[health.level]}
    </StatusPill>
  );
};

/* ── Opportunità ──────────────────────────────────────────────────────── */
export const DEAL_STAGE_LABEL: Record<CrmDealStage, string> = {
  nuova: 'Nuova',
  demo: 'Demo',
  proposta: 'Proposta',
  trattativa: 'Trattativa',
  vinta: 'Vinta',
  persa: 'Persa',
};

export const DEAL_KIND_LABEL: Record<CrmDealKind, string> = {
  nuovo: 'Contratto nuovo',
  upsell: 'Add-on',
  rinnovo: 'Rinnovo',
};

/* ── Attività ─────────────────────────────────────────────────────────── */
export const ACTIVITY_LABEL: Record<CrmTimelineItem['kind'], string> = {
  nota: 'Nota',
  chiamata: 'Chiamata',
  email: 'Email',
  incontro: 'Incontro',
  demo: 'Demo',
  whatsapp: 'WhatsApp',
  sistema: 'Sistema',
  supporto: 'Supporto',
  avviso: 'Avviso',
};

export const ACTIVITY_ICON: Record<CrmTimelineItem['kind'], React.ComponentType<{ className?: string }>> = {
  nota: StickyNote,
  chiamata: Phone,
  email: Mail,
  incontro: Users,
  demo: Presentation,
  whatsapp: MessageCircle,
  sistema: Cog,
  supporto: LifeBuoy,
  avviso: AlertTriangle,
};

/* ── Suggerimenti dei campi liberi ───────────────────────────────────────
   Restano testo libero (un'«enoteca con cucina» non deve finire in
   «altro»); i suggerimenti tengono uguali le parole che si ripetono. */
export const SOURCE_SUGGESTIONS = ['passaparola', 'telefonata', 'sito', 'social', 'evento', 'fiera', 'rivenditore', 'cliente che porta cliente'];
export const BUSINESS_TYPE_SUGGESTIONS = ['ristorante', 'pizzeria', 'trattoria', 'osteria', 'agriturismo', 'enoteca', 'bar', 'hotel', 'catering', 'banqueting'];
export const SOFTWARE_SUGGESTIONS = ['nessuno', 'carta e penna', 'TheFork Manager', 'Plateform', 'Quandoo', 'Cassa in Cloud', 'Tilby', 'altro gestionale'];

/* ── Formati ──────────────────────────────────────────────────────────── */

/** «€ 1.234» — il ricavo di Sympotia è in euro qualunque lingua legga chi
 *  guarda; il separatore segue la lingua. Decimali solo se servono, e
 *  allora due («€ 169,40», mai «€ 169,4»). */
export const eur = (cents: number | null | undefined): string => {
  const value = typeof cents === 'number' && Number.isFinite(cents) ? Math.round(cents) : 0;
  const digits = value % 100 === 0 ? 0 : 2;
  return `€ ${(value / 100).toLocaleString(displayLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

/** Euro scritti in un campo («49,90») → centesimi; vuoto = null. NaN se il
 *  testo non è un numero: il chiamante lo rifiuta. */
export const parseEuroInput = (value: string): number | null => {
  const s = value.trim().replace(/\s|€/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
};

export const centsToInput = (cents: number | null | undefined): string =>
  typeof cents === 'number' ? String(cents / 100).replace('.', ',') : '';

export const todayRome = (): string => getRomeDatePart(new Date());

export const addDaysIso = (isoDay: string, days: number): string => {
  const d = new Date(`${isoDay}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** «24 ott» per una data YYYY-MM-DD; con l'anno solo se non è quello in corso. */
export const formatDay = (isoDay: string | null | undefined): string => {
  if (!isoDay) return '—';
  const d = new Date(`${isoDay.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  const sameYear = isoDay.slice(0, 4) === todayRome().slice(0, 4);
  return d.toLocaleDateString(displayLocale(), {
    day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC',
  });
};

/** Data e ora di un istante, nel fuso del locale. */
export const formatInstant = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(displayLocale(), {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome',
  });
};

/** «oggi», «domani», «ieri», «fra 3 g», «5 g fa» per una scadenza. */
export const dueLabel = (isoDay: string): string => {
  const today = todayRome();
  const diff = Math.round((new Date(`${isoDay}T12:00:00Z`).getTime() - new Date(`${today}T12:00:00Z`).getTime()) / 86_400_000);
  if (diff === 0) return 'oggi';
  if (diff === 1) return 'domani';
  if (diff === -1) return 'ieri';
  if (diff > 1 && diff <= 6) return `fra ${diff} g`;
  if (diff < -1) return `${-diff} g fa`;
  return formatDay(isoDay);
};

/** Link per chiamare e scrivere: numeri italiani senza prefisso diventano
 *  +39 per WhatsApp, che vuole il formato internazionale. */
export const telHref = (phone: string): string => `tel:${phone.replace(/[^\d+]/g, '')}`;
export const whatsappHref = (phone: string): string => {
  let digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (/^3\d{8,9}$/.test(digits)) digits = `39${digits}`;
  return `https://wa.me/${digits}`;
};

/** Un CSV che Excel italiano apre in colonne: punto e virgola e BOM. */
export const toCsv = (rows: Array<Record<string, string | number | null | undefined>>, columns: Array<[string, string]>): string => {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map(([, label]) => cell(label)).join(';');
  const body = rows.map(r => columns.map(([key]) => cell(r[key])).join(';'));
  return '﻿' + [head, ...body].join('\r\n');
};

/** CSV in righe: separatore indovinato dalla prima riga (; , o tab),
 *  virgolette doppie come da RFC 4180. */
export const parseCsv = (text: string): string[][] => {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const counts = [';', ',', '\t'].map(sep => [sep, firstLine.split(sep).length] as const);
  const sep = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === sep) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
};

export const downloadText = (filename: string, text: string, type = 'text/csv;charset=utf-8') => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** Riga di una lista dentro un card: hairline fra le righe, 44px di altezza
 *  minima, l'intera riga come bersaglio quando è cliccabile. */
export const crmRowButton =
  'flex w-full min-h-[44px] items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)]';
