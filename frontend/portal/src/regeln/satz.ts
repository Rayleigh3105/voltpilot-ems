/**
 * Der REGEL-SATZ (Einheitsmodell Stufe 5a, Konzept `vp-komponenten-einheit-h2`
 * Teil 5b.3): jede Regel-Karte trägt EINEN Klartext-Satz — und zwar aus EINER
 * Ableitung, nie aus zwei Wahrheiten.
 *
 *  - **Rezept-Regeln** (Verbraucher) lesen WÖRTLICH `consumers/policy.ts`
 *    `policySentence` — denselben Satz, den der Regelbaukasten als permanente
 *    Vorschau zeigt. Vorschau und Karte können damit nicht auseinanderlaufen.
 *  - **Baukasten-Regeln** gehen durch den bestehenden Rück-Parser
 *    (`flows/guidedBuilder.ts` `parseGuidedFlow`, Roundtrip-Gesetz) und werden
 *    hier zu einem Satz komponiert.
 *  - **Editor-Regeln** bekommen KEINEN geratenen Satz: der Rück-Parser gibt
 *    ehrlich `null`, und dann steht dort „Eigene Regel · N Bausteine".
 *    Weniger behaupten schlägt falsch zusammenfassen.
 *
 * PURE + unit-getestet (`satz.test.ts`); die Fläche rendert nur.
 */
import { channelLabel } from '../channels';
import type { EditorEntity, FlowDocument } from '../flows/model';
import { parseGuidedFlow, type GuidedAction, type GuidedCondition, type GuidedRule } from '../flows/guidedBuilder';

/**
 * Die IMMER-Zeile der Regel-Karte (5b.5): was unabhängig von jeder Regel gilt.
 * Sie steht im Detail-Einschub unter WENN/DANN und ist bewusst der EINE Satz,
 * der die Rangordnung nennt, ohne einen Live-Zustand zu behaupten.
 */
export const IMMER_ZEILE =
  'Geräteschutz, Netzvorgaben und der Vorrang von Fahrplan und Sofortaktionen bleiben wirksam.';

/**
 * Der STATISCHE Erklärsatz auf einer Speicher-Regel (5b.1, Zeile „Hinweis"):
 * die Arbitrierungs-Ränge sind dokumentiert, WER gerade gewinnt meldet die Box
 * aber nicht fein genug — ein Live-Zustand wäre erfunden.
 */
export const SPEICHER_VORRANG_HINWEIS = 'Der Fahrplan hat auf dem Speicher Vorrang.';

const DAY_WORD: Record<string, string> = {
  alle: 'täglich',
  werktage: 'an Werktagen',
  wochenende: 'am Wochenende',
};

function num(value: number): string {
  return value.toLocaleString('de-DE', { maximumFractionDigits: 2 });
}

function entityName(entities: EditorEntity[], id: string): string {
  const found = entities.find((e) => e.id === id);
  return found?.label?.trim() ? found.label : 'Ihr Gerät';
}

/** Die Einheit eines Messwerts in Kundendeutsch (leer, wenn keine bekannt ist). */
function channelUnit(channel: string): string {
  if (channel.endsWith('_pct')) return ' %';
  if (channel.endsWith('_kw')) return ' kW';
  if (channel.endsWith('_kwh')) return ' kWh';
  return '';
}

/** Eine Bedingung als lesbarer Nebensatz („der Ladestand über 25 % liegt"). */
export function bedingungSatz(c: GuidedCondition, entities: EditorEntity[]): string {
  if (c.kind === 'schedule') {
    return `es ${DAY_WORD[c.days] ?? 'täglich'} zwischen ${c.from} und ${c.to} Uhr ist`;
  }
  const richtung = c.direction === 'above' ? 'über' : 'unter';
  if (c.kind === 'price') {
    return `der Börsenpreis ${richtung} ${num(c.threshold)} ct/kWh liegt`;
  }
  const wert = channelLabel(c.channel);
  const wo = entityName(entities, c.entityId);
  return `${wert} von ${wo} ${richtung} ${num(c.threshold)}${channelUnit(c.channel)} liegt`;
}

/** Die Aktion als lesbarer Hauptsatz („schaltet VoltPilot die Wallbox ein"). */
export function aktionSatz(a: GuidedAction, entities: EditorEntity[]): string {
  switch (a.kind) {
    case 'onoff':
      return `schaltet VoltPilot ${entityName(entities, a.entityId)} ein`;
    case 'setpoint':
      return `stellt VoltPilot ${entityName(entities, a.entityId)} auf ${num(a.value)} kW`;
    default:
      return `meldet VoltPilot: „${a.message}“`;
  }
}

/** Der Satz einer Baukasten-Regel (WENN … , DANN …). */
export function guidedSatz(rule: GuidedRule, entities: EditorEntity[]): string {
  const verb = rule.combinator === 'or' ? ' oder ' : ' und ';
  const wenn = rule.conditions.map((c) => bedingungSatz(c, entities)).join(verb);
  return `Wenn ${wenn}, ${aktionSatz(rule.action, entities)}.`;
}

/** Die WENN-Zeilen des Detail-Einschubs (eine je Bedingung). */
export function wennZeilen(rule: GuidedRule, entities: EditorEntity[]): string[] {
  return rule.conditions.map((c, i) => {
    const satz = bedingungSatz(c, entities);
    if (i === 0) return satz.charAt(0).toUpperCase() + satz.slice(1);
    return `${rule.combinator === 'or' ? 'oder' : 'und'} ${satz}`;
  });
}

/** Die DANN-Zeile des Detail-Einschubs. */
export function dannZeile(rule: GuidedRule, entities: EditorEntity[]): string {
  const satz = aktionSatz(rule.action, entities);
  return satz.charAt(0).toUpperCase() + satz.slice(1);
}

export interface FlowSatz {
  /** Der Klartext-Satz, oder null wenn der Baukasten die Regel nicht abbildet. */
  satz: string | null;
  /** Die ehrliche Ersatz-Zeile („Eigene Regel · 7 Bausteine"). */
  ersatz: string;
  /** Das geparste Formular-Modell (null = außerhalb des Baukasten-Ausschnitts). */
  rule: GuidedRule | null;
}

/**
 * Der Satz einer FLOW-Regel. Ist das Dokument außerhalb des Baukasten-
 * Ausschnitts, bleibt `satz` null und die Karte zeigt `ersatz` — nie eine
 * geratene Zusammenfassung.
 */
export function flowSatz(doc: FlowDocument | null, entities: EditorEntity[]): FlowSatz {
  const bausteine = doc?.nodes?.length ?? 0;
  const ersatz = `Eigene Regel · ${bausteine} Baustein${bausteine === 1 ? '' : 'e'}`;
  if (!doc) return { satz: null, ersatz, rule: null };
  const rule = parseGuidedFlow(doc);
  if (!rule) return { satz: null, ersatz, rule: null };
  return { satz: guidedSatz(rule, entities), ersatz, rule };
}
