/**
 * Die REGEL-KARTE IM DETAIL (Einheitsmodell Stufe 5a, Konzept
 * `vp-komponenten-einheit-h2` Teil 5b.5) — ein Einschub, keine eigene Seite.
 *
 * Von oben nach unten: Kopf (Name · Zustand · Gerätestand) → „Ihre Regel"
 * (WENN/DANN als lesbare Sätze + die IMMER-Zeile) → „Verlauf dieser Regel"
 * → „Geprüft & durchgerechnet" bzw. der Erfüllungs-Nachweis → Versionen →
 * Aktionen.
 *
 * Zwei Ehrlichkeitsregeln tragen diese Datei:
 *
 *  - **Der VERLAUF wird in dieser Stufe noch nicht aufgezeichnet** (der
 *    Verlaufsspeicher ist Stufe 5b). Die Fläche sagt das mit einem Satz —
 *    es gibt hier keine Platzhalter-Zahl, keinen „heute N×"-Zähler und keine
 *    leere Liste, die wie ein Ausfall aussieht.
 *  - **Simulation und Nachweis sind GETRENNT.** Baukasten-/Editor-Regeln
 *    tragen das Jahres-Ergebnis ihres Probelaufs; Rezept-Regeln mit
 *    Pflicht-Semantik haben keinen Jahres-Probelauf und zeigen stattdessen
 *    ihren Erfüllungs-Nachweis (gemessen > berechnet > angenommen). Die Karte
 *    behauptet nie eine Zahl, die es nicht gibt.
 *
 * PURE + unit-getestet (`detail.test.ts`).
 */
import { eurAmount } from '../format';
import {
  fulfilmentSummary,
  taskLine,
  type ConsumerFulfilment,
} from '../consumers/fulfillment';
import type { GuidedRule } from '../flows/guidedBuilder';
import type { EditorEntity } from '../flows/model';
import type { FlowSimulationSummary } from '../flows/flowsApi';
import { dannZeile, IMMER_ZEILE, wennZeilen } from './satz';
import { VERLAUF_NOCH_NICHT, type RegelKarte } from './zustand';

export interface RegelAbschnitt {
  /** Die Überschrift des Abschnitts (Versalien-Zeile im Einschub). */
  titel: string;
  /** Die Zeilen des Abschnitts — leer heißt: der Abschnitt entfällt. */
  zeilen: string[];
  /** Eine ruhige Fußnote, die die Grenze der Aussage nennt. */
  note?: string | null;
}

export interface RegelDetailView {
  name: string;
  /** WENN-Zeilen; leer, wenn die Regel außerhalb des Baukasten-Ausschnitts liegt. */
  wenn: string[];
  /** DANN-Zeile; null im selben Fall. */
  dann: string | null;
  /** Der Ersatz, wenn WENN/DANN nicht ableitbar ist („Eigene Regel · 7 Bausteine"). */
  ersatz: string | null;
  immer: string;
  verlauf: RegelAbschnitt;
  /** „Geprüft & durchgerechnet" bzw. der Erfüllungs-Nachweis. */
  nachweis: RegelAbschnitt;
  versionen: string | null;
  /** Die Beschriftung von „Bearbeiten"; null wenn es keinen Rückweg gibt. */
  bearbeiten: string | null;
  /** Die Beschriftung des Schalters im Fuß („Pausieren"/„Einschalten"). */
  schalter: string;
}

export interface RegelDetailInput {
  karte: RegelKarte;
  entities: EditorEntity[];
  /** Das geparste Formular-Modell einer Baukasten-Regel (null = Editor-Regel). */
  rule?: GuidedRule | null;
  /** Der Klartext-Satz einer Rezept-Regel (er ersetzt WENN/DANN). */
  rezeptSatz?: string | null;
  /** Der Probelauf einer Flow-Regel. */
  simulation?: FlowSimulationSummary | null;
  /** Der Erfüllungs-Nachweis einer Rezept-Regel. */
  fulfilment?: ConsumerFulfilment | null;
  /** Die gespeicherten Versionen (Flow) bzw. die Policy-Version (Rezept). */
  versionen?: number[] | null;
  aktiveVersion?: number | null;
}

const VERLAUF_TITEL = 'Verlauf dieser Regel';
const GEPRUEFT_TITEL = 'Geprüft & durchgerechnet';
const NACHWEIS_TITEL = 'Erfüllungs-Nachweis';

/**
 * Der Probelauf-Satz einer Flow-Regel. Ohne Ergebnis wird NICHTS behauptet —
 * eine Regel ohne Probelauf sagt das, statt eine 0 € zu erfinden.
 */
export function probelaufZeile(sim: FlowSimulationSummary | null | undefined): string | null {
  const eur = sim?.headline?.voltpilotVorteilNettoEur ?? sim?.headline?.gesamtVorteilNettoEur;
  if (sim == null || eur == null || !Number.isFinite(eur)) return null;
  const vorzeichen = eur >= 0 ? '+' : '−';
  return `An einem Jahr Ihrer Anlage durchgerechnet: ${vorzeichen}${eurAmount(Math.abs(eur))} `
    + 'gegenüber „ohne diese Regel".';
}

/** Der Nachweis-Abschnitt: Probelauf (Flow) ODER Erfüllung (Rezept). */
export function nachweisAbschnitt(input: RegelDetailInput): RegelAbschnitt {
  if (input.karte.art === 'rezept') {
    const tasks = input.fulfilment?.tasks ?? [];
    const summary = fulfilmentSummary(input.fulfilment);
    const zeilen = tasks.map((t) => {
      const l = taskLine(t);
      return [l.text, l.progress, l.confirmation, l.atRisk ? 'Frist gefährdet' : '']
        .filter((p) => p !== '')
        .join(' · ');
    });
    return {
      titel: NACHWEIS_TITEL,
      zeilen: summary.headline ? [summary.headline, ...zeilen] : zeilen,
      note: tasks.length === 0
        ? 'Für diese Regel liegt noch kein Nachweis vor.'
        : 'Gemessen, sonst aus der Leistung berechnet, sonst angenommen — nie behauptet.',
    };
  }
  const zeile = probelaufZeile(input.simulation);
  return {
    titel: GEPRUEFT_TITEL,
    zeilen: zeile ? [zeile] : [],
    note: zeile
      ? null
      : 'Diese Regel wurde noch nicht durchgerechnet — vor dem Einschalten prüft und '
        + 'simuliert VoltPilot sie.',
  };
}

/** Die Versionen-Zeile („v3 aktiv · v2 · v1"), oder null. */
export function versionenZeile(
  versionen: number[] | null | undefined,
  aktiv: number | null | undefined,
): string | null {
  const list = [...(versionen ?? [])].sort((a, b) => b - a);
  if (list.length === 0) return null;
  return list.map((v) => (v === aktiv ? `v${v} aktiv` : `v${v}`)).join(' · ');
}

/** Der Detail-Einschub einer Regel. */
export function regelDetail(input: RegelDetailInput): RegelDetailView {
  const karte = input.karte;
  const rule = input.rule ?? null;
  const rezept = karte.art === 'rezept';

  // Eine Rezept-Regel trägt ihren EINEN Satz (den der Baukasten als Vorschau
  // zeigt); eine Baukasten-Regel wird in WENN/DANN zerlegt; eine Editor-Regel
  // bekommt keinen geratenen Satz.
  const wenn = rule ? wennZeilen(rule, input.entities) : [];
  const dann = rule ? dannZeile(rule, input.entities) : null;
  const rezeptSatz = rezept ? (input.rezeptSatz ?? karte.satz) : null;

  let ersatz: string | null = null;
  if (!rule && !rezeptSatz) ersatz = karte.ersatz;

  return {
    name: karte.name,
    wenn: rezeptSatz ? [rezeptSatz] : wenn,
    dann: rezeptSatz ? null : dann,
    ersatz,
    immer: IMMER_ZEILE,
    verlauf: {
      titel: VERLAUF_TITEL,
      zeilen: [],
      note: VERLAUF_NOCH_NICHT,
    },
    nachweis: nachweisAbschnitt(input),
    versionen: rezept ? null : versionenZeile(input.versionen, input.aktiveVersion),
    bearbeiten: rezept
      ? 'Regel bearbeiten'
      : rule
        ? 'Bearbeiten (Baukasten)'
        : 'Im Editor öffnen',
    schalter: karte.an ? 'Pausieren' : 'Einschalten',
  };
}
