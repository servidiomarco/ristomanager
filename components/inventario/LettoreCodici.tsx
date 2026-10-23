import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CameraOff, Flashlight, FlashlightOff, Keyboard, Link2, Loader2, Plus, ScanBarcode, X } from 'lucide-react';
import {
  InventoryArea,
  InventoryLocation,
  InventoryMovementReason,
  InventoryProduct,
  InventoryStockRow,
} from '../../types';
import { addInventoryProductBarcode, getInventoryProducts, lookupInventoryBarcode } from '../../services/apiService';
import { normalizeBarcode } from '../../utils/barcode';
import { toTitleCase } from '../../utils/text';
import { Callout, SearchField, StatusPill, dsButton, dsInput } from '../ds';
import { dateLocale, formatDelta } from './Movimenti';
import { SchedaMovimento, parseQty, proposeCell, rememberCell, type Direction } from './SchedaMovimento';

/* ── Il lettore ────────────────────────────────────────────────────────────
   La fotocamera del telefono legge il codice a barre; la scheda che sale dal
   basso dice di che prodotto è e lo carica o scarica. Due usi:
   - «move»: dal tasto Scansiona dell'Inventario. Letto un codice si conferma
     il movimento e si torna a inquadrare il prossimo, senza chiudere niente:
     scaricare un furgone è una scansione per collo.
   - «capture»: dalla scheda del prodotto, per compilarne il codice. Il primo
     codice letto torna a chi l'ha chiesto e il lettore si chiude.

   Chrome su Android ha un lettore suo (BarcodeDetector); Safari no, e lì
   entra barcode-detector, lo stesso lettore compilato in WebAssembly. Il file
   .wasm (~1 MB) viene servito da noi, non dal CDN che la libreria userebbe:
   si scarica solo la prima volta che un iPhone apre il lettore. */

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'] as const;

// Lo stesso codice ancora inquadrato non è una nuova scansione: lo diventa
// quando è uscito dall'inquadratura per almeno questo tempo. È quello che
// permette di passare sei bottiglie una dopo l'altra e leggere «6».
const SAME_CODE_GAP_MS = 1500;
const DETECT_EVERY_MS = 120;

type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };

const createDetector = async (): Promise<Detector> => {
  const Native = (globalThis as any).BarcodeDetector;
  if (Native && typeof Native.getSupportedFormats === 'function') {
    try {
      const supported: string[] = await Native.getSupportedFormats();
      const formats = FORMATS.filter(f => supported.includes(f));
      if (formats.includes('ean_13')) return new Native({ formats });
    } catch {
      /* il lettore del browser non risponde: si passa a quello nostro */
    }
  }
  const [{ BarcodeDetector, prepareZXingModule }, wasm] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasm.default : prefix + path),
    },
  });
  return new BarcodeDetector({ formats: [...FORMATS] }) as unknown as Detector;
};

type CameraStatus = 'starting' | 'running' | 'denied' | 'unavailable' | 'error';

// La fotocamera e il ciclo di lettura. `onCode` riceve il testo grezzo di
// ogni lettura; il filtro «stesso codice ancora inquadrato» è di chi la usa.
const useBarcodeCamera = (active: boolean, onCode: (raw: string) => void) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const [status, setStatus] = useState<CameraStatus>('starting');
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus('starting');
    setTorchAvailable(false);
    setTorchOn(false);

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('unavailable');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (err: any) {
        if (!stopped) setStatus(err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'denied' : 'unavailable');
        return;
      }
      if (stopped) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      // Senza muted e playsinline Safari apre il video a tutto schermo.
      video.muted = true;
      video.setAttribute('playsinline', '');
      await video.play().catch(() => {});
      const track = stream.getVideoTracks()[0] ?? null;
      trackRef.current = track;
      const caps = (track?.getCapabilities?.() ?? {}) as any;
      setTorchAvailable(Boolean(caps.torch));

      let detector: Detector;
      try {
        detector = await createDetector();
      } catch {
        if (!stopped) setStatus('error');
        return;
      }
      if (stopped) return;
      setStatus('running');

      const tick = async () => {
        if (stopped) return;
        if (video.readyState >= 2) {
          try {
            const found = await detector.detect(video);
            const raw = found[0]?.rawValue;
            if (raw && !stopped) onCodeRef.current(raw);
          } catch {
            /* un fotogramma storto non ferma il lettore */
          }
        }
        timer = setTimeout(tick, DETECT_EVERY_MS);
      };
      tick();
    })();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach(t => t.stop());
      trackRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [active]);

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as any] });
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    }
  };

  return { videoRef, status, torchAvailable, torchOn, toggleTorch };
};

// Il telefono dice «letto» anche a chi non guarda lo schermo. iPhone non
// vibra da una pagina web: lì resta la scheda che sale.
const vibrate = (pattern: number | number[]) => {
  try { navigator.vibrate?.(pattern); } catch { /* non tutti i telefoni */ }
};

type Phase =
  | { kind: 'scan' }
  | { kind: 'lookup'; code: string }
  | { kind: 'found'; code: string; product: InventoryProduct; locations: InventoryLocation[]; stock: InventoryStockRow[] }
  | { kind: 'unknown'; code: string }
  | { kind: 'pick'; code: string };

interface Props {
  open: boolean;
  onClose: () => void;
  mode: 'move' | 'capture';
  /** capture: il codice letto, già normalizzato. */
  onCapture?: (code: string) => void;
  /** move: l'area e la cella che la pagina sta guardando, per la cella proposta. */
  activeArea: InventoryArea;
  activeLocationId: number | null;
  /** move: un codice da cercare subito (dopo aver creato il prodotto). */
  initialCode?: string | null;
  /** move: registra il movimento; true se è andato. */
  onMove?: (product: InventoryProduct, locationId: number, delta: number, reason: InventoryMovementReason) => Promise<boolean>;
  /** move: «Nuovo prodotto» con questo codice. */
  onCreateProduct?: (code: string) => void;
  /** move: un codice appena associato cambia il prodotto anche nella pagina. */
  onProductUpdated?: (product: InventoryProduct) => void;
  areaLabel: (area: InventoryArea) => string;
}

export const LettoreCodici: React.FC<Props> = ({
  open, onClose, mode, onCapture, activeArea, activeLocationId, initialCode,
  onMove, onCreateProduct, onProductUpdated, areaLabel,
}) => {
  const { t, i18n } = useTranslation('inventario', { useSuspense: false });
  const locale = dateLocale(i18n.language);

  const [phase, setPhase] = useState<Phase>({ kind: 'scan' });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [direction, setDirection] = useState<Direction>('in');
  const [qty, setQty] = useState('1');
  const [cellId, setCellId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // L'esito dell'ultimo movimento, in alto sopra la fotocamera: dice che è
  // andato senza chiedere un tocco per chiuderlo.
  const [done, setDone] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [pickList, setPickList] = useState<InventoryProduct[] | null>(null);
  const [pickSearch, setPickSearch] = useState('');
  const lastSeen = useRef<{ code: string; at: number } | null>(null);

  const lookup = async (code: string) => {
    setError(null);
    setPhase({ kind: 'lookup', code });
    try {
      const res = await lookupInventoryBarcode(code);
      if (phaseRef.current.kind !== 'lookup' || phaseRef.current.code !== code) return;
      const locations = Array.isArray(res.locations) ? res.locations : [];
      const stock = Array.isArray(res.stock) ? res.stock : [];
      const pageCell = res.product.area === activeArea && activeLocationId != null ? activeLocationId : null;
      const pick = proposeCell(res.product.area, locations, stock, pageCell);
      setCellId(pick);
      setQty('1');
      setPhase({ kind: 'found', code: res.barcode ?? code, product: res.product, locations, stock });
      vibrate(40);
    } catch (err: any) {
      if (phaseRef.current.kind !== 'lookup' || phaseRef.current.code !== code) return;
      if (err?.status === 404) {
        setPhase({ kind: 'unknown', code: typeof err?.data?.barcode === 'string' ? err.data.barcode : code });
        vibrate([30, 60, 30]);
      } else {
        setError(err?.message || t('lettore.lookupError', 'Errore nella ricerca del codice'));
        setPhase({ kind: 'scan' });
      }
    }
  };

  const handleCode = (raw: string) => {
    const code = normalizeBarcode(raw);
    if (!code) return;
    const now = Date.now();
    const last = lastSeen.current;
    lastSeen.current = { code, at: now };
    if (last && last.code === code && now - last.at < SAME_CODE_GAP_MS) return;

    if (mode === 'capture') {
      vibrate(40);
      onCapture?.(code);
      onClose();
      return;
    }
    const current = phaseRef.current;
    if (current.kind === 'scan') {
      setDone(null);
      lookup(code);
    } else if (current.kind === 'found' && (current.code === code || (current.product.barcodes ?? []).includes(code))) {
      // Lo stesso articolo ripassato: uno in più.
      setQty(q => {
        const n = Number(q.replace(',', '.'));
        return String(Number.isFinite(n) ? Math.round((n + 1) * 1000) / 1000 : 1);
      });
      vibrate(30);
    }
    // Un altro codice con una scheda aperta si ignora: prima si conferma o
    // si annulla, poi si passa al prossimo.
  };

  // La fotocamera resta accesa anche con la scheda aperta (serve a ripassare
  // lo stesso articolo); si spegne solo nella scelta del prodotto, dove non
  // si inquadra niente e la batteria conta.
  const cameraActive = open && phase.kind !== 'pick';
  const { videoRef, status, torchAvailable, torchOn, toggleTorch } = useBarcodeCamera(cameraActive, handleCode);

  // Ogni apertura riparte pulita; con un codice in mano lo cerca subito.
  useEffect(() => {
    if (!open) return;
    setPhase({ kind: 'scan' });
    setError(null);
    setDone(null);
    setManualOpen(false);
    setManualCode('');
    setPickList(null);
    setPickSearch('');
    lastSeen.current = null;
    if (mode === 'move' && initialCode) {
      // Il codice appena usato è ancora nell'inquadratura: non deve
      // riaprire la stessa scheda appena confermata.
      lastSeen.current = { code: initialCode, at: Date.now() };
      lookup(initialCode);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!done) return undefined;
    const id = setTimeout(() => setDone(null), 3500);
    return () => clearTimeout(id);
  }, [done]);

  const submitManual = () => {
    const code = normalizeBarcode(manualCode);
    if (!code) return;
    setManualOpen(false);
    setManualCode('');
    if (mode === 'capture') {
      onCapture?.(code);
      onClose();
      return;
    }
    lastSeen.current = { code, at: Date.now() };
    lookup(code);
  };

  const confirm = async () => {
    if (phase.kind !== 'found' || cellId == null || !onMove) return;
    const n = parseQty(qty);
    if (!Number.isFinite(n) || n <= 0) {
      setError(t('lettore.invalidQty', 'Quantità non valida'));
      return;
    }
    setSaving(true);
    setError(null);
    const delta = direction === 'in' ? n : -n;
    const reason = direction === 'in' ? InventoryMovementReason.CARICO : InventoryMovementReason.SCARICO;
    const ok = await onMove(phase.product, cellId, delta, reason);
    setSaving(false);
    if (!ok) return;
    rememberCell(phase.product.area, cellId);
    const cell = phase.locations.find(l => l.id === cellId);
    setDone(`${formatDelta(delta, phase.product.unit, locale)} · ${phase.product.name}${cell ? ` · ${toTitleCase(cell.name)}` : ''}`);
    // Il codice appena confermato è ancora inquadrato: lastSeen lo tiene
    // fermo finché non esce, così la scheda non si riapre da sola.
    lastSeen.current = { code: phase.code, at: Date.now() };
    setPhase({ kind: 'scan' });
  };

  const openPick = async () => {
    if (phase.kind !== 'unknown') return;
    const code = phase.code;
    setPhase({ kind: 'pick', code });
    setPickSearch('');
    if (pickList) return;
    try {
      const all = await getInventoryProducts();
      setPickList(Array.isArray(all) ? all : []);
    } catch (err: any) {
      setError(err?.message || t('lettore.productsError', 'Errore caricamento prodotti'));
      setPickList([]);
    }
  };

  const associate = async (product: InventoryProduct) => {
    if (phase.kind !== 'pick') return;
    const code = phase.code;
    setSaving(true);
    setError(null);
    try {
      const updated = await addInventoryProductBarcode(product.id, code);
      onProductUpdated?.(updated);
      setPickList(list => list?.map(p => (p.id === updated.id ? updated : p)) ?? null);
      lastSeen.current = { code, at: Date.now() };
      await lookup(code);
    } catch (err: any) {
      setError(err?.message || t('lettore.associateError', 'Errore nell\'associare il codice'));
    } finally {
      setSaving(false);
    }
  };

  const pickResults = useMemo(() => {
    const q = pickSearch.trim().toLowerCase();
    const list = pickList ?? [];
    const filtered = q ? list.filter(p => p.name.toLowerCase().includes(q)) : list;
    // Prima l'area che si sta guardando: il codice letto in cucina è quasi
    // sempre di un prodotto della cucina.
    return [...filtered].sort((a, b) =>
      (a.area === activeArea ? 0 : 1) - (b.area === activeArea ? 0 : 1) || a.name.localeCompare(b.name, locale));
  }, [pickList, pickSearch, activeArea, locale]);

  if (!open) return null;

  const cameraMessage =
    status === 'denied' ? t('lettore.denied', 'La fotocamera non è permessa. Consentila nelle impostazioni del browser, o scrivi il codice.')
    : status === 'unavailable' ? t('lettore.unavailable', 'Fotocamera non disponibile su questo dispositivo. Scrivi il codice.')
    : status === 'error' ? t('lettore.detectorError', 'Il lettore non è partito. Scrivi il codice.')
    : null;

  const manualForm = (
    <form
      className="flex gap-2"
      onSubmit={e => { e.preventDefault(); submitManual(); }}
    >
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        autoFocus
        value={manualCode}
        onChange={e => setManualCode(e.target.value)}
        placeholder={t('lettore.manualPlaceholder', 'Codice a barre')}
        aria-label={t('lettore.manualPlaceholder', 'Codice a barre')}
        className={`${dsInput} min-w-0 flex-1`}
      />
      <button type="submit" disabled={!normalizeBarcode(manualCode)} className={dsButton.primary}>
        {t('lettore.search', 'Cerca')}
      </button>
    </form>
  );

  // Il piede della scheda «codice sconosciuto», lo stesso di SchedaMovimento:
  // Annulla largo quanto la sua parola, l'azione principale prende il resto.
  // A metà e metà «Associa a un prodotto» andava a capo dentro un tasto alto
  // 44px; su un telefono più stretto si accorcia con i puntini.
  const footerRow = 'flex gap-2';
  const footerCancel = `${dsButton.secondary} flex-none`;
  const footerMain = `${dsButton.primary} min-w-0 flex-1 whitespace-nowrap`;

  // ---- Il pannello in basso, per fase ----------------------------------
  let panel: React.ReactNode;
  if (phase.kind === 'found') {
    panel = (
      <SchedaMovimento
        product={phase.product}
        locations={phase.locations}
        stock={phase.stock}
        direction={direction}
        onDirection={setDirection}
        qty={qty}
        onQty={setQty}
        cellId={cellId}
        onCell={setCellId}
        saving={saving}
        onConfirm={confirm}
        onCancel={() => { setPhase({ kind: 'scan' }); setError(null); }}
        areaBadge={phase.product.area !== activeArea ? areaLabel(phase.product.area) : null}
        areaLabel={areaLabel}
        footnote={t('lettore.againHint', 'Ripassa lo stesso codice per aggiungerne uno')}
      />
    );
  } else if (phase.kind === 'unknown') {
    panel = (
      <div className="space-y-3">
        <div>
          <div className="text-[18px] font-semibold text-[var(--ds-text-primary)]">{t('lettore.unknownTitle', 'Codice non trovato')}</div>
          <div className="mt-0.5 text-[14px] tabular-nums text-[var(--ds-text-muted)]">{phase.code}</div>
        </div>
        {/* Lo stesso piede della scheda del carico: Annulla a sinistra,
            l'azione che si cerca a destra e piena. «Nuovo prodotto» sta sopra,
            a tutta larghezza: è la strada meno frequente. Niente flex-1 in una
            colonna: lì schiaccia l'altezza (base 0) e il tasto perde i 44px. */}
        {onCreateProduct && (
          <button type="button" onClick={() => onCreateProduct(phase.code)} className={`${dsButton.secondary} w-full`}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('lettore.newProduct', 'Nuovo prodotto')}
          </button>
        )}
        <div className={footerRow}>
          <button type="button" onClick={() => setPhase({ kind: 'scan' })} className={footerCancel}>
            {t('lettore.cancel', 'Annulla')}
          </button>
          <button type="button" onClick={openPick} className={footerMain}>
            <Link2 className="h-4 w-4 flex-shrink-0" aria-hidden />
            <span className="truncate">{t('lettore.associate', 'Associa a un prodotto')}</span>
          </button>
        </div>
      </div>
    );
  } else if (phase.kind === 'pick') {
    panel = (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div>
          <div className="text-[18px] font-semibold text-[var(--ds-text-primary)]">{t('lettore.pickTitle', 'Di che prodotto è?')}</div>
          <div className="mt-0.5 text-[14px] tabular-nums text-[var(--ds-text-muted)]">{phase.code}</div>
        </div>
        <SearchField
          value={pickSearch}
          onChange={setPickSearch}
          placeholder={t('searchProduct')}
          ariaLabel={t('searchProduct')}
        />
        <div className="min-h-0 flex-1 overflow-y-auto rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
          {pickList == null ? (
            <p className="flex items-center justify-center gap-2 py-6 text-[14px] text-[var(--ds-text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {t('lettore.loadingProducts', 'Carico i prodotti…')}
            </p>
          ) : pickResults.length === 0 ? (
            <p className="py-6 text-center text-[14px] text-[var(--ds-text-muted)]">{t('noProductForFilters')}</p>
          ) : (
            pickResults.map((p, i) => (
              <button
                key={p.id}
                type="button"
                disabled={saving}
                onClick={() => associate(p)}
                className={`flex min-h-[52px] w-full items-center gap-3 px-4 text-left transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-50 ${
                  i > 0 ? 'border-t border-[var(--ds-border)]' : ''
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{p.name}</span>
                {p.unit && <span className="text-[13px] text-[var(--ds-text-muted)]">{p.unit}</span>}
                {p.area !== activeArea && <StatusPill tone="neutral">{areaLabel(p.area)}</StatusPill>}
              </button>
            ))
          )}
        </div>
        <button type="button" onClick={() => setPhase({ kind: 'unknown', code: phase.code })} className={`${dsButton.secondary} w-full`}>
          {t('lettore.back', 'Indietro')}
        </button>
      </div>
    );
  } else {
    // scan / lookup
    panel = (
      <div className="space-y-3">
        {phase.kind === 'lookup' ? (
          <p className="flex items-center justify-center gap-2 py-2 text-[15px] text-[var(--ds-text-secondary)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('lettore.looking', { code: phase.code, defaultValue: 'Cerco {{code}}…' })}
          </p>
        ) : manualOpen || cameraMessage ? (
          manualForm
        ) : (
          <p className="py-1 text-center text-[15px] text-[var(--ds-text-secondary)]">
            {mode === 'capture'
              ? t('lettore.hintCapture', 'Inquadra il codice a barre del prodotto')
              : t('lettore.hint', 'Inquadra il codice a barre')}
          </p>
        )}
        {!manualOpen && !cameraMessage && phase.kind === 'scan' && (
          <button type="button" onClick={() => setManualOpen(true)} className={`${dsButton.quiet} w-full`}>
            <Keyboard className="h-4 w-4" aria-hidden />
            {t('lettore.typeCode', 'Scrivi il codice')}
          </button>
        )}
      </div>
    );
  }

  const title = mode === 'capture' ? t('lettore.titleCapture', 'Leggi il codice') : t('lettore.title', 'Scansiona');

  return createPortal(
    // Sopra a tutto, anche alla scheda del prodotto che lo apre in «capture».
    // Lo strato della fotocamera è nero in tutti e due i temi, e quello che ci
    // sta sopra è bianco: colori scritti per esteso, perché `text-white` qui
    // passa dal vecchio @theme, che nel tema scuro rimappa white sul grigio
    // scuro delle superfici, e il titolo spariva.
    <div className="fixed inset-0 z-[60] flex items-stretch justify-center bg-[#000] sm:items-center sm:bg-[var(--ds-backdrop)] sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="relative flex h-full w-full flex-col overflow-hidden bg-[#000] sm:h-[min(820px,100%)] sm:max-w-[480px] sm:rounded-[var(--ds-radius)]">
        {/* La fotocamera */}
        {/* Nella scelta del prodotto la fotocamera è spenta e resta solo la
            striscia in alto, con il titolo e la chiusura. */}
        {/* overflow-hidden: l'ombra larga 9999px attorno al riquadro scurisce
            la fotocamera, e senza questo scuriva anche il pannello sotto (sul
            telefono le schede uscivano grigie e spente). */}
        <div className={`relative overflow-hidden ${phase.kind === 'pick' ? 'h-[76px] flex-none' : 'min-h-0 flex-1'}`}>
          <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" muted playsInline aria-hidden />
          {status === 'running' && phase.kind !== 'pick' && (
            // Il riquadro dice dove mettere il codice; il resto dell'immagine
            // si legge comunque.
            <div className="pointer-events-none absolute inset-x-[12%] top-1/2 h-[28%] -translate-y-1/2 rounded-[var(--ds-radius)] border-2 border-[rgba(255,255,255,0.85)] shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" aria-hidden />
          )}
          {status === 'starting' && phase.kind !== 'pick' && (
            <p className="absolute inset-0 flex items-center justify-center gap-2 text-[15px] text-[rgba(255,255,255,0.8)]">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {t('lettore.starting', 'Accendo la fotocamera…')}
            </p>
          )}
          {cameraMessage && phase.kind !== 'pick' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center text-[15px] text-[rgba(255,255,255,0.85)]">
              <CameraOff className="h-8 w-8" aria-hidden />
              {cameraMessage}
            </div>
          )}
          {done && (
            <div className="absolute inset-x-4 top-[68px] flex justify-center" role="status">
              <span className="max-w-full truncate rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-4 py-2 text-[14px] font-medium text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-raised)]">
                {done}
              </span>
            </div>
          )}
          {/* In alto: chiudi e torcia */}
          {/* La sfumatura tiene leggibili titolo e tasti anche su un'etichetta
              bianca sotto la luce della cella. */}
          <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-[linear-gradient(to_bottom,rgba(0,0,0,0.6),transparent)] p-4 pb-8" style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}>
            <span className="inline-flex items-center gap-2 text-[16px] font-semibold text-[#fff]">
              <ScanBarcode className="h-5 w-5" aria-hidden />
              {title}
            </span>
            <div className="flex items-center gap-2">
              {torchAvailable && (
                <button
                  type="button"
                  onClick={toggleTorch}
                  aria-label={torchOn ? t('lettore.torchOff', 'Spegni la torcia') : t('lettore.torchOn', 'Accendi la torcia')}
                  aria-pressed={torchOn}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--ds-radius-control)] bg-[rgba(255,255,255,0.16)] text-[#fff] transition-colors hover:bg-[rgba(255,255,255,0.26)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#fff]"
                >
                  {torchOn ? <FlashlightOff className="h-5 w-5" aria-hidden /> : <Flashlight className="h-5 w-5" aria-hidden />}
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label={t('close')}
                className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--ds-radius-control)] bg-[rgba(255,255,255,0.16)] text-[#fff] transition-colors hover:bg-[rgba(255,255,255,0.26)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#fff]"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
          </div>
        </div>

        {/* Il pannello */}
        <div
          className={`flex flex-col gap-3 bg-[var(--ds-canvas)] px-4 pt-4 ${phase.kind === 'pick' ? 'min-h-0 flex-1' : ''}`}
          style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}
        >
          {error && <Callout tone="critical">{error}</Callout>}
          {panel}
        </div>
      </div>
    </div>,
    document.body
  );
};
