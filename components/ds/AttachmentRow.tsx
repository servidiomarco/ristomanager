import React from 'react';
import { X } from 'lucide-react';

/* ── AttachmentRow ────────────────────────────────────────────────────────
   Un file già caricato e in attesa di partire, mostrato dentro il composer.

   Stava in tre copie quasi uguali — InboxPage, EmailPage, StaffChatPage — e
   avevano già iniziato a divergere: due mostravano i KB, la terza no. Da qui
   in poi la riga è una sola.

   Vive **dentro** la scheda bianca del composer, non sopra di essa: fuori
   finiva su `--ds-canvas`, e un `--ds-surface-row` su canvas sono due toni che
   distano il 2% — il file allegato spariva contro lo sfondo. Dentro, lo stesso
   tono è esattamente il gradino giusto. */

/** Etichette scritte a mano, non `toUpperCase()` sull'estensione: "PDF" e
 *  "MP3" si scrivono così di loro (come SMS o VIP, §5.2), mentre maiuscolare
 *  una stringa qualsiasi violerebbe la regola. Fuori elenco si dice "File", che
 *  è vero per qualunque cosa. */
const TYPE_LABEL: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
  'video/mp4': 'MP4',
  'audio/mpeg': 'MP3',
  'audio/ogg': 'OGG',
};

const typeLabel = (contentType: string): string => TYPE_LABEL[contentType] ?? 'File';

/** I byte non dicono niente a nessuno; sopra il mega si passa ai MB, altrimenti
 *  un video da 10 MB si annuncerebbe come "10240 KB". */
const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Taglia in mezzo, non in fondo. `truncate` mangia per prima l'estensione —
 *  cioè l'unica parte che dice *che cosa* è il file — e lascia il nome monco:
 *  "Rules to fo…" invece di "Rules to fo…w.pdf". */
const middleTruncate = (name: string, head = 16, tail = 8): string =>
  name.length <= head + tail + 1 ? name : `${name.slice(0, head)}…${name.slice(-tail)}`;

export const AttachmentRow: React.FC<{
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  /** Anteprima vera, quando il file caricato ha già un URL pubblico — oggi solo
   *  la chat di staff (`staffMediaUrl`). Messaggi ed Email hanno un URL solo
   *  dopo l'invio, quindi lì resta la targhetta del tipo. */
  previewUrl?: string;
  onRemove: () => void;
}> = ({ filename, contentType, sizeBytes, previewUrl, onRemove }) => {
  const name = filename || typeLabel(contentType);
  return (
    // `inline-flex`, non `flex`: la riga si stringe sul contenuto invece di
    // prendere tutta la larghezza del composer. Un allegato e' un oggetto, non
    // una sezione — e cosi' due o tre stanno affiancati invece che impilati.
    // `max-w-full` la tiene dentro su schermo stretto, dove il nome accorciato
    // puo' ancora essere piu' largo del composer.
    <div className="inline-flex max-w-full items-center gap-3 rounded-[16px] bg-[var(--ds-surface-row)] p-2">
      {previewUrl ? (
        <img
          src={previewUrl}
          alt=""
          className="h-10 w-10 flex-shrink-0 rounded-[12px] object-cover"
          loading="lazy"
        />
      ) : (
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[12px] bg-[var(--ds-surface)] text-[10px] font-semibold text-[var(--ds-text-muted)]">
          {typeLabel(contentType)}
        </span>
      )}

      <div className="min-w-0">
        {/* `title` porta il nome intero: il taglio è per lo spazio, non per
            nascondere qual è il file. */}
        <p className="truncate text-[14px] text-[var(--ds-text-primary)]" title={name}>
          {middleTruncate(name)}
        </p>
        <p className="text-[12px] text-[var(--ds-text-muted)]">{formatSize(sizeBytes)}</p>
      </div>

      {/* 44px sul telefono, 36 da sm: prima era 20px, sotto il minimo assoluto
          di 24 che il documento fissa per qualunque bersaglio. */}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Togli ${name}`}
        className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] sm:h-9 sm:w-9"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
};
