import type { ForecastAccuracyPoint, ForecastModelId, ForecastModelState } from './api';
import type { Kernaussage } from './chartKopf';
import { NBSP } from './format';

/**
 * Die Mobil-Fassung der Prognosequalität (Konzept `data/vp-mobile-views-x1` §8,
 * Captain-Go 09.08.2026) — reine Ableitungen, der Render ist dünn.
 *
 * Der gemessene Befund war REIHENFOLGE: 5.036 px (6,2 Bildschirme), die mit dem
 * Erklär-Essay beginnen; das erste Diagramm bei 3.437 px; und die eigentliche
 * Antwort — „wie genau sind meine Prognosen?" — musste man sich aus
 * Modell-Karten zusammensuchen. Die Kennzahl dafür EXISTIERT längst, sie stand
 * nur zu weit unten.
 *
 * **Die Rahmung ist load-bearing und bleibt:** 2 Prognosearten × (1 aktives
 * Modell + höchstens 1 Schatten-Kandidat). Sie adressiert die dokumentierte
 * Verwirrung „zwei aktive Prognosen" und darf beim Kürzen nicht verloren
 * gehen — sie wird nur von drei Absätzen auf eine Zeile Struktur eingedampft.
 */

/**
 * Die zwei Prognosearten, überall gleich benannt (die Rahmung hängt daran).
 * Diese Konstante ist die EINE Quelle — `PrognosePage` liest sie, statt eine
 * zweite Liste zu führen.
 */
export const KIND_LABELS: Record<'load' | 'pv', string> = {
  load: 'Verbrauchsprognose (Last)',
  pv: 'PV-Prognose (Erzeugung)',
};

/** Der eine Satz, der die Struktur trägt — Verdikt-Karte UND Aufklapper. */
export const RAHMUNG =
  '2 Prognosearten × je 1 aktives Modell + höchstens 1 lernender Kandidat.';

/** Der eine Ehrlichkeits-Satz unter dem Kandidaten-Status. */
export const KANDIDAT_EHRLICHKEIT =
  'Kandidaten beeinflussen Ihre Steuerung nicht. Ein Wechsel passiert nie automatisch.';

/** „±0,75 kW" — die Abweichung ist ein Betrag, deshalb das ±. */
export function abweichung(kw: number | null): string {
  if (kw == null) return '—';
  return `±${Number(kw).toLocaleString('de-DE', { maximumFractionDigits: 2 })}${NBSP}kW`;
}

export interface VerdiktZeile {
  kind: 'load' | 'pv';
  /** „Verbrauchsprognose (Last)". */
  art: string;
  /** „±0,75 kW" oder „—". */
  wert: string;
  /** „letzte 7 Tage" — oder der ehrliche Grund, warum es keinen Wert gibt. */
  note: string;
}

/**
 * Das Verdikt: 2 Arten × Ø-Abweichung. Es RECHNET nichts Neues — `mittlereMae`
 * ist dieselbe Kennzahl, die die Modell-Karten schon zeigten; sie rückt nur
 * nach oben.
 *
 * Eine Art ohne Bewertung bekommt „—" MIT Grund, nie eine erfundene 0.
 */
export function verdikt(
  accuracy: readonly ForecastAccuracyPoint[],
  aktiv: Record<'load' | 'pv', ForecastModelId>,
  tage = 7,
): VerdiktZeile[] {
  return (['load', 'pv'] as const).map((kind) => {
    const m = mittlereMae(accuracy, aktiv[kind], tage);
    return {
      kind,
      art: KIND_LABELS[kind],
      wert: abweichung(m ? m.mae : null),
      note: m
        ? `letzte ${m.tage} ${m.tage === 1 ? 'Tag' : 'Tage'}`
        : 'noch keine Bewertung',
    };
  });
}

/** Mittlere Ø-Abweichung EINES Modells über seine jüngsten `tage` Bewertungen. */
export function mittlereMae(
  accuracy: readonly ForecastAccuracyPoint[],
  model: ForecastModelId,
  tage = 7,
): { mae: number; tage: number } | null {
  const meine = accuracy
    .filter((a) => a.model === model)
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, tage);
  if (meine.length === 0) return null;
  return {
    mae: meine.reduce((s, a) => s + a.maeKw, 0) / meine.length,
    tage: meine.length,
  };
}

/** „In X von Y Bewertungen genauer" — die Tage mit positivem Skill. */
export function skillBilanz(
  accuracy: readonly ForecastAccuracyPoint[],
  model: ForecastModelId,
  tage = 10,
): { besser: number; gesamt: number } | null {
  const bewertet = accuracy
    .filter((a) => a.model === model && a.skillVsBaseline != null)
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, tage);
  if (bewertet.length === 0) return null;
  return {
    besser: bewertet.filter((a) => (a.skillVsBaseline ?? 0) > 0).length,
    gesamt: bewertet.length,
  };
}

export type KandidatTon = 'sammelt' | 'besser' | 'neutral';

export interface KandidatZeile {
  model: ForecastModelId;
  /** Die Prognoseart, gegen die er antritt — „Verbrauch" / „PV-Korrektur". */
  art: string;
  /** Die eine Aussage: „in 10 von 12 Tagen genauer" · „sammelt Daten · Tag 14/21". */
  stand: string;
  ton: KandidatTon;
}

/** Kurzform der Art für die Zwei-Zeilen-Wahrheit (die Karte nennt sie daneben). */
const ART_KURZ: Record<'load' | 'pv', string> = {
  load: 'Verbrauch',
  pv: 'PV-Korrektur',
};

/**
 * Der Kandidaten-Status als ZWEI-ZEILEN-WAHRHEIT (Konzept §8): je Kandidat eine
 * Zeile „Art → Stand", darunter EINMAL der Ehrlichkeits-Satz. Der ganze
 * Schattenbetrieb-Kern in ~90 px statt in drei Karten mit Fortschrittsbalken,
 * Trainings-Datum und Merkmalsliste — die wandern in den Aufklapper.
 *
 * Ehrlich in beide Richtungen: ein sammelnder Kandidat nennt seinen Tag-Stand,
 * ein rechnender ohne Bewertung sagt das, statt eine Quote zu erfinden.
 */
export function kandidatenZeilen(
  kandidaten: readonly ForecastModelState[],
  accuracy: readonly ForecastAccuracyPoint[],
): KandidatZeile[] {
  return kandidaten.map((k) => {
    const art = ART_KURZ[k.kind] ?? k.kind;
    if (k.status === 'collecting') {
      const tag = k.daysCollected ?? 0;
      const soll = k.daysRequired ?? 21;
      return { model: k.model, art, stand: `sammelt Daten · Tag ${tag}/${soll}`, ton: 'sammelt' };
    }
    const bilanz = skillBilanz(accuracy, k.model);
    if (!bilanz) {
      return { model: k.model, art, stand: 'rechnet mit · erste Bewertung folgt', ton: 'neutral' };
    }
    return {
      model: k.model,
      art,
      stand: `in ${bilanz.besser} von ${bilanz.gesamt} ${
        bilanz.gesamt === 1 ? 'Bewertung' : 'Bewertungen'
      } genauer`,
      // Nur eine MEHRHEIT der Bewertungen ist ein „besser" — sonst läse sich
      // „in 1 von 12 genauer" wie ein Erfolg.
      ton: bilanz.besser * 2 > bilanz.gesamt ? 'besser' : 'neutral',
    };
  });
}

/* ---------------------------------------------------------------------------
 * Die Diagramm-Schicht (Chart-Redesign Stufe 4)
 *
 * Die Diagnose war, dass die Fläche drei Dinge nicht sagte, die sie sagen muss
 * (Scout `vp-charts-verstaendlich-r2` §6 F):
 *
 *  - **Die POLARITÄT war unerklärt.** Die aktive Linie liegt oben, oben ist
 *    hier aber SCHLECHTER — ein Laie liest das genau verkehrt herum. Der Anker
 *    steht deshalb INNEN im Bild („↑ schlechter" / „↓ besser"); außen lief er
 *    in der Revision 1 aus der Fläche heraus.
 *  - **Die grüne Fläche zwischen den Kurven war unbenannt** (K10). Sie ist die
 *    eigentliche Aussage und trägt jetzt ihr Wort.
 *  - **„Ø kW" liest sich als Durchschnittsleistung** — die Klartext-Einheit
 *    steht in `chartCopy.AXIS.abweichung`.
 * ------------------------------------------------------------------------- */

/** Die zwei Polaritäts-Anker — sie stehen INNEN am Rand, nie außerhalb. */
export const POLARITAET = {
  oben: '↑ schlechter',
  unten: '↓ besser',
} as const;

/** Das Wort AN der Verbesserungs-Fläche (K10: keine Kodierung ohne Wort). */
export const VERBESSERUNG_WORT = 'so viel besser war der Kandidat';

export interface Verbesserung {
  /** Untere Kante je Tag (der bessere der beiden Werte) — `null` = Lücke. */
  unten: (number | null)[];
  /** Höhe der Fläche je Tag; nur wo der Kandidat WIRKLICH besser war. */
  delta: (number | null)[];
  /** {@link VERBESSERUNG_WORT} — nur gesetzt, wenn es etwas zu benennen gibt. */
  wort: string | null;
}

/**
 * Die Fläche zwischen aktivem Modell und Kandidat — sie wird NUR dort
 * gezeichnet, wo der Kandidat an diesem Tag wirklich näher lag. Ein Tag, an
 * dem er schlechter war, bekommt keine Fläche (sie hieße sonst das Gegenteil
 * von dem, was ihr Wort behauptet), und ein Tag ohne beide Werte bleibt eine
 * Lücke.
 *
 * `wort` ist `null`, wenn kein einziger Tag eine Fläche trägt — dann wird auch
 * nichts beschriftet.
 */
export function verbesserung(
  aktiv: readonly (number | null)[],
  kandidat: readonly (number | null)[],
): Verbesserung {
  const unten: (number | null)[] = [];
  const delta: (number | null)[] = [];
  let irgendwas = false;
  for (let i = 0; i < aktiv.length; i++) {
    const a = aktiv[i];
    const k = kandidat[i];
    if (a == null || k == null || k >= a) {
      unten.push(null);
      delta.push(null);
      continue;
    }
    unten.push(k);
    delta.push(a - k);
    irgendwas = true;
  }
  return { unten, delta, wort: irgendwas ? VERBESSERUNG_WORT : null };
}

/** Der Grund, wenn es (noch) keinen Kandidaten-Vergleich gibt. */
export const KEIN_VERGLEICH_GRUND =
  'Für diese Prognoseart läuft gerade kein lernender Kandidat.';
/** Der Grund, solange der Kandidat noch keine Bewertung hat. */
export const NOCH_KEINE_BEWERTUNG_GRUND =
  'Der Kandidat rechnet mit - die erste Bewertung folgt.';

/**
 * K1 · „Der Kandidat lag an 11 von 14 Tagen näher an der Wirklichkeit."
 *
 * ABGELEITET aus `skillBilanz` — derselben Zahl, die die Kandidaten-Zeile
 * nennt; sie rückt nur nach oben. Ohne Kandidat bzw. ohne Bewertung steht dort
 * der ehrliche GRUND, nie ein erfundener Satz. Der Ton ist nur dann `ok`, wenn
 * eine MEHRHEIT der Bewertungen für den Kandidaten spricht — sonst läse sich
 * „an 1 von 12 Tagen" wie ein Erfolg.
 */
export function kandidatKern(
  accuracy: readonly ForecastAccuracyPoint[],
  kandidat: ForecastModelId | null,
): Kernaussage {
  if (!kandidat) return { wert: null, satz: null, grund: KEIN_VERGLEICH_GRUND, ton: 'calm' };
  const bilanz = skillBilanz(accuracy, kandidat, 14);
  if (!bilanz) {
    return { wert: null, satz: null, grund: NOCH_KEINE_BEWERTUNG_GRUND, ton: 'calm' };
  }
  const mehrheit = bilanz.besser * 2 > bilanz.gesamt;
  // ⚠ Der Kopf trägt hier bewusst KEINEN Anker. Zwei Kandidaten waren im Test
  // beide eine DOPPELUNG derselben Seite: `KANDIDAT_EHRLICHKEIT` steht schon
  // unter der Kandidaten-Zeile, und die zwei Ø-Abweichungen stehen schon in
  // der Verdikt-Karte darüber. Die Zahlen gehören stattdessen AN die Kurven
  // (K2, `direktEtikett`) - dort können sie nicht von ihnen abweichen.
  return {
    wert: `${bilanz.besser} von ${bilanz.gesamt}`,
    satz: `${
      bilanz.gesamt === 1 ? 'Bewertung' : 'Bewertungen'
    }: So oft lag der Kandidat näher an der Wirklichkeit.`,
    grund: null,
    ton: mehrheit ? 'ok' : 'calm',
    anker: null,
  };
}

/**
 * K2 · Das Etikett AM Kurvenende: „aktiv Ø 0,68 kW" / „Kandidat Ø 0,54 kW".
 *
 * Es steht dort statt im Kopf, weil es dort nicht von der Kurve abweichen kann
 * (der Revision-1-Fehler: eine Legende behauptete einen Wert, den die Kurve
 * nicht zeigte) - und weil dieselben zwei Zahlen im Kopf eine Doppelung der
 * Verdikt-Karte wären. `null`, solange das Modell keine Bewertung hat.
 */
export function direktEtikett(
  accuracy: readonly ForecastAccuracyPoint[],
  model: ForecastModelId,
  istAktiv: boolean,
  tage = 14,
): string | null {
  const m = mittlereMae(accuracy, model, tage);
  if (!m) return null;
  return `${istAktiv ? 'aktiv' : 'Kandidat'} Ø ${abweichung(m.mae)}`;
}

/* ---------------------------------------------------------------------------
 * Der Prognose-Schalter + die Erklärbarkeit des Schattenbetriebs
 * (Captain-Auftrag 18.08.2026: „einen Schalter im Portal dafür machen und den
 * Schattenbetrieb für den Benutzer erklärbarer machen")
 *
 * Der Befund war, dass die Seite eine ZAHL zeigte („in 7 von 10 Bewertungen
 * genauer"), aus der eine HANDLUNG folgt - und weder die Zahl belegte, woher
 * sie kommt, noch gab es die Handlung. Beides ist hier rein abgeleitet; die
 * Fläche rendert nur.
 *
 * ⚠ Ehrlichkeitsregel, die alles hier trägt: die Liste unten zeigt EXAKT die
 * Tage, die der Zähler zählt (`skillBilanz`) - sonst hätte die Seite zwei
 * Wahrheiten über dieselben zehn Bewertungen. Deshalb filtert sie auf
 * `skillVsBaseline != null` und liest den Gewinner aus dem VORZEICHEN des
 * gespeicherten Vergleichs, statt die zwei Fehlerwerte neu gegeneinander zu
 * rechnen; die Fehler stehen als BELEG daneben.
 * ------------------------------------------------------------------------- */

/** Der Erklär-Kopf in zwei Sätzen - was Schattenbetrieb überhaupt ist. */
export const SCHATTEN_ERKLAERUNG = [
  'Ein lernender Kandidat rechnet jede Viertelstunde parallel mit und stellt eigene Prognosen - er beeinflusst dabei keinen einzigen Fahrplan.',
  'Jede Nacht wird nachgerechnet, wer näher an den echten Messwerten lag; erst dieser Vergleich begründet eine Umstellung.',
] as const;

/**
 * Das PRINZIP-Kärtchen am Seitenfuß („So funktioniert der Schattenbetrieb").
 *
 * Es beschreibt bewusst NICHT noch einmal den Mechanismus - den sagt
 * {@link SCHATTEN_ERKLAERUNG} direkt bei den Kandidaten -, sondern die
 * ENTSCHEIDUNG und ihre Folgen: wer umstellt, was sich dann ändert, und dass
 * der Rückweg offen bleibt. (Vor dem Schalter stand hier die Erklärung; sie ist
 * an den Ort gewandert, an dem die Frage entsteht, damit es nicht zwei
 * Fassungen desselben Satzes gibt.)
 *
 * EINE Quelle für Rechner UND Telefon-Aufklapper.
 */
export const SCHATTEN_PRINZIP = [
  'Ein Kandidat wird nie automatisch aktiv. Die Umstellung ist eine bewusste Entscheidung von VoltPilot anhand genau der Bewertungen, die auf dieser Seite stehen.',
  'Nach einer Umstellung planen alle Fahrpläne ab dem nächsten Planungslauf mit dem neuen Modell - spätestens 15 Minuten später. Das bisherige Modell verschwindet dabei nicht: es rechnet im Schatten weiter und wird weiter jede Nacht bewertet.',
  'Deshalb ist der Rückweg jederzeit offen, und es bleibt nachvollziehbar, welches Modell Ihre Anlage seit wann plant.',
] as const;

/** Die Zeile ÜBER den Merkmalsgewichten - sie ordnet die Prozente ein. */
export const MERKMALE_EINLEITUNG =
  'Worauf das Modell achtet - Anteil am gelernten Urteil:';

/** Die Metrik der Liste, ehrlich benannt (kein „Genauigkeit in %"). */
export const BEWERTUNG_METRIK =
  'Ø Abweichung je Tag (kW) - je Viertelstunde gegen den Messwert, dann gemittelt.';

/** Eine Zeile der Beleg-Liste: ein bewerteter Tag. */
export interface BewertungsZeile {
  /** ISO-Tag, wie er aus der Bewertung kommt. */
  day: string;
  /** „18.08.2026". */
  datum: string;
  /** Ø Abweichung des Kandidaten an diesem Tag. */
  kandidatMae: number;
  /** Ø Abweichung des aktiven Modells - `null`, wenn nicht bewertet. */
  aktivMae: number | null;
  /** Wer an diesem Tag näher lag. `null` = kein Urteil möglich. */
  gewinner: 'kandidat' | 'aktiv' | 'gleich' | null;
}

function datum(day: string): string {
  const [y, m, d] = day.split('-');
  return y && m && d ? `${d}.${m}.${y}` : day;
}

/**
 * Die letzten `tage` Bewertungen als BELEG für „X von Y genauer" - dieselben
 * Tage, in derselben Reihenfolge (neueste zuerst), die {@link skillBilanz}
 * zählt.
 *
 * Der Gewinner kommt aus dem Vorzeichen des GESPEICHERTEN Vergleichs
 * (`skillVsBaseline`), nicht aus einem neuen Vergleich der zwei kW-Werte: der
 * Server hat verglichen, die Fläche belegt. Fehlt der Wert des aktiven Modells
 * für einen Tag, steht dort „—" statt einer erfundenen Zahl.
 */
export function bewertungsListe(
  accuracy: readonly ForecastAccuracyPoint[],
  kandidat: ForecastModelId | null,
  aktiv: ForecastModelId,
  tage = 10,
): BewertungsZeile[] {
  if (!kandidat) return [];
  const aktivMaeByDay = new Map<string, number>();
  for (const a of accuracy) {
    if (a.model === aktiv) aktivMaeByDay.set(a.day, a.maeKw);
  }
  return accuracy
    .filter((a) => a.model === kandidat && a.skillVsBaseline != null)
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, tage)
    .map((a) => {
      const skill = a.skillVsBaseline ?? 0;
      return {
        day: a.day,
        datum: datum(a.day),
        kandidatMae: a.maeKw,
        aktivMae: aktivMaeByDay.get(a.day) ?? null,
        gewinner: skill > 0 ? 'kandidat' : skill < 0 ? 'aktiv' : 'gleich',
      } satisfies BewertungsZeile;
    });
}

/** Die Zeile über der Liste: „In 7 von 10 Bewertungen war der Kandidat genauer." */
export function bewertungsBilanzSatz(zeilen: readonly BewertungsZeile[]): string | null {
  if (zeilen.length === 0) return null;
  const besser = zeilen.filter((z) => z.gewinner === 'kandidat').length;
  return `In ${besser} von ${zeilen.length} ${
    zeilen.length === 1 ? 'Bewertung' : 'Bewertungen'
  } war der Kandidat genauer.`;
}

/* ---- der Schalter ---------------------------------------------------------- */

/** Der Zustand einer Prognoseart im Schalter (Server-Antwort, 1:1). */
export interface ModellWahl {
  kind: 'load' | 'pv';
  activeModel: ForecastModelId;
  source: 'portal' | 'env';
  envDefault: ForecastModelId;
  setByName: string | null;
  setAt: string | null;
  selectable: ForecastModelId[];
}

export interface ModellWahlHistorie {
  kind: 'load' | 'pv';
  model: ForecastModelId;
  previousModel: ForecastModelId | null;
  setByName: string | null;
  setAt: string;
}

export interface ModellWahlZustand {
  kinds: ModellWahl[];
  history: ModellWahlHistorie[];
}

/**
 * Die Rolle-plus-Herkunft-Zeile am AKTIVEN Modell: „aktiv seit 18.08.2026,
 * umgestellt von max" bzw. „aktiv (Standardmodell dieser Anlage)".
 *
 * Ohne Namen steht dort „von einem Portal-Admin" - eine nackte Kennung ist
 * kein Urheber, den ein Mensch liest, und den Namen zu erfinden wäre schlimmer.
 */
export function rolleZeile(wahl: ModellWahl | null): string {
  if (!wahl || wahl.source !== 'portal' || !wahl.setAt) {
    return 'Aktiv - das ausgelieferte Standardmodell dieser Prognoseart.';
  }
  const wer = wahl.setByName ? `von ${wahl.setByName}` : 'von einem Portal-Admin';
  return `Aktiv seit ${datum(wahl.setAt.slice(0, 10))}, umgestellt ${wer}.`;
}

/** Die Historie einer Art als lesbare Zeilen, neueste zuerst. */
export function historieZeilen(
  zustand: ModellWahlZustand | null,
  kind: 'load' | 'pv',
  labels: Record<string, string>,
  grenze = 5,
): string[] {
  if (!zustand) return [];
  return zustand.history
    .filter((h) => h.kind === kind)
    .slice(0, grenze)
    .map((h) => {
      const wer = h.setByName ? h.setByName : 'ein Portal-Admin';
      const von = h.previousModel ? labels[h.previousModel] ?? h.previousModel : null;
      const zu = labels[h.model] ?? h.model;
      return von
        ? `${datum(h.setAt.slice(0, 10))}: ${von} → ${zu} (${wer})`
        : `${datum(h.setAt.slice(0, 10))}: auf ${zu} umgestellt (${wer})`;
    });
}

/** Der Zustand des „Kandidat übernehmen"-Knopfes. */
export interface UebernahmeKnopf {
  /** Ob der Knopf überhaupt angeboten wird. */
  sichtbar: boolean;
  label: string;
  /** Deaktiviert-Grund, sonst `null`. */
  grund: string | null;
}

/**
 * Ein Knopf, der strukturell nichts bewirken kann, wird NICHT angeboten - und
 * wo er angeboten wird, steht der Einwand VOR dem Klick (die
 * `applyView`-Disziplin der Edge-Updates).
 *
 * Ein sammelnder Kandidat hat noch keine einzige Prognose abgegeben; ihn zu
 * übernehmen hieße, den Optimierer auf eine leere Reihe zu setzen. Deshalb ist
 * der Knopf dort da, aber gesperrt - mit dem echten Grund.
 */
export function uebernahmeKnopf(
  kandidat: ForecastModelState,
  bewertungen: readonly BewertungsZeile[],
  darfSchalten: boolean,
): UebernahmeKnopf {
  if (!darfSchalten) return { sichtbar: false, label: '', grund: null };
  if (kandidat.status === 'collecting') {
    const tag = kandidat.daysCollected ?? 0;
    const soll = kandidat.daysRequired ?? 21;
    return {
      sichtbar: true,
      label: 'Kandidat übernehmen',
      grund: `Noch keine Prognosen - der Kandidat sammelt Daten (Tag ${tag} von ${soll}).`,
    };
  }
  if (bewertungen.length === 0) {
    return {
      sichtbar: true,
      label: 'Kandidat übernehmen',
      grund: 'Noch keine Tagesbewertung - es gibt nichts, worauf sich eine Umstellung stützen könnte.',
    };
  }
  return { sichtbar: true, label: 'Kandidat übernehmen', grund: null };
}

/** Der Bestätigungs-Dialog: was passiert, was gleich bleibt, wie es zurückgeht. */
export interface UebernahmeDialog {
  titel: string;
  intro: string;
  folgen: string[];
  bestaetigen: string;
}

/**
 * Die Folgenliste im Haus-Muster (`ConfirmDialog`): sie nennt ausdrücklich
 * auch, was GLEICH bleibt - sonst liest sich jedes Umlegen wie ein Lockern der
 * Regeln - und dass der Rückweg offen ist.
 *
 * ⚠ Sie sagt „alle Anlagen": die Wahl gilt plattformweit (die Semantik der
 * abgelösten Umgebungsvariablen). Ein Klick auf einer Anlagen-Seite darf nie
 * wie eine Entscheidung für DIESE Anlage aussehen.
 */
export function uebernahmeDialog(
  kandidatLabel: string,
  aktivLabel: string,
  artLabel: string,
): UebernahmeDialog {
  return {
    titel: 'Kandidat übernehmen?',
    intro: `„${kandidatLabel}" wird das aktive Modell für die ${artLabel}.`,
    folgen: [
      'Ab dem nächsten Planungslauf - spätestens in 15 Minuten - rechnen alle Fahrpläne mit diesem Modell.',
      `„${aktivLabel}" lernt im Schatten weiter und wird weiter jede Nacht bewertet.`,
      'Sie können jederzeit zurücktauschen - mit demselben Knopf in die Gegenrichtung.',
      'Aufgezeichnete Messwerte, Fahrpläne und Bewertungen bleiben unverändert; es wird nichts neu trainiert.',
      'Die Umstellung gilt für alle Anlagen der Plattform und wird mit Zeitpunkt und Urheber protokolliert.',
    ],
    bestaetigen: 'Übernehmen',
  };
}

/** Der Rücktausch-Dialog - derselbe Knopf, andere Richtung, andere Folgen. */
export function ruecktauschDialog(
  zielLabel: string,
  aktivLabel: string,
  artLabel: string,
): UebernahmeDialog {
  return {
    titel: 'Zurücktauschen?',
    intro: `„${zielLabel}" wird wieder das aktive Modell für die ${artLabel}.`,
    folgen: [
      'Ab dem nächsten Planungslauf rechnen alle Fahrpläne wieder mit diesem Modell.',
      `„${aktivLabel}" rechnet danach im Schatten weiter - seine Bewertung läuft ohne Lücke weiter.`,
      'Auch der Rücktausch wird mit Zeitpunkt und Urheber protokolliert.',
    ],
    bestaetigen: 'Zurücktauschen',
  };
}

/**
 * Ist die Umstellung auf `model` ein RÜCKTAUSCH? Wahr, sobald dieses Modell
 * dieser Art schon einmal aktiv war (es taucht in der Historie als
 * abgelöstes Modell auf). Die Dialoge unterscheiden sich, weil sich die
 * Handlung unterscheidet - „übernehmen" ist ein Schritt nach vorn,
 * „zurücktauschen" die Rücknahme davon.
 */
export function istRuecktausch(
  zustand: ModellWahlZustand | null,
  kind: 'load' | 'pv',
  model: ForecastModelId,
): boolean {
  if (!zustand) return false;
  return zustand.history.some((h) => h.kind === kind && h.previousModel === model);
}

/** Die Wahl einer Art aus dem Schalter-Zustand (`null` = nicht geladen). */
export function wahlFuer(
  zustand: ModellWahlZustand | null,
  kind: 'load' | 'pv',
): ModellWahl | null {
  return zustand?.kinds.find((k) => k.kind === kind) ?? null;
}
