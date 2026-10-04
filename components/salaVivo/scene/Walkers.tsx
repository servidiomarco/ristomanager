import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { ActorView, FrameNeed, SceneDirectorApi } from '../types';
import {
  HEAD_CENTRE_Y,
  composeDogLying,
  composeDogStanding,
  composePersonJoints,
  createDogMatrices,
  createFigureGeometries,
  createPersonMatrices,
  figureScale,
} from './figures';
import { motionWakeAtFrom, type FrameDemand } from './frameDemand';
import { DOG_SHADOW_L, DOG_SHADOW_W, SHADOW_Y, STAND_SHADOW } from './People';
import { guestBodyColor, headColor, type ScenePalette } from './theme';
import { createPoseJoints, poseJoints } from './walkPose';

/* Chi si muove: gli attori del regista (model/director.ts, che arriva qui
 * come SceneDirectorApi), cioè gli ospiti a metà di un passaggio,
 * l'hostess (sempre: cammina, e il suo nome la segue) e i camerieri.
 *
 * Questo strato fa anche andare avanti il regista: un useFrame a priorità
 * −1, il primo di ogni frame, chiama director.step(delta) e poi disegna
 * director.actorsIn(sala). People (priorità 0) legge lo stesso regista nello
 * stesso frame e salta le chiavi che il regista ha in mano: ogni figura è
 * disegnata da uno strato solo. Dopo il passo si pubblica quanti frame
 * servono (demand.motion, demand.motionWakeAt), e si sveglia il throttle
 * solo quando il bisogno cambia, mai a ogni frame.
 *
 * Le stesse parti di People (busto, testa, coscia, stinco, braccio,
 * avambraccio, chignon, più grembiule e vassoio del cameriere, corpo e zampe
 * del cane in piedi, il cane sdraiato, le ombre), in InstancedMesh dinamici
 * (DynamicDrawUsage) da 48 persone e 8 cani, rifatti al doppio se non
 * bastano, riscritti a ogni frame disegnato con temporanei riusati: niente
 * allocazioni per frame, niente stato React.
 *
 * Comparire e svanire. Chi entra dalla porta o se ne va, chi si dissolve
 * sul posto: un'opacità per istanza (ActorView.fade), in un secondo gruppo
 * di mesh trasparenti che si riempie solo mentre qualcuno è a metà. Sono
 * mesh trasparenti con depthWrite spento, e da sole mostrerebbero le parti
 * dietro attraverso quelle davanti (il braccio lontano dentro il busto, la
 * testa di chi segue sopra il petto di chi precede: le istanze si disegnano
 * per tipo di parte, non per persona). Per questo ogni mesh di quel gruppo
 * ha un gemello che prima scrive solo la profondità (colorWrite spento, dopo
 * tutto l'opaco), con lo stesso shader di vertice; poi il colore passa solo
 * dove la profondità è UGUALE, cioè sulla superficie più vicina, e una
 * figura a metà è un fantasma uniforme, che copre chi gli sta dietro. Con
 * «minore o uguale» e un piccolo scarto di profondità passavano anche le due
 * capsule che si incrociano a gomito e ginocchio: una riga scura a ogni
 * giuntura. Il prezzo: una figura quasi trasparente copre le ombre a terra
 * dietro di lei (al 12 % col tema chiaro non si vede), e una draw call in
 * più per tipo di parte, solo finché qualcuno sta svanendo. Scala o
 * affondamento non andavano: chi entra dalla porta crescerebbe camminando.
 * Il retino (dither) sì, ma su un tablet si vede la trama.
 *
 * Le ombre a macchia di chi non è seduto svaniscono con lui (anche fuori
 * dalla porta, dove non c'è pavimento: un'ombra senza nessuno sarebbe una
 * macchia nel vuoto), e chi si siede la perde mentre si siede: seduto non ce
 * l'ha, come in People.
 *
 * I nomi del personale (l'hostess della sala principale, i camerieri con un
 * nome): una pastiglia per attore, uno sprite sopra la testa, disegnato su
 * canvas quando compare o cambia tema e poi solo spostato. */

/** La capienza di partenza: 48 persone e 8 cani; i pezzi si rifanno al
 *  doppio quando non bastano. */
const PEOPLE_CAPACITY = 48;
const DOG_CAPACITY = 8;
const STAFF_CAPACITY = 12;
/** Sotto questa opacità un attore non si disegna affatto (è fuori dalla
 *  porta, o in coda dietro di lei). */
const FADE_HIDDEN = 0.004;
/** Dopo tutto l'opaco (0): la profondità di chi svanisce si scrive per
 *  ultima, sopra un pavimento e dei tavoli già disegnati. */
const DEPTH_RENDER_ORDER = 3;
/** Fra gli anelli (1) e le etichette (2): chi svanisce si mescola alla sala
 *  già disegnata, ombre e anelli compresi, e le etichette restano sopra. */
const FADING_RENDER_ORDER = 1.5;
/** Due risvegli del regista più vicini di così sono lo stesso. */
const WAKE_TOLERANCE_MS = 8;

/* Le pastiglie dei nomi: sopra la testa (il centro, +35 cm), alte 0,30 m
 * nel mondo e almeno 22 px sullo schermo, fino al doppio. Il disegno è
 * quello della pastiglia «+N» dell'ingresso (TableLabels): --ds-surface,
 * bordo --ds-border-strong, testo --ds-text-secondary, il raggio dei
 * controlli dello stile scelto. Neutra: il nome di chi lavora in sala non è
 * lo stato di un tavolo. */
const LABEL_LIFT = 0.35;
const LABEL_HEIGHT = 0.3;
const LABEL_MIN_SCREEN_PX = 22;
const LABEL_MAX_GROWTH = 2;
const LABEL_TEX_H = 96;
const LABEL_PILL_H = 80;
const LABEL_FONT_PX = 50;
const LABEL_PAD_X = 22;
const LABEL_BORDER_PX = 3;
const LABEL_MAX_TEX_W = 512;
/** Un chip dell'app è alto ~36 px: il raggio dello stile «squadrato» si
 *  riporta sulla pastiglia in proporzione, come in TableLabels. */
const NOMINAL_CHIP_PX = 36;
/** Come le etichette dei tavoli: sopra tutto. */
const LABEL_RENDER_ORDER = 2;

const EMPTY: readonly ActorView[] = [];
const UP = new THREE.Vector3(0, 1, 0);
const _pm = createPersonMatrices();
const _dm = createDogMatrices();
const _dogLying = new THREE.Matrix4();
const _joints = createPoseJoints();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _body = new THREE.Color();
const _head = new THREE.Color();
const _neutralHead = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** L'opacità per istanza: un attributo `instanceFade` della geometria, che
 *  moltiplica l'alfa del colore. La chiave del programma è esplicita, una
 *  per materiale: quella di default è il testo di onBeforeCompile, uguale per
 *  tutti, e three potrebbe riusare un programma compilato per un altro. */
function withInstanceFade<M extends THREE.Material>(material: M, cacheKey: string): M {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float instanceFade;\nvarying float vInstanceFade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvInstanceFade = instanceFade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vInstanceFade;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.a *= vInstanceFade;');
  };
  material.customProgramCacheKey = () => cacheKey;
  return material;
}

/** Un tipo di parte degli attori: un InstancedMesh dinamico, riscritto a ogni
 *  frame da begin/push/end. Le trappole di InstancedPart valgono anche qui
 *  (frustumCulled spento, instanceColor prima del primo render, count
 *  esatto), più DynamicDrawUsage e, per chi svanisce, l'attributo
 *  `instanceFade` e il gemello della profondità che condivide geometria e
 *  matrici. */
class DynamicPart {
  private readonly group: THREE.Group;
  private readonly base: THREE.BufferGeometry;
  private readonly material: THREE.Material;
  private readonly depthMaterial: THREE.Material | null;
  private readonly fading: boolean;
  private readonly colored: boolean;
  private readonly renderOrder: number;
  private capacity = 0;
  private geometry: THREE.BufferGeometry | null = null;
  private mesh: THREE.InstancedMesh | null = null;
  private depth: THREE.InstancedMesh | null = null;
  private matrices: Float32Array = new Float32Array(0);
  private colors: Float32Array | null = null;
  private fades: Float32Array | null = null;
  private fadeAttribute: THREE.InstancedBufferAttribute | null = null;
  private n = 0;

  /** `fading`: con l'opacità per istanza (una copia della geometria che porta
   *  l'attributo); `depthMaterial`: il gemello della profondità, o null. */
  constructor(
    group: THREE.Group,
    base: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    options: { fading: boolean; colored: boolean; depthMaterial?: THREE.Material | null; renderOrder?: number },
  ) {
    this.group = group;
    this.base = base;
    this.material = material;
    this.depthMaterial = options.depthMaterial ?? null;
    this.fading = options.fading;
    this.colored = options.colored;
    this.renderOrder = options.renderOrder ?? 0;
    this.build(Math.max(1, Math.ceil(capacity)), 0);
  }

  /** Rifà mesh e attributi a `capacity`, tenendo le prime `keep` istanze già
   *  scritte in questo frame. Solo alla nascita e quando la capienza non
   *  basta: una volta ogni tanto, mai a ogni frame. */
  private build(capacity: number, keep: number): void {
    const geometry = this.fading ? this.base.clone() : this.base;
    const matrices = new Float32Array(capacity * 16);
    const colors = this.colored ? new Float32Array(capacity * 3) : null;
    const fades = this.fading ? new Float32Array(capacity) : null;
    if (keep > 0) {
      matrices.set(this.matrices.subarray(0, keep * 16));
      if (colors && this.colors) colors.set(this.colors.subarray(0, keep * 3));
      if (fades && this.fades) fades.set(this.fades.subarray(0, keep));
    }

    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(matrices, 16).setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = colors ? new THREE.InstancedBufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage) : null;
    const fadeAttribute = fades ? new THREE.InstancedBufferAttribute(fades, 1).setUsage(THREE.DynamicDrawUsage) : null;
    if (fadeAttribute) geometry.setAttribute('instanceFade', fadeAttribute);
    mesh.frustumCulled = false;
    mesh.renderOrder = this.renderOrder;
    mesh.count = 0;
    mesh.visible = false;

    let depth: THREE.InstancedMesh | null = null;
    if (this.depthMaterial) {
      depth = new THREE.InstancedMesh(geometry, this.depthMaterial, capacity);
      // Le stesse matrici e gli stessi colori, gli stessi buffer: si caricano
      // una volta per frame, e lo shader di vertice è lo stesso del colore
      // (stessi define), così la profondità torna uguale al bit.
      depth.instanceMatrix = mesh.instanceMatrix;
      depth.instanceColor = mesh.instanceColor;
      depth.frustumCulled = false;
      depth.renderOrder = DEPTH_RENDER_ORDER;
      depth.count = 0;
      depth.visible = false;
    }

    this.release();
    this.capacity = capacity;
    this.geometry = geometry;
    this.mesh = mesh;
    this.depth = depth;
    this.matrices = matrices;
    this.colors = colors;
    this.fades = fades;
    this.fadeAttribute = fadeAttribute;
    this.group.add(mesh);
    if (depth) this.group.add(depth);
  }

  private release(): void {
    if (this.depth) {
      this.group.remove(this.depth);
      // Matrici e colori sono del mesh principale: li libera lui (due
      // dispose sullo stesso attributo non fanno danni).
      this.depth.dispose();
    }
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.dispose();
    }
    if (this.fading && this.geometry) this.geometry.dispose();
    this.depth = null;
    this.mesh = null;
    this.geometry = null;
  }

  begin(): void {
    this.n = 0;
  }

  push(m: THREE.Matrix4, color: THREE.Color, fade: number): void {
    if (this.n >= this.capacity) this.build(this.capacity * 2, this.n);
    const i = this.n++;
    m.toArray(this.matrices, i * 16);
    if (this.colors) color.toArray(this.colors, i * 3);
    if (this.fades) this.fades[i] = fade;
  }

  end(): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const n = this.n;
    mesh.count = n;
    mesh.visible = n > 0;
    if (this.depth) {
      this.depth.count = n;
      this.depth.visible = n > 0;
    }
    if (n === 0) return;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (this.fadeAttribute) this.fadeAttribute.needsUpdate = true;
  }

  dispose(): void {
    this.release();
  }
}

/** Le parti di uno dei due gruppi (opaco, o di chi svanisce). */
interface Layer {
  torso: DynamicPart;
  head: DynamicPart;
  thigh: DynamicPart;
  shin: DynamicPart;
  upperArm: DynamicPart;
  forearm: DynamicPart;
  bun: DynamicPart;
  apron: DynamicPart;
  tray: DynamicPart;
  dogBody: DynamicPart;
  dogLeg: DynamicPart;
  dog: DynamicPart;
  all: DynamicPart[];
}

type Geometries = ReturnType<typeof createFigureGeometries>;

function createLayer(group: THREE.Group, geo: Geometries, material: THREE.Material, depthMaterial: THREE.Material | null, fading: boolean): Layer {
  const options = { fading, colored: true, depthMaterial, renderOrder: fading ? FADING_RENDER_ORDER : 0 };
  const part = (g: THREE.BufferGeometry, capacity: number) => new DynamicPart(group, g, material, capacity, options);
  const layer = {
    torso: part(geo.torso, PEOPLE_CAPACITY),
    head: part(geo.head, PEOPLE_CAPACITY),
    thigh: part(geo.thigh, PEOPLE_CAPACITY * 2),
    shin: part(geo.shin, PEOPLE_CAPACITY * 2),
    upperArm: part(geo.upperArm, PEOPLE_CAPACITY * 2),
    forearm: part(geo.forearm, PEOPLE_CAPACITY * 2),
    bun: part(geo.bun, 4),
    apron: part(geo.apron, STAFF_CAPACITY),
    tray: part(geo.tray, STAFF_CAPACITY),
    dogBody: part(geo.dogBody, DOG_CAPACITY),
    dogLeg: part(geo.dogLeg, DOG_CAPACITY * 4),
    dog: part(geo.dog, DOG_CAPACITY),
  };
  return { ...layer, all: Object.values(layer) };
}

/* ── Le pastiglie dei nomi ──────────────────────────────────────────────── */

interface LabelLook {
  surface: string;
  stroke: string;
  text: string;
  fontFamily: string;
  controlRadiusPx: number;
}

interface LabelSlot {
  key: string;
  text: string;
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  /** Larghezza su altezza del canvas: lo sprite la segue. */
  aspect: number;
  /** La versione dell'aspetto (tema, font) con cui è disegnata. */
  drawn: number;
  /** Il frame in cui l'attore c'era ancora. */
  seen: number;
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

/** Disegna il nome nella pastiglia, rifacendo canvas e texture alla
 *  larghezza giusta (con WebGL2 three alloca la texture immutabile alla prima
 *  salita: un canvas più largo non ci entrerebbe). */
function drawLabel(slot: LabelSlot, look: LabelLook): void {
  const font = `500 ${LABEL_FONT_PX}px ${look.fontFamily}`;
  const probe = slot.canvas.getContext('2d');
  if (!probe) return;
  probe.font = font;
  const maxText = LABEL_MAX_TEX_W - 2 * LABEL_PAD_X - 2 * LABEL_BORDER_PX;
  let text = slot.text;
  let width = probe.measureText(text).width;
  if (width > maxText) {
    // Tagliato coi puntini, per caratteri interi.
    const chars = Array.from(text);
    while (chars.length > 1 && probe.measureText(`${chars.join('').trimEnd()}…`).width > maxText) chars.pop();
    text = `${chars.join('').trimEnd()}…`;
    width = probe.measureText(text).width;
  }
  const pillW = Math.max(LABEL_PILL_H, Math.ceil(width + 2 * LABEL_PAD_X));
  const texW = Math.min(LABEL_MAX_TEX_W, pillW + 2 * LABEL_BORDER_PX);
  if (slot.canvas.width !== texW) {
    slot.canvas.width = texW;
    slot.canvas.height = LABEL_TEX_H;
    slot.texture.dispose();
    slot.texture = labelTexture(slot.canvas);
    slot.material.map = slot.texture;
  }
  const ctx = slot.canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, texW, LABEL_TEX_H);
  const x = (texW - pillW) / 2;
  const y = (LABEL_TEX_H - LABEL_PILL_H) / 2;
  const radius = look.controlRadiusPx >= LABEL_PILL_H ? LABEL_PILL_H / 2 : (look.controlRadiusPx * LABEL_PILL_H) / NOMINAL_CHIP_PX;
  roundRectPath(ctx, x, y, pillW, LABEL_PILL_H, radius);
  ctx.fillStyle = look.surface;
  ctx.fill();
  ctx.lineWidth = LABEL_BORDER_PX;
  ctx.strokeStyle = look.stroke;
  ctx.stroke();
  ctx.font = font;
  ctx.fillStyle = look.text;
  ctx.textAlign = 'center';
  // Centrato sull'inchiostro vero, come le etichette dei tavoli.
  const m = ctx.measureText(text);
  const ascent = m.actualBoundingBoxAscent;
  const descent = m.actualBoundingBoxDescent;
  if (Number.isFinite(ascent) && Number.isFinite(descent) && ascent + descent > 0) {
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, texW / 2, LABEL_TEX_H / 2 + (ascent - descent) / 2);
  } else {
    ctx.textBaseline = 'middle';
    ctx.fillText(text, texW / 2, LABEL_TEX_H / 2);
  }
  slot.aspect = texW / LABEL_TEX_H;
  slot.texture.needsUpdate = true;
}

function labelTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Alfa premoltiplicata e fusione ONE / ONE_MINUS_SRC_ALPHA, come le
  // etichette dei tavoli: niente alone scuro attorno alla pastiglia.
  texture.premultiplyAlpha = true;
  return texture;
}

class StaffLabels {
  private readonly group: THREE.Group;
  private readonly slots: LabelSlot[] = [];
  private frame = 0;
  /** Cresce quando cambiano tema o font: le pastiglie si ridisegnano. */
  version = 0;

  constructor(group: THREE.Group) {
    this.group = group;
  }

  begin(): void {
    this.frame++;
  }

  /** Il nome di un attore in questo frame: creato la prima volta (e quando
   *  il testo cambia), poi solo spostato. */
  place(key: string, text: string, x: number, y: number, z: number, fade: number, look: LabelLook): void {
    let slot: LabelSlot | null = null;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].key === key) {
        slot = this.slots[i];
        break;
      }
    }
    if (slot && slot.text !== text) {
      this.remove(slot);
      slot = null;
    }
    if (!slot) slot = this.create(key, text);
    if (slot.drawn !== this.version) {
      drawLabel(slot, look);
      slot.drawn = this.version;
    }
    slot.seen = this.frame;
    slot.sprite.position.set(x, y, z);
    // Con la fusione premoltiplicata l'opacità va anche sul colore.
    slot.material.color.setScalar(fade);
    slot.material.opacity = fade;
    // A opacità quasi zero resta, nascosta: tornerà fra poco, e rifarla
    // vorrebbe dire un canvas e una texture nuovi.
    slot.sprite.visible = fade > FADE_HIDDEN;
  }

  private create(key: string, text: string): LabelSlot {
    const canvas = document.createElement('canvas');
    canvas.width = LABEL_TEX_H;
    canvas.height = LABEL_TEX_H;
    const texture = labelTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = LABEL_RENDER_ORDER;
    sprite.visible = false;
    const slot: LabelSlot = { key, text, sprite, material, texture, canvas, aspect: 1, drawn: -1, seen: this.frame };
    this.slots.push(slot);
    this.group.add(sprite);
    return slot;
  }

  private remove(slot: LabelSlot): void {
    const i = this.slots.indexOf(slot);
    if (i >= 0) {
      this.slots[i] = this.slots[this.slots.length - 1];
      this.slots.pop();
    }
    this.group.remove(slot.sprite);
    slot.material.dispose();
    slot.texture.dispose();
    // Safari ha un tetto alla memoria dei canvas: a 0 × 0 la libera subito.
    slot.canvas.width = 0;
    slot.canvas.height = 0;
  }

  /** Via chi non c'era in questo frame; le altre alla loro misura a schermo:
   *  0,30 m, almeno 22 px, fino al doppio. */
  end(camera: THREE.Camera, viewH: number): void {
    for (let i = this.slots.length - 1; i >= 0; i--) {
      if (this.slots[i].seen !== this.frame) this.remove(this.slots[i]);
    }
    const cam = camera as THREE.PerspectiveCamera;
    const perPx = cam.isPerspectiveCamera && viewH > 0 ? (2 * Math.tan((cam.fov * Math.PI) / 360)) / viewH : 0;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const d = perPx > 0 ? cam.position.distanceTo(slot.sprite.position) : 0;
      const h = Math.min(LABEL_HEIGHT * LABEL_MAX_GROWTH, Math.max(LABEL_HEIGHT, LABEL_MIN_SCREEN_PX * perPx * d));
      slot.sprite.scale.set(h * slot.aspect, h, 1);
    }
  }

  dispose(): void {
    for (let i = this.slots.length - 1; i >= 0; i--) this.remove(this.slots[i]);
  }
}

/* ── Il gruppo degli attori ─────────────────────────────────────────────── */

interface WalkerSet {
  opaque: Layer;
  fading: Layer;
  shadow: DynamicPart;
  shadowMaterial: THREE.Material;
  labels: StaffLabels;
  dispose: () => void;
}

function createWalkerSet(group: THREE.Group, blobShadow: THREE.Material): WalkerSet {
  const geo = createFigureGeometries();
  // Bianco: il colore è quello dell'istanza, il token del ruolo (theme.ts).
  const opaqueMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
  // Chi svanisce: il colore solo dove la profondità è quella del gemello
  // (EqualDepth), cioè sulla superficie più vicina di ogni figura.
  const fadingMaterial = withInstanceFade(
    new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, depthWrite: false, depthFunc: THREE.EqualDepth }),
    'sala-walkers-fade',
  );
  // Il gemello: lo stesso materiale, solo profondità. Lambert anche lui e non
  // Basic: con lo stesso shader di vertice la profondità del colore torna
  // identica, e l'uguaglianza regge senza scarti.
  const depthMaterial = withInstanceFade(new THREE.MeshLambertMaterial({ color: 0xffffff, colorWrite: false }), 'sala-walkers-depth');
  // Le ombre: la stessa macchia di People (alphaMap, colore, opacità del
  // tema), con l'opacità per istanza.
  const shadowMaterial = withInstanceFade(blobShadow.clone(), 'sala-walkers-shadow');
  shadowMaterial.transparent = true;
  shadowMaterial.depthWrite = false;
  const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  const opaque = createLayer(group, geo, opaqueMaterial, null, false);
  const fading = createLayer(group, geo, fadingMaterial, depthMaterial, true);
  const shadow = new DynamicPart(group, plane, shadowMaterial, PEOPLE_CAPACITY + DOG_CAPACITY, { fading: true, colored: false });
  const labels = new StaffLabels(group);
  return {
    opaque,
    fading,
    shadow,
    shadowMaterial,
    labels,
    dispose: () => {
      for (const p of opaque.all) p.dispose();
      for (const p of fading.all) p.dispose();
      shadow.dispose();
      labels.dispose();
      geo.dispose();
      plane.dispose();
      opaqueMaterial.dispose();
      fadingMaterial.dispose();
      depthMaterial.dispose();
      shadowMaterial.dispose();
    },
  };
}

/** Il colore del corpo e della testa di un attore, in _body e _head.
 *  Hostess e camerieri hanno la testa neutra degli ospiti; il ruolo lo dice
 *  il corpo (argilla, o il colore dei bottoni pieni col grembiule). */
function actorColors(a: ActorView, palette: ScenePalette): void {
  if (a.kind === 'hostess') {
    _body.copy(palette.hostess);
    _head.copy(_neutralHead);
    return;
  }
  if (a.kind === 'waiter') {
    _body.copy(palette.waiter);
    _head.copy(_neutralHead);
    return;
  }
  guestBodyColor(palette, finite(a.tint) ? a.tint : 0, _body);
  headColor(palette, _body, _head);
}

/** Scrive tutti gli attori della sala nelle parti. Un passaggio solo, niente
 *  allocazioni: le matrici e i colori nei temporanei di modulo, le istanze
 *  in fila nei buffer già pronti. `tagAlpha` è l'opacità dell'etichetta
 *  della comitiva accompagnata (0 senza): il nome dell'hostess le lascia il
 *  posto. */
function writeActors(set: WalkerSet, actors: readonly ActorView[], palette: ScenePalette, look: LabelLook, blobShadow: THREE.Material, tagAlpha: number): void {
  const { opaque, fading, shadow, labels } = set;
  for (let i = 0; i < opaque.all.length; i++) opaque.all[i].begin();
  for (let i = 0; i < fading.all.length; i++) fading.all[i].begin();
  shadow.begin();
  labels.begin();
  // La macchia segue il tema come quella di People (0,12 chiaro, 0,30 scuro).
  set.shadowMaterial.opacity = blobShadow.opacity;
  headColor(palette, guestBodyColor(palette, 0, _neutralHead), _neutralHead);

  for (let i = 0; i < actors.length; i++) {
    const a = actors[i];
    if (!a || !finite(a.x) || !finite(a.z)) continue;
    const fade = finite(a.fade) ? clamp01(a.fade) : 1;
    if (fade <= FADE_HIDDEN) continue;
    const layer = fade >= 1 ? opaque : fading;
    const yaw = finite(a.yaw) ? a.yaw : 0;
    const seat = finite(a.seat) ? clamp01(a.seat) : 0;
    poseJoints(a, _joints);

    if (a.kind === 'dog') {
      if (_joints.dogLying) {
        composeDogLying(a.x, a.z, yaw, _dogLying);
        layer.dog.push(_dogLying, palette.dog, fade);
      } else {
        composeDogStanding(a.x, a.z, yaw, _joints, _dm);
        layer.dogBody.push(_dm.body, palette.dog, fade);
        for (let l = 0; l < 4; l++) layer.dogLeg.push(_dm.legs[l], palette.dog, fade);
      }
      _q.setFromAxisAngle(UP, yaw);
      _m.compose(_p.set(a.x, SHADOW_Y, a.z), _q, _s.set(DOG_SHADOW_W, 1, DOG_SHADOW_L));
      shadow.push(_m, _white, fade);
      continue;
    }

    const s = figureScale(a.kind);
    composePersonJoints(a.x, a.z, yaw, s, _joints, _pm);
    actorColors(a, palette);
    layer.torso.push(_pm.torso, _body, fade);
    layer.head.push(_pm.head, _head, fade);
    for (let side = 0; side < 2; side++) {
      layer.thigh.push(_pm.thigh[side], _body, fade);
      layer.shin.push(_pm.shin[side], _body, fade);
      layer.upperArm.push(_pm.upperArm[side], _body, fade);
      layer.forearm.push(_pm.forearm[side], _body, fade);
    }
    if (a.kind === 'hostess') layer.bun.push(_pm.bun, _body, fade);
    if (a.kind === 'waiter') {
      // Il grembiule sta col busto: la stessa matrice.
      layer.apron.push(_pm.torso, palette.surface, fade);
      if (_joints.tray) layer.tray.push(_pm.tray, palette.tray, fade);
    }

    // L'ombra di chi sta in piedi, che svanisce mentre si siede (seduto ce
    // l'ha la sedia) e con lui quando svanisce.
    const shade = fade * (1 - seat);
    if (shade > FADE_HIDDEN) {
      const size = STAND_SHADOW * s;
      _q.setFromAxisAngle(UP, yaw);
      _m.compose(_p.set(a.x, SHADOW_Y, a.z), _q, _s.set(size, 1, size));
      shadow.push(_m, _white, shade);
    }

    if (typeof a.label === 'string' && a.label !== '') {
      // Mentre accompagna, l'etichetta della comitiva (NameTag, 0,8 m dietro
      // di lei e un filo più su) coprirebbe il suo nome: il nome si dissolve
      // mentre l'etichetta compare, e torna quando l'etichetta se ne va.
      const shown = a.kind === 'hostess' ? fade * (1 - tagAlpha) : fade;
      labels.place(a.key, a.label, a.x, _joints.hipY + HEAD_CENTRE_Y * s + LABEL_LIFT, a.z, shown, look);
    }
  }

  for (let i = 0; i < opaque.all.length; i++) opaque.all[i].end();
  for (let i = 0; i < fading.all.length; i++) fading.all[i].end();
  shadow.end();
}

/** Il font delle pastiglie è arrivato dopo che si erano disegnate col
 *  ripiego: un numero che cresce, così si ridisegnano. Di solito il font è
 *  già in cache (l'app lo usa ovunque) e non cresce mai. */
function useFontVersion(fontFamily: string): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    const spec = `500 ${LABEL_FONT_PX}px ${fontFamily}`;
    const has = (): boolean => {
      try {
        return !!fonts && typeof fonts.check === 'function' && fonts.check(spec);
      } catch {
        return false;
      }
    };
    if (!fonts || has()) return;
    let alive = true;
    const arrived = () => {
      if (!alive || !has()) return;
      alive = false;
      setVersion((v) => v + 1);
    };
    try {
      if (typeof fonts.load === 'function') fonts.load(spec).then(arrived, () => {});
      fonts.addEventListener?.('loadingdone', arrived);
    } catch {
      /* senza FontFace API resta il ripiego */
    }
    return () => {
      alive = false;
      try {
        fonts.removeEventListener?.('loadingdone', arrived);
      } catch {
        /* niente da staccare */
      }
    };
  }, [fontFamily]);
  return version;
}

/** Due istanti di risveglio uguali, a meno del rumore fra gli orologi. */
const sameWake = (a: number, b: number): boolean => a === b || Math.abs(a - b) <= WAKE_TOLERANCE_MS;

/** Un errore del regista una volta sola in console: a ogni frame
 *  riempirebbe il registro, e il canvas deve continuare a disegnare (un
 *  useFrame che lancia farebbe girare R3F a vuoto, un frame dopo l'altro). */
function reportOnce(reported: { current: boolean }, error: unknown): void {
  if (reported.current) return;
  reported.current = true;
  console.error('Sala dal vivo: il regista non risponde', error);
}

interface WalkersProps {
  director: SceneDirectorApi;
  /** La sala sullo schermo: quella di actorsIn. */
  roomId: number;
  palette: ScenePalette;
  /** Cresce a ogni cambio di tema: le pastiglie dei nomi si ridisegnano. */
  themeVersion: number;
  /** La macchia di People: forma e opacità del tema. */
  shadow: THREE.Material;
  demand: FrameDemand;
}

export function Walkers({ director, roomId, palette, themeVersion, shadow, demand }: WalkersProps) {
  const invalidate = useThree((s) => s.invalidate);
  const [group] = useState(() => new THREE.Group());
  const setRef = useRef<WalkerSet | null>(null);
  const fontVersion = useFontVersion(palette.fontFamily);
  const reported = useRef(false);
  const [look] = useState<LabelLook>(() => ({ surface: '', stroke: '', text: '', fontFamily: '', controlRadiusPx: 9999 }));

  // Nascono e muoiono con l'effetto (StrictMode), come le parti di People.
  useLayoutEffect(() => {
    const set = createWalkerSet(group, shadow);
    setRef.current = set;
    invalidate();
    return () => {
      set.dispose();
      setRef.current = null;
    };
  }, [group, shadow, invalidate]);

  // Tema o font cambiati: le pastiglie si ridisegnano al prossimo frame.
  useLayoutEffect(() => {
    look.surface = palette.surfaceCss;
    look.stroke = palette.borderStrongCss;
    look.text = palette.textSecondaryCss;
    look.fontFamily = palette.fontFamily;
    look.controlRadiusPx = palette.controlRadiusPx;
    const set = setRef.current;
    if (set) set.labels.version++;
    invalidate();
  }, [palette, themeVersion, fontVersion, shadow, look, invalidate]);

  useFrame((state, delta) => {
    if (!director) return;
    // Il passo: il primo di ogni frame (priorità −1). Il regista limita da sé
    // il passo a 100 ms quando qualcosa si muove; da fermi passa tutto il
    // tempo dormito, così i camerieri al pass contano il tempo vero.
    const dtMs = finite(delta) && delta > 0 ? delta * 1000 : 0;
    let actors: readonly ActorView[] = EMPTY;
    let tagAlpha = 0;
    try {
      director.step(dtMs);
      const list = director.actorsIn(roomId);
      if (Array.isArray(list)) actors = list;
      const tag = director.tagIn(roomId);
      if (tag && finite(tag.alpha)) tagAlpha = clamp01(tag.alpha);
    } catch (error) {
      reportOnce(reported, error);
    }
    const set = setRef.current;
    if (set) {
      writeActors(set, actors, palette, look, shadow, tagAlpha);
      set.labels.end(state.camera, state.size.height);
    }

    // Quanti frame servono adesso, per FrameThrottle. Si sveglia il throttle
    // solo se il bisogno è cambiato (un cameriere parte, l'ultimo ospite si
    // siede): a ogni frame lo terrebbe a girare a vuoto.
    let need: FrameNeed = 'none';
    let wakeIn: number | null = null;
    try {
      need = director.frameNeed();
      wakeIn = director.wakeInMs();
    } catch (error) {
      reportOnce(reported, error);
    }
    const wakeAt = motionWakeAtFrom(wakeIn, performance.now());
    const changed = need !== demand.motion || (need === 'none' && !sameWake(wakeAt, demand.motionWakeAt));
    demand.motion = need;
    demand.motionWakeAt = wakeAt;
    if (changed) demand.wake();
  }, -1);

  return <primitive object={group} />;
}
