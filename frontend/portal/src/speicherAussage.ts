/**
 * Die SPEICHER-AUSSAGE in zwei Ebenen (Erlöse-Konzept `vp-erloese-seite-konzept-e2`
 * §3.5/§3.6, Captain-Entscheide E2 = a und E8 = a, 02.09.2026).
 *
 * ⚠ DER BEHOBENE BEFUND IST EINE TEXT-ÄNDERUNG, KEINE ZAHLEN-ÄNDERUNG (§2.2/§3.5).
 * Der Chip „VoltPilots Steuerung: − 2,67 €" zeigte seit je `savedEur` — und das
 * misst den GANZEN SPEICHER (Baseline = dieselbe Anlage ohne Speicher), nicht
 * die Steuerung. Seit der Dreiteilung (PR 591, `savedEur = savedSpeicherEur +
 * savedSteuerungEur`) gibt es beide Zahlen, also heißt derselbe Wert jetzt
 * „Ihr Speicher hat … gebracht" und „VoltPilots Steuerung" ist erst
 * `savedSteuerungEur` — der Mehrwert gegenüber einem STUR arbeitenden Speicher.
 *
 * ⚠ ES WIRD HIER NICHTS GERECHNET. Jede Zahl ist ein Feld der Antwort; die
 * Ableitung setzt sie in Sätze. Eine zweite Rechnung im Portal wären zwei
 * Geldwahrheiten über dieselbe Kasse (dieselbe Falle, die das Bestandskonto
 * eine Datei weiter ausdrücklich vermeidet).
 *
 * ⚠ DIESELBE ABLEITUNG SPEIST DREI FLÄCHEN (§3.6): die Erlöse-Karte (Langform),
 * die Cockpit-Erlöskarte und den Steuerungs-Bereich (beide `kurz`). Ohne das
 * sagt das Cockpit „Steuerung − 2,67 €" und die Erlöse-Seite „Steuerung
 * + 1,45 €" über dieselbe Stunde.
 *
 * ⚠ EIN ÄLTERES BACKEND KENNT DIE DREI FELDER NICHT (§3.6): `undefined` wird
 * wie `null` OHNE Grund behandelt — dann NUR Zeile 1, keine Zeile 2 und kein
 * Nachtrag-Link. Ein fehlendes FELD ist kein fehlendes STAMMDATUM.
 */
import type { PlantKind } from './api';
import { BESTAND_BADGE, bestandZeile, type BestandEingabe } from './erloesKomposition';
import { proofAnchor } from './fleet';
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

/** Das VORZEICHEN einer Zahl als Wort — nie Farbe allein (§3.9). */
export type SpeicherVorzeichen = 'plus' | 'minus' | 'null';

/**
 * Der ANZEIGE-Ton (E8): `ok` nur bei abgeschlossenem Zeitraum und Wert ≥ 0,005 €;
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

/** Die render-fertige Speicher-Aussage. */
export interface SpeicherAussage {
  /* --- Zeile 1 + 2 (die Form, die das Konzept als `neu.speicher` erwartet) --- */
  /** Zeile 1: was der GANZE Speicher gebracht hat (`savedEur`). */
  gesamt: SpeicherGeld;
  /** Der stur arbeitende Vergleichs-Speicher (`savedSpeicherEur`); null ohne Aufteilung. */
  stur: SpeicherGeld | null;
  /** Zeile 2: der Mehrwert der Steuerung (`savedSteuerungEur`); null ohne Aufteilung. */
  steuerung: SpeicherGeld | null;
  splitReason: SteuerungSplitReason | null;
  /** true = der Zeitraum läuft noch, jede Zahl ist ein Zwischenstand. */
  zwischenstand: boolean;
  /** Der volle Satz der Zeile 1 (Tooltip-Wortlaut, §3.5). */
  satz: string;
  /**
   * Der volle Satz der Zeile 2. `null` heißt: es gibt nichts zu sagen — die
   * gelieferten Zahlen gehen nicht auf (Identitäts-Wächter, fail-soft).
   */
  steuerungSatz: string | null;
  /** Zeile 3: das Bestandskonto; null ohne gemessene Bestandsänderung. */
  bestand: string | null;
  bestandBadge: string | null;
  /** Womit der Bestand bewertet wurde (Tooltip); null ohne Bewertung. */
  bestandTitel: string | null;
  /** Zeile 4 (E6): was der Fahrplan vorab geplant hatte; null ohne Planwert. */
  geplant: string | null;
  /** Der Anker „Erlös mit VoltPilot … · Ungeregelt wären es …"; null ohne Baseline. */
  anker: string | null;

  /* --- Anzeige (E8 + Revision 2 „Label · Zahl · Chip", §3.5/§3.12) --- */
  anzeigeTon: SpeicherTon;
  /** Der Ton der Zeile 2; null ohne Aufteilung. */
  steuerungTon: SpeicherTon | null;
  /** 1–3 Wörter: „Speicher heute" / „Speicher im Zeitraum". */
  gesamtLabel: string;
  /** „Zwischenstand" / „unter Null"; null = kein Chip. */
  gesamtChip: string | null;
  steuerungLabel: string;
  /** Der Betrag der Zeile 2 — „—", wo es keine Aufteilung gibt (nie eine 0). */
  steuerungWert: string;
  /** „stur − 4,12 €" / „Speicher-Daten fehlen ›"; null = kein Chip. */
  steuerungChip: string | null;
  /** true = der Chip der Zeile 2 führt auf die Technik-Seite (Stammdaten nachtragen). */
  nachtragLink: boolean;

  /* --- Kurzform für Cockpit + Steuerungs-Bereich (§3.6) --- */
  /** „Speicher + 12,40 € · davon Steuerung + 3,10 €" — EINE Zeile. */
  kurz: string;
  /** Der volle Wortlaut als Tooltip der Kurzform. */
  kurzTitel: string;

  /**
   * Ob es überhaupt etwas zu SAGEN gibt. `false` heißt: die Gesamtzahl liegt im
   * Totband und es gibt keine Aufteilung — dann behauptet keine Fläche eine
   * Speicher-Aussage (die Regel, die der Chip seit je hatte: nie eine 0).
   */
  hatAussage: boolean;
}

/**
 * Was die Aussage aus der Antwort braucht. Bewusst STRUKTURELL (das
 * `BestandEingabe`-Muster), damit sowohl die Anlagen-Antwort (`SiteEarnings`)
 * als auch die Flotten-Zeile (`EarningsSite`) hineinpassen — die eine trägt
 * `range`/`to`, die andere nicht.
 */
export interface SpeicherEingabe extends BestandEingabe {
  savedEur?: number | null;
  savedSpeicherEur?: number | null;
  savedSteuerungEur?: number | null;
  steuerungSplitReason?: SteuerungSplitReason | null;
  baselineEur?: number | null;
  actualEur?: number | null;
  plantKind?: PlantKind | null;
}

export interface SpeicherKontext {
  now: Date;
  /**
   * Der Planwert des Fahrplans (`history.totals.batterySavingsPlannedEur`).
   * Er wohnt in einer ANDEREN Antwort und wird deshalb hereingereicht statt
   * geraten.
   */
  geplantEur?: number | null;
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

/**
 * Die EINE Ableitung der Speicher-Aussage. `null` heißt: es gibt nichts zu
 * sagen (kein berechenbarer `savedEur`) — nie eine erfundene 0.
 */
export function speicherAussage(
  money: SpeicherEingabe | null | undefined,
  ctx: SpeicherKontext,
): SpeicherAussage | null {
  if (!money) return null;
  const saved = num(money.savedEur ?? null);
  if (saved == null) return null;

  const bis = money.to ? new Date(money.to).getTime() : NaN;
  const laeuft =
    ctx.laeuft ?? (Number.isFinite(bis) && bis > ctx.now.getTime());
  const tag = money.range === 'day';

  const speicherEur = num(money.savedSpeicherEur ?? null);
  const steuerungEur = num(money.savedSteuerungEur ?? null);
  // ⚠ Der Identitäts-Wächter (§3.6): gehen die drei Zahlen nicht auf, zeigt die
  // Ableitung NUR Zeile 1 und protokolliert — nie zwei Zahlen, die sich
  // widersprechen. Er kann nur bei einem inkonsistenten Backend anschlagen.
  let split = speicherEur != null && steuerungEur != null;
  if (split && Math.abs((speicherEur as number) + (steuerungEur as number) - saved) > IDENTITAET_TOLERANZ) {
    // eslint-disable-next-line no-console
    console.warn(
      `speicherAussage: savedSpeicherEur + savedSteuerungEur (${speicherEur} + ${steuerungEur}) ` +
        `ergibt nicht savedEur (${saved}) — Zeile 2 wird ausgelassen.`,
    );
    split = false;
  }
  const widerspruch = speicherEur != null && steuerungEur != null && !split;

  const gesamt = tonWort(saved);
  const stur = split ? tonWort(speicherEur) : null;
  const steuerung = split ? tonWort(steuerungEur) : null;

  const wann = laeuft
    ? tag
      ? 'heute bisher'
      : 'in diesem Zeitraum bisher'
    : tag
      ? 'an diesem Tag'
      : 'in diesem Zeitraum';

  const satz =
    saved < -SPEICHER_TOTBAND
      ? laeuft
        ? `Zwischenstand: ${gesamt.wort} — die Kasse zählt noch nicht, was gerade im Speicher liegt.`
        : `Ihr Speicher hat ${wann} ${gesamt.wort} gebracht — weniger als eine Anlage ohne Speicher.`
      : `Ihr Speicher hat ${wann} ${gesamt.wort} gebracht`;

  // Der GRUND wird nur genannt, wenn der Server ihn nennt. Ein fehlendes Feld
  // (älteres Backend) ist kein fehlendes Stammdatum — dann gibt es Zeile 2
  // schlicht nicht, ohne Nachtrag-Aufforderung.
  const grund: SteuerungSplitReason | null =
    split || widerspruch ? null : (money.steuerungSplitReason ?? null);

  const steuerungSatz = split
    ? (steuerung as SpeicherGeld).eur >= SPEICHER_TOTBAND
      ? `davon ${(steuerung as SpeicherGeld).wort} durch VoltPilots Steuerung — gegenüber einem stur arbeitenden Speicher (${(stur as SpeicherGeld).wort})`
      : (steuerung as SpeicherGeld).eur <= -SPEICHER_TOTBAND
        ? `Zwischenstand Steuerung: ${(steuerung as SpeicherGeld).wort} gegenüber einem stur arbeitenden Speicher (${(stur as SpeicherGeld).wort}) — er hält Energie für später`
        : `Steuerung und sturer Speicher liegen ${wann} gleichauf (${(stur as SpeicherGeld).wort})`
    : grund === 'no_battery_data'
      ? 'Wie viel davon VoltPilots Steuerung war, lässt sich ohne Speicher-Stammdaten nicht sagen — Kapazität sowie Lade- und Entladeleistung nachtragen ›'
      : null;

  const bestand = bestandZeile(money, ctx.now);
  const geplantEur = num(ctx.geplantEur ?? null);
  const baseline = num(money.baselineEur ?? null);
  const actual = num(money.actualEur ?? null);

  const gesamtLabel = laeuft
    ? tag
      ? 'Speicher heute'
      : 'Speicher bisher'
    : tag
      ? 'Speicher an diesem Tag'
      : 'Speicher im Zeitraum';
  const anzeigeTon = anzeigeTonVon(saved, laeuft);

  const kurz =
    `${laeuft ? 'Zwischenstand Speicher' : 'Speicher'} ${gesamt.wort}` +
    (split ? ` · davon Steuerung ${(steuerung as SpeicherGeld).wort}` : '');

  return {
    gesamt,
    stur,
    steuerung,
    splitReason: grund,
    zwischenstand: laeuft,
    satz,
    steuerungSatz,
    bestand: bestand?.text ?? null,
    bestandBadge: bestand?.badge ?? null,
    bestandTitel: bestand?.titel ?? null,
    geplant:
      geplantEur == null
        ? null
        : `Vorab geplant hatte der Fahrplan ${tonWort(geplantEur).wort}`,
    anker:
      baseline != null && actual != null && money.plantKind
        ? proofAnchor(money.plantKind, baseline, actual)
        : null,

    anzeigeTon,
    steuerungTon: split ? anzeigeTonVon((steuerung as SpeicherGeld).eur, laeuft) : null,
    gesamtLabel,
    gesamtChip: laeuft ? 'Zwischenstand' : anzeigeTon === 'warn' ? 'unter Null' : null,
    steuerungLabel: 'davon Steuerung',
    steuerungWert: split ? (steuerung as SpeicherGeld).wort : '—',
    steuerungChip: split
      ? `stur ${(stur as SpeicherGeld).wort}`
      : grund === 'no_battery_data'
        ? 'Speicher-Daten fehlen ›'
        : null,
    nachtragLink: grund === 'no_battery_data',

    kurz,
    kurzTitel: steuerungSatz ? `${satz} · ${steuerungSatz}` : satz,
    hatAussage: gesamt.ton !== 'null' || split,
  };
}

/** Das Etikett, das den Planwert von der gemessenen Kasse trennt. */
export { BESTAND_BADGE };
