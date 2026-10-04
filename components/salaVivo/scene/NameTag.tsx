import { useEffect, useState, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { ActorTag, SceneDirectorApi } from '../types';

/* L'etichetta della comitiva accompagnata: «Tavolo 40 · 4 (2 bambini) +
 * cane», o il nome della comitiva a nomi accesi (il testo lo compone la
 * pagina, già tradotto: qui niente i18n, e a nomi spenti nessun nome arriva).
 *
 * UN elemento DOM sopra il canvas, non uno sprite: è testo dell'app, nel
 * font e nei token dell'app, nitido a ogni DPR. Lo disegna SalaVivoCanvas
 * accanto al <Canvas>; qui lo si sposta a ogni frame disegnato, proiettando
 * il punto sopra la testa di chi segue l'hostess (director.tagIn, che lo
 * tiene da quando entra dalla porta a quando i suoi vanno alle sedie). Solo
 * transform, opacità e, quando cambia comitiva o testo, textContent: niente
 * render di React a ogni frame, e niente scrittura sul DOM se non cambia
 * niente.
 *
 * Nascosta senza accompagnamento, e col movimento ridotto: lì il regista
 * mette tutti al loro posto senza camminare, e un'etichetta che salta da
 * una porta a un tavolo non direbbe niente. */

/** Mezzo pixel: sotto, spostare l'etichetta non si vede e costa una
 *  scrittura sul DOM. */
const SNAP_PX = 0.5;

const _v = new THREE.Vector3();
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

interface NameTagProps {
  director: SceneDirectorApi;
  /** La sala sullo schermo: quella di tagIn. */
  roomId: number;
  /** Il testo per id della prenotazione, dalla pagina. */
  partyTags: ReadonlyMap<number, string>;
  /** L'elemento che SalaVivoCanvas tiene accanto al <Canvas>. */
  targetRef: RefObject<HTMLDivElement | null>;
  /** prefers-reduced-motion: niente etichetta. */
  reducedMotion?: boolean;
}

interface TagState {
  /** Quello che c'è scritto nell'elemento adesso. */
  text: string;
  /** La posizione e l'opacità scritte per ultime (NaN / −1: niente ancora). */
  x: number;
  y: number;
  alpha: number;
}

/** Nasconde l'etichetta, se non lo è già. */
function hide(el: HTMLDivElement, state: TagState): void {
  if (state.alpha === 0) return;
  el.style.opacity = '0';
  state.alpha = 0;
}

export function NameTag({ director, roomId, partyTags, targetRef, reducedMotion = false }: NameTagProps): null {
  const [state] = useState<TagState>(() => ({ text: '', x: NaN, y: NaN, alpha: -1 }));

  // Smontata (un'altra sala senza canvas, il canvas che si rifà): nascosta,
  // così non resta ferma dov'era.
  useEffect(() => {
    const el = targetRef.current;
    return () => {
      if (el) hide(el, state);
    };
  }, [targetRef, state]);

  // Priorità 0, dopo CameraRig nell'ordine dei componenti: la proiezione usa
  // la camera di questo frame, non quella del precedente (l'etichetta
  // resterebbe indietro mentre si trascina la sala).
  useFrame(({ camera, size }) => {
    const el = targetRef.current;
    if (!el) return;
    let tag: ActorTag | null = null;
    if (!reducedMotion && director) {
      try {
        tag = director.tagIn(roomId);
      } catch {
        tag = null;
      }
    }
    const text = tag ? partyTags?.get(tag.partyId) : undefined;
    if (!tag || !text || !finite(tag.x) || !finite(tag.y) || !finite(tag.z) || !(size.width > 0) || !(size.height > 0)) {
      hide(el, state);
      return;
    }
    camera.updateMatrixWorld();
    _v.set(tag.x, tag.y, tag.z).project(camera);
    // Dietro la camera o fuori dal volume visto: niente etichetta.
    if (!(_v.z > -1 && _v.z < 1)) {
      hide(el, state);
      return;
    }
    if (text !== state.text) {
      el.textContent = text;
      state.text = text;
    }
    const x = Math.round(((_v.x + 1) / 2) * size.width / SNAP_PX) * SNAP_PX;
    const y = Math.round(((1 - _v.y) / 2) * size.height / SNAP_PX) * SNAP_PX;
    if (x !== state.x || y !== state.y) {
      // Ancorata col centro in basso sopra la testa.
      el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
      state.x = x;
      state.y = y;
    }
    const alpha = Math.round(Math.min(1, Math.max(0, finite(tag.alpha) ? tag.alpha : 1)) * 100) / 100;
    if (alpha !== state.alpha) {
      el.style.opacity = String(alpha);
      state.alpha = alpha;
    }
  });

  return null;
}
