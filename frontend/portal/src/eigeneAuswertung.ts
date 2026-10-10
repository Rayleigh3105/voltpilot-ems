/**
 * Die Anwendung „Eigene Auswertung" — reine Hälfte (Anwendungs-Programm
 * Stufe 5; Scout `data/vp-portal-zielbild-anwendungen` §3.6 / §5, Stufe B).
 *
 * Der Kunde baut sich aus einem Messwert seiner Anlage eine eigene Kachel oder
 * einen eigenen Verlauf. Diese Datei ist die EINE Stelle, an der daraus Regeln,
 * Vorschläge und Sätze werden — ohne DOM, ohne Uhr, ohne Netz (das
 * `Tagesprotokoll`/`FleetPflege`/`cockpitLayout`-Muster).
 *
 * ## ⚠ Die EHRLICHKEITSREGEL ist ein ZWILLING, keine zweite Wahrheit
 *
 * Welches Aggregat zu welchem Kanal passt, entscheidet der SERVER
 * (`services/api .../cockpit/EigeneAuswertung`) — eine unehrliche Kombination
 * ist dort ein 400 mit deutschem Grund. Diese Hälfte spart dem Kunden den
 * Klick: sie bietet gar nicht erst an, was der Server ablehnen würde, und sagt
 * warum. Beide Seiten fahren dieselben Vektoren
 * (`docs/contracts/v2/eigene-auswertung-vectors.json`); **wer die Regel ändert,
 * ändert beide Seiten und die Vektor-Datei.**
 *
 * ```
 *   Kanalart   | erkannt an              | jetzt | tagessumme | tagesmax | tagesmittel
 *   -----------+-------------------------+-------+------------+----------+------------
 *   energie    | *_kwh, *_wh, *energy*   |   ja  |     ja     |   nein   |    nein
 *   leistung   | *_kw, *_w, *power*      |   ja  |    nein    |    ja    |     ja
 *   anteil     | *_pct                   |   ja  |    nein    |    ja    |     ja
 *   messwert   | alles Übrige            |   ja  |    nein    |    ja    |     ja
 * ```
 *
 * Beide Verbote hängen an DERSELBEN Tatsache: **ein kWh-Kanal meldet in diesem
 * Haus einen ZÄHLERSTAND** (die Hausregel steht serverseitig in
 * `ConsumerRequirementStateRepository.energyOverPeriod` — die Energie einer
 * Periode ist `max − min`, der ZUWACHS). Eine Tagessumme über Leistung oder
 * Temperatur addiert Momentanwerte; Höchstwert und Mittel eines Zählerstands
 * sind keine Aussage.
 *
 * ## Was hier NICHT lebt
 *
 * Die WERTE. Sie kommen aus `GET /api/v1/sites/{id}/eigene-auswertung` — aus
 * demselben Messwert-Pfad, aus dem der Verlaufs-Explorer seine Kurven zieht.
 * Eine zweite Rechnung im Portal wäre eine zweite Wahrheit über dieselbe Zahl.
 */
import CATALOG from './anwendungen/catalog.json';
import { channelUnitHint } from './channels';
import { fmtNum } from './format';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/** Die vier Kennzahlen, in Anzeige-Reihenfolge. */
export type Aggregat = 'jetzt' | 'tagessumme' | 'tagesmax' | 'tagesmittel';

/** Kachel mit EINER Zahl, oder der Tagesverlauf mit der Zahl als Kopfzeile. */
export type Darstellung = 'kachel' | 'chart';

/** Was ein Kanal misst — abgeleitet aus seinem NAMEN, nie aus der Einheit. */
export type Kanalart = 'energie' | 'leistung' | 'anteil' | 'messwert';

/** Das Präfix, an dem ein eigener Baustein erkennbar ist. */
export const EIGEN_PREFIX = 'eigen:';

/** Wie viele eigene Auswertungen eine Anlage höchstens trägt (Server-Deckel). */
export const MAX_EIGENE = 12;

/** Die Länge einer Überschrift (Server-Deckel). */
export const MAX_TITEL = 60;

export const AGGREGATE: Aggregat[] = ['jetzt', 'tagessumme', 'tagesmax', 'tagesmittel'];

/** Eine eigene Auswertung, wie sie im Layout-Dokument steht. */
export interface EigeneAuswertungDef {
  id: string;
  titel: string;
  darstellung: Darstellung;
  entityId: string;
  channel: string;
  aggregat: Aggregat;
}

/** Eine ART eigener Auswertung, wie der Katalog sie beschreibt. */
export interface VorlageDef {
  id: string;
  label: string;
  satz: string | null;
  darstellung: Darstellung;
  flaeche: string;
  anwendung: string;
  nach: string | null;
}

const RAW_VORLAGEN = (CATALOG as { baustein_vorlagen?: VorlageDef[] }).baustein_vorlagen ?? [];

/** Die Arten eigener Auswertung dieser Fläche, in Katalog-Reihenfolge. */
export function vorlagen(flaeche = 'cockpit'): VorlageDef[] {
  return RAW_VORLAGEN.filter((v) => v.flaeche === flaeche);
}

/** Die Vorlage einer Darstellung, oder null. */
export function vorlageFuer(darstellung: string): VorlageDef | null {
  return RAW_VORLAGEN.find((v) => v.darstellung === darstellung) ?? null;
}

/** Trägt dieser Baustein-Schlüssel das Präfix einer eigenen Auswertung? */
export function istEigen(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(EIGEN_PREFIX);
}

// ---------------------------------------------------------------------------
// Die Ehrlichkeitsregel (der Zwilling)
// ---------------------------------------------------------------------------

/**
 * Was dieser Kanal misst. ⚠ Aus dem NAMEN, nicht aus der gemeldeten Einheit:
 * das Kanal-Vokabular ist offen (ein Selbstbau-Gerät benennt seine Kanäle
 * selbst), und die Einheit ist optional. Ein unbekannter Kanal ist `messwert` —
 * die Art, die am wenigsten behauptet.
 */
export function kanalart(channel: string | null | undefined): Kanalart {
  if (!channel) return 'messwert';
  const c = channel.toLowerCase();
  // ⚠ DIE REIHENFOLGE IST EINE REGEL, kein Stil:
  //  1. `_pct` ZUERST — ein Prozentsuffix ist die eindeutigste Aussage, die ein
  //     Kanalname machen kann. Stünde es hinter der Energie, bekäme ein
  //     `energy_pct` die Tagessumme eines Zählerstands, also eine Summe über
  //     Prozentwerte.
  //  2. Energie VOR Leistung — `energy_kwh` endet auf `_kwh` UND enthält
  //     `energy`, und `_kwh` endet nicht auf `_kw`.
  if (c.endsWith('_pct') || c.endsWith('_prozent')) return 'anteil';
  if (
    c.endsWith('_kwh') ||
    c.endsWith('kwh') ||
    c.endsWith('_wh') ||
    c.includes('energy') ||
    c.includes('energie')
  ) {
    return 'energie';
  }
  if (c.endsWith('_kw') || c.endsWith('_w') || c.includes('power') || c.includes('leistung')) {
    return 'leistung';
  }
  return 'messwert';
}

/** Darf dieses Aggregat auf diesem Kanal stehen? */
export function erlaubt(channel: string, aggregat: string): boolean {
  if (!AGGREGATE.includes(aggregat as Aggregat)) return false;
  // Der jüngste gemeldete Wert ist genau das, was das Gerät gemeldet hat —
  // darüber gibt es auf keinem Kanal etwas zu streiten.
  if (aggregat === 'jetzt') return true;
  return (aggregat === 'tagessumme') === (kanalart(channel) === 'energie');
}

/** Die Aggregate, die auf diesem Kanal ehrlich sind. Nie leer (`jetzt` gilt immer). */
export function erlaubteAggregate(channel: string): Aggregat[] {
  return AGGREGATE.filter((a) => erlaubt(channel, a));
}

/**
 * Der deutsche Grund für eine unehrliche Kombination — er benennt die KANALART
 * und die AUSWEGE, nie nur „ungültig". Null, wenn sie erlaubt ist.
 */
export function grund(channel: string, aggregat: string, label?: string | null): string | null {
  if (erlaubt(channel, aggregat)) return null;
  const name = label && label.trim() ? label : channel;
  if (aggregat === 'tagessumme') {
    // Artikel und Pronomen gehören zusammen, sonst entsteht ein falscher Satz.
    const art =
      kanalart(channel) === 'leistung'
        ? 'eine Leistung — sie'
        : kanalart(channel) === 'anteil'
          ? 'ein Prozentwert — er'
          : 'ein Messwert — er';
    return `„${name}“ ist ${art} lässt sich nicht zu einer Tagessumme addieren. Wählen Sie „Aktuell“, „Tageshöchstwert“ oder „Tagesmittel“.`;
  }
  if (aggregat === 'tagesmax') {
    return `„${name}“ ist ein Zählerstand — sein Höchstwert ist immer der letzte Stand des Tages. Wählen Sie „Aktuell“ oder „Tagessumme“.`;
  }
  if (aggregat === 'tagesmittel') {
    return `„${name}“ ist ein Zählerstand — ein Mittelwert daraus ist keine Aussage. Wählen Sie „Aktuell“ oder „Tagessumme“.`;
  }
  return `Dieser Zeitbezug passt nicht zu „${name}“.`;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** Der Name einer Kennzahl auf der Fläche. */
export function aggregatLabel(aggregat: string): string {
  switch (aggregat) {
    case 'jetzt':
      return 'Aktuell';
    case 'tagessumme':
      return 'Tagessumme';
    case 'tagesmax':
      return 'Tageshöchstwert';
    case 'tagesmittel':
      return 'Tagesmittel';
    default:
      return aggregat;
  }
}

/**
 * Der ZEITBEZUG unter der Zahl. Er ist keine Zierde: „3,2 kW" allein sagt
 * nicht, ob das jetzt gilt oder der Tageshöchstwert ist.
 */
export function zeitbezug(aggregat: string): string {
  switch (aggregat) {
    case 'jetzt':
      return 'jetzt';
    case 'tagessumme':
      return 'heute';
    case 'tagesmax':
      return 'Höchstwert heute';
    case 'tagesmittel':
      return 'Mittel heute';
    default:
      return '';
  }
}

/** Ein Satz, der die Kennzahl erklärt — im Dialog unter der Auswahl. */
export function aggregatSatz(channel: string, aggregat: string): string {
  const art = kanalart(channel);
  switch (aggregat) {
    case 'jetzt':
      return 'Der zuletzt gemeldete Wert.';
    case 'tagessumme':
      return 'Was heute dazugekommen ist — der Zuwachs des Zählers seit Mitternacht.';
    case 'tagesmax':
      return art === 'anteil'
        ? 'Der höchste Stand seit Mitternacht.'
        : 'Der höchste Wert seit Mitternacht.';
    case 'tagesmittel':
      return 'Der Durchschnitt seit Mitternacht, nach der Zahl der Messungen gewichtet.';
    default:
      return '';
  }
}

/**
 * Die Einheit einer Zahl. Sie kommt aus der DEKLARIERTEN Einheit der Komponente,
 * wo es eine gibt, sonst aus dem Kanalnamen — nie erfunden: ein selbst
 * benannter Kanal ohne Einheit bekommt keine.
 */
export function einheit(channel: string, deklariert?: string | null): string {
  if (deklariert && deklariert.trim()) return deklariert.trim();
  return channelUnitHint(channel) ?? '';
}

/**
 * Die Zahl einer Kachel. `null` bleibt ein Strich — eine Kachel ohne Messung
 * behauptet keine Null.
 */
export function wertText(
  wert: number | null | undefined,
  channel: string,
  deklariert?: string | null,
): string {
  if (wert == null || !Number.isFinite(wert)) return '\u2014';
  // Grosse Zahlen ohne Nachkomma, kleine mit zweien: ein Zaehlerstand von
  // 140,5 kWh liest sich anders als 0,12 kW, und beide sollen ohne Zoom
  // lesbar bleiben.
  const stellen = Math.abs(wert) >= 100 ? 0 : Math.abs(wert) >= 10 ? 1 : 2;
  return fmtNum(wert, einheit(channel, deklariert), stellen);
}

/**
 * Der Titel-VORSCHLAG. Er wird vorgeschlagen, nie erzwungen — der Kunde
 * benennt seine Kachel selbst, und ein Vorschlag spart ihm nur das Tippen.
 */
export function titelVorschlag(
  komponente: string,
  messwert: string,
  aggregat: string,
): string {
  const zusatz = aggregat === 'jetzt' ? '' : ` (${zeitbezug(aggregat)})`;
  const roh = `${komponente} · ${messwert}${zusatz}`;
  return roh.length <= MAX_TITEL ? roh : roh.slice(0, MAX_TITEL).trimEnd();
}

/** Der Satz über der Liste im Anpassen-Modus, wenn es noch keine gibt. */
export const LEER_SATZ =
  'Sie haben noch keine eigene Auswertung. Mit „+ Eigene Auswertung“ bauen Sie sich aus einem Messwert Ihrer Anlage eine Kachel oder einen Verlauf.';

/** Der Satz, wenn der Deckel erreicht ist — er nennt die Zahl. */
export function deckelSatz(anzahl: number): string | null {
  return anzahl >= MAX_EIGENE
    ? `Mehr als ${MAX_EIGENE} eigene Auswertungen kann ein Cockpit nicht tragen. Entfernen Sie eine, um eine neue anzulegen.`
    : null;
}

// ---------------------------------------------------------------------------
// Schlüssel + Entwurf
// ---------------------------------------------------------------------------

/**
 * Ein neuer, in diesem Dokument freier Schlüssel. Er ist bewusst KEINE UUID:
 * er steht in `order`/`hidden` und wird beim Fehlersuchen gelesen — die
 * Zeichenmenge ist die, die der Server prüft (`[a-z0-9][a-z0-9-]*`).
 */
export function neuerSchluessel(vorhanden: readonly string[], zaehler = 1): string {
  const belegt = new Set(vorhanden);
  let n = zaehler;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const id = `${EIGEN_PREFIX}k${n}`;
    if (!belegt.has(id)) return id;
    n += 1;
  }
}

/** Ein Entwurf im Dialog — dieselben Felder, aber jedes darf noch leer sein. */
export interface Entwurf {
  id: string | null;
  titel: string;
  darstellung: Darstellung;
  entityId: string;
  channel: string;
  aggregat: Aggregat;
}

/** Der frische Entwurf: eine Kachel mit dem aktuellen Wert. */
export function leererEntwurf(): Entwurf {
  return { id: null, titel: '', darstellung: 'kachel', entityId: '', channel: '', aggregat: 'jetzt' };
}

/**
 * Ist dieser Entwurf speicherbar — und wenn nicht, warum? Genau die Prüfungen,
 * die der Server auch fährt, damit die Fläche keinen Klick anbietet, der
 * scheitert.
 */
export function entwurfFehler(e: Entwurf): string | null {
  if (!e.entityId) return 'Wählen Sie die Komponente, deren Messwert Sie sehen möchten.';
  if (!e.channel) return 'Wählen Sie den Messwert, den Sie sehen möchten.';
  const g = grund(e.channel, e.aggregat);
  if (g) return g;
  if (!e.titel.trim()) return 'Geben Sie Ihrer Auswertung eine Überschrift.';
  if (e.titel.trim().length > MAX_TITEL) return `Die Überschrift ist länger als ${MAX_TITEL} Zeichen.`;
  return null;
}

/** Der Entwurf als Definition — mit dem Schlüssel, unter dem er gespeichert wird. */
export function ausEntwurf(e: Entwurf, id: string): EigeneAuswertungDef {
  return {
    id,
    titel: e.titel.trim(),
    darstellung: e.darstellung,
    entityId: e.entityId,
    channel: e.channel,
    aggregat: e.aggregat,
  };
}

/** Eine bestehende Definition zurück in einen Entwurf (der Bearbeiten-Weg). */
export function zuEntwurf(d: EigeneAuswertungDef): Entwurf {
  return { ...d, titel: d.titel ?? '' };
}

/**
 * Ein Aggregat, das auf dem NEUEN Kanal nicht mehr ehrlich wäre, fällt auf
 * `jetzt` zurück — es gilt auf jedem Kanal. Ohne diese Regel bliebe nach einem
 * Kanalwechsel eine unehrliche Kombination stehen, die der Server ablehnt.
 */
export function nachKanalwechsel(e: Entwurf, channel: string): Entwurf {
  return { ...e, channel, aggregat: erlaubt(channel, e.aggregat) ? e.aggregat : 'jetzt' };
}

// ---------------------------------------------------------------------------
// Die Werte-Antwort
// ---------------------------------------------------------------------------

/** Ein Eimer der Tages-Kurve (die Form von `EntityHistoryRepository.Bucket`). */
export interface EigenerEimer {
  start: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
  n: number;
}

/** Der Wert EINER eigenen Auswertung, wie der Server ihn liefert. */
export interface EigenerWert {
  id: string;
  titel: string;
  darstellung: Darstellung;
  entityId: string;
  channel: string;
  aggregat: Aggregat;
  wert: number | null;
  kanalart: Kanalart | null;
  komponente: string | null;
  entityType: string | null;
  hinweis: string | null;
  /**
   * Der Tagesverlauf. Ältere bzw. unvollständige Werte-Antworten können das
   * additive Feld noch auslassen; die Fläche behandelt das wie eine leere
   * Reihe und erfindet keine Messpunkte.
   */
  verlauf?: EigenerEimer[];
}

export interface EigeneAuswertungWerte {
  at: string;
  from: string;
  to: string;
  bucketMinutes: number;
  werte: EigenerWert[];
}

/** Die Werte unter ihrem Baustein-Schlüssel — der Weg von der Reihenfolge zum Wert. */
export function werteNachId(w: EigeneAuswertungWerte | null): Map<string, EigenerWert> {
  const out = new Map<string, EigenerWert>();
  for (const v of w?.werte ?? []) out.set(v.id, v);
  return out;
}
