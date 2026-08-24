#!/usr/bin/env node
/**
 * Erzeugt die App-Icons des Portals aus DER Bildmarke, die `public/favicon.svg`
 * schon zeigt: der weisse Blitz auf dem VoltPilot-Verlauf.
 *
 * WARUM ein Generator statt vier von Hand gemalter Dateien: die vier Icons sind
 * dieselbe Marke in drei verschiedenen RAHMEN (abgerundet / vollflaechig /
 * Apple), und genau die Rahmen-Regeln sind das, was man beim Nachmalen falsch
 * macht - vor allem die Safe-Zone eines `maskable`-Icons. Hier stehen sie als
 * Zahlen, sind kommentiert und lassen sich nachrechnen. Der Lauf ist
 * deterministisch (gleiche Eingabe -> byte-gleiche Datei), also ist eine
 * Aenderung im Diff sichtbar statt "irgendein neues Bild".
 *
 * Bewusst OHNE Abhaengigkeit: reines Node (`zlib` aus der Standardbibliothek),
 * kein sharp/canvas/ImageMagick. Der Blitz besteht ausschliesslich aus GERADEN
 * (die Pfaddaten des favicon sind `L`/`h`-Befehle), ein Polygon-Test genuegt
 * also - es braucht keinen SVG-Renderer.
 *
 *   node tools/gen-icons.mjs            # schreibt public/icons/*
 *   node tools/gen-icons.mjs --check    # prueft nur, ob die Dateien aktuell sind
 *
 * Wer die Marke aendert, fuehrt das Skript neu aus UND hebt `SW_VERSION` in
 * `public/sw.js` (die Icons liegen im Vorrat des Service Workers).
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'public', 'icons');

/* -------------------------------------------------------------------------- */
/* Die Marke - Zahlen 1:1 aus public/favicon.svg (viewBox 0 0 64 64)           */
/* -------------------------------------------------------------------------- */

/** Der Verlauf `--vp-grad-hero` aus designsystem/tokens/colors.css. */
const GRADIENT = [
  { t: 0.0, rgb: [0xb8, 0xd4, 0xff] }, // --vp-primary-light
  { t: 0.5, rgb: [0x7b, 0xa3, 0xf7] }, // --vp-primary-dark
  { t: 1.0, rgb: [0x5a, 0x8d, 0xe8] }, // --vp-primary-deep
];

/** Eckenradius der abgerundeten Fassung, in 64er-Einheiten (favicon: rx=14). */
const CORNER = 14 / 64;

/**
 * Der Blitz als Polygon in 64er-Einheiten, aus dem favicon-Pfad
 * `M36.5 10 L20 36.5 h10.5 L27.5 54 L44 27.5 h-10.5 Z` ausgeschrieben.
 * Bounding-Box 24 x 44, mittig auf (32,32) - das ist die Grundlage der
 * Safe-Zone-Rechnung unten.
 */
const BOLT = [
  [36.5, 10],
  [20, 36.5],
  [30.5, 36.5],
  [27.5, 54],
  [44, 27.5],
  [33.5, 27.5],
];

const BOLT_CENTER = [32, 32];

/**
 * Der Blitz-Massstab der `maskable`-Fassung.
 *
 * Die Regel: bei einem maskable-Icon darf die Plattform alles ausserhalb eines
 * KREISES mit 80 % der Kantenlaenge wegschneiden - alles Wesentliche muss also
 * in einen Kreis mit Radius 0,4 * Kantenlaenge um die Mitte passen. Der Blitz
 * misst 24 x 44 (halbe Diagonale sqrt(12^2 + 22^2) = 25,06 in 64er-Einheiten)
 * und passt bei Massstab 1,0 mit 25,06 < 25,6 nur um ein halbes Prozent hinein.
 * 0,85 gibt ihm Luft (halbe Diagonale 21,3) und ist zugleich die Bildwirkung,
 * die ein maskable-Icon haben soll: etwas kleiner als die randlose Fassung.
 */
const MASKABLE_BOLT_SCALE = 0.85;

/* -------------------------------------------------------------------------- */
/* Rasterung                                                                  */
/* -------------------------------------------------------------------------- */

/** Kantenglaettung durch Ueberabtastung: 4x4 Proben je Bildpunkt. */
const SS = 4;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Die Verlaufsfarbe an Position t (0..1) - sRGB-Interpolation wie im Browser. */
function gradientAt(t) {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 1; i < GRADIENT.length; i++) {
    const a = GRADIENT[i - 1];
    const b = GRADIENT[i];
    if (clamped <= b.t) {
      const local = (clamped - a.t) / (b.t - a.t);
      return [
        Math.round(lerp(a.rgb[0], b.rgb[0], local)),
        Math.round(lerp(a.rgb[1], b.rgb[1], local)),
        Math.round(lerp(a.rgb[2], b.rgb[2], local)),
      ];
    }
  }
  return GRADIENT[GRADIENT.length - 1].rgb;
}

/** Liegt (x,y) im Rechteck 0..1 x 0..1 mit Eckenradius r (alles normiert)? */
function insideRoundedUnitSquare(x, y, r) {
  if (x < 0 || y < 0 || x > 1 || y > 1) return false;
  if (r <= 0) return true;
  const cx = x < r ? r : x > 1 - r ? 1 - r : x;
  const cy = y < r ? r : y > 1 - r ? 1 - r : y;
  if (cx === x || cy === y) return true; // Kante, nicht Ecke
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Crossing-number-Test: liegt (x,y) im Polygon? */
function insidePolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function scaledBolt(scale) {
  return BOLT.map(([x, y]) => [
    BOLT_CENTER[0] + (x - BOLT_CENTER[0]) * scale,
    BOLT_CENTER[1] + (y - BOLT_CENTER[1]) * scale,
  ]);
}

/**
 * Zeichnet ein Icon.
 *
 * @param size    Kantenlaenge in Bildpunkten
 * @param rounded true = eigene abgerundete Ecken (transparent aussen herum),
 *                false = vollflaechig deckend (maskable / Apple: dort rundet
 *                die PLATTFORM, ein eigener Radius wuerde doppelt beschnitten)
 * @param scale   Massstab des Blitzes
 */
function drawIcon(size, rounded, scale) {
  const bolt = scaledBolt(scale);
  const px = Buffer.alloc(size * size * 4);
  const step = 1 / SS;
  const half = step / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let boltHits = 0;
      let gradSum = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Probenmitte in Bildpunkt-Koordinaten, dann normiert auf 0..1.
          const fx = (x + sx * step + half) / size;
          const fy = (y + sy * step + half) / size;
          const inBg = rounded ? insideRoundedUnitSquare(fx, fy, CORNER) : true;
          if (!inBg) continue;
          bgHits++;
          gradSum += (fx + fy) / 2; // Verlauf 135deg: von (0,0) nach (1,1)
          if (insidePolygon(bolt, fx * 64, fy * 64)) boltHits++;
        }
      }
      const total = SS * SS;
      const o = (y * size + x) * 4;
      if (bgHits === 0) {
        px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0;
        continue;
      }
      const [gr, gg, gb] = gradientAt(gradSum / bgHits);
      // Der Blitz ist weiss; sein Deckungsgrad mischt ihn ueber den Verlauf.
      const boltCover = boltHits / bgHits;
      px[o] = Math.round(lerp(gr, 255, boltCover));
      px[o + 1] = Math.round(lerp(gg, 255, boltCover));
      px[o + 2] = Math.round(lerp(gb, 255, boltCover));
      px[o + 3] = Math.round((bgHits / total) * 255);
    }
  }
  return px;
}

/* -------------------------------------------------------------------------- */
/* PNG-Kodierung (8 Bit RGBA, nicht verschraenkt)                             */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 6; // Farbtyp RGBA
  // 10..12: Kompression 0, Filter 0, Interlace 0 (Buffer.alloc ist genullt)
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // Filtertyp "None" - reproduzierbar
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */

/** Die vier ausgelieferten Dateien - jede mit ihrem Rahmen-Grund. */
const ICONS = [
  // Startbildschirm/Task-Umschalter: eigene Rundung wie das favicon.
  { file: 'icon-192.png', size: 192, rounded: true, scale: 1 },
  { file: 'icon-512.png', size: 512, rounded: true, scale: 1 },
  // maskable: vollflaechig, Blitz in der Safe-Zone (siehe MASKABLE_BOLT_SCALE).
  { file: 'icon-maskable-512.png', size: 512, rounded: false, scale: MASKABLE_BOLT_SCALE },
  // Apple rundet selbst und kennt keine Transparenz: deckendes Quadrat.
  { file: 'apple-touch-icon-180.png', size: 180, rounded: false, scale: 1 },
];

const check = process.argv.includes('--check');
mkdirSync(OUT_DIR, { recursive: true });
let drift = 0;
for (const icon of ICONS) {
  const png = encodePng(icon.size, drawIcon(icon.size, icon.rounded, icon.scale));
  const path = join(OUT_DIR, icon.file);
  if (check) {
    const same = existsSync(path) && readFileSync(path).equals(png);
    if (!same) {
      console.error(`DRIFT: ${icon.file} entspricht nicht dem Generator`);
      drift++;
    }
    continue;
  }
  writeFileSync(path, png);
  console.log(`${icon.file}  ${icon.size}x${icon.size}  ${png.length} B`);
}
if (check) {
  if (drift > 0) {
    console.error('Bitte `node tools/gen-icons.mjs` ausfuehren.');
    process.exit(1);
  }
  console.log('Icons sind aktuell.');
}
