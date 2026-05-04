import { useEffect, useRef } from 'react';
import { authApiService } from '../services/authApiService';

const WARNING_LEAD_MS = 5 * 60 * 1000; // warn 5 minutes before expiry
const POLL_INTERVAL_MS = 30 * 1000;    // re-check every 30s in case the token gets refreshed

interface ToastAction {
  label: string;
  onClick: () => void;
}

type ShowWarningToast = (
  message: string,
  type: 'success' | 'error' | 'info',
  options?: { title?: string; duration?: number; action?: ToastAction }
) => void;

interface Options {
  isAuthenticated: boolean;
  showToast: ShowWarningToast;
}

const decodeExpiryMs = (token: string): number | null => {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
};

export const useTokenExpiryWarning = ({ isAuthenticated, showToast }: Options): void => {
  const warnedForTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) {
      warnedForTokenRef.current = null;
      return;
    }

    let cancelled = false;

    const check = () => {
      if (cancelled) return;
      const token = authApiService.getAccessToken();
      if (!token) return;

      // Reset warning state on token rotation
      if (warnedForTokenRef.current && warnedForTokenRef.current !== token) {
        warnedForTokenRef.current = null;
      }
      if (warnedForTokenRef.current === token) return;

      const expiryMs = decodeExpiryMs(token);
      if (expiryMs == null) return;

      const msUntilExpiry = expiryMs - Date.now();
      if (msUntilExpiry <= 0 || msUntilExpiry > WARNING_LEAD_MS) return;

      warnedForTokenRef.current = token;

      const minutes = Math.max(1, Math.ceil(msUntilExpiry / 60000));
      showToast(
        `La sessione scade tra ${minutes} ${minutes === 1 ? 'minuto' : 'minuti'}`,
        'info',
        {
          title: 'Sessione in scadenza',
          duration: msUntilExpiry,
          action: {
            label: 'Estendi',
            onClick: async () => {
              const refreshed = await authApiService.refreshToken();
              if (refreshed) {
                showToast('Sessione estesa', 'success');
              } else {
                showToast('Impossibile estendere la sessione', 'error');
              }
            },
          },
        }
      );
    };

    check();
    const interval = setInterval(check, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isAuthenticated, showToast]);
};
