// Registro dei tipi-evento di dominio con la loro autorità — tappa 4 del
// piano ibrido, fase 1 (docs/brainstorming-installazione-ibrida.md nel repo
// marketing, sez. 4: «la tabella deve esistere nel codice, check in CI»).
//
// Ogni dato ha UN master in ogni momento: questo file è la mappa. Il check
// in CI (tests/api/event-registry.test.ts) estrae i literal degli eventi da
// server.ts e socketService.ts e pretende che ognuno sia registrato qui —
// una feature nuova che broadcasta un tipo non dichiarato non passa la CI.
// L'outbox rifiuta a runtime i tipi non registrati (outboxEnqueueInTx).
//
// Le autorità:
// - 'cloud'    — il master è il cloud (inbound, CRM, configurazione, menu,
//                gateway di pagamento). Il nodo li applica come proiezioni.
// - 'service'  — il master è il dominio servizio: quando la fase 4 accende
//                l'autorità sul nodo di sala, queste mutazioni nascono là.
// - 'split'    — il tipo copre OGGI mutazioni di entrambe le autorità (es.
//                reservation:updated serve sia la prenotazione inbound che
//                l'arrivo in reception). Da sdoppiare in tipi distinti PRIMA
//                che la fase 4 sposti l'autorità: un tipo split non può
//                migrare com'è.
// - 'transient'— segnale realtime puro (presence, ack, wake-up): non è un
//                fatto di dominio e non entrerà mai nel log di replica.
//
// schema_ver: versione del payload del tipo (sez. «Migrazioni di schema»);
// si alza quando il payload cambia forma, mai retroattivamente.
//
// Condiviso fra cloud e (in futuro) nodo: niente import, solo dati.

export type EventAuthority = 'cloud' | 'service' | 'split' | 'transient';

export interface DomainEventSpec {
    authority: EventAuthority;
    schema_ver: number;
}

const spec = (authority: EventAuthority, schema_ver = 1): DomainEventSpec => ({ authority, schema_ver });

export const DOMAIN_EVENTS: Record<string, DomainEventSpec> = {
    // --- Prenotazioni: inbound (cloud) E arrivi/assegnazione (servizio)
    //     passano oggi dagli stessi tipi → split, da sdoppiare in fase 4.
    'reservation:created': spec('split'),
    'reservation:updated': spec('split'),
    'reservation:deleted': spec('split'),
    'reservation:synced': spec('split'),
    'tableAssignmentSuggestion:created': spec('service'),
    'tableAssignmentSuggestion:resolved': spec('service'),

    // --- Pianta e sala: la geometria è configurazione (cloud), lo stato
    //     operativo è servizio. table:updated porta entrambe → split.
    'room:created': spec('cloud'),
    'room:updated': spec('cloud'),
    'room:deleted': spec('cloud'),
    'table:created': spec('cloud'),
    'table:updated': spec('split'),
    'table:deleted': spec('cloud'),
    'tableMerge:created': spec('service'),
    'tableMerge:deleted': spec('service'),
    'tableHidden:created': spec('service'),
    'tableHidden:deleted': spec('service'),
    'roomClosed:created': spec('service'),
    'roomClosed:deleted': spec('service'),

    // --- Comande e cucina: non esiste scrittura legittima da fuori il
    //     ristorante — il cuore dell'autorità di servizio.
    'order:created': spec('service'),
    'order:updated': spec('service'),
    'order:deleted': spec('service'),
    'order:revised': spec('service'),
    'order:revision-acked': spec('service'),
    'orderItem:status': spec('service'),
    'orderItem:voided': spec('service'),
    'course:queued': spec('service'),
    'course:fired': spec('service'),
    'course:unfired': spec('service'),
    'course:called': spec('service'),
    'course:ready': spec('service'),
    'course:recalled': spec('service'),
    'course:served': spec('service'),
    'course:unserved': spec('service'),
    'kds:item': spec('service'),
    'kds:fired': spec('service'),
    'kds:unfired': spec('service'),
    'passepartout:chiusura': spec('service'),

    // --- Conti e cassa: il conto vive in sala, ma gli incassi dal QR
    //     arrivano dai webhook (cloud). La fase 5 del piano li sdoppia:
    //     «il cloud incassa, il nodo applica la chiusura».
    'bill:opened': spec('service'),
    'bill:updated': spec('service'),
    'bill:closed': spec('service'),
    'bill:voided': spec('service'),
    'bill:settled': spec('split'),
    'bill:payment-recorded': spec('split'),
    'bill:payment-voided': spec('split'),
    'bill:split-claimed': spec('split'),
    'bill:split-released': spec('split'),
    'bill:split-paid': spec('split'),
    'bill:split-refunded': spec('split'),
    'bill:split-abandoned': spec('split'),
    'cash:session-opened': spec('service'),
    'cash:session-closed': spec('service'),
    'paymentRequest:created': spec('cloud'),
    'paymentRequest:updated': spec('cloud'),
    'payments:seen': spec('cloud'),
    'fiscal:updated': spec('cloud'),

    // --- Asporto: nasce online o al telefono (cloud), avanza in cucina e
    //     al ritiro (servizio) → split finché la fase 4 non li separa.
    'takeaway:created': spec('split'),
    'takeaway:updated': spec('split'),
    'takeaway:config': spec('cloud'),

    // --- Menu e catalogo: configurazione, master in cloud.
    'dish:created': spec('cloud'),
    'dish:updated': spec('cloud'),
    'dish:deleted': spec('cloud'),
    'dish:synced': spec('cloud'),
    'menu:created': spec('cloud'),
    'menu:updated': spec('cloud'),
    'menu:deleted': spec('cloud'),
    'catalogue:updated': spec('cloud'),
    'banquet:created': spec('cloud'),
    'banquet:updated': spec('cloud'),
    'banquet:deleted': spec('cloud'),

    // --- Inbound e CRM: richiedono internet per esistere.
    'message:inbound': spec('cloud'),
    'message:outbound': spec('cloud'),
    'message:read': spec('cloud'),
    'message:status': spec('cloud'),
    'email:new': spec('cloud'),
    'email:read': spec('cloud'),
    'inboundEmail:received': spec('cloud'),

    // --- Gestione (staff, turni, spesa, todo, fornitori): tolleranza alta
    //     alla latenza, conflitti rari — master in cloud.
    'staff:created': spec('cloud'),
    'staff:updated': spec('cloud'),
    'staff:deleted': spec('cloud'),
    'shift:created': spec('cloud'),
    'shift:updated': spec('cloud'),
    'shift:deleted': spec('cloud'),
    'timeoff:created': spec('cloud'),
    'timeoff:updated': spec('cloud'),
    'timeoff:deleted': spec('cloud'),
    // Piano ferie: un solo tipo, il client rilegge il piano o le proprie
    // richieste — il payload dice solo cosa è cambiato.
    'leave:changed': spec('cloud'),
    'supplier:created': spec('cloud'),
    'supplier:updated': spec('cloud'),
    'supplier:deleted': spec('cloud'),
    'shopping:created': spec('cloud'),
    'shopping:updated': spec('cloud'),
    'shopping:deleted': spec('cloud'),
    'shopping:cleared': spec('cloud'),
    'todo:created': spec('cloud'),
    'todo:updated': spec('cloud'),
    'todo:deleted': spec('cloud'),
    'staffchat:message': spec('cloud'),
    'staffchat:read': spec('cloud'),
    'staffchat:presets': spec('cloud'),

    // --- Piattaforma e strumenti interni.
    'features:updated': spec('cloud'),
    'devboard:changed': spec('cloud'),
    'roadmap:changed': spec('cloud'),

    // --- Segnali realtime puri: mai nel log di replica.
    'connection:acknowledged': spec('transient'),
    'orderpad:presence': spec('transient'),
    'orderpad:enter': spec('transient'),
    'orderpad:leave': spec('transient'),
    'subscribe:room': spec('transient'),
    'unsubscribe:room': spec('transient'),
    'subscribe:station': spec('transient'),
    'unsubscribe:station': spec('transient'),
};

export const eventSpec = (type: string): DomainEventSpec | undefined => DOMAIN_EVENTS[type];

/** Guardia dell'outbox: un tipo non registrato è un errore di programma da
 *  vedere in CI, non una riga silenziosa che nessun handler consegnerà. */
export const requireRegisteredEvent = (type: string): DomainEventSpec => {
    const found = DOMAIN_EVENTS[type];
    if (!found) {
        throw new Error(`Evento di dominio non registrato: '${type}' — dichiaralo in services/eventRegistry.ts con la sua autorità`);
    }
    if (found.authority === 'transient') {
        throw new Error(`L'evento '${type}' è transient: non appartiene al log di replica e non passa dall'outbox`);
    }
    return found;
};
