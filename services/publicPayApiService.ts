// Public no-auth client for the /pay/:token guest page. Deliberately does
// NOT import authApiService / socketClient — the mobile page is a
// standalone tree rendered without the AuthProvider.

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export type PublicSplitKind = 'equal_share' | 'fixed_amount' | 'per_item';
export type PublicSplitStatus = 'CLAIMED' | 'PAID' | 'ABANDONED' | 'RELEASED' | 'REFUNDED';

export interface PublicSplitView {
  kind: PublicSplitKind;
  amount_cents: number;
  claimant_label: string | null;
  status: PublicSplitStatus;
}

export interface PublicBillItem {
  id: number;
  name: string;
  qty: number;
  total_cents: number;
  /** Già presa da un altro ospite: due persone non pagano lo stesso piatto. */
  taken: boolean;
}

export interface PublicBillView {
  bill: {
    total_cents: number;
    covers: number;
    currency: string;
    status: 'OPEN' | 'LOCKED';
  };
  splits: PublicSplitView[];
  paid_cents: number;
  claimed_cents: number;
  residual_cents: number;
  /** Falso quando il dettaglio manca o c'è uno sconto: in quel caso pagare
   *  "la propria riga" addebiterebbe più del dovuto. */
  per_item_available?: boolean;
  items?: PublicBillItem[];
}

export interface ClaimPayload {
  kind: PublicSplitKind;
  amount_cents?: number;
  item_ids?: number[];
  claimant_label?: string;
}

export interface ClaimResponse {
  split_id: number;
  amount_cents: number;
  claimant_label: string | null;
  expires_at: string;
  checkout_url: string | null;
  payment_request_id: number | null;
}

const jsonRequest = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const err: any = new Error(data?.error || `Request failed (${response.status})`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return response.json();
};

class PublicPayApiService {
  async getBill(token: string): Promise<PublicBillView | null> {
    try {
      return await jsonRequest<PublicBillView>(`${API_URL}/pay/${encodeURIComponent(token)}`);
    } catch (err: any) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  async claim(token: string, payload: ClaimPayload): Promise<ClaimResponse> {
    return jsonRequest<ClaimResponse>(`${API_URL}/pay/${encodeURIComponent(token)}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async release(token: string, splitId: number): Promise<{ released: boolean; split_id: number }> {
    return jsonRequest(`${API_URL}/pay/${encodeURIComponent(token)}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ split_id: splitId }),
    });
  }
}

export const publicPayApiService = new PublicPayApiService();
