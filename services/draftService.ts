// Local-storage backed draft persistence for forms.
// Why: when a session expires mid-typing, the user shouldn't lose their work.
// Drafts are namespaced by formKey, expire after TTL_MS, and are scoped per-user.

const DRAFT_PREFIX = 'ristomanager_draft_';
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface DraftEnvelope<T> {
  data: T;
  savedAt: number;
  userId?: number | string | null;
}

const buildKey = (formKey: string): string => `${DRAFT_PREFIX}${formKey}`;

const getCurrentUserId = (): number | string | null => {
  try {
    const userJson = localStorage.getItem('ristomanager_user');
    if (!userJson) return null;
    const user = JSON.parse(userJson);
    return user?.id ?? null;
  } catch {
    return null;
  }
};

export const saveDraft = <T>(formKey: string, data: T): void => {
  try {
    const envelope: DraftEnvelope<T> = {
      data,
      savedAt: Date.now(),
      userId: getCurrentUserId(),
    };
    localStorage.setItem(buildKey(formKey), JSON.stringify(envelope));
  } catch {
    // localStorage may be full or disabled — silently ignore
  }
};

export const loadDraft = <T>(formKey: string): { data: T; savedAt: number } | null => {
  try {
    const raw = localStorage.getItem(buildKey(formKey));
    if (!raw) return null;
    const envelope: DraftEnvelope<T> = JSON.parse(raw);

    // Expired
    if (Date.now() - envelope.savedAt > TTL_MS) {
      localStorage.removeItem(buildKey(formKey));
      return null;
    }

    // Cross-user: don't surface another user's draft on this device
    const currentUserId = getCurrentUserId();
    if (envelope.userId != null && currentUserId != null && envelope.userId !== currentUserId) {
      return null;
    }

    return { data: envelope.data, savedAt: envelope.savedAt };
  } catch {
    return null;
  }
};

export const clearDraft = (formKey: string): void => {
  try {
    localStorage.removeItem(buildKey(formKey));
  } catch {
    // ignore
  }
};

// Form keys used across the app (centralized to avoid typos)
export const DRAFT_KEYS = {
  RESERVATION_NEW: 'reservation_new',
} as const;
