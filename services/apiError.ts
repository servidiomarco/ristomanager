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
    const base = data.error || fallback || `Request failed with status ${status}`;
    // `detail` is optional and often absent; only append when it adds something
    // and isn't just a repeat of the headline.
    const detail = typeof data.detail === 'string' ? data.detail.trim() : '';
    const message = detail && detail !== base ? `${base}: ${detail}` : String(base);
    const err = new Error(message) as ApiError;
    err.status = status;
    err.data = data;
    return err;
}
