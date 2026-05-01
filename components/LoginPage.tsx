import React, { useState } from 'react';
import { AlertCircle, Loader2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await login({ email, password });
    } catch (err: any) {
      setError(err.message || 'Credenziali non valide');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--risto-background)] grid grid-cols-1 md:grid-cols-2">
      {/* Left: form */}
      <div className="bg-white px-6 py-8 sm:px-10 md:px-12 md:py-10 flex flex-col min-h-screen md:min-h-0">
        <div className="flex items-center gap-2.5">
          <div className="risto-mark">R</div>
          <span className="text-[15px] font-medium tracking-[-0.2px] text-[var(--risto-text-secondary)]">Risto</span>
        </div>

        <div className="w-full max-w-[380px] mx-auto my-auto py-12">
          <h2 className="text-[22px] font-medium tracking-[-0.4px] text-[var(--risto-text-secondary)] text-center mb-8">
            Accedi al tuo ristorante
          </h2>

          <form onSubmit={handleSubmit} className="space-y-3.5">
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="risto-input"
              placeholder="Email"
              required
              disabled={isLoading}
            />

            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="risto-input pr-13"
                style={{ paddingRight: 52 }}
                placeholder="Password"
                required
                disabled={isLoading}
              />
              <button
                type="button"
                onClick={() => setShowPassword(prev => !prev)}
                disabled={isLoading}
                className="absolute right-5 top-1/2 -translate-y-1/2 text-[var(--risto-text-primary)] hover:text-[var(--risto-text-secondary)] transition-colors disabled:opacity-50"
                aria-label={showPassword ? 'Nascondi password' : 'Mostra password'}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
              </button>
            </div>

            {error && (
              <div className="flex items-center gap-2 px-4 py-3 bg-[var(--risto-red-soft)] rounded-2xl text-[var(--risto-red)] text-sm">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="risto-btn-primary mt-1.5 flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Accesso in corso…
                </>
              ) : (
                'Accedi'
              )}
            </button>
          </form>

          <div className="mt-6 text-center text-[13px] font-light text-[var(--risto-text-primary)]">
            <a href="#" className="text-[var(--risto-text-secondary)] underline decoration-[rgba(17,24,39,0.3)] underline-offset-[3px] font-normal">
              Password dimenticata?
            </a>
          </div>
        </div>

        <div className="text-center text-[11px] font-medium tracking-[0.35px] text-[var(--risto-text-primary)]">
          Risto Manager · Italia
        </div>
      </div>

      {/* Right: ambient image */}
      <div className="hidden md:block relative bg-[#F5F1EC] p-10 overflow-hidden">
        <div
          className="absolute inset-10 rounded"
          style={{
            background:
              "linear-gradient(135deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.15) 100%), url('https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=1200&q=80') center/cover no-repeat",
          }}
        />
        <div
          className="relative z-[2] mt-auto self-start max-w-[320px] text-white text-xs font-normal tracking-[0.2px] leading-[1.5] px-[18px] py-[14px] rounded-2xl absolute bottom-10 left-10"
          style={{
            background: 'rgba(17, 24, 39, 0.4)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
          }}
        >
          <strong className="font-medium block mb-0.5">Servizio cena</strong>
          Gestisci coperti, sala e magazzino in tempo reale.
        </div>
      </div>
    </div>
  );
};
