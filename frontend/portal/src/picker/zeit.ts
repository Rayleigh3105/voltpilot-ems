/**
 * Die REGELN des Zeit-Pickers - Raster, tolerantes Lesen, Grenzen.
 *
 * Diese Datei rechnet und formuliert; sie rendert nichts und ruft nichts ab.
 *
 * ⚠ DER WERT BLEIBT `HH:MM` - byte-gleich mit dem, was `<input type="time">`
 * geliefert hat, das der Picker ablöst.
 *
 * ⚠ UND DAS RASTER IST EIN VORSCHLAG, KEINE VALIDIERUNG. Ein Viertelstunden-
 * Raster als einzige Eingabemöglichkeit würde ändern, WELCHE Werte ein
 * Formular annimmt („keine Verhaltensänderung der Formulare") - eine Regel, die
 * heute 06:07 erlaubt, dürfte das morgen nicht plötzlich verbieten. Getippt
 * wird deshalb frei, das Raster ist nur die schnelle Liste daneben.
 */

/** Der Vorgabe-Abstand der Liste in Minuten. */
export const RASTER_MIN = 15;

function zwei(n: number): string {
  return String(n).padStart(2, '0');
}

/** `HH:MM` aus Minuten seit Mitternacht. */
export function ausMinuten(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${zwei(Math.floor(m / 60))}:${zwei(m % 60)}`;
}

/** Minuten seit Mitternacht, oder `null` bei unbrauchbarem Wert. */
export function inMinuten(wert: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((wert ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/**
 * Tolerantes Lesen einer getippten Zeit - dieselbe Haltung wie die tolerante
 * Suche: die Schreibweise darf nicht entscheiden, ob jemand ans Ziel kommt.
 *
 * Angenommen werden `18:30` · `18.30` · `18 30` · `1830` · `830` · `18` ·
 * `8` - und `null`, sobald es nicht mehr eindeutig ist. Eine unklare Eingabe
 * wird NIE geraten (aus „25" wird keine Zeit).
 */
export function zeitLesen(text: string): string | null {
  const t = (text ?? '').trim().replace(/\s*uhr$/i, '').trim();
  if (t === '') return null;
  const mitTrenner = /^(\d{1,2})[:.\s](\d{1,2})$/.exec(t);
  if (mitTrenner) return baue(Number(mitTrenner[1]), Number(mitTrenner[2]));
  const nurZiffern = /^(\d{1,4})$/.exec(t);
  if (!nurZiffern) return null;
  const z = nurZiffern[1];
  // 1-2 Ziffern = volle Stunde; 3-4 Ziffern = HMM bzw. HHMM.
  if (z.length <= 2) return baue(Number(z), 0);
  return baue(Number(z.slice(0, z.length - 2)), Number(z.slice(-2)));
}

function baue(h: number, m: number): string | null {
  if (h > 23 || m > 59) return null;
  return `${zwei(h)}:${zwei(m)}`;
}

/**
 * Das Raster als Liste.
 *
 * ⚠ `bis` ist EINSCHLIESSLICH. OHNE `bis` endet die Liste am letzten
 * Rasterpunkt VOR Mitternacht - „24:00" ist als Uhrzeit kein Zeitpunkt dieses
 * Tages. Wo eine Fläche das Tagesende meint (Verbraucher-Fenster), reicht sie
 * `24:00` AUSDRÜCKLICH herein; dann steht es in der Liste, und der Wert bleibt
 * der, den das Formular schon immer trug.
 *
 * ⚠ Ein ausdrücklich genannter Rand wird auch dann angeboten, wenn er NEBEN
 * dem Raster liegt - sonst fehlte genau die Grenze, die der Aufrufer meinte.
 */
export function raster(
  schritt = RASTER_MIN,
  von = '00:00',
  bis?: string | null,
): string[] {
  const s = Math.max(1, Math.round(schritt));
  const a = inMinuten(von) ?? 0;
  const genannt = bis != null && bis !== '' ? inMinuten(bis) : null;
  // Ohne genannten Rand: der letzte Rasterpunkt, der noch in den Tag fällt.
  const b = genannt ?? a + Math.floor((1439 - a) / s) * s;
  if (b < a) return [];
  const out: string[] = [];
  for (let m = a; m <= b; m += s) out.push(ausMinuten(m));
  if (genannt != null && out[out.length - 1] !== ausMinuten(genannt)) {
    out.push(ausMinuten(genannt));
  }
  return out;
}

/** Liegt die Zeit in den Grenzen? (`HH:MM` ist lexikografisch sortierbar.) */
export function imBereich(wert: string, min?: string | null, max?: string | null): boolean {
  if (min && wert < min) return false;
  if (max && wert > max) return false;
  return true;
}

/**
 * Die ANGEZEIGTE Zeit - im Deutschen mit „Uhr", weil ein nacktes „18:30" in
 * einem Formularfeld auch ein Zeitraum sein könnte.
 */
export function anzeige(wert: string): string | null {
  return inMinuten(wert) == null ? null : `${wert} Uhr`;
}

/** Der Index der Zeile, die dem Wert am nächsten liegt (für „ins Bild holen"). */
export function naechsteZeile(zeilen: string[], wert: string): number {
  const ziel = inMinuten(wert);
  if (ziel == null || zeilen.length === 0) return -1;
  let besteI = 0;
  let besteD = Number.POSITIVE_INFINITY;
  zeilen.forEach((z, i) => {
    const m = inMinuten(z);
    if (m == null) return;
    const d = Math.abs(m - ziel);
    if (d < besteD) {
      besteD = d;
      besteI = i;
    }
  });
  return besteI;
}
