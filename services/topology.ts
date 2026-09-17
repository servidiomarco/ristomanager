// Il profilo di topologia — tappa 4 dell'ibrido, fase 2 («una codebase,
// due topologie», sez. 3 del brainstorming nel repo marketing).
//
// La stessa codebase gira in due posti:
// - 'cloud' (default): l'installazione di sempre su Railway — tutto attivo.
// - 'service-node': il nodo di sala sul PC del ristorante, con Postgres
//   locale. Serve SOLO il dominio servizio; le integrazioni inbound
//   (webhook Twilio/Vonage/ElevenLabs/Stripe/SumUp, pagine pubbliche,
//   /pay), gli scheduler cloud (promemoria, recensioni, riconcili
//   pagamenti, IMAP) e gli invii esterni (WhatsApp/SMS/email/push) sono
//   SPENTI: quel lavoro appartiene al cloud, e un nodo che lo facesse
//   sulla propria replica duplicherebbe messaggi e scritture.
//
// La scelta è una variabile d'ambiente, non un fork: SERVER_PROFILE è
// impostata solo dall'installer del nodo, il cloud non la definisce e
// resta 'cloud' per costruzione. Qualunque valore ignoto = 'cloud':
// mai un typo in env deve spegnere pezzi della produzione.

export type ServerProfile = 'cloud' | 'service-node';

export const SERVER_PROFILE: ServerProfile =
    process.env.SERVER_PROFILE === 'service-node' ? 'service-node' : 'cloud';

export const isServiceNode = SERVER_PROFILE === 'service-node';
