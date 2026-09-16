/**
 * „Die Box an der Quelle“ (UEMS AP-13 IP-12, L6 · W10): woher eine Messstelle ihre Werte
 * BEKOMMT — nicht nur welches Gerät sie misst, sondern welche VoltPilot-Box dieses Gerät liest
 * und seit wann. Rein: keine Netzzugriffe, keine Uhr, kein React.
 *
 * **L6:** die Quelle-Karte der Messstellen-Seite (AP-04 IP-14) und die Register-Spalte „Quelle“
 * sagen „GR-7 C-1 · gelesen von Box Halle 2 (neu) seit 04.11.2026 09:38“ — der zweite Teil kommt
 * aus der ZUSTÄNDIGKEIT der Datenquelle (AP-06 IP-3), nie aus dem Namen der Anlage, nie aus einer
 * Adresse und nie aus der Heimat-Anlage der Box.
 *
 * **W10:** das Anlagen-Modell sagt „eine Anlage hat genau EINE Box“. Für die Flächen, die AP-13
 * berührt, gilt das nicht: es gibt eine Box **je Quelle**, und sie wechselt mit der Zeit (das
 * Referenzunternehmen führt vier Boxen und sieben Datenquellen). Deshalb steht hier keine Box je
 * ANLAGE, sondern je QUELLE und je ZEITPUNKT. Die Box-Seite selbst bleibt AP-06 IP-16.
 *
 * ⚠ KEINE ZWEITE REGEL. Welche Box zu einem Zeitpunkt liest, urteilt der Vertrags-Zwilling
 * `uemsDatenquelle.zustaendigeBox` (halboffen auf die Minute, `effective_to` gehört nicht dazu).
 * Dieses Modul stellt nur die Sätze und findet die Quelle ZUR KOMPONENTE.
 *
 * ⚠ NICHTS WIRD ERFUNDEN. Ohne bekannte Zuständigkeit steht kein Satz — keine 0, kein „unbekannt“,
 * keine Box aus der Nachbarschaft. Auch eine Box ohne Kundennamen (entfernte Box: `name === null`)
 * bekommt keinen Satz, denn „gelesen von 8f3e…“ ist kein Kundensatz. Das ist dieselbe Regel wie
 * `letzter_wert` in AP-04 IP-14: `null` heißt „nichts bekannt“.
 *
 * ⚠ BEFUND an AP-06 (siehe `api.ts`): `GET …/sites/{id}/data-sources` nennt weder die Geräte noch
 * die Komponenten einer Quelle. Der Weg „Komponente → ihre Datenquelle“, den AP-13 §8
 * voraussetzt, geht deshalb über `GET …/sites/{id}/geraete` und dessen `data_source_id` —
 * {@link quellenJeGeraet} ist genau diese Verbindung, zwei Aufrufe je Anlage statt einem.
 */
import type { UemsDatenquelle, UemsDatenquelleZeitraum, UemsGeraet } from './api';
import { UEMS_BOX } from './glossar';
import { zustaendigeBox } from './uemsDatenquelle';

// ────────────────────────────────────────────────────────────────────────── Wörter

/** L6 — der ganze Satz steht an EINER Stelle; die Flächen setzen nur ihren Zeitpunkt-Text ein. */
export const GELESEN_VON = 'gelesen von {box} seit {zeitpunkt}';

/** AP-04 A7: der Fakt im Messstellenregister, bewusst nicht als Tätigkeit formuliert. */
export const ZUSTAENDIG = 'zuständig: {box} seit {zeitpunkt}';

/** Die Überschrift der Zeile, wo die Fläche eine braucht (Karte am Telefon). */
export const GELESEN_VON_TITEL = `Gelesen von ${UEMS_BOX}`;

const ms = (iso: string): number => Date.parse(iso);

// ────────────────────────────────────────────────────────────────────────── Formen

/** Welche Box eine Quelle zu einem Zeitpunkt liest — und seit wann ununterbrochen. */
export interface BoxZuordnung {
  /** Die Datenquelle, aus deren Zuständigkeit die Aussage kommt. */
  quelle: string;
  /** Die Kennung der Box (`device.id`). */
  boxId: string;
  /** Der Kundenname der Box („Box Halle 2 (neu)“). */
  name: string;
  /** Beginn des laufenden Zuständigkeits-Zeitraums — das „seit“ des Satzes. */
  seit: string;
}

/** Ein Wechsel der zuständigen Box an EINER Quelle, gelesen aus der Zeitachse. */
export interface BoxWechsel {
  quelle: string;
  /** Der Augenblick, in dem die neue Box übernimmt (Ende alt = Beginn neu). */
  zeitpunkt: string;
  /**
   * Das Wort des Ereignis-Vokabulars (`handover`, AP-07): `box_tausch`, wenn die alte Box mit
   * diesem Augenblick ALLE ihre Zuständigkeiten abgibt und danach keine mehr beginnt (AP-06 E7);
   * sonst `uebergabe` — dann liest sie anderswo weiter.
   */
  anlass: 'box_tausch' | 'uebergabe';
  boxAlt: string;
  boxNeu: string;
  /** Kennung → Kundenname für die Platzhalter des Satzes; ohne Namen fehlt der Eintrag. */
  namen: Record<string, string>;
}

// ────────────────────────────────────────────────── Die Quelle zur Komponente (Befund)

/**
 * Gerät → Datenquelle, über `geraet.data_source_id`. Ein Gerät ohne Datenquelle steht nicht in
 * der Karte; eine Datenquelle, die es nicht (mehr) gibt, wird nicht erfunden.
 */
export function quellenJeGeraet(
  geraete: readonly UemsGeraet[] | null | undefined,
  datenquellen: readonly UemsDatenquelle[] | null | undefined,
): Map<string, UemsDatenquelle> {
  const nach = new Map((datenquellen ?? []).map((q) => [q.id, q]));
  const karte = new Map<string, UemsDatenquelle>();
  for (const g of geraete ?? []) {
    const q = g.data_source_id ? nach.get(g.data_source_id) : undefined;
    if (q) karte.set(g.id, q);
  }
  return karte;
}

// ──────────────────────────────────────────────────────────────── Zuständigkeit → Satz

const normal = (zs: readonly UemsDatenquelleZeitraum[]) =>
  zs.map((z) => ({ box: z.box.id, effective_from: z.effective_from, effective_to: z.effective_to }));

/**
 * Welche Box liest `q` zum Zeitpunkt `t` — das Urteil fällt `uemsDatenquelle.zustaendigeBox`.
 * `null`: keine Box zuständig (Entwurf, Lücke, erst geplant) ODER die Box hat keinen Namen mehr.
 */
export function zustaendigkeit(q: UemsDatenquelle, t: string): BoxZuordnung | null {
  const zeitraeume = q.zeitraeume ?? [];
  const boxId = zustaendigeBox(normal(zeitraeume), t);
  if (boxId === null) return null;
  const laufend = zeitraeume.find(
    (z) => z.box.id === boxId && ms(z.effective_from) <= ms(t) && (z.effective_to === null || ms(t) < ms(z.effective_to)),
  );
  const name = laufend?.box.name;
  if (!laufend || !name) return null;
  return { quelle: q.id, boxId, name, seit: laufend.effective_from };
}

/** Die Box am GERÄT einer Bindung — der Weg, den die Flächen gehen (Komponente → Gerät → Quelle). */
export function boxAmGeraet(
  karte: ReadonlyMap<string, UemsDatenquelle>,
  geraetId: string | null | undefined,
  t: string,
): BoxZuordnung | null {
  const q = geraetId ? karte.get(geraetId) : undefined;
  return q ? zustaendigkeit(q, t) : null;
}

/**
 * L6 — „gelesen von Box Halle 2 (neu) seit 04.11.2026 09:38“. `zeit` ist der Zeitpunkt-Text der
 * Fläche (das Register schreibt „04.11.2026 09:38“, die Quelle-Karte „04.11.2026, 09:38 Uhr“);
 * ohne Zuordnung gibt es KEINEN Satz.
 */
export function boxSatz(z: BoxZuordnung | null, zeit: (iso: string) => string): string | null {
  if (z === null) return null;
  return GELESEN_VON.split('{box}').join(z.name).split('{zeitpunkt}').join(zeit(z.seit));
}

/** A7 — derselbe Zuständigkeitsfakt wie {@link boxSatz}, in der Wortform des Registers. */
export function zustaendigSatz(z: BoxZuordnung | null, zeit: (iso: string) => string): string | null {
  if (z === null) return null;
  return ZUSTAENDIG.split('{box}').join(z.name).split('{zeitpunkt}').join(zeit(z.seit));
}

// ───────────────────────────────────────────────────── Box-Tausch und Übergabe (V5)

/** Beginnt bei `zeitpunkt` eine Zuständigkeit dieser Box, oder reicht eine darüber hinaus? */
const haeltNoch = (q: UemsDatenquelle, box: string, zeitpunkt: string): boolean =>
  (q.zeitraeume ?? []).some(
    (z) => z.box.id === box && (z.effective_to === null || ms(z.effective_to) > ms(zeitpunkt)),
  );

/**
 * Die Box-Wechsel EINER Quelle, aus der Zeitachse ihrer Zuständigkeiten (jüngster zuletzt). Ein
 * Wechsel ist genau die Naht zweier Zeiträume mit verschiedenen Boxen: `effective_to` der alten
 * ist `effective_from` der neuen (AP-06 §4: Ende alt = Beginn neu). Eine Lücke dazwischen ist
 * kein Wechsel, sondern eine Zeit ohne Box — sie wird nie aufgefüllt.
 *
 * `anlass` urteilt über `alle` Quellen, die der Aufrufer geladen hat (heute: die Quellen der
 * Anlage): gibt die alte Box mit diesem Augenblick ALLE ihre Zuständigkeiten ab, ist es ein
 * Box-Tausch (AP-06 E7), sonst eine Übergabe. Liest eine Box über Anlagen hinweg, braucht das
 * Urteil die Quellen aller Anlagen — sonst hiesse eine Übergabe fälschlich Box-Tausch.
 */
export function boxWechsel(
  q: UemsDatenquelle,
  alle: readonly UemsDatenquelle[] = [q],
): BoxWechsel[] {
  const zs = [...(q.zeitraeume ?? [])].sort((a, b) => ms(a.effective_from) - ms(b.effective_from));
  const wechsel: BoxWechsel[] = [];
  for (let i = 1; i < zs.length; i += 1) {
    const alt = zs[i - 1];
    const neu = zs[i];
    if (alt.effective_to === null || ms(alt.effective_to) !== ms(neu.effective_from)) continue;
    if (alt.box.id === neu.box.id) continue;
    const zeitpunkt = neu.effective_from;
    const behaelt = alle.some((x) => haeltNoch(x, alt.box.id, zeitpunkt));
    const namen: Record<string, string> = {};
    if (alt.box.name) namen[alt.box.id] = alt.box.name;
    if (neu.box.name) namen[neu.box.id] = neu.box.name;
    wechsel.push({
      quelle: q.id,
      zeitpunkt,
      anlass: behaelt ? 'uebergabe' : 'box_tausch',
      boxAlt: alt.box.id,
      boxNeu: neu.box.id,
      namen,
    });
  }
  return wechsel;
}

/** Alle Box-Wechsel einer Quelle am GERÄT einer Bindung — derselbe Weg wie {@link boxAmGeraet}. */
export function boxWechselAmGeraet(
  karte: ReadonlyMap<string, UemsDatenquelle>,
  geraetId: string | null | undefined,
  alle: readonly UemsDatenquelle[],
): BoxWechsel[] {
  const q = geraetId ? karte.get(geraetId) : undefined;
  return q ? boxWechsel(q, alle) : [];
}

/**
 * Der Wechsel, der zu einem Ereignis `handover` der Werte-Route gehört: die Route liefert nur
 * `{id, art, von, bis}` — `anlass`, `box_alt` und `box_neu` stehen in der Zeitachse. Getroffen
 * wird über den Augenblick der Übernahme (`von`); ohne Treffer bleibt der Marker beim
 * Kurz-Satz des Vokabulars („Übergabe seit …“), statt eine Box zu raten.
 */
export function wechselZu(wechsel: readonly BoxWechsel[], von: string): BoxWechsel | null {
  return wechsel.find((w) => ms(w.zeitpunkt) === ms(von)) ?? null;
}

/**
 * Die Felder, mit denen `uemsEreignis.ereignisSatz` den vollen IP-4-Satz spricht:
 * „Box-Tausch: Box Halle 2 (neu) ersetzt Box Halle 2 — keine Werte von 04.11.2026 09:38 bis 09:40“.
 * Ohne beide Namen gibt es keine Ergänzung — ein Satz mit einer rohen Kennung wäre keiner.
 */
export function wechselFelder(
  w: BoxWechsel,
): { felder: { anlass: string; box_alt: string; box_neu: string }; namen: Record<string, string> } | null {
  if (!w.namen[w.boxAlt] || !w.namen[w.boxNeu]) return null;
  return { felder: { anlass: w.anlass, box_alt: w.boxAlt, box_neu: w.boxNeu }, namen: w.namen };
}
