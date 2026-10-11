// Vonage: il sandbox WhatsApp usato prima di Twilio. Resta solo come ripiego
// per i ristoranti con le credenziali in env quando Twilio non è
// configurato (uno sviluppo locale, di fatto). Solo testo: niente template,
// niente allegati.

export function isVonageConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!(env.VONAGE_API_KEY && env.VONAGE_API_SECRET && env.VONAGE_WHATSAPP_NUMBER);
}

export async function sendVonageWhatsApp(to: string, text: string): Promise<void> {
    const VONAGE_API_KEY = process.env.VONAGE_API_KEY;
    const VONAGE_API_SECRET = process.env.VONAGE_API_SECRET;
    const VONAGE_WHATSAPP_NUMBER = process.env.VONAGE_WHATSAPP_NUMBER;

    if (!VONAGE_API_KEY || !VONAGE_API_SECRET || !VONAGE_WHATSAPP_NUMBER) {
        // Prima si tornava in silenzio e la riga finiva nel log come
        // spedita: un messaggio mai partito sembrava consegnato.
        throw new Error('Vonage non configurato (VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_WHATSAPP_NUMBER)');
    }

    // Numero in formato E.164 (col +).
    const formattedTo = to.startsWith('+') ? to : `+${to}`;
    const formattedFrom = VONAGE_WHATSAPP_NUMBER.startsWith('+') ? VONAGE_WHATSAPP_NUMBER : `+${VONAGE_WHATSAPP_NUMBER}`;

    console.log(`[Vonage] Sending message to ${formattedTo} from ${formattedFrom}`);

    const auth = Buffer.from(`${VONAGE_API_KEY}:${VONAGE_API_SECRET}`).toString('base64');
    const response = await fetch('https://messages-sandbox.nexmo.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${auth}`,
        },
        body: JSON.stringify({
            from: formattedFrom,
            to: formattedTo,
            message_type: 'text',
            text,
            channel: 'whatsapp',
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Vonage API error: ${response.status} - ${errorBody}`);
    }

    const result = await response.json();
    console.log(`[Vonage] ✅ Message sent to ${to}`, result);
}
