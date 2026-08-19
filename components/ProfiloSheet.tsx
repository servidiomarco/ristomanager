import React, { useState, useEffect } from 'react';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import { Sheet, FormCard, Field, dsInput, dsButton } from './ds';
import { useAuth } from '../contexts/AuthContext';

/**
 * Il proprio account, self-service: nome e telefono, cambio password, cambio
 * email. Aperto dall'area utente della sidebar (e dal menu "Altro" su mobile).
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
      setProfileNote({ tone: 'error', text: 'Il nome non può essere vuoto.' });
      return;
    }
    setProfileBusy(true);
    setProfileNote(null);
    try {
      await updateProfile({ full_name: fullName.trim(), phone: phone.trim() || null });
      setProfileNote({ tone: 'ok', text: 'Salvato.' });
    } catch (err: any) {
      setProfileNote({ tone: 'error', text: err?.data?.message || 'Salvataggio non riuscito.' });
    } finally {
      setProfileBusy(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      setPasswordNote({ tone: 'error', text: 'La nuova password deve avere almeno 8 caratteri.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordNote({ tone: 'error', text: 'Le due password non coincidono.' });
      return;
    }
    setPasswordBusy(true);
    setPasswordNote(null);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordNote({ tone: 'ok', text: 'Password aggiornata. Le altre sessioni verranno scollegate.' });
    } catch (err: any) {
      setPasswordNote({
        tone: 'error',
        text: err?.status === 401
          ? 'La password attuale non è corretta.'
          : err?.data?.message || 'Cambio password non riuscito.',
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
      setEmailNote({ tone: 'ok', text: 'Email aggiornata.' });
    } catch (err: any) {
      setEmailNote({
        tone: 'error',
        text: err?.status === 409
          ? 'Questa email è già in uso.'
          : err?.status === 401
            ? 'La password non è corretta.'
            : err?.data?.message || 'Cambio email non riuscito.',
      });
    } finally {
      setEmailBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Il tuo account"
      subtitle={user ? `${user.email} · ${roleLabel}` : undefined}
      ariaLabel="Il tuo account"
      bodyClassName="p-4 sm:p-5 space-y-4"
    >
      <FormCard title="Profilo">
        <form onSubmit={handleProfileSubmit} className="space-y-4">
          <Field label="Nome" htmlFor="profilo-nome" required>
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
          <Field label="Telefono" htmlFor="profilo-telefono">
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
            Salva
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
            aria-label={showPasswords ? 'Nascondi password' : 'Mostra password'}
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            {showPasswords ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        }
      >
        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <Field label="Password attuale" htmlFor="profilo-pw-attuale" required>
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
          <Field label="Nuova password" htmlFor="profilo-pw-nuova" required hint="Minimo 8 caratteri.">
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
          <Field label="Conferma password" htmlFor="profilo-pw-conferma" required>
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
            Aggiorna password
          </button>
        </form>
      </FormCard>

      <FormCard title="Email">
        <form onSubmit={handleEmailSubmit} className="space-y-4">
          <Field label="Nuova email" htmlFor="profilo-email-nuova" required>
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
          <Field label="Password attuale" htmlFor="profilo-email-pw" required hint="Serve a confermare che sei tu.">
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
            Cambia email
          </button>
        </form>
      </FormCard>
    </Sheet>
  );
};
