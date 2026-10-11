// Le informazioni sul locale che un cliente chiede in chat o al telefono:
// orari, chiusure, sale aperte, menu, come arrivare, recapiti.
//
// I dati c'erano già tutti nel CRM, ma l'agente WhatsApp poteva rispondere
// solo con quello che il gestore aveva ricopiato a mano nelle regole della
// casa: «siamo aperti?» e «l'esterno è chiuso?» (al Frantoio, settembre
// 2026) restavano senza risposta o, peggio, con quella di una regola vecchia.
// Pensato anche per Sofia (rapporto concorrenti, punto 9): stessi dati, stesso
// formato.

import { queryWithRetry } from '../db.js';
import { Shift } from '../types.js';
import { getAllOpeningHours, getAvailableSlots, listClosures } from '../utils/slots.js';
import { getDatePartInTz } from '../utils/reservationTime.js';
import { getTenantLocale } from './tenantLocale.js';

export type InfoTopic = 'hours' | 'closures' | 'zones' | 'menu' | 'directions' | 'contacts';
export const INFO_TOPICS: readonly InfoTopic[] = ['hours', 'closures', 'zones', 'menu', 'directions', 'contacts'];

/** Quello che sta in server.ts: identità pubblica, menu digitale, giorni
 *  riservati di Sofia. */
export interface RestaurantInfoDeps {
    identity: (tenantId: number) => Promise<{ name: string; phone: string; whatsapp: string; address: string; mapsUrl: string; websiteUrl: string }>;
    /** Il link del menu digitale se il locale l'ha acceso, altrimenti null. */
    digitalMenuUrl: (tenantId: number) => Promise<string | null>;
    /** I giorni chiusi alle prenotazioni da Sofia (banchetti, eventi). */
    dateBlocks: (tenantId: number) => Promise<Array<{ date: string; shift: 'LUNCH' | 'DINNER' | 'ALL' }>>;
}

let deps: RestaurantInfoDeps | null = null;
export function configureRestaurantInfo(d: RestaurantInfoDeps): void {
    deps = d;
}
const D = (): RestaurantInfoDeps => {
    if (!deps) throw new Error('restaurantInfo non configurato');
    return deps;
};

const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const fascia = (open: string | null, close: string | null) => (open && close ? `${open}–${close}` : null);

async function oggiNelLocale(tenantId: number): Promise<string> {
    return getDatePartInTz(new Date(), (await getTenantLocale(tenantId)).timezone);
}

const isShift = (v: unknown): v is Shift => v === Shift.LUNCH || v === Shift.DINNER;

/**
 * Le informazioni su un argomento, in una forma compatta che un modello
 * legge e riformula. `date` e `shift` restringono orari e sale a un giorno.
 */
export async function restaurantInfo(
    tenantId: number,
    topic: InfoTopic,
    opts: { date?: string | null; shift?: string | null } = {}
): Promise<Record<string, any>> {
    const date = typeof opts.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : null;
    const shift = isShift(opts.shift) ? opts.shift : null;

    if (topic === 'hours') {
        const settimana = (await getAllOpeningHours(tenantId)).map(h => ({
            giorno: GIORNI[h.weekday] ?? String(h.weekday),
            pranzo: fascia(h.lunch_open, h.lunch_close) ?? 'chiuso',
            cena: fascia(h.dinner_open, h.dinner_close) ?? 'chiuso',
        }));
        const out: Record<string, any> = { orari_settimanali: settimana };
        if (date) {
            // Il giorno chiesto: gli orari prenotabili dicono anche le
            // chiusure straordinarie, che la settimana tipo non vede.
            const [pranzo, cena] = await Promise.all([
                getAvailableSlots(tenantId, date, Shift.LUNCH),
                getAvailableSlots(tenantId, date, Shift.DINNER),
            ]);
            out.giorno = {
                data: date,
                pranzo: pranzo.length ? `aperto, orari prenotabili ${pranzo[0]}–${pranzo[pranzo.length - 1]}` : 'chiuso',
                cena: cena.length ? `aperto, orari prenotabili ${cena[0]}–${cena[cena.length - 1]}` : 'chiuso',
            };
        }
        return out;
    }

    if (topic === 'closures') {
        const oggi = await oggiNelLocale(tenantId);
        const [chiusure, blocchi] = await Promise.all([listClosures(tenantId, oggi), D().dateBlocks(tenantId)]);
        return {
            chiusure_straordinarie: chiusure.slice(0, 20).map(c => ({
                data: c.date, turno: c.shift ?? 'tutto il giorno', motivo: c.reason ?? null,
            })),
            giorni_non_prenotabili: blocchi.filter(b => b.date >= oggi).slice(0, 20).map(b => ({
                data: b.date, turno: b.shift === 'ALL' ? 'tutto il giorno' : b.shift,
            })),
        };
    }

    if (topic === 'zones') {
        const sale = await queryWithRetry(
            `SELECT id, name, location, is_closed FROM rooms WHERE tenant_id = $1 ORDER BY name`,
            [tenantId]
        );
        let chiuseQuelGiorno = new Set<number>();
        if (date && shift) {
            const r = await queryWithRetry(
                `SELECT room_id FROM room_closed_overrides WHERE tenant_id = $1 AND date = $2 AND shift = $3`,
                [tenantId, date, shift]
            );
            chiuseQuelGiorno = new Set(r.rows.map((x: any) => Number(x.room_id)));
        }
        return {
            sale: sale.rows.map((s: any) => ({
                nome: s.name,
                zona: s.location === 'OUTDOOR' ? 'esterno' : 'interno',
                stato: s.is_closed || chiuseQuelGiorno.has(Number(s.id)) ? 'chiusa' : 'aperta',
            })),
            // Una sala aperta non garantisce un tavolo: per quello serve la
            // disponibilità con la zona.
            nota: date && shift
                ? 'Lo stato vale per il giorno e il turno chiesti. Per sapere se c\'è posto usa check_availability.'
                : 'Senza giorno e turno lo stato è quello generale. Per un giorno preciso chiedi di nuovo con date e shift.',
        };
    }

    if (topic === 'menu') {
        const url = await D().digitalMenuUrl(tenantId);
        return url
            ? { menu_digitale: url }
            : { menu_digitale: null, nota: 'Il menu digitale non è attivo: per il menu rimanda al personale.' };
    }

    const id = await D().identity(tenantId);
    if (topic === 'directions') {
        return { nome: id.name, indirizzo: id.address || null, mappa: id.mapsUrl || null };
    }
    return {
        nome: id.name,
        telefono: id.phone || null,
        whatsapp: id.whatsapp || null,
        sito: id.websiteUrl || null,
    };
}
