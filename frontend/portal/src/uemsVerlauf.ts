/**
 * Der VERLAUF einer Messstelle (UEMS AP-13 IP-4 = AP-08 IP-10) als reine Ableitung: aus der Antwort von
 * `GET /api/v1/messstellen/{kennzeichen}/werte` im Raster des Zeitraums wird, was das Diagramm zeigt.
 *
 * Die Regeln stehen in AP-08 §5 (Chart-Regeln K1–K11) und AP-13 §4.6 (V1–V7). Hier wird nichts gerechnet, was ein
 * Satz sagt:
 *  - V1: vier Zeiträume im Raster der Route — Tag in Viertelstunden, Woche in Stunden, Monat in Tagen, Jahr in
 *    Monaten (`uemsOberflaechen.VERLAUF_RASTER`), kein freies Von–Bis. Die Woche hat keine Karte: die Route kennt
 *    kein Wochen-Raster, und summiert wird nie.
 *  - V3: jeder Schritt ist eine erklärte Zahl — Zahl, Zustand und Kennzeichen über `uemsWerteKarte.anzeige` (also
 *    den Ergebnis-Vertrag), Farbe UND Wort je Zustand; `null` ist eine Lücke ohne Balken und ohne Null.
 *  - V4: eine Folge von Schritten „keine Werte“ ist eine schraffierte Fläche.
 *  - V5: Marker aus `ereignisse[]` mit dem Satz des Ereignis-Vokabulars (`uemsEreignis.ereignisSatz`) — höchstens
 *    drei im Bild (K6), jeder in der Liste darunter. Eine Lücke ohne verwiesenes Ereignis sagt „keine Werte von …
 *    bis …“ aus den Schritten selbst, ohne Ursache.
 *  - V6/K1: der Kernaussage-Satz ist abgeleitet — aus der Karte der Periode, nie handgeschrieben.
 *  - K7: der Tooltip ist ein Satz (`chartTooltip.ableseSatz`).
 *
 * Die Höhe eines Balkens nutzt `Number()` nur fürs Bild, nie für einen Satz (wie der Kennzahl-Balken).
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */

import type { MessstelleWerte, MessstelleWerteRaster, MessstelleWerteWert } from './api';
import type { Kernaussage } from './chartKopf';
import { ableseSatz } from './chartTooltip';
import {
  UEMS_ERHALTEN,
  UEMS_EREIGNIS_AM,
  UEMS_EREIGNIS_SEIT,
  UEMS_EREIGNIS_VON_BIS,
  UEMS_KEINE_WERTE_AM,
  UEMS_KEINE_WERTE_IM,
  UEMS_KEINE_WERTE_VON_BIS,
  UEMS_NOCH_NICHT_GERECHNET,
  UEMS_WOCHE_OHNE_ZAHL,
} from './glossar';
import { MONATE, datumVon, isoTag, isoWoche, montagDerWoche, verschiebe } from './picker/datum';
import { EREIGNIS_TEXTE, ereignisSatz, zahlText, zeitText, type ArtText } from './uemsEreignis';
import { KEINE_WERTE, MIT_ERSATZWERT, OHNE_ZAHL, TRENNER, UNVOLLSTAENDIG, VOLLSTAENDIG, menge } from './uemsErgebnis';
import { VERLAUF_RASTER, type Zeitraum } from './uemsOberflaechen';
import { anzeige, karte, monatTitel, tagTitel, type Anfrage, type MessstellenKarte, type WertAnzeige } from './uemsWerteKarte';

const zwei = (n: number): string => String(n).padStart(2, '0');

// ------------------------------------------------------------------ 1 · Zeit-Leiste (V1, V2)

/** Der Wert der Zeit-Leiste, in dem ein Tag liegt: `JJJJ-MM-TT` · `JJJJ-Www` · `JJJJ-MM` · `JJJJ`. */
export const wertAm = (zeitraum: Zeitraum, tag: string): string => {
  if (zeitraum === 'tag') return tag;
  if (zeitraum === 'monat') return tag.slice(0, 7);
  if (zeitraum === 'jahr') return tag.slice(0, 4);
  return isoWoche(datumVon(tag, 'tag')!);
};

/** Der erste Tag des Zeitraums (die Woche beginnt am Montag, ISO). */
export const ersterTag = (zeitraum: Zeitraum, wert: string): string => {
  if (zeitraum === 'tag') return wert;
  if (zeitraum === 'monat') return `${wert}-01`;
  if (zeitraum === 'jahr') return `${wert}-01-01`;
  return isoTag(montagDerWoche(datumVon(wert, 'woche')!));
};

/** Der letzte Tag des Zeitraums, einschließlich — so fragt die Route (`bis` einschließlich). */
export const letzterTag = (zeitraum: Zeitraum, wert: string): string => {
  if (zeitraum === 'tag') return wert;
  if (zeitraum === 'woche') return verschiebe(ersterTag('woche', wert), 6);
  if (zeitraum === 'jahr') return `${wert}-12-31`;
  const [j, m] = wert.split('-').map(Number);
  return `${wert}-${zwei(new Date(Date.UTC(j, m, 0)).getUTCDate())}`;
};

/** Blättern um `schritt` Zeiträume derselben Art. */
export const blaettere = (zeitraum: Zeitraum, wert: string, schritt: number): string => {
  if (zeitraum === 'tag') return verschiebe(wert, schritt);
  if (zeitraum === 'woche') return isoWoche(datumVon(verschiebe(ersterTag('woche', wert), 7 * schritt), 'tag')!);
  if (zeitraum === 'jahr') return String(Number(wert) + schritt);
  const [j, m] = wert.split('-').map(Number);
  const d = new Date(Date.UTC(j, m - 1 + schritt, 1));
  return `${d.getUTCFullYear()}-${zwei(d.getUTCMonth() + 1)}`;
};

/** Liegt der Zeitraum schon beim heutigen oder danach? Dann gibt es kein „weiter“ — gleiche Formen sortieren als Text. */
export const heuteOderSpaeter = (zeitraum: Zeitraum, wert: string, heute: string): boolean => wert >= wertAm(zeitraum, heute);

/** Die Überschrift der Liste unter der Karte. */
export const LISTE_TITEL: Readonly<Record<Zeitraum, string>> = { tag: 'Stunden', woche: 'Tage', monat: 'Tage', jahr: 'Monate' };

export interface VerlaufAnfragen {
  /** Die Periode als EIN Schritt — `null` in der Woche (kein Wochen-Raster, nichts wird summiert). */
  karte: Anfrage | null;
  /** Die Liste: am Tag die Stunden, in Woche und Monat die Tage, im Jahr die Monate. */
  liste: Anfrage;
  /** Das Diagramm im Raster des Zeitraums (V1). */
  verlauf: Anfrage;
}

/** Die Anfragen eines Zeitraums. Tage in der Zone des Standorts, `bis` einschließlich. */
export const zeitraumAnfragen = (zeitraum: Zeitraum, wert: string): VerlaufAnfragen => {
  const von = ersterTag(zeitraum, wert);
  const bis = letzterTag(zeitraum, wert);
  const verlauf: Anfrage = { raster: VERLAUF_RASTER[zeitraum], von, bis };
  if (zeitraum === 'tag') return { karte: { raster: 'tag', von, bis }, liste: { raster: 'stunde', von, bis }, verlauf };
  if (zeitraum === 'woche') return { karte: null, liste: { raster: 'tag', von, bis }, verlauf };
  if (zeitraum === 'monat') return { karte: { raster: 'monat', von, bis }, liste: { raster: 'tag', von, bis }, verlauf };
  return { karte: { raster: 'jahr', von, bis }, liste: { raster: 'monat', von, bis }, verlauf };
};

/** Fragen zwei Anfragen dasselbe? Im Monat und im Jahr ist der Verlauf die Liste — dann antwortet EINE. */
export const gleicheAnfrage = (a: Anfrage | null, b: Anfrage | null): boolean =>
  a !== null && b !== null && a.raster === b.raster && a.von === b.von && a.bis === b.bis;

// ------------------------------------------------------------------ 2 · Schritte (V3)

/** Wie ein Schritt gezeichnet wird: je Zustand eine Farbe (mit ihrem Wort in der Legende), `ohne` = nicht gesprochen. */
export type SchrittArt = 'vollstaendig' | 'unvollstaendig' | 'ersatzwert' | 'keine_werte' | 'ohne';

const ART_DES_ZUSTANDS: Readonly<Record<string, SchrittArt>> = {
  [VOLLSTAENDIG]: 'vollstaendig',
  [UNVOLLSTAENDIG]: 'unvollstaendig',
  [MIT_ERSATZWERT]: 'ersatzwert',
  [KEINE_WERTE]: 'keine_werte',
};

/** Das Wort je Farbe — in der Reihenfolge der Legende. */
export const ZUSTAND_WORT: ReadonlyArray<{ art: Exclude<SchrittArt, 'ohne'>; wort: string }> = [
  { art: 'vollstaendig', wort: VOLLSTAENDIG },
  { art: 'unvollstaendig', wort: UNVOLLSTAENDIG },
  { art: 'ersatzwert', wort: MIT_ERSATZWERT },
  { art: 'keine_werte', wort: KEINE_WERTE },
];

export interface Schritt {
  index: number;
  von: string;
  bis: string;
  /** „14:15–14:30“ · „Mo 02.11. 14:00–15:00“ · „Di 03.11.2026“ · „Oktober 2026“. */
  titel: string;
  /** Die Beschriftung an der Zeitachse: „14:00“ · „03.“ · „Okt“. */
  kurz: string;
  anzeige: WertAnzeige;
  art: SchrittArt;
  /** Nur für die Höhe im Bild; `null` = kein Balken (keine Zahl, nie eine Null). */
  hoehe: number | null;
  /** „14 von 15 Werten“ — `null` ohne Angabe oder an einem nicht gesprochenen Schritt. */
  erhalten: string | null;
  wert: MessstelleWerteWert;
}

/** Der Kalendertag der Ortszeit, wie die Route ihn schreibt: „03.11.2026“. */
const datum = (von: string): string => `${von.slice(8, 10)}.${von.slice(5, 7)}.${von.slice(0, 4)}`;

const titelDes = (raster: MessstelleWerteRaster, w: MessstelleWerteWert): string => {
  if (raster === 'jahr') return w.von.slice(0, 4);
  if (raster === 'monat') return monatTitel(w.von);
  if (raster === 'tag') return tagTitel(w.von);
  // Die Stunden einer Woche nennen ihren Tag; die Viertelstunden stehen unter dem Tag der Zeit-Leiste.
  const beschriftung = w.beschriftung ?? w.von;
  return raster === 'stunde' ? `${tagTitel(w.von, false)} ${beschriftung}` : beschriftung;
};

const kurzDes = (raster: MessstelleWerteRaster, w: MessstelleWerteWert): string => {
  if (raster === 'jahr') return w.von.slice(0, 4);
  if (raster === 'monat') return MONATE[Number(w.von.slice(5, 7)) - 1].slice(0, 3);
  if (raster === 'tag') return `${w.von.slice(8, 10)}.`;
  return (w.beschriftung ?? w.von.slice(11, 16)).slice(0, 5);
};

/** „14 von 15 Werten“ — gezählt hat die Route; hier stehen nur ihre zwei Zahlen im Satz. */
export const erhaltenText = (w: Pick<MessstelleWerteWert, 'erhalten' | 'erwartet'>): string | null => {
  if (w.erhalten === null || w.erwartet === null) return null;
  const vorlage = w.erwartet === 1 ? UEMS_ERHALTEN.singular : UEMS_ERHALTEN.plural;
  return vorlage.replace('{erhalten}', zahlText(w.erhalten)).replace('{erwartet}', zahlText(w.erwartet));
};

export const schritte = (antwort: MessstelleWerte): Schritt[] =>
  antwort.werte.map((w, index) => {
    const a = anzeige(antwort, w, false);
    const art: SchrittArt = a.zustand === null ? 'ohne' : (ART_DES_ZUSTANDS[w.zustand ?? ''] ?? 'ohne');
    return {
      index,
      von: w.von,
      bis: w.bis,
      titel: titelDes(antwort.raster, w),
      kurz: kurzDes(antwort.raster, w),
      anzeige: a,
      art,
      hoehe: art !== 'ohne' && w.menge !== null ? Number(w.menge) : null,
      erhalten: art === 'ohne' ? null : erhaltenText(w),
      wert: w,
    };
  });

// ------------------------------------------------------------------ 3 · Lücken als Flächen (V4)

export interface Luecke {
  erster: number;
  letzter: number;
  /** Nennt ein Schritt der Folge ein Ereignis? Sonst spricht der Marker aus den Schritten selbst. */
  verwiesen: boolean;
}

/** Jede Folge von Schritten „keine Werte“ — eine Fläche je Folge. */
export const luecken = (s: readonly Schritt[]): Luecke[] => {
  const out: Luecke[] = [];
  for (const x of s) {
    if (x.art !== 'keine_werte') continue;
    const letzte = out[out.length - 1];
    if (letzte && letzte.letzter === x.index - 1) {
      letzte.letzter = x.index;
      letzte.verwiesen ||= x.wert.ereignisse.length > 0;
    } else {
      out.push({ erster: x.index, letzter: x.index, verwiesen: x.wert.ereignisse.length > 0 });
    }
  }
  return out;
};

// ------------------------------------------------------------------ 4 · Marker (V5, K6)

/** Höchstens drei benannte Marken im Bild — mehr ist Rauschen (K6); jede steht in der Liste. */
export const MARKER_IM_BILD = 3;

export interface Marker {
  schluessel: string;
  satz: string;
  erster: number;
  letzter: number;
  /** 1 … 3 im Bild, `null` = nur in der Liste. */
  nummer: number | null;
}

const PLATZHALTER = /\{(\w+)\}/g;

/** Die Felder, die die Werte-Route an einem Ereignis liefert ({id, art, von, bis}). */
const FELDER_DER_ROUTE = new Set(['von', 'bis']);

const fuelle = (vorlage: string, werte: Record<string, string>): string =>
  vorlage.replace(PLATZHALTER, (_, feld: string) => werte[feld]);

/**
 * Der Satz eines Ereignisses der Werte-Route. Braucht der Standard-Satz der Art nur `von`/`bis` (die Lücke), spricht
 * ihn das Vokabular selbst. Braucht er Felder, die die Route nicht liefert (Zählerwechsel, Übergabe …), steht der
 * Name der Art mit ihrer Zeit — nie ein geratenes Feld. Eine Art außerhalb des Vokabulars: `null` (nicht gesprochen).
 */
export const markerSatz = (e: { art: string; von: string; bis: string | null }, zone: string): string | null => {
  const text = (EREIGNIS_TEXTE as Record<string, ArtText | undefined>)[e.art];
  if (text === undefined) return null;
  const offen = text.zeitraum && e.bis === null;
  const vorlage = text.varianteNach === null ? text.saetze[offen ? 'standard_offen' : 'standard'] : undefined;
  if (vorlage !== undefined && [...vorlage.matchAll(PLATZHALTER)].every((m) => FELDER_DER_ROUTE.has(m[1]))) {
    return ereignisSatz({ art: e.art, von: e.von, bis: e.bis }, {}, zone);
  }
  const von = zeitText(e.von, zone);
  if (e.bis !== null) return fuelle(UEMS_EREIGNIS_VON_BIS, { name: text.name, von, bis: zeitText(e.bis, zone, e.von) });
  return fuelle(text.zeitraum ? UEMS_EREIGNIS_SEIT : UEMS_EREIGNIS_AM, { name: text.name, von });
};

/** „keine Werte von 14:15 bis 17:30“ aus den Schritten der Folge — ohne Ursache (V4). */
const lueckenSatz = (raster: MessstelleWerteRaster, s: readonly Schritt[], l: Luecke, zone: string): string => {
  const a = s[l.erster];
  const b = s[l.letzter];
  if (raster === 'viertelstunde' || raster === 'stunde') {
    return fuelle(UEMS_KEINE_WERTE_VON_BIS, { von: zeitText(a.von, zone), bis: zeitText(b.bis, zone, a.von) });
  }
  const text = raster === 'tag' ? datum : raster === 'monat' ? monatTitel : (v: string) => v.slice(0, 4);
  if (l.erster === l.letzter) return fuelle(raster === 'tag' ? UEMS_KEINE_WERTE_AM : UEMS_KEINE_WERTE_IM, { von: text(a.von) });
  return fuelle(UEMS_KEINE_WERTE_VON_BIS, { von: text(a.von), bis: text(b.von) });
};

/** Die Marker des Bildes: jedes Ereignis EINMAL (Kennung), dazu jede Lücke ohne verwiesenes Ereignis — nach Beginn. */
export const marker = (antwort: MessstelleWerte, s: readonly Schritt[], l: readonly Luecke[]): Marker[] => {
  const zone = antwort.zeitzone;
  const ereignisse = new Map<string, { von: string; satz: string; erster: number; letzter: number }>();
  for (const x of s) {
    for (const e of x.wert.ereignisse) {
      const da = ereignisse.get(e.id);
      if (da) {
        da.letzter = x.index;
        continue;
      }
      const satz = markerSatz(e, zone);
      if (satz !== null) ereignisse.set(e.id, { von: e.von, satz, erster: x.index, letzter: x.index });
    }
  }
  const alle = [
    ...[...ereignisse.entries()].map(([id, e]) => ({ schluessel: id, ...e })),
    ...l
      .filter((x) => !x.verwiesen)
      .map((x) => ({
        schluessel: `luecke-${s[x.erster].von}`,
        von: s[x.erster].von,
        satz: lueckenSatz(antwort.raster, s, x, zone),
        erster: x.erster,
        letzter: x.letzter,
      })),
  ].sort((a, b) => a.erster - b.erster || Date.parse(a.von) - Date.parse(b.von));
  return alle.map(({ schluessel, satz, erster, letzter }, i) => ({
    schluessel,
    satz,
    erster,
    letzter,
    nummer: i < MARKER_IM_BILD ? i + 1 : null,
  }));
};

// ------------------------------------------------------------------ 5 · Kernaussage, Tooltip, Schritt-Karte (V6, K1, K7)

/**
 * Der Kernaussage-Satz über dem Diagramm, abgeleitet aus der Karte der Periode (V6): „Di 03.11.2026: 2.304 kWh ·
 * vollständig · vorläufig“. Ohne Zahl nennt er den Grund „noch nicht gerechnet“; jeder andere Grund bleibt ohne Satz
 * (K1: der Kopf rendert dann nichts — die Karte zeigt den Strich). Die Woche hat keine Zahl und sagt, warum.
 */
export const kernaussage = (zeitraum: Zeitraum, periode: MessstelleWerte | null): Kernaussage | null => {
  if (zeitraum === 'woche') return { wert: null, satz: null, grund: UEMS_WOCHE_OHNE_ZAHL, ton: 'calm' };
  const k = periode ? karte(periode) : null;
  const w = periode?.werte[0];
  if (!periode || !k || !w) return null;
  const a = anzeige(periode, w, false);
  if (a.zustand === null) {
    if (w.grund !== 'noch_nicht_gebildet') return null;
    return { wert: null, satz: null, grund: `${k.titel}: ${[OHNE_ZAHL, UEMS_NOCH_NICHT_GERECHNET].join(TRENNER)}`, ton: 'calm' };
  }
  const teile = [a.zahl, a.zustand, k.fassung].filter((t): t is string => t !== null);
  return { wert: null, satz: `${k.titel}: ${teile.join(TRENNER)}`, grund: null, ton: w.zustand === VOLLSTAENDIG ? 'ok' : 'warn' };
};

/** Der Tooltip als Satz (K7): „17:30–17:45: 22,4 kWh, unvollständig, 14 von 15 Werten.“ */
export const tooltipSatz = (s: Schritt): string =>
  ableseSatz([
    `${s.titel}: ${s.anzeige.zahl}`,
    s.anzeige.zustand ?? (s.wert.grund === 'noch_nicht_gebildet' ? UEMS_NOCH_NICHT_GERECHNET : null),
    s.erhalten,
  ])!;

/**
 * Die Karte eines gewählten Schritts (V3, WerteKarte-Form): Zahl · Zustand samt Herkunft · Verlauf mit „erhalten von
 * erwartet“ · Fassung · Kennzeichen · Grund — dieselbe Ableitung wie die Karte der Periode, nur mit dem Titel des Schritts.
 */
export const schrittKarte = (antwort: MessstelleWerte, s: Schritt): MessstellenKarte => {
  const k = karte({ ...antwort, werte: [s.wert] })!;
  const verlauf = [k.abdeckung, s.erhalten].filter((t): t is string => t !== null);
  return { ...k, titel: s.titel, abdeckung: verlauf.length > 0 ? verlauf.join(TRENNER) : null };
};

// ------------------------------------------------------------------ 6 · Das Bild (K11: 1 Einheit = 1 px)

export const BILD = {
  /** Höhe der Zeichenfläche ohne Marker-Zeilen und Zeitachse. */
  flaeche: 168,
  /** Rand links/rechts. */
  rand: 8,
  /** Die Zeitachse unter der Fläche. */
  achse: 22,
  /** Eine Zeile Marker über der Fläche. */
  markenZeile: 20,
  /** Luft über der obersten Linie (Beschriftung der Skala). */
  oben: 18,
  /** Ab dieser Breite stehen ausführlichere Achsen-Beschriftungen. */
  breit: 560,
  /** Vor der ersten Messung (und in jsdom) — die schmale Bühne passt in jeden Rahmen. */
  vorgabeBreite: 343,
} as const;

export interface Bild {
  breite: number;
  hoehe: number;
  flaeche: { x: number; y: number; w: number; h: number };
  /** Breite je Schritt. */
  schritt: number;
  balken: Array<{ index: number; x: number; y: number; w: number; h: number; art: SchrittArt }>;
  luecken: Array<{ x: number; w: number }>;
  marken: Array<{ nummer: number; x1: number; x2: number; y: number }>;
  /** Die oberste Linie der Skala mit ihrer Zahl (über `menge`, gerundet nur zur Anzeige) und die Nulllinie. */
  skala: { y: number; text: string | null; nullY: number };
  ticks: Array<{ x: number; text: string }>;
}

const STUFEN = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** Die nächste runde Zahl darüber — nur für die Skala des Bildes. */
export const skalaOben = (v: number): number => {
  if (v <= 0) return 0;
  const e = 10 ** Math.floor(Math.log10(v));
  return (STUFEN.find((f) => f * e >= v) ?? 10) * e;
};

const tickIndizes = (raster: MessstelleWerteRaster, s: readonly Schritt[], breit: boolean): number[] => {
  if (raster === 'viertelstunde') {
    // Je Wanduhr die ERSTE Viertelstunde — am 25-Stunden-Tag steht 02:00 nicht zweimal.
    const uhren = breit ? ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00'] : ['00:00', '06:00', '12:00', '18:00'];
    return uhren.map((u) => s.findIndex((x) => x.kurz === u)).filter((i) => i >= 0);
  }
  if (raster === 'stunde') return s.filter((x) => x.kurz === '00:00').map((x) => x.index);
  if (raster === 'tag') return s.filter((x) => ['01.', '08.', '15.', '22.', '29.'].includes(x.kurz)).map((x) => x.index);
  return s.filter((x) => breit || x.index % 3 === 0).map((x) => x.index);
};

const tickText = (raster: MessstelleWerteRaster, x: Schritt, breit: boolean): string => {
  if (raster === 'stunde') return breit ? tagTitel(x.von, false) : tagTitel(x.von, false).slice(0, 2);
  return x.kurz;
};

/** Die Geometrie des Bildes in Pixeln der gemessenen Breite. */
export const bild = (antwort: MessstelleWerte, s: readonly Schritt[], l: readonly Luecke[], m: readonly Marker[], breite: number): Bild => {
  const b = breite > 0 ? breite : BILD.vorgabeBreite;
  const breit = b >= BILD.breit;
  const n = Math.max(1, s.length);
  const w = b - 2 * BILD.rand;
  const schritt = w / n;
  const xVon = (i: number) => BILD.rand + i * schritt;

  // Marker-Zeilen: eine Marke rückt eine Zeile höher, wenn sie der vorigen zu nahe käme.
  const imBild = m.filter((x): x is Marker & { nummer: number } => x.nummer !== null);
  const zeilenEnde: number[] = [];
  const marken = imBild.map((x) => {
    const x1 = xVon(x.erster);
    const x2 = Math.max(x1 + 2, xVon(x.letzter + 1));
    let zeile = zeilenEnde.findIndex((ende) => ende + 24 <= x1);
    if (zeile < 0) zeile = zeilenEnde.length;
    zeilenEnde[zeile] = Math.max(x2, x1 + 20);
    return { nummer: x.nummer, x1, x2, zeile };
  });
  const zeilen = zeilenEnde.length;
  const y = BILD.oben + zeilen * BILD.markenZeile;
  const flaeche = { x: BILD.rand, y, w, h: BILD.flaeche };

  const hoehen = s.map((x) => x.hoehe).filter((h): h is number => h !== null);
  const oben = skalaOben(Math.max(0, ...hoehen));
  const unten = -skalaOben(-Math.min(0, ...hoehen));
  const spanne = oben - unten || 1;
  const yVon = (v: number) => y + ((oben - v) / spanne) * BILD.flaeche;
  const nullY = yVon(0);
  const luft = schritt >= 6 ? 2 : schritt >= 3 ? 1 : 0;

  let skalaText: string | null = null;
  if (oben > 0) {
    try {
      skalaText = menge(oben, antwort.messstelle.einheit, antwort.raster);
    } catch {
      skalaText = null;
    }
  }

  return {
    breite: b,
    hoehe: y + BILD.flaeche + BILD.achse,
    flaeche,
    schritt,
    balken: s
      .filter((x) => x.hoehe !== null)
      .map((x) => {
        const hoch = yVon(Math.max(0, x.hoehe!));
        const tief = yVon(Math.min(0, x.hoehe!));
        return { index: x.index, x: xVon(x.index) + luft / 2, y: hoch, w: Math.max(1, schritt - luft), h: Math.max(1, tief - hoch), art: x.art };
      }),
    luecken: l.map((x) => ({ x: xVon(x.erster), w: (x.letzter - x.erster + 1) * schritt })),
    // Die Marken stehen ÜBER der Skala-Beschriftung: Zeile 0 ganz oben.
    marken: marken.map(({ nummer, x1, x2, zeile }) => ({ nummer, x1, x2, y: BILD.markenZeile / 2 + zeile * BILD.markenZeile })),
    skala: { y: yVon(oben), text: skalaText, nullY },
    ticks: tickIndizes(antwort.raster, s, breit).map((i) => ({ x: xVon(i), text: tickText(antwort.raster, s[i], breit) })),
  };
};
