/**
 * M4 — die **Erlös-Komposition** ("Projektion", OpenProject #532, Epic #527).
 *
 * Geld ist eine **Komposition von Strömen**, kein neuer Rechenkern
 * (report §1.4): jeder aktive Modus benennt seinen Strom, und jeder Strom liest
 * aus **bestehenden** Earnings-Feldern —
 * Eigenverbrauch → `eigenverbrauchsWertEur` + `einspeiseErloesEur`,
 * Marktvermarktung → `savedEur`/`arbitrageEur` (+ Marktprämie im Kleingedruckten),
 * Lastspitzenkappung → `peakShaving.avoidedEur`,
 * Automationen → ein ehrliches **„—"** (eine €-Zurechnung je Regel gibt es
 * nicht, E15 ist nicht gebaut). Hier wird NICHTS neu gerechnet und NICHTS
 * erfunden.
 *
 * **Die Perioden-Ehrlichkeit ist die tragende Regel dieses Moduls**
 * (report §1.4 + §9): vermiedene Leistungskosten sind ein **Stand der
 * laufenden Abrechnungsperiode**, EV-/Handelswerte sind **Zeitraum**-Werte
 * (Tag/Monat/Jahr). Deshalb
 *  1. trägt JEDE Zeile ihr eigenes Perioden-Etikett,
 *  2. gibt es **eine Summe je Periode** — quer über Perioden wird NIE addiert,
 *  3. und sobald mehrere Perioden im Stapel stehen, sagt eine Zeile das laut.
 *
 * Reines Daten-/Logikmodul (der `live.ts`/`moduleSurface.ts`-Präzedenzfall):
 * kein React, kein Netzwerk. Es KONSUMIERT das M0-Read-Model
 * (`surface.ts` `moneyStreams(modes)`) und leitet Modi nicht neu ab.
 *
 * Die **Erlös-Historie** ist der Drill-in dieses Blocks (money-modus-gebunden)
 * und bleibt sauber getrennt von der **Telemetrie-Historie**, die zu
 * `base(entities)` gehört und in JEDEM Modus existiert (feedback.md Punkt 2).
 */

import type {
  EarningsRange,
  EarningsSite,
  PeakShaving,
  SiteEarnings,
  SiteEarningsBucket,
} from './api';
import { coveredSinceLabel, periodLabel } from './anlage';
import { eurAmount, fmtNum } from './format';
import { marktpraemie } from './marktpraemie';
import type { MoneyStream, MoneyStreamId, StreamPeriod } from './surface';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/**
 * Warum eine Zeile keine Zahl zeigt:
 *  - `value` — eine echte, gemessene Zahl;
 *  - `unattributed` — es EXISTIERT keine Zurechnung (Automationen, E15);
 *  - `unavailable` — der Wert ist (noch) nicht berechenbar (keine Messwerte,
 *    kein Tarif hinterlegt, Modul erst frisch aktiv).
 * Beide Nicht-Zahl-Zustände rendern „—", niemals eine 0.
 */
export type StreamValueState = 'value' | 'unattributed' | 'unavailable';

/** Eine Zeile des Strom-Stapels — vollständig abgeleitet, render-fertig. */
export interface StreamRow {
  id: MoneyStreamId;
  label: string;
  /** Der Betrag in €; null in JEDEM Nicht-`value`-Zustand. */
  eur: number | null;
  /** "1.204,00 €" bzw. der Gedankenstrich. */
  valueText: string;
  state: StreamValueState;
  period: StreamPeriod;
  /** Das Perioden-Etikett DIESER Zeile ("Juli" / "Abrechnungsjahr 2026"). */
  periodLabel: string;
  /** Balkenanteil 0..1 — relativ zur größten Zeile DERSELBEN Periode. */
  barFraction: number;
  /** CSS-Farbe (Token-`var()`), damit Punkt und Balken zusammenpassen. */
  hue: string;
  /** Optionale ruhige Detailzeile (Arbitrage-Anteil, Marktprämie, Hinweis). */
  note: string | null;
}

/** Die Summe EINER Periode — es gibt bewusst keine periodenübergreifende. */
export interface PeriodTotal {
  period: StreamPeriod;
  /** "Juli gesamt" / "Abrechnungsjahr 2026 gesamt". */
  label: string;
  eur: number | null;
  valueText: string;
  /** Wie viele Zeilen wirklich in diese Summe eingegangen sind. */
  contributingRows: number;
}

/** Der Drill-in in die Geld-Tiefe — die **Erlös**-Historie. */
export interface ErloesDrillIn {
  label: string;
  /** Die Abgrenzung zur Telemetrie-Historie, sichtbar im UI. */
  hint: string;
}

/** Die fertige Erlös-Komposition. */
export interface ErloesKompositionView {
  /** Überschrift inkl. Zeitraum: "Ertrag · Juli — alle Ströme". */
  title: string;
  rows: StreamRow[];
  /** Eine Summe JE Periode (report §1.4). */
  totals: PeriodTotal[];
  /**
   * Der laute Hinweis, sobald der Stapel mehrere Perioden mischt — ohne ihn
   * wäre eine Gesamtzahl unehrlich.
   */
  periodNote: string | null;
  /** Erklärt das ehrliche „—" — nur wenn es eine solche Zeile gibt. */
  footnote: string | null;
  drillIn: ErloesDrillIn | null;
  /** true = es gibt nichts zu zeigen (kein Geld-Modus) → Block entfällt. */
  isEmpty: boolean;
}

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

/** Der Gedankenstrich — die einzige erlaubte Nicht-Zahl. */
export const DASH = '—';

export const ERLOES_HISTORIE: ErloesDrillIn = {
  label: 'Erlöse im Detail',
  // Die Trennung aus feedback.md Punkt 2 steht sichtbar im UI, nicht nur im Code.
  hint: 'Erlös-Historie – getrennt vom Telemetrie-Verlauf.',
};

export const UNATTRIBUTED_FOOTNOTE =
  'Jeder Strom kommt aus einem Modus. Wo „—" steht, gibt es noch keine Zurechnung je Regel – erfunden wird nichts.';

/**
 * Die Earnings-Felder, aus denen eine Zeile liest. Das MUSS deckungsgleich mit
 * dem `sources`-Feld des M0-Manifests bleiben (drift-gesichert im Test) — das
 * Manifest ist die Wahrheit, hier steht nur die Auflösung.
 */
export const STREAM_SOURCES: Record<MoneyStreamId, string[]> = {
  eigenverbrauchswert: ['eigenverbrauchsWertEur'],
  einspeisung: ['einspeiseErloesEur'],
  handel: ['savedEur', 'arbitrageEur'],
  lastspitzen: ['peakShaving.avoidedEur'],
  automation: [],
};

/** Farbe je Strom — die `--vp-flow-*`-Kanalfarben, wie im Konzept-Mock. */
const STREAM_HUE: Record<MoneyStreamId, string> = {
  lastspitzen: 'var(--vp-flow-pv)',
  handel: 'var(--vp-flow-grid)',
  eigenverbrauchswert: 'var(--vp-flow-batt)',
  einspeisung: 'var(--vp-primary)',
  automation: 'var(--vp-flow-load)',
};

// ---------------------------------------------------------------------------
// Perioden-Etiketten
// ---------------------------------------------------------------------------

function isoYear(iso: string): string {
  return iso.slice(0, 4);
}

/**
 * Das Etikett der Abrechnungsperiode aus dem PS-4-Block. Ohne den Block bleibt
 * es beim neutralen "Abrechnungsperiode" — nie ein erfundener Zeitraum.
 */
export function billingPeriodLabel(
  money: { peakShaving?: PeakShaving | null } | null | undefined,
): string {
  const ps = money?.peakShaving;
  if (!ps?.periodStart) return 'Abrechnungsperiode';
  if (ps.abrechnung === 'monat') {
    const d = new Date(`${ps.periodStart.slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return 'Abrechnungsperiode';
    return `Abrechnungsmonat ${d.toLocaleDateString('de-DE', { month: 'long' })} ${isoYear(ps.periodStart)}`;
  }
  return `Abrechnungsjahr ${isoYear(ps.periodStart)}`;
}

// ---------------------------------------------------------------------------
// Wert-Auflösung je Strom
// ---------------------------------------------------------------------------

interface Resolved {
  eur: number | null;
  note: string | null;
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Die Zurechnungs-Zeile UNTER dem Erlös: was VoltPilots Steuerung an diesem
 * Erlös beigetragen hat (MIG §5). Sie ist bewusst **kein eigener Summand** —
 * `savedEur` ist das Delta gegenüber einer ungeregelten Anlage und steckt
 * bereits im Erlös. Null (kein Wert / rauschfrei 0) → keine Zeile, nie eine 0.
 */
export function steeringAttributionNote(savedEur: number | null | undefined): string | null {
  const eur = num(savedEur ?? null);
  if (eur == null || Math.abs(eur) < 0.005) return null;
  return eur > 0
    ? `davon ${eurAmount(eur)} durch VoltPilots Steuerung`
    : `VoltPilots Steuerung: ${eurAmount(eur)} in diesem Zeitraum`;
}

function resolve(stream: MoneyStream, money: EarningsSite | null): Resolved {
  if (!money) return { eur: null, note: null };
  switch (stream.id) {
    case 'eigenverbrauchswert':
      return { eur: num(money.eigenverbrauchsWertEur), note: null };
    case 'einspeisung': {
      // Die Marktprämie steckt bereits IM Einspeise-Erlös - das gehört ins
      // Kleingedruckte, nicht in eine eigene erfundene Zeile (report §1.4).
      const praemie =
        num(money.anzulegenderWertCtKwh) != null
          ? 'inkl. Marktprämie (anzulegender Wert hinterlegt)'
          : null;
      const steering =
        stream.attribution === 'steering' ? steeringAttributionNote(money.savedEur) : null;
      return {
        eur: num(money.einspeiseErloesEur),
        note: [steering, praemie].filter(Boolean).join(' · ') || null,
      };
    }
    case 'handel': {
      const saved = num(money.savedEur);
      const arbitrage = num(money.arbitrageEur);
      return {
        eur: saved,
        note: arbitrage != null ? `davon Netzladen: ${eurAmount(arbitrage)}` : null,
      };
    }
    case 'lastspitzen':
      return { eur: num(money.peakShaving?.avoidedEur), note: null };
    default:
      // Automationen: es gibt keine Quelle - der Zustand entscheidet, nicht der Wert.
      return { eur: null, note: null };
  }
}

// ---------------------------------------------------------------------------
// Die Komposition
// ---------------------------------------------------------------------------

export interface ErloesKompositionInput {
  /** Die Ströme der aktiven Modi — `moneyStreams(activeModes(site))` aus M0. */
  streams: MoneyStream[];
  /** Die Earnings-Zeile dieser Anlage; null = noch nicht geladen. */
  money: EarningsSite | null;
  /** Der gewählte Zeitraum der Seite. */
  range: EarningsRange;
  /** Der Anker des Zeitraums (angetippter Monat), Standard: jetzt. */
  at?: Date;
  now?: Date;
}

/**
 * Baut den Strom-Stapel. Reihenfolge = die Modus-Reihenfolge aus M0 (kanonisch,
 * nie €-gewichtet — kein tägliches Umsortieren, kein Flackern).
 */
export function erloesKomposition(input: ErloesKompositionInput): ErloesKompositionView {
  const now = input.now ?? new Date();
  const at = input.at ?? now;
  const rangeLabel = periodLabel(input.range, at, now);
  const billingLabel = billingPeriodLabel(input.money);
  const labelFor = (p: StreamPeriod) => (p === 'billing-period' ? billingLabel : rangeLabel);
  // V4/V13: „Gesamt gesamt" -> „seit 3. Juli 2026" (nennt zugleich, warum
  // Monat/Jahr/Gesamt auf einer jungen Anlage dieselbe Zahl tragen).
  const sinceLabel =
    input.range === 'all' ? coveredSinceLabel(input.money?.firstCoveredDate) : null;
  const totalCaption = (p: StreamPeriod) =>
    p === 'range' && sinceLabel ? sinceLabel : `${labelFor(p)} gesamt`;

  const rows: StreamRow[] = (input.streams ?? []).map((s) => {
    const { eur, note } = s.unattributed
      ? { eur: null, note: null }
      : resolve(s, input.money);
    const state: StreamValueState = s.unattributed
      ? 'unattributed'
      : eur == null
        ? 'unavailable'
        : 'value';
    return {
      id: s.id,
      label: s.label,
      eur: state === 'value' ? eur : null,
      valueText: state === 'value' ? eurAmount(eur as number) : DASH,
      state,
      period: s.period,
      periodLabel: labelFor(s.period),
      barFraction: 0,
      hue: STREAM_HUE[s.id] ?? 'var(--vp-primary)',
      note: state === 'value' ? note : state === 'unavailable' ? 'Noch keine Daten.' : null,
    };
  });

  // Balken NUR innerhalb einer Periode skalieren - ein Jahresstand darf einen
  // Monatswert nicht optisch erschlagen (und umgekehrt).
  for (const period of ['range', 'billing-period'] as StreamPeriod[]) {
    const group = rows.filter((r) => r.period === period && r.eur != null);
    const max = Math.max(0, ...group.map((r) => Math.abs(r.eur as number)));
    if (max <= 0) continue;
    for (const r of group) r.barFraction = Math.abs(r.eur as number) / max;
  }

  // Eine Summe JE Periode - quer wird nie addiert (report §1.4).
  const totals: PeriodTotal[] = [];
  for (const period of ['range', 'billing-period'] as StreamPeriod[]) {
    const group = rows.filter((r) => r.period === period);
    if (group.length === 0) continue;
    const contributing = group.filter((r) => r.eur != null);
    const sum = contributing.reduce((acc, r) => acc + (r.eur as number), 0);
    totals.push({
      period,
      label: totalCaption(period),
      eur: contributing.length > 0 ? sum : null,
      valueText: contributing.length > 0 ? eurAmount(sum) : DASH,
      contributingRows: contributing.length,
    });
  }

  const periodNote =
    totals.length > 1
      ? `Verschiedene Zeiträume: ${totals
          .map((t) => labelFor(t.period))
          .join(' und ')} werden getrennt ausgewiesen und nicht zu einer Summe addiert.`
      : null;

  const hasAttributed = rows.some((r) => r.state === 'value');

  return {
    title: `Ertrag · ${rangeLabel} — alle Ströme`,
    rows,
    totals,
    periodNote,
    footnote: rows.some((r) => r.state !== 'value') ? UNATTRIBUTED_FOOTNOTE : null,
    drillIn: hasAttributed ? ERLOES_HISTORIE : null,
    isEmpty: rows.length === 0,
  };
}

// ===========================================================================
// Welt B · die Erlöse-HISTORIE einer Anlage (F1 des Historie-Konzepts)
// ===========================================================================
//
// Der Block oben ist die Komposition des COCKPITS (modusgetrieben, ein Strom je
// aktivem Modus). Was jetzt folgt, ist die Komposition der Erlöse-WELT: derselbe
// Geist (eine Zeile je Geldstrom, „—" statt erfundener Null, nie zwei Perioden
// in einer Summe), aber die Zeilen sind die MESSBAREN Teile eines Zeitraums, die
// der anlagen-scharfe Endpunkt `GET /sites/{id}/earnings` liefert:
//
//     Ergebnis = Einspeise-Erlös + Wert des Eigenverbrauchs − Stromkosten
//
// **Warum die Zurechnung der Steuerung KEIN Summand ist** (MIG §5, dieselbe
// Regel wie im Geld-Hero): `savedEur` ist ein Delta gegenüber einer ungeregelten
// Anlage und steckt bereits IM Erlös — als Geschwister-Zeile würde es doppelt
// zählen. Es steht deshalb als Unterzeile unter der großen Zahl.
//
// **Warum es hier bewusst KEINE „ohne Speicher wären es X €"-Zahl gibt.** Die
// wäre `Ergebnis − savedEur`, und das stimmt nur, solange kein Wert des
// Eigenverbrauchs mitgerechnet wird: eine ungeregelte Anlage verbraucht WENIGER
// selbst (ihr fehlt die Batterie), und diesen Gegenwert kennt der Endpunkt
// nicht. Statt einer fast-richtigen Zahl steht dort die Zurechnung, die exakt
// ist. (Der Entwurf zeigte die Zeile; sie wäre eine Ehrlichkeitsfalle.)

/** Die Zeilen der Ergebnis-Karte — kanonische Reihenfolge, nie €-sortiert. */
export type ErgebnisZeileId =
  | 'einspeisung'
  | 'eigenverbrauchswert'
  | 'stromkosten'
  | 'lastspitzen';

/** Wie eine Zeile ins Ergebnis eingeht — als OPERATOR, nie als Minus am Betrag. */
export type ErgebnisVorzeichen = 'plus' | 'minus';

/** Eine Zeile der Ergebnis-Karte, render-fertig. */
export interface ErgebnisZeile {
  id: ErgebnisZeileId;
  label: string;
  vorzeichen: ErgebnisVorzeichen;
  /** Der Betrag; null = nicht berechenbar (dann steht „—"). */
  eur: number | null;
  /** Der BETRAG ohne Vorzeichen („1.059,40 €") bzw. der Gedankenstrich. */
  valueText: string;
  period: StreamPeriod;
  periodLabel: string;
  /** Balkenanteil 0..1 — relativ zur größten Zeile DERSELBEN Periode. */
  barFraction: number;
  hue: string;
  /** Die ruhige Detailzeile bzw. der Grund für das „—". */
  note: string | null;
}

/** Die fertige Ergebnis-Karte der Erlöse-Welt. */
export interface ErloesErgebnisView {
  /** „Ergebnis · Juli 2026". */
  titel: string;
  /** Das Netto des Zeitraums; null = für diesen Zeitraum nicht berechenbar. */
  nettoEur: number | null;
  /** „+ 999,26 €" / „− 12,40 €" / „—" — Vorzeichen als eigenes Zeichen. */
  nettoText: string;
  /** Ob der Zeitraum unterm Strich eingebracht oder gekostet hat. */
  richtung: 'ertrag' | 'kosten' | null;
  /** Der eine Satz unter der Zahl — sagt, was die Zahl bedeutet. */
  nettoSatz: string;
  /** „davon 161,44 € durch VoltPilots Steuerung" (Zurechnung, kein Summand). */
  steering: string | null;
  /** Der Titel-Text dazu: wogegen die Zurechnung gemessen ist. */
  steeringTitel: string | null;
  rows: ErgebnisZeile[];
  /**
   * Ob der Stapel überhaupt mehrere Perioden mischt. Nur dann trägt jede Zeile
   * ihr Perioden-Etikett sichtbar — sonst steht der Zeitraum schon in der
   * Überschrift, und ihn an jeder Zeile zu wiederholen ist Lärm, kein Beleg.
   */
  mehrerePerioden: boolean;
  /** Laut gesagt, sobald Zeilen verschiedener Perioden im Stapel stehen. */
  periodNote: string | null;
  /** Erklärt das „—" — nur, wenn es eine solche Zeile gibt. */
  footnote: string | null;
  /** Warum es gar nichts zu rechnen gibt (leerer Zeitraum) — sonst null. */
  leerText: string | null;
}

const ERGEBNIS_HUE: Record<ErgebnisZeileId, string> = {
  einspeisung: 'var(--vp-primary)',
  eigenverbrauchswert: 'var(--vp-flow-batt)',
  stromkosten: 'var(--vp-chart-discharge)',
  lastspitzen: 'var(--vp-flow-pv)',
};

/** Warum ein Zeitraum nichts hergibt — in Kundendeutsch, nie ein Code. */
export const LEER_TEXT: Record<string, string> = {
  no_data: 'Für diesen Zeitraum liegen noch keine Messwerte Ihrer Anlage vor.',
  missing_channels:
    'Ihr Gerät meldet für diesen Zeitraum keine Netz- und Verbrauchswerte — ohne sie lässt sich kein Erlös berechnen.',
  no_prices:
    'Für diesen Zeitraum liegen noch keine Börsenpreise vor — sobald sie da sind, erscheinen die Beträge hier.',
};

/** Der Rückfall, wenn der Endpunkt keinen Grund nennt. */
export const LEER_TEXT_FALLBACK =
  'Für diesen Zeitraum lässt sich noch kein Erlös berechnen.';

function euroOhneVorzeichen(v: number): string {
  return eurAmount(Math.abs(v));
}

/** „+ 999,26 €" / „− 12,40 €" — das Vorzeichen steht als eigenes Zeichen davor. */
export function signedEuro(v: number): string {
  return `${v < 0 ? '−' : '+'} ${euroOhneVorzeichen(v)}`;
}

export interface ErloesErgebnisInput {
  /** Die Antwort des anlagen-scharfen Endpunkts; null = noch nicht geladen. */
  money: SiteEarnings | null;
  /** Der Name des gezeigten Zeitraums („Juli 2026") — die Zeit-Leiste regiert. */
  periodLabel: string;
}

/**
 * Die Ergebnis-Karte (Karte 1 der Erlöse-Welt).
 *
 * Jede Zeile trägt ihr eigenes Perioden-Etikett, und die vermiedenen
 * Leistungskosten gehören zur LAUFENDEN ABRECHNUNGSPERIODE — sie stehen
 * deshalb im Stapel, gehen aber NIE in die große Zahl ein (dieselbe Regel wie
 * im Cockpit-Block).
 */
export function erloesErgebnis(input: ErloesErgebnisInput): ErloesErgebnisView {
  const money = input.money;
  const rangeLabel = input.periodLabel;
  const billingLabel = billingPeriodLabel(money);
  const titel = `Ergebnis · ${rangeLabel}`;

  const rows: ErgebnisZeile[] = [];
  const push = (
    id: ErgebnisZeileId,
    label: string,
    vorzeichen: ErgebnisVorzeichen,
    eur: number | null,
    period: StreamPeriod,
    note: string | null,
  ) => {
    rows.push({
      id,
      label,
      vorzeichen,
      eur,
      valueText: eur == null ? DASH : euroOhneVorzeichen(eur),
      period,
      periodLabel: period === 'billing-period' ? billingLabel : rangeLabel,
      barFraction: 0,
      hue: ERGEBNIS_HUE[id],
      note,
    });
  };

  const einspeise = num(money?.einspeiseErloesEur ?? null);
  const eigen = num(money?.eigenverbrauchsWertEur ?? null);
  const kosten = num(money?.stromkostenEur ?? null);
  const netto = num(money?.nettoErgebnisEur ?? null);

  push('einspeisung', 'Einspeise-Erlös', 'plus', einspeise, 'range', einspeiseNote(money));
  push(
    'eigenverbrauchswert',
    'Wert des Eigenverbrauchs',
    'plus',
    eigen,
    'range',
    eigenNote(money, eigen),
  );
  push('stromkosten', 'Stromkosten (Netzbezug)', 'minus', kosten, 'range', kostenNote(money));
  if (money?.peakShaving) {
    push(
      'lastspitzen',
      'Vermiedene Leistungskosten',
      'plus',
      num(money.peakShaving.avoidedEur),
      'billing-period',
      'Eigene Abrechnungsperiode — nicht Teil des Zeitraum-Ergebnisses.',
    );
  }

  // Balken nur INNERHALB einer Periode skalieren (ein Jahresstand darf einen
  // Monatswert nicht optisch erschlagen).
  for (const period of ['range', 'billing-period'] as StreamPeriod[]) {
    const group = rows.filter((r) => r.period === period && r.eur != null);
    const max = Math.max(0, ...group.map((r) => Math.abs(r.eur as number)));
    if (max <= 0) continue;
    for (const r of group) r.barFraction = Math.abs(r.eur as number) / max;
  }

  const mehrerePerioden = new Set(rows.map((r) => r.period)).size > 1;
  const richtung = netto == null ? null : netto < 0 ? 'kosten' : 'ertrag';
  const leerText =
    money == null || netto != null
      ? null
      : (LEER_TEXT[money.reason ?? ''] ?? LEER_TEXT_FALLBACK);

  return {
    titel,
    nettoEur: netto,
    nettoText: netto == null ? DASH : signedEuro(netto),
    richtung,
    nettoSatz: nettoSatz(netto, rangeLabel),
    steering: steeringAttributionNote(money?.savedEur),
    steeringTitel: steeringTitel(money),
    rows,
    mehrerePerioden,
    periodNote: mehrerePerioden
      ? `Verschiedene Zeiträume: ${rangeLabel} und ${billingLabel} werden getrennt ausgewiesen und nicht zu einer Summe addiert.`
      : null,
    footnote: rows.some((r) => r.eur == null) ? UNATTRIBUTED_FOOTNOTE : null,
    leerText,
  };
}

function nettoSatz(netto: number | null, rangeLabel: string): string {
  if (netto == null) return `Für ${rangeLabel} lässt sich noch kein Ergebnis berechnen.`;
  const betrag = euroOhneVorzeichen(netto);
  return netto < 0
    ? `${rangeLabel}: Ihr Strombezug hat ${betrag} mehr gekostet, als Ihre Anlage eingebracht hat.`
    : `${rangeLabel}: So viel hat Ihre Anlage unterm Strich eingebracht.`;
}

function einspeiseNote(money: SiteEarnings | null): string | null {
  if (!money) return null;
  if (money.einspeiseErloesEur == null) return 'Noch keine Daten.';
  const praemie = num(money.marktpraemieEur);
  return praemie != null && Math.abs(praemie) >= 0.005
    ? `enthält ${eurAmount(praemie)} Marktprämie`
    : null;
}

function eigenNote(money: SiteEarnings | null, eigen: number | null): string | null {
  if (!money) return null;
  if (eigen != null) {
    const kwh = num(money.selbstverbrauchKwh);
    return kwh == null ? null : `${fmtNum(kwh, 'kWh')} selbst genutzt`;
  }
  if (money.tarifArt === 'ohne' && !money.tarifPriced) {
    const kwh = num(money.selbstverbrauchKwh);
    const menge = kwh == null ? '' : ` (${fmtNum(kwh, 'kWh')} selbst genutzt)`;
    return `Ohne hinterlegten Stromtarif lässt sich der Wert nicht beziffern${menge}.`;
  }
  return 'Noch keine Daten.';
}

function kostenNote(money: SiteEarnings | null): string | null {
  if (!money) return null;
  if (money.stromkostenEur == null) return 'Noch keine Daten.';
  return money.tarifPriced
    ? 'bewertet zu Ihrem Stromtarif'
    : 'bewertet zum Börsenpreis der jeweiligen Viertelstunde';
}

function steeringTitel(money: SiteEarnings | null): string | null {
  if (!money || num(money.savedEur) == null) return null;
  return (
    'Gegenüber derselben Anlage ohne Speicher und ohne Steuerung — gleiche Sonne, ' +
    'gleicher Verbrauch, Speicher aus. Der Betrag steckt bereits im Ergebnis.'
  );
}

// ---------------------------------------------------------------------------
// Karte 3 · „Was den Preis gemacht hat"
// ---------------------------------------------------------------------------

export type PreisZeileId =
  | 'bezugspreis'
  | 'marktwert'
  | 'monatsmarktwert'
  | 'marktpraemie'
  | 'arbitrage';

/** Eine Zeile der Preis-Karte — Wert plus die Einordnung dazu. */
export interface PreisZeile {
  id: PreisZeileId;
  label: string;
  /** „8,9 ct/kWh" / „+ 12,40 €" / „—". */
  wert: string;
  note: string | null;
  /** false = „—" (nicht berechenbar bzw. für diese Anlage nicht zutreffend). */
  vorhanden: boolean;
  /**
   * Ruhige Zusatzzeilen unter der Einordnung (Vorläufigkeit, „bereits
   * enthalten", der Weg zu einer fehlenden Eingabe). Leer bei jeder Zeile, die
   * mit einem Satz auskommt.
   */
  hinweise: string[];
  /** Optionaler Weg dorthin, wo der fehlende Wert gepflegt wird. */
  href: string | null;
}

/** ct/kWh in Kundenschreibweise: deutsches Komma, eine Nachkommastelle. */
function ctText(v: number): string {
  return `${v.toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} ct/kWh`;
}

export interface PreisTreiberInput {
  money: SiteEarnings | null;
  /** Ob die Anlage überhaupt aus dem Netz laden darf (Stammdatum der Anlage). */
  netzladenErlaubt?: boolean;
  /** Nur für den Weg in die Einstellungen, wo ein Wert fehlt. */
  siteId?: string | null;
}

/**
 * Karte 3: die Preise HINTER dem Ergebnis. Sie rechnet nichts Neues — sie zeigt
 * die Größen, die der Endpunkt ehrlich hergibt, und schreibt überall dort „—",
 * wo es keine Zurechnung gibt (mit dem Grund daneben, damit ein Strich nicht
 * wie ein Defekt aussieht).
 */
export function preisTreiber(input: PreisTreiberInput): PreisZeile[] {
  const m = input.money;
  const zeilen: PreisZeile[] = [];
  const add = (id: PreisZeileId, label: string, wert: string | null, note: string | null) => {
    zeilen.push({
      id,
      label,
      wert: wert ?? DASH,
      note,
      vorhanden: wert != null,
      hinweise: [],
      href: null,
    });
  };

  const bezug = num(m?.bezugspreisCtKwh ?? null);
  add(
    'bezugspreis',
    'Ø Bezugspreis',
    bezug == null ? null : ctText(bezug),
    bezug == null
      ? 'In diesem Zeitraum wurde kein Strom aus dem Netz bezogen.'
      : m?.tarifPriced
        ? 'Ihr hinterlegter Stromtarif, Viertelstunde für Viertelstunde'
        : 'reiner Börsenpreis — ein hinterlegter Stromtarif würde hier einfließen',
  );

  const erzielt = num(m?.realizedExportCtKwh ?? null);
  const markt = num(m?.marketValueSolarCtKwh ?? null);
  add(
    'marktwert',
    'Ihr erzielter Marktwert',
    erzielt == null ? null : ctText(erzielt),
    erzielt == null
      ? 'In diesem Zeitraum wurde nichts eingespeist.'
      : markt == null
        ? null
        : marktVergleich(erzielt, markt),
  );
  add(
    'monatsmarktwert',
    'Monatsmarktwert Solar',
    markt == null ? null : ctText(markt),
    markt == null
      ? 'Für diesen Zeitraum ist noch kein Monatsdurchschnitt veröffentlicht.'
      : m?.marketValueProvisional
        ? 'vorläufig — der endgültige Wert wird nachgereicht'
        : null,
  );

  // Die Marktprämie erklärt sich selbst (`marktpraemie.ts`) — insbesondere die
  // BERECHNETE Null, die vorher wie ein Defekt aussah.
  if (m) {
    const p = marktpraemie({
      marktpraemieEur: m.marktpraemieEur,
      anzulegenderWertCtKwh: m.anzulegenderWertCtKwh,
      marketValueSolarCtKwh: m.marketValueSolarCtKwh,
      marketValueProvisional: m.marketValueProvisional,
      eingespeistKwh: m.eingespeistKwh,
      plantKind: m.plantKind,
      range: m.range,
      from: m.from,
      to: m.to,
      siteId: input.siteId ?? null,
    });
    zeilen.push({
      id: 'marktpraemie',
      // Der Monat IST die Abrechnungseinheit der Prämie — er gehört in die
      // Überschrift, nicht in eine Fußnote.
      label: p.label,
      wert: p.wert,
      note: p.note,
      vorhanden: p.vorhanden,
      hinweise: p.hinweise,
      href: p.href,
    });
  } else {
    add('marktpraemie', 'Marktprämie', null, null);
  }

  const arbitrage = num(m?.arbitrageEur ?? null);
  add(
    'arbitrage',
    'davon durch Netzladen',
    arbitrage == null ? null : signedEuro(arbitrage),
    arbitrage == null
      ? input.netzladenErlaubt
        ? 'In diesem Zeitraum wurde nicht aus dem Netz geladen.'
        : 'Ihr Speicher lädt ausschließlich Sonnenstrom.'
      : 'Verkaufserlös der aus dem Netz geladenen Energie abzüglich ihrer Einkaufskosten',
  );

  return zeilen;
}

function marktVergleich(erzielt: number, markt: number): string {
  const diff = erzielt - markt;
  if (Math.abs(diff) < 0.05) return 'etwa auf Höhe des Monatsdurchschnitts';
  const betrag = Math.abs(diff).toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return diff > 0
    ? `${betrag} ct über dem Monatsdurchschnitt`
    : `${betrag} ct unter dem Monatsdurchschnitt`;
}

// ---------------------------------------------------------------------------
// Karte 2 · „Geld im Verlauf"
// ---------------------------------------------------------------------------

/** Eine Reihe des Geld-Verlaufs (gestapelter Balken). */
export interface GeldReihe {
  id: 'einspeisung' | 'eigenverbrauchswert' | 'stromkosten';
  label: string;
  /** Der Anteil je Balken; Kosten stehen NEGATIV, also unter der Nulllinie. */
  data: number[];
}

/** Die fertige Datengrundlage des Geld-Verlaufs. */
export interface GeldVerlaufView {
  /** true = es gibt nichts zu zeichnen (dann rendert die Karte einen Satz). */
  leer: boolean;
  /** Die Zeitpunkte der Balken (ISO), für Achsen- und Tooltip-Beschriftung. */
  starts: string[];
  reihen: GeldReihe[];
  /** Die kumulierte Linie — laufende Summe der Netto-Beträge. */
  kumuliert: number[];
  /** „kumuliert 999,26 €" — der Endstand der Linie; null ohne Balken. */
  kumuliertText: string | null;
  /** Der „Was zeigt das?"-Satz, passend zur Balkenbreite. */
  untertitel: string;
}

const VERLAUF_LABEL: Record<GeldReihe['id'], string> = {
  einspeisung: 'Einspeise-Erlös',
  eigenverbrauchswert: 'Wert des Eigenverbrauchs',
  stromkosten: 'Stromkosten',
};

/** Wie breit ein Balken ist — die Skala folgt dem Zeitraum (P6). */
export function verlaufSchritt(range: SiteEarnings['range']): string {
  switch (range) {
    case 'day':
      return 'Stunde';
    case 'week':
    case 'month':
      return 'Tag';
    default:
      return 'Monat';
  }
}

/**
 * Karte 2: dieselben drei Teile wie in der Ergebnis-Karte, nur über die Zeit —
 * gestapelte Balken (Erlöse nach oben, Kosten nach unten) plus die kumulierte
 * Linie, die am Ende genau auf dem Netto-Ergebnis des Zeitraums landet.
 *
 * **Ein fehlender Teil wird zu 0 im BALKEN, nicht zu einer erfundenen Zahl:**
 * ein Balken existiert nur, wenn der Zeitraum-Eimer überhaupt berechenbar war
 * (der Endpunkt listet nur solche), und ein dort fehlender Strom (z. B. kein
 * Tarif → kein Wert des Eigenverbrauchs) trägt schlicht nichts zum Stapel bei.
 */
export function geldVerlauf(
  series: SiteEarningsBucket[] | null | undefined,
  range: SiteEarnings['range'],
): GeldVerlaufView {
  const buckets = series ?? [];
  const schritt = verlaufSchritt(range);
  const untertitel =
    `Was zeigt das? Je ${schritt} die Erlöse nach oben und die Stromkosten nach unten; ` +
    'die Linie summiert beides auf und endet auf dem Ergebnis des Zeitraums.';
  if (buckets.length === 0) {
    return {
      leer: true,
      starts: [],
      reihen: [],
      kumuliert: [],
      kumuliertText: null,
      untertitel,
    };
  }

  const wert = (v: number | null | undefined) => (num(v ?? null) ?? 0);
  const reihen: GeldReihe[] = [
    {
      id: 'einspeisung',
      label: VERLAUF_LABEL.einspeisung,
      data: buckets.map((b) => wert(b.einspeiseErloesEur)),
    },
    {
      id: 'eigenverbrauchswert',
      label: VERLAUF_LABEL.eigenverbrauchswert,
      data: buckets.map((b) => wert(b.eigenverbrauchsWertEur)),
    },
    {
      id: 'stromkosten',
      label: VERLAUF_LABEL.stromkosten,
      // Kosten zeigen nach UNTEN - das ist die Aussage des Diagramms.
      data: buckets.map((b) => -wert(b.stromkostenEur)),
    },
  ];

  let lauf = 0;
  const kumuliert = buckets.map((b) => {
    lauf += wert(b.nettoEur);
    return lauf;
  });

  return {
    leer: false,
    starts: buckets.map((b) => b.start),
    reihen,
    kumuliert,
    kumuliertText: `kumuliert ${signedEuro(lauf)}`,
    untertitel,
  };
}
