/**
 * **„So verdient Ihre Anlage"** — das Ertragsbild der Erlöse-Welt für
 * direkt vermarktete Anlagen.
 *
 * Die Frage der Karte: *ist das gut?* Die Pointe ist eine Beziehung dritter
 * Ordnung: die Anlage verkauft zeitversetzt ÜBER dem Monatsdurchschnitt, **und
 * die Marktprämie bleibt trotzdem voll**, weil sie ausschließlich am
 * Durchschnitt aller Solaranlagen hängt (`PREMIUM_RATE_CT = GREATEST(
 * anzulegender Wert − Monatsmarktwert, 0)`, `EarningsRepository.java`) und den
 * eigenen Mehrerlös nie anrechnet.
 *
 * **Das Bild seit dem Konzept „Erlöse · Preise und Verdienst" (25.09.2026):**
 * drei Balken auf EINER ct-Skala statt des Säulenbilds mit zwei Linien —
 *
 *  1. **Ø aller Solaranlagen** — der Monatsmarktwert Solar an der Börse,
 *  2. **Ihre Anlage** — was sie an der Börse erzielt hat (fair verglichen:
 *     beide sind nach eingespeisten kWh gewichtet, Server),
 *  3. **Ihr Erlös je kWh** — der Börsen-Teil plus der Prämien-Block obendrauf.
 *
 * Das Plus ist eine LÄNGE, keine Linie, die man übersetzen muss; der
 * Prämien-Block kommt nach dem Börsen-Teil — Ihr Vorsprung an der Börse bleibt
 * darunter vollständig stehen.
 *
 * ⚠ **Es wird nichts gerechnet, was der Server nicht geliefert hat.** Jede
 *   ct-Zahl ist ein Server-Durchschnitt oder der Quotient zweier Server-Summen
 *   (REGEL 1, `erloesEbenen.ts`): der Erlös je kWh ist `Einspeise-Erlös ÷
 *   eingespeiste kWh` — dieselbe Zahl wie „Ø … ct/kWh" in der Abrechnung —,
 *   der Prämien-Block `Marktprämie ÷ eingespeiste kWh`. An Tagen mit negativem
 *   Börsenpreis ruht die Prämie in diesen Viertelstunden; dann steht die
 *   ANGEKOMMENE Prämie da (und der Satz in der Unterzeile), nie der Satz als
 *   Block, der mehr behauptete, als ankam.
 *
 * **Eine Wahrheit, keine Forks:** die Prämien-Zeile IST der `marktpraemie()`-
 * Output (alle vier Zustände wörtlich, inkl. Monat, amtlich/vorläufig,
 * „anteilig", Borderline-Satz und Einstellungs-Link), und der Verdikt-Chip
 * spricht den `marktVergleich()`-Wortlaut.
 *
 * Reines Daten-/Logikmodul: kein React, kein Netzwerk.
 * `components/SoVerdient.tsx` rendert nur.
 */

import type { SiteEarnings } from './api';
import {
  balkenliste,
  ct1,
  ctWert,
  istMinus,
  type Balkenliste,
  type BalkenSegment,
  type BalkenZeile,
} from './balkenliste';
import { durchschnittCt } from './erloesEbenen';
import { marktVergleich } from './erloesKomposition';
import { NBSP } from './format';
import { marktpraemie, praemieMonat, type MarktpraemieView } from './marktpraemie';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/**
 * Die Lage ist eine 2×2-Matrix (Prämie zahlt/ruht × erzielt über/unter Ø) plus
 * die Datenlagen-Zustände. Deshalb sind **Zustand und Verdikt getrennt**: eine
 * Anlage kann gleichzeitig eine Aufstockung bekommen UND unter dem Durchschnitt
 * verkauft haben.
 *
 * `praemien_monat` = S1 · `voll_aus_dem_markt` = S2/S3 (S3 zusätzlich
 * vorläufig) · `ohne_garantiewert` = S5 · `ohne_monatswert` = S6 ·
 * `nichts_eingespeist` = S7 · `mehrere_monate` = S8. S4 („unter Ø") ist das
 * VERDIKT `aufmerksam`; S9 (nicht direkt vermarktet) liefert `null`.
 */
export type SoVerdientState =
  | 'praemien_monat'
  | 'voll_aus_dem_markt'
  | 'ohne_garantiewert'
  | 'ohne_monatswert'
  | 'nichts_eingespeist'
  | 'mehrere_monate';

/** Welche Form die Karte annimmt — Balken oder ein ehrlicher Satz. */
export type SoVerdientForm = 'balken' | 'fallback';

/**
 * Der Ton des Verdikt-Chips.
 *
 * **`aufmerksam` ist ein Captain-Entscheid (05.08.2026) und kein Design-Detail:**
 * „Wir können eigentlich nicht unter Durchschnitt sein — das bedeutet, wir
 * verkaufen, wenn's weniger kostet, also Gegenteil von Optimieren." Unter dem
 * Durchschnitt zu liegen darf deshalb NIE wie ein hinnehmbarer Normaltag
 * aussehen. Es ist trotzdem ein RUHIGER Warnton, kein roter Alarm.
 */
export type VerdictTon = 'vorteil' | 'neutral' | 'aufmerksam';

/** Die Antwort auf „Ist das gut?" — sie steht ÜBER den Balken, die sie beweisen. */
export interface VerdictChip {
  ton: VerdictTon;
  /** Der volle Chip-Text (bei `aufmerksam` inkl. des Prüf-Zusatzes). */
  text: string;
  /** Nur die Einordnung — der `marktVergleich()`-Wortlaut, ohne Zusatz. */
  vergleich: string;
}

export interface SoVerdientView {
  form: SoVerdientForm;
  state: SoVerdientState;
  /** „So verdient Ihre Anlage · August 2026" (ohne Monat: ohne Zusatz). */
  titel: string;
  monatLabel: string | null;
  /** `null` = kein Maßstab (S6), keine eigene Einspeisung (S7) oder S8. */
  verdict: VerdictChip | null;
  /** Ø aller Solaranlagen · Ihre Anlage · Ihr Erlös je kWh — `null` in S7. */
  balken: Balkenliste | null;
  /** Der Kernsatz unter den Balken — in jeder Monats-Lage mit Einspeisung (S1–S6). */
  kernsatz: string | null;
  /** Der ehrliche Satz, wo es kein ganzes Bild gibt (S7/S8). */
  hinweis: string | null;
  /**
   * Stehen die gerundeten Teile (Börse + Prämie) nicht auf dem gerundeten
   * Erlös je kWh, sagt es dieser Satz — sonst läse sich die Differenz wie ein
   * Rechenfehler (das Muster der Abrechnung).
   */
  rundung: string | null;
  /** Die Prämien-Zeile, wörtlich aus `marktpraemie()`. */
  praemie: MarktpraemieView;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const KARTEN_TITEL = 'So verdient Ihre Anlage';

/**
 * Der Kernsatz, immer unter den Balken. Er ist in BEIDEN Prämien-Lagen wahr —
 * Aufstockung UND „voll aus dem Markt" — und trägt die Pointe wörtlich
 * (Captain-Wortwahl 05.08.2026: die Kurzfassung).
 */
export const KERNSATZ =
  'Die Prämie richtet sich nach dem Durchschnitt — Ihr Timing-Vorteil bleibt Ihnen ungeschmälert.';

/**
 * S8: EIN Monatssatz wäre eine Behauptung über viele Monatswerte — die Prämie
 * wird je Monat abgerechnet. Der Börsen-Vergleich bleibt (beide Größen sind
 * über dieselbe Einspeisung gewichtet), der Erlös mit Prämie nicht.
 */
export const MEHRERE_MONATE_HINWEIS =
  'Die Prämie wird je Monat abgerechnet — wählen Sie einen Monat, um das Bild zu sehen.';

/** S7: ohne eigene Einspeisung gibt es kein Bild, aber einen ehrlichen Satz. */
export const NICHTS_EINGESPEIST_HINWEIS =
  'In diesem Zeitraum wurde nichts eingespeist — sobald Ihre Anlage einspeist, zeigt diese Karte, wie sich Ihr Erlös je kWh zusammensetzt.';

/**
 * Der Prüf-Zusatz des Verdikt-Chips (Captain-Override zu S4). Er benennt, WARUM
 * „unter dem Durchschnitt" nicht neutral ist, statt es nur einzufärben.
 */
export const UNTER_DURCHSCHNITT_ZUSATZ =
  'prüfenswert: die Optimierung verkauft normalerweise über dem Durchschnitt';

/** Der Rundungs-Satz — derselbe Gedanke wie „Posten einzeln gerundet" der Abrechnung. */
export const RUNDUNG_HINWEIS = 'Einzeln gerundet — der Erlös je kWh ist exakt gerechnet.';

/**
 * Das Anzeige-Totband: unter 0,05 ct liegt die eigene Anlage „etwa auf Höhe"
 * des Durchschnitts — dieselbe Schwelle, mit der `marktVergleich` formuliert.
 */
const VERGLEICH_DEADBAND_CT = 0.05;

/** Ein Prämien-Block unter 0,05 ct wäre „0,0 ct" — dann wird keiner gezeichnet. */
const BLOCK_MIN_CT = 0.05;

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Garantiewert und Monatswert, wie die Prämien-Zeile sie schreibt: 1–2 Stellen. */
function ct12(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Das Verdikt — die Antwort zuerst, die Balken als Beweis
// ---------------------------------------------------------------------------

/**
 * Die Einordnung der eigenen Anlage gegen den Durchschnitt. `null`, sobald
 * einer der beiden Werte fehlt — ohne Maßstab wird nichts behauptet.
 */
export function verdictChip(erzielt: number | null, markt: number | null): VerdictChip | null {
  if (erzielt == null || markt == null) return null;
  const diff = erzielt - markt;
  const vergleich = marktVergleich(erzielt, markt);
  if (Math.abs(diff) < VERGLEICH_DEADBAND_CT) {
    return { ton: 'neutral', text: vergleich, vergleich };
  }
  if (diff > 0) {
    // Das „+" nur in der Über-Lage — ein Vorzeichen vor „unter" wäre Unsinn.
    return { ton: 'vorteil', text: `+ ${vergleich}`, vergleich };
  }
  // Captain-Override: unter dem Durchschnitt ist NICHT neutral.
  return { ton: 'aufmerksam', text: `${vergleich} — ${UNTER_DURCHSCHNITT_ZUSATZ}`, vergleich };
}

// ---------------------------------------------------------------------------
// Die Balken
// ---------------------------------------------------------------------------

/** Zeile 1 — der Maßstab: Ø aller Solaranlagen an der Börse. */
function marktZeile(markt: number | null, vorlaeufig: boolean | null | undefined): BalkenZeile {
  const stand = vorlaeufig === true ? ' · vorläufig' : vorlaeufig === false ? ' · amtlich' : '';
  if (markt == null) {
    return {
      id: 'markt',
      name: 'Ø aller Solaranlagen',
      rolle: 'markt',
      wert: ctWert(null),
      vorhanden: false,
      segmente: [],
      unter: { text: 'Monatsmarktwert Solar · noch nicht veröffentlicht' },
    };
  }
  return {
    id: 'markt',
    name: 'Ø aller Solaranlagen',
    rolle: 'markt',
    wert: ctWert(markt),
    vorhanden: true,
    minus: istMinus(markt),
    segmente: [{ rolle: 'markt', von: 0, bis: markt, vorlaeufig: vorlaeufig === true }],
    unter: { text: `Monatsmarktwert Solar · an der Börse${stand}` },
  };
}

/** Zeile 2 — die eigene Anlage an der Börse (Ø ihrer Einspeise-Zeiten). */
function anlageZeile(erzielt: number | null, zusatz: string | null): BalkenZeile {
  if (erzielt == null) {
    return {
      id: 'anlage',
      name: 'Ihre Anlage',
      rolle: 'einspeisung',
      wert: ctWert(null),
      vorhanden: false,
      segmente: [],
      unter: { text: 'nichts eingespeist' },
    };
  }
  return {
    id: 'anlage',
    name: 'Ihre Anlage',
    rolle: 'einspeisung',
    wert: ctWert(erzielt),
    vorhanden: true,
    minus: istMinus(erzielt),
    segmente: [{ rolle: 'einspeisung', von: 0, bis: erzielt }],
    unter: { text: `an der Börse erzielt, Ø Ihrer Einspeise-Zeiten${zusatz ? ` · ${zusatz}` : ''}` },
  };
}

/**
 * Die Unterzeile des Erlöses: WAS die Prämie tut — mit den Zahlen, die sie
 * erklären. Nie eine erfundene Null: fehlt der Betrag, steht der Grund.
 */
function praemienSatz(m: SiteEarnings, praemieCt: number | null, kwh: number | null): string {
  const eur = num(m.marktpraemieEur);
  const aw = num(m.anzulegenderWertCtKwh);
  const mw = num(m.marketValueSolarCtKwh);
  // Ohne Garantiewert hat NIEMAND gerechnet — auch eine gelieferte 0 ist dann
  // keine Aussage (dieselbe Reihenfolge wie `marktpraemie()`).
  if (aw == null) return 'ohne Marktprämie — kein Garantiewert hinterlegt';
  if (eur == null || praemieCt == null) {
    return mw == null ? 'ohne Marktprämie — sie steht erst mit dem Monatsmarktwert fest' : 'ohne Marktprämie';
  }
  const satz = mw != null ? aw - mw : null;
  if (Math.abs(eur) < 0.005) {
    if (satz == null) return 'Marktprämie ruht';
    if (satz <= 0) {
      return Math.round(aw * 100) === Math.round(mw! * 100)
        ? 'Marktprämie ruht — Monatsmarktwert auf Höhe Ihres Garantiewerts'
        : 'Marktprämie ruht — Monatsmarktwert über Ihrem Garantiewert';
    }
    return 'Marktprämie ruht — bei negativem Börsenpreis gilt sie nicht';
  }
  // Eine winzige Prämie bekommt zwei Stellen — „+ 0,0 ct" wäre eine Null.
  const betrag =
    praemieCt < BLOCK_MIN_CT
      ? praemieCt.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : ct1(praemieCt);
  const block = `+ ${betrag}${NBSP}ct Marktprämie`;
  if (satz == null || satz <= 0) return block;
  // Voll = jede eingespeiste kWh bekam den Satz. Kam mehr als einen Cent
  // WENIGER an, lag ein Teil der Einspeisung bei negativem Börsenpreis (§ 51
  // EEG, `PREMIUM_ELIGIBLE`) — dasselbe Kriterium wie die Prämien-Rechnung
  // (`aufstockungsRechnung`), damit Zeile und Fuß nie verschieden urteilen.
  const zeitweise = kwh != null && (satz * kwh) / 100 - eur > 0.01;
  if (!zeitweise) {
    return `${block} · Garantiewert ${ct12(aw)}${NBSP}−${NBSP}Ø${NBSP}${ct12(mw!)}`;
  }
  return `${block} · Satz ${ct12(satz)}${NBSP}ct, ruht bei negativem Börsenpreis`;
}

/**
 * Zeile 3 — der Erlös je kWh: Börsen-Teil plus Prämien-Block. `null`, wo es
 * keinen Erlös je kWh gibt (keine Summe oder keine Menge).
 */
function erloesZeile(m: SiteEarnings, erzielt: number): { zeile: BalkenZeile; rundung: string | null } | null {
  const kwh = num(m.eingespeistKwh);
  const erloes = durchschnittCt(num(m.einspeiseErloesEur), kwh);
  if (erloes == null) return null;
  const praemieCt = durchschnittCt(num(m.marktpraemieEur), kwh);

  // Gestapelt wird nur im Positiven: ein Block, der von einem negativen
  // Börsen-Teil zurück Richtung Null läuft, läse sich als Abzug.
  const block = praemieCt != null && praemieCt >= BLOCK_MIN_CT && erzielt >= 0 && erloes > erzielt;
  const segmente: BalkenSegment[] = block
    ? [
        { rolle: 'einspeisung', von: 0, bis: erzielt },
        // Der Block endet am ECHTEN Erlös — so ist die Balkenlänge genau die
        // Zahl daneben, auch wenn die Server-Durchschnitte in der letzten
        // Stelle auseinanderliegen.
        { rolle: 'praemie', von: erzielt, bis: erloes, danach: true },
      ]
    : [{ rolle: 'einspeisung', von: 0, bis: erloes }];

  const gerundet = (v: number) => Math.round(v * 10) / 10;
  const rundung =
    block && Math.abs(gerundet(erzielt) + gerundet(praemieCt!) - gerundet(erloes)) > 0.001
      ? RUNDUNG_HINWEIS
      : null;

  return {
    zeile: {
      id: 'erloes',
      name: 'Ihr Erlös je kWh',
      rolle: null,
      wert: ctWert(erloes),
      vorhanden: true,
      minus: istMinus(erloes),
      summe: true,
      segmente,
      unter: { text: praemienSatz(m, praemieCt, kwh), schluessel: block ? 'praemie' : null },
    },
    rundung,
  };
}

// ---------------------------------------------------------------------------
// Die Ableitung
// ---------------------------------------------------------------------------

export interface SoVerdientInput {
  money: SiteEarnings | null | undefined;
  /** Nur für den Weg in die Einstellungen, wo der Garantiewert fehlt. */
  siteId?: string | null;
}

/**
 * Das Ertragsbild einer Anlage — oder `null`, wenn es hier gar keine Karte gibt.
 *
 * **`null` heißt: nicht direkt vermarktet (S9).** Ohne Direktvermarktung gibt es
 * keine Marktprämie und keinen Monatsmarktwert als Maßstab; die feste
 * Vergütung steht in „Preise im Zeitraum".
 */
export function soVerdient(input: SoVerdientInput): SoVerdientView | null {
  const m = input.money;
  if (!m || m.plantKind !== 'direktvermarktung') return null;

  const praemie = marktpraemie({
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

  const monat = praemieMonat(m.from, m.to);
  const titel = monat ? `${KARTEN_TITEL} · ${monat}` : KARTEN_TITEL;
  const erzielt = num(m.realizedExportCtKwh);
  const markt = num(m.marketValueSolarCtKwh);
  const aw = num(m.anzulegenderWertCtKwh);
  const basis = { titel, monatLabel: monat, praemie, rundung: null } as const;

  // S8 — mehrere Kalendermonate: der Börsen-Vergleich bleibt (beide Größen
  // sind über dieselbe Einspeisung gewichtet), der Erlös mit EINEM Prämien-
  // Satz nicht — die Prämie wird je Monat abgerechnet.
  if (!monat) {
    const zusatz = erzielt != null && markt != null ? marktVergleich(erzielt, markt) : null;
    return {
      ...basis,
      form: 'balken',
      state: 'mehrere_monate',
      verdict: null,
      balken: balkenliste('Erlös je eingespeister Kilowattstunde', [
        marktZeile(markt, m.marketValueProvisional),
        anlageZeile(erzielt, zusatz),
      ]),
      kernsatz: null,
      hinweis: MEHRERE_MONATE_HINWEIS,
    };
  }

  // S7 — ohne eigene Einspeisung gibt es kein Bild, nur den Satz und die Prämie.
  if (erzielt == null) {
    return {
      ...basis,
      form: 'fallback',
      state: 'nichts_eingespeist',
      verdict: null,
      balken: null,
      kernsatz: null,
      hinweis: NICHTS_EINGESPEIST_HINWEIS,
    };
  }

  const satz = aw != null && markt != null ? Math.max(aw - markt, 0) : 0;
  const state: SoVerdientState =
    markt == null
      ? 'ohne_monatswert'
      : aw == null
        ? 'ohne_garantiewert'
        : satz > 0
          ? 'praemien_monat'
          : 'voll_aus_dem_markt';

  const erloes = erloesZeile(m, erzielt);
  const zeilen = [marktZeile(markt, m.marketValueProvisional), anlageZeile(erzielt, null)];
  if (erloes) zeilen.push(erloes.zeile);

  return {
    ...basis,
    form: 'balken',
    state,
    verdict: verdictChip(erzielt, markt),
    balken: balkenliste('Erlös je eingespeister Kilowattstunde', zeilen),
    kernsatz: KERNSATZ,
    hinweis: null,
    rundung: erloes?.rundung ?? null,
  };
}
