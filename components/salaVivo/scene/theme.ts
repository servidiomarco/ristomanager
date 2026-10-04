import { useEffect, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLYPH } from '../../../utils/tableGeometry';
import type { TableDisplayStatus } from '../types';

/* I colori della scena 3D: gli stessi token della piantina, letti dal CSS.
 *
 * Perché leggerli e non riscriverli qui: index.css è l'unica fonte dei colori
 * e i --tg-* cambiano col tema. Una copia a mano diverge al primo ritocco,
 * come è già successo con prenota.html e i fogli di stampa.
 *
 * Una tavolozza sola, di THREE.Color creati una volta. I materiali a colore
 * fisso tengono il colore PER RIFERIMENTO (material.color = palette.x): al
 * cambio di tema li aggiorna il .set() sul posto, senza ricreare materiali né
 * rimontare la scena. Quello che è COPIATO altrove (i colori per istanza di
 * tavoli, figure e cartellini, le etichette disegnate su canvas) si rifà
 * quando cresce `version`.
 */

/** Gli stati del glifo, nell'ordine della piantina. */
export const TABLE_STATUSES = ['libera', 'attesa', 'inarrivo', 'arrivato', 'uscita', 'noshow'] as const satisfies readonly TableDisplayStatus[];

// Se TableGlyph aggiunge uno stato e qui manca, tsc si ferma su questa riga
// invece di lasciare in sala un tavolo senza colore.
type UnlistedStatus = Exclude<TableDisplayStatus, (typeof TABLE_STATUSES)[number]>;
const STATUS_LIST_IS_COMPLETE: [UnlistedStatus] extends [never] ? true : false = true;
void STATUS_LIST_IS_COMPLETE;

export interface StatusColors {
  /** --tg-{s}-bg: il piano del tavolo. */
  bg: THREE.Color;
  /** --tg-{s}-stroke: lo spessore del piano e le gambe, il «bordo» del glifo. */
  stroke: THREE.Color;
  /** --tg-{s}-chair: le sedie accese. */
  chair: THREE.Color;
  /** Le sedie spente di un tavolo occupato: chair verso il pavimento al 75 %,
   *  come l'opacità 0,25 con cui la 2D le disegna sopra la sala. */
  chairDim: THREE.Color;
  /** --tg-{s}-name e --tg-{s}-stroke in CSS, per le etichette su canvas 2D. */
  nameCss: string;
  strokeCss: string;
}

export interface ScenePalette {
  dark: boolean;
  /** --ds-canvas: lo sfondo, lo stesso del palco della pagina. */
  canvas: THREE.Color;
  /** --ds-surface: il pavimento. */
  surface: THREE.Color;
  /** --ds-surface-row: banco del pass, leggio, zerbino. */
  surfaceRow: THREE.Color;
  /** --ds-border-strong: zoccolo, telaio della porta, piani degli arredi. */
  borderStrong: THREE.Color;
  /** --ds-cat-5-tint: il pavimento all'aperto (una categoria, non uno stato). */
  outdoorFloor: THREE.Color;
  /** --tg-inarrivo-accent: l'anello che pulsa. */
  ringAccent: THREE.Color;
  /* I colori dei ruoli: mai un colore di stato (una figura in --tg-* si
   * leggerebbe come lo stato del tavolo), e mai il verde acqua di
   * --ds-cat-1, che in sala vuol dire «uscita». */
  /** --ds-text-muted: gli ospiti, pedine neutre schiarite per comitiva
   *  (guestBodyColor). */
  guest: THREE.Color;
  /** Il chiaro verso cui vanno la tinta degli ospiti e le teste: --ds-surface
   *  col tema chiaro (il pavimento), --ds-text-primary con lo scuro. Verso il
   *  pavimento scuro teste e bambini diventerebbero più scuri dei corpi e
   *  degli adulti, e una testa di bambino sul pavimento della veranda
   *  scenderebbe a 2,5:1. */
  light: THREE.Color;
  /** --ds-cat-6-solid, argilla: l'hostess, l'unica tinta di una figura fuori
   *  dalle famiglie di stato. */
  hostess: THREE.Color;
  /** --ds-cat-6-text: il cane. */
  dog: THREE.Color;
  /** --ds-action-bg: i camerieri, col grembiule in --ds-surface. Il colore
   *  dei bottoni pieni dell'app, quasi nero col tema chiaro e quasi bianco
   *  con lo scuro: la divisa, che non è né uno stato né una categoria. */
  waiter: THREE.Color;
  /** --ds-border-strong: il vassoio. In --ds-surface-row sparirebbe sul
   *  pavimento chiaro, visto dall'alto. */
  tray: THREE.Color;
  /** Il cartellino «Riservato» o «Evento» sul piano: le falde in
   *  --tg-attesa-name (il blu scuro dell'attesa col tema chiaro, chiaro con lo
   *  scuro), la costa in --tg-attesa-bg. Al contrario, in --tg-attesa-bg,
   *  sparirebbe sul piano di un tavolo libero, in attesa o in arrivo, che
   *  sono tutti dello stesso chiaro. */
  signCard: THREE.Color;
  signRidge: THREE.Color;
  /** Le ombre a macchia: nero a 0,12 col tema chiaro, 0,30 con lo scuro, dove
   *  un'ombra leggera sparirebbe. */
  shadowOpacity: number;
  status: Record<TableDisplayStatus, StatusColors>;
  /** --ds-surface in CSS: la pastiglia delle etichette. */
  surfaceCss: string;
  /** --ds-border-strong e --ds-text-secondary in CSS: la pastiglia «+N»
   *  dell'ingresso, neutra come un contatore dell'app. */
  borderStrongCss: string;
  textSecondaryCss: string;
  /** --font-sans per intero, pila di ripiego compresa. */
  fontFamily: string;
  /** --ds-radius-control in px: pillola piena col «classico», 8 px con lo
   *  «squadrato». Le etichette seguono lo stile scelto come ogni altro chip. */
  controlRadiusPx: number;
}

const FALLBACK_COLOR = '#888888';
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const CSS_FUNCTION = /^(?:rgb|rgba|hsl|hsla)\(/i;

/** Un token del documento, così com'è scritto in index.css. Vuoto quando non
 *  è definito: lo decide chi lo legge (un colore ripiega su #888888). */
function readRaw(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim();
}

/** Un token colore. Tutti quelli usati qui sono esadecimali puri (verificato in
 *  index.css, tema chiaro e scuro); un valore che three non saprebbe leggere
 *  diventa il grigio di ripiego, mai un colore lasciato a metà. */
function readColor(style: CSSStyleDeclaration, name: string): string {
  const v = readRaw(style, name);
  return HEX.test(v) || CSS_FUNCTION.test(v) ? v : FALLBACK_COLOR;
}

const _from = { r: 0, g: 0, b: 0 };
const _to = { r: 0, g: 0, b: 0 };

/** Mescola due colori nello spazio sRGB, quello in cui il browser compone
 *  l'opacità della 2D: così la sedia spenta in 3D è lo stesso colore che
 *  l'occhio vede sulla piantina, non quello di un mix lineare (più chiaro). */
function mixSrgb(target: THREE.Color, from: THREE.Color, to: THREE.Color, t: number): void {
  from.getRGB(_from, THREE.SRGBColorSpace);
  to.getRGB(_to, THREE.SRGBColorSpace);
  target.setRGB(
    _from.r + (_to.r - _from.r) * t,
    _from.g + (_to.g - _from.g) * t,
    _from.b + (_to.b - _from.b) * t,
    THREE.SRGBColorSpace,
  );
}

function emptyStatus(): StatusColors {
  return {
    bg: new THREE.Color(FALLBACK_COLOR),
    stroke: new THREE.Color(FALLBACK_COLOR),
    chair: new THREE.Color(FALLBACK_COLOR),
    chairDim: new THREE.Color(FALLBACK_COLOR),
    nameCss: FALLBACK_COLOR,
    strokeCss: FALLBACK_COLOR,
  };
}

/** Rilegge tutti i token nella tavolozza, sul posto. */
export function readPalette(palette: ScenePalette): void {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  palette.dark = root.classList.contains('dark');
  palette.canvas.set(readColor(style, '--ds-canvas'));
  palette.surface.set(readColor(style, '--ds-surface'));
  palette.surfaceRow.set(readColor(style, '--ds-surface-row'));
  palette.borderStrong.set(readColor(style, '--ds-border-strong'));
  palette.outdoorFloor.set(readColor(style, '--ds-cat-5-tint'));
  palette.ringAccent.set(readColor(style, '--tg-inarrivo-accent'));
  palette.guest.set(readColor(style, '--ds-text-muted'));
  palette.light.set(readColor(style, palette.dark ? '--ds-text-primary' : '--ds-surface'));
  palette.hostess.set(readColor(style, '--ds-cat-6-solid'));
  palette.dog.set(readColor(style, '--ds-cat-6-text'));
  palette.waiter.set(readColor(style, '--ds-action-bg'));
  palette.tray.set(readColor(style, '--ds-border-strong'));
  palette.signCard.set(readColor(style, '--tg-attesa-name'));
  palette.signRidge.set(readColor(style, '--tg-attesa-bg'));
  palette.shadowOpacity = palette.dark ? 0.3 : 0.12;
  palette.surfaceCss = readColor(style, '--ds-surface');
  palette.borderStrongCss = readColor(style, '--ds-border-strong');
  palette.textSecondaryCss = readColor(style, '--ds-text-secondary');
  // La pila di --font-sans va a capo in index.css: su una riga sola, o la
  // proprietà font del canvas la rifiuta e ripiega sul serif.
  palette.fontFamily = readRaw(style, '--font-sans').replace(/\s+/g, ' ') || 'sans-serif';
  const radius = parseFloat(readRaw(style, '--ds-radius-control'));
  palette.controlRadiusPx = Number.isFinite(radius) && radius >= 0 ? radius : 9999;

  for (const s of TABLE_STATUSES) {
    const c = palette.status[s];
    c.bg.set(readColor(style, `--tg-${s}-bg`));
    c.stroke.set(readColor(style, `--tg-${s}-stroke`));
    c.chair.set(readColor(style, `--tg-${s}-chair`));
    mixSrgb(c.chairDim, c.chair, palette.surface, 1 - GLYPH.DIMMED_CHAIR_OPACITY);
    c.nameCss = readColor(style, `--tg-${s}-name`);
    c.strokeCss = readColor(style, `--tg-${s}-stroke`);
  }
}

function createPalette(): ScenePalette {
  const status = {} as Record<TableDisplayStatus, StatusColors>;
  for (const s of TABLE_STATUSES) status[s] = emptyStatus();
  const palette: ScenePalette = {
    dark: false,
    canvas: new THREE.Color(FALLBACK_COLOR),
    surface: new THREE.Color(FALLBACK_COLOR),
    surfaceRow: new THREE.Color(FALLBACK_COLOR),
    borderStrong: new THREE.Color(FALLBACK_COLOR),
    outdoorFloor: new THREE.Color(FALLBACK_COLOR),
    ringAccent: new THREE.Color(FALLBACK_COLOR),
    guest: new THREE.Color(FALLBACK_COLOR),
    light: new THREE.Color(FALLBACK_COLOR),
    hostess: new THREE.Color(FALLBACK_COLOR),
    dog: new THREE.Color(FALLBACK_COLOR),
    waiter: new THREE.Color(FALLBACK_COLOR),
    tray: new THREE.Color(FALLBACK_COLOR),
    signCard: new THREE.Color(FALLBACK_COLOR),
    signRidge: new THREE.Color(FALLBACK_COLOR),
    shadowOpacity: 0.12,
    status,
    surfaceCss: FALLBACK_COLOR,
    borderStrongCss: FALLBACK_COLOR,
    textSecondaryCss: FALLBACK_COLOR,
    fontFamily: 'sans-serif',
    controlRadiusPx: 9999,
  };
  readPalette(palette);
  return palette;
}

/** I colori di uno stato, con ripiego su «libera» per un valore che questo
 *  client non conosce (un server più nuovo): meglio un tavolo neutro che un
 *  tavolo che fa cadere la scena. */
export function statusColors(palette: ScenePalette, status: TableDisplayStatus): StatusColors {
  return palette.status[status] ?? palette.status.libera;
}

/** Quanto la testa di una figura va dal corpo verso il chiaro: una pedina
 *  monocroma, con la testa che si stacca dal busto senza un colore pelle. */
const HEAD_TOWARD_LIGHT = 0.35;

/** Il corpo di un ospite: --ds-text-muted spostato di `tint` verso il chiaro
 *  (palette.light: --ds-surface col tema chiaro, --ds-text-primary con lo
 *  scuro; FigureSlot.tint: 0–0,20 per comitiva, +0,15 i bambini). Così i
 *  bambini sono più chiari degli adulti con tutti e due i temi. Nello spazio
 *  sRGB come le sedie spente: un passo di tinta schiarisce quanto l'occhio si
 *  aspetta, non di più verso il chiaro come un mix lineare. Scrive in `out`,
 *  niente allocazioni. */
export function guestBodyColor(palette: ScenePalette, tint: number, out: THREE.Color): THREE.Color {
  const t = typeof tint === 'number' && Number.isFinite(tint) ? Math.min(1, Math.max(0, tint)) : 0;
  mixSrgb(out, palette.guest, palette.light, t);
  return out;
}

/** La testa: il colore del corpo al 35 % verso il chiaro, più chiara del
 *  busto con tutti e due i temi. `out` può essere lo stesso colore di
 *  `body`. */
export function headColor(palette: ScenePalette, body: THREE.Color, out: THREE.Color): THREE.Color {
  mixSrgb(out, body, palette.light, HEAD_TOWARD_LIGHT);
  return out;
}

/** La tavolozza della scena e la sua versione.
 *
 * Il tema lo mette App, con la classe `dark` su <html>: un MutationObserver
 * sugli attributi di <html> rilegge i token solo quando `dark` cambia davvero
 * (la classe porta anche altro) o quando cambia `data-design`, che sposta il
 * raggio delle pastiglie. Niente polling, niente lettura a ogni frame. */
export function useScenePalette(): { palette: ScenePalette; version: number } {
  const invalidate = useThree((s) => s.invalidate);
  const [palette] = useState(createPalette);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const root = document.documentElement;
    let dark = palette.dark;
    let design = root.getAttribute('data-design');
    const refresh = () => {
      const nextDark = root.classList.contains('dark');
      const nextDesign = root.getAttribute('data-design');
      if (nextDark === dark && nextDesign === design) return;
      dark = nextDark;
      design = nextDesign;
      readPalette(palette);
      setVersion((v) => v + 1);
      invalidate();
    };
    // Il tema può essere cambiato fra la prima lettura e questo effetto.
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-design'] });
    return () => observer.disconnect();
  }, [palette, invalidate]);

  return { palette, version };
}

/* ── La luce ──────────────────────────────────────────────────────────────
 *
 * Scelta: MeshLambertMaterial ovunque, con una luce ambientale e una
 * direzionale TARATE, e Canvas `flat` (niente tone mapping). In three r186
 * Lambert rende albedo/π · (A + I·max(0, n·l)) con luci bianche (A
 * ambientale, I direzionale), in spazio lineare, poi la conversione sRGB in
 * uscita. Con A + I·l_y = π una faccia rivolta in alto (n = +Y) rende
 * ESATTAMENTE il suo colore: il piano del tavolo è il suo --tg-*-bg, il
 * pavimento il suo --ds-surface, la seduta il suo --tg-*-chair, entro
 * l'arrotondamento a 8 bit (il ±3 % richiesto, con margine). Le facce
 * verticali prendono solo una parte della direzionale e scendono fra 0,65 e
 * 0,84 dell'albedo: lo spessore del piano e lo schienale si leggono, senza
 * un secondo materiale per parte e senza ombre calcolate.
 *
 * Perché non MeshBasic sui piani: con una regola sola per tutto, piani,
 * sedute, pavimento e arredi stanno nella stessa luce, e l'ombra delle facce
 * laterali viene da sé invece che da colori scuriti a mano.
 */
const SUN_RAW = new THREE.Vector3(0.35, 1, 0.55).normalize();
/** La direzione della luce (dalla superficie verso la luce): dall'alto, un
 *  po' da destra e dal lato della camera, così le facce che guardano lo
 *  spettatore sono le più chiare fra le verticali. */
export const SUN_POSITION: [number, number, number] = [SUN_RAW.x * 20, SUN_RAW.y * 20, SUN_RAW.z * 20];
export const AMBIENT_INTENSITY = 0.65 * Math.PI;
export const SUN_INTENSITY = (Math.PI - AMBIENT_INTENSITY) / SUN_RAW.y;

/* ── Le ombre a macchia ───────────────────────────────────────────────────
 * Niente shadow map (costano un passaggio di rendering a ogni frame e su un
 * televisore non servono): sotto tavoli, sedie e arredi un disco morbido
 * nero, trasparente, che la 2D disegna come l'ombra a 0,08 del glifo. */
export interface BlobShadow {
  material: THREE.MeshBasicMaterial;
  texture: THREE.DataTexture;
}

const SHADOW_TEX = 64;

export function createBlobShadow(): BlobShadow {
  const data = new Uint8Array(SHADOW_TEX * SHADOW_TEX * 4);
  const half = SHADOW_TEX / 2;
  for (let y = 0; y < SHADOW_TEX; y++) {
    for (let x = 0; x < SHADOW_TEX; x++) {
      const d = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half;
      const v = Math.min(1, Math.max(0, 1 - d));
      // smoothstep: il centro pieno e un bordo che svanisce senza scalino.
      const a = Math.round(255 * v * v * (3 - 2 * v));
      const i = (y * SHADOW_TEX + x) * 4;
      // alphaMap legge il canale verde: lo stesso valore su tutti e tre.
      data[i] = a;
      data[i + 1] = a;
      data[i + 2] = a;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, SHADOW_TEX, SHADOW_TEX, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    alphaMap: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    opacity: 0.12,
  });
  return { material, texture };
}

export function disposeBlobShadow(shadow: BlobShadow): void {
  shadow.material.dispose();
  shadow.texture.dispose();
}
