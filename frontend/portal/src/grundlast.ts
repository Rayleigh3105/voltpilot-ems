/**
 * **Grundlast** - „Was läuft bei mir immer?“ (Bedienkonzept Privatkunde §5, Variante A; BK-1 bis BK-3 = A).
 * Rein und rahmenfrei: aus der Antwort von `GET /api/v1/sites/{id}/grundlast` die Wörter, Sätze und Balken der
 * Karte im Verlauf (`components/energie/GrundlastKarte.tsx`) und der Kachel im Cockpit.
 *
 * Die Zahl rechnet nur der Server (`GrundlastRegel`): niedrigste Viertelstunde 0–5 Uhr, Median der gewerteten
 * Nächte ab drei. Hier wird nur gerundet (10 W, kWh am Tag auf 0,5) und in Worte gefasst.
 *
 * Ehrlichkeit: eine Nacht ohne genug Messwerte ist ein grauer Balken, nie 0 W; ohne typische Nacht steht ein
 * Strich und der Grund. Keine Hochrechnung aufs Jahr (BK-3 = A), keine Warnung bei einer Stufe (§5.3).
 */
import type { Grundlast, GrundlastZeitraum, HistoryRange } from './api';
import { GRUNDLAST, GRUNDLAST_LAEUFT_IMMER, GRUNDLAST_TYPISCHE_NACHT } from './glossarGrundlast';
import { NBSP } from './format';
import { restWort } from './verbrauchKomposition';

const NF0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

/**
 * Leistung in Watt, auf 10 W gerundet (§5.4): „640 W“, „1.240 W“ - geschütztes Leerzeichen vor der Einheit,
 * Tausenderpunkt; kleiner als 5 W wird „0 W“, nie ein Minus. Steht hier statt in `leitungsplan.ts`, weil jenes Modul
 * im Einstiegs-Bündel liegt und nur nachgeladene Stücke Watt schreiben (`test/bundle-smoke.sh`).
 */
export function watt(x: number | null): string {
  return x == null ? '—' : `${NF0.format(Math.max(0, Math.round(x / 10) * 10))}${NBSP}W`;
}

/** Der Zeitraum der Route zum Zeitraum des Verlaufs. */
export function grundlastZeitraum(range: HistoryRange): GrundlastZeitraum {
  return ({ day: 'tag', week: 'woche', month: 'monat', year: 'jahr' } as const)[range];
}

/**
 * Der Anteil am Verbrauch als Wort, sieben Stufen (Bericht §5.4; Startwerte des Baus, nicht vom Captain
 * entschieden): die nächste der Brüche ein Zehntel … die Hälfte, darüber „mehr als die Hälfte“.
 */
export function anteilWort(anteil: number): string {
  if (anteil >= 0.6) return 'mehr als die Hälfte';
  const stufen: [number, string][] = [
    [1 / 10, 'ein Zehntel'],
    [1 / 6, 'ein Sechstel'],
    [1 / 5, 'ein Fünftel'],
    [1 / 4, 'ein Viertel'],
    [1 / 3, 'ein Drittel'],
    [1 / 2, 'die Hälfte'],
  ];
  let beste = stufen[0];
  for (const s of stufen) if (Math.abs(s[0] - anteil) < Math.abs(beste[0] - anteil)) beste = s;
  return beste[1];
}

/** kWh am Tag, rund: unter 10 auf 0,5, sonst ganze. „5,5“, „7“, „15“. */
export function kwhRund(kwh: number): string {
  const r = kwh < 10 ? Math.round(kwh * 2) / 2 : Math.round(kwh);
  return r.toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

const nacht = (n: number) => (n === 1 ? '1 Nacht' : `${n} Nächte`);

/** Lokales Datum aus `JJJJ-MM-TT` (nie als UTC lesen). */
function datum(iso: string): Date {
  const [j, m, t] = iso.split('-').map(Number);
  return new Date(j, (m ?? 1) - 1, t ?? 1);
}

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONATE_KURZ = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'];
const WOCHENTAGE = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];
const zwei = (n: number) => String(n).padStart(2, '0');

/** „Mo., 31.08.“ */
function tagKurz(iso: string): string {
  const d = datum(iso);
  return `${WOCHENTAGE[d.getDay()]}, ${zwei(d.getDate())}.${zwei(d.getMonth() + 1)}.`;
}
/** „1. Okt.“ */
function tagImMonat(iso: string): string {
  const d = datum(iso);
  return `${d.getDate()}. ${MONATE_KURZ[d.getMonth()]}`;
}
/** „17. Oktober“ */
function tagLang(iso: string): string {
  const d = datum(iso);
  return `${d.getDate()}. ${MONATE[d.getMonth()]}`;
}

/** Die Überschrift über der Zahl. */
export function nachtTitel(z: GrundlastZeitraum, von: string): string {
  switch (z) {
    case 'tag':
      return `in der Nacht zum ${tagKurz(von).replace(/^[^,]+, /, '')}`;
    case 'woche':
      return `${GRUNDLAST_TYPISCHE_NACHT} der Woche`;
    case 'monat':
      return `${GRUNDLAST_TYPISCHE_NACHT} im Monat`;
    case 'jahr':
      return `${GRUNDLAST_TYPISCHE_NACHT} im Jahr`;
    default:
      return `${GRUNDLAST_TYPISCHE_NACHT} der letzten 14 Nächte`;
  }
}

const VORPERIODE: Record<GrundlastZeitraum, string> = {
  tag: 'Nacht davor',
  woche: 'Vorwoche',
  monat: 'Vormonat',
  jahr: 'Vorjahr',
  aktuell: 'vor einem Monat',
};

/** Ein Balken: je Nacht (Tag/Woche/Monat) oder je Monat (Jahr). */
export interface GrundlastBalken {
  key: string;
  /** 0..1 der höchsten Säule; `null` = kein Wert (grauer Strich oder leer). */
  hoehe: number | null;
  /** `wert` = farbige Säule, `ohne` = grauer Strich (nicht gewertet / vor der Messung), `offen` = leer. */
  art: 'wert' | 'ohne' | 'offen';
  /** Für den Tooltip: „Mo., 31.08.: 640 W“. */
  titel: string;
}

export interface GrundlastTeilZeile {
  key: string;
  label: string;
  wert: string;
  art: 'teil' | 'rest';
}

export interface GrundlastKarteModell {
  titel: string;
  /** Die große Zahl („640 W“) oder „—“. */
  zahl: string;
  balken: GrundlastBalken[];
  /** Erste und letzte Beschriftung unter den Balken. */
  achse: [string, string] | null;
  teile: GrundlastTeilZeile[];
  satz: string;
}

/** Der Satz unter der Karte (eine Aussage, höchstens ein Zusatz). */
export function grundlastSatz(g: Grundlast): string {
  if (g.typischW == null) {
    if (g.z === 'tag') return g.luecken > 0 ? 'Diese Nacht hat zu wenige Messwerte.' : 'Für diese Nacht gibt es noch keine Messwerte.';
    const fehlen = Math.max(1, g.mindestens - g.gewertet);
    if (g.luecken > 0) return `Zu wenige Nächte mit Messwerten: ${nacht(g.luecken)} ohne Messwerte ${g.luecken === 1 ? 'ist' : 'sind'} nicht gewertet.`;
    if (g.naechte.some((n) => n.status === 'offen') || g.z === 'aktuell')
      return `Noch ${nacht(fehlen)} Messung, dann steht hier Ihre ${GRUNDLAST}.`;
    if (g.gewertet > 0) return `Erst ${nacht(g.gewertet)} gemessen – für die typische Nacht braucht es ${g.mindestens}.`;
    return 'In diesem Zeitraum wurde noch nicht gemessen.';
  }
  const basis = g.kwhAmTag == null ? null : `Rund ${kwhRund(g.kwhAmTag)} kWh am Tag`;
  const zusatz = grundlastZusatz(g);
  if (zusatz) return basis ? `${basis}. ${zusatz}` : zusatz;
  const teile: string[] = [];
  if (basis) {
    const anteil = g.anteil == null ? '' : g.anteil >= 0.6 ? ' – mehr als die Hälfte Ihres Verbrauchs' : ` – etwa ${anteilWort(g.anteil)} Ihres Verbrauchs`;
    teile.push(`${basis}${anteil}.`);
  }
  if (g.vorperiodeW != null) teile.push(`${VORPERIODE[g.z]}: ${watt(g.vorperiodeW)}.`);
  return teile.join(' ');
}

/** Der eine Zusatz, der Anteil und Vorperiode verdrängt: Lücken, Stufe, niedrigster Monat. */
function grundlastZusatz(g: Grundlast): string | null {
  if (g.luecken > 0) return `${nacht(g.luecken)} ohne Messwerte ${g.luecken === 1 ? 'ist' : 'sind'} nicht gewertet.`;
  if (g.stufe) {
    const diff = g.stufe.nachherW - g.stufe.vorherW;
    return `Seit dem ${tagLang(g.stufe.seit)} rund ${watt(Math.abs(diff))} ${diff > 0 ? 'mehr' : 'weniger'}.`;
  }
  if (g.z === 'jahr') {
    const mit = g.monate.filter((m) => m.w != null);
    if (mit.length >= 2) {
      const tief = mit.reduce((a, b) => ((b.w as number) < (a.w as number) ? b : a));
      return `Niedrigster Monat: ${MONATE[Number(tief.monat.slice(5, 7)) - 1]} mit ${watt(tief.w)}.`;
    }
  }
  return null;
}

/** Die Karte im Verlauf. `profil` wählt das Wort für den Rest (wie „Verbrauch nach Bereichen“). */
export function grundlastKarte(g: Grundlast, profil?: string | null): GrundlastKarteModell {
  const roh =
    g.z === 'jahr'
      ? g.monate.map((m) => ({
        key: m.monat,
        w: m.w,
        art: (m.w != null ? 'wert' : m.gewertet === 0 && !vergangen(m.monat) ? 'offen' : 'ohne') as GrundlastBalken['art'],
        titel: `${MONATE[Number(m.monat.slice(5, 7)) - 1]}: ${m.w == null ? 'keine Zahl' : watt(m.w)}`,
      }))
      : g.naechte.map((n) => ({
        key: n.datum,
        w: n.w,
        art: (n.status === 'gewertet' ? 'wert' : n.status === 'offen' ? 'offen' : 'ohne') as GrundlastBalken['art'],
        titel: `${tagKurz(n.datum)}: ${n.status === 'gewertet' ? watt(n.w) : n.status === 'offen' ? 'noch offen' : 'nicht gewertet'}`,
      }));
  const max = Math.max(0, ...roh.map((b) => b.w ?? 0));
  const balken: GrundlastBalken[] =
    g.z === 'tag' ? [] : roh.map((b) => ({ key: b.key, art: b.art, titel: b.titel, hoehe: b.w != null && max > 0 ? b.w / max : null }));
  const achse: [string, string] | null =
    balken.length < 2
      ? null
      : g.z === 'jahr'
        ? [MONATE_KURZ[Number(g.monate[0].monat.slice(5, 7)) - 1], MONATE_KURZ[Number(g.monate[g.monate.length - 1].monat.slice(5, 7)) - 1]]
        : g.z === 'monat'
          ? [tagImMonat(g.von), tagImMonat(g.bis)]
          : [tagKurz(g.von), tagKurz(g.bis)];

  const teile: GrundlastTeilZeile[] = [];
  if (g.teile.length > 0 && g.typischW != null) {
    const sortiert = [...g.teile].sort((a, b) => (b.w ?? -1) - (a.w ?? -1));
    for (const t of sortiert) {
      teile.push({ key: t.entityId, label: t.label?.trim() || t.typLabel || 'Gerät', wert: watt(t.w), art: 'teil' });
    }
    if (g.rest) {
      const wert =
        g.rest.w != null
          ? watt(g.rest.w)
          : g.rest.grund === 'teile_mehr_als_haus'
            ? 'passt nicht zusammen'
            : 'nicht bestimmbar';
      teile.push({ key: 'rest', label: restWort(profil), wert, art: 'rest' });
    }
  }
  return {
    titel: nachtTitel(g.z, g.von),
    zahl: watt(g.typischW),
    balken,
    achse,
    teile,
    satz: grundlastSatz(g),
  };
}

/** Ob ein Monat (`JJJJ-MM`) schon begonnen hat. */
function vergangen(monat: string): boolean {
  const heute = new Date();
  const jetzt = `${heute.getFullYear()}-${zwei(heute.getMonth() + 1)}`;
  return monat <= jetzt;
}

/** Die Kachel im Cockpit (`z=aktuell`), oder `null`, wenn der Hausverbrauch nie gemessen wurde. */
export interface GrundlastKachelModell {
  /** Die Zahl ohne Einheit („310“) oder „—“. */
  zahl: string;
  einheit: string | null;
  zustand: string;
  sub: string | null;
}

export function grundlastKachel(g: Grundlast | null): GrundlastKachelModell | null {
  if (!g || !g.hausverbrauchGemessen) return null;
  if (g.typischW == null) {
    const fehlen = Math.max(1, g.mindestens - g.gewertet);
    return {
      zahl: '—',
      einheit: null,
      zustand: GRUNDLAST_LAEUFT_IMMER,
      sub: g.luecken > 0 ? 'zu wenige Nächte mit Messwerten' : `noch ${nacht(fehlen)} Messung`,
    };
  }
  const w = watt(g.typischW);
  return {
    zahl: w.replace(/ W$/, ''),
    einheit: 'W',
    zustand: GRUNDLAST_LAEUFT_IMMER,
    sub: g.vorperiodeW == null ? null : `vor einem Monat ${watt(g.vorperiodeW)}`,
  };
}
