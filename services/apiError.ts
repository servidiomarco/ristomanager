// One definition of "turn a failed HTTP response into an Error" for every
// frontend API client.
//
// Each client used to inline its own version, and most of them built the
// message from the response's `error` field alone. That silently discarded
// `detail`, which is where the server puts the actual reason — a payment
// gateway refusing a refund, a validation message, the exception text. The
// symptom was an operator staring at "Rimborso SumUp fallito" with no way to
// learn why, while the server had already sent the explanation.
//
// Keeping this in one place means a client can't drift back to dropping it.

export interface ApiError extends Error {
    /** HTTP status of the failed response. */
    status?: number;
    /** Parsed response body, for callers that branch on a machine-readable code. */
    data?: any;
}

/**
 * Build the Error to throw for a non-2xx response.
 *
 * @param status   response.status
 * @param body     parsed JSON body (pass whatever `response.json()` gave you;
 *                 a non-object is tolerated)
 * @param fallback message when the body carries no `error` field
 */
export function buildApiError(status: number, body: any, fallback?: string): ApiError {
    const data = body && typeof body === 'object' ? body : {};
    // Molte route rispondono { error: 'codice_macchina', message: 'frase' }:
    // il codice serve ai client che ramificano (resta in err.data.error), la
    // frase all'operatore. Prendere sempre `error` mostrava il codice nudo —
    // «messaging_not_available» nel toast del link del conto su un
    // ristorante demo, invece di «Messaggi non ancora attivi…». Un `error`
    // in forma di frase (spazi, maiuscole) resta il titolo come prima.
    const errorIsCode = typeof data.error === 'string' && /^[a-z][a-z0-9_]*$/.test(data.error);
    const readableMessage = typeof data.message === 'string' ? data.message.trim() : '';
    const base = (errorIsCode && readableMessage) || data.error || fallback || `Request failed with status ${status}`;
    // `detail` is optional and often absent; only append when it adds something
    // and isn't just a repeat of the headline.
    const detail = typeof data.detail === 'string' ? data.detail.trim() : '';
    const message = detail && detail !== base ? `${base}: ${detail}` : String(base);
    const err = new Error(message) as ApiError;
    err.status = status;
    err.data = data;
    return err;
}
