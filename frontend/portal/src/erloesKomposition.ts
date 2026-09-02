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
  CockpitMoney,
  EarningsRange,
  PeakShaving,
  PlantKind,
  SiteEarnings,
  SiteEarningsBucket,
  TarifArt,
} from './api';
import { coveredSinceLabel, periodLabel } from './anlage';
import { NBSP, eurAmount, fmtNum } from './format';
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
  'Jeder Strom kommt aus einem Betriebsmodell. Wo „—" steht, gibt es noch keine Zurechnung je Regel – erfunden wird nichts.';

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

/* ---------------------------------------------------------------------------
 * „Wie wird das berechnet?" — die Kunden-Erklärung UNTER dem Steuerungs-Chip
 *
 * Captain-Wunsch 01.09.2026: der Kunde soll direkt am grünen Chip
 * („davon 3,73 € durch VoltPilots Steuerung") nachlesen können, WIE die Zahl
 * zustande kommt. Bis hierher gab es dafür nur einen Tooltip-Einzeiler
 * (`steeringTitel`) und den Provenienz-Satz `anlage.savedProvenance` — beide
 * sagen, WOGEGEN verglichen wird, aber nicht, MIT WELCHEN PREISEN.
 *
 * ⚠ ES WIRD HIER NICHTS GERECHNET. Die Erklärung beschreibt die Rechnung, die
 * der SERVER anstellt (`EarningsRepository`, die ONE-truth-Komposition
 * `SlotEconomics.importPriceCtSql`); jede genannte Zahl ist ein Feld, das die
 * Antwort ohnehin trägt. Eine zweite Rechnung im Portal wären zwei
 * Geldwahrheiten über dieselbe Kasse — dieselbe Falle, die das Bestandskonto
 * eine Sektion weiter oben ausdrücklich vermeidet.
 *
 * ⚠ WAS NICHT BELEGT IST, WIRD NICHT BEHAUPTET. Ohne hinterlegten Tarif sagt
 * die Preis-Zeile „Börsenpreis" statt eines erfundenen Tarifs; eine
 * Marktprämie von 0 bekommt ihren GRUND nur, wenn beide ct-Größen vorliegen,
 * sonst bleibt es beim neutralen Satz (die Vierzustands-Disziplin aus
 * `marktpraemie.ts`).
 *
 * ⚠ DAS BESTANDSKONTO WIRD VERWIESEN, NIE DUPLIZIERT. Die Zeile „im Speicher
 * für später" steht schon unter dem Chip; die Erklärung nennt nur, WARUM die
 * Kassenzahl mittags sinken kann, und zeigt auf sie — wo sie wirklich
 * gerendert wird (`bestandSichtbar`).
 * ------------------------------------------------------------------------- */

/** Eine Zeile der Formel-Box: die Seite der Rechnung und ihr Wortlaut. */
export interface FormelZeile {
  /** „Ohne Steuerung" / „Mit Steuerung" / „Beitrag der Steuerung". */
  label: string;
  /** Der Satz dahinter — Kundenworte, keine Symbole ausser × und −. */
  text: string;
}

/** Eine Preis-Angabe: womit die jeweilige Seite bewertet wird. */
export interface PreisAngabe {
  /** „Bezugspreis" / „Einspeisepreis". */
  label: string;
  text: string;
  /** Ruhige Zusatzzeile (Ø des Zeitraums, Marktprämie-Lage); null = keine. */
  zusatz: string | null;
}

/** Die render-fertige Erklärung. */
export interface SteuerungFormel {
  /** Der Auslöser-Text des Aufklappers. */
  ausloeser: string;
  /** Der Kernsatz: was verglichen wird. */
  kern: string;
  /** Die drei Zeilen der Rechnung. */
  zeilen: FormelZeile[];
  /** Womit die beiden Seiten bewertet werden. */
  preise: PreisAngabe[];
  /**
   * Historik-Semantik (B5): jede Periode wird zu den HEUTE gepflegten
   * Tarif-/Vergütungsangaben bewertet, eine Änderung schreibt also die
   * Vergangenheit um. `null`, wo die Zahl reiner Börsenpreis ist (nacktes
   * `ohne`, kein Direktvermarktungs-Wert) — dort gibt es nichts umzuschreiben.
   */
  historik: string | null;
  /** Warum die Zahl im Tagesverlauf noch nicht vollständig ist. */
  hinweis: string;
}

/**
 * Was die Erklärung wissen muss. **Jedes Feld ist optional**, weil sie an vier
 * Flächen mit drei verschiedenen Antwortformen hängt: das Anlagen-`/earnings`
 * (`SiteEarnings`, alles da), die Flotten-Zeile (`EarningsSite`, ohne
 * `bezugspreisCtKwh`/`marktpraemieEur`) und das Portfolio-Aggregat (gar kein
 * einzelner Tarif). Ein fehlendes Feld führt IMMER zur vorsichtigeren Fassung.
 */
export interface SteuerungFormelInput {
  tarifArt?: TarifArt | null;
  tarifParamCtKwh?: number | null;
  /** Ob der vermiedene Netzbezug wirklich zum Tarif bewertet ist. */
  tarifPriced?: boolean | null;
  /**
   * Ob die EINSPEISE-Seite zur festen EEG-Vergütung bewertet ist (Anmerkung
   * A1 aus `vp-review-eeg-r1`). `=== true` nur bei einer EEG-vergüteten
   * Eigenverbrauchs-Anlage; Direktvermarktung bleibt Spot + Marktprämie. Dann
   * sagen Kernsatz UND Einspeisepreis-Zeile „Ihre feste Einspeisevergütung"
   * statt „Börsenpreis". Fehlt das Flag (ältere Antwort, Flotten-DTO), bleibt
   * es bei der vorsichtigeren Börsenpreis-Fassung.
   */
  exportVerguetungPriced?: boolean | null;
  /** Der Ø-Bezugspreis des Zeitraums — belegt die Preis-Zeile. */
  bezugspreisCtKwh?: number | null;
  plantKind?: PlantKind | null;
  marktpraemieEur?: number | null;
  anzulegenderWertCtKwh?: number | null;
  marketValueSolarCtKwh?: number | null;
  /**
   * Portfolio: mehrere Anlagen mit je eigenem Tarif — dann wird kein einzelner
   * genannt, sondern „der Stromtarif der jeweiligen Anlage".
   */
  tarifneutral?: boolean;
  /**
   * Ob die Fläche die Bestandszeile („im Speicher für später") wirklich
   * rendert. Nur dann verweist der Hinweis auf sie; sonst stünde ein Zeiger
   * auf eine Zeile, die es nicht gibt.
   */
  bestandSichtbar?: boolean;
}

/** Der Auslöser — an allen Flächen wortgleich. */
export const FORMEL_AUSLOESER = 'Wie wird das berechnet?';

function ct(value: number): string {
  return `${value.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${NBSP}ct/kWh`;
}

/** Der Bezugspreis in Kundenworten — „Börsenpreis", wo kein Tarif hinterlegt ist. */
function bezugspreisText(input: SteuerungFormelInput): string {
  if (input.tarifneutral) return 'Der Stromtarif der jeweiligen Anlage.';
  const param = num(input.tarifParamCtKwh ?? null);
  if (input.tarifArt === 'fest') {
    return param != null
      ? `Ihr fester Stromtarif: ${ct(param)}.`
      : 'Ihr fester Stromtarif.';
  }
  if (input.tarifArt === 'dynamisch') {
    if (param != null && param > 0) {
      return `Ihr dynamischer Stromtarif: Börsenpreis der jeweiligen Viertelstunde + ${ct(param)} Aufschlag.`;
    }
    // ⚠ A1: ohne Aufschlag-Param, aber tariflich bewertet — gepflegtes Preisblatt
    // ODER der Produktions-Default (`OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS`) — bewertet
    // der Server mit Spot + Standard-Netzentgelten und Abgaben (`tarifPriced === true`),
    // daneben steht ein Ø-Bezugspreis von ~30 ct, und ein nacktes „Börsenpreis"
    // widerspräche ihm sichtbar. Dieselbe B3-Klasse wie im `ohne`-Zweig, nur auf
    // `dynamisch` (Anmerkung A1 aus dem PR-587-Review).
    if (input.tarifPriced === true) {
      return 'Ihr dynamischer Stromtarif: Börsenpreis der jeweiligen Viertelstunde plus Standard-Netzentgelte und Abgaben.';
    }
    // Flag aus / nacktes dynamisch: die Zahl ist wirklich reiner Börsenpreis.
    return 'Ihr dynamischer Stromtarif: der Börsenpreis der jeweiligen Viertelstunde.';
  }
  // 'ohne' und alles Unbekannte: es gibt keinen kundenseitigen Tarif.
  // ⚠ Mit dem Produktions-Default (`OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS`)
  // bewertet der Server eine solche Anlage aber mit Spot + Standard-Netzentgelten
  // und Abgaben (`tarifPriced === true`) — dann steht daneben ein Ø-Bezugspreis
  // von ~30 ct, und ein nacktes „Börsenpreis" widerspräche ihm sichtbar (B3).
  if (input.tarifPriced === true) {
    return (
      'Der Börsenpreis der jeweiligen Viertelstunde plus Standard-Netzentgelte und Abgaben ' +
      '— für diese Anlage ist kein Stromtarif hinterlegt.'
    );
  }
  // Flag aus / älterer Stand: die Zahl ist wirklich reiner Börsenpreis.
  return 'Der Börsenpreis der jeweiligen Viertelstunde — für diese Anlage ist kein Stromtarif hinterlegt.';
}

/**
 * Die Kurzform des Bezugspreises für den Kernsatz.
 *
 * ⚠ DIE PRÄZEDENZ IST DER B3-FIX: `tarifPriced === true` gewinnt über
 * `tarifArt === 'ohne'`. Mit dem Produktions-Default bewertet der Server eine
 * tariflose Anlage mit Spot + Standard-Netzentgelten (~18,7 ct brutto); ein
 * nacktes „dem Börsenpreis" widerspräche dem daneben gezeigten Ø-Bezugspreis
 * (~30 ct) sichtbar. Der Fall `tarifPriced === false` (Flag aus, nacktes
 * `ohne`) bleibt ehrlich „dem Börsenpreis".
 */
function bezugKurzText(input: SteuerungFormelInput): string {
  if (input.tarifneutral) return 'dem Stromtarif der jeweiligen Anlage';
  // Die Grundwahrheit: ist die Zahl NICHT zum Tarif bewertet, ist sie Spot —
  // egal, ob ein Tarif auf Akte liegt.
  if (input.tarifPriced === false) return 'dem Börsenpreis';
  const ohneTarif = input.tarifArt === 'ohne' || input.tarifArt == null;
  if (ohneTarif) {
    return input.tarifPriced === true
      ? 'dem Börsenpreis plus Standard-Netzentgelte und Abgaben'
      : 'dem Börsenpreis';
  }
  return 'Ihrem Stromtarif';
}

/**
 * ⚠ Ob die Einspeisung zur festen EEG-Vergütung bewertet ist (Anmerkung A1).
 * Eine EEG-vergütete Eigenverbrauchs-Anlage bewertet der Server die Einspeisung
 * NICHT zum Börsenpreis, sondern zur festen Vergütung — dann widerspräche ein
 * nacktes „Börsenpreis" der daneben stehenden Karte-Zahl sichtbar. `tarifneutral`
 * gewinnt (ein Portfolio nennt keine einzelne Vergütung, wie beim Bezugspreis).
 */
function istFesteVerguetung(input: SteuerungFormelInput): boolean {
  return input.exportVerguetungPriced === true && input.tarifneutral !== true;
}

/** Die Kurzform des Einspeisepreises für den Kernsatz. */
function einspeisePreisKurz(input: SteuerungFormelInput): string {
  return istFesteVerguetung(input) ? 'Ihrer festen Einspeisevergütung' : 'dem Börsenpreis';
}

/** Der Wortlaut der Einspeisepreis-Zeile. */
function einspeisePreisText(input: SteuerungFormelInput): string {
  return istFesteVerguetung(input)
    ? 'Ihre feste Einspeisevergütung nach EEG.'
    : 'Der Börsenpreis (Day-Ahead) der jeweiligen Viertelstunde.';
}

/**
 * Der Historik-Satz (B5) — nur, wo die Bewertung an einer heute gepflegten
 * Größe hängt, deren Änderung die Vergangenheit umschreibt: ein Tarif, ein
 * Preisblatt/Standard-Aufschlag (`tarifPriced`) oder der anzulegende Wert der
 * Direktvermarktung. Bei reinem Börsenpreis gibt es nichts umzuschreiben (die
 * Day-Ahead-Preise sind feste Fakten) — dann `null`.
 */
function historikSatz(input: SteuerungFormelInput): string | null {
  const relevant =
    input.tarifneutral === true ||
    input.tarifArt === 'fest' ||
    input.tarifArt === 'dynamisch' ||
    input.tarifPriced === true ||
    input.plantKind === 'direktvermarktung';
  return relevant
    ? 'Bewertet wird immer zu den heute hinterlegten Tarif- und Vergütungsangaben — ' +
        'ändern sich diese, ändern sich auch zurückliegende Auswertungen.'
    : null;
}

/**
 * Die Marktprämie-Zeile. Sie fällt NUR bei Direktvermarktung an, und eine
 * berechnete 0 bekommt ihren Grund nur, wenn beide ct-Größen vorliegen (sonst
 * behauptete der Satz eine Rechnung, die niemand belegen kann).
 */
function einspeiseZusatz(input: SteuerungFormelInput): string | null {
  if (input.tarifneutral) return null;
  if (input.plantKind !== 'direktvermarktung') return null;
  const praemie = num(input.marktpraemieEur ?? null);
  if (praemie != null && Math.abs(praemie) >= 0.005) {
    return `Dazu kommt die Marktprämie: ${eurAmount(praemie)} in diesem Zeitraum.`;
  }
  const aw = num(input.anzulegenderWertCtKwh ?? null);
  const mw = num(input.marketValueSolarCtKwh ?? null);
  if (praemie != null && aw != null && mw != null && mw >= aw) {
    return (
      `Derzeit keine Marktprämie, weil der Monatsmarktwert (${ct(mw)}) über Ihrem ` +
      `anzulegenden Wert (${ct(aw)}) liegt — Ihre Vergütung kommt in diesem Zeitraum voll aus dem Markt.`
    );
  }
  if (praemie != null) return 'In diesem Zeitraum fällt keine Marktprämie an.';
  if (aw != null) return 'Dazu kommt die Marktprämie, wo sie anfällt.';
  return null;
}

/**
 * Die Erklärung zum Steuerungs-Chip. Sie steht IMMER zur Verfügung, sobald der
 * Chip steht — es gibt keinen Zustand, in dem die Rechnung eine andere wäre;
 * verschieden ist nur, wie viel wir über die PREISE sagen können.
 */
export function steuerungFormel(input: SteuerungFormelInput): SteuerungFormel {
  const bezugKurz = bezugKurzText(input);

  const kern =
    'Wir vergleichen jede Viertelstunde Ihre tatsächliche Stromrechnung mit der Rechnung, ' +
    'die dieselbe Anlage ohne Speicher-Steuerung gehabt hätte — bewertet mit ' +
    `${bezugKurz} für den Netzbezug und ${einspeisePreisKurz(input)} für die Einspeisung. ` +
    'Die Differenz ist das, was die Steuerung verdient hat.';

  const zeilen: FormelZeile[] = [
    {
      label: 'Ohne Steuerung',
      // ⚠ Die Vergleichs-Anlage verbraucht ihren Solarstrom weiterhin DIREKT
      // (Netting im Slot: `max(load−pv,0) × p − max(pv−load,0) × s`). Der frühere
      // Satz beschrieb `load × p − pv × s` und wäre für einen nachrechnenden
      // Kunden eine andere Baseline gewesen (B4).
      text:
        'Speicher aus, Solarstrom wird direkt verbraucht und der Rest sofort eingespeist: ' +
        'Netzbezug nach Abzug des direkt verbrauchten Solarstroms × Bezugspreis − ' +
        'Solarüberschuss × Einspeisepreis.',
    },
    {
      label: 'Mit Steuerung',
      text: 'Gemessen an Ihrem Zähler: Netzbezug × Bezugspreis − Netzeinspeisung × Einspeisepreis.',
    },
    {
      label: 'Beitrag der Steuerung',
      text: 'Kosten ohne Steuerung − Kosten mit Steuerung, über alle Viertelstunden des Zeitraums summiert.',
    },
  ];

  const bezugSchnitt = num(input.bezugspreisCtKwh ?? null);
  const preise: PreisAngabe[] = [
    {
      label: 'Bezugspreis',
      text: bezugspreisText(input),
      zusatz:
        !input.tarifneutral && bezugSchnitt != null
          ? `Im Zeitraum im Schnitt ${ct(bezugSchnitt)}.`
          : null,
    },
    {
      label: 'Einspeisepreis',
      text: einspeisePreisText(input),
      zusatz: einspeiseZusatz(input),
    },
  ];

  const zeiger = input.bestandSichtbar
    ? ' Was gerade im Speicher liegt, steht in der Zeile darunter.'
    : '';

  return {
    ausloeser: FORMEL_AUSLOESER,
    kern,
    zeilen,
    preise,
    historik: historikSatz(input),
    hinweis:
      'Diese Zahl ist eine reine Kassenrechnung: Strom, der gerade in den Speicher geladen wurde, ' +
      'zählt noch nicht — sein Wert erscheint erst, wenn er später den Netzbezug ersetzt. ' +
      'Deshalb kann die Zahl mittags sinken und ist erst am Tagesende vollständig.' +
      zeiger,
  };
}

/* ---------------------------------------------------------------------------
 * Das BESTANDSKONTO — die zweite Zeile unter der Steuerungs-Zurechnung
 *
 * ⚠ DER BEFUND, DER SIE NÖTIG MACHT (Diagnose `vp-tagesbild-minus-f3`):
 * `savedEur` ist eine ZAHLUNGSBILANZ ohne Bestandskonto. Sie bewertet jede
 * Viertelstunde nur nach dem, was über den Netzanschluss GEFLOSSEN ist —
 * Energie, die in den Speicher wandert, zählt darin als entgangener
 * Einspeise-Erlös (Minus), und ihr Gegenwert (der Abend) existiert mittags noch
 * nicht. Am 21.08.2026 stand deshalb um 12:19 „−4,69 €" über einem
 * ökonomisch einwandfreien Plan, während ≈ 44 kWh im Speicher lagen.
 *
 * ⚠ SIE WIRD NIE IN `savedEur` EINGERECHNET. Die gemessene Kasse bleibt die
 * gemessene Kasse; der Bestand steht DANEBEN und sagt selbst, dass er nach dem
 * Plan bewertet ist. Alles andere wären zwei Geldwahrheiten über dieselbe Zahl
 * (dieselbe Falle, die `tagesbild.ts` bei der Geisterkurve schon einmal
 * ausdrücklich vermieden hat).
 *
 * Beide Richtungen werden in Kundenworten gezeigt: „gespeichert" bzw.
 * „genutzt". Der Eurobetrag bleibt absichtlich ohne Vorzeichen, weil er weder
 * Zuschlag noch Abzug der danebenstehenden Verdienst-Zahl ist.
 * ------------------------------------------------------------------------- */

/** Unter dieser Menge ist eine Bestandsänderung Messrauschen, keine Aussage. */
export const BESTAND_KWH_TOTBAND = 0.5;

/** Unter diesem Betrag würde die Cent-Anzeige fälschlich auf 0,00 € runden. */
export const BESTAND_EUR_TOTBAND = 0.005;

/** Die render-fertige Bestandszeile. */
export interface BestandZeile {
  /** Der ganze Satz („44,2 kWh Speicherenergie seit Tagesbeginn gespeichert · Planwert 8,35 €"). */
  text: string;
  /** Das Etikett, das den Planwert sichtbar von der Verdienst-Zahl trennt; null ohne Bewertung. */
  badge: string | null;
  /** Womit bewertet wurde — der Titel-Text dahinter; null ohne Bewertung. */
  titel: string | null;
  /** Die gemessene Bestandsänderung in kWh (+ eingelagert / − entnommen). */
  deltaKwh: number;
  /** Ihr Plan-Wert in EUR; null, solange es keine Bewertung gibt. */
  wertEur: number | null;
}

/** Der Planwert ist weder Abzug noch Zuschlag zur Verdienst-Zahl. */
export const BESTAND_BADGE = 'Kein Abzug';

/** Was der Bestand aus der Endpunkt-Antwort braucht (ein ÄLTERER Stand: nichts). */
export interface BestandEingabe {
  speicherDeltaKwh?: number | null;
  speicherWertCtKwh?: number | null;
  speicherWertEur?: number | null;
  speicherWertBasis?: string | null;
  /** Fensterende des Zeitraums (ISO) — entscheidet über „läuft noch". */
  to?: string | null;
  /** Die Perioden-Art — nur der TAG kennt „Folgetag"/„Vortag". */
  range?: string | null;
}

/**
 * Die eine Ableitung der Bestandszeile — von der Tagesbild-Überschrift UND von
 * der Ergebnis-Karte gelesen, damit beide Flächen über denselben Bestand nie
 * Verschiedenes behaupten können.
 *
 * `null` heißt: es gibt nichts zu sagen — kein Speicher, kein gemessener
 * Ladestand, ein älteres Backend, oder eine Bestandsänderung im Rauschen.
 */
export function bestandZeile(
  m: BestandEingabe | null | undefined,
  now: Date,
): BestandZeile | null {
  if (!m) return null;
  const delta = num(m.speicherDeltaKwh ?? null);
  if (delta == null || Math.abs(delta) < BESTAND_KWH_TOTBAND) return null;

  const bis = m.to ? new Date(m.to).getTime() : NaN;
  const laeuft = Number.isFinite(bis) && bis > now.getTime();
  const menge = fmtNum(Math.abs(delta), 'kWh');
  const tag = m.range === 'day';
  const satz = laeuft
    ? tag
      ? delta > 0
        ? `${menge} Speicherenergie seit Tagesbeginn gespeichert`
        : `${menge} Speicherenergie seit Tagesbeginn genutzt`
      : delta > 0
        ? `${menge} Speicherenergie seit Beginn des Zeitraums gespeichert`
        : `${menge} Speicherenergie seit Beginn des Zeitraums genutzt`
    : tag
      ? delta > 0
        ? `${menge} Speicherenergie für den Folgetag gespeichert`
        : `${menge} Speicherenergie aus dem Vortag genutzt`
      : delta > 0
        ? `${menge} Speicherenergie im Zeitraum gespeichert`
        : `${menge} Speicherenergie im Zeitraum genutzt`;

  const wert = num(m.speicherWertEur ?? null);
  // Die kWh sind GEMESSEN, der Euro ist PLAN: ohne Bewertung bleibt die
  // gemessene Menge stehen, ohne eine spätere Abrechnung zu versprechen.
  if (wert == null) {
    return {
      text: `${satz} · Planwert noch nicht verfügbar`,
      badge: null,
      titel: null,
      deltaKwh: delta,
      wertEur: wert,
    };
  }
  const absolut = Math.abs(wert);
  const betrag =
    absolut > 0 && absolut < BESTAND_EUR_TOTBAND
      ? `< 0,01${NBSP}€`
      : eurAmount(absolut);
  return {
    // Die Richtung steht bereits unmissverständlich im Verb. Ein Vorzeichen
    // am Eurobetrag sähe unter „Verdient" wie ein Zu- oder Abzug aus, obwohl
    // der Planwert ausdrücklich NICHT in dieser Zahl verrechnet wird.
    text: `${satz} · Planwert ${betrag}`,
    badge: BESTAND_BADGE,
    titel: bestandTitel(m.speicherWertBasis ?? null, num(m.speicherWertCtKwh ?? null)),
    deltaKwh: delta,
    wertEur: wert,
  };
}

/**
 * Womit bewertet wurde, in Kundendeutsch. Der Server sagt es maschinenlesbar
 * (`plan` = der Speicherwert dieser Viertelstunde, `terminal` = der am Ende des
 * Fahrplans); ein Wort, das wir nicht kennen, wird NICHT übersetzt.
 */
function bestandTitel(basis: string | null, ctKwh: number | null): string | null {
  const quelle =
    basis === 'plan'
      ? 'dem Speicherwert dieser Viertelstunde'
      : basis === 'terminal'
        ? 'dem Speicherwert am Ende des Fahrplans'
        : null;
  if (!quelle) return null;
  const preis = ctKwh == null ? '' : ` (${fmtNum(ctKwh, 'ct/kWh')})`;
  return `Der Fahrplan bewertet die Speicherenergie mit ${quelle}${preis}. Dieser Planwert dient nur der Einordnung und wird nicht vom Verdienst abgezogen.`;
}

function resolve(stream: MoneyStream, money: CockpitMoney | null): Resolved {
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
  money: CockpitMoney | null;
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
  /**
   * Die Eingabe fuer den Aufklapper „Wie wird das berechnet?" unter dem Chip
   * (Captain 01.09.2026). `null` = keine Zurechnung, also nichts zu erklaeren.
   */
  steeringFormel: SteuerungFormelInput | null;
  /**
   * Das BESTANDSKONTO daneben („44,2 kWh Speicherenergie seit Tagesbeginn
   * gespeichert · Planwert 8,35 €"). Es steht NEBEN der Zurechnung, nie in der großen Zahl:
   * die gemessene Kasse kennt eingelagerte Energie nur als entgangenen Erlös
   * (Diagnose vp-tagesbild-minus-f3). `null` = nichts zu sagen.
   */
  bestand: BestandZeile | null;
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
  /**
   * Mobil: den Zeitraum aus dem TITEL weglassen. Der Kartenkopf ist am Telefon
   * EINE Zeile, und „Ergebnis · So., 09.08.2026" wurde dort auf „Ergebni…"
   * abgeschnitten. Verloren geht nichts: die klebende Bedienzeile nennt den
   * Zeitraum unmittelbar darüber, und der Satz unter der Zahl nennt ihn erneut.
   */
  kurzerTitel?: boolean;
  /** „Jetzt" — entscheidet, ob der Zeitraum noch LÄUFT (Bestandszeile). */
  now?: Date;
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
  const titel = input.kurzerTitel ? 'Ergebnis' : `Ergebnis · ${rangeLabel}`;

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
    steeringFormel:
      money == null || steeringAttributionNote(money.savedEur) == null
        ? null
        : {
            tarifArt: money.tarifArt,
            tarifParamCtKwh: money.tarifParamCtKwh,
            tarifPriced: money.tarifPriced ?? null,
            exportVerguetungPriced: money.exportVerguetungPriced ?? null,
            bezugspreisCtKwh: money.bezugspreisCtKwh,
            plantKind: money.plantKind,
            marktpraemieEur: money.marktpraemieEur,
            anzulegenderWertCtKwh: money.anzulegenderWertCtKwh,
            marketValueSolarCtKwh: money.marketValueSolarCtKwh,
            bestandSichtbar: bestandZeile(money, input.now ?? new Date()) != null,
          },
    bestand: bestandZeile(money, input.now ?? new Date()),
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
  // Seit dem Captain-Entscheid E7 (02.09.2026) bewertet der Server den
  // Eigenverbrauch IMMER mit dem Bezugspreis der Karte - ein fehlender Wert
  // heißt also fehlende Daten, nie „kein Stromtarif hinterlegt".
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
  /**
   * Zeilen, die eine ANDERE Karte derselben Seite schon zeigt — sie entfallen
   * hier, statt dieselbe Wahrheit zweimal zu behaupten (die Absorption des
   * Kombinations-Bilds, Konzept `vp-ertrag-kombi-konzept-t7` D2). Wer absorbiert,
   * sagt es selbst: `soVerdient().absorbiert` ist die eine Liste, damit Karte und
   * Preis-Karte nie über verschiedene Mengen reden.
   */
  ohne?: readonly PreisZeileId[];
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

  return input.ohne?.length ? zeilen.filter((z) => !input.ohne!.includes(z.id)) : zeilen;
}

/**
 * „2,9 ct über dem Monatsdurchschnitt" — der Wortlaut, mit dem die Preis-Karte
 * den erzielten Marktwert einordnet. Exportiert, weil der Verdikt-Chip des
 * Kombinations-Bilds ihn WIEDERVERWENDET: die Einordnung darf nicht an zwei
 * Stellen verschieden formuliert sein.
 */
export function marktVergleich(erzielt: number, markt: number): string {
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

// --- Mobil: die Erlöse-Welt als Ergebnis + benannte Aufklapper ---------------

/**
 * **Die Mobil-Fassung der Erlöse-Welt** (Konzept `data/vp-mobile-views-x1` §6,
 * Captain-Abnahme 09.08.2026). Gemessen waren es **5 932 px** = acht Karten in
 * identischem Gewicht: nichts sagte, was die Hauptsache ist, und die reine
 * Gelegenheits-Lektüre („Speicher & Preis" samt drei Absätzen, das
 * Tagesprotokoll) lag bei 4 867 px täglich im Scrollweg.
 *
 * Umgeordnet wird, NICHT gekürzt: der Falz trägt das Ergebnis (Zahl + die drei
 * Kompositionszeilen, die sie ERGEBEN + die Steuerungs-Zurechnung), danach ein
 * kompakter Verlauf — und alles Erklärende wird ein BENANNTER Aufklapper, der
 * beim Öffnen seinen vollen Inhalt und sein eigenes Abzeichen behält.
 *
 * Diese Funktion entscheidet nur, WELCHE Aufklapper es gibt und wie sie heißen.
 * Ein Aufklapper, dessen Karte auf dieser Anlage bzw. in diesem Zeitraum gar
 * nicht existiert (kein Markt-Vergleich ohne Direktvermarktung, kein
 * Tagesnachweis außerhalb des Tages), erscheint nicht — ein leerer Aufklapper
 * wäre ein Versprechen ins Leere.
 */
export type ErloesAufklapperId =
  | 'so-verdient'
  | 'preis-treiber'
  | 'speicher-preis'
  | 'tagesprotokoll';

export interface ErloesAufklapper {
  id: ErloesAufklapperId;
  /** Die Zeile, die zugeklappt sichtbar ist. */
  titel: string;
  /** Die ruhige Unterzeile — was drinsteckt. */
  sub: string;
}

const AUFKLAPPER: Record<ErloesAufklapperId, ErloesAufklapper> = {
  'so-verdient': {
    id: 'so-verdient',
    titel: 'So verdient Ihre Anlage · der Markt-Vergleich',
    sub: 'Ihr Erlös gegen den Monatsdurchschnitt',
  },
  'preis-treiber': {
    id: 'preis-treiber',
    titel: 'Was den Preis gemacht hat',
    sub: 'Bezugspreis, Marktwert, Marktprämie',
  },
  'speicher-preis': {
    id: 'speicher-preis',
    // Seit dem Chart-Redesign Stufe 3 ist der Tagesnachweis das TAGESBILD -
    // drei Flächen über einer Zeitachse statt „Speicher & Preis" allein. Die
    // ID bleibt, damit ein geöffneter Aufklapper seine Sitzung behält.
    titel: 'Der Tag im Bild · Preis, Speicher, Ertrag',
    sub: 'Was Ihre Anlage an diesem Tag getan hat',
  },
  tagesprotokoll: {
    id: 'tagesprotokoll',
    titel: 'Tagesprotokoll',
    sub: 'Der Tag in Sätzen',
  },
};

export interface ErloesAufklapperInput {
  /** Gibt es das Kombinations-Ertragsbild? (nur direkt vermarktete Anlagen) */
  hatSoVerdient: boolean;
  /** Trägt „Was den Preis gemacht hat" überhaupt eine Zeile? */
  hatPreisTreiber: boolean;
  /** Der Tagesnachweis + das Protokoll gibt es nur im Tages-Zeitraum. */
  istTag: boolean;
  /** Liegt für diesen Tag überhaupt eine Historie-Antwort vor? */
  hatTagesdaten: boolean;
}

export function erloesAufklapper(input: ErloesAufklapperInput): ErloesAufklapper[] {
  const out: ErloesAufklapper[] = [];
  if (input.hatSoVerdient) out.push(AUFKLAPPER['so-verdient']);
  if (input.hatPreisTreiber) out.push(AUFKLAPPER['preis-treiber']);
  if (input.istTag && input.hatTagesdaten) {
    out.push(AUFKLAPPER['speicher-preis']);
    out.push(AUFKLAPPER.tagesprotokoll);
  }
  return out;
}

/**
 * **Die geplante Speicher-Ersparnis als gerahmte Fußnotiz.** Sie bleibt
 * SICHTBAR, verliert am Telefon aber ihren Karten-Rang: als gleichrangige Karte
 * neben dem gemessenen Ergebnis ist sie genau die dokumentierte
 * Ehrlichkeits-Falle dieser Seite (die zwei Zahlen dürfen um ein Vielfaches
 * auseinanderliegen, und die geplante ist die größere).
 *
 * **Das Abzeichen „Geplant" bleibt wörtlich** — es wandert nur vom Kartenkopf
 * in die Notiz. Ohne Plan steht der Grund da, nie eine erfundene Null.
 */
export interface GeplantNotiz {
  /** Immer „Geplant" — das Abzeichen der Notiz. */
  badge: string;
  /** „+ 4,12 €" oder „—". */
  wertText: string;
  /** Der Satz daneben. */
  satz: string;
  /** Ob wirklich ein Plan vorliegt (sonst ist `wertText` das ehrliche „—"). */
  vorhanden: boolean;
}

export function geplanteErsparnisNotiz(
  eur: number | null | undefined,
  periodLabel: string,
): GeplantNotiz {
  if (eur == null) {
    return {
      badge: 'Geplant',
      wertText: DASH,
      satz: `Für ${periodLabel} liegt kein Batterie-Fahrplan vor — die geplante Ersparnis erscheint, sobald geplant wird.`,
      vorhanden: false,
    };
  }
  return {
    badge: 'Geplant',
    wertText: signedEuro(eur),
    satz:
      'Speicher-Ersparnis laut Fahrplan — vorab geplant, nicht gemessen. ' +
      'Der gemessene Beitrag der Steuerung steht oben im Ergebnis.',
    vorhanden: true,
  };
}
