import { displayLocale } from './formatLocale';

/* ── «2 h fa» ─────────────────────────────────────────────────────────────
 * SOLO FRONTEND (niente estensione .js negli import: il server non passa
 * di qui).
 *
 * Questa funzione esisteva in cinque copie byte-identiche — Email, Messaggi,
 * Chat staff, Notifiche e il pannello della campanella — e le cinque
 * dicevano la stessa cosa in italiano cablato. Due di quei file erano già
 * passati a react-i18next e si erano portati dietro la copia non tradotta:
 * è il modo in cui una schermata resta mezza italiana senza che nessuno se
 * ne accorga, perché il typecheck non ha niente da dire.
 *
 * `t` arriva come parametro perché questa è una funzione pura, chiamata
 * anche da moduli senza hook — lo stesso contratto di utils/courses.ts.
 * Senza `t` si resta in italiano: un chiamante dimenticato deve leggersi,
 * non sparire.
 *
 * Le chiavi sono prefissate `common:` di proposito: i cinque chiamanti
 * dichiarano cinque namespace diverse (email, messaggi, chat, notifiche),
 * e senza prefisso ognuno cercherebbe `rel.now` nella propria — non la
 * troverebbe, e resterebbe in italiano senza che niente lo segnali.
 */
type TFunc = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

export interface RelativeTimeOptions {
    /** Le notifiche mostrano anche l'anno sulle righe vecchie. */
    withYear?: boolean;
}

/** «ora», «5 min fa», «3 h fa», «2 g fa», poi la data. */
export const relativeTime = (
    iso: string | null | undefined,
    t?: TFunc,
    options: RelativeTimeOptions = {},
): string => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';

    const min = Math.floor((Date.now() - d.getTime()) / 60000);
    if (min < 1) return t ? t('common:rel.now', 'ora') : 'ora';
    if (min < 60) return t ? t('common:rel.min', '{{n}} min fa', { n: min }) : `${min} min fa`;

    const h = Math.floor(min / 60);
    if (h < 24) return t ? t('common:rel.hours', '{{n}} h fa', { n: h }) : `${h} h fa`;

    const days = Math.floor(h / 24);
    if (days < 7) return t ? t('common:rel.days', '{{n}} g fa', { n: days }) : `${days} g fa`;

    return d.toLocaleDateString(displayLocale(), {
        day: '2-digit',
        month: 'short',
        ...(options.withYear ? { year: '2-digit' as const } : {}),
    });
};
