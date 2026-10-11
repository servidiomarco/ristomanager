// Quello che il modulo WhatsApp prende da server.ts, iniettato all'avvio con
// configureWhatsApp() come fanno bookingTools e i router delle funzioni
// recenti. Tutto il resto (database, push, lingua, telefoni) il modulo lo
// importa da sé.

export interface WhatsAppDeps {
    /** Evento socket a tutti i client del ristorante (inbox, schede). */
    broadcastToAll: (tenantId: number, event: string, payload: unknown) => void;
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
};

export function configureWhatsApp(d: WhatsAppDeps): void {
    deps = d;
}

export function whatsappDeps(): WhatsAppDeps {
    return deps ?? NO_DEPS;
}
