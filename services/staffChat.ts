// Chat staff — modello condiviso client/server (docs/chat-staff-plan.md).
// Come text.ts: importato da entrambi i lati, quindi import relativi con
// estensione .js (il build server emette ES module veri).
//
// I canali sono FISSI e la membership discende dal ruolo: chi sei decide
// cosa vedi, niente tabella di iscrizioni. PLATFORM_ADMIN è fuori dai
// canali come è fuori dalla room tenant (dentro un tenant si impersona).
import { UserRole } from '../types.js';

export const STAFF_CHANNELS = ['generale', 'sala', 'cucina', 'reception'] as const;
export type StaffChannel = (typeof STAFF_CHANNELS)[number];

const MANAGEMENT: UserRole[] = [UserRole.OWNER, UserRole.GENERAL_MANAGER, UserRole.MANAGER];

const CHANNEL_ROLES: Record<StaffChannel, UserRole[]> = {
    generale: [...MANAGEMENT, UserRole.RECEPTION, UserRole.WAITER, UserRole.KITCHEN, UserRole.CASSA],
    // La cassa sta in sala: «tavolo 12 chiede il conto» è esattamente il
    // messaggio che deve raggiungerla. Senza questa riga un utente CASSA
    // avrebbe staffchat:use e nessun canale, cioè una chat vuota.
    sala: [...MANAGEMENT, UserRole.WAITER, UserRole.CASSA],
    cucina: [...MANAGEMENT, UserRole.KITCHEN],
    reception: [...MANAGEMENT, UserRole.RECEPTION],
};

export const isStaffChannel = (value: string): value is StaffChannel =>
    (STAFF_CHANNELS as readonly string[]).includes(value);

export const channelsForRole = (role: UserRole): StaffChannel[] =>
    STAFF_CHANNELS.filter(channel => CHANNEL_ROLES[channel].includes(role));

export const rolesForChannel = (channel: StaffChannel): UserRole[] =>
    [...CHANNEL_ROLES[channel]];

export interface StaffMedia {
    token: string;
    content_type: string;
    filename: string | null;
}

// Il messaggio come viaggia su API e socket. Nel DB il DM porta mittente e
// destinatario espliciti; il threadKey è sempre derivato, mai persistito.
export interface StaffMessage {
    id: number;
    kind: 'channel' | 'direct';
    channel: StaffChannel | null;
    sender_user_id: number | null;
    sender_name: string;
    sender_role: string;
    recipient_user_id: number | null;
    recipient_name: string | null;
    body: string | null;
    preset_key: string | null;
    linked_reservation_id: number | null;
    linked_table_id: number | null;
    // Menzioni: id espliciti mandati dal client, mai riestratti dal testo.
    mentioned_user_ids: number[] | null;
    // Allegati foto: riferimenti a outbound_media (token pubblico).
    media: StaffMedia[] | null;
    created_at: string;
}

// Un messaggio può richiamare al massimo questo numero di colleghi: oltre,
// si sta parlando al canale, non a qualcuno.
export const STAFF_MAX_MENTIONS = 5;

// threadKey: 'channel:<nome>' | 'dm:<userId dell'ALTRO utente>'. Unico punto
// di verità sul formato — route, cursori di lettura e deep-link push passano
// tutti da qui.
export type StaffThreadRef =
    | { kind: 'channel'; channel: StaffChannel }
    | { kind: 'direct'; otherUserId: number };

export const channelThreadKey = (channel: StaffChannel): string => `channel:${channel}`;
export const dmThreadKey = (otherUserId: number): string => `dm:${otherUserId}`;

export const parseThreadKey = (key: string): StaffThreadRef | null => {
    if (key.startsWith('channel:')) {
        const channel = key.slice('channel:'.length);
        return isStaffChannel(channel) ? { kind: 'channel', channel } : null;
    }
    if (key.startsWith('dm:')) {
        const otherUserId = Number(key.slice('dm:'.length));
        return Number.isInteger(otherUserId) && otherUserId > 0
            ? { kind: 'direct', otherUserId }
            : null;
    }
    return null;
};

// Il threadKey di un DM dipende da chi guarda: è sempre l'id dell'altro capo.
export const threadKeyFor = (msg: StaffMessage, myUserId: number): string => {
    if (msg.kind === 'channel') return channelThreadKey(msg.channel as StaffChannel);
    const other = msg.sender_user_id === myUserId ? msg.recipient_user_id : msg.sender_user_id;
    return dmThreadKey(other ?? 0);
};

// Messaggi rapidi: il preset inserisce la label come body (completabile a
// mano) e salva la key per icona/colore in lista. Hardcoded nell'MVP; la
// tabella gestibile da UI è rimandata (piano §9).
export const STAFF_MESSAGE_PRESETS: { key: string; label: string }[] = [
    { key: 'piatto-finito', label: 'Piatto finito' },
    { key: 'serve-runner', label: 'Serve un runner' },
    { key: 'conto-richiesto', label: 'Chiedono il conto' },
    { key: 'vip-in-arrivo', label: 'VIP in arrivo' },
    { key: 'walkin-gruppo', label: 'Gruppo senza prenotazione' },
];

export const isStaffPresetKey = (key: string): boolean =>
    STAFF_MESSAGE_PRESETS.some(p => p.key === key);

export const STAFF_MESSAGE_MAX_LENGTH = 1000;
export const STAFF_MAX_ATTACHMENTS = 3;

// Anteprima nelle liste/push quando il messaggio è solo foto.
export const staffMessagePreview = (m: Pick<StaffMessage, 'body' | 'media'>): string =>
    m.body ?? ((m.media?.length ?? 0) > 1 ? 'foto' : 'una foto');
