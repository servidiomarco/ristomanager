import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Paperclip, Loader2, Upload, Trash2, FileText, Image as ImageIcon, Film, Music } from 'lucide-react';
import { listMedia, uploadMedia, deleteMedia, type MediaFile } from '../services/mediaApiService';
import { useAuth } from '../contexts/AuthContext';

/* ── Libreria media ───────────────────────────────────────────────────────
   File che si mandano più volte agli stessi clienti: il menù di Ferragosto,
   la piantina delle sale, il modulo per i gruppi. Li si carica qui una volta
   e poi si allegano dalla conversazione con due tocchi, invece di ripescarli
   dal telefono ogni volta.

   Il nome è separato dal nome del file di proposito: "Menù di Ferragosto"
   si trova a colpo d'occhio in un elenco, "menu_ferragosto_v3_DEF.pdf" no. */

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const MAX_BYTES = 5 * 1024 * 1024;

const leggibile = (bytes: number): string =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Icona per famiglia di file: si riconosce il PDF senza leggere l'estensione. */
const iconaPer = (contentType: string) => {
    if (contentType.startsWith('image/')) return ImageIcon;
    if (contentType.startsWith('video/')) return Film;
    if (contentType.startsWith('audio/')) return Music;
    return FileText;
};

export const MediaLibraryManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const puoModificare = hasPermission('settings:full');

    const [files, setFiles] = useState<MediaFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [caricando, setCaricando] = useState(false);
    const [titolo, setTitolo] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const ricarica = useCallback(async () => {
        try {
            const { files } = await listMedia();
            setFiles(files);
        } catch (err: any) {
            showToast(err?.data?.error || 'Elenco dei file non caricato', 'error');
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => { ricarica(); }, [ricarica]);

    const handleFile = async (file: File | undefined) => {
        if (!file) return;
        // Il controllo è anche sul server; qui serve a non far caricare 8 MB
        // per poi vederli rifiutati dopo l'attesa.
        if (file.size > MAX_BYTES) {
            showToast('File troppo grande: massimo 5 MB', 'error');
            return;
        }
        setCaricando(true);
        try {
            await uploadMedia(file, titolo);
            setTitolo('');
            if (inputRef.current) inputRef.current.value = '';
            await ricarica();
            showToast('File caricato', 'success');
        } catch (err: any) {
            showToast(err?.data?.error || 'Caricamento non riuscito', 'error');
        } finally {
            setCaricando(false);
        }
    };

    const handleDelete = async (f: MediaFile) => {
        if (!window.confirm(`Eliminare "${f.title}"? I messaggi già inviati restano invariati.`)) return;
        try {
            await deleteMedia(f.id);
            setFiles(prev => prev.filter(x => x.id !== f.id));
            showToast('File eliminato', 'success');
        } catch (err: any) {
            showToast(err?.data?.error || 'Eliminazione non riuscita', 'error');
        }
    };

    return (
        <details className="group bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] overflow-hidden">
            <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--ds-surface-row)] transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-arriving-text)] flex-shrink-0">
                        <Paperclip className="h-5 w-5" aria-hidden />
                    </div>
                    <div className="min-w-0">
                        <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Media</h4>
                        <p className="text-[13px] text-[var(--ds-text-muted)] truncate">
                            {loading ? 'Caricamento…'
                                : files.length === 0 ? 'Nessun file: carica il menù o la piantina'
                                : `${files.length} file pronti da allegare ai messaggi`}
                        </p>
                    </div>
                </div>
            </summary>

            <div className="border-t border-[var(--ds-border)] px-4 py-4 space-y-4">
                <p className="text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
                    I file caricati qui si allegano a un messaggio dalla conversazione, con la graffetta.
                    Utile per quello che mandi spesso: il menù di una serata, la piantina delle sale.
                    Massimo 5 MB — è il limite di WhatsApp, non nostro.
                </p>

                {puoModificare && (
                    <div className="rounded-[14px] border border-[var(--ds-border)] p-3 space-y-2.5">
                        <input
                            type="text"
                            value={titolo}
                            onChange={e => setTitolo(e.target.value)}
                            placeholder="Come lo chiami? (es. Menù di Ferragosto)"
                            className="w-full h-10 rounded-[10px] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 text-[14px] text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                        />
                        <input
                            ref={inputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,audio/mpeg,application/pdf"
                            onChange={e => handleFile(e.target.files?.[0])}
                            className="hidden"
                            id="media-file-input"
                        />
                        <button
                            type="button"
                            onClick={() => inputRef.current?.click()}
                            disabled={caricando}
                            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-[10px] bg-[var(--ds-text-primary)] px-4 text-[14px] font-semibold text-[var(--ds-surface)] transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                        >
                            {caricando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                            {caricando ? 'Carico…' : 'Scegli un file'}
                        </button>
                        <p className="text-[12px] text-[var(--ds-text-subtle)]">
                            Se lasci vuoto il nome, useremo quello del file.
                        </p>
                    </div>
                )}

                {loading ? (
                    <div className="flex items-center gap-2 py-4 text-[13px] text-[var(--ds-text-muted)]">
                        <Loader2 className="h-4 w-4 animate-spin" /> Carico l'elenco…
                    </div>
                ) : files.length === 0 ? (
                    <p className="py-3 text-[13px] text-[var(--ds-text-subtle)]">
                        Ancora nessun file.
                    </p>
                ) : (
                    <ul className="divide-y divide-[var(--ds-border)]">
                        {files.map(f => {
                            const Icona = iconaPer(f.content_type);
                            return (
                                <li key={f.id} className="flex items-center gap-3 py-2.5">
                                    <Icona className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-[14px] text-[var(--ds-text-primary)]">{f.title}</p>
                                        <p className="truncate text-[12px] text-[var(--ds-text-subtle)]">
                                            {f.filename} · {leggibile(f.size_bytes)}
                                        </p>
                                    </div>
                                    {puoModificare && (
                                        <button
                                            type="button"
                                            onClick={() => handleDelete(f)}
                                            aria-label={`Elimina ${f.title}`}
                                            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-danger-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </details>
    );
};
