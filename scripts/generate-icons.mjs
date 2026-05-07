// One-shot generator for PWA / push notification icons.
// Renders the lucide-react ChefHat glyph (current brand mark) on a dark
// rounded square at 192x192 and 512x512.

import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'public');

const BG = '#0f172a';      // slate-900, matches manifest theme_color
const FG = '#ffffff';

const buildSvg = (size) => {
    const radius = Math.round(size * 0.18);
    const stroke = Math.max(2, Math.round(size * 0.045));
    const iconSize = Math.round(size * 0.55);
    const offset = Math.round((size - iconSize) / 2);
    const scale = iconSize / 24;
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${BG}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="${FG}" stroke-width="${(stroke / scale).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z"/>
    <path d="M6 17h12"/>
  </g>
</svg>`;
};

const sizes = [192, 512];
for (const size of sizes) {
    const svg = buildSvg(size);
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    const outPath = resolve(outDir, `icon-${size}.png`);
    writeFileSync(outPath, buf);
    console.log(`Generated ${outPath} (${buf.byteLength} bytes)`);
}
