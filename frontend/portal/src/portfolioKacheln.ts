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
   * bzw. „unverändert ggü. Vorjahr"). `null`, wenn der Pfeil ihn schon trägt
   * oder die Kachel leer ist.
   */
  vergleich: string | null;
}

/** Die Lastspitzen-Kachel: gemessene Spitze + Balken gegen die vereinbarte Leistung. */
export interface SpitzeKachel {
  wert: string;
  einheit: string;
  leer: boolean;
  satz: string;
  fuellProzent: number | null;
}

/** Das ganze Raster, fertig zum Rendern. */
export interface PortfolioKachelRaster {
  periodeWort: string;
  leit: LeitKachel | null;
  verbrauch: VergleichKachel;
  lastspitze: SpitzeKachel;
  kosten: VergleichKachel;
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

function verbrauchKachel(v: PortfolioKpi['verbrauch'], bezug: string): VergleichKachel {
  if (v.kwh == null) {
    return { wert: STRICH, einheit: '', leer: true, satz: 'noch keine Ablesung', trend: null, vergleich: null };
  }
  const t = trend(v.kwh, v.kwh_vorjahr, 'ggü. Vorjahr');
  return {
    wert: fmtNum(v.kwh, '', 0),
    einheit: 'kWh',
    leer: false,
    satz: `Netzbezug · ${bezug}`,
    trend: t,
    vergleich: t ? null : vorjahrErsatz(v.kwh_vorjahr),
  };
}

function kostenKachel(k: PortfolioKpi['kosten'], bezug: string): VergleichKachel {
  if (!k.tarif_hinterlegt) {
    return { wert: STRICH, einheit: '', leer: true, satz: 'kein Tarif hinterlegt', trend: null, vergleich: null };
  }
  if (k.eur == null) {
    return { wert: STRICH, einheit: '', leer: true, satz: 'noch keine Ablesung', trend: null, vergleich: null };
  }
  const t = trend(k.eur, k.eur_vorjahr, 'ggü. Vorjahr');
  return {
    wert: fmtNum(k.eur, '', 0),
    einheit: '€',
    leer: false,
    satz: `aus Tarif · ${bezug}`,
    trend: t,
    vergleich: t ? null : vorjahrErsatz(k.eur_vorjahr),
  };
}

function lastspitzeKachel(s: PortfolioKpi['lastspitze'], bezug: string): SpitzeKachel {
  if (s.kw == null) {
    return { wert: STRICH, einheit: '', leer: true, satz: `keine Lastdaten · ${bezug}`, fuellProzent: null };
  }
  const satz = s.vereinbart_kw != null ? `von ${fmtNum(s.vereinbart_kw, '', 0)} kW vereinbart` : 'gemessene Spitze';
  return {
    wert: fmtNum(s.kw, '', 0),
    einheit: 'kW',
    leer: false,
    satz,
    fuellProzent: s.anteil_prozent == null ? null : Math.min(100, Math.max(0, s.anteil_prozent)),
  };
}

/** Baut das fertige Kachelraster aus den rohen Portfolio-Aggregaten. */
export function portfolioKacheln(kpi: PortfolioKpi): PortfolioKachelRaster {
  const bezug = periodeWort(kpi.periode.jahr, kpi.periode.monat);
  return {
    periodeWort: bezug,
    leit: leitKachel(kpi.leit),
    verbrauch: verbrauchKachel(kpi.verbrauch, bezug),
    lastspitze: lastspitzeKachel(kpi.lastspitze, bezug),
    kosten: kostenKachel(kpi.kosten, bezug),
  };
}
