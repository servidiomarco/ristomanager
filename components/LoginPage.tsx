import React, { useState, useEffect } from 'react';
import { ChefHat, AlertCircle, Loader2, Eye, EyeOff } from 'lucide-react';
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

  // Load saved credentials on mount
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
      // ignore corrupt storage
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
    <div className="min-h-screen w-full font-['Inter',sans-serif] text-[#111827] relative flex flex-col">
      {/* Full-bleed background image */}
      <div
        className="absolute inset-0 -z-10 bg-cover bg-center"
        style={{
          backgroundImage:
            "url('https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1920&q=80')",
        }}
        aria-hidden="true"
      />
      {/* Subtle darkening for legibility */}
      <div className="absolute inset-0 -z-10 bg-black/15" aria-hidden="true" />
      {/* Top chrome: logo top-left only */}
      <header className="w-full flex items-center px-6 py-5">
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center justify-center w-7 h-7 bg-white rounded-full">
            <ChefHat className="h-4 w-4 text-[#111827]" />
          </div>
          <span className="text-[14px] leading-[20px] font-medium tracking-[0.35px] text-white drop-shadow-sm">
            Risto CRM
          </span>
        </div>
      </header>

      {/* Centered card */}
      <main className="flex-1 flex items-center justify-center px-4 pb-16">
        <div
          className="w-full max-w-[440px] bg-white rounded-2xl p-2"
          style={{
            boxShadow:
              'rgba(0, 0, 0, 0.06) 0px 0px 0px 1px, rgba(0, 0, 0, 0.06) 0px 1px 1px -0.5px, rgba(0, 0, 0, 0.06) 0px 3px 3px -1.5px, rgba(0, 0, 0, 0.06) 0px 6px 6px -3px, rgba(0, 0, 0, 0.06) 0px 12px 12px -6px, rgba(0, 0, 0, 0.06) 0px 24px 24px -12px',
          }}
        >
          <div className="rounded-xl px-7 pt-7 pb-5">
            {/* Heading */}
            <h1 className="text-[24px] leading-[32px] font-medium tracking-[-0.01em] text-[#111827]">
              Benvenuto in Risto CRM
            </h1>
            <p className="mt-1 text-[14px] leading-[22.75px] font-light text-[#6B7280]">
              Accedi al tuo account qui sotto.
            </p>

            {/* Form */}
            <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
              {/* Email */}
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="email"
                  className="text-[14px] leading-[20px] font-medium tracking-[0.35px] text-[#111827]"
                >
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="tu@email.com"
                  className="w-full bg-white border border-[#E5E7EB] rounded px-3 py-2.5 text-[14px] leading-[20px] font-light text-[#111827] placeholder:text-[#6B7280] focus:outline-none focus:border-[#111827] transition-colors duration-150"
                  required
                  disabled={isLoading}
                />
              </div>

              {/* Password */}
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="password"
                  className="text-[14px] leading-[20px] font-medium tracking-[0.35px] text-[#111827]"
                >
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-white border border-[#E5E7EB] rounded px-3 py-2.5 pr-10 text-[14px] leading-[20px] font-light text-[#111827] placeholder:text-[#6B7280] focus:outline-none focus:border-[#111827] transition-colors duration-150"
                    required
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((p) => !p)}
                    disabled={isLoading}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-[#6B7280] hover:text-[#111827] transition-colors duration-150 disabled:opacity-50"
                    aria-label={showPassword ? 'Nascondi password' : 'Mostra password'}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Remember me */}
              <div className="flex items-center gap-2.5 pt-1">
                <input
                  id="remember-me"
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  disabled={isLoading}
                  className="h-4 w-4 rounded-[4px] border-[#E5E7EB] text-[#111827] focus:ring-1 focus:ring-[#111827]"
                />
                <label
                  htmlFor="remember-me"
                  className="text-[14px] leading-[22.75px] font-light text-[#6B7280] select-none"
                >
                  Ricorda le mie credenziali
                </label>
              </div>

              {/* Error */}
              {error && (
                <div className="flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E5E7EB] rounded text-[14px] leading-[20px] font-light text-[#111827]">
                  <AlertCircle className="h-4 w-4 flex-shrink-0 text-[#111827]" />
                  <span>{error}</span>
                </div>
              )}

              {/* Submit (pill) */}
              <button
                type="submit"
                disabled={isLoading}
                className="mt-2 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#111827] hover:bg-black text-white text-[14px] leading-[20px] font-medium tracking-[0.35px] rounded-full transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
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
            </form>
          </div>
        </div>
      </main>
    </div>
  );
};
