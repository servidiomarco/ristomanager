// HACCP — lettura del documento di trasporto (Fase 4 di docs/haccp-piano.md).
//
// La foto (o il PDF) della bolla diventa una PROPOSTA di righe di ricevimento:
// fornitore, numero e data del documento, e per ogni prodotto lotto,
// scadenza, quantità e tipo di merce. Non scrive niente: il modulo mostra la
// proposta, la persona corregge e conferma riga per riga — è la regola di
// tutta l'AI dell'app, propone e non decide. La temperatura all'arrivo e
// l'esito non stanno sulla bolla: li mette chi riceve la merce.
//
// Gira sul backend: la chiave non attraversa mai il browser.

import Anthropic from '@anthropic-ai/sdk';
import { HACCP_RECEIPT_CATEGORIES, HaccpReceiptCategory } from '../utils/haccp.js';

const MODEL = 'claude-opus-5-5';
// Una bolla ha poche decine di righe: lo spazio basta, e il ragionamento
// attinge allo stesso budget.
const MAX_TOKEN = 8000;
// Leggere una bolla scritta a mano o fotografata storta chiede attenzione,
// non ragionamento lungo: lo sforzo predefinito del modello, scritto per
// esteso perché non cambi sotto i piedi con il prossimo modello.
const SFORZO = 'medium' as const;
const MAX_LINES = 60;

export const DDT_MAX_BYTES = 5 * 1024 * 1024;
export const DDT_TYPES = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/;

export interface DdtScanLine {
    product: string;
    lotNumber: string | null;
    expiryDate: string | null;
    quantity: string | null;
    category: HaccpReceiptCategory | null;
}

export interface DdtScanResult {
    supplier: string | null;
    ddtNumber: string | null;
    documentDate: string | null;
    lines: DdtScanLine[];
    warnings: string[];
}

export interface DdtScanUsage {
    model: string;
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
}

export class DdtScanError extends Error {
    constructor(message: string, public readonly kind: 'not_configured' | 'refused' | 'upstream') {
        super(message);
        this.name = 'DdtScanError';
    }
}

export function isDdtScanConfigured(): boolean {
    return Boolean((process.env.ANTHROPIC_API_KEY || '').trim());
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

// Lo schema della risposta: con l'output strutturato il JSON arriva sempre
// valido e completo, e il server non deve indovinare dove finisce.
const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        supplier: nullable({ type: 'string' }),
        ddt_number: nullable({ type: 'string' }),
        document_date: nullable({ type: 'string' }),
        lines: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    product: { type: 'string' },
                    lot_number: nullable({ type: 'string' }),
                    expiry_date: nullable({ type: 'string' }),
                    quantity: nullable({ type: 'string' }),
                    category: nullable({ type: 'string', enum: HACCP_RECEIPT_CATEGORIES }),
                },
                required: ['product', 'lot_number', 'expiry_date', 'quantity', 'category'],
            },
        },
        warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['supplier', 'ddt_number', 'document_date', 'lines', 'warnings'],
};

const SYSTEM = `Leggi un documento di trasporto (DDT) o una fattura accompagnatoria arrivata con la merce in un ristorante italiano, e ricava i dati per il registro HACCP del ricevimento merci.

COSA ESTRARRE:
- supplier: chi ha consegnato la merce (il mittente o cedente), non il ristorante destinatario.
- ddt_number: il numero del documento, come è scritto.
- document_date: la data del documento in formato AAAA-MM-GG.
- lines: una riga per prodotto alimentare consegnato. Per ognuna: product (la descrizione leggibile, senza codici articolo), lot_number (il lotto, se stampato), expiry_date (la scadenza o il TMC in AAAA-MM-GG, se stampata), quantity (quantità con unità di misura, come sul documento), category (REFRIGERATO, CARNE, POLLAME, PESCE, LATTICINI, SURGELATO, ORTOFRUTTA, SECCO o ALTRO, solo quando il prodotto lo rende evidente).
- warnings: brevi note in italiano su quello che non si legge o è dubbio ("lotto della riga 3 illeggibile").

REGOLE:
- Scrivi solo quello che c'è sul documento. Un dato che non vedi vale null: niente lotti, scadenze o fornitori ricostruiti a intuito.
- Imballaggi, cauzioni, trasporto, sconti e righe non alimentari restano fuori.
- Se il documento non è un DDT o una fattura di merce, restituisci lines vuoto e spiegalo in warnings.`;

const isoDay = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
    if (!m) return null;
    const d = new Date(`${m[0]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : m[0];
};
const text = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s ? s.slice(0, max) : null;
};

/** La risposta del modello, ripulita: date vere o null, tipi di merce noti,
 *  righe senza prodotto scartate. L'output strutturato garantisce la forma,
 *  non il contenuto. */
export function normalizeDdtScan(raw: any): DdtScanResult {
    const lines: DdtScanLine[] = (Array.isArray(raw?.lines) ? raw.lines : [])
        .map((l: any): DdtScanLine | null => {
            const product = text(l?.product, 255);
            if (!product) return null;
            const category = HACCP_RECEIPT_CATEGORIES.includes(l?.category) ? l.category as HaccpReceiptCategory : null;
            return {
                product,
                lotNumber: text(l?.lot_number, 100),
                expiryDate: isoDay(l?.expiry_date),
                quantity: text(l?.quantity, 50),
                category,
            };
        })
        .filter((l: DdtScanLine | null): l is DdtScanLine => l !== null)
        .slice(0, MAX_LINES);
    return {
        supplier: text(raw?.supplier, 255),
        ddtNumber: text(raw?.ddt_number, 50),
        documentDate: isoDay(raw?.document_date),
        lines,
        warnings: (Array.isArray(raw?.warnings) ? raw.warnings : [])
            .map((w: unknown) => text(w, 300))
            .filter((w: string | null): w is string => !!w)
            .slice(0, 10),
    };
}

export async function scanDdt(
    file: { data: string; contentType: string },
    onUsage?: (u: DdtScanUsage) => void,
): Promise<DdtScanResult> {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) throw new DdtScanError('ANTHROPIC_API_KEY non configurata sul backend', 'not_configured');

    const media: Anthropic.Beta.BetaContentBlockParam = file.contentType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } }
        : {
            type: 'image',
            source: { type: 'base64', media_type: file.contentType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: file.data },
        };

    let response: Anthropic.Beta.BetaMessage;
    try {
        const client = new Anthropic({ apiKey });
        response = await client.beta.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKEN,
            // Se il modello rifiuta (un documento scambiato per altro), la
            // richiesta passa da sola al modello di ripiego scelto dal server.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: SFORZO, format: { type: 'json_schema', schema: SCHEMA } },
            system: SYSTEM,
            messages: [{
                role: 'user',
                content: [media, { type: 'text', text: 'Leggi questo documento di trasporto.' }],
            }],
        });
    } catch (err: any) {
        throw new DdtScanError(err?.message || 'Errore dal modello', 'upstream');
    }

    if (onUsage) {
        onUsage({
            model: response.model || MODEL,
            promptTokens: response.usage.input_tokens ?? 0,
            outputTokens: response.usage.output_tokens ?? 0,
            totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
        });
    }

    if (response.stop_reason === 'refusal') {
        throw new DdtScanError('Il documento non si può leggere', 'refused');
    }
    const json = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();
    try {
        return normalizeDdtScan(JSON.parse(json));
    } catch {
        throw new DdtScanError('Risposta del modello non leggibile', 'upstream');
    }
}
