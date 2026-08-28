import React, { useState, useEffect } from 'react';
import { AlertCircle, Loader2, Eye, EyeOff, Check, CheckCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { authApiService } from '../services/authApiService';
import { PLATFORM_NAME } from '../platform';
import { dsInput, dsButton, Callout } from './ds';

const SAVED_CREDENTIALS_KEY = 'ristocrm_saved_credentials';

// La pagina ha tre facce: login, richiesta reset (email) e nuova password
// (arrivando dal link `?reset=<token>` dell'email).
type LoginMode = 'login' | 'forgot' | 'reset';

// Il submit è l'unica azione piena della pagina: primary a tutta larghezza.
const submitClass = `${dsButton.primary} mt-3 w-full`;

const linkClass =
  'rounded-full text-[13px] leading-[18px] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] underline underline-offset-2 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-40';

// Occhio mostra/nascondi, parcheggiato dentro il campo: `inset-y-0` gli dà
// tutta l'altezza dell'input, quindi il bersaglio è già di 44px.
const revealClass =
  'absolute inset-y-0 right-0 pr-4 flex items-center rounded-full text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] transition-colors duration-150 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

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

  // Errore e nota di esito hanno la stessa forma — Callout, tono opposto. Il
  // `role` sta sul contenitore perché Callout non inoltra attributi arbitrari.
  const errorCallout = error && (
    <div role="alert">
      <Callout tone="critical" icon={AlertCircle}>{error}</Callout>
    </div>
  );

  return (
    <div className="min-h-screen w-full flex font-sans text-[var(--ds-text-primary)] bg-[var(--ds-surface)]">
      {/* Left: form column */}
      <div className="flex-1 min-w-0 relative flex flex-col">
        {/* Centered form — il logo viaggia dentro il blocco centrato, non in
            una barra in cima: appoggiato al titolo fa una testata sola invece
            di due elementi separati da tutta l'altezza della colonna. */}
        <main className="flex-1 flex items-center justify-center px-6 py-6">
          <div className="w-full max-w-[400px]">
            {/* Il tema arriva anche qui: .dark viene applicata da localStorage
                prima dell'accesso. Stessa coppia nero/bianco della sidebar. */}
            <div className="flex items-center justify-center mb-18">
              <img src="/logo-sympotia-black.svg" alt={PLATFORM_NAME} className="h-8 w-auto dark:hidden" />
              <img src="/logo-sympotia-white.svg" alt={PLATFORM_NAME} className="hidden h-8 w-auto dark:block" />
            </div>
            <h1 className="text-[26px] leading-[32px] font-semibold tracking-tight text-[var(--ds-text-primary)] text-center mb-1.5">
              {mode === 'forgot' ? 'Recupera la password'
                : mode === 'reset' ? 'Scegli una nuova password'
                : 'Accedi al tuo ristorante'}
            </h1>
            <p className="text-[15px] leading-[22px] text-[var(--ds-text-secondary)] text-center mb-8">
              {mode === 'forgot' ? 'Ti mandiamo un link per sceglierne una nuova.'
                : mode === 'reset' ? 'Minimo 8 caratteri.'
                : 'Inserisci le tue credenziali per continuare.'}
            </p>

            {mode === 'forgot' && (
              forgotSent ? (
                <div className="flex flex-col gap-4">
                  {/* Sempre lo stesso messaggio, che l'email esista o no:
                      la UI non conferma mai quali indirizzi hanno un account. */}
                  <div role="status">
                    <Callout tone="positive" icon={CheckCircle}>
                      Se l'indirizzo esiste, riceverai un'email con il link per reimpostare la password. Il link vale 1 ora.
                    </Callout>
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
                      className={dsInput}
                      required
                      disabled={isLoading}
                      autoFocus
                    />
                  </div>

                  {errorCallout}

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
                      className={`${dsInput} pr-12`}
                      required
                      minLength={8}
                      disabled={isLoading}
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword((p) => !p)}
                      disabled={isLoading}
                      className={revealClass}
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
                    className={dsInput}
                    required
                    minLength={8}
                    disabled={isLoading}
                  />
                </div>

                {errorCallout}

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
                <div role="status">
                  <Callout tone="positive" icon={CheckCircle}>{info}</Callout>
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
                  className={dsInput}
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
                    className={`${dsInput} pr-12`}
                    required
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((p) => !p)}
                    disabled={isLoading}
                    className={revealClass}
                    aria-label={showPassword ? 'Nascondi password' : 'Mostra password'}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Remember me — checkbox 20px del design system, riga a 44px
                  perché il bersaglio è tutta la label, non il quadratino. */}
              <label
                htmlFor="remember-me"
                className="flex min-h-11 items-center gap-2.5 px-1 cursor-pointer select-none"
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
                    className="h-5 w-5 rounded-[6px] border border-[var(--ds-border-strong)] bg-[var(--ds-surface)] peer-checked:bg-[var(--ds-action-bg)] peer-checked:border-[var(--ds-action-bg)] peer-disabled:opacity-40 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--ds-border-focus)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--ds-surface)] transition-colors duration-150"
                  />
                  <Check
                    className="absolute h-3.5 w-3.5 text-[var(--ds-action-fg)] opacity-0 peer-checked:opacity-100 transition-opacity duration-150 pointer-events-none"
                    strokeWidth={3}
                  />
                </span>
                <span className="text-[13px] leading-[18px] text-[var(--ds-text-secondary)]">
                  Ricorda le mie credenziali
                </span>
              </label>

              {/* Error */}
              {errorCallout}

              {/* Submit (pill) */}
              <button type="submit" disabled={isLoading} className={submitClass}>
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
          <p className="text-[12px] leading-[16px] text-[var(--ds-text-subtle)]">
            {PLATFORM_NAME} · Italia
          </p>
        </div>
      </div>

      {/* Right: framed image */}
      <div className="hidden lg:flex flex-1 min-w-0 bg-[var(--ds-canvas)] p-6">
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
