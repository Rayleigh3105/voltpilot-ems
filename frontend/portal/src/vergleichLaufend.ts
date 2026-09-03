/**
 * **Der Vergleich eines LAUFENDEN Zeitraums** — Erlöse-Konzept
 * `data/vp-erloese-seite-konzept-e2` §3.7, Captain-Entscheid **E3 = (a)**,
 * Befund **B3**.
 *
 * Der behobene Befund: die Erlöse-Karte rechnete das Ergebnis eines HALBEN
 * Tages gegen den VOLLEN Vortag und färbte das Ergebnis rot — um 12:19 stand
 * über einem völlig normalen Tag „53 % weniger als am Vortag" (Beleg: der
 * Screenshot des Captains, Scratch-Test L4). Die Zahl war arithmetisch
 * richtig und als Aussage falsch: verglichen wurden fünf Stunden mit
 * vierundzwanzig.
 *
 * **Die drei Regeln, die hier Gesetz sind:**
 *
 * 1. **Gleiche Stunde gegen gleiche Stunde.** Ein laufender TAG wird bis zur
 *    aktuellen Berliner Stunde summiert — und der Vortag ebenso. Die LAUFENDE
 *    Stunde bleibt bei beiden draußen: sie ist in beiden Tagen unvollständig,
 *    aber verschieden weit.
 * 2. **Kein Prozent, wo die Grundlage verschieden lang ist.** Eine laufende
 *    Woche / ein laufender Monat / ein laufendes Jahr bekommt NUR die zwei
 *    Beträge („bisher 39,30 € · ganze Vorwoche 41,10 €"). „Bis zum gleichen
 *    Kalendertag" wäre rechenbar, aber die Vorperiode kann kürzer sein
 *    (Februar) — ein Prozent daraus wäre wieder eine Behauptung.
 * 3. **Am laufenden Tag wird nicht GEWERTET.** Die Richtung ist eine Tatsache,
 *    die Wertung wäre eine Behauptung: ein trüber Vormittag sagt nichts über
 *    den Tag, und ein rotes Urteil über eine halbe Messung ist genau der
 *    Fehler, den B3 beschreibt — nur kleiner. Abgeschlossene Zeiträume behalten
 *    ihre Wertung unverändert (`delta()`).
 *
 * **⚠ Die Stunde kommt IMMER aus Europe/Berlin, nie aus `Date#getHours()`.**
 * Der Server spannt seine Fenster in dieser Zone auf; würde hier die Zone des
 * Browsers rechnen, verschöbe sich der Schnitt für jeden Leser außerhalb der
 * DACH-Zone um Stunden (dieselbe Regel wie in `anlage.ts`/`befehle.ts`/
 * `strompreis.ts`). Und verglichen wird die Stunde je EIMER aus seinem
 * `start`-Zeitstempel, **nie über den Index**: an einem Zeitumstellungstag hat
 * der Tag 23 bzw. 25 Eimer, und der n-te Eimer ist dann nicht die n-te Stunde.
 *
 * Kein React, kein Netz (das `fleet.ts`/`schedule.ts`-Muster).
 */
import type { HistoryRange } from './api';
import { isCurrentPeriod } from './energieBilanz';
import { eurAmount } from './format';
import {
  delta,
  laufendHinweis,
  vergleichsName,
  type DeltaView,
  type VergleichsModus,
} from './historieVergleich';

/**
 * Die Zone, in der der Server seine Zeiträume aufspannt. Lokal gehalten wie in
 * `anlage.ts`/`befehle.ts` — es gibt im Portal (noch) keinen geteilten
 * Zonen-Kopf, aber genau EINEN Wert.
 */
const ZONE = 'Europe/Berlin';

/**
 * Die Berliner Stunde eines Zeitpunkts (0…23) — die einzige Stelle, an der
 * dieses Modul eine Uhrzeit liest.
 *
 * `sv-SE` liefert die nackte zweistellige Stunde („00", „12"); `de-DE` hängt
 * ein „ Uhr" an und `Number()` gäbe NaN (beim Bau gemessen). An einem
 * Zeitumstellungstag ist das Ergebnis die WANDUHR-Stunde: im März fehlt die 2,
 * im Oktober gibt es sie zweimal — beides ist genau das, was „bis 12 Uhr"
 * bedeutet, und beides fällt hier ohne Sonderfall richtig heraus.
 */
export function berlinStunde(at: Date | string | null | undefined): number | null {
  if (at == null) return null;
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return null;
  const h = Number(d.toLocaleTimeString('sv-SE', { timeZone: ZONE, hour: '2-digit', hour12: false }));
  return Number.isFinite(h) ? h : null;
}

/** Ein Eimer der Geld-Reihe — strukturell `SiteEarningsBucket`, ohne den Rest. */
export interface VergleichsEimer {
  start: string;
  nettoEur: number | null;
}

/**
 * Die Summe der Eimer, die VOR `stunde` beginnen (Berliner Wanduhr).
 *
 * `null` heißt „keine Grundlage": kein einziger abgeschlossener Eimer, oder
 * keiner davon trug einen Wert. Eine 0 wäre hier die teuerste Art zu lügen —
 * sie läse sich als gemessene Null.
 */
export function summeBisStunde(
  series: readonly VergleichsEimer[] | null | undefined,
  stunde: number,
): number | null {
  if (!series || !Number.isFinite(stunde)) return null;
  let summe = 0;
  let getroffen = false;
  for (const b of series) {
    const h = berlinStunde(b.start);
    if (h == null || h >= stunde) continue;
    if (b.nettoEur == null || !Number.isFinite(b.nettoEur)) continue;
    summe += b.nettoEur;
    getroffen = true;
  }
  return getroffen ? summe : null;
}

/** Das Ergebnis des Stunden-Vergleichs (nur für einen laufenden TAG). */
export interface BisStundeVergleich {
  /** Die Stunde, BIS zu der gerechnet wurde (die laufende bleibt draußen). */
  bisStunde: number;
  jetztEur: number;
  vorherEur: number;
  /** Neutral getönt (Regel 3); `null`, wenn die Vorperiode keine Basis trägt. */
  delta: DeltaView | null;
}

/**
 * **Der Kern (E3a): heute bis zur laufenden Stunde gegen den Vortag bis zur
 * SELBEN Stunde.** `null`, sobald eine der beiden Seiten keine abgeschlossene
 * Stunde trägt — dann gibt es nichts ehrlich zu vergleichen (etwa um 00:30).
 */
export function vergleichBisStunde(
  heute: readonly VergleichsEimer[] | null | undefined,
  gestern: readonly VergleichsEimer[] | null | undefined,
  now: Date,
  name = 'dem Vortag',
): BisStundeVergleich | null {
  const stunde = berlinStunde(now);
  if (stunde == null) return null;
  const jetztEur = summeBisStunde(heute, stunde);
  const vorherEur = summeBisStunde(gestern, stunde);
  if (jetztEur == null || vorherEur == null) return null;
  // `mehrIstBesser = null` ⇒ `wertung: 'neutral'` per Hausregel; die Wertung
  // wird darunter zusätzlich festgeschrieben, damit ein späterer `true`-Griff
  // nicht unbemerkt ein rotes Urteil zurückbringt (B3).
  const d = delta(jetztEur, vorherEur, null, name);
  return { bisStunde: stunde, jetztEur, vorherEur, delta: d };
}

/** Welche der drei Lesarten die Karte zeigt. */
export type VergleichModus = 'gleicher_zeitpunkt' | 'nur_betraege' | 'ganze_periode';

/** Was die Erlöse-Karte über den Vergleich sagen darf. */
export interface ErloesVergleich {
  modus: VergleichModus;
  /**
   * **Ebene 0** — der Chip, 1–3 Wörter + Prozent („25 % weniger"). `null`,
   * wenn es nichts abweichendes zu sagen gibt (Revision 2 §3.12: „der
   * Vergleich nur, wenn er abweicht"). Am laufenden Tag IMMER `neutral`.
   */
  chip: DeltaView | null;
  /**
   * Die zwei Beträge in einer Zeile — „Bis 12 Uhr: heute 50,66 € · gestern
   * 67,57 €" bzw. „bisher 39,30 € · ganze Vorwoche 41,10 €". `null` für einen
   * abgeschlossenen Zeitraum (dort ist die Zahl der Karte der ganze Zeitraum).
   */
  betraege: string | null;
  /**
   * **Ebene 1** — der Erklärsatz, der sagt, WAS mit WAS verglichen wurde. Er
   * wohnt bewusst als Datenfeld hier, damit die neue Ergebnis-Karte (P3/P4) ihn
   * ohne eigene Ableitung in ihr Akkordeon setzen kann.
   */
  satz: string | null;
  /** Die Schnitt-Stunde (nur `gleicher_zeitpunkt`). */
  bisStunde: number | null;
  /** Die verglichenen Beträge als Zahlen (Ebene 1 / Titel). */
  jetztEur: number | null;
  vorherEur: number | null;
}

export interface ErloesVergleichInput {
  range: HistoryRange;
  anchor: Date;
  now: Date;
  modus?: VergleichsModus;
  /** Das Ergebnis des gezeigten Zeitraums. */
  jetztEur: number | null | undefined;
  /** Das Ergebnis der Vergleichsperiode — `null`/`undefined` = kein Vergleich. */
  vorherEur: number | null | undefined;
  jetztSeries?: readonly VergleichsEimer[] | null;
  vorherSeries?: readonly VergleichsEimer[] | null;
}

/**
 * Der volle Name der Vergleichsperiode für die Beträge-Zeile: „ganzer Vortag",
 * „ganze Vorwoche", „ganzer August", „ganzes Jahr 2025".
 */
export function vollerVergleichsName(
  anchor: Date,
  range: HistoryRange,
  modus: VergleichsModus = 'vorperiode',
): string {
  const name = vergleichsName(anchor, range, modus);
  if (range === 'day') return name === 'dem Vortag' ? 'ganzer Vortag' : `ganzer ${name}`;
  if (range === 'week') return name === 'der Vorwoche' ? 'ganze Vorwoche' : `ganze ${name}`;
  if (range === 'year') return `ganzes Jahr ${name}`;
  return `ganzer ${name}`;
}

/** „25 % weniger" — der Chip. `null` bei „etwa wie" (nur, wenn er abweicht). */
function kurzerChip(d: DeltaView | null): DeltaView | null {
  if (!d || d.richtung === 'gleich') return null;
  return { ...d, wertung: 'neutral', text: `${d.pct} % ${d.richtung}` };
}

/**
 * **Die EINE Formulierung des Gleiche-Stunde-Vergleichs** — Chip, Beträge-Zeile
 * und Methoden-Satz aus einem schon BEGRENZTEN Paar.
 *
 * Sie steht hier, weil zwei Flächen sie brauchen und derselbe Vergleich nicht
 * zweimal formuliert werden darf: die Anlagen-Seite rechnet die Grenze selbst
 * aus ihren Stunden-Eimern ({@link vergleichBisStunde}), das Portfolio bekommt
 * sie fertig vom Server (`GET /api/v1/earnings` → `vergleich`, Paket P6) —
 * beide gehen durch DIESE Funktion.
 *
 * **Am laufenden Tag wird nicht gewertet** (Regel 3): der Chip ist immer
 * `neutral`, die Richtung steht als Wort darin.
 */
export function gleicheStundeZeile(v: BisStundeVergleich): ErloesVergleich {
  return {
    modus: 'gleicher_zeitpunkt',
    chip: kurzerChip(v.delta),
    betraege: `Bis ${v.bisStunde} Uhr: heute ${eurAmount(v.jetztEur)} · gestern ${eurAmount(v.vorherEur)}`,
    satz: `Verglichen wird bis ${v.bisStunde} Uhr — der Vortag ebenfalls bis ${v.bisStunde} Uhr; die laufende Stunde bleibt bei beiden draußen.`,
    bisStunde: v.bisStunde,
    jetztEur: v.jetztEur,
    vorherEur: v.vorherEur,
  };
}

/**
 * **Die EINE Ableitung der Vergleichszeile der Erlöse-Karte.**
 *
 * - abgeschlossener Zeitraum → unverändert `delta()` mit Pfeil, Wort UND Ton;
 * - laufender TAG mit Stunden-Eimern → gleiche Stunde gegen gleiche Stunde,
 *   Prozent + Wort, neutral getönt;
 * - laufende Woche/Monat/Jahr (und ein laufender Tag ohne brauchbare Eimer, z.
 *   B. gegen ein älteres Backend) → NUR die zwei Beträge, kein Prozent.
 *
 * `null`, wenn es gar keine Vergleichsperiode gibt.
 */
export function erloesVergleich(input: ErloesVergleichInput): ErloesVergleich | null {
  const { range, anchor, now, jetztEur, vorherEur } = input;
  const modus = input.modus ?? 'vorperiode';
  if (vorherEur == null || !Number.isFinite(vorherEur)) return null;

  const name = vergleichsName(anchor, range, modus);
  const laeuft = isCurrentPeriod(anchor, range, now);

  if (!laeuft) {
    // Mehr Ergebnis ist eindeutig besser — die Wertung bleibt, wie sie war.
    return {
      modus: 'ganze_periode',
      chip: delta(jetztEur, vorherEur, true, name),
      betraege: null,
      satz: null,
      bisStunde: null,
      jetztEur: jetztEur ?? null,
      vorherEur,
    };
  }

  if (range === 'day') {
    const bis = vergleichBisStunde(input.jetztSeries, input.vorherSeries, now, name);
    if (bis) {
      return gleicheStundeZeile(bis);
    }
  }

  // Laufend, aber ohne gleichlange Grundlage: ein Anker, keine Wertung (K8).
  return {
    modus: 'nur_betraege',
    chip: null,
    betraege:
      jetztEur == null || !Number.isFinite(jetztEur)
        ? null
        : `bisher ${eurAmount(jetztEur)} · ${vollerVergleichsName(anchor, range, modus)} ${eurAmount(vorherEur)}`,
    satz: laufendHinweis(anchor, range, now, modus),
    bisStunde: null,
    jetztEur: jetztEur ?? null,
    vorherEur,
  };
}
