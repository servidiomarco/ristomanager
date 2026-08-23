import React, { useState, useEffect } from 'react';
import { AlertCircle, Loader2, Eye, EyeOff, Check, CheckCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { authApiService } from '../services/authApiService';
import { PLATFORM_NAME } from '../platform';

const SAVED_CREDENTIALS_KEY = 'ristocrm_saved_credentials';

// La pagina ha tre facce: login, richiesta reset (email) e nuova password
// (arrivando dal link `?reset=<token>` dell'email).
type LoginMode = 'login' | 'forgot' | 'reset';

const inputClass =
  'w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-full px-5 py-3 text-[14px] leading-[20px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:border-[var(--color-fg)] transition-colors duration-150';

const submitClass =
  'mt-3 w-full inline-flex items-center justify-center gap-2 px-5 py-3.5 bg-[var(--color-fg)] hover:opacity-90 text-[var(--color-fg-on-brand)] text-[14px] leading-[20px] font-medium tracking-[0.01em] rounded-full transition-opacity duration-150 disabled:opacity-50 disabled:cursor-not-allowed';

const linkClass =
  'text-[13px] leading-[18px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] underline underline-offset-2 transition-colors duration-150';

export const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // ?reset=<token> nella query string: il link dell'email atterra qui.
  // Letto una volta al mount; la query si pulisce al termine del reset.
  const [resetToken] = useState(() => new URLSearchParams(window.location.search).get('reset') || '');
  const [mode, setMode] = useState<LoginMode>(() => (resetToken ? 'reset' : 'login'));

  // Richiesta reset
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSent, setForgotSent] = useState(false);

  // Nuova password
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);

  // Nota verde sopra il form di login (es. "password aggiornata").
  const [info, setInfo] = useState('');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SAVED_CREDENTIALS_KEY);
      if (saved) {
        const { email: savedEmail, password: savedPassword } = JSON.parse(saved);
        if (savedEmail) setEmail(savedEmail);
        if (savedPassword) setPassword(savedPassword);
        setRememberMe(true);
      }
    } catch {
      // ignore
    }
  }, []);

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      await authApiService.forgotPassword(forgotEmail);
      // Nessuna distinzione fra email esistente e no — nemmeno qui in UI:
      // il messaggio è identico in ogni caso (il server risponde sempre 200).
      setForgotSent(true);
    } catch (err: any) {
      // Solo rate limit o rete: la risposta non dice mai se l'account esiste.
      setError(err?.data?.message || 'Richiesta non riuscita, riprova tra qualche minuto.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('La nuova password deve avere almeno 8 caratteri.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Le due password non coincidono.');
      return;
    }
    setIsLoading(true);
    try {
      await authApiService.resetPassword(resetToken, newPassword);
      // Token consumato: si toglie ?reset=... dalla URL così un refresh non
      // ripropone il form con un token ormai morto.
      window.history.replaceState(null, '', window.location.pathname);
      setNewPassword('');
      setConfirmPassword('');
      setInfo('Password aggiornata. Accedi con la nuova password.');
      setMode('login');
    } catch (err: any) {
      setError(err?.data?.message || 'Il link non è più valido. Richiedi un nuovo reset.');
    } finally {
      setIsLoading(false);
    }
  };

  const goToLogin = () => {
    setMode('login');
    setError('');
    setForgotSent(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setIsLoading(true);

    try {
      await login({ email, password });
      if (rememberMe) {
        localStorage.setItem(
          SAVED_CREDENTIALS_KEY,
          JSON.stringify({ email, password })
        );
      } else {
        localStorage.removeItem(SAVED_CREDENTIALS_KEY);
      }
    } catch (err: any) {
      setError(err.message || 'Credenziali non valide');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex font-sans text-[var(--color-fg)] bg-[var(--color-surface)]">
      {/* Left: form column */}
      <div className="flex-1 min-w-0 relative flex flex-col">
        {/* Top bar: brand */}
        <div className="px-6 py-6 flex items-center justify-center">
          {/* Il login non applica mai .dark (il tema si carica dopo l'accesso),
              quindi basta il wordmark nero. */}
          <img src="/logo-sympotia-black.svg" alt={PLATFORM_NAME} className="h-8 w-auto" />
        </div>

        {/* Centered form */}
        <main className="flex-1 flex items-center justify-center px-6">
          <div className="w-full max-w-[400px]">
            <h1 className="text-[26px] leading-[32px] font-semibold tracking-tight text-[var(--color-fg)] text-center mb-1.5">
              {mode === 'forgot' ? 'Recupera la password'
                : mode === 'reset' ? 'Scegli una nuova password'
                : 'Accedi al tuo ristorante'}
            </h1>
            <p className="text-sm text-[var(--color-fg-muted)] text-center mb-8">
              {mode === 'forgot' ? 'Ti mandiamo un link per sceglierne una nuova.'
                : mode === 'reset' ? 'Minimo 8 caratteri.'
                : 'Inserisci le tue credenziali per continuare.'}
            </p>

            {mode === 'forgot' && (
              forgotSent ? (
                <div className="flex flex-col gap-4">
                  {/* Sempre lo stesso messaggio, che l'email esista o no:
                      la UI non conferma mai quali indirizzi hanno un account. */}
                  <div role="status" className="flex items-start gap-2 px-4 py-3 bg-[var(--color-surface)] border border-emerald-200 rounded-2xl text-[13px] leading-[18px] text-emerald-700">
                    <CheckCircle className="h-4 w-4 flex-shrink-0 mt-0.5 text-emerald-600" />
                    <span>Se l'indirizzo esiste, riceverai un'email con il link per reimpostare la password. Il link vale 1 ora.</span>
                  </div>
                  <div className="text-center">
                    <button type="button" onClick={goToLogin} className={linkClass}>
                      Torna al login
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleForgotSubmit} className="flex flex-col gap-3">
                  <div>
                    <label htmlFor="forgot-email" className="sr-only">Email</label>
                    <input
                      id="forgot-email"
                      type="email"
                      autoComplete="email"
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                      placeholder="Email"
                      className={inputClass}
                      required
                      disabled={isLoading}
                      autoFocus
                    />
                  </div>

                  {error && (
                    <div role="alert" className="flex items-center gap-2 px-4 py-2.5 bg-[var(--color-surface)] border border-rose-200 rounded-full text-[13px] leading-[18px] text-rose-700">
                      <AlertCircle className="h-4 w-4 flex-shrink-0 text-rose-600" />
                      <span>{error}</span>
                    </div>
                  )}

                  <button type="submit" disabled={isLoading} className={submitClass}>
                    {isLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Invio in corso...
                      </>
                    ) : (
                      'Invia il link'
                    )}
                  </button>

                  <div className="text-center mt-3">
                    <button type="button" onClick={goToLogin} disabled={isLoading} className={linkClass}>
                      Torna al login
                    </button>
                  </div>
                </form>
              )
            )}

            {mode === 'reset' && (
              <form onSubmit={handleResetSubmit} className="flex flex-col gap-3">
                <div>
                  <label htmlFor="new-password" className="sr-only">Nuova password</label>
                  <div className="relative">
                    <input
                      id="new-password"
                      type={showNewPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Nuova password"
                      className={`${inputClass} pr-12`}
                      required
                      minLength={8}
                      disabled={isLoading}
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword((p) => !p)}
                      disabled={isLoading}
                      className="absolute inset-y-0 right-0 pr-4 flex items-center text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors duration-150 disabled:opacity-50"
                      aria-label={showNewPassword ? 'Nascondi password' : 'Mostra password'}
                      tabIndex={-1}
                    >
                      {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="confirm-password" className="sr-only">Conferma password</label>
                  <input
                    id="confirm-password"
                    type={showNewPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Conferma password"
                    className={inputClass}
                    required
                    minLength={8}
                    disabled={isLoading}
                  />
                </div>

                {error && (
                  <div role="alert" className="flex items-center gap-2 px-4 py-2.5 bg-[var(--color-surface)] border border-rose-200 rounded-full text-[13px] leading-[18px] text-rose-700">
                    <AlertCircle className="h-4 w-4 flex-shrink-0 text-rose-600" />
                    <span>{error}</span>
                  </div>
                )}

                <button type="submit" disabled={isLoading} className={submitClass}>
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Salvataggio...
                    </>
                  ) : (
                    'Salva la nuova password'
                  )}
                </button>

                <div className="text-center mt-3">
                  <button
                    type="button"
                    onClick={() => {
                      window.history.replaceState(null, '', window.location.pathname);
                      goToLogin();
                    }}
                    disabled={isLoading}
                    className={linkClass}
                  >
                    Torna al login
                  </button>
                </div>
              </form>
            )}

            {mode === 'login' && (
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              {/* Esito del reset appena completato */}
              {info && (
                <div role="status" className="flex items-center gap-2 px-4 py-2.5 bg-[var(--color-surface)] border border-emerald-200 rounded-full text-[13px] leading-[18px] text-emerald-700">
                  <CheckCircle className="h-4 w-4 flex-shrink-0 text-emerald-600" />
                  <span>{info}</span>
                </div>
              )}
              {/* Email */}
              <div>
                <label htmlFor="email" className="sr-only">Email</label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email"
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-full px-5 py-3 text-[14px] leading-[20px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:border-[var(--color-fg)] transition-colors duration-150"
                  required
                  disabled={isLoading}
                />
              </div>

              {/* Password */}
              <div>
                <label htmlFor="password" className="sr-only">Password</label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Password"
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-full px-5 py-3 pr-12 text-[14px] leading-[20px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:border-[var(--color-fg)] transition-colors duration-150"
                    required
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((p) => !p)}
                    disabled={isLoading}
                    className="absolute inset-y-0 right-0 pr-4 flex items-center text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors duration-150 disabled:opacity-50"
                    aria-label={showPassword ? 'Nascondi password' : 'Mostra password'}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Remember me */}
              <label
                htmlFor="remember-me"
                className="flex items-center gap-2 px-1 mt-1 cursor-pointer select-none"
              >
                <span className="relative inline-flex items-center justify-center">
                  <input
                    id="remember-me"
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    disabled={isLoading}
                    className="peer sr-only"
                  />
                  <span
                    className="h-4 w-4 rounded-[4px] border border-[var(--color-line-strong)] bg-[var(--color-surface)] peer-checked:bg-[var(--color-fg)] peer-checked:border-[var(--color-fg)] peer-disabled:opacity-50 transition-colors duration-150"
                  />
                  <Check
                    className="absolute h-3 w-3 text-[var(--color-fg-on-brand)] opacity-0 peer-checked:opacity-100 transition-opacity duration-150 pointer-events-none"
                    strokeWidth={3}
                  />
                </span>
                <span className="text-[13px] leading-[18px] text-[var(--color-fg-muted)]">
                  Ricorda le mie credenziali
                </span>
              </label>

              {/* Error */}
              {error && (
                <div role="alert" className="flex items-center gap-2 px-4 py-2.5 bg-[var(--color-surface)] border border-rose-200 rounded-full text-[13px] leading-[18px] text-rose-700">
                  <AlertCircle className="h-4 w-4 flex-shrink-0 text-rose-600" />
                  <span>{error}</span>
                </div>
              )}

              {/* Submit (pill) */}
              <button
                type="submit"
                disabled={isLoading}
                className="mt-3 w-full inline-flex items-center justify-center gap-2 px-5 py-3.5 bg-[var(--color-fg)] hover:opacity-90 text-[var(--color-fg-on-brand)] text-[14px] leading-[20px] font-medium tracking-[0.01em] rounded-full transition-opacity duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Accesso in corso...
                  </>
                ) : (
                  'Accedi'
                )}
              </button>

              {/* Forgot password */}
              <div className="text-center mt-3">
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => {
                    setError('');
                    setInfo('');
                    setForgotSent(false);
                    // Prefill: se ha già scritto l'email nel login, non gliela
                    // si fa riscrivere.
                    setForgotEmail(email);
                    setMode('forgot');
                  }}
                  className={linkClass}
                >
                  Password dimenticata?
                </button>
              </div>
            </form>
            )}
          </div>
        </main>

        {/* Footer */}
        <div className="px-6 py-6 text-center">
          <p className="text-[12px] leading-[16px] text-[var(--color-fg-subtle)]">
            {PLATFORM_NAME} · Italia
          </p>
        </div>
      </div>

      {/* Right: framed image */}
      <div className="hidden lg:flex flex-1 min-w-0 bg-[var(--color-surface-3)] p-6">
        <div className="w-full h-full rounded-2xl overflow-hidden">
          <img
            src="https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=1400&q=80"
            alt=""
            className="w-full h-full object-cover"
          />
        </div>
      </div>
    </div>
  );
};
