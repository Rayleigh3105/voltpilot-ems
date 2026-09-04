/**
 * Die STEUERUNGS-AUSSAGE der Kundenansicht — EINE Zahl, EINE Messlatte.
 *
 * ⚠ **DIE MESSLATTE IST DERSELBE SPEICHER OHNE SMARTE STEUERUNG** (Captain
 * 04.09.2026, wörtlich zum Screenshot der Live-Anlage Pilsting/Herzogau:
 * „Das ist doch Quatsch, du musst Anlage immer mit Speicher berechnen, einer
 * halt ohne smart Steuerung."). Bis hierher führte diese Ableitung ZWEI
 * Zahlen: `savedEur` („Ihr Speicher hat … gebracht", gemessen gegen eine
 * Anlage GANZ OHNE Speicher) und darunter `savedSteuerungEur`. Die erste
 * beantwortet eine Frage, die kein Kunde hat — sein Speicher steht bereits im
 * Keller —, und sie stand als große Zahl über der kleinen, die wirklich
 * zählt. Sie ist ERSATZLOS aus der Kundenansicht entfallen.
 *
 * ⚠ **`savedEur`/`savedSpeicherEur`/`baselineEur` SIND ADMIN-ZAHLEN.** Sie
 * bleiben vollständig in der Antwort (Plattform-Optimizer, Flotten-Admin
 * führen sie weiter) — was sich geändert hat, ist WER sie zeigen darf. Hier
 * werden sie nur noch als PRÜFSUMME gelesen (der Identitäts-Wächter unten),
 * nie in einen Satz gesetzt.
 *
 * ⚠ **ES WIRD HIER NICHTS GERECHNET.** Jede Zahl ist ein Feld der Antwort;
 * die Ableitung setzt sie in Sätze. Eine zweite Rechnung im Portal wären zwei
 * Geldwahrheiten über dieselbe Kasse (dieselbe Falle, die das Bestandskonto
 * eine Datei weiter ausdrücklich vermeidet).
 *
 * ⚠ **DIESELBE ABLEITUNG SPEIST DREI FLÄCHEN**: die Erlöse-Karte (Langform),
 * die Cockpit-Erlöskarte und den Steuerungs-Bereich (beide `kurz`). Ohne das
 * sagt das Cockpit „Steuerung − 2,67 €" und die Erlöse-Seite „Steuerung
 * + 1,45 €" über dieselbe Stunde.
 *
 * ⚠ **OHNE VERGLEICH GIBT ES KEINE ZAHL — und die Gesamtzahl ist KEIN
 * ERSATZ.** Fehlen die Batterie-Stammdaten, sagt die Fläche den GRUND im
 * Klartext (`ohneVergleich`) und bietet den Nachtrag-Weg an. Ein ÄLTERES
 * Backend, das die Felder gar nicht kennt, bekommt gar keine Aussage
 * (`null`) — ein fehlendes FELD ist kein fehlendes STAMMDATUM.
 */
import type { PlantKind } from './api';
import { BESTAND_BADGE, bestandZeile, type BestandEingabe } from './erloesKomposition';
import { eurAmount } from './format';

/** Unter diesem Betrag rundet die Cent-Anzeige auf 0,00 € — dann ist es keine Aussage. */
export const SPEICHER_TOTBAND = 0.005;

/**
 * Toleranz des Identitäts-Wächters. `savedSpeicherEur + savedSteuerungEur ==
 * savedEur` gilt serverseitig per Konstruktion (BigDecimal-Subtraktion); ein
 * halber Cent Luft fängt die Gleitkomma-Reise durch JSON ab, ohne einen echten
 * Widerspruch durchzulassen.
 */
export const IDENTITAET_TOLERANZ = 0.005;

/**
 * Die MESSLATTE als Wort — sie steht in jedem Satz dieser Datei und in den
 * Rechenschritten (`erloesEbenen.speicherSchritte`) an GENAU EINER Stelle.
 * Zwei Formulierungen über dieselbe Vergleichsanlage wären zwei Messlatten.
 */
export const MESSLATTE = 'ein Speicher ohne smarte Steuerung';

/** Dieselbe Messlatte im Dativ („gegenüber DEMSELBEN Speicher …"). */
export const MESSLATTE_DATIV = 'demselben Speicher ohne smarte Steuerung';

/** Das VORZEICHEN einer Zahl als Wort — nie Farbe allein (§3.9). */
export type SpeicherVorzeichen = 'plus' | 'minus' | 'null';

/**
 * Der ANZEIGE-Ton: `ok` nur bei abgeschlossenem Zeitraum und Wert ≥ 0,005 €;
 * `neutral` bei laufendem Zeitraum (jede Zahl ist ein Zwischenstand) und im
 * Totband; `warn` bei abgeschlossen und < 0. Nie Grün auf einem Zwischenstand,
 * nie Rot auf einem Bewertungs-Minus — Rot ist auf dieser Seite für Stromkosten
 * reserviert.
 */
export type SpeicherTon = 'ok' | 'neutral' | 'warn';

/** Eine Geldzahl mit ihrem Vorzeichen-Wort. */
export interface SpeicherGeld {
  eur: number;
  ton: SpeicherVorzeichen;
  wort: string;
}

/** Warum die Aufteilung fehlt — der Server kennt genau einen Grund. */
export type SteuerungSplitReason = 'no_battery_data';

/** Die render-fertige Steuerungs-Aussage. */
export interface SpeicherAussage {
  /**
   * DIE Zahl: der Mehrwert der Steuerung gegenüber {@link MESSLATTE}
   * (`savedSteuerungEur`). `null` = es gibt keinen Vergleich — dann steht
   * `ohneVergleich` da, nie eine Ersatzzahl.
   */
  steuerung: SpeicherGeld | null;
  splitReason: SteuerungSplitReason | null;
  /** true = der Zeitraum läuft noch, jede Zahl ist ein Zwischenstand. */
  zwischenstand: boolean;
  /** Der volle Satz zur Zahl (Tooltip-Wortlaut); null ohne Zahl. */
  satz: string | null;
  /**
   * Der Klartext-GRUND, warum es keine Zahl gibt (inkl. Nachtrag-Weg);
   * null, sobald es eine Zahl gibt.
   */
  ohneVergleich: string | null;
  /** Zeile: das Bestandskonto; null ohne gemessene Bestandsänderung. */
  bestand: string | null;
  bestandBadge: string | null;
  /** Womit der Bestand bewertet wurde (Tooltip); null ohne Bewertung. */
  bestandTitel: string | null;
  /**
   * Was der Fahrplan vorab als Steuerungs-Mehrwert geplant hatte
   * (`history.totals.steuerungPlannedEur`); null ohne Planwert — und der
   * Planwert bleibt so lange ABWESEND, bis der Optimierer ihn gegen dieselbe
   * Messlatte rechnet (parallele Aufgabe). Die alte, gegen „ohne Speicher"
   * geplante Zahl erreicht diese Fläche nicht mehr.
   */
  geplant: string | null;

  /* --- Anzeige („Label · Zahl · Chip") --- */
  anzeigeTon: SpeicherTon;
  /** 2–3 Wörter: „Steuerung heute" / „Steuerung im Zeitraum". */
  label: string;
  /** „Zwischenstand" / „unter Null"; null = kein Chip. */
  chip: string | null;
  /** Der Betrag — „—", wo es keinen Vergleich gibt (nie eine 0). */
  wert: string;
  /** „Speicher-Daten fehlen ›"; null = kein Hinweis. */
  hinweis: string | null;
  /** true = der Hinweis führt auf die Technik-Seite (Stammdaten nachtragen). */
  nachtragLink: boolean;

  /* --- Kurzform für Cockpit + Steuerungs-Bereich --- */
  /** „Steuerung + 3,10 €" — EINE Zeile. */
  kurz: string;
  /** Der volle Wortlaut als Tooltip der Kurzform. */
  kurzTitel: string;

  /**
   * Ob es überhaupt etwas zu SAGEN gibt: eine Zahl ODER ein belegter Grund.
   * `false` heißt: die Fläche schweigt (älteres Backend) — nie eine 0, nie
   * die Gesamtzahl als Ersatz.
   */
  hatAussage: boolean;
}

/**
 * Was die Aussage aus der Antwort braucht. Bewusst STRUKTURELL (das
 * `BestandEingabe`-Muster), damit sowohl die Anlagen-Antwort (`SiteEarnings`)
 * als auch die Flotten-Zeile (`EarningsSite`) hineinpassen — die eine trägt
 * `range`/`to`, die andere nicht.
 *
 * ⚠ `savedEur`/`savedSpeicherEur` sind hier NUR die Prüfsumme des
 * Identitäts-Wächters; sie werden nie in einen Satz gesetzt.
 */
export interface SpeicherEingabe extends BestandEingabe {
  savedEur?: number | null;
  savedSpeicherEur?: number | null;
  savedSteuerungEur?: number | null;
  steuerungSplitReason?: SteuerungSplitReason | null;
  plantKind?: PlantKind | null;
}

export interface SpeicherKontext {
  now: Date;
  /**
   * Der geplante STEUERUNGS-Mehrwert des Fahrplans
   * (`history.totals.steuerungPlannedEur`). Er wohnt in einer ANDEREN Antwort
   * und wird deshalb hereingereicht statt geraten; `null`/`undefined` = der
   * Optimierer rechnet ihn noch gegen die alte Messlatte, dann bleibt die
   * Plan-Zeile weg.
   */
  steuerungGeplantEur?: number | null;
  /**
   * Ob der Zeitraum noch läuft. Ohne Angabe aus `to` abgeleitet; eine
   * Flotten-Zeile trägt kein Fensterende und behauptet dann keinen
   * Zwischenstand (statt einen zu erfinden).
   */
  laeuft?: boolean;
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Kaufmännisch (halb WEG von null) wie `toLocaleString` — `Math.round` allein rundet −1,585 auf −1,58. */
function r3(v: number): number {
  return (Math.sign(v) * Math.round(Math.abs(v) * 1000 + 1e-9)) / 1000;
}

/**
 * Vorzeichen als WORT + Ton. Im Totband ist die Zahl keine Aussage über eine
 * Richtung — sie bleibt „0,00 €" ohne Vorzeichen.
 */
function tonWort(v: number | null): SpeicherGeld {
  if (v == null || Math.abs(v) < SPEICHER_TOTBAND) {
    return { eur: v == null ? 0 : r3(v), ton: 'null', wort: eurAmount(0) };
  }
  const eur = r3(v);
  return eur > 0
    ? { eur, ton: 'plus', wort: `+ ${eurAmount(eur)}` }
    : { eur, ton: 'minus', wort: `− ${eurAmount(Math.abs(eur))}` };
}

function anzeigeTonVon(eur: number, laeuft: boolean): SpeicherTon {
  if (laeuft) return 'neutral';
  if (Math.abs(eur) < SPEICHER_TOTBAND) return 'neutral';
  return eur > 0 ? 'ok' : 'warn';
}

/** Der Klartext-Grund, wenn kein Vergleich möglich ist — inkl. Nachtrag-Weg. */
export const OHNE_VERGLEICH_SATZ =
  `Für diese Anlage fehlen die Speicher-Stammdaten — ohne sie ist kein Vergleich mit ${MESSLATTE} ` +
  'möglich: Kapazität sowie Lade- und Entladeleistung nachtragen ›';

/**
 * Die EINE Ableitung der Steuerungs-Aussage. `null` heißt: es gibt nichts zu
 * sagen — nie eine erfundene 0 und nie die Gesamtzahl als Ersatz.
 */
export function speicherAussage(
  money: SpeicherEingabe | null | undefined,
  ctx: SpeicherKontext,
): SpeicherAussage | null {
  if (!money) return null;
  const saved = num(money.savedEur ?? null);
  // Ohne berechenbare Kasse gibt es überhaupt keine Geld-Aussage über diesen
  // Zeitraum — dann sagt die Fläche gar nichts (der `reason` der Antwort
  // erklärt diesen Fall an anderer Stelle).
  if (saved == null) return null;

  const bis = money.to ? new Date(money.to).getTime() : NaN;
  const laeuft =
    ctx.laeuft ?? (Number.isFinite(bis) && bis > ctx.now.getTime());
  const tag = money.range === 'day';

  const speicherEur = num(money.savedSpeicherEur ?? null);
  const steuerungEur = num(money.savedSteuerungEur ?? null);
  // ⚠ Der Identitäts-Wächter: gehen die drei Zahlen nicht auf, wird GAR KEINE
  // Steuerungs-Zahl behauptet und protokolliert — nie eine Zahl, der die
  // eigene Prüfsumme widerspricht. Er kann nur bei einem inkonsistenten
  // Backend anschlagen.
  let split = steuerungEur != null;
  if (
    split &&
    speicherEur != null &&
    Math.abs(speicherEur + (steuerungEur as number) - saved) > IDENTITAET_TOLERANZ
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `speicherAussage: savedSpeicherEur + savedSteuerungEur (${speicherEur} + ${steuerungEur}) ` +
        `ergibt nicht savedEur (${saved}) — die Steuerungs-Zahl wird ausgelassen.`,
    );
    split = false;
  }
  const widerspruch = steuerungEur != null && !split;

  const steuerung = split ? tonWort(steuerungEur) : null;

  // Der GRUND wird nur genannt, wenn der Server ihn nennt. Ein fehlendes Feld
  // (älteres Backend) ist kein fehlendes Stammdatum — dann gibt es schlicht
  // keine Aussage, ohne Nachtrag-Aufforderung.
  const grund: SteuerungSplitReason | null =
    split || widerspruch ? null : (money.steuerungSplitReason ?? null);

  if (steuerung == null && grund == null) return null;

  const wann = laeuft
    ? tag
      ? 'heute bisher'
      : 'in diesem Zeitraum bisher'
    : tag
      ? 'an diesem Tag'
      : 'in diesem Zeitraum';

  const satz =
    steuerung == null
      ? null
      : steuerung.ton === 'plus'
        ? `Die Steuerung hat ${wann} ${steuerung.wort} gebracht — gegenüber ${MESSLATTE_DATIV}`
        : steuerung.ton === 'minus'
          ? laeuft
            ? `Zwischenstand Steuerung: ${steuerung.wort} gegenüber ${MESSLATTE_DATIV} — sie hält Energie für später; die Kasse zählt sie erst, wenn der Speicher später den Netzbezug ersetzt.`
            : `Die Steuerung hat ${wann} ${steuerung.wort} gebracht — weniger als ${MESSLATTE_DATIV}.`
          : `Die Steuerung und ${MESSLATTE} liegen ${wann} gleichauf.`;

  const bestand = bestandZeile(money, ctx.now);
  const geplantEur = num(ctx.steuerungGeplantEur ?? null);

  const label = laeuft
    ? tag
      ? 'Steuerung heute'
      : 'Steuerung bisher'
    : tag
      ? 'Steuerung an diesem Tag'
      : 'Steuerung im Zeitraum';
  const anzeigeTon = steuerung ? anzeigeTonVon(steuerung.eur, laeuft) : 'neutral';

  const kurz = steuerung
    ? `${laeuft ? 'Zwischenstand Steuerung' : 'Steuerung'} ${steuerung.wort}`
    : 'Steuerung —';

  return {
    steuerung,
    splitReason: grund,
    zwischenstand: laeuft,
    satz,
    ohneVergleich: grund === 'no_battery_data' ? OHNE_VERGLEICH_SATZ : null,
    bestand: bestand?.text ?? null,
    bestandBadge: bestand?.badge ?? null,
    bestandTitel: bestand?.titel ?? null,
    geplant:
      geplantEur == null
        ? null
        : `Vorab geplant hatte der Fahrplan ${tonWort(geplantEur).wort} durch die Steuerung`,

    anzeigeTon,
    label,
    chip: steuerung
      ? laeuft
        ? 'Zwischenstand'
        : anzeigeTon === 'warn'
          ? 'unter Null'
          : null
      : null,
    wert: steuerung ? steuerung.wort : '—',
    hinweis: grund === 'no_battery_data' ? 'Speicher-Daten fehlen ›' : null,
    nachtragLink: grund === 'no_battery_data',

    kurz,
    kurzTitel: satz ?? (grund === 'no_battery_data' ? OHNE_VERGLEICH_SATZ : kurz),
    hatAussage: steuerung != null || grund != null,
  };
}

/** Das Etikett, das den Planwert von der gemessenen Kasse trennt. */
export { BESTAND_BADGE };
