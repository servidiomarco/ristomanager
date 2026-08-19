// I quattro strumenti di prenotazione, indipendenti dal canale.
//
// Nascono dentro gli endpoint `/webhook/elevenlabs/*` costruiti per Sofia, ma
// di vocale non hanno nulla: sono le regole di casa (date bloccate, soglia dei
// gruppi grandi, griglia degli slot, caparra automatica) più le validazioni
// che servono a qualunque LLM che prenoti al posto di una persona. Estrarli
// qui serve a un motivo preciso: quando arriverà il canale WhatsApp dovrà
// chiamare QUESTI, non una copia. Due copie divergono al primo cambio di
// regola, e la divergenza si scopre da un cliente arrivato davanti a un
// tavolo che non esiste.
//
// Cosa resta fuori, perché è davvero del canale:
//  - autenticazione (firma ElevenLabs, token WhatsApp)
//  - la forma del body in ingresso (`{parameters:{...}}` per ElevenLabs)
//  - gli interruttori del canale (voice_agent_enabled, sospensione telefonica)
//
// Le dipendenze arrivano da server.ts con `configureBookingTools()` invece che
// per import: quasi tutte vivono lì (socketService, policy caparra, invio
// messaggi) e importarle da qui creerebbe un ciclo.
//
// CONTRATTO DI RISPOSTA — da non cambiare alla leggera: gli errori che l'utente
// può correggere tornano con HTTP 200 e `success:false` + `message` in
// italiano, perché ElevenLabs non passa al modello il corpo delle risposte 4xx
// e l'agente ripiegherebbe su un generico "errore tecnico" invece di leggere
// il messaggio al cliente. Solo i guasti veri restano 5xx.

import { Shift } from '../types.js';

// I canali self-service (voce, WhatsApp) non hanno JWT: come in
// elevenlabsService, il tenant resta quello storico finché la Fase C non
// threada il tenant nella configurazione del canale.
const PUBLIC_TENANT_ID = 1;

// ---------------------------------------------------------------------------
// Contratto
// ---------------------------------------------------------------------------

export interface ToolOutcome {
    /** Corpo JSON da restituire al modello, identico su ogni canale. */
    body: Record<string, any>;
    /** true solo per guasti tecnici: l'adattatore risponde 500. */
    serverError?: boolean;
}

/** Come il canale si presenta nei log, nelle notifiche e nell'audit. */
export interface ToolChannel {
    id: 'voice' | 'whatsapp';
    /** Prefisso dei log applicativi, es. "[ElevenLabs]". */
    logPrefix: string;
    /** Attribuzione nell'activity log (non c'è un utente autenticato). */
    actorEmail: string;
    actorName: string;
    /** Valore del campo `source` nei metadati dell'audit. */
    sourceTag: string;
    /** Titoli delle push allo staff. */
    pushTitles: { created: string; cancelled: string; modified: string };
    /** Aggancio all'audit del canale (per la voce: la riga in voice_calls). */
    linkConversation?: (p: { conversationId: string; phone: string; reservationId: number }) => void;
}

export const VOICE_CHANNEL: ToolChannel = {
    id: 'voice',
    logPrefix: '[ElevenLabs]',
    actorEmail: 'voice-agent@elevenlabs',
    actorName: 'Agent vocale',
    sourceTag: 'VOICE',
    pushTitles: {
        created: 'Nuova prenotazione vocale',
        cancelled: 'Prenotazione cancellata (voce)',
        modified: 'Prenotazione modificata (voce)',
    },
};

// Il canale chat. L'aggancio alla conversazione non serve: i messaggi sono
// già legati alla prenotazione da resolveReservationByPhone (PR #132).
export const WHATSAPP_CHANNEL: ToolChannel = {
    id: 'whatsapp',
    logPrefix: '[WhatsApp]',
    actorEmail: 'agente-whatsapp@ristomanager',
    actorName: 'Agente WhatsApp',
    sourceTag: 'WHATSAPP',
    pushTitles: {
        created: 'Nuova prenotazione da WhatsApp',
        cancelled: 'Prenotazione cancellata (WhatsApp)',
        modified: 'Prenotazione modificata (WhatsApp)',
    },
};

/** Tutto ciò che gli strumenti prendono da server.ts. */
export interface BookingToolsDeps {
    parseFlexibleDate: (v: any) => string | null;
    parseFlexibleTime: (v: any) => string | null;
    normalizeItalianPhone: (v: string) => string;
    normalizeCustomerName: (v: string) => string;
    formatItalianDateReadback: (date: string) => string;
    formatItalianConfirmation: (r: any) => string;
    formatItalianCancellation: (r: any) => string;
    formatItalianModification: (r: any) => string;
    formatSlotListItalian: (slots: string[]) => string;
    formatBookingDateTime: (d: any) => { dateLabel: string; timeLabel: string };
    formatEuroMinor: (cents: number) => string;
    asUtcInstant: (v: any) => any;
    toTitleCase: (v: any) => string;
    reservationPushLabel: (d: any) => string;

    findAvailability: (p: any) => Promise<any>;
    getAvailableSlots: (date: string, shift: Shift) => Promise<string[]>;
    createVoiceReservation: (p: any) => Promise<any>;
    cancelVoiceReservation: (p: any) => Promise<any>;
    modifyVoiceReservation: (p: any) => Promise<any>;
    recordVoiceCall: (p: any) => Promise<any>;
    upsertCustomerFromReservation: (name: string, phone: string, a: any, b: any) => Promise<any>;

    getVoiceDateBlocks: () => Promise<any>;
    findVoiceDateBlock: (date: string, shift: 'LUNCH' | 'DINNER', blocks: any) => any;
    buildVoiceDateBlockMessage: (date: string, shift: 'LUNCH' | 'DINNER', block: any) => string;
    getLargeGroupThreshold: () => Promise<number>;

    isAutoDepositRequired: (guests: number) => Promise<boolean>;
    getAutoDepositPolicy: () => Promise<{ enabled: boolean; minGuests: number; perPersonCents: number }>;
    depositDefaultPerPersonCents: number;
    createPaymentOrder: (p: any) => Promise<any>;
    queryWithRetry: (sql: string, params?: any[]) => Promise<any>;
    buildDepositRequestMessage: (...a: any[]) => string;
    buildBookingDepositRequestTemplate: (...a: any[]) => any;
    sendBookingConfirmation: (phone: string, text: string, resId: number, opts?: any) => Promise<any>;

    logActivity: (...a: any[]) => void;
    activityAction: { CREATE: any; UPDATE: any; DELETE: any };
    resourceType: { RESERVATION: any };
    pushSendToRoles: (roles: string[], payload: any, opts?: any) => Promise<any>;
    broadcastReservationCreated: (r: any) => void;
    broadcastReservationUpdated: (r: any) => void;
    broadcastPaymentRequestCreated: (r: any) => void;
    broadcastReservationsUpdatedByIds: (ids: number[]) => Promise<any>;
}

let D: BookingToolsDeps | null = null;

export function configureBookingTools(deps: BookingToolsDeps): void {
    D = deps;
}

function deps(): BookingToolsDeps {
    if (!D) throw new Error('bookingTools non configurato: chiamare configureBookingTools() all\'avvio');
    return D;
}

// ---------------------------------------------------------------------------
// Messaggi di errore condivisi — stessa frase su ogni canale, così il cliente
// sente e legge le stesse parole.
// ---------------------------------------------------------------------------

const MSG = {
    invalidDate: 'Formato data non riconosciuto. Esempi accettati: 2026-05-14, 14/05/2026, "14 maggio 2026".',
    invalidTime: 'Formato orario non riconosciuto. Esempi accettati: 20:30, "20 e 30", "20 e mezza".',
    invalidShift: 'Il turno non è valido. Può indicare se si tratta di pranzo o cena?',
    invalidGuests: 'Il numero di ospiti non è valido. Può ripetermi per quante persone vuole prenotare?',
    invalidPhoneCreate: 'Non ho un numero di telefono per la prenotazione. Può dettarmelo?',
    invalidPhoneFind: 'Non ho un numero di telefono a cui associare la prenotazione. Può dettarmelo?',
    notFound: 'Non trovo una prenotazione a questo numero per la data indicata. Può confermarmi la data esatta?',
    largeGroup: (threshold: number) =>
        `Per gruppi da ${threshold + 1} persone in su preferiamo gestire la prenotazione al telefono. Lascio un promemoria e la richiamiamo il prima possibile.`,
};

const isShift = (s: string): s is Shift => s === Shift.LUNCH || s === Shift.DINNER;

// ---------------------------------------------------------------------------
// Tool 1 — check_availability
// ---------------------------------------------------------------------------

export interface CheckAvailabilityParams {
    date?: any;
    shift?: any;
    guests?: any;
    location_preference?: any;
}

export async function checkAvailability(
    p: CheckAvailabilityParams,
    channel: ToolChannel = VOICE_CHANNEL
): Promise<ToolOutcome> {
    const d = deps();
    const fail = (error: string, message: string, extra: Record<string, any> = {}): ToolOutcome => ({
        body: { available: false, free_tables_count: 0, error, message, ...extra },
    });

    const rawShift = String(p.shift ?? '').trim().toUpperCase();
    const guests = Number(p.guests);
    const rawLocation = String(p.location_preference ?? '').trim().toUpperCase();
    const locationPreference = rawLocation === 'INDOOR' || rawLocation === 'OUTDOOR'
        ? (rawLocation as 'INDOOR' | 'OUTDOOR')
        : undefined;

    const normalizedDate = d.parseFlexibleDate(p.date);
    if (!normalizedDate) {
        console.warn(`${channel.logPrefix} check-availability rejected: unparseable date`, { received: p.date });
        return fail('invalid_date', MSG.invalidDate);
    }
    if (!isShift(rawShift)) return fail('invalid_shift', MSG.invalidShift);
    if (!Number.isFinite(guests) || guests < 1 || guests > 50) return fail('invalid_guests', MSG.invalidGuests);

    // Data bloccata dall'operatore (feste a menù fisso ecc.): non si prenota e
    // non si leggono nemmeno i tavoli liberi, si invita a richiamare.
    const dateBlock = d.findVoiceDateBlock(normalizedDate, rawShift, await d.getVoiceDateBlocks());
    if (dateBlock) {
        console.log(`${channel.logPrefix} check-availability blocked date`, { date: normalizedDate, shift: rawShift, block: dateBlock });
        return fail('date_blocked', d.buildVoiceDateBlockMessage(normalizedDate, rawShift, dateBlock), {
            date_readback: d.formatItalianDateReadback(normalizedDate),
        });
    }

    // Gruppi grandi a una persona. Il motivo storico: findAvailability filtra
    // per `tables.seats >= guests`, quindi un gruppo più grande del tavolo più
    // grande risulta sempre senza posto anche a sala vuota (successo il
    // 2026-07-17 con 11 persone). Invece di insegnare al modello a ragionare
    // sull'unione dei tavoli, sopra soglia si passa la mano.
    const threshold = await d.getLargeGroupThreshold();
    if (guests > threshold) {
        console.log(`${channel.logPrefix} check-availability handoff (large group)`, { date: normalizedDate, shift: rawShift, guests, threshold });
        return fail('large_group', MSG.largeGroup(threshold));
    }

    try {
        const result = await d.findAvailability({
            date: normalizedDate,
            shift: rawShift as Shift,
            guests: Math.trunc(guests),
            location_preference: locationPreference,
        });
        console.log(`${channel.logPrefix} check-availability`, { date: normalizedDate, raw_date: p.date, shift: rawShift, guests, location_preference: locationPreference, result });
        // date_readback è la stringa "venerdì 10 luglio" che il modello DEVE
        // ripetere alla lettera: da solo sbaglia regolarmente l'accoppiata
        // giorno della settimana / giorno del mese.
        return { body: { ...result, date_readback: d.formatItalianDateReadback(normalizedDate) } };
    } catch (err) {
        console.error(`${channel.logPrefix} check-availability error`, err);
        return {
            serverError: true,
            body: { available: false, free_tables_count: 0, message: 'Si è verificato un errore tecnico, posso richiamarla?' },
        };
    }
}

// ---------------------------------------------------------------------------
// Tool 2 — create_reservation
// ---------------------------------------------------------------------------

export interface CreateReservationParams {
    customer_name?: any;
    phone?: any;
    caller_id?: any;
    date?: any;
    time?: any;
    shift?: any;
    guests?: any;
    children?: any;
    notes?: any;
    location_preference?: any;
    conversation_id?: string;
}

// Quando il modello salta la raccolta del nome riempie il campo obbligatorio
// con un segnaposto: rifiutarli lo costringe a chiedere davvero al cliente.
const NAME_PLACEHOLDERS = new Set([
    'cliente', 'customer', 'ospite', 'guest', 'anonimo', 'sconosciuto',
    'signore', 'signora', 'sig', 'n/a', 'na', 'test', 'nome', 'nome cognome',
]);

export async function createReservation(
    p: CreateReservationParams,
    channel: ToolChannel = VOICE_CHANNEL
): Promise<ToolOutcome> {
    const d = deps();
    const conversationId = p.conversation_id;
    const fail = (error: string, message: string, extra: Record<string, any> = {}): ToolOutcome => ({
        body: { success: false, error, message, ...extra },
    });

    const customerName = d.normalizeCustomerName(String(p.customer_name ?? '').trim());
    // Telefono: vince quello dettato o confermato dal cliente; il caller_id
    // (catturato dall'intestazione SIP) è la rete di sicurezza per quando il
    // modello dimentica di interpolare la variabile.
    const callerIdRaw = String(p.caller_id ?? '').trim();
    const phoneRaw = String(p.phone ?? '').trim() || callerIdRaw;
    const phoneSource: 'customer' | 'caller_id' | 'none' = String(p.phone ?? '').trim()
        ? 'customer' : callerIdRaw ? 'caller_id' : 'none';
    const rawShift = String(p.shift ?? '').trim().toUpperCase();
    const guests = Number(p.guests);
    const notes = typeof p.notes === 'string' ? p.notes.trim() : undefined;
    const rawLocation = String(p.location_preference ?? '').trim().toUpperCase();
    const locationPreference = rawLocation === 'INDOOR' || rawLocation === 'OUTDOOR'
        ? (rawLocation as 'INDOOR' | 'OUTDOOR')
        : undefined;

    if (!customerName) {
        return fail('invalid_customer_name', 'Non ho colto il nome per la prenotazione. Può ripetermi il nome del cliente?');
    }
    if (NAME_PLACEHOLDERS.has(customerName.toLowerCase().trim())) {
        console.warn(`${channel.logPrefix} create-reservation rejected: placeholder name`, { received: customerName });
        return fail('invalid_customer_name', 'Serve il nome reale del cliente per registrare la prenotazione. Chieda nome e cognome al cliente e riprovi.');
    }
    if (!phoneRaw) return fail('invalid_phone', MSG.invalidPhoneCreate);

    const normalizedDate = d.parseFlexibleDate(p.date);
    if (!normalizedDate) {
        console.warn(`${channel.logPrefix} create-reservation rejected: unparseable date`, { received: p.date });
        return fail('invalid_date', MSG.invalidDate);
    }
    const normalizedTime = d.parseFlexibleTime(p.time);
    if (!normalizedTime) {
        console.warn(`${channel.logPrefix} create-reservation rejected: unparseable time`, { received: p.time });
        return fail('invalid_time', MSG.invalidTime);
    }
    if (!isShift(rawShift)) return fail('invalid_shift', MSG.invalidShift);

    // Doppia difesa sul blocco data: un modello che salta il controllo di
    // disponibilità non deve comunque poter prenotare un giorno riservato.
    const dateBlock = d.findVoiceDateBlock(normalizedDate, rawShift, await d.getVoiceDateBlocks());
    if (dateBlock) {
        console.log(`${channel.logPrefix} create-reservation blocked date`, { date: normalizedDate, shift: rawShift, block: dateBlock, conversation_id: conversationId });
        return fail('date_blocked', d.buildVoiceDateBlockMessage(normalizedDate, rawShift, dateBlock));
    }

    // L'orario deve stare sulla griglia degli slot, altrimenti la prenotazione
    // non torna uguale passando dal modulo di modifica manuale. La griglia
    // dipende da opening_hours + special_closures, quindi cambia per giorno.
    const validSlots = await d.getAvailableSlots(normalizedDate, rawShift as Shift);
    if (!validSlots.includes(normalizedTime)) {
        const shiftLabel = (rawShift as Shift) === Shift.LUNCH ? 'il pranzo' : 'la cena';
        console.warn(`${channel.logPrefix} create-reservation rejected: invalid_slot`, {
            received_time: p.time, normalized_time: normalizedTime, shift: rawShift, available_slots: validSlots,
        });
        const message = validSlots.length === 0
            ? `Mi dispiace, ${shiftLabel} di quel giorno non è disponibile. Possiamo provare un altro giorno?`
            : `Per ${shiftLabel} possiamo prenotare solo alle ${d.formatSlotListItalian(validSlots)}. Quale orario preferisce?`;
        return fail('invalid_slot', message, { available_slots: validSlots });
    }
    if (!Number.isFinite(guests) || guests < 1 || guests > 50) return fail('invalid_guests', MSG.invalidGuests);

    const threshold = await d.getLargeGroupThreshold();
    if (guests > threshold) {
        console.log(`${channel.logPrefix} create-reservation blocked (large group)`, { guests, threshold, conversation_id: conversationId });
        return fail('large_group', MSG.largeGroup(threshold));
    }

    const childrenNum = Number(p.children);
    const children = Number.isFinite(childrenNum) && childrenNum > 0
        ? Math.max(0, Math.min(Math.trunc(childrenNum), Math.trunc(guests)))
        : 0;

    // La colonna è TIMESTAMPTZ: lasciamo interpretare a Postgres nel fuso del
    // server (Europe/Rome in produzione).
    const reservationTime = `${normalizedDate}T${normalizedTime}:00`;
    const depositRequired = await d.isAutoDepositRequired(Math.trunc(guests));

    try {
        console.log(`${channel.logPrefix} create-reservation start`, {
            customer_name: customerName, raw_date: p.date, raw_time: p.time,
            normalized_date: normalizedDate, normalized_time: normalizedTime,
            shift: rawShift, guests, children, conversation_id: conversationId,
            location_preference: locationPreference, phone_source: phoneSource,
            deposit_required: depositRequired,
        });
        const created = await d.createVoiceReservation({
            customer_name: customerName,
            phone: phoneRaw,
            reservation_time: reservationTime,
            shift: rawShift as Shift,
            guests: Math.trunc(guests),
            children,
            notes,
            conversation_id: conversationId,
            location_preference: locationPreference,
            deposit_required: depositRequired,
        });

        // Caparra: ordine + riga payment_requests + invio del link. Se il
        // gateway fallisce si degrada al flusso "da rivedere", con lo staff che
        // completa a mano dalla scheda.
        let depositCheckoutUrl: string | null = null;
        let depositAmountCents = 0;
        const depositPolicy = depositRequired ? await d.getAutoDepositPolicy() : null;
        if (depositRequired) {
            depositAmountCents = Math.trunc(guests) * (depositPolicy?.perPersonCents ?? d.depositDefaultPerPersonCents);
            const [yyyy, mm, dd] = normalizedDate.split('-');
            const depositDateLabel = `${dd}/${mm}/${yyyy}`;
            const depositGuestsLabel = `${Math.trunc(guests)} ${Math.trunc(guests) === 1 ? 'persona' : 'persone'}`;
            const orderDescription = `Caparra prenotazione #${created.id} - ${depositGuestsLabel} ${depositDateLabel} ${normalizedTime}`;
            try {
                const order = await d.createPaymentOrder({
                    amount: depositAmountCents,
                    currency: 'EUR',
                    description: orderDescription,
                    reference: `reservation:${created.id}`,
                    flow: 'deposit',
                });
                const insertedPayment = await d.queryWithRetry(
                    `INSERT INTO payment_requests
                        (tenant_id, reservation_id, amount_cents, currency, description, status, provider,
                         provider_order_id, checkout_url, metadata)
                     VALUES ($9, $1, $2, 'EUR', $3, $4, $5, $6, $7, $8)
                     RETURNING *`,
                    [
                        created.id, depositAmountCents, orderDescription, order.status, order.provider,
                        order.id, order.checkoutUrl,
                        JSON.stringify({ ...order.metadata, source: `${channel.id}_auto_deposit` }),
                        PUBLIC_TENANT_ID,
                    ]
                );
                depositCheckoutUrl = order.checkoutUrl;
                try { d.broadcastPaymentRequestCreated(insertedPayment.rows[0]); }
                catch (err) { console.warn(`${channel.logPrefix} payment socket broadcast failed:`, err); }

                const smsText = d.buildDepositRequestMessage(
                    d.toTitleCase(created.customer_name), depositGuestsLabel, depositDateLabel,
                    normalizedTime, depositAmountCents, order.checkoutUrl, depositPolicy?.perPersonCents
                );
                const whatsappTemplate = d.buildBookingDepositRequestTemplate(
                    d.toTitleCase(created.customer_name), depositGuestsLabel, depositDateLabel,
                    normalizedTime, depositAmountCents, order.checkoutUrl
                );
                d.sendBookingConfirmation(created.phone, smsText, created.id, { whatsappTemplate }).catch((err: any) =>
                    console.error(`${channel.logPrefix} deposit link send failed:`, err?.message || err)
                );
            } catch (err: any) {
                console.error(`${channel.logPrefix} deposit link creation failed:`, err?.message || err);
                depositAmountCents = 0;
            }
        }

        if (conversationId && channel.linkConversation) {
            channel.linkConversation({
                conversationId,
                phone: d.normalizeItalianPhone(phoneRaw),
                reservationId: created.id,
            });
        }

        // Rubrica: il canale self-service è il modo più comune in cui un
        // cliente nuovo compare la prima volta nel sistema.
        await d.upsertCustomerFromReservation(customerName, phoneRaw, null, null);

        d.logActivity(
            null, channel.actorEmail, channel.actorName,
            d.activityAction.CREATE, d.resourceType.RESERVATION,
            created.id, created.customer_name,
            {
                source: channel.sourceTag,
                conversation_id: conversationId,
                requires_review: created.requires_review,
                guests: created.guests,
                children: created.children,
                reservation_time: created.reservation_time,
                shift: created.shift,
            }
        );

        try {
            d.broadcastReservationCreated(created);
            // La riga appena trasmessa non ha i campi latest_payment_*: se la
            // caparra è partita si rimanda la versione arricchita, così
            // l'icona dell'acconto compare subito in dashboard.
            if (depositCheckoutUrl) d.broadcastReservationsUpdatedByIds([created.id]).catch(() => {});
        } catch (err) {
            console.warn(`${channel.logPrefix} broadcastReservationCreated failed:`, err);
        }

        const reservationLabel = d.reservationPushLabel(d.asUtcInstant(created.reservation_time));
        d.pushSendToRoles(
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
                category: 'reservation',
                title: channel.pushTitles.created,
                body: `${d.toTitleCase(created.customer_name)} · ${created.guests} ospiti · ${reservationLabel}`,
                url: `/?view=RESERVATIONS&reservationId=${created.id}`,
                tag: `reservation-${created.id}`,
            },
            { excludeUserId: null }
        ).catch((err: any) => console.error(`Push (${channel.id} reservation) failed:`, err));

        // Con la caparra la frase di chiusura cambia: il cliente deve sapere
        // che il tavolo è garantito solo dopo il pagamento.
        const firstName = d.toTitleCase(created.customer_name).split(' ')[0];
        const confirmationPhrase = depositCheckoutUrl
            ? `Registrato ${firstName}: per i gruppi numerosi chiediamo una caparra di ${d.formatEuroMinor(depositAmountCents)}. Le ho appena inviato il link di pagamento su WhatsApp, o via SMS. Il tavolo sarà confermato appena riceviamo il pagamento. Grazie!`
            : depositRequired
                ? `Registrato ${firstName}: per i gruppi numerosi è prevista una caparra. La ricontatteremo a breve per completare la prenotazione. Grazie!`
                : d.formatItalianConfirmation(created);

        console.log(`${channel.logPrefix} create-reservation OK`, {
            id: created.id, conversation_id: conversationId, customer: created.customer_name,
            table_id: created.table_id, table_name: created.table_name,
            room: created.room_name, location: created.room_location,
            deposit_required: depositRequired, deposit_link_sent: !!depositCheckoutUrl,
        });
        return {
            body: {
                success: true,
                reservation_id: created.id,
                requires_review: created.requires_review,
                confirmation_phrase: confirmationPhrase,
                date_readback: d.formatItalianDateReadback(normalizedDate),
                table_id: created.table_id,
                table_name: created.table_name,
                room_name: created.room_name,
                room_location: created.room_location,
                deposit_required: depositRequired,
                deposit_amount: depositRequired ? d.formatEuroMinor(depositAmountCents) : undefined,
                deposit_link_sent: depositRequired ? !!depositCheckoutUrl : undefined,
            },
        };
    } catch (err: any) {
        console.error(`${channel.logPrefix} create-reservation error`, err);
        return {
            serverError: true,
            body: { success: false, message: 'Si è verificato un errore tecnico nel salvare la prenotazione, posso richiamarla?' },
        };
    }
}

// ---------------------------------------------------------------------------
// Tool 3 — cancel_reservation
// ---------------------------------------------------------------------------

export interface CancelReservationParams {
    phone?: any;
    caller_id?: any;
    date?: any;
    time?: any;
    conversation_id?: string;
}

export async function cancelReservation(
    p: CancelReservationParams,
    channel: ToolChannel = VOICE_CHANNEL
): Promise<ToolOutcome> {
    const d = deps();
    const conversationId = p.conversation_id;
    const fail = (error: string, message: string): ToolOutcome => ({ body: { success: false, error, message } });

    const callerIdRaw = String(p.caller_id ?? '').trim();
    const phoneRaw = String(p.phone ?? '').trim() || callerIdRaw;
    const phoneSource: 'customer' | 'caller_id' | 'none' = String(p.phone ?? '').trim()
        ? 'customer' : callerIdRaw ? 'caller_id' : 'none';

    if (!phoneRaw) return fail('invalid_phone', MSG.invalidPhoneFind);
    const normalizedDate = d.parseFlexibleDate(p.date);
    if (!normalizedDate) {
        console.warn(`${channel.logPrefix} cancel-reservation rejected: unparseable date`, { received: p.date });
        return fail('invalid_date', MSG.invalidDate);
    }
    // L'orario è facoltativo: serve solo a distinguere quando lo stesso numero
    // ha più prenotazioni nello stesso giorno.
    let normalizedTime: string | undefined;
    if (p.time !== undefined && p.time !== null && String(p.time).trim() !== '') {
        const t = d.parseFlexibleTime(p.time);
        if (!t) {
            console.warn(`${channel.logPrefix} cancel-reservation rejected: unparseable time`, { received: p.time });
            return fail('invalid_time', MSG.invalidTime);
        }
        normalizedTime = t;
    }

    try {
        console.log(`${channel.logPrefix} cancel-reservation start`, {
            phone_raw: phoneRaw, phone_source: phoneSource,
            normalized_date: normalizedDate, normalized_time: normalizedTime, conversation_id: conversationId,
        });
        const outcome = await d.cancelVoiceReservation({
            phone: phoneRaw, date: normalizedDate, time: normalizedTime, conversation_id: conversationId,
        });

        if (outcome.status === 'not_found') {
            console.log(`${channel.logPrefix} cancel-reservation: no match`, {
                phone: d.normalizeItalianPhone(phoneRaw), date: normalizedDate, time: normalizedTime,
            });
            return { body: { success: false, status: 'not_found', message: MSG.notFound } };
        }

        if (outcome.status === 'already_cancelled') {
            const { timeLabel } = d.formatBookingDateTime(d.asUtcInstant(outcome.reservation.reservation_time));
            console.log(`${channel.logPrefix} cancel-reservation: already cancelled`, {
                id: outcome.reservation.id, conversation_id: conversationId,
            });
            return {
                body: {
                    success: false,
                    status: 'already_cancelled',
                    reservation_id: outcome.reservation.id,
                    message: `La prenotazione di ${outcome.reservation.customer_name} delle ${timeLabel} risulta già annullata. C'è altro che posso fare?`,
                },
            };
        }

        if (outcome.status === 'ambiguous') {
            const list = outcome.candidates.map((c: any) => {
                const { timeLabel } = d.formatBookingDateTime(d.asUtcInstant(c.reservation_time));
                return `${timeLabel} per ${c.guests}`;
            }).join(', ');
            console.log(`${channel.logPrefix} cancel-reservation: ambiguous`, {
                count: outcome.candidates.length, candidates: outcome.candidates.map((c: any) => c.id),
            });
            return {
                body: {
                    success: false,
                    status: 'ambiguous',
                    candidates: outcome.candidates,
                    message: `Ho trovato più prenotazioni per quel giorno (${list}). Mi conferma l'orario di quella da annullare?`,
                },
            };
        }

        const cancelled = outcome.reservation;

        if (conversationId && channel.linkConversation) {
            channel.linkConversation({
                conversationId, phone: d.normalizeItalianPhone(phoneRaw), reservationId: cancelled.id,
            });
        }

        d.logActivity(
            null, channel.actorEmail, channel.actorName,
            d.activityAction.DELETE, d.resourceType.RESERVATION,
            cancelled.id, cancelled.customer_name,
            {
                source: channel.sourceTag,
                conversation_id: conversationId,
                cancelled_via: `${channel.id}_agent`,
                reservation_time: cancelled.reservation_time,
                shift: cancelled.shift,
                guests: cancelled.guests,
            }
        );

        try {
            d.broadcastReservationUpdated({ ...cancelled, reservation_status: 'CANCELLED' });
        } catch (err) {
            console.warn(`${channel.logPrefix} broadcastReservationUpdated failed:`, err);
        }

        const reservationLabel = d.reservationPushLabel(d.asUtcInstant(cancelled.reservation_time));
        d.pushSendToRoles(
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
                category: 'reservation',
                title: channel.pushTitles.cancelled,
                body: `${d.toTitleCase(cancelled.customer_name)} · ${cancelled.guests} ospiti · ${reservationLabel}`,
                url: `/?view=RESERVATIONS&reservationId=${cancelled.id}`,
                tag: `reservation-${cancelled.id}`,
            },
            { excludeUserId: null }
        ).catch((err: any) => console.error(`Push (${channel.id} cancellation) failed:`, err));

        console.log(`${channel.logPrefix} cancel-reservation OK`, {
            id: cancelled.id, conversation_id: conversationId, customer: cancelled.customer_name,
        });
        return {
            body: {
                success: true,
                status: 'cancelled',
                reservation_id: cancelled.id,
                confirmation_phrase: d.formatItalianCancellation(cancelled),
            },
        };
    } catch (err: any) {
        console.error(`${channel.logPrefix} cancel-reservation error`, err);
        return {
            serverError: true,
            body: { success: false, message: 'Si è verificato un errore tecnico, posso richiamarla per cancellare la prenotazione?' },
        };
    }
}

// ---------------------------------------------------------------------------
// Tool 4 — modify_reservation
// ---------------------------------------------------------------------------

export interface ModifyReservationParams extends CancelReservationParams {
    new_date?: any;
    new_time?: any;
    new_shift?: any;
    new_guests?: any;
    new_location_preference?: any;
    new_notes?: any;
}

export async function modifyReservation(
    p: ModifyReservationParams,
    channel: ToolChannel = VOICE_CHANNEL
): Promise<ToolOutcome> {
    const d = deps();
    const conversationId = p.conversation_id;
    const fail = (error: string, message: string): ToolOutcome => ({ body: { success: false, error, message } });

    const callerIdRaw = String(p.caller_id ?? '').trim();
    const phoneRaw = String(p.phone ?? '').trim() || callerIdRaw;
    if (!phoneRaw) return fail('invalid_phone', MSG.invalidPhoneFind);

    const normalizedDate = d.parseFlexibleDate(p.date);
    if (!normalizedDate) {
        return fail('invalid_date', 'Formato data della prenotazione da modificare non riconosciuto. Esempi: 2026-05-14, 14/05/2026, "14 maggio 2026".');
    }
    let normalizedTime: string | undefined;
    if (p.time !== undefined && p.time !== null && String(p.time).trim() !== '') {
        const t = d.parseFlexibleTime(p.time);
        if (!t) return fail('invalid_time', 'Formato orario della prenotazione non riconosciuto. Esempi: 20:30, "20 e 30", "20 e mezza".');
        normalizedTime = t;
    }

    // Gli override "new_*" sono tutti facoltativi: quello che manca resta com'è.
    let newDate: string | undefined;
    if (p.new_date !== undefined && p.new_date !== null && String(p.new_date).trim() !== '') {
        newDate = d.parseFlexibleDate(p.new_date) || undefined;
        if (!newDate) return fail('invalid_new_date', 'Formato nuova data non riconosciuto. Esempi: 2026-05-14, 14/05/2026, "14 maggio 2026".');
    }
    let newTime: string | undefined;
    if (p.new_time !== undefined && p.new_time !== null && String(p.new_time).trim() !== '') {
        newTime = d.parseFlexibleTime(p.new_time) || undefined;
        if (!newTime) return fail('invalid_new_time', 'Formato nuovo orario non riconosciuto. Esempi: 20:30, "20 e 30", "20 e mezza".');
    }
    let newShift: Shift | undefined;
    if (p.new_shift !== undefined && p.new_shift !== null && String(p.new_shift).trim() !== '') {
        const s = String(p.new_shift).trim().toUpperCase();
        if (!isShift(s)) return fail('invalid_new_shift', 'Il nuovo turno non è valido. Può indicare se si tratta di pranzo o cena?');
        newShift = s as Shift;
    }
    let newGuests: number | undefined;
    if (p.new_guests !== undefined && p.new_guests !== null && String(p.new_guests).trim() !== '') {
        const g = Number(p.new_guests);
        if (!Number.isFinite(g) || g < 1 || g > 50) {
            return fail('invalid_new_guests', 'Il nuovo numero di ospiti non è valido. Può ripetermi per quante persone?');
        }
        newGuests = Math.trunc(g);
    }
    let newLocation: 'INDOOR' | 'OUTDOOR' | undefined;
    if (p.new_location_preference !== undefined && p.new_location_preference !== null) {
        const l = String(p.new_location_preference).trim().toUpperCase();
        if (l === 'INDOOR' || l === 'OUTDOOR') newLocation = l as 'INDOOR' | 'OUTDOOR';
    }
    const newNotes = typeof p.new_notes === 'string' && p.new_notes.trim() !== '' ? p.new_notes.trim() : undefined;

    if (!newDate && !newTime && !newShift && newGuests === undefined && !newLocation && !newNotes) {
        return fail('no_changes_provided', 'Cosa vuole modificare della prenotazione? Data, orario, numero di persone, zona (interno o esterno) o note?');
    }

    // Se il nuovo orario scavalca il confine fra i turni e il turno non è
    // stato indicato, lo deduciamo noi.
    if (newTime && !newShift) {
        const hh = parseInt(newTime.split(':')[0], 10);
        if (Number.isFinite(hh)) newShift = (hh >= 11 && hh < 17) ? Shift.LUNCH : Shift.DINNER;
    }

    try {
        console.log(`${channel.logPrefix} modify-reservation start`, {
            phone_raw: phoneRaw, normalized_date: normalizedDate, normalized_time: normalizedTime,
            new_date: newDate, new_time: newTime, new_shift: newShift, new_guests: newGuests,
            new_location: newLocation, has_new_notes: !!newNotes, conversation_id: conversationId,
        });
        const outcome = await d.modifyVoiceReservation({
            phone: phoneRaw, date: normalizedDate, time: normalizedTime, conversation_id: conversationId,
            new_date: newDate, new_time: newTime, new_shift: newShift, new_guests: newGuests,
            new_location_preference: newLocation, new_notes: newNotes,
        });

        if (outcome.status === 'not_found') {
            return { body: { success: false, status: 'not_found', message: MSG.notFound } };
        }
        if (outcome.status === 'already_cancelled') {
            return {
                body: {
                    success: false, status: 'already_cancelled', reservation_id: outcome.reservation.id,
                    message: `La prenotazione di ${outcome.reservation.customer_name} risulta annullata: non posso modificarla. Vuole fare una nuova prenotazione?`,
                },
            };
        }
        if (outcome.status === 'ambiguous') {
            const list = outcome.candidates.map((c: any) => {
                const { timeLabel } = d.formatBookingDateTime(d.asUtcInstant(c.reservation_time));
                return `${timeLabel} per ${c.guests}`;
            }).join(', ');
            return {
                body: {
                    success: false, status: 'ambiguous', candidates: outcome.candidates,
                    message: `Ho trovato più prenotazioni per quel giorno (${list}). Mi conferma l'orario di quella da modificare?`,
                },
            };
        }
        if (outcome.status === 'no_change') {
            return {
                body: {
                    success: false, status: 'no_change',
                    message: 'I dati che mi ha indicato coincidono con quelli già registrati. Non c\'è nulla da modificare.',
                },
            };
        }
        if (outcome.status === 'unavailable') {
            return {
                body: {
                    success: false, status: 'unavailable',
                    message: 'Mi dispiace, non abbiamo disponibilità per la nuova configurazione richiesta. Vuole provare un altro orario o un\'altra data?',
                },
            };
        }

        // outcome.status === 'modified'
        const { before, after } = outcome;

        if (conversationId && channel.linkConversation) {
            channel.linkConversation({
                conversationId, phone: d.normalizeItalianPhone(phoneRaw), reservationId: after.id,
            });
        }

        d.logActivity(
            null, channel.actorEmail, channel.actorName,
            d.activityAction.UPDATE, d.resourceType.RESERVATION,
            after.id, after.customer_name,
            {
                source: channel.sourceTag,
                conversation_id: conversationId,
                modified_via: `${channel.id}_agent`,
                before: {
                    reservation_time: before.reservation_time,
                    shift: before.shift,
                    guests: before.guests,
                    // Senza il tavolo di partenza l'audit non mostrava che la
                    // modifica lo aveva cambiato (indagine tavolo 56, 04/08).
                    table_id: before.table_id ?? null,
                },
                after: {
                    reservation_time: after.reservation_time,
                    shift: after.shift,
                    guests: after.guests,
                    table_id: after.table_id,
                },
            }
        );

        try {
            d.broadcastReservationUpdated(after);
        } catch (err) {
            console.warn(`${channel.logPrefix} broadcastReservationUpdated (modify) failed:`, err);
        }

        const reservationLabel = d.reservationPushLabel(d.asUtcInstant(after.reservation_time));
        d.pushSendToRoles(
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
                category: 'reservation',
                title: channel.pushTitles.modified,
                body: `${d.toTitleCase(after.customer_name)} · ${after.guests} ospiti · ${reservationLabel}`,
                url: `/?view=RESERVATIONS&reservationId=${after.id}`,
                tag: `reservation-${after.id}`,
            },
            { excludeUserId: null }
        ).catch((err: any) => console.error(`Push (${channel.id} modification) failed:`, err));

        console.log(`${channel.logPrefix} modify-reservation OK`, {
            id: after.id, conversation_id: conversationId, customer: after.customer_name,
        });
        // after.reservation_time è un Date: String(Date) darebbe
        // "Fri Jan 15 2027 ...", che non è ISO.
        const rt: any = after.reservation_time;
        const afterIso: string = rt instanceof Date ? rt.toISOString() : String(rt);
        return {
            body: {
                success: true,
                status: 'modified',
                reservation_id: after.id,
                confirmation_phrase: d.formatItalianModification(after),
                date_readback: d.formatItalianDateReadback(afterIso.slice(0, 10)),
            },
        };
    } catch (err: any) {
        console.error(`${channel.logPrefix} modify-reservation error`, err);
        return {
            serverError: true,
            body: { success: false, message: 'Si è verificato un errore tecnico nel modificare la prenotazione, posso richiamarla?' },
        };
    }
}
