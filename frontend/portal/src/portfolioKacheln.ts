/**
 * DAS KACHELRASTER-MODELL der UEMS-Übersicht (Konzept `data/vp-portfolio-konzept2-p2`
 * §4.2): macht aus den rohen {@link PortfolioKpi}-Aggregaten die vier Leitkacheln -
 * Leitkennzahl (EnPI gegen Ziel), Energieverbrauch, Lastspitze und Energiekosten -
 * fertig formatiert in der Sprache des Portals.
 *
 * Reines Modul (AGENTS.md „Fachableitungen bleiben reine Module; Komponenten
 * rendern ihr Ergebnis"): kein React, kein Netz, keine Uhr. Rundung nur zur Anzeige
 * (AP-08, `de-DE`); ein fehlender Wert steht als „–" OHNE Einheit (nie 0), und eine
 * Kachel ohne Grundlage trägt einen ehrlichen Satz (kein Tarif, keine Lastdaten).
 */
import type { PortfolioKpi } from './api';
import { fmtNum } from './format';

/** Der Strich für einen fehlenden Wert (U+2013), ohne Einheit - überall gleich. */
const STRICH = '–';

const MONATE = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
] as const;

/** Ein Vergleich gegen einen früheren Zeitraum: Pfeilrichtung + Prozent (neutral, kein Urteil). */
export interface Trend {
  prozent: string;
  richtung: 'rauf' | 'runter';
  bezug: string;
}

/** Das Urteil der Leitkennzahl gegen ihre Bezugsbasis (gefärbt). */
export interface Urteil {
  wort: string;
  ton: 'ok' | 'warn' | 'neutral';
}

/** Die Leitkachel: der EnPI gegen sein Ziel. */
export interface LeitKachel {
  kennzeichen: string;
  name: string;
  wert: string;
  einheit: string;
  leer: boolean;
  stand: string;
  ziel: string | null;
  trend: Trend | null;
  urteil: Urteil | null;
}

/** Eine Kachel mit einer Zahl und einem Vorjahresvergleich (Verbrauch, Kosten). */
export interface VergleichKachel {
  wert: string;
  einheit: string;
  leer: boolean;
  /** Der Bezugszeitraum/Kontext unter der Zahl („Netzbezug · September 2026") bzw. der ehrliche Leersatz. */
  satz: string | null;
  /** Der Vorjahresvergleich als gefärbter Pfeil, wenn er belastbar ist. */
  trend: Trend | null;
  /**
   * Review PR2 §4 — jede Kachel trägt einen Vergleich: fehlt ein belastbarer
   * Pfeil, steht hier der ehrliche Ersatzsatz („Vorjahr noch nicht verfügbar"
   * bzw. „unverändert ggü. Vorjahr"), bei unvollständiger Messung „unvollständig
   * gemessen". `null`, wenn der Pfeil ihn schon trägt oder die Kachel leer ist.
   */
  vergleich: string | null;
  /**
   * Review R2 §B2: ob die Menge vollständig gemessen ist. Bei `false` kennzeichnet
   * die Kachel „unvollständig gemessen" und unterdrückt den Vorjahrespfeil (eine
   * Teilmenge gegen das volle Vorjahr wäre irreführend).
   */
  vollstaendig: boolean;
}

/** Die Lastspitzen-Kachel: höchste Spitze im Abrechnungszeitraum + Balken gegen die vereinbarte Leistung. */
export interface SpitzeKachel {
  wert: string;
  einheit: string;
  leer: boolean;
  satz: string;
  /** Review R2 §B3: die Anlage der Spitze — eigene Zeile, Name gegen Umbruch geschützt; null ohne Daten. */
  anlage: string | null;
  fuellProzent: number | null;
  /** „höchste Spitze 2026 · 05.10. 20:15" — Abrechnungszeitraum + Zeitpunkt der Spitze; null ohne Daten. */
  wann: string | null;
}

/** Die Datenlage-Kachel: wie viele Messstellen aktuell Daten liefern (Konzept-Set §4.2). */
export interface DatenlageKachel {
  wert: string;
  einheit: string;
  leer: boolean;
  satz: string;
  ton: 'ok' | 'warn' | 'neutral';
}

/** Das ganze Raster, fertig zum Rendern. */
export interface PortfolioKachelRaster {
  periodeWort: string;
  leit: LeitKachel | null;
  verbrauch: VergleichKachel;
  lastspitze: SpitzeKachel;
  kosten: VergleichKachel;
  datenlage: DatenlageKachel | null;
}

function periodeWort(jahr: number, monat: number): string {
  const name = MONATE[monat - 1] ?? '';
  return name ? `${name} ${jahr}` : String(jahr);
}

/** Der Vorjahres-/Vormonatsvergleich als Pfeil + Prozent; null ohne belastbaren Vergleich. */
function trend(jetzt: number | null, frueher: number | null, bezug: string): Trend | null {
  if (jetzt == null || frueher == null || frueher === 0) {
    return null;
  }
  const delta = ((jetzt - frueher) / frueher) * 100;
  // Unter einem halben Prozent: kein Pfeil - ruhiger und ehrlich (keine Scheingenauigkeit).
  if (Math.abs(delta) < 0.5) {
    return null;
  }
  return { prozent: fmtNum(Math.abs(delta), '', 0), richtung: delta > 0 ? 'rauf' : 'runter', bezug };
}

function urteilAnsicht(u: string | null | undefined): Urteil | null {
  switch (u) {
    case 'besser':
      return { wort: 'besser als die Bezugsbasis', ton: 'ok' };
    case 'schlechter':
      return { wort: 'über der Bezugsbasis', ton: 'warn' };
    case 'im_rahmen':
      return { wort: 'im Rahmen der Bezugsbasis', ton: 'neutral' };
    default:
      return null;
  }
}

function leitKachel(l: PortfolioKpi['leit']): LeitKachel | null {
  if (!l) {
    return null;
  }
  const ziel = l.ziel_wortlaut
    ? `Ziel: ${l.ziel_wortlaut}`
    : l.ziel_prozent != null
      ? `Ziel: ${fmtNum(l.ziel_prozent, '', 0)} % unter Bezugsbasis`
      : null;
  return {
    kennzeichen: l.kennzeichen,
    name: l.name,
    wert: l.wert == null ? STRICH : fmtNum(l.wert, '', 2),
    einheit: l.wert == null ? '' : (l.einheit ?? ''),
    leer: l.wert == null,
    stand: `Stand ${periodeWort(l.jahr, l.monat)}`,
    ziel,
    trend: vormonatsTrend(l),
    urteil: urteilAnsicht(l.urteil),
  };
}

/** Der Trend kommt fertig aus dem Backend (`trend_prozent`, jüngster Wert vs. Vormonat). */
function vormonatsTrend(l: NonNullable<PortfolioKpi['leit']>): Trend | null {
  if (l.trend_prozent == null || Math.abs(l.trend_prozent) < 0.5) {
    return null;
  }
  return {
    prozent: fmtNum(Math.abs(l.trend_prozent), '', 0),
    richtung: l.trend_prozent > 0 ? 'rauf' : 'runter',
    bezug: 'ggü. Vormonat',
  };
}

/**
 * Der ehrliche Ersatz für den Pfeil, wenn kein belastbarer Vorjahresvergleich
 * möglich ist (Review PR2 §4): kein Vorjahreswert → „noch nicht verfügbar",
 * sonst ein flacher Verlauf → „unverändert".
 */
function vorjahrErsatz(vorjahr: number | null): string {
  return vorjahr == null || vorjahr === 0 ? 'Vorjahr noch nicht verfügbar' : 'unverändert ggü. Vorjahr';
}

/** Review R2 §B2: bei unvollständiger Messung „unvollständig gemessen" statt des irreführenden Vorjahresvergleichs. */
function vergleichBei(vollstaendig: boolean, trendDa: boolean, vorjahr: number | null): string | null {
  if (!vollstaendig) {
    return 'unvollständig gemessen';
  }
  return trendDa ? null : vorjahrErsatz(vorjahr);
}

function verbrauchKachel(v: PortfolioKpi['verbrauch'], bezug: string): VergleichKachel {
  if (v.kwh == null) {
    return { wert: STRICH, einheit: '', leer: true, satz: 'noch keine Ablesung', trend: null, vergleich: null, vollstaendig: true };
  }
  // Review R2 §B2: bei unvollständiger Menge keinen Vorjahrespfeil (Teilmenge gegen volles Vorjahr wäre irreführend).
  const t = v.vollstaendig ? trend(v.kwh, v.kwh_vorjahr, 'ggü. Vorjahr') : null;
  return {
    wert: fmtNum(v.kwh, '', 0),
    einheit: 'kWh',
    leer: false,
    satz: `Netzbezug · ${bezug}`,
    trend: t,
    vergleich: vergleichBei(v.vollstaendig, t != null, v.kwh_vorjahr),
    vollstaendig: v.vollstaendig,
  };
}

function kostenKachel(k: PortfolioKpi['kosten'], bezug: string, vollstaendig: boolean): VergleichKachel {
  if (!k.tarif_hinterlegt) {
    return { wert: STRICH, einheit: '', leer: true, satz: 'kein Tarif hinterlegt', trend: null, vergleich: null, vollstaendig: true };
  }
  if (k.eur == null) {
    return { wert: STRICH, einheit: '', leer: true, satz: 'noch keine Ablesung', trend: null, vergleich: null, vollstaendig: true };
  }
  // Kosten = Menge × Tarif: ist die Menge unvollständig, ist es die Kostensumme auch.
  const t = vollstaendig ? trend(k.eur, k.eur_vorjahr, 'ggü. Vorjahr') : null;
  return {
    wert: fmtNum(k.eur, '', 0),
    einheit: '€',
    leer: false,
    satz: `aus Tarif · ${bezug}`,
    trend: t,
    vergleich: vergleichBei(vollstaendig, t != null, k.eur_vorjahr),
    vollstaendig,
  };
}

/**
 * Zeitpunkt der Spitze als „05.10. 20:15" (Europe/Berlin, de-DE) — rein aus dem
 * gegebenen ISO-Zeitpunkt, keine Uhr. Null bei fehlendem/ungültigem Zeitpunkt.
 */
function fmtWann(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  const datum = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Berlin' });
  const zeit = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  return `${datum} ${zeit}`;
}

/**
 * Review R2 (Pixel): den Anlagennamen nicht zerreißen — das LETZTE Leerzeichen durch ein
 * geschütztes ersetzen, damit ein angehängtes Wort/Zahl („Halle 1") nicht allein umbricht.
 * Nur das letzte Leerzeichen, damit lange Namen trotzdem umbrechen können (kein Überlauf).
 */
function nameZusammen(name: string): string {
  return name.replace(/ (\S+)$/u, ' $1');
}

function lastspitzeKachel(s: PortfolioKpi['lastspitze']): SpitzeKachel {
  // Review PR3 §1: die Spitze bezieht sich auf den laufenden ABRECHNUNGSZEITRAUM
  // (Leistungspreis-Basis), nicht auf einen Kalendermonat — `zeitraum` ist das Label.
  const raum = s.zeitraum ?? null;
  if (s.kw == null) {
    return { wert: STRICH, einheit: '', leer: true, satz: raum ? `keine Lastdaten · ${raum}` : 'keine Lastdaten', anlage: null, fuellProzent: null, wann: null };
  }
  // Review R2 §B3: die Portfolio-Lastspitze ist die höchste Spitze EINER Anlage samt DEREN vereinbarter Leistung —
  // die Anlage benennen, sonst mischt die Kachel Einzelspitze und Einzel-Vereinbarung ununterscheidbar. Die Anlage
  // steht in EIGENER Zeile (Pixel-Review R2) und ihr Name bleibt gegen Umbruch geschützt, damit „Halle 1" zusammenbleibt.
  const grund = s.vereinbart_kw != null ? `von ${fmtNum(s.vereinbart_kw, '', 1)} kW vereinbart` : 'gemessene Spitze';
  const zeit = fmtWann(s.zeitpunkt);
  const wann = raum ? (zeit ? `höchste Spitze ${raum} · ${zeit}` : `höchste Spitze ${raum}`) : zeit;
  return {
    // Review R2 §B4: gemessene kW mit 1 Nachkommastelle (AP-08), wie die Anlagenkarte.
    wert: fmtNum(s.kw, '', 1),
    einheit: 'kW',
    leer: false,
    satz: grund,
    anlage: s.anlage ? nameZusammen(s.anlage) : null,
    fuellProzent: s.anteil_prozent == null ? null : Math.min(100, Math.max(0, s.anteil_prozent)),
    wann,
  };
}

/** Review PR3 §2: die Datenlage-Kachel — wie viele Messstellen aktuell Daten liefern. */
function datenlageKachel(d: PortfolioKpi['datenlage']): DatenlageKachel | null {
  if (!d || d.gesamt == null || d.gesamt === 0) {
    return null;
  }
  const aktuell = d.aktuell ?? 0;
  const voll = aktuell >= d.gesamt;
  return {
    wert: `${fmtNum(aktuell, '', 0)}/${fmtNum(d.gesamt, '', 0)}`,
    einheit: 'Messstellen',
    leer: false,
    satz: voll ? 'vollständig · aktuell' : `${fmtNum(d.gesamt - aktuell, '', 0)} ohne aktuelle Daten`,
    ton: voll ? 'ok' : 'warn',
  };
}

/** Baut das fertige Kachelraster aus den rohen Portfolio-Aggregaten. */
export function portfolioKacheln(kpi: PortfolioKpi): PortfolioKachelRaster {
  const bezug = periodeWort(kpi.periode.jahr, kpi.periode.monat);
  return {
    periodeWort: bezug,
    leit: leitKachel(kpi.leit),
    verbrauch: verbrauchKachel(kpi.verbrauch, bezug),
    lastspitze: lastspitzeKachel(kpi.lastspitze),
    kosten: kostenKachel(kpi.kosten, bezug, kpi.verbrauch.vollstaendig),
    datenlage: datenlageKachel(kpi.datenlage),
  };
}
