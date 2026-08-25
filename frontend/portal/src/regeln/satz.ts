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
 * der nennt, was keine Regel aushebelt — ohne einen Live-Zustand zu behaupten.
 *
 * ⚠ Der Fahrplan-Vorrang steht seit Steuerung Stufe 2 NICHT mehr hier: er gilt
 * NICHT für jede Regel gleich (siehe {@link VORRANG_ZEILE}), und ein Satz, der
 * ihn pauschal behauptet, wäre auf einer Geräte-Regel falsch.
 */
export const IMMER_ZEILE =
  'Geräteschutz, Netzvorgaben und der Vorrang von Sofortaktionen bleiben wirksam.';

/**
 * Was eine Regel BEANSPRUCHT — und damit, wer bei ihr vorgeht.
 * `speicher` = sie greift auf den Speicher zu, `geraet` = sie schaltet ein Gerät.
 */
export type VorrangArt = 'speicher' | 'geraet';

/**
 * Der Vorrang-Hinweis, **Variante 1** (Konzept `vp-steuerung-konzept-b3` §3.6,
 * Captain-Entscheid S2): ruhig, konkret, mit dem Beispiel und dem Rückweg — der
 * Text der FOLGEN-KARTE vor „Aktivieren".
 *
 * ⚠ **Er ist nach der beanspruchten Sache getrennt, und das bleibt so — aber
 * SEIT STUFE 3 sagen beide Zweige „Ihre Regel geht vor".** Die Trennung
 * transportiert jetzt die FOLGE, nicht mehr den Gewinner: auf dem Speicher
 * pausiert dafür ein laufendes Betriebsmodell, bei einem Gerät nicht.
 *
 * Belegt ist das (§3.7, jede Zeile mit Codestelle):
 *
 *  - **Gerät:** die Regel geht vor. Für Verbraucher wirft der Optimierer auf
 *    keiner Anlage einen konkurrierenden Wunsch ein
 *    (`OPTIMIZER_CONTROLLABLE_LOADS_ENABLED` und `VOLTPILOT_V2_PLAN_SITES` sind
 *    per Vorgabe aus), eine generierte Verbraucherregel überholt den Plan
 *    ohnehin — und seit Stufe 3 beansprucht eine aktive Regel ihre Komponente
 *    zusätzlich materiell (`flow_claim` → `owner_claimed`).
 *  - **Speicher:** die Regel geht seit Stufe 3 ebenfalls vor, und zwar OHNE
 *    dass am Arbiter etwas geändert wurde: für eine beanspruchte Komponente
 *    speist die Box gar keinen Fahrplan-Sollwert mehr ein (§3.7 A3) und der
 *    Optimierer plant sie als gehalten (A4). Ein Betriebsmodell auf demselben
 *    Speicher wird bei der Aktivierung stillgelegt statt die Regel abzulehnen
 *    (A5b) — deshalb nennt der Satz genau das.
 *
 * ⚠ Was der Satz ABSICHTLICH NICHT verspricht: eine Zahl. „Was das kostet"
 * kommt mit der Vorschau (Stufe 7); bis dahin wäre sie erfunden.
 */
export const VORRANG_FOLGEN: Record<VorrangArt, string> = {
  geraet:
    'Ihre Regel geht vor. Wenn sie greift, weicht der Fahrplan — Ihr Gerät läuft '
    + 'dann, weil Sie es so wollten, auch wenn VoltPilot gerade anders geplant '
    + 'hätte. Sie können die Regel jederzeit ausschalten, dann plant VoltPilot '
    + 'wieder frei.',
  speicher:
    'Ihre Regel geht vor. Wenn sie greift, weicht der Fahrplan — der Speicher '
    + 'wird dann zum Beispiel voll gehalten, obwohl er abends günstig hätte '
    + 'entladen können. Läuft gerade ein Betriebsmodell auf diesem Speicher, '
    + 'pausiert es dafür. Sie können die Regel jederzeit ausschalten, dann '
    + 'plant VoltPilot wieder frei.',
};

/**
 * Derselbe Hinweis, **Variante 3** (§3.6): der Einzeiler unter dem Schalter der
 * Regel-Zeile. Kürzeste Form desselben Fakts — nie belehrend, immer mit dem
 * Rückweg im Satz davor (die Karte trägt ihn).
 *
 * ⚠ Er ist eine BEDINGTE Aussage („greift die Regel …"), keine Live-Behauptung.
 * Ob eine Regel den Fahrplan GERADE ausbremst und was das kostet, meldet auch
 * nach Stufe 3 niemand fein genug (Konzept §3.7 C1) — das ist der Live-Beleg
 * der Stufe 7, und bis dahin wird er nicht erfunden.
 *
 * ⚠ Seit Stufe 3 lautet er auf BEIDEN Zweigen gleich, weil die Aussage jetzt
 * auf beiden stimmt (§3.7 A3/A4). Er bleibt trotzdem ein Record: der Speicher
 * bekommt in Stufe 7 die Variante 2 (dieselbe Aussage MIT Zahl), das Gerät
 * nicht.
 */
export const VORRANG_ZEILE: Record<VorrangArt, string> = {
  geraet:
    'Regel vor Fahrplan: Greift die Regel, plant VoltPilot um sie herum — das '
    + 'kann Ersparnis kosten. Wir zeigen es Ihnen, wenn es passiert.',
  speicher:
    'Regel vor Fahrplan: Greift die Regel, plant VoltPilot um sie herum — das '
    + 'kann Ersparnis kosten. Wir zeigen es Ihnen, wenn es passiert.',
};

/**
 * Der statische Erklärsatz auf einer SPEICHER-Regel — der Variante-3-Satz
 * (§3.6). Der Name bleibt, damit die Karte nicht umgebaut werden muss.
 */
export const SPEICHER_VORRANG_HINWEIS = VORRANG_ZEILE.speicher;

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
