/**
 * QR-Code nach ISO/IEC 18004, nur was die Beschriftung einer Box braucht: Byte-Modus, Fassung 1 bis 10,
 * Fehlerkorrektur L oder M, Maske nach den Strafpunkten des Standards. Ohne fremde Bibliothek, damit das
 * Portal keine Abhängigkeit für eine Vorschau mitschleppt.
 *
 * Die Matrizen sind gegen `qrcode` (Python) geprüft: `qrCode.test.ts` liest `qrCode.vektoren.json`.
 * Der Aufbau folgt dem Standard Schritt für Schritt: Daten in Codewörter, Reed-Solomon je Block,
 * Blöcke verschränkt, Funktionsmuster, Daten im Zickzack, Maske, Formatinformation.
 *
 * Reines Modul: kein React, kein DOM.
 */

export type Fehlerkorrektur = 'L' | 'M';

export interface QrCode {
  fassung: number;
  korrektur: Fehlerkorrektur;
  maske: number;
  /** Kantenlänge in Modulen (17 + 4 × Fassung). */
  groesse: number;
  /** `module[y][x]`: true = dunkel. Ohne Ruhezone. */
  module: boolean[][];
}

const HOECHSTE_FASSUNG = 10;

// Je Fassung (Index 1 bis 10): Prüf-Codewörter je Block und Zahl der Blöcke (Tabelle 9 des Standards).
const PRUEF_JE_BLOCK: Record<Fehlerkorrektur, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
};
const BLOECKE: Record<Fehlerkorrektur, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
};
// Die beiden Bits der Formatinformation je Stufe.
const FORMAT_BITS: Record<Fehlerkorrektur, number> = { L: 1, M: 0 };

/** Module für Daten und Prüfung (ohne Funktionsmuster, Format- und Fassungsinformation). */
function rohModule(fassung: number): number {
  let n = (16 * fassung + 128) * fassung + 64;
  if (fassung >= 2) {
    const a = Math.floor(fassung / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (fassung >= 7) n -= 36;
  }
  return n;
}

function datenCodewoerter(fassung: number, k: Fehlerkorrektur): number {
  return Math.floor(rohModule(fassung) / 8) - PRUEF_JE_BLOCK[k][fassung] * BLOECKE[k][fassung];
}

// ── Reed-Solomon über GF(256), Polynom 0x11D ───────────────────────────────

function gfMal(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsTeiler(grad: number): number[] {
  const r = new Array<number>(grad).fill(0);
  r[grad - 1] = 1;
  let wurzel = 1;
  for (let i = 0; i < grad; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMal(r[j], wurzel);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    wurzel = gfMal(wurzel, 0x02);
  }
  return r;
}

function rsRest(daten: readonly number[], teiler: readonly number[]): number[] {
  const r = new Array<number>(teiler.length).fill(0);
  for (const b of daten) {
    const f = b ^ (r.shift() as number);
    r.push(0);
    teiler.forEach((t, i) => (r[i] ^= gfMal(t, f)));
  }
  return r;
}

// ── Daten ──────────────────────────────────────────────────────────────────

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

function codewoerter(bytes: readonly number[], fassung: number, k: Fehlerkorrektur): number[] {
  const bits: number[] = [];
  const schreibe = (wert: number, laenge: number) => {
    for (let i = laenge - 1; i >= 0; i--) bits.push((wert >>> i) & 1);
  };
  schreibe(0b0100, 4); // Byte-Modus
  schreibe(bytes.length, fassung <= 9 ? 8 : 16);
  bytes.forEach((b) => schreibe(b, 8));
  const kapazitaet = datenCodewoerter(fassung, k) * 8;
  schreibe(0, Math.min(4, kapazitaet - bits.length)); // Abschluss
  schreibe(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < kapazitaet; pad ^= 0xec ^ 0x11) schreibe(pad, 8);
  const daten: number[] = [];
  for (let i = 0; i < bits.length; i += 8) daten.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return daten;
}

/** Blöcke bilden, je Block die Prüfwörter anhängen, dann Spalte für Spalte verschränken. */
function verschraenkt(daten: readonly number[], fassung: number, k: Fehlerkorrektur): number[] {
  const anzahl = BLOECKE[k][fassung];
  const pruef = PRUEF_JE_BLOCK[k][fassung];
  const gesamt = Math.floor(rohModule(fassung) / 8);
  const kurze = anzahl - (gesamt % anzahl);
  const kurzLaenge = Math.floor(gesamt / anzahl);
  const teiler = rsTeiler(pruef);
  const bloecke: number[][] = [];
  for (let i = 0, pos = 0; i < anzahl; i++) {
    const laenge = kurzLaenge - pruef + (i < kurze ? 0 : 1);
    const d = daten.slice(pos, pos + laenge);
    pos += laenge;
    const block = [...d, ...rsRest(d, teiler)];
    if (i < kurze) block.splice(kurzLaenge - pruef, 0, -1); // Platzhalter: kurze Blöcke sind ein Wort kürzer
    bloecke.push(block);
  }
  const ergebnis: number[] = [];
  for (let i = 0; i < bloecke[0].length; i++) {
    bloecke.forEach((b) => {
      if (b[i] !== -1) ergebnis.push(b[i]);
    });
  }
  return ergebnis;
}

// ── Matrix ─────────────────────────────────────────────────────────────────

function ausrichtung(fassung: number): number[] {
  if (fassung === 1) return [];
  const anzahl = Math.floor(fassung / 7) + 2;
  const schritt = Math.floor((fassung * 8 + anzahl * 3 + 5) / (anzahl * 4 - 4)) * 2;
  const lagen = [6];
  for (let pos = fassung * 4 + 10; lagen.length < anzahl; pos -= schritt) lagen.splice(1, 0, pos);
  return lagen;
}

class Matrix {
  readonly fassung: number;
  readonly groesse: number;
  readonly module: boolean[][];
  readonly funktion: boolean[][];

  constructor(fassung: number) {
    this.fassung = fassung;
    this.groesse = fassung * 4 + 17;
    this.module = Array.from({ length: this.groesse }, () => new Array<boolean>(this.groesse).fill(false));
    this.funktion = Array.from({ length: this.groesse }, () => new Array<boolean>(this.groesse).fill(false));
  }

  setze(x: number, y: number, dunkel: boolean) {
    this.module[y][x] = dunkel;
    this.funktion[y][x] = true;
  }

  funktionsmuster() {
    const g = this.groesse;
    for (let i = 0; i < g; i++) {
      this.setze(6, i, i % 2 === 0);
      this.setze(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [g - 4, 3], [3, g - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < g && y >= 0 && y < g) this.setze(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const lagen = ausrichtung(this.fassung);
    const n = lagen.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            this.setze(lagen[i] + dx, lagen[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }
    this.format(0, 'M'); // nur um die Plätze zu belegen; die echten Bits kommen nach der Maske
    this.fassungsinfo();
  }

  format(maske: number, k: Fehlerkorrektur) {
    const daten = (FORMAT_BITS[k] << 3) | maske;
    let rest = daten;
    for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
    const bits = ((daten << 10) | rest) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const g = this.groesse;
    for (let i = 0; i <= 5; i++) this.setze(8, i, bit(i));
    this.setze(8, 7, bit(6));
    this.setze(8, 8, bit(7));
    this.setze(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setze(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setze(g - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setze(8, g - 15 + i, bit(i));
    this.setze(8, g - 8, true); // das dunkle Modul
  }

  fassungsinfo() {
    if (this.fassung < 7) return;
    let rest = this.fassung;
    for (let i = 0; i < 12; i++) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25);
    const bits = (this.fassung << 12) | rest;
    for (let i = 0; i < 18; i++) {
      const dunkel = ((bits >>> i) & 1) !== 0;
      const a = this.groesse - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setze(a, b, dunkel);
      this.setze(b, a, dunkel);
    }
  }

  daten(woerter: readonly number[]) {
    let i = 0;
    const g = this.groesse;
    for (let rechts = g - 1; rechts >= 1; rechts -= 2) {
      if (rechts === 6) rechts = 5;
      for (let v = 0; v < g; v++) {
        for (let j = 0; j < 2; j++) {
          const x = rechts - j;
          const aufwaerts = ((rechts + 1) & 2) === 0;
          const y = aufwaerts ? g - 1 - v : v;
          if (!this.funktion[y][x] && i < woerter.length * 8) {
            this.module[y][x] = ((woerter[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  maskiere(maske: number) {
    for (let y = 0; y < this.groesse; y++) {
      for (let x = 0; x < this.groesse; x++) {
        if (this.funktion[y][x]) continue;
        let kippen: boolean;
        switch (maske) {
          case 0: kippen = (x + y) % 2 === 0; break;
          case 1: kippen = y % 2 === 0; break;
          case 2: kippen = x % 3 === 0; break;
          case 3: kippen = (x + y) % 3 === 0; break;
          case 4: kippen = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: kippen = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: kippen = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: kippen = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (kippen) this.module[y][x] = !this.module[y][x];
      }
    }
  }

  /** Strafpunkte nach Abschnitt 7.8.3 des Standards. */
  strafe(): number {
    const g = this.groesse;
    const m = this.module;
    let summe = 0;
    const linie = (wert: (i: number, j: number) => boolean) => {
      for (let i = 0; i < g; i++) {
        let lauf = 1;
        for (let j = 1; j <= g; j++) {
          if (j < g && wert(i, j) === wert(i, j - 1)) {
            lauf++;
          } else {
            if (lauf >= 5) summe += 3 + (lauf - 5);
            lauf = 1;
          }
        }
        // Muster 1:1:3:1:1 mit vier hellen Modulen davor oder danach (die Ruhezone zählt hell).
        const reihe = Array.from({ length: g + 8 }, (_, j) => (j < 4 || j >= g + 4 ? false : wert(i, j - 4)));
        // Die äußeren dunklen Läufe sind genau ein Modul lang: davor bzw. danach hell.
        for (let j = 0; j + 11 <= reihe.length; j++) {
          const s = reihe.slice(j, j + 11).map((b) => (b ? 1 : 0)).join('');
          if (s === '10111010000' && (j === 0 || !reihe[j - 1])) summe += 40;
          if (s === '00001011101' && (j + 11 === reihe.length || !reihe[j + 11])) summe += 40;
        }
      }
    };
    linie((y, x) => m[y][x]);
    linie((x, y) => m[y][x]);
    for (let y = 0; y < g - 1; y++) {
      for (let x = 0; x < g - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) summe += 3;
      }
    }
    const dunkel = m.reduce((a, r) => a + r.filter(Boolean).length, 0);
    const gesamt = g * g;
    const k = Math.ceil(Math.abs(dunkel * 20 - gesamt * 10) / gesamt) - 1;
    summe += k * 10;
    return summe;
  }
}

/**
 * Den Text als QR-Code: die kleinste Fassung, in die er passt (ab `kleinsteFassung`). `maske` fest
 * (0 bis 7) oder nach den Strafpunkten gewählt. Wirft, wenn der Text nicht in Fassung 10 passt.
 */
export function qrCode(
  text: string,
  opts: { korrektur?: Fehlerkorrektur; kleinsteFassung?: number; maske?: number } = {},
): QrCode {
  const k = opts.korrektur ?? 'M';
  const bytes = utf8(text);
  let fassung = Math.max(1, opts.kleinsteFassung ?? 1);
  while (fassung <= HOECHSTE_FASSUNG && 4 + (fassung <= 9 ? 8 : 16) + bytes.length * 8 > datenCodewoerter(fassung, k) * 8) {
    fassung++;
  }
  if (fassung > HOECHSTE_FASSUNG) throw new Error(`Der Text ist zu lang für einen QR-Code bis Fassung ${HOECHSTE_FASSUNG}.`);
  const woerter = verschraenkt(codewoerter(bytes, fassung, k), fassung, k);

  const bau = (maske: number) => {
    const m = new Matrix(fassung);
    m.funktionsmuster();
    m.daten(woerter);
    m.maskiere(maske);
    m.format(maske, k);
    return m;
  };
  let maske = opts.maske ?? -1;
  if (maske < 0) {
    let beste = Infinity;
    for (let i = 0; i < 8; i++) {
      const s = bau(i).strafe();
      if (s < beste) {
        beste = s;
        maske = i;
      }
    }
  }
  const m = bau(maske);
  return { fassung, korrektur: k, maske, groesse: m.groesse, module: m.module };
}

/**
 * Die dunklen Module als SVG-Pfad, eine Einheit je Modul, mit `ruhe` Modulen Rand: Zeile für Zeile
 * zusammenhängende Läufe als ein Rechteck.
 */
export function qrPfad(q: QrCode, ruhe = 0): string {
  const teile: string[] = [];
  q.module.forEach((reihe, y) => {
    let x = 0;
    while (x < q.groesse) {
      if (!reihe[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < q.groesse && reihe[x]) x++;
      teile.push(`M${start + ruhe} ${y + ruhe}h${x - start}v1h-${x - start}z`);
    }
  });
  return teile.join('');
}
