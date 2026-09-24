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
import { eurAmount, fmtNum, NBSP } from './format';

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

/** Dieselbe Messlatte als Attribut („dieselbe Anlage, aber …“). */
export const MESSLATTE_KURZ = 'ohne smarte Steuerung';

/**
 * Dieselbe Messlatte im DATIV mit unbestimmtem Artikel („Vergleich mit …").
 *
 * ⚠ Es sind vier Formen, weil das Deutsche vier Fälle hat — nicht vier
 * Wahrheiten: wer die Formulierung ändert, ändert alle vier zusammen. Ein
 * Satz, der `MESSLATTE` in eine Dativ-Lücke setzt, liest sich als „Vergleich
 * mit EIN Speicher" (genau so im Test aufgefallen).
 */
export const MESSLATTE_DATIV_UNBESTIMMT = 'einem Speicher ohne smarte Steuerung';

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

/**
 * Die GESCHLOSSENE Liste der Grund-Kennungen eines Minus-Tages, in der
 * Rangfolge des Servers (`SteuerungGrund.java`; Regeln, Schwellen und
 * Rangfolge in `docs/contracts/steuerung-tag-vectors.json`, Block `grund`).
 * Der Server entscheidet, OB ein Grund greift; das Portal wählt nur die Worte
 * dazu. Eine Kennung, die hier fehlt, wird nie als Code gezeigt.
 */
export const STEUERUNG_GRUENDE = [
  'gestern_verkauft',
  'haelt_energie_fuer_morgen',
  'so_geplant',
  'wenig_sonne',
  'anders_als_geplant',
] as const;
export type SteuerungGrund = (typeof STEUERUNG_GRUENDE)[number];

/** Höchstens so viele Gründe stehen in einer Zeile (Konzept k1 E3 = A). */
export const GRUENDE_HOECHSTENS = 2;

/** Ein Anker des größeren Zeitraums: „September bisher + 116,94 €". */
export interface SpeicherAnker {
  label: string;
  wert: string;
  eur: number;
}

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

  /* --- Einordnung eines Tages (Konzept k1 §7, E1/E3/E4 = A) --- */
  /**
   * Die Grund-Kennungen des Servers, höchstens zwei, in Rangfolge — nur
   * bekannte Wörter der geschlossenen Liste. `[]` = berechnet, kein Grund
   * (Plus-Tag oder keine Regel greift); `null` = nicht berechnet (anderer
   * Zeitraum, älteres Backend) — dann gilt die bisherige Formulierung.
   */
  gruende: SteuerungGrund[] | null;
  /**
   * Die Sekundärzeile unter einem Minus-Tag: der Grund in Worten mit Zahl,
   * beim Vortags-Verkauf mit dem Paar („gestern verkauft + 12,78 € · beide
   * Tage + 3,00 €"). null = kein Grund — dann steht nur der Chip da.
   */
  grundZeile: string | null;
  /** Der erste Grund mit seiner Zahl, ohne Paar (Portfolio-Kachel). */
  grundErster: string | null;
  /** Der erste Grund als Kurzwort (Tabellenzelle): „gestern verkauft". */
  grundKurz: string | null;
  /**
   * Der Anker des größeren Zeitraums (E4): unter der Tageszahl der laufende
   * Monat, unter der Monatszahl das Jahr — dieselbe Zahl wie der Reiter.
   */
  anker: SpeicherAnker | null;

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
  /** Fensteranfang (ISO) — der Tag des Ankers; die Flotten-Zeile hat keinen. */
  from?: string | null;
  /* Die Einordnung des Tages (z2, nur `range=day`, sonst null). */
  steuerungVortagEur?: number | null;
  steuerungMonatBisherEur?: number | null;
  steuerungPlannedEur?: number | null;
  steuerungGruende?: readonly string[] | null;
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
  /**
   * Der Anker einer MONATSZAHL (E4): `savedSteuerungEur` des Jahres aus
   * `range=year` — dieselbe Zahl wie der Jahres-Reiter. Er wohnt in einer
   * anderen Antwort und wird deshalb hereingereicht; ohne ihn kein Anker.
   */
  jahrAnker?: { eur: number | null; jahr: number; laeuft: boolean } | null;
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

/** „+ 116,94 €" / „− 9,78 €" / „0,00 €" — die Vorzeichen-Grammatik dieser Datei für andere Flächen. */
export function geldWort(v: number): string {
  return fest(tonWort(v).wort);
}

function anzeigeTonVon(eur: number, laeuft: boolean): SpeicherTon {
  if (laeuft) return 'neutral';
  if (Math.abs(eur) < SPEICHER_TOTBAND) return 'neutral';
  return eur > 0 ? 'ok' : 'warn';
}

/** Cent-genau — die Paar-Zeile addiert, was der Leser sieht (s. {@link paarEur}). */
function r2(v: number): number {
  return (Math.sign(v) * Math.round(Math.abs(v) * 100 + 1e-9)) / 100;
}

/**
 * „beide Tage": die Summe der ZWEI GEZEIGTEN Tageszahlen. Sie ist die einzige
 * Addition dieser Datei und addiert bewusst die auf Cent gerundeten Werte —
 * sonst läse der Kunde „+ 12,78 €" und „− 9,78 €" und darunter „+ 2,99 €".
 * Beide Summanden sind Felder derselben Antwort und derselben Definition
 * (Tage ergeben den Monat), die Summe ist also keine zweite Rechnung.
 */
export function paarEur(heuteEur: number, vortagEur: number): number {
  return r2(r2(heuteEur) + r2(vortagEur));
}

/** Nur Kennungen der geschlossenen Liste, höchstens zwei, in Server-Reihenfolge. */
export function grundKennungen(roh: readonly string[] | null | undefined): SteuerungGrund[] | null {
  if (!Array.isArray(roh)) return null;
  const bekannt = roh.filter((k): k is SteuerungGrund =>
    (STEUERUNG_GRUENDE as readonly string[]).includes(k),
  );
  return bekannt.slice(0, GRUENDE_HOECHSTENS);
}

/** Zeichen und Betrag brechen nie auseinander („+ ⏎ 12,78 €" am Telefon). */
function fest(s: string): string {
  return s.replace(/([+−]) /g, `$1${NBSP}`);
}

interface GrundText {
  kurz: string;
  mitZahl: string;
  mitPaar: string;
}

/**
 * Die Worte zu einer Kennung. Laufend spricht die Zeile vom heutigen Tag
 * („gestern", „für morgen"), abgeschlossen vom gezeigten Tag („am Vortag",
 * „für den Folgetag"). Fehlt die Zahl eines Grundes, steht das Wort allein —
 * nie eine erfundene Zahl.
 */
function grundText(
  k: SteuerungGrund,
  money: SpeicherEingabe,
  heuteEur: number,
  laeuft: boolean,
): GrundText {
  const plan = num(money.steuerungPlannedEur ?? null);
  switch (k) {
    case 'gestern_verkauft': {
      const kurz = laeuft ? 'gestern verkauft' : 'am Vortag verkauft';
      const vortag = num(money.steuerungVortagEur ?? null);
      if (vortag == null) return { kurz, mitZahl: kurz, mitPaar: kurz };
      const mitZahl = `${kurz} ${tonWort(vortag).wort}`;
      return { kurz, mitZahl, mitPaar: `${mitZahl} · beide Tage ${tonWort(paarEur(heuteEur, vortag)).wort}` };
    }
    case 'haelt_energie_fuer_morgen': {
      const kurz = laeuft ? 'hält Energie für morgen' : 'hielt Energie für den Folgetag';
      const kwh = num(money.speicherVorsprungKwh ?? null);
      const mitZahl =
        kwh == null
          ? kurz
          : laeuft
            ? `hält ${fmtNum(kwh, 'kWh')} für morgen`
            : `hielt ${fmtNum(kwh, 'kWh')} für den Folgetag`;
      return { kurz, mitZahl, mitPaar: mitZahl };
    }
    case 'so_geplant': {
      const mitZahl = plan == null ? 'so geplant' : `so geplant (${tonWort(plan).wort})`;
      return { kurz: 'so geplant', mitZahl, mitPaar: mitZahl };
    }
    case 'wenig_sonne':
      return { kurz: 'wenig Sonne', mitZahl: 'wenig Sonne', mitPaar: 'wenig Sonne' };
    case 'anders_als_geplant': {
      const mitZahl =
        plan == null ? 'anders als geplant' : `anders als geplant (Plan ${tonWort(plan).wort})`;
      return { kurz: 'anders als geplant', mitZahl, mitPaar: mitZahl };
    }
  }
}

const BERLIN = 'Europe/Berlin';

/**
 * Der Anker unter der TAGESZAHL: der Monat bis einschließlich dieses Tages
 * (`steuerungMonatBisherEur`, = `range=month` zum selben Stand). Am Monats-
 * ersten entfällt er — dort ist er dieselbe Zahl wie der Tag.
 */
function monatsAnker(money: SpeicherEingabe, now: Date, laeuft: boolean): SpeicherAnker | null {
  const eur = num(money.steuerungMonatBisherEur ?? null);
  if (eur == null) return null;
  const tag = money.from ? new Date(money.from) : now;
  if (Number.isNaN(tag.getTime())) return null;
  const d = Number(tag.toLocaleDateString('de-DE', { day: 'numeric', timeZone: BERLIN }));
  if (d <= 1) return null;
  const monat = tag.toLocaleDateString('de-DE', { month: 'long', timeZone: BERLIN });
  return {
    label: laeuft ? `${monat} bisher` : `1.–${d}. ${monat}`,
    wert: tonWort(eur).wort,
    eur: r3(eur),
  };
}

/** Der Anker unter der MONATSZAHL: das Jahr (hereingereicht, s. {@link SpeicherKontext}). */
function jahresAnker(ctx: SpeicherKontext): SpeicherAnker | null {
  const j = ctx.jahrAnker;
  const eur = num(j?.eur ?? null);
  if (!j || eur == null) return null;
  return { label: j.laeuft ? 'Jahr bisher' : `Jahr ${j.jahr}`, wert: tonWort(eur).wort, eur: r3(eur) };
}

/** Der Klartext-Grund, wenn kein Vergleich möglich ist — inkl. Nachtrag-Weg. */
export const OHNE_VERGLEICH_SATZ =
  `Für diese Anlage fehlen die Speicher-Stammdaten — ohne sie ist kein Vergleich mit ${MESSLATTE_DATIV_UNBESTIMMT} ` +
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

  // Die EINORDNUNG (Konzept k1 §7, E1/E3 = A): der Grund kommt vom Server und
  // wird nur in Worte gesetzt — nie geraten, nie gecacht (der Grund eines
  // laufenden Tages kann am Abend kippen, z2 „Über die Paketgrenze" 1).
  const gruende = tag && steuerung ? grundKennungen(money.steuerungGruende) : null;
  const texte =
    steuerung && steuerung.ton === 'minus' && gruende && gruende.length > 0
      ? gruende.map((k) => grundText(k, money, steuerung.eur, laeuft))
      : [];
  const grundZeile = texte.length > 0 ? fest(texte.map((t) => t.mitPaar).join(' · ')) : null;

  const satz =
    steuerung == null
      ? null
      : steuerung.ton === 'plus'
        ? `Die Steuerung hat ${wann} ${steuerung.wort} gebracht — gegenüber ${MESSLATTE_DATIV}`
        : steuerung.ton === 'minus'
          ? gruende != null
            ? // Berechnet: nur der Grund des Servers — ohne ihn gar keiner.
              laeuft
              ? `Zwischenstand Steuerung: ${steuerung.wort} gegenüber ${MESSLATTE_DATIV}${grundZeile ? ` — ${grundZeile}` : ''}.`
              : `Die Steuerung hat ${wann} ${steuerung.wort} gebracht — weniger als ${MESSLATTE_DATIV}${grundZeile ? `; ${grundZeile}` : ''}.`
            : laeuft
              ? `Zwischenstand Steuerung: ${steuerung.wort} gegenüber ${MESSLATTE_DATIV} — sie hält Energie für später; die Kasse zählt sie erst, wenn der Speicher später den Netzbezug ersetzt.`
              : `Die Steuerung hat ${wann} ${steuerung.wort} gebracht — weniger als ${MESSLATTE_DATIV}.`
          : `Die Steuerung und ${MESSLATTE} liegen ${wann} gleichauf.`;

  const anker = steuerung
    ? tag
      ? monatsAnker(money, ctx.now, laeuft)
      : money.range === 'month'
        ? jahresAnker(ctx)
        : null
    : null;

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

    gruende,
    grundZeile,
    grundErster: texte[0] ? fest(texte[0].mitZahl) : null,
    grundKurz: texte[0]?.kurz ?? null,
    anker,

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
