import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import { Sheet, FormCard, Field, dsInput, dsButton } from './ds';
import { useAuth } from '../contexts/AuthContext';
import { LeMieFerieCard } from './LeMieFerieCard';

/**
 * Il proprio account, self-service: le proprie ferie (per chi ha l'account
 * collegato a una scheda del personale), nome e telefono, cambio password,
 * cambio email. Aperto dall'area utente della sidebar (e dal menu "Altro" su
 * mobile).
 *
 * Tre card indipendenti, ognuna col suo submit: password ed email richiedono
 * la password corrente e falliscono in modi diversi — un unico "Salva" che
 * aggrega tre errori diversi sarebbe illeggibile.
 */

interface ProfiloSheetProps {
  open: boolean;
  onClose: () => void;
  /** Etichetta leggibile del ruolo — la mappa vive in App.tsx. */
  roleLabel: string;
}

// Esito di una card: una riga sotto il bottone, verde o critica. Il verde è
// il token della famiglia "seduto" — l'unico verde del sistema (§ colori per
// stato), non un green Tailwind fuori palette.
const Note: React.FC<{ tone: 'ok' | 'error'; children: React.ReactNode }> = ({ tone, children }) => (
  <p
    role={tone === 'error' ? 'alert' : 'status'}
    className={`text-[13px] ${tone === 'ok' ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}`}
  >
    {children}
  </p>
);

export const ProfiloSheet: React.FC<ProfiloSheetProps> = ({ open, onClose, roleLabel }) => {
  const { t } = useTranslation('profilo', { useSuspense: false });
  const { user, updateProfile, changePassword, changeEmail } = useAuth();

  // ── Profilo (nome + telefono) ──
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileNote, setProfileNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // ── Password ──
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordNote, setPasswordNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // ── Email ──
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailNote, setEmailNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // Ripopola dai dati correnti a ogni apertura, e azzera i campi sensibili:
  // password scritte a metà non devono sopravvivere a un chiudi-e-riapri.
  useEffect(() => {
    if (!open) return;
    setFullName(user?.full_name || '');
    setPhone(user?.phone || '');
    setProfileNote(null);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordNote(null);
    setNewEmail('');
    setEmailPassword('');
    setEmailNote(null);
  }, [open, user?.full_name, user?.phone]);

  const profileDirty = fullName.trim() !== (user?.full_name || '') || phone.trim() !== (user?.phone || '');

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim()) {
      setProfileNote({ tone: 'error', text: t('nameRequired') });
      return;
    }
    setProfileBusy(true);
    setProfileNote(null);
    try {
      await updateProfile({ full_name: fullName.trim(), phone: phone.trim() || null });
      setProfileNote({ tone: 'ok', text: t('savedOk') });
    } catch (err: any) {
      setProfileNote({ tone: 'error', text: err?.data?.message || t('saveFailed') });
    } finally {
      setProfileBusy(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      setPasswordNote({ tone: 'error', text: t('pwTooShort') });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordNote({ tone: 'error', text: t('pwMismatch') });
      return;
    }
    setPasswordBusy(true);
    setPasswordNote(null);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordNote({ tone: 'ok', text: t('pwUpdated') });
    } catch (err: any) {
      setPasswordNote({
        tone: 'error',
        text: err?.status === 401
          ? t('pwCurrentWrong')
          : err?.data?.message || t('pwChangeFailed'),
      });
    } finally {
      setPasswordBusy(false);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailBusy(true);
    setEmailNote(null);
    try {
      await changeEmail(newEmail, emailPassword);
      setNewEmail('');
      setEmailPassword('');
      setEmailNote({ tone: 'ok', text: t('emailUpdated') });
    } catch (err: any) {
      setEmailNote({
        tone: 'error',
        text: err?.status === 409
          ? t('emailInUse')
          : err?.status === 401
            ? t('pwWrong')
            : err?.data?.message || t('emailChangeFailed'),
      });
    } finally {
      setEmailBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('accountTitle')}
      subtitle={user ? `${user.email} · ${roleLabel}` : undefined}
      ariaLabel={t('accountTitle')}
      bodyClassName="p-4 sm:p-5 space-y-4"
    >
      {/* Solo per chi ha l'account collegato a una scheda del personale. */}
      <LeMieFerieCard open={open} />

      <FormCard title={t('profile')}>
        <form onSubmit={handleProfileSubmit} className="space-y-4">
          <Field label={t('name')} htmlFor="profilo-nome" required>
            <input
              id="profilo-nome"
              type="text"
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              maxLength={120}
              required
              disabled={profileBusy}
              className={dsInput}
            />
          </Field>
          <Field label={t('phone')} htmlFor="profilo-telefono">
            <input
              id="profilo-telefono"
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              maxLength={30}
              placeholder="+39 …"
              disabled={profileBusy}
              className={dsInput}
            />
          </Field>
          {profileNote && <Note tone={profileNote.tone}>{profileNote.text}</Note>}
          <button type="submit" disabled={profileBusy || !profileDirty} className={`${dsButton.primary} w-full`}>
            {profileBusy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('save')}
          </button>
        </form>
      </FormCard>

      <FormCard
        title="Password"
        aside={
          <button
            type="button"
            onClick={() => setShowPasswords(p => !p)}
            aria-pressed={showPasswords}
            aria-label={showPasswords ? t('hidePassword') : t('showPassword')}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            {showPasswords ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        }
      >
        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <Field label={t('currentPassword')} htmlFor="profilo-pw-attuale" required>
            <input
              id="profilo-pw-attuale"
              type={showPasswords ? 'text' : 'password'}
              autoComplete="current-password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              required
              disabled={passwordBusy}
              className={dsInput}
            />
          </Field>
          <Field label={t('newPassword')} htmlFor="profilo-pw-nuova" required hint={t('pwHint')}>
            <input
              id="profilo-pw-nuova"
              type={showPasswords ? 'text' : 'password'}
              autoComplete="new-password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              minLength={8}
              required
              disabled={passwordBusy}
              className={dsInput}
            />
          </Field>
          <Field label={t('confirmPassword')} htmlFor="profilo-pw-conferma" required>
            <input
              id="profilo-pw-conferma"
              type={showPasswords ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              minLength={8}
              required
              disabled={passwordBusy}
              className={dsInput}
            />
          </Field>
          {passwordNote && <Note tone={passwordNote.tone}>{passwordNote.text}</Note>}
          <button
            type="submit"
            disabled={passwordBusy || !currentPassword || !newPassword || !confirmPassword}
            className={`${dsButton.primary} w-full`}
          >
            {passwordBusy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('updatePassword')}
          </button>
        </form>
      </FormCard>

      <FormCard title="Email">
        <form onSubmit={handleEmailSubmit} className="space-y-4">
          <Field label={t('newEmail')} htmlFor="profilo-email-nuova" required>
            <input
              id="profilo-email-nuova"
              type="email"
              autoComplete="email"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              required
              disabled={emailBusy}
              className={dsInput}
            />
          </Field>
          <Field label={t('currentPassword')} htmlFor="profilo-email-pw" required hint={t('emailPwHint')}>
            <input
              id="profilo-email-pw"
              type="password"
              autoComplete="current-password"
              value={emailPassword}
              onChange={e => setEmailPassword(e.target.value)}
              required
              disabled={emailBusy}
              className={dsInput}
            />
          </Field>
          {emailNote && <Note tone={emailNote.tone}>{emailNote.text}</Note>}
          <button
            type="submit"
            disabled={emailBusy || !newEmail || !emailPassword}
            className={`${dsButton.primary} w-full`}
          >
            {emailBusy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('changeEmail')}
          </button>
        </form>
      </FormCard>
    </Sheet>
  );
};
