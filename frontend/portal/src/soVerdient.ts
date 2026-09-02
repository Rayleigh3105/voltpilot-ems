/**
 * **„So verdient Ihre Anlage"** — das Kombinations-Ertragsbild der Erlöse-Welt
 * (Konzept `data/vp-ertrag-kombi-konzept-t7`, Variante A „Zwei-Säulen-Bild",
 * Captain-Go 05.08.2026).
 *
 * Die drei ct-Kacheln der Preis-Karte (erzielt · Ø · Prämie) tragen jede für
 * sich die Wahrheit, aber nicht die GESCHICHTE — die reale Kundenrückfrage vom
 * 05.08. („Wie ist das zu lesen?") galt genau der Beziehung zwischen ihnen. Und
 * die Pointe ist eine Beziehung DRITTER Ordnung: die Anlage verkauft
 * zeitversetzt ÜBER dem Monatsdurchschnitt, **und die Marktprämie bleibt
 * trotzdem voll**, weil sie ausschließlich am Flotten-Durchschnitt hängt
 * (`PREMIUM_RATE_CT = GREATEST(anzulegender Wert − Monatsmarktwert, 0)`,
 * `EarningsRepository.java`) und den eigenen Mehrerlös nie anrechnet. Dafür sind
 * Sätze das falsche Medium: der Beweis ist GEOMETRIE — die Höhe des grünen
 * Blocks IST der Abstand der beiden Führungslinien, sichtbar unabhängig von der
 * eigenen Säule.
 *
 * **Es wird hier nichts gerechnet, was der Server nicht schon geliefert hat.**
 * Die einzige Arithmetik ist Chart-Geometrie plus der Satz `AW − Ø` für die
 * Block-Beschriftung — dieselbe Differenz, die `aufstockungsRechnung` heute
 * anzeigt, mit demselben Aufgeh-Guard.
 *
 * **Eine Wahrheit, keine Forks:** die Prämien-Zeile IST der `marktpraemie()`-
 * Output (alle vier Zustände wörtlich, inkl. Monat in der Überschrift,
 * amtlich/vorläufig, „anteilig", Borderline-Satz und Einstellungs-Link), und der
 * Verdikt-Chip spricht den `marktVergleich()`-Wortlaut der Preis-Karte.
 *
 * Reines Daten-/Logikmodul (der `live.ts`/`marktpraemie.ts`-Präzedenzfall):
 * kein React, kein Netzwerk. `components/SoVerdientChart.tsx` rendert nur.
 */

import type { SiteEarnings, SiteEarningsRange } from './api';
import { DASH, marktVergleich, type PreisZeile, type PreisZeileId } from './erloesKomposition';
import { marktpraemie, praemieMonat, type MarktpraemieView } from './marktpraemie';
import { capTextLength } from './svgText';

/** Die Haus-Textkappung; hier RE-EXPORTIERT, damit die Aufrufer dieses Bildes
 *  sie weiterhin von hier beziehen können (sie wohnt neutral in `svgText.ts`,
 *  weil das Struktur-Schaltbild dieselbe Disziplin braucht). */
export { capTextLength };

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/**
 * Die Lage ist eine 2×2-Matrix (Prämie zahlt/ruht × erzielt über/unter Ø) plus
 * die Datenlagen-Zustände. Deshalb sind **Zustand und Verdikt getrennt**: eine
 * Anlage kann gleichzeitig eine Aufstockung bekommen UND unter dem Durchschnitt
 * verkauft haben — ein einziges Feld müsste sich für eine der beiden Wahrheiten
 * entscheiden.
 *
 * Zuordnung zur Zustandsgalerie des Konzepts (§5):
 * `praemien_monat` = S1 · `voll_aus_dem_markt` = S2/S3 (S3 zusätzlich
 * `vorlaeufig`) · `ohne_garantiewert` = S5 · `ohne_monatswert` = S6 ·
 * `nichts_eingespeist` = S7 · `mehrere_monate` = S8. S4 („unter Ø") ist das
 * VERDIKT `unter`, S9 (nicht direkt vermarktet) gibt es gar nicht — dort
 * liefert `soVerdient()` `null` und es rendert keine Karte.
 */
export type SoVerdientState =
  | 'praemien_monat'
  | 'voll_aus_dem_markt'
  | 'ohne_garantiewert'
  | 'ohne_monatswert'
  | 'nichts_eingespeist'
  | 'mehrere_monate';

/** Welche Form die Karte annimmt — Bild, Zeilen oder ein ehrlicher Satz. */
export type SoVerdientForm = 'chart' | 'rows' | 'fallback';

/**
 * Der Ton des Verdikt-Chips.
 *
 * **`aufmerksam` ist ein Captain-Entscheid (05.08.2026) und kein Design-Detail:**
 * „Wir können eigentlich nicht unter Durchschnitt sein — das bedeutet, wir
 * verkaufen, wenn's weniger kostet, also Gegenteil von Optimieren." Unter dem
 * Durchschnitt zu liegen darf deshalb NIE wie ein hinnehmbarer Normaltag
 * aussehen. Es ist trotzdem ein RUHIGER Warnton (Haus-Warn-Token), kein roter
 * Alarm: die Anlage ist nicht kaputt, die Lage ist prüfenswert.
 */
export type VerdictTon = 'vorteil' | 'neutral' | 'aufmerksam';

/** Die Antwort auf „Ist das gut?" — sie steht ÜBER dem Bild, das sie beweist. */
export interface VerdictChip {
  ton: VerdictTon;
  /** Der volle Chip-Text (bei `aufmerksam` inkl. des Prüf-Zusatzes). */
  text: string;
  /** Nur die Einordnung — der `marktVergleich()`-Wortlaut, ohne Zusatz. */
  vergleich: string;
}

/** Die Zahlen, aus denen das Bild gebaut wird — alle in ct/kWh. */
export interface ChartData {
  /** Ø Monatsmarktwert Solar; `null` = Leer-Platzhalter MIT Grund (S6). */
  oeCt: number | null;
  /** Was die eigene Anlage am Markt erzielt hat. */
  erCt: number;
  /** Der Garantiewert (anzulegender Wert); `null` = keine Linie (S5). */
  awCt: number | null;
  /** Der Monats-SATZ der Prämie (`AW − Ø`, nie negativ); `0` = kein Block. */
  satzCt: number;
  /** Ø-Säule schraffiert + „vorläufig"-Tag — ein ruhiger Stand, kein Alarm. */
  vorlaeufig: boolean;
  /** Beschriftung über der eigenen Säule. */
  topLabel: string;
  /** Bildunterschriften der eigenen Säule. */
  eigenCaption: string;
  eigenSubCaption: string;
  /** Der zugängliche Name des Bildes — er ERZÄHLT den Zustand, nicht die Form. */
  ariaLabel: string;
}

export interface SoVerdientView {
  form: SoVerdientForm;
  state: SoVerdientState;
  /** „So verdient Ihre Anlage · August 2026" (ohne Monat: ohne Zusatz). */
  titel: string;
  monatLabel: string | null;
  /** `null` = kein Maßstab (S6) oder keine eigene Säule (S7). */
  verdict: VerdictChip | null;
  /** `null` außer bei `form === 'chart'`. */
  chart: ChartData | null;
  /** Der Kernsatz unter dem Bild — nur, wo es ein Bild gibt. */
  kernsatz: string | null;
  /** Der ehrliche Grund, warum hier kein Bild steht (S7/S8). */
  hinweis: string | null;
  /** Die absorbierten Export-Zeilen — nur in der Zeilen-Form (S8). */
  zeilen: PreisZeile[];
  /** Die Prämien-Zeile, wörtlich aus `marktpraemie()`. */
  praemie: MarktpraemieView;
  /*
   * ⚠ Das frühere `absorbiert` ist mit der Preis-Karte ENTFALLEN (P6/E5).
   *   Es sagte der Karte „Was den Preis gemacht hat", welche Kacheln sie
   *   auslassen soll; die Karte gibt es nicht mehr, ihre Preise wohnen in
   *   Ebene 2 der Ergebnis-Karte. Ein Feld, das nur eine gelöschte Karte
   *   gelesen hat, ist toter Code — und `ZEILEN_FORM` unten sagt weiterhin,
   *   was DIESE Karte zeigt.
   */
}

// ---------------------------------------------------------------------------
// Copy — genau drei neue Sätze, alles andere ist wiederverwendet (§7)
// ---------------------------------------------------------------------------

export const KARTEN_TITEL = 'So verdient Ihre Anlage';

/**
 * Der Kernsatz, immer unter dem Bild. Er ist in BEIDEN Prämien-Lagen wahr —
 * Aufstockung UND „voll aus dem Markt" — und trägt die Pointe wörtlich
 * (Captain-Wortwahl 05.08.2026: die Kurzfassung).
 */
export const KERNSATZ =
  'Die Prämie richtet sich nach dem Durchschnitt — Ihr Timing-Vorteil bleibt Ihnen ungeschmälert.';

/**
 * S8: EIN Ø wäre eine Behauptung über zwölf verschiedene Monatswerte. Lieber
 * kein Monat als der falsche (die `praemieMonat`-Regel).
 */
export const MEHRERE_MONATE_HINWEIS =
  'Die Prämie wird je Monat abgerechnet — wählen Sie einen Monat, um das Bild zu sehen.';

/** S7: ohne eigene Säule gibt es kein Bild, aber einen ehrlichen Satz. */
export const NICHTS_EINGESPEIST_HINWEIS =
  'In diesem Zeitraum wurde nichts eingespeist — sobald Ihre Anlage einspeist, zeigt diese Karte, wie sich Ihr Erlös je kWh zusammensetzt.';

/**
 * Der Prüf-Zusatz des Verdikt-Chips (Captain-Override zu S4). Er benennt, WARUM
 * „unter dem Durchschnitt" nicht neutral ist, statt es nur einzufärben.
 */
export const UNTER_DURCHSCHNITT_ZUSATZ =
  'prüfenswert: die Optimierung verkauft normalerweise über dem Durchschnitt';

/** S5: die Garantie-Linie fehlt ehrlich — der Timing-Vergleich läuft weiter. */
export const OHNE_GARANTIEWERT_NOTE = ['Garantiewert', 'nicht hinterlegt'] as const;

/** S6: der Ø-Platz behauptet KEINEN Wert. */
export const OHNE_MONATSWERT_NOTE = ['noch nicht', 'veröffentlicht'] as const;

export const OE_CAPTION = ['Ø Monatsmarktwert', 'Solar (alle Anlagen)'] as const;

/**
 * Was die Zeilen-Form (S8) als KACHEL zeigt. Die Marktprämie fehlt hier
 * absichtlich: sie hat auf JEDER Form dieser Karte ihre eigene Fußzeile, und
 * beides zusammen stellte denselben Betrag samt Rechnung zweimal auf eine
 * Karte — genau die Doppelung, gegen die die Absorption gebaut ist.
 */
const ZEILEN_FORM: readonly PreisZeileId[] = ['marktwert', 'monatsmarktwert'];

/**
 * Das Anzeige-Totband: unter 0,05 ct liegt die eigene Säule „etwa auf Höhe" des
 * Durchschnitts — dieselbe Schwelle, mit der `marktVergleich` formuliert.
 */
const VERGLEICH_DEADBAND_CT = 0.05;

/**
 * Wie genau die Gesamtmarke aufgehen muss, um überhaupt zu erscheinen. Gerundet
 * wird auf die EINE angezeigte Nachkommastelle — eine Gleichung, die um eine
 * gerundete Stelle danebenliegt, wäre schlimmer als keine
 * (das `aufstockungsRechnung`-Muster).
 */
const GESAMT_TOLERANZ_CT = 0.05;

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** ct/kWh in Kundenschreibweise — eine Nachkommastelle, wie im ganzen Bild. */
export function ctText(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Der Zeitraum-Zusatz der eigenen Säule — nur wo er etwas klarstellt. */
function eigenCaption(range: SiteEarningsRange | null | undefined): string {
  if (range === 'day') return 'Ihre Anlage · Tag';
  if (range === 'week') return 'Ihre Anlage · Woche';
  return 'Ihre Anlage';
}

// ---------------------------------------------------------------------------
// Das Verdikt — die Antwort zuerst, das Bild als Beweis
// ---------------------------------------------------------------------------

/**
 * Die Einordnung der eigenen Säule gegen den Durchschnitt. `null`, sobald einer
 * der beiden Werte fehlt — ohne Maßstab wird nichts behauptet.
 */
export function verdictChip(
  erzielt: number | null,
  markt: number | null,
): VerdictChip | null {
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
  return {
    ton: 'aufmerksam',
    text: `${vergleich} — ${UNTER_DURCHSCHNITT_ZUSATZ}`,
    vergleich,
  };
}

/**
 * Die Gesamtmarke „7,4 + 1,1 = 8,5 ct je kWh". Sie erscheint NUR, wenn sie mit
 * dem servergerechneten Einspeise-Erlös aufgeht (Konzept D3): §51 setzt die
 * Prämie in Negativpreis-Viertelstunden aus, Satz und effektiver Erlös können
 * also auseinanderfallen — dann behauptet das Bild lieber keine Summe.
 */
export function gesamtMarke(
  erCt: number,
  satzCt: number,
  einspeiseErloesEur: number | null | undefined,
  eingespeistKwh: number | null | undefined,
): number | null {
  if (satzCt <= 0) return null;
  const eur = num(einspeiseErloesEur);
  const kwh = num(eingespeistKwh);
  if (eur == null || kwh == null || kwh <= 0) return null;
  const effektivCt = (eur / kwh) * 100;
  const summe = erCt + satzCt;
  return Math.abs(effektivCt - summe) <= GESAMT_TOLERANZ_CT ? summe : null;
}

/** Die Beschriftung über der eigenen Säule. */
function topLabel(erCt: number, satzCt: number, gesamt: number | null): string {
  if (satzCt <= 0) return `${ctText(erCt)} ct`;
  if (gesamt != null) {
    return `${ctText(erCt)} + ${ctText(satzCt)} = ${ctText(gesamt)} ct je kWh`;
  }
  return `${ctText(erCt)} + ${ctText(satzCt)} ct`;
}

/**
 * Der zugängliche Name des Bildes. Er erzählt den ZUSTAND in einem Satz — was
 * die eigene Säule erzielt hat, wie der Durchschnitt dazu steht und was die
 * Prämie tut —, damit ein Screenreader dieselbe Geschichte bekommt wie das Auge.
 */
export function chartAriaLabel(input: {
  state: SoVerdientState;
  erCt: number;
  oeCt: number | null;
  awCt: number | null;
  satzCt: number;
  vorlaeufig: boolean;
  verdict: VerdictChip | null;
}): string {
  const teile: string[] = [
    `Erlös je Kilowattstunde: Ihre Anlage erzielte ${ctText(input.erCt)} ct`,
  ];
  if (input.oeCt == null) {
    teile.push('für diesen Zeitraum ist noch kein Monatsdurchschnitt veröffentlicht');
  } else {
    const stand = input.vorlaeufig ? ' (vorläufig)' : '';
    teile.push(
      `der Monatsdurchschnitt aller Solaranlagen liegt bei ${ctText(input.oeCt)} ct${stand}` +
        (input.verdict ? ` — ${input.verdict.vergleich}` : ''),
    );
  }
  if (input.awCt == null) {
    teile.push('ein Garantiewert ist nicht hinterlegt, deshalb zeigt das Bild keine Prämie');
  } else if (input.satzCt > 0) {
    teile.push(
      `die Marktprämie stockt um ${ctText(input.satzCt)} ct auf den Garantiewert ${ctText(input.awCt)} ct auf`,
    );
  } else {
    teile.push(
      `die Marktprämie ruht, weil der Monatsdurchschnitt den Garantiewert ${ctText(input.awCt)} ct erreicht hat`,
    );
  }
  return `${teile.join('; ')}.`;
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
 * Das Kombinations-Bild einer Anlage — oder `null`, wenn es hier gar keine
 * Karte gibt.
 *
 * **`null` heißt: nicht direkt vermarktet (S9).** Ohne Direktvermarktung gibt es
 * keine Marktprämie und keinen Monatsmarktwert als Maßstab; die Preis-Karte
 * behält dann ihre fünf Kacheln samt der ehrlichen Zeile „Ihre Anlage wird nicht
 * direkt vermarktet …", die `marktpraemie.ts` für sie gebaut hat.
 */
export function soVerdient(input: SoVerdientInput): SoVerdientView | null {
  const m = input.money;
  if (!m || m.plantKind !== 'direktvermarktung') return null;

  const siteId = input.siteId ?? null;
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
    siteId,
  });

  const monat = praemieMonat(m.from, m.to);
  const titel = monat ? `${KARTEN_TITEL} · ${monat}` : KARTEN_TITEL;
  const basis = { titel, monatLabel: monat, praemie } as const;

  // S8 — mehrere Kalendermonate: EIN Ø wäre eine Behauptung über viele
  // Monatswerte. Statt eines falschen Bildes die Zeilen-Form, die dieselben
  // Zahlen ohne Durchschnitts-Behauptung trägt.
  if (!monat) {
    return {
      ...basis,
      form: 'rows',
      state: 'mehrere_monate',
      verdict: null,
      chart: null,
      kernsatz: null,
      hinweis: MEHRERE_MONATE_HINWEIS,
      zeilen: exportZeilen(m),
    };
  }

  const erzielt = num(m.realizedExportCtKwh);
  const markt = num(m.marketValueSolarCtKwh);
  const aw = num(m.anzulegenderWertCtKwh);

  // S7 — ohne eigene Säule gibt es kein Zwei-Säulen-Bild. Die Karte fällt auf
  // den Satz zurück und übernimmt nur die Prämien-Zeile.
  if (erzielt == null) {
    return {
      ...basis,
      form: 'fallback',
      state: 'nichts_eingespeist',
      verdict: null,
      chart: null,
      kernsatz: null,
      hinweis: NICHTS_EINGESPEIST_HINWEIS,
      zeilen: [],
    };
  }

  // Der Satz ist die Größe der `aufstockungsRechnung` — nie negativ, und ohne
  // eine der beiden Zahlen gibt es keinen Block.
  const satz = aw != null && markt != null ? Math.max(aw - markt, 0) : 0;
  const verdict = verdictChip(erzielt, markt);
  const vorlaeufig = m.marketValueProvisional === true && markt != null;

  const state: SoVerdientState =
    markt == null
      ? 'ohne_monatswert'
      : aw == null
        ? 'ohne_garantiewert'
        : satz > 0
          ? 'praemien_monat'
          : 'voll_aus_dem_markt';

  const gesamt = gesamtMarke(erzielt, satz, m.einspeiseErloesEur, m.eingespeistKwh);

  return {
    ...basis,
    form: 'chart',
    state,
    verdict,
    chart: {
      oeCt: markt,
      erCt: erzielt,
      awCt: aw,
      satzCt: satz,
      vorlaeufig,
      topLabel: topLabel(erzielt, satz, gesamt),
      eigenCaption: eigenCaption(m.range),
      eigenSubCaption: satz > 0 ? 'erzielt + Prämie' : 'am Markt erzielt',
      ariaLabel: chartAriaLabel({
        state,
        erCt: erzielt,
        oeCt: markt,
        awCt: aw,
        satzCt: satz,
        vorlaeufig,
        verdict,
      }),
    },
    kernsatz: KERNSATZ,
    hinweis: null,
    zeilen: [],
  };
}

/**
 * Die zwei Export-Kacheln der Zeilen-Form (S8) — WÖRTLICH die Texte, die bis
 * P6 die Karte „Was den Preis gemacht hat" trug. Sie werden hier gebaut, seit
 * jene Karte entfallen ist (E5): dieselben Sätze, nur ohne den Umweg über eine
 * Karte, die es nicht mehr gibt.
 *
 * `ZEILEN_FORM` bleibt die EINE Liste dessen, was diese Form zeigt — die
 * Reihenfolge der Kacheln folgt ihr, nicht dem Code hier.
 */
function exportZeilen(money: SiteEarnings): PreisZeile[] {
  const erzielt = num(money.realizedExportCtKwh);
  const markt = num(money.marketValueSolarCtKwh);
  const zeile = (id: PreisZeileId): PreisZeile => {
    if (id === 'marktwert') {
      return {
        id,
        label: 'Ihr erzielter Marktwert',
        wert: erzielt == null ? DASH : `${ctText(erzielt)} ct/kWh`,
        note:
          erzielt == null
            ? 'In diesem Zeitraum wurde nichts eingespeist.'
            : markt == null
              ? null
              : marktVergleich(erzielt, markt),
        vorhanden: erzielt != null,
        hinweise: [],
        href: null,
      };
    }
    return {
      id,
      label: 'Monatsmarktwert Solar',
      wert: markt == null ? DASH : `${ctText(markt)} ct/kWh`,
      note:
        markt == null
          ? 'Für diesen Zeitraum ist noch kein Monatsdurchschnitt veröffentlicht.'
          : money.marketValueProvisional
            ? 'vorläufig — der endgültige Wert wird nachgereicht'
            : null,
      vorhanden: markt != null,
      hinweise: [],
      href: null,
    };
  };
  return ZEILEN_FORM.map(zeile);
}

// ---------------------------------------------------------------------------
// Geometrie — der Beweis steckt im Bild, also muss das Bild rechnen können
// ---------------------------------------------------------------------------

/**
 * **Ehrliche Skala per Konstruktion:** jede Höhe wird aus den ECHTEN Zahlen
 * gegen eine Achse ab 0 gerechnet, nichts ist von Hand gezeichnet. Der Prototyp
 * des Konzepts (`concept.html`) ist hierher portiert, nicht neu erfunden.
 */
export interface ChartLayoutOpts {
  /** Breitere Bühne mit größerer Chip-Zone (Desktop-Kartenbreite). */
  wide?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LayoutText {
  x: number;
  y: number;
  text: string;
  /**
   * Harte Kappung der Zeilenbreite. Gesetzt NUR, wenn die Schätzbreite das
   * Fenster sprengen könnte — der Betrachter lädt womöglich eine breitere
   * Ersatzschrift als der Autor, und ein überlaufendes Label wäre dann still
   * abgeschnitten statt gestaucht.
   */
  textLength?: number;
  fontSize: number;
}

export interface LayoutChip {
  /** Wo der Chip WIRKLICH steht (nach dem Entzerren). */
  y: number;
  /** Wo er hingehört — die Leader-Linie schlägt die Brücke. */
  anchorY: number;
  titel: LayoutText;
  wert: LayoutText;
  leader: LayoutLine;
  /** Der Prämien-Chip trägt einen Farbpunkt, der Garantie-Chip nicht. */
  punkt: boolean;
}

export interface ChartLayout {
  width: number;
  height: number;
  /** Die Nulllinie — die ehrliche Basis, immer sichtbar. */
  baseline: LayoutLine;
  /** Die Ø-Säule; `null` im Leer-Platzhalter-Fall. */
  oeBar: Rect | null;
  /** Der gestrichelte Leer-Platzhalter (S6) MIT seinem Grund. */
  oePlaceholder: { rect: Rect; dash: LayoutText; grund: LayoutText[] } | null;
  /** Die Ø-Führungslinie = die Verlängerung der Säulen-Oberkante. */
  oeLine: LayoutLine | null;
  oeWert: LayoutText | null;
  oeStand: LayoutText | null;
  /** Die eigene Säule (unten) und der Prämien-Block (oben). */
  erBar: Rect;
  praemieBar: Rect | null;
  /**
   * Die 2-px-Weißfuge zwischen beiden Segmenten. Sie wird ÜBER die Grenze
   * gezeichnet, statt von einem der Segmente abgezogen zu werden — sonst wäre
   * der grüne Block um die Fuge kürzer als der Linien-Abstand, den er beweisen
   * soll (im Browser nachgemessen: 29,9 statt 33,3 px). Eine Fuge ist Optik,
   * kein Messwert; sie darf keine Höhe verfälschen.
   */
  fuge: Rect | null;
  erLabel: LayoutText;
  /** Die Garantiewert-Linie über die volle Breite. */
  awLine: LayoutLine | null;
  chips: LayoutChip[];
  /** S5: der Hinweis anstelle der fehlenden Garantie-Linie. */
  awFehltNote: LayoutText[] | null;
  captions: LayoutText[];
}

/** Mindestabstand zweier Chips, bevor sie entzerrt werden. */
export const CHIP_MIN_ABSTAND = 30;
/** Halber Abstand, auf den kollidierende Chips gespreizt werden. */
export const CHIP_SPREIZUNG = 17;

/**
 * Zwei Chips, die übereinander liegen würden, werden symmetrisch um ihre Mitte
 * gespreizt — die Leader-Linien zeigen weiterhin auf die echte Höhe, also
 * verschiebt das Entzerren die AUSSAGE nicht, nur die Beschriftung.
 */
export function spreadChips<T extends { y: number }>(chips: T[]): T[] {
  if (chips.length !== 2) return chips;
  const [a, b] = chips;
  if (Math.abs(a.y - b.y) >= CHIP_MIN_ABSTAND) return chips;
  const mitte = (a.y + b.y) / 2;
  const oben = a.y <= b.y ? a : b;
  const unten = a.y <= b.y ? b : a;
  oben.y = mitte - CHIP_SPREIZUNG;
  unten.y = mitte + CHIP_SPREIZUNG;
  return chips;
}


/**
 * Baut das ganze Bild aus den echten Zahlen. Die Funktion ist rein — genau
 * deshalb sind Kollisions- und Grenzfälle (die 0,1-ct-Lage des realen August)
 * ohne Browser prüfbar.
 */
export function chartLayout(data: ChartData, opts: ChartLayoutOpts = {}): ChartLayout {
  const wide = opts.wide === true;
  const width = wide ? 520 : 344;
  const height = 252;
  const padT = 30;
  const padB = 46;
  const padL = 14;
  const padR = wide ? 150 : 120;
  const plotL = padL;
  const plotR = width - padR;
  const plotW = plotR - plotL;
  const plotB = height - padB;
  const plotH = plotB - padT;
  const barW = wide ? 96 : 76;
  const xOe = plotL + plotW * 0.25;
  const xEr = plotL + plotW * 0.77;

  const { oeCt, erCt, awCt, satzCt } = data;
  // Der Kopfraum (14 %) hält die Beschriftung über der höchsten Säule frei;
  // die Achse beginnt trotzdem bei 0 — gestaucht wird nie.
  const maxV = Math.max(erCt + satzCt, oeCt ?? 0, awCt ?? 0, 1) * 1.14;
  const y = (v: number) => plotB - (v / maxV) * plotH;

  const layout: ChartLayout = {
    width,
    height,
    baseline: { x1: plotL, y1: plotB, x2: width - 10, y2: plotB },
    oeBar: null,
    oePlaceholder: null,
    oeLine: null,
    oeWert: null,
    oeStand: null,
    erBar: { x: 0, y: 0, width: 0, height: 0 },
    praemieBar: null,
    fuge: null,
    erLabel: { x: 0, y: 0, text: '', fontSize: 12.5 },
    awLine: null,
    chips: [],
    awFehltNote: null,
    captions: [],
  };

  // --- Ø-Säule bzw. der Leer-Platzhalter -----------------------------------
  if (oeCt != null) {
    const yo = y(oeCt);
    layout.oeBar = { x: xOe - barW / 2, y: yo, width: barW, height: plotB - yo };
    layout.oeLine = { x1: xOe + barW / 2, y1: yo, x2: plotR, y2: yo };
    layout.oeWert = { x: xOe, y: yo - 8, text: `${ctText(oeCt)} ct`, fontSize: 12.5 };
    if (data.vorlaeufig) {
      layout.oeStand = { x: xOe, y: yo - 22, text: 'vorläufig', fontSize: 9.5 };
    }
  } else {
    const mitte = padT + (plotB - padT) / 2;
    layout.oePlaceholder = {
      rect: { x: xOe - barW / 2, y: padT, width: barW, height: plotB - padT },
      dash: { x: xOe, y: mitte - 4, text: '—', fontSize: 15 },
      grund: OHNE_MONATSWERT_NOTE.map((t, i) => ({
        x: xOe,
        y: mitte + 13 + i * 11,
        text: t,
        fontSize: 9,
      })),
    };
  }

  // --- Eigene Säule + Prämien-Block ----------------------------------------
  // BEIDE Segmente sind exakt: der Block reicht von `er` bis `er + satz`, also
  // ist seine Höhe wörtlich der Abstand der beiden Führungslinien — das ist der
  // ganze Beweis. Die Fuge liegt DARÜBER.
  const ye = y(erCt);
  const xBar = xEr - barW / 2;
  layout.erBar = { x: xBar, y: ye, width: barW, height: plotB - ye };
  if (satzCt > 0) {
    const yp = y(erCt + satzCt);
    layout.praemieBar = { x: xBar, y: yp, width: barW, height: ye - yp };
    layout.fuge = { x: xBar, y: ye - 1, width: barW, height: 2 };
  }

  // Die Beschriftung darf weder links heraus- noch in die Chip-Zone laufen.
  const fs = data.topLabel.length > 12 ? 11.5 : 12.5;
  const halb = data.topLabel.length * fs * 0.34;
  const lx = Math.max(plotL + halb, Math.min(xEr, plotR + 4 - halb));
  layout.erLabel = { x: lx, y: y(erCt + satzCt) - 8, text: data.topLabel, fontSize: fs };

  // --- Rechte Chips: Garantie-Linie + Prämien-Block ------------------------
  const roh: { y: number; anchorY: number; titel: string; wert: string; punkt: boolean }[] = [];
  if (awCt != null) {
    const ya = y(awCt);
    layout.awLine = { x1: plotL, y1: ya, x2: plotR, y2: ya };
    roh.push({
      y: ya,
      anchorY: ya,
      titel: 'Garantiewert',
      wert: `${ctText(awCt)} ct`,
      punkt: false,
    });
  }
  if (satzCt > 0) {
    const yc = (y(erCt) + y(erCt + satzCt)) / 2;
    roh.push({
      y: yc,
      anchorY: yc,
      titel: 'Marktprämie',
      wert: `+ ${ctText(satzCt)} ct`,
      punkt: true,
    });
  }
  spreadChips(roh);

  const chipX = plotR + 10;
  const chipMax = width - chipX - 6;
  layout.chips = roh.map((c) => ({
    y: c.y,
    anchorY: c.anchorY,
    punkt: c.punkt,
    leader: { x1: plotR, y1: c.anchorY, x2: chipX - 3, y2: c.y },
    titel: {
      x: chipX,
      y: c.y - 2,
      text: c.titel,
      fontSize: 10,
      // Der Punkt vor dem Titel kostet Platz — er zählt in der Schätzung mit.
      textLength: capTextLength(c.punkt ? `x ${c.titel}` : c.titel, 10, chipMax),
    },
    wert: {
      x: chipX,
      y: c.y + 11,
      text: c.wert,
      fontSize: 10.5,
      textLength: capTextLength(c.wert, 10.5, chipMax),
    },
  }));

  // S5: ohne Garantiewert steht dort der Grund, nie eine erfundene Linie.
  if (awCt == null && oeCt != null) {
    layout.awFehltNote = OHNE_GARANTIEWERT_NOTE.map((t, i) => ({
      x: chipX,
      y: padT + 14 + i * 12,
      text: t,
      fontSize: 9.5,
      textLength: Math.min(chipMax, i === 0 ? 78 : 92),
    }));
  }

  // --- Beschriftungen unter den Säulen -------------------------------------
  layout.captions = [
    { x: xOe, y: plotB + 16, text: OE_CAPTION[0], fontSize: 10 },
    { x: xOe, y: plotB + 28, text: OE_CAPTION[1], fontSize: 10 },
    { x: xEr, y: plotB + 16, text: data.eigenCaption, fontSize: 10 },
    { x: xEr, y: plotB + 28, text: data.eigenSubCaption, fontSize: 10 },
  ];

  return layout;
}
