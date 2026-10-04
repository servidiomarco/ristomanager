import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/* I confini della Sala dal vivo: chi può importare three, e chi no.
 *
 * three e la scena (circa 250 KB gzip) stanno in chunk caricati a richiesta:
 * App carica la pagina con React.lazy, la pagina carica il canvas solo dopo
 * la sonda WebGL2. Basta un import statico nel posto sbagliato perché il 3D
 * finisca nel bundle che ogni palmare e ogni schermo di cucina scarica, e la
 * build non se ne accorge: compila benissimo. Se ne accorge questo test,
 * leggendo i sorgenti.
 *
 * - Pagina, contratto dei tipi, modello e i tre hook della pagina: mai three,
 *   @react-three/* o la scena, nemmeno come tipi (il contratto lo promette).
 * - La pagina raggiunge il canvas solo con import('./SalaVivoCanvas').
 * - App raggiunge la pagina solo con import('./components/salaVivo/SalaVivoPage'),
 *   e non tocca three, la scena o il canvas.
 * Un `import type` verso la pagina o il canvas è ammesso: sparisce dalla
 * build e non tira dietro niente. */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const at = (p: string) => join(ROOT, p);
const PAGE = 'components/salaVivo/SalaVivoPage.tsx';
const MODEL_DIR = 'components/salaVivo/model';
const SCENE_DIR = 'components/salaVivo/scene';

// I file di una cartella, sottocartelle comprese.
const filesUnder = (dir: string): string[] =>
  readdirSync(at(dir)).flatMap(name => {
    const rel = `${dir}/${name}`;
    return statSync(at(rel)).isDirectory() ? filesUnder(rel) : /\.tsx?$/.test(name) ? [rel] : [];
  });

interface ImportRef {
  /** Lo specificatore, così com'è scritto. */
  spec: string;
  /** import(...) a richiesta. */
  dynamic: boolean;
  /** `import type` / `export type`: sparisce dalla build. */
  typeOnly: boolean;
}

// Gli import di un sorgente: statici (import … from, import '…', export …
// from), anche su più righe, e dinamici (import('…')).
const importsOf = (source: string): ImportRef[] => {
  const refs: ImportRef[] = [];
  const statico = /(?:^|[;\n}])\s*(import|export)\s+(type\s+)?(?:[\w*{}\s,$]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(statico)) {
    refs.push({ spec: m[3], dynamic: false, typeOnly: !!m[2] });
  }
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    refs.push({ spec: m[1], dynamic: true, typeOnly: false });
  }
  return refs;
};

const isThree = (spec: string) => spec === 'three' || spec.startsWith('three/') || spec.startsWith('@react-three/');
// './scene', '../scene/…' dal modello; '../components/salaVivo/scene/…' da un hook.
const isScene = (spec: string) => /(?:^\.{1,2}\/|\/salaVivo\/)scene(?:\/|$)/.test(spec);
const isCanvas = (spec: string) => /(?:^|\/)SalaVivoCanvas(?:\.tsx?)?$/.test(spec);

// Il file che un import relativo raggiunge, o null (un pacchetto, un file che
// non è codice). Senza estensione come nel frontend, o col .js che i file
// condivisi col server scrivono al posto del .ts.
const resolveLocal = (fromFile: string, spec: string): string | null => {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(at(fromFile)), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  const hit = candidates.find(p => /\.tsx?$/.test(p) && existsSync(p) && statSync(p).isFile());
  return hit ? relative(ROOT, hit).split(sep).join('/') : null;
};

/** Tutto quello che finisce nello stesso chunk di `entry`: gli import statici
 *  seguiti a catena. Gli import dinamici sono chunk a parte (è il punto), e
 *  quelli di soli tipi spariscono dalla build. */
const staticClosure = (entry: string) => {
  const files = new Set<string>([entry]);
  const queue = [entry];
  const edges: Array<{ from: string; spec: string; file: string | null }> = [];
  while (queue.length > 0) {
    const from = queue.shift()!;
    for (const ref of importsOf(readFileSync(at(from), 'utf8'))) {
      if (ref.dynamic || ref.typeOnly) continue;
      const file = resolveLocal(from, ref.spec);
      edges.push({ from, spec: ref.spec, file });
      if (file && !files.has(file)) {
        files.add(file);
        queue.push(file);
      }
    }
  }
  return { files, edges };
};

// Un arco che porterebbe il 3D nel chunk: three, la scena o il canvas.
const pullsIn3d = (e: { spec: string; file: string | null }) =>
  isThree(e.spec)
  || (e.file !== null && (e.file.startsWith('components/salaVivo/scene/') || /^components\/salaVivo\/SalaVivoCanvas\.tsx?$/.test(e.file)));

const PURE_FILES = (): string[] => [
  'components/salaVivo/types.ts',
  ...filesUnder(MODEL_DIR),
  'hooks/useServiceOverrides.ts',
  'hooks/usePrefersReducedMotion.ts',
  'hooks/useWakeLock.ts',
  ...(existsSync(at(PAGE)) ? [PAGE] : []),
];

describe('il lettore degli import', () => {
  // Il test è utile quanto il suo lettore: qui si controlla che veda le forme
  // che un import può prendere, e che non veda quello che non è un import.
  it('vede import statici, su più righe, di soli tipi, export … from e dinamici', () => {
    const src = [
      "import * as THREE from 'three';",
      'import {',
      '  Canvas,',
      "} from '@react-three/fiber';",
      "import type { Mesh } from 'three';",
      "import './scene/theme';",
      "export { RoomShell } from './scene/RoomShell';",
      "const Canvas3D = React.lazy(() => import('./SalaVivoCanvas'));",
      "// un commento che parla di three senza importarlo",
      "const s = 'from three';",
    ].join('\n');
    expect(importsOf(src)).toEqual([
      { spec: 'three', dynamic: false, typeOnly: false },
      { spec: '@react-three/fiber', dynamic: false, typeOnly: false },
      { spec: 'three', dynamic: false, typeOnly: true },
      { spec: './scene/theme', dynamic: false, typeOnly: false },
      { spec: './scene/RoomShell', dynamic: false, typeOnly: false },
      { spec: './SalaVivoCanvas', dynamic: true, typeOnly: false },
    ]);
    expect(isThree('three/addons/controls/MapControls.js')).toBe(true);
    expect(isThree('threejs-helper')).toBe(false);
    expect(isScene('../scene')).toBe(true);
    expect(isScene('./scene/TablesLayer')).toBe(true);
    expect(isScene('../components/salaVivo/scene/theme')).toBe(true);
    expect(isScene('./sceneModel')).toBe(false);
    expect(isScene('../model/sceneModel')).toBe(false);
    expect(isCanvas('./SalaVivoCanvas')).toBe(true);
    expect(isCanvas('../components/salaVivo/SalaVivoCanvas.tsx')).toBe(true);
    expect(isCanvas('./SalaVivoCanvasProps')).toBe(false);
  });
});

describe('i confini del 3D', () => {
  it('il modello c\'è e il lettore ne vede gli import', () => {
    const model = filesUnder(MODEL_DIR);
    expect(model.length).toBeGreaterThanOrEqual(5);
    const sceneModel = readFileSync(at(`${MODEL_DIR}/sceneModel.ts`), 'utf8');
    expect(importsOf(sceneModel).map(r => r.spec)).toContain('./geometry');
  });

  it('pagina, tipi, modello e hook della pagina non importano mai three, la scena o il canvas', () => {
    const violazioni: string[] = [];
    for (const file of PURE_FILES()) {
      for (const ref of importsOf(readFileSync(at(file), 'utf8'))) {
        const canvasStatico = isCanvas(ref.spec) && !ref.dynamic && !ref.typeOnly;
        if (isThree(ref.spec) || isScene(ref.spec) || canvasStatico) violazioni.push(`${file} → ${ref.spec}`);
      }
    }
    expect(violazioni).toEqual([]);
  });

  it.skipIf(!existsSync(at(PAGE)))('la pagina raggiunge il canvas solo a richiesta', () => {
    const refs = importsOf(readFileSync(at(PAGE), 'utf8')).filter(r => isCanvas(r.spec) && !r.typeOnly);
    expect(refs.filter(r => !r.dynamic).map(r => r.spec)).toEqual([]);
    // E lo carica davvero: un canvas mai importato sarebbe una pagina vuota.
    expect(refs.some(r => r.dynamic)).toBe(true);
  });

  it('App raggiunge la pagina solo a richiesta, e non tocca three, la scena o il canvas', () => {
    const refs = importsOf(readFileSync(at('App.tsx'), 'utf8'));
    const violazioni = refs
      .filter(r => !r.typeOnly)
      .filter(r =>
        isThree(r.spec)
        || isScene(r.spec)
        || isCanvas(r.spec)
        || (!r.dynamic && /^\.\/components\/salaVivo\/SalaVivoPage(?:\.tsx?)?$/.test(r.spec)))
      .map(r => r.spec);
    expect(violazioni).toEqual([]);
  });

  it('i file controllati esistono (un percorso sbagliato non deve far passare il test)', () => {
    for (const file of PURE_FILES()) expect(existsSync(at(file)), relative(ROOT, at(file))).toBe(true);
  });
});

describe('i confini del 3D, seguendo gli import a catena', () => {
  // Il controllo file per file non vede un modulo nuovo che la pagina importa
  // (una sonda, un helper) e che a sua volta importa la scena: qui si segue
  // tutto quello che finisce nel chunk.
  it('il risolutore trova i moduli, anche col .js dei file condivisi', () => {
    expect(resolveLocal(`${MODEL_DIR}/sceneModel.ts`, './geometry')).toBe(`${MODEL_DIR}/geometry.ts`);
    expect(resolveLocal(`${MODEL_DIR}/tableStatus.ts`, '../../reservationState')).toBe('components/reservationState.tsx');
    expect(resolveLocal('hooks/useServiceOverrides.ts', '../components/salaVivo/types')).toBe('components/salaVivo/types.ts');
    expect(resolveLocal('App.tsx', 'react')).toBeNull();
    const { files } = staticClosure(`${MODEL_DIR}/sceneModel.ts`);
    expect(files.has('utils/tableGeometry.ts')).toBe(true);
    expect(files.has('types.ts')).toBe(true);
  });

  it.skipIf(!existsSync(at(SCENE_DIR)))('controprova: dalla scena il controllo arriva davvero a three', () => {
    // Se il lettore o il risolutore smettessero di vedere gli import, i due
    // controlli qui sotto passerebbero sempre: questo no.
    expect(filesUnder(SCENE_DIR).some(f => staticClosure(f).edges.some(pullsIn3d))).toBe(true);
  });

  it.skipIf(!existsSync(at(PAGE)))('il chunk della pagina non arriva mai a three, alla scena o al canvas', () => {
    const { edges } = staticClosure(PAGE);
    expect(edges.filter(pullsIn3d).map(e => `${e.from} → ${e.spec}`)).toEqual([]);
  });

  it('il bundle principale non arriva mai alla pagina né al 3D', () => {
    const { files, edges } = staticClosure('App.tsx');
    // Un controllo che non legge niente passerebbe sempre: App tira dietro
    // centinaia di moduli.
    expect(files.size).toBeGreaterThan(50);
    expect(files.has(PAGE)).toBe(false);
    expect(edges.filter(pullsIn3d).map(e => `${e.from} → ${e.spec}`)).toEqual([]);
  });
});
