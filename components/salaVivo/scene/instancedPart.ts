import * as THREE from 'three';

/* Un tipo di pezzo della scena (piani, sedie, gambe delle figure, cartellini…):
 * un InstancedMesh solo, colorato per istanza. Lo usano tavoli, persone e
 * cartellini, così le trappole degli InstancedMesh si evitano in un posto:
 *
 * - frustumCulled = false su ognuno: la boundingSphere si calcola una volta,
 *   alla prima occasione, e non segue né le matrici né `count`. Con la sfera
 *   vecchia un tavolo spostato, o un ospite appena arrivato, sparirebbe ai
 *   bordi dell'inquadratura.
 * - instanceColor creato nel costruttore, PRIMA del primo render: un
 *   materiale compilato senza ignora setColorAt, e i pezzi resterebbero
 *   bianchi.
 * - `count` non può superare la capienza con cui il mesh è nato: se non
 *   basta, il mesh si rifà al doppio (reserve), mai a ogni scrittura.
 */

/** Il margine sulla capienza calcolata dalla sala, e la crescita minima. */
export const CAPACITY_SLACK = 1.25;
const MIN_TABLE_CAPACITY = 8;

/** La capienza di partenza per `n` pezzi contati nella sala: n × 1,25, almeno 8. */
export function slackCapacity(n: number): number {
  return Math.max(MIN_TABLE_CAPACITY, Math.ceil((Number.isFinite(n) ? n : 0) * CAPACITY_SLACK));
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export class InstancedPart {
  mesh: THREE.InstancedMesh;
  private capacity: number;
  private readonly group: THREE.Group;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.Material;
  private readonly colored: boolean;

  /** `capacity` è già quella voluta (vedi slackCapacity): qui si arrotonda
   *  soltanto, e mai sotto 1. */
  constructor(group: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, colored: boolean) {
    this.group = group;
    this.geometry = geometry;
    this.material = material;
    this.colored = colored;
    this.capacity = Math.max(1, Math.ceil(Number.isFinite(capacity) ? capacity : 1));
    this.mesh = this.create(this.capacity);
    group.add(this.mesh);
  }

  private create(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.frustumCulled = false;
    if (this.colored) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.count = 0;
    mesh.visible = false;
    return mesh;
  }

  /** Posto per `count` istanze, rifacendo il mesh al doppio se serve. */
  reserve(count: number): void {
    if (count <= this.capacity) return;
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.capacity = Math.max(Math.ceil(count * CAPACITY_SLACK), this.capacity * 2);
    this.mesh = this.create(this.capacity);
    this.group.add(this.mesh);
  }

  set(i: number, x: number, y: number, z: number, q: THREE.Quaternion, sx: number, sy: number, sz: number, color?: THREE.Color): void {
    _p.set(x, y, z);
    _s.set(sx, sy, sz);
    _m.compose(_p, q, _s);
    this.mesh.setMatrixAt(i, _m);
    if (color && this.colored) this.mesh.setColorAt(i, color);
  }

  /** Una matrice già composta (le parti delle figure). */
  setMatrix(i: number, m: THREE.Matrix4, color?: THREE.Color): void {
    this.mesh.setMatrixAt(i, m);
    if (color && this.colored) this.mesh.setColorAt(i, color);
  }

  /** Solo il colore: il cambio di tema, a matrici ferme. */
  setColor(i: number, color: THREE.Color): void {
    if (this.colored) this.mesh.setColorAt(i, color);
  }

  commit(count: number): void {
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Dopo un giro di soli colori: le matrici non si ricaricano. */
  commitColors(): void {
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.group.remove(this.mesh);
    this.mesh.dispose();
  }
}
