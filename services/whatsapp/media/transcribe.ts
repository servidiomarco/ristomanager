// I vocali dei clienti trascritti con la speech-to-text di ElevenLabs
// (scribe_v2), sulla stessa chiave e sugli stessi crediti di Sofia. La
// lingua si riconosce da sola: il cliente inglese parla inglese.
//
// Provata l'11/10/2026 con la chiave di produzione: scribe_v2 risponde, la
// chiave ha il permesso, e la lingua torna in tre lettere («ita»). I vocali
// WhatsApp sono OGG/Opus, formato che ElevenLabs dichiara supportato: da
// riguardare sul primo vocale vero se la trascrizione fallisce.

const STT_URL = () => (process.env.ELEVENLABS_STT_URL || 'https://api.elevenlabs.io/v1/speech-to-text').trim();
// ELEVENLABS_STT_KEY esiste per i test (stub locale): in produzione si usa
// la chiave di Sofia.
const STT_KEY = () => (process.env.ELEVENLABS_STT_KEY || process.env.ELEVENLABS_API_KEY || '').trim();
export const STT_MODEL = 'scribe_v2';

export function isTranscriptionConfigured(): boolean {
    return STT_KEY().length > 0;
}

// Le lingue che l'app conosce, dal codice a tre lettere del servizio.
const LANGS: Record<string, string> = { ita: 'it', eng: 'en', fra: 'fr', deu: 'de', spa: 'es', por: 'pt', nld: 'nl' };

export interface Transcription {
    text: string;
    language: string | null;
}

export async function transcribeAudio(bytes: Buffer, contentType: string): Promise<Transcription> {
    const key = STT_KEY();
    if (!key) throw new Error('ElevenLabs non configurato');
    const form = new FormData();
    form.append('model_id', STT_MODEL);
    form.append('file', new Blob([new Uint8Array(bytes)], { type: contentType || 'audio/ogg' }), contentType.includes('ogg') ? 'vocale.ogg' : 'vocale');
    // Un vocale di un minuto si trascrive in pochi secondi; oltre il mezzo
    // minuto qualcosa non va, e l'agente non deve aspettare per sempre.
    const response = await fetch(STT_URL(), {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
        signal: AbortSignal.timeout(30_000),
    });
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = typeof body?.detail === 'string' ? body.detail : body?.detail?.message;
        throw new Error(`ElevenLabs ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const text = String(body?.text ?? '').trim();
    const code = String(body?.language_code ?? '').toLowerCase();
    return { text, language: LANGS[code] ?? (code.length === 2 ? code : null) };
}
