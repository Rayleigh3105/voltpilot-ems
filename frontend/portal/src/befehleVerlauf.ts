// Der VERLAUF der Befehle (Geräteseiten Stufe 2, Konzept
// `data/vp-geraeteseite-rahmen-r2` §6; Captain-Entscheide **D2a** Befehle
// standardmäßig offen · **D4a** die anlagenweite Befehle-Seite bekommt DIESELBE
// filterlose Liste).
//
// **Der behobene Befund war ZUSCHNITT, nicht fehlende Auskunft** (§2.4): die
// Befehle-Seite war eine RECHERCHE-Fläche - drei Schnell-Chips, eine
// aufklappbare Filter-Leiste mit vier Struktur-Feldern, ein Freitext und ein
// Treffer-Zähler standen ÜBER einer Liste, die den Tag von MORGENS nach ABENDS
// erzählte. Wer nachsieht, was VoltPilot zuletzt geschickt hat, muss aber
// zuerst die JÜNGSTE Zeile lesen, nicht die älteste, und er sucht nichts - er
// schaut nach.
//
// Diese Datei ist die EINE Wahrheit darüber, **in welcher Reihenfolge die
// Zeilen stehen, wo eine Datumszeile fällt, wie die Seiten gemischt werden und
// was eine leere oder gekappte Liste sagt**. Sie ist rein und framework-frei
// (der `befehle.ts`/`geraetRahmen.ts`-Präzedenzfall); `components/BefehleVerlauf.tsx`
// rendert sie und entscheidet nichts.
//
// ⚠ **Sie formuliert KEINEN Satz neu.** Jede Zeile bleibt der bestehende
// Film-Satz aus `befehle.film()` (Ton, Urteil, Roh-Blick), der Leer-Satz kommt
// aus `befehle.leerSatz()`, der Deckel-Hinweis aus `befehle.deckelSatz()`. Zwei
// Formulierungen über denselben Vorgang wären zwei Wahrheiten.
import type { CommandHistory } from './api';
import { deckelSatz, film, leerSatz, type BefehlZeile } from './befehle';
import { HANDEINGRIFF_LABEL, type HandeingriffAktion } from './handeingriff';
import { SOFORT_LABEL, type SofortAktion } from './consumers/fulfillment';

/** Die Plattform-Zeitzone - dieselbe, in der der Server sein Fenster aufspannt. */
const ZONE = 'Europe/Berlin';

/**
 * Die Aufbewahrung des Verlaufs in TAGEN (`CommandLog.RETENTION`, 90 d). Sie
 * ist zugleich das Fenster, das die Fläche anfragt: weiter zurück gibt es
 * nichts, und der Server lehnt ein größeres Fenster ausdrücklich ab
 * (`CommandFilter.MAX_DAYS_BACK`).
 */
export const VERLAUF_TAGE = 90;

/** Wie viele Zeilen eine Seite trägt (§6.1). */
export const SEITE = 20;

// ---------------------------------------------------------------------------
// Das Fenster
// ---------------------------------------------------------------------------

/**
 * Das Abfrage-Fenster des Verlaufs: die letzten {@link VERLAUF_TAGE} Berliner
 * Kalendertage, `to` EINSCHLIESSLICH.
 *
 * ⚠ Gerechnet wird auf dem BERLINER Kalendertag, nicht auf dem des Browsers -
 * der Server spannt sein Fenster in genau dieser Zone auf, und ein Leser
 * ausserhalb der DACH-Zone bekäme sonst ein um einen Tag verschobenes Fenster
 * (dieselbe Regel wie `befehle.berlinTag`).
 */
export function verlaufFenster(now: number): { from: string; to: string } {
  const to = new Date(now).toLocaleDateString('sv-SE', { timeZone: ZONE });
  return { from: minusTage(to, VERLAUF_TAGE - 1), to };
}

/** Der Tag N Kalendertage vor einem `YYYY-MM-DD` - reine Arithmetik, keine Zone. */
function minusTage(tagIso: string, tage: number): string {
  const d = new Date(`${tagIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - tage);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Die Liste
// ---------------------------------------------------------------------------

/** Ein Eintrag der Liste: eine Datumszeile ODER eine Befehlszeile. */
export type VerlaufEintrag =
  | { art: 'tag'; key: string; text: string }
  | { art: 'zeile'; key: string; zeile: BefehlZeile };

export interface VerlaufView {
  /** Datumszeilen und Befehlszeilen in Anzeige-Reihenfolge (neueste zuerst). */
  eintraege: VerlaufEintrag[];
  /** Wie viele BEFEHLS-Zeilen darin stehen (ohne die Datumszeilen). */
  zeilen: number;
  /** „212 Befehle in den letzten 90 Tagen" - null ohne belegte Zahl. */
  bilanz: string | null;
  /** Der Satz einer LEEREN Liste; null, sobald eine Zeile da ist. */
  leer: string | null;
  /** Der Hinweis, wenn der Tages-Deckel gegriffen hat; sonst null. */
  deckel: string | null;
  /** Ob „Ältere laden" etwas bewirken kann - nie ein Knopf ins Leere. */
  mehrMoeglich: boolean;
  /** Der Cursor der nächsten Seite (`before`), oder null. */
  cursor: string | null;
}

/**
 * Der Verlauf: **neueste Zeile oben**, mit einer Datumszeile bei jedem
 * Tageswechsel.
 *
 * @param seiten die geladenen Seiten, NEUESTE zuerst (`[history, ...mehr]`)
 * @param now die Bezugszeit - sie entscheidet nur, welche Periode „laufend"
 *            ist und wie „Heute"/„Gestern" heißen
 * @param opts.gefiltert ob eine Komponente ODER ein Gerät gewählt ist (der
 *                       Leer-Satz unterscheidet die Fälle)
 *
 * Vier Regeln tragen die Funktion:
 * 1. **Umgekehrte Film-Ordnung.** `film()` liefert ÄLTESTE zuerst (so kommen
 *    die Server-Zeilen an); der Verlauf dreht sie um - er beantwortet „was
 *    zuletzt", nicht „wie der Tag verlief".
 * 2. **Gruppiert wird nach dem BEGINN.** Das Ende einer über Mitternacht
 *    laufenden Periode liegt per Konstruktion im Fenster; ein zweites Datum
 *    wäre Rauschen (dieselbe Begründung wie in `befehle.spanne`).
 * 3. **Doppelt gelieferte Grenzzeilen gewinnen genau einmal.** Der Server
 *    vergleicht `before` mit `<=`, die Grenzzeile kommt also ZWEIMAL - lieber
 *    doppelt als lautlos verloren, gemischt wird über die `id`.
 * 4. **Der Deckel wird GESAGT, nie still gekappt** - ein Verlauf, der schweigt,
 *    wäre eine Lücke ohne Grund.
 */
export function neuesteZuerst(
  seiten: readonly (CommandHistory | null | undefined)[],
  now: number,
  opts: { gefiltert?: boolean } = {},
): VerlaufView {
  const echte = seiten.filter((h): h is CommandHistory => Boolean(h));
  const neueste = echte[0] ?? null;
  const aelteste = echte[echte.length - 1] ?? null;

  const gesehen = new Set<number>();
  const alle: BefehlZeile[] = [];
  for (const h of echte) {
    // ⚠ `datiert: false`: das Datum trägt hier die GRUPPEN-Zeile. Beides
    // zugleich wäre dieselbe Auskunft zweimal („18.08. 22:00" unter der
    // Überschrift „Montag, 18. August 2026").
    const zeilen = film(h, now, { datiert: false });
    for (let i = zeilen.length - 1; i >= 0; i -= 1) {
      const z = zeilen[i];
      if (gesehen.has(z.id)) continue;
      gesehen.add(z.id);
      alle.push(z);
    }
  }

  const eintraege: VerlaufEintrag[] = [];
  let letzterTag: string | null | undefined;
  for (const z of alle) {
    if (letzterTag === undefined || z.tag !== letzterTag) {
      letzterTag = z.tag;
      eintraege.push({ art: 'tag', key: `tag:${z.tag ?? 'unbekannt'}`, text: tagText(z.tag, now) });
    }
    eintraege.push({ art: 'zeile', key: `z:${z.id}`, zeile: z });
  }

  const cursor = aelteste?.nextBefore ?? null;
  return {
    eintraege,
    zeilen: alle.length,
    bilanz: bilanzSatz(neueste?.total),
    leer: alle.length === 0 ? leerSatz(neueste, opts.gefiltert === true) : null,
    deckel: deckelSatz(neueste),
    mehrMoeglich: Boolean(cursor),
    cursor,
  };
}

/**
 * Die JÜNGSTE Zeile des Verlaufs, oder null.
 *
 * Sie trägt die Kurzfassung einer GESCHLOSSENEN Befehls-Sektion („zuletzt
 * 14:02 · bestätigt") - dieselbe Zeile, die aufgeklappt oben steht, damit die
 * zwei Zustände derselben Sektion nichts Verschiedenes behaupten.
 */
export function neuesteZeile(view: VerlaufView): BefehlZeile | null {
  for (const e of view.eintraege) {
    if (e.art === 'zeile') return e.zeile;
  }
  return null;
}

/**
 * Die Überschrift einer Tagesgruppe: „Heute" · „Gestern" · „Montag, 18. August
 * 2026".
 *
 * ⚠ Ein Zeitpunkt ohne lesbaren Tag bekommt seine EIGENE Gruppe mit dem
 * ehrlichen Wort - ihn stillschweigend der Gruppe darüber zuzuschlagen wäre
 * eine erfundene Datierung.
 */
export function tagText(tag: string | null, now: number): string {
  if (!tag) return 'Zeitpunkt unbekannt';
  const heute = new Date(now).toLocaleDateString('sv-SE', { timeZone: ZONE });
  if (tag === heute) return 'Heute';
  if (tag === minusTage(heute, 1)) return 'Gestern';
  return new Date(`${tag}T12:00:00Z`).toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * „212 Befehle in den letzten 90 Tagen" aus dem SERVER-Zähler.
 *
 * ⚠ Die Zahl kommt vom Server (`total`), sie wird NIE aus den geladenen Seiten
 * gezählt - sonst behauptete die Fläche „20 Befehle", während 3.400 dahinter
 * liegen. Ein älteres Backend meldet sie nicht; dann steht dort NICHTS statt
 * einer erfundenen Bilanz, und eine 0 sagt schon der Leer-Satz.
 */
export function bilanzSatz(total: number | null | undefined): string | null {
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  const wort = total === 1 ? 'Befehl' : 'Befehle';
  return `${total.toLocaleString('de-DE')} ${wort} in den letzten ${VERLAUF_TAGE} Tagen`;
}

// ---------------------------------------------------------------------------
// Die AKTIONSZEILE „Befehl an dieses Gerät ▾" (§6.2)
// ---------------------------------------------------------------------------

/** Die Beschriftung der Aktionszeile - sie steht ÜBER der Liste. */
export const AKTIONSZEILE_LABEL = 'Befehl an dieses Gerät';

/** Die Beschriftung des Register-Wegs - wörtlich die der Register-Sektion. */
export const REGISTER_LABEL = 'Register schreiben';

/**
 * Die Gattung eines Blatts (`geraetGesicht.Gattung`) plus `box` für die
 * Tor-Seite. Sie steht hier als eigenes Vokabular, damit diese reine Datei
 * nicht an der Gesichts-Ableitung hängt.
 */
export type BlattGattung =
  | 'wechselrichter-speicher'
  | 'wechselrichter'
  | 'pv-melder'
  | 'zaehler'
  | 'verbraucher'
  | 'ladepunkt'
  | 'geraet'
  | 'box';

/** Welchen BESTEHENDEN Dialog eine Aktion öffnet. */
export type AktionArt = 'speicher' | 'verbraucher' | 'register';

export interface VerlaufAktion {
  /** Stabiler Schlüssel - zugleich der Testanker. */
  key: string;
  label: string;
  art: AktionArt;
  /**
   * Das Wort, mit dem der Wirt seinen bestehenden Dialog öffnet: eine
   * `HandeingriffAktion`, eine `SofortAktion` oder `'register'`.
   */
  wert: string;
}

/**
 * Die Aktionszeile eines Blatts (§6.2).
 *
 * ⚠ **Es entsteht KEIN zweiter Auslöse-Pfad.** Jede Aktion nennt nur, welcher
 * BESTEHENDE Dialog aufgeht (Handeingriff-Folgenkarte, `ConsumerOverrideDialog`,
 * `RegisterWriteDrawer`); die Sicherheits-Zusage, die Dauer-Pflicht und jede
 * Rückfrage bleiben dort, wo sie schon geprüft sind.
 *
 * ⚠ **Was der Zustand nicht hergibt, wird nicht angeboten** (die
 * `registerZugang`-Regel): die Speicher-Handlungen kommen fertig aus
 * `handeingriff.speicherAktionen`, die Geräte-Handlungen aus
 * `consumers/fulfillment.sofortAktionen`, und der Register-Weg nur mit einem
 * BELEGTEN Schreibweg (`registerWrite.geraetRegisterZugang.moeglich`).
 *
 * Die Regel je Gattung:
 * - **Zähler** und **Ladesäule**: keine Zeile. An einen Zähler geht kein Befehl
 *   (er hat auch gar keine Befehls-Sektion), und die OCPP-Säule trägt ihren
 *   eigenen Aktions-Katalog samt Rollen-Gattern.
 * - **Box**: der Register-Weg (die primäre Lane, deren Vorgänge sie auch im
 *   Verlauf trägt).
 * - **Hybrid-Wechselrichter**: die Speicher-Handlungen + Register.
 * - **PV-Wechselrichter/-Melder**: Register.
 * - **Verbraucher** und die Rückfall-Gattung: die Sofortaktionen + Register
 *   (ein Eigenbau-Gerät hat beides).
 */
export function aktionsZeile(i: {
  gattung: BlattGattung;
  speicher?: readonly HandeingriffAktion[];
  verbraucher?: readonly SofortAktion[];
  registerMoeglich?: boolean;
}): VerlaufAktion[] {
  const out: VerlaufAktion[] = [];
  const register = () => {
    if (i.registerMoeglich) {
      out.push({ key: 'register', label: REGISTER_LABEL, art: 'register', wert: 'register' });
    }
  };
  switch (i.gattung) {
    case 'zaehler':
    case 'ladepunkt':
      return [];
    case 'box':
      register();
      return out;
    case 'wechselrichter-speicher':
      for (const a of i.speicher ?? []) {
        out.push({ key: `speicher:${a}`, label: HANDEINGRIFF_LABEL[a], art: 'speicher', wert: a });
      }
      register();
      return out;
    case 'wechselrichter':
    case 'pv-melder':
      register();
      return out;
    default:
      for (const a of i.verbraucher ?? []) {
        out.push({ key: `verbraucher:${a}`, label: SOFORT_LABEL[a], art: 'verbraucher', wert: a });
      }
      register();
      return out;
  }
}
