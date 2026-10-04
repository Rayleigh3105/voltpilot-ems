/**
 * Das ZEITRASTER der Steuerung: heute und morgen in Viertelstunden (2 × 96).
 *
 * Rein: keine Netzaufrufe, keine Uhr ausser der übergebenen. Die Wanduhr ist
 * die des Browsers - dieselbe Lesart wie der Fahrplan (`fahrplanTag.ts`
 * `mitternacht`), damit „14:15“ hier und dort dieselbe Viertelstunde meint.
 *
 * Dazu die Wörter für Zahlen: die Einheit steht immer am Wert, ein fehlender
 * Wert wird nie zu einer 0 (die Aufrufer fragen `null` ab, bevor sie formen).
 */

/** Viertelstunden in zwei Tagen. */
export const N = 192;
export const TAG = 96;
const VIERTEL_MS = 15 * 60 * 1000;

export interface Raster {
  /** Lokale Mitternacht HEUTE (ms). */
  start: number;
  /** Die laufende Viertelstunde (0 … 95). */
  jetzt: number;
  /** Minuten seit Mitternacht (für „13:10“). */
  jetztMin: number;
  /** Der Zeitpunkt, für den das Raster gilt (ms). */
  nowMs: number;
}

export function raster(now: Date): Raster {
  const mitternacht = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const jetztMin = now.getHours() * 60 + now.getMinutes();
  return { start: mitternacht, jetzt: Math.min(TAG - 1, Math.floor(jetztMin / 15)), jetztMin, nowMs: now.getTime() };
}

/**
 * Die Viertelstunde eines Zeitpunkts im Raster - `null` ausserhalb (gestern,
 * übermorgen) oder bei einem unlesbaren Stempel.
 *
 * ⚠ Über die Wanduhr, nicht über die Millisekunden seit Mitternacht: an einem
 * Umstellungstag hat der Tag 92 oder 100 Viertelstunden, das Raster aber 96.
 */
export function slotVon(r: Raster, iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const heute = new Date(r.start);
  const tagDiff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - heute.getTime()) / 86_400_000,
  );
  if (tagDiff < 0 || tagDiff > 1) return null;
  const i = tagDiff * TAG + Math.floor((d.getHours() * 60 + d.getMinutes()) / 15);
  return i >= 0 && i < N ? i : null;
}

/** Der Beginn einer Viertelstunde als Datum (Wanduhr). */
export function slotDatum(r: Raster, t: number): Date {
  const heute = new Date(r.start);
  const tag = Math.floor(t / TAG);
  const m = (t % TAG) * 15;
  return new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() + tag, Math.floor(m / 60), m % 60);
}

/** Viertelstunde eines Datums (das Gegenstück zu {@link slotDatum}). */
export function slotAus(r: Raster, d: Date): number | null {
  return slotVon(r, d.toISOString());
}

/** Minuten zwischen jetzt und dem Beginn einer Viertelstunde. */
export function minutenBis(r: Raster, t: number): number {
  return Math.round((slotDatum(r, t).getTime() - r.nowMs) / 60_000);
}

export const leer = <T>(): (T | null)[] => Array.from({ length: N }, () => null);

// ---------------------------------------------------------------------------
// Wörter für Zahlen und Zeiten
// ---------------------------------------------------------------------------

const NF1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const NF0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const NF2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const zahl1 = (v: number) => NF1.format(v);
export const zahl0 = (v: number) => NF0.format(v);
export const fKw = (v: number) => `${NF1.format(Math.abs(v) < 0.05 ? 0 : v)} kW`;
export const fKwh = (v: number) => `${NF1.format(v)} kWh`;
export const fCt = (v: number) => `${v < 0 ? '−' : ''}${NF1.format(Math.abs(v))} ct/kWh`;
export const fEur = (v: number) => `${NF2.format(v)} €`;
export const fPct = (v: number) => `${NF0.format(v)} %`;
export const fGrad = (v: number) => `${NF0.format(v)} °C`;

const pad = (n: number) => String(n).padStart(2, '0');

/** „14:15“ für eine Viertelstunde (morgen ohne Zusatz). */
export function uhr(t: number): string {
  const m = ((t % TAG) + TAG) % TAG;
  return `${pad(Math.floor(m / 4))}:${pad((m % 4) * 15)}`;
}

/** „morgen 07:00“ / „14:15“. */
export function uhrTag(t: number): string {
  return (t >= TAG ? 'morgen ' : '') + uhr(t);
}

/** „13:10“ aus Minuten seit Mitternacht. */
export function uhrMin(min: number): string {
  return `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
}

/** Die Uhrzeit eines Zeitpunkts, mit „morgen“ oder Datum, wenn nicht heute. */
export function uhrVon(r: Raster, ms: number): string {
  const d = new Date(ms);
  const t = slotAus(r, d);
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (t == null) return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' }) + ' ' + hhmm;
  return (t >= TAG ? 'morgen ' : '') + hhmm;
}

/** „2 Std 30 Min“ aus Viertelstunden. */
export function dauer(viertel: number): string {
  const min = Math.round(viertel * 15);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} Min`;
  return `${h} Std${m ? ` ${m} Min` : ''}`;
}

/** „in 25 Min“ / „um 16:00“ / „gleich“. */
export function inZeit(r: Raster, t: number): string {
  const diff = minutenBis(r, t);
  if (diff <= 0) return 'gleich';
  if (diff < 60) return `in ${diff} Min`;
  return `um ${uhrTag(t)}`;
}

/** „Werkstatt, Heizstab und Pool“. */
export function aufzaehlung(namen: string[]): string {
  return namen.reduce((s, n, i, a) => s + (i === 0 ? '' : i === a.length - 1 ? ' und ' : ', ') + n, '');
}

/** Zusammenhängende Spannen einer Ja/Nein-Reihe als [von, bis). */
export function spannen(bits: readonly boolean[], t0 = 0): [number, number][] {
  const out: [number, number][] = [];
  let s: number | null = null;
  bits.forEach((v, i) => {
    if (v && s == null) s = i;
    if (!v && s != null) {
      out.push([t0 + s, t0 + i]);
      s = null;
    }
  });
  if (s != null) out.push([t0 + s, t0 + bits.length]);
  return out;
}

/** „14:00–15:30, morgen 11:00–13:00 und 2 weitere“. */
export function spannenText(sp: [number, number][], max = 3): string {
  if (!sp.length) return '—';
  const txt = sp.slice(0, max).map(([a, b]) => `${uhrTag(a)}–${uhr(b)}`).join(', ');
  return txt + (sp.length > max ? ` und ${sp.length - max} weitere` : '');
}

export const VIERTEL = VIERTEL_MS;
