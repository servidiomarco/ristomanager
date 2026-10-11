// Quello che il modulo WhatsApp prende da server.ts, iniettato all'avvio con
// configureWhatsApp() come fanno bookingTools e i router delle funzioni
// recenti. Tutto il resto (database, push, lingua, telefoni) il modulo lo
// importa da sé.

export interface WhatsAppDeps {
    /** Evento socket a tutti i client del ristorante (inbox, schede). */
    broadcastToAll: (tenantId: number, event: string, payload: unknown) => void;
    /** Rimanda le prenotazioni cambiate ai client (l'«Annulla» di
     *  un'azione dell'agente). */
    broadcastReservationsUpdatedByIds: (ids: number[]) => Promise<unknown>;
    /** Lo stato di consegna di un messaggio (inbox, conferma della
     *  prenotazione, ripieghi): lo stesso per Twilio e Meta. */
    persistDeliveryStatus: (tenantId: number, sid: string, status: string, errorCode: string | null, errorText: string | null) => Promise<void>;
}

let deps: WhatsAppDeps | null = null;
let warned = false;

const NO_DEPS: WhatsAppDeps = {
    broadcastToAll: () => {
        if (!warned) {
            warned = true;
            console.warn('[whatsapp] modulo non configurato: eventi socket non inviati');
        }
    },
    broadcastReservationsUpdatedByIds: async () => undefined,
    persistDeliveryStatus: async () => undefined,
};

export function configureWhatsApp(d: WhatsAppDeps): void {
    deps = d;
}

export function whatsappDeps(): WhatsAppDeps {
    return deps ?? NO_DEPS;
}
