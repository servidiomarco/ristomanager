import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { TABLE_TOP_HEIGHT } from '../model/geometry';
import type { TableModel } from '../types';
import { statusColors, type ScenePalette } from './theme';

/* I nomi dei tavoli: uno sprite per tavolo, con il nome disegnato su un canvas
 * 2D (256 × 128) nella pastiglia dell'app: --ds-surface, bordo dello stato,
 * testo in --tg-{stato}-name con il font dell'app. Senza nomi la sala 3D non
 * si confronta con la piantina, ed è il primo controllo che si fa.
 *
 * 1,2 m sopra il piano: più in alto delle teste degli ospiti seduti (PR2c),
 * così un'etichetta non finisce mai dentro una persona.
 *
 * Si ridisegna solo l'etichetta che cambia (nome, stato), e tutte al cambio
 * di tema o quando il font dell'app arriva dopo il ripiego: il modello si
 * ricalcola ogni minuto, le etichette no. */

const TEX_W = 256;
const TEX_H = 128;
const LABEL_LIFT = 1.2;
const LABEL_HEIGHT = 0.45;
const LABEL_WIDTH = LABEL_HEIGHT * (TEX_W / TEX_H);
const FONT_PX = 72;
const FONT_MIN_PX = 38;
// La pastiglia occupa quasi tutta l'altezza dello sprite (0,45 m): più
// grande il testo, più lontano si legge da un tablet all'ingresso.
const PILL_H = 110;
const PAD_X = 28;
const BORDER_PX = 3;
/** Un chip dell'app è alto ~36 px: il raggio dei controlli dello stile
 *  «squadrato» (8 px) si riporta sulla pastiglia in proporzione. */
const NOMINAL_CHIP_PX = 36;
/** Quanto si aspetta il font prima di disegnare col ripiego. */
const FONT_WAIT_MS = 1500;
/** Dopo anelli (1) e ombre (0): le etichette si compongono per ultime. */
const LABEL_RENDER_ORDER = 2;
/** Altezza minima a schermo di un'etichetta, in px CSS. A 0,45 m fissi una
 *  sala intera inquadrata su un tablet o su una TV dava etichette di 15-20 px,
 *  con le cifre a metà: il numero del tavolo è la prima cosa che si cerca, e
 *  da qualche metro non si leggeva. Da lontano l'etichetta cresce quanto
 *  basta per restare leggibile; da vicino resta la sua misura vera. */
const LABEL_MIN_SCREEN_PX = 30;
/** Fino a dove cresce: oltre, in una sala piena si coprirebbero a vicenda. */
const LABEL_MAX_GROWTH = 2.5;

interface Label {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  /** Quello che c'è disegnato: nome, stato, tema. '' = niente ancora. */
  drawn: string;
}

function createLabel(): Label {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Alfa premoltiplicata dal canvas (che la tiene già così) e fusione ONE /
  // ONE_MINUS_SRC_ALPHA: con l'alfa «dritta» i pixel trasparenti attorno alla
  // pastiglia sono neri, e mipmap e filtro bilineare li mescolano al bordo,
  // un alone scuro attorno a ogni etichetta vista da lontano.
  texture.premultiplyAlpha = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(LABEL_WIDTH, LABEL_HEIGHT, 1);
  sprite.renderOrder = LABEL_RENDER_ORDER;
  sprite.visible = false;
  return { sprite, material, texture, canvas, ctx, drawn: '' };
}

function disposeLabel(label: Label): void {
  label.material.dispose();
  label.texture.dispose();
  // Safari ha un tetto alla memoria totale dei canvas: a 0 × 0 la libera
  // subito, senza aspettare il garbage collector.
  label.canvas.width = 0;
  label.canvas.height = 0;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, h / 2, w / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

interface LabelLook {
  surface: string;
  stroke: string;
  text: string;
  fontFamily: string;
  controlRadiusPx: number;
}

function drawLabel(label: Label, name: string, look: LabelLook): void {
  const ctx = label.ctx;
  if (!ctx) return;
  ctx.clearRect(0, 0, TEX_W, TEX_H);

  // Il nome intero a 72 px; se non ci sta si rimpicciolisce fino a 38 px, e
  // solo oltre si taglia coi puntini («11+12+13+14» resta leggibile).
  const maxText = TEX_W - 2 * PAD_X - 2 * BORDER_PX;
  let size = FONT_PX;
  ctx.font = `500 ${size}px ${look.fontFamily}`;
  let text = name;
  let width = ctx.measureText(text).width;
  // In proporzione, poi un px alla volta: la larghezza non scala esatta col
  // corpo (crenatura, hinting) e un solo passo può restare un pixel sopra.
  while (width > maxText && size > FONT_MIN_PX) {
    size = Math.max(FONT_MIN_PX, Math.min(size - 1, Math.floor((size * maxText) / width)));
    ctx.font = `500 ${size}px ${look.fontFamily}`;
    width = ctx.measureText(text).width;
  }
  if (width > maxText) {
    let cut = name;
    while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxText) cut = cut.slice(0, -1);
    text = `${cut}…`;
    width = ctx.measureText(text).width;
  }

  const pillW = Math.min(TEX_W - BORDER_PX, Math.max(PILL_H, width + 2 * PAD_X));
  const x = (TEX_W - pillW) / 2;
  const y = (TEX_H - PILL_H) / 2;
  const radius = look.controlRadiusPx >= PILL_H ? PILL_H / 2 : (look.controlRadiusPx * PILL_H) / NOMINAL_CHIP_PX;
  roundRectPath(ctx, x, y, pillW, PILL_H, radius);
  ctx.fillStyle = look.surface;
  ctx.fill();
  ctx.lineWidth = BORDER_PX;
  ctx.strokeStyle = look.stroke;
  ctx.stroke();

  // Centrato sull'inchiostro vero (cifre e maiuscole iniziali), non sulla
  // scatola dell'em: con 'middle' i numeri cadono un filo in alto.
  ctx.fillStyle = look.text;
  ctx.textAlign = 'center';
  const m = ctx.measureText(text);
  const ascent = m.actualBoundingBoxAscent;
  const descent = m.actualBoundingBoxDescent;
  if (Number.isFinite(ascent) && Number.isFinite(descent) && ascent + descent > 0) {
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, TEX_W / 2, TEX_H / 2 + (ascent - descent) / 2);
  } else {
    ctx.textBaseline = 'middle';
    ctx.fillText(text, TEX_W / 2, TEX_H / 2);
  }
  label.texture.needsUpdate = true;
}

/** Quando disegnare le etichette, e quando ridisegnarle: 0 = non ancora; poi
 *  un numero che cresce quando il font vero arriva DOPO che si è già
 *  disegnato col ripiego (va nella firma di ogni etichetta).
 *
 *  Hanken Grotesk arriva da Google Fonts. Di solito è già in cache (l'app lo
 *  usa ovunque) e la promessa di fonts.load si risolve subito; offline o a
 *  rete lenta si disegna dopo FONT_WAIT_MS con la pila di --font-sans. Senza
 *  il secondo giro un tavolo che non cambia né nome né stato (ogni tavolo
 *  libero) resterebbe nel font di sistema fino al cambio di tema, su uno
 *  schermo fissato anche tutto il giorno. Il font può arrivare dopo per la
 *  promessa stessa o perché lo scarica il resto della pagina: per questo
 *  anche 'loadingdone'. */
function useFontEpoch(fontFamily: string): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let alive = true;
    // Le etichette sono già state disegnate, e col ripiego.
    let drawn = false;
    let onFallback = false;
    const spec = `500 ${FONT_PX}px ${fontFamily}`;
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    const hasFont = (): boolean => {
      try {
        return !!fonts && typeof fonts.check === 'function' && fonts.check(spec);
      } catch {
        return false;
      }
    };
    // Si disegna con quello che c'è: il font vero se è arrivato, se no il
    // ripiego (e lo si ricorda, per il secondo giro).
    const draw = () => {
      if (!alive || drawn) return;
      drawn = true;
      window.clearTimeout(timer);
      onFallback = !hasFont();
      setEpoch((e) => (e === 0 ? 1 : e));
    };
    const timer = window.setTimeout(draw, FONT_WAIT_MS);
    // Un font ha finito di caricare: se è il nostro si disegna, o si
    // ridisegna se prima era toccato al ripiego. 'loadingdone' scatta per
    // qualunque font, per questo il controllo.
    const arrived = () => {
      if (!alive || !hasFont()) return;
      if (!drawn) {
        draw();
        return;
      }
      if (!onFallback) return;
      onFallback = false;
      setEpoch((e) => e + 1);
    };
    try {
      if (fonts && typeof fonts.load === 'function') fonts.load(spec).then(arrived, draw);
      else draw();
      fonts?.addEventListener?.('loadingdone', arrived);
    } catch {
      draw();
    }
    return () => {
      alive = false;
      window.clearTimeout(timer);
      try {
        fonts?.removeEventListener?.('loadingdone', arrived);
      } catch {
        /* niente da staccare */
      }
    };
  }, [fontFamily]);
  return epoch;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const mm = (v: unknown): string => (finite(v) ? String(Math.round(v * 1000)) : 'x');
const EMPTY: readonly TableModel[] = [];

function labelsKey(tables: readonly TableModel[]): string {
  let key = '';
  for (const t of tables) {
    if (!t) continue;
    key += `${t.id}|${t.name}|${t.status}|${mm(t.center?.x)}|${mm(t.center?.z)}\n`;
  }
  return key;
}

interface TableLabelsProps {
  tables: readonly TableModel[] | null | undefined;
  palette: ScenePalette;
  themeVersion: number;
}

export function TableLabels({ tables: tablesProp, palette, themeVersion }: TableLabelsProps) {
  const invalidate = useThree((s) => s.invalidate);
  const [group] = useState(() => new THREE.Group());
  const [labels] = useState(() => new Map<number, Label>());
  const tables = Array.isArray(tablesProp) ? tablesProp : EMPTY;
  const key = useMemo(() => labelsKey(tables), [tables]);
  const tablesRef = useRef(tables);
  const fontEpoch = useFontEpoch(palette.fontFamily);

  useLayoutEffect(() => {
    tablesRef.current = tables;
  });

  useLayoutEffect(() => {
    const seen = new Set<number>();
    for (const t of tablesRef.current) {
      if (!t || !finite(t.center?.x) || !finite(t.center?.z)) continue;
      const name = String(t.name ?? '').trim();
      if (!name || seen.has(t.id)) continue;
      seen.add(t.id);
      let label = labels.get(t.id);
      if (!label) {
        label = createLabel();
        labels.set(t.id, label);
        group.add(label.sprite);
      }
      label.sprite.position.set(t.center.x, TABLE_TOP_HEIGHT + LABEL_LIFT, t.center.z);
      const colors = statusColors(palette, t.status);
      const drawn = `${name}|${t.status}|${themeVersion}|${fontEpoch}`;
      if (fontEpoch > 0 && label.drawn !== drawn) {
        drawLabel(label, name, {
          surface: palette.surfaceCss,
          stroke: colors.strokeCss,
          text: colors.nameCss,
          fontFamily: palette.fontFamily,
          controlRadiusPx: palette.controlRadiusPx,
        });
        label.drawn = drawn;
      }
      label.sprite.visible = label.drawn !== '';
    }
    for (const [id, label] of labels) {
      if (seen.has(id)) continue;
      group.remove(label.sprite);
      disposeLabel(label);
      labels.delete(id);
    }
    invalidate();
  }, [key, themeVersion, fontEpoch, palette, group, labels, invalidate]);

  // Misura minima a schermo: gira solo nei frame che si disegnano davvero
  // (frameloop a richiesta), quindi a ogni movimento di camera e mai a vuoto.
  // Nessuna allocazione: solo numeri e la scala degli sprite.
  useFrame((state) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    const viewH = state.size.height;
    if (!cam.isPerspectiveCamera || !(viewH > 0)) return;
    // Metri per px CSS a distanza 1 dalla camera.
    const perPx = (2 * Math.tan((cam.fov * Math.PI) / 360)) / viewH;
    const maxH = LABEL_HEIGHT * LABEL_MAX_GROWTH;
    for (const label of labels.values()) {
      if (!label.sprite.visible) continue;
      const d = cam.position.distanceTo(label.sprite.position);
      const h = Math.min(maxH, Math.max(LABEL_HEIGHT, LABEL_MIN_SCREEN_PX * perPx * d));
      if (Math.abs(label.sprite.scale.y - h) > 1e-4) label.sprite.scale.set(h * (TEX_W / TEX_H), h, 1);
    }
  });

  // Allo smontaggio (e allo smontaggio finto di StrictMode, dopo il quale
  // l'effetto qui sopra le ricrea da capo) si libera tutto.
  useEffect(() => {
    return () => {
      for (const label of labels.values()) {
        group.remove(label.sprite);
        disposeLabel(label);
      }
      labels.clear();
    };
  }, [group, labels]);

  return <primitive object={group} />;
}
