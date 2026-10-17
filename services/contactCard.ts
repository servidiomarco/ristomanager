// La scheda contatto del locale («Salva il nostro numero»).
//
// In Italia la rete telefonica passa al cliente solo il numero, mai il nome:
// il CNAM esiste solo negli Stati Uniti. Quando il locale richiama dal CRM o
// dal cordless, il cliente vede «Vecchio Frantoio» solo se il numero è nella
// sua rubrica. Questa scheda (vCard 3.0, la versione che leggono sia iPhone
// sia Android) gliela mette lì con un tocco, dalla conferma o dalla pagina
// «La tua prenotazione».

export interface ContactCardPhone {
    /** E.164, es. +390985010032. */
    number: string;
    /** Etichetta mostrata in rubrica (X-ABLabel di Apple, la legge anche
     *  Google Contatti); senza, resta il tipo «lavoro». */
    label?: string | null;
    kind: 'work' | 'cell';
}

export interface ContactCardInput {
    name: string;
    phones: ContactCardPhone[];
    address?: string | null;
    websiteUrl?: string | null;
    /** JPEG già ridotto: diventa la foto del contatto, e quindi anche quella
     *  della chiamata in arrivo sull'iPhone. */
    photoJpeg?: Buffer | null;
}

// RFC 2426 §4: in un valore di testo vanno protetti backslash, virgola,
// punto e virgola e a capo.
const escapeText = (value: string): string =>
    value
        .replace(/\\/g, '\\\\')
        .replace(/\r?\n/g, '\\n')
        .replace(/,/g, '\\,')
        .replace(/;/g, '\\;');

// Righe al massimo di 75 ottetti, le successive iniziano con uno spazio. Si
// taglia sui caratteri e non sui byte: un'accentata spezzata a metà
// diventerebbe un carattere rotto nel nome del contatto.
function foldLine(line: string): string {
    const out: string[] = [];
    let current = '';
    let bytes = 0;
    for (const ch of line) {
        const size = Buffer.byteLength(ch, 'utf8');
        const limit = out.length === 0 ? 75 : 74;
        if (bytes + size > limit) {
            out.push(current);
            current = '';
            bytes = 0;
        }
        current += ch;
        bytes += size;
    }
    out.push(current);
    return out.join('\r\n ');
}

/** Il numero senza spazi, uguale per due scritture dello stesso telefono. */
const phoneKey = (number: string): string => number.replace(/[^\d+]/g, '');

export function buildContactCard(input: ContactCardInput): string {
    const name = input.name.trim();
    const lines: string[] = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        // N col nome intero nel cognome: è il campo su cui la rubrica ordina,
        // e Android mostra N quando manca FN.
        `N:${escapeText(name)};;;;`,
        `FN:${escapeText(name)}`,
        `ORG:${escapeText(name)}`,
        // L'iPhone mostra il contatto come azienda (nome del locale, niente
        // «nome e cognome»); gli altri ignorano il campo.
        'X-ABShowAs:COMPANY',
    ];
    const seen = new Set<string>();
    let item = 0;
    for (const phone of input.phones) {
        const key = phoneKey(phone.number);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const type = phone.kind === 'cell' ? 'CELL,VOICE' : 'WORK,VOICE';
        const label = phone.label?.trim();
        if (label) {
            item += 1;
            lines.push(`item${item}.TEL;TYPE=${type}:${phone.number}`);
            lines.push(`item${item}.X-ABLabel:${escapeText(label)}`);
        } else {
            lines.push(`TEL;TYPE=${type}:${phone.number}`);
        }
    }
    const address = input.address?.trim();
    // L'indirizzo in anagrafica è una riga sola: va nella via, gli altri
    // campi restano vuoti invece di essere indovinati.
    if (address) lines.push(`ADR;TYPE=WORK:;;${escapeText(address)};;;;`);
    const website = input.websiteUrl?.trim();
    if (website) lines.push(`URL:${website}`);
    if (input.photoJpeg && input.photoJpeg.length > 0) {
        lines.push(`PHOTO;ENCODING=b;TYPE=JPEG:${input.photoJpeg.toString('base64')}`);
    }
    lines.push('END:VCARD');
    return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Il nome del file scaricato: «Il Vecchio Frantoio.vcf». */
export function contactCardFileName(name: string): string {
    const clean = name.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    return `${clean || 'contatto'}.vcf`;
}

// sharp ha binari nativi: si carica solo quando serve, come in
// services/whatsapp/media. Senza sharp la scheda parte senza foto.
let sharpLoading: Promise<typeof import('sharp')> | null = null;
async function loadSharp(): Promise<typeof import('sharp')> {
    sharpLoading ??= import('sharp').then(m => ((m as any).default ?? m) as typeof import('sharp'));
    return sharpLoading;
}

/** Il logo come foto del contatto: quadrata, su bianco (la rubrica la
 *  ritaglia in un cerchio, e un PNG trasparente diventerebbe nero su alcuni
 *  Android), piccola perché viaggia dentro il file. null se non si riesce. */
export async function contactPhotoFromLogo(logo: Buffer): Promise<Buffer | null> {
    try {
        const sharp = await loadSharp();
        // Il margine tiene il marchio dentro il cerchio della rubrica: un
        // logo largo toccherebbe i bordi e verrebbe tagliato.
        const inner = await sharp(logo)
            .resize(220, 220, { fit: 'inside', withoutEnlargement: false })
            .toBuffer();
        return await sharp({
            create: { width: 300, height: 300, channels: 3, background: '#ffffff' },
        })
            .composite([{ input: inner, gravity: 'center' }])
            .jpeg({ quality: 82 })
            .toBuffer();
    } catch (err: any) {
        console.warn('[contatto] foto dal logo non riuscita:', err?.message || err);
        return null;
    }
}
