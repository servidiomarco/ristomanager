import React, { useState, useEffect } from 'react';
import { AlertCircle, Loader2, Eye, EyeOff, Check, ChefHat } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const SAVED_CREDENTIALS_KEY = 'ristocrm_saved_credentials';

export const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
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
          <div className="flex items-center gap-3">
            <div className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-[var(--color-fg)]">
              <ChefHat className="h-6 w-6 text-[var(--color-fg-on-brand)]" />
            </div>
            <span className="text-[20px] leading-[28px] font-semibold tracking-tight text-[var(--color-fg)]">
              Risto CRM
            </span>
          </div>
        </div>

        {/* Centered form */}
        <main className="flex-1 flex items-center justify-center px-6">
          <div className="w-full max-w-[400px]">
            <h1 className="text-[26px] leading-[32px] font-semibold tracking-tight text-[var(--color-fg)] text-center mb-1.5">
              Accedi al tuo ristorante
            </h1>
            <p className="text-sm text-[var(--color-fg-muted)] text-center mb-8">
              Inserisci le tue credenziali per continuare.
            </p>

            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
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
                  className="text-[13px] leading-[18px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] underline underline-offset-2 transition-colors duration-150"
                >
                  Password dimenticata?
                </button>
              </div>
            </form>
          </div>
        </main>

        {/* Footer */}
        <div className="px-6 py-6 text-center">
          <p className="text-[12px] leading-[16px] text-[var(--color-fg-subtle)]">
            Risto Manager · Italia
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
