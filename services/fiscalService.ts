// Driver fiscali per il documento commerciale (fase 3 del piano fatturazione,
// provider scelti in docs/confronto-provider-fiscali.md). Questo modulo è
// volutamente PURO rispetto al database: costruisce il payload dall'input e
// parla col provider. La persistenza (fiscal_documents), l'idempotenza e il
// flusso di emissione vivono in server.ts — così il payload builder si testa
// senza rete e il driver si sostituisce senza toccare il flusso.
//
// Driver disponibili:
//  - 'openapi': POST/DELETE /IT-e-receipts (corrispettivi, binario "soluzione
//    software" — vedi confronto provider). Bearer token e base URL da env:
//    OPENAPI_INVOICE_TOKEN, OPENAPI_INVOICE_BASE_URL (default sandbox
//    https://test.invoice.openapi.com).
//  - 'mock': nessuna rete, conferma sempre. Serve ai test API e alle demo
//    senza credenziali; rifiutato in produzione.

export type FiscalDriverName = 'openapi' | 'mock';

export interface EReceiptItemPayload {
    quantity: string;       // "1.00" — due decimali
    description: string;
    unit_price: string;     // lordo IVA inclusa, "12.50"
    vat_rate_code: string;  // "10.00" | "22.00" | ... | "N2"
}

// Payload di POST /IT-e-receipts (schema OAS Openapi, importi come stringhe).
export interface EReceiptPayload {
    fiscal_id: string;
    type: 'sale';
    items: EReceiptItemPayload[];
    cash_payment_amount: string;
    electronic_payment_amount: string;
    ticket_restaurant_payment_amount: string;
    ticket_restaurant_quantity: number;
    services_uncollected_amount: string;
    invoice_issuing: boolean;
    discount: string;
    additional_text?: string | null;
    lottery_code?: string | null;
}

export interface FiscalIssueResult {
    provider_ref: string;
    raw: any;
}

export interface FiscalProviderDriver {
    readonly name: FiscalDriverName;
    issueEReceipt(payload: EReceiptPayload): Promise<FiscalIssueResult>;
    voidEReceipt(providerRef: string): Promise<any>;
}

// Centesimi → stringa euro a due decimali ("1234" → "12.34"), il formato che
// l'API vuole su ogni importo.
export const centsToEuroString = (cents: number): string => (Math.round(cents) / 100).toFixed(2);

// Aliquota (intero %) → vat_rate_code dell'API. Lo 0 non esiste nell'enum:
// le operazioni a IVA zero viaggiano coi codici natura N1..N6. 'N2' (non
// soggette) è il default MENO sbagliato per un fuori-campo generico, ma la
// natura giusta dipende dal caso — DA VALIDARE COL COMMERCIALISTA prima di
// usare aliquota 0 in produzione (il piano lo segnala anche per la fattura).
export const vatRateToCode = (rate: number): string => {
    const r = Number.isFinite(rate) ? Math.max(0, rate) : 10;
    if (r === 0) return 'N2';
    return r.toFixed(2);
};

// Riga del libro cassa come serve al mapping (subset di BillPayment).
export interface FiscalPaymentInput {
    method: string;
    amount_cents: number;
    meta?: Record<string, any> | null;
}

export interface BuildEReceiptInput {
    fiscalId: string;
    totalCents: number;
    // Snapshot righe del conto (table_bills.items); null/vuoto per i conti
    // aperti a mano, che diventano una riga unica "Consumazione".
    items: { name: string; qty: number; unit_price_cents: number; vat_rate?: number }[] | null;
    // Movimenti attivi del libro cassa, specchi LINK_ONLINE inclusi.
    payments: FiscalPaymentInput[];
    // Acconto accreditato sul conto (quote deposit PAID): denaro già
    // incassato online prima della serata.
    depositCreditCents: number;
    lotteryCode?: string | null;
}

// Costruisce il payload del documento commerciale dal conto chiuso.
//
// Mapping metodi → campi dell'API:
//   CONTANTI → cash; POS_FISICO/SATISPAY/LINK_ONLINE/GIFT_CARD (+acconto) →
//   electronic; BUONO_PASTO → ticket (quantità da meta.ticket_quantity, o il
//   numero di movimenti); SOSPESO → services_uncollected + invoice_issuing
//   (il corrispettivo non riscosso che verrà fatturato); OMAGGIO → sconto
//   globale — fiscalmente discutibile (l'omaggio ha l'IVA), DA VALIDARE COL
//   COMMERCIALISTA insieme ai codici natura.
//
// La quadratura è l'invariante del documento: somma righe − sconti =
// incassato + non riscosso. Le mance restano fuori da tutto (non sono
// corrispettivo). Lo sconto delle comande (totale < somma righe) finisce nel
// campo discount globale insieme all'omaggio.
export function buildEReceiptPayload(input: BuildEReceiptInput): EReceiptPayload {
    const srcItems = Array.isArray(input.items) && input.items.length > 0
        ? input.items
        : [{ name: 'Consumazione', qty: 1, unit_price_cents: input.totalCents, vat_rate: 10 }];

    const items: EReceiptItemPayload[] = srcItems
        .filter(i => Number(i.qty) > 0 && Number(i.unit_price_cents) > 0)
        .map(i => ({
            quantity: Number(i.qty).toFixed(2),
            description: String(i.name || 'Articolo').slice(0, 1000),
            unit_price: centsToEuroString(Number(i.unit_price_cents)),
            vat_rate_code: vatRateToCode(Number(i.vat_rate ?? 10)),
        }));

    const itemsGrossCents = srcItems.reduce(
        (n, i) => n + (Number(i.qty) > 0 && Number(i.unit_price_cents) > 0
            ? Math.round(Number(i.unit_price_cents) * Number(i.qty)) : 0),
        0
    );

    let cash = 0, electronic = input.depositCreditCents, ticket = 0, ticketQty = 0, uncollected = 0, omaggio = 0;
    for (const p of input.payments) {
        const amount = Math.round(Number(p.amount_cents) || 0);
        if (amount <= 0) continue;
        switch (p.method) {
            case 'CONTANTI': cash += amount; break;
            case 'BUONO_PASTO': {
                ticket += amount;
                const qty = Number(p.meta?.ticket_quantity);
                ticketQty += Number.isInteger(qty) && qty > 0 ? qty : 1;
                break;
            }
            case 'SOSPESO': uncollected += amount; break;
            case 'OMAGGIO': omaggio += amount; break;
            default: electronic += amount; break; // POS_FISICO, SATISPAY, GIFT_CARD, LINK_ONLINE
        }
    }

    // Sconto delle comande (righe > totale) + omaggio: entrambi riducono il
    // dovuto rispetto alla somma delle righe.
    const orderDiscount = Math.max(0, itemsGrossCents - input.totalCents);
    const discount = orderDiscount + omaggio;

    return {
        fiscal_id: input.fiscalId,
        type: 'sale',
        items,
        cash_payment_amount: centsToEuroString(cash),
        electronic_payment_amount: centsToEuroString(electronic),
        ticket_restaurant_payment_amount: centsToEuroString(ticket),
        ticket_restaurant_quantity: ticketQty,
        services_uncollected_amount: centsToEuroString(uncollected),
        invoice_issuing: uncollected > 0,
        discount: centsToEuroString(discount),
        lottery_code: input.lotteryCode ?? null,
    };
}

// ---------------------------------------------------------------------------

class OpenapiDriver implements FiscalProviderDriver {
    readonly name = 'openapi' as const;

    private baseUrl(): string {
        // Default sandbox: passare in produzione è una SCELTA esplicita via
        // env, mai un fallback.
        return (process.env.OPENAPI_INVOICE_BASE_URL || 'https://test.invoice.openapi.com').replace(/\/$/, '');
    }

    private token(): string {
        const t = process.env.OPENAPI_INVOICE_TOKEN;
        if (!t) throw new Error('OPENAPI_INVOICE_TOKEN non configurato: crea un token su console.openapi.com (scope invoice) e mettilo in env');
        return t;
    }

    private async call(method: string, path: string, body?: any): Promise<any> {
        const res = await fetch(`${this.baseUrl()}${path}`, {
            method,
            headers: {
                'Authorization': `Bearer ${this.token()}`,
                'Content-Type': 'application/json',
            },
            body: body != null ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* risposta non-JSON: resta nel messaggio d'errore */ }
        if (!res.ok) {
            throw new Error(`Openapi ${method} ${path} → ${res.status}: ${json?.message ?? text.slice(0, 500)}`);
        }
        return json;
    }

    async issueEReceipt(payload: EReceiptPayload): Promise<FiscalIssueResult> {
        const json = await this.call('POST', '/IT-e-receipts', payload);
        const ref = json?.data?.id;
        if (!ref) throw new Error(`Openapi: risposta senza id documento: ${JSON.stringify(json).slice(0, 500)}`);
        return { provider_ref: String(ref), raw: json };
    }

    async voidEReceipt(providerRef: string): Promise<any> {
        return this.call('DELETE', `/IT-e-receipts/${encodeURIComponent(providerRef)}`);
    }
}

// Conferma sempre, nessuna rete: per i test API e le demo. Il provider_ref è
// riconoscibile a colpo d'occhio così un "MOCK-" in un ambiente vero urla.
class MockDriver implements FiscalProviderDriver {
    readonly name = 'mock' as const;
    private seq = 0;

    async issueEReceipt(payload: EReceiptPayload): Promise<FiscalIssueResult> {
        this.seq += 1;
        return {
            provider_ref: `MOCK-${Date.now()}-${this.seq}`,
            raw: { data: { id: `MOCK-${this.seq}`, status: 'ready', echo: payload } },
        };
    }

    async voidEReceipt(providerRef: string): Promise<any> {
        return { data: { id: providerRef, status: 'voided' } };
    }
}

const drivers: Record<FiscalDriverName, FiscalProviderDriver> = {
    openapi: new OpenapiDriver(),
    mock: new MockDriver(),
};

export function getFiscalDriver(name: string): FiscalProviderDriver {
    if (name === 'mock' && process.env.NODE_ENV === 'production') {
        throw new Error('Il driver fiscale mock non è ammesso in produzione');
    }
    const d = drivers[name as FiscalDriverName];
    if (!d) throw new Error(`Driver fiscale sconosciuto: ${name}`);
    return d;
}
