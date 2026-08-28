/**
 * Portal v3 · M4 — der Vorlagen-Filter der EINEN „＋ Neue Automation"-Fläche.
 *
 * Eine Vorlage, die diese Anlage gar nicht fahren kann, wird **ausgeblendet**
 * (nicht ausgegraut) — hinter einer gezählten, ehrlichen Zeile, die sagt, was
 * fehlt, und die man aufklappen kann. Das ersetzt die alte Galerie, in der jede
 * Vorlage stand und die Hälfte davon einen roten Grund trug.
 *
 * Rein, ohne React/Netzwerk (der `surface.ts`/`steuerungArea.ts`-Präzedenzfall).
 *
 * **Die Rollen werden aus dem Anlagenmodell ABGELEITET, nie aus einer
 * Typenliste:** die Kanäle einer Entität laufen durch `topology.defaultRole`
 * (die TS-Hälfte der EINEN, über Go/TS/Java geteilten AE1-Ableitung), die
 * Kategorie kommt aus dem Topologie-Read-Model, wenn es geladen ist, und sonst
 * aus den Fähigkeiten der Entität selbst.
 *
 * **`resolve()` bleibt die Wahrheit.** Dieser Filter darf nie großzügiger sein
 * als `resolve()` — sonst zeigt die Fläche eine Vorlage an, die beim Klick
 * scheitert. `customerTemplates.test.ts` nagelt genau diese Richtung fest.
 */
import type { SiteTopology } from '../api';
import { defaultRole } from '../topology';
import type { CustomerTemplateDef, TemplateRole } from './customerTemplates';
import type { EditorEntity } from './model';

/** Das Anlagenmodell, gegen das gefiltert wird. */
export interface PlantModel {
  /** Die v2-Entitäten in der Editor-Sicht (Fähigkeiten je Entität). */
  entities: EditorEntity[];
  /** Optional das Topologie-Read-Model — liefert die Kategorien. */
  topology?: SiteTopology | null;
}

/** Was der Kundin fehlt, in ihrer Sprache (nie ein Rollen-Code). */
const MISSING_LABEL: Record<TemplateRole, string> = {
  consumer: 'ein steuerbares Gerät',
  grid: 'ein Netz-Zähler',
  storage: 'ein Speicher',
  pv: 'eine PV-Erzeugung',
};

/**
 * Die Kategorie einer Entität, wenn das Topologie-Read-Model sie nicht kennt:
 * abgeleitet aus ihren FÄHIGKEITEN (misst Ladestand → Speicher, misst
 * PV-Leistung → Erzeuger, schaltbar → Verbraucher, misst nur Leistung ohne
 * Steuerung → Zähler). Bewusst keine Typenliste — das Vokabular der
 * Entitätstypen ist offen (E1b).
 */
function inferCategory(e: EditorEntity): string {
  const measure = e.measure ?? [];
  const actuate = e.actuate ?? [];
  if (measure.includes('soc_pct') || measure.includes('battery_power_kw')) return 'storage';
  if (measure.includes('pv_power_kw')) return 'producer';
  if (actuate.length > 0) return 'consumer';
  if (measure.includes('power_kw')) return 'meter';
  return '';
}

/**
 * Die Rollen, die diese Anlage tatsächlich besitzt.
 *
 * `pv`/`storage`/`grid` kommen aus `defaultRole(category, channel)`;
 * `consumer` verlangt zusätzlich, dass das Gerät WIRKLICH schaltbar ist
 * (`on_off`) — genau die Bedingung, die die Vorlagen im `resolve()` prüfen.
 */
export function plantRoles(plant: PlantModel): Set<TemplateRole> {
  const roles = new Set<TemplateRole>();
  const categories = new Map<string, string>();
  for (const t of plant.topology?.entities ?? []) categories.set(t.id, t.category);

  for (const e of plant.entities ?? []) {
    const category = categories.get(e.id) || inferCategory(e);
    for (const channel of e.measure ?? []) {
      // Der Typ entscheidet mit: ein Ladepunkt ist Kategorie `consumer`, sein
      // `soc_pct` gehört aber dem AUTO und darf hier nie „storage" belegen.
      const role = defaultRole(e.entityType ?? '', category, channel, '');
      if (role === 'pv' || role === 'storage' || role === 'grid') roles.add(role);
    }
    if (category === 'consumer' && (e.actuate ?? []).includes('on_off')) roles.add('consumer');
  }
  return roles;
}

/** Welche der geforderten Rollen die Anlage NICHT hat (in Deklarations-Reihenfolge). */
export function missingRoles(
  template: Pick<CustomerTemplateDef, 'requiresRoles'>,
  plant: PlantModel | Set<TemplateRole>,
): TemplateRole[] {
  const have = plant instanceof Set ? plant : plantRoles(plant);
  return (template.requiresRoles ?? []).filter((r) => !have.has(r));
}

/** Passt die Vorlage zu dieser Anlage? */
export function fitsPlant(
  template: Pick<CustomerTemplateDef, 'requiresRoles'>,
  plant: PlantModel | Set<TemplateRole>,
): boolean {
  return missingRoles(template, plant).length === 0;
}

/** Der ehrliche Satz, warum eine Vorlage nicht passt; null wenn sie passt. */
export function missingReason(
  template: Pick<CustomerTemplateDef, 'requiresRoles'>,
  plant: PlantModel | Set<TemplateRole>,
): string | null {
  const missing = missingRoles(template, plant);
  if (missing.length === 0) return null;
  const words = missing.map((r) => MISSING_LABEL[r]);
  const list = words.length > 1
    ? `${words.slice(0, -1).join(', ')} und ${words[words.length - 1]}`
    : words[0];
  return `Dafür fehlt Ihrer Anlage noch ${list}.`;
}

/**
 * Alles, was der Filter von einem Angebot braucht: seine Rollen-Voraussetzung.
 * Bewusst STRUKTURELL statt auf `CustomerTemplateDef` festgenagelt — seit dem
 * Einheitsmodell (Stufe 5a) benutzt die REZEPT-Galerie denselben Filter, und
 * zwei Kopien derselben Ausblend-Regel wären zwei Wahrheiten.
 */
export type FilterableOffer = Pick<CustomerTemplateDef, 'requiresRoles'>;

export interface NotFittingTemplate<T extends FilterableOffer = CustomerTemplateDef> {
  template: T;
  /** Was fehlt — die Zeile, die an der eingeblendeten Karte steht. */
  reason: string;
}

export interface TemplatePartition<T extends FilterableOffer = CustomerTemplateDef> {
  fitting: T[];
  notFitting: NotFittingTemplate<T>[];
}

/** Vorlagen/Rezepte in „passt" und „passt (noch) nicht" trennen. */
export function partition<T extends FilterableOffer>(
  templates: T[],
  plant: PlantModel,
): TemplatePartition<T> {
  const have = plantRoles(plant);
  const fitting: T[] = [];
  const notFitting: NotFittingTemplate<T>[] = [];
  for (const template of templates ?? []) {
    const reason = missingReason(template, have);
    if (reason == null) fitting.push(template);
    else notFitting.push({ template, reason });
  }
  return { fitting, notFitting };
}

/**
 * Der Wortlaut der gezählten Aufklapp-Zeile. Bewusst ganze SÄTZE statt eines
 * eingesetzten Substantivs: „1 weitere Vorlage" und „1 weiteres Rezept" haben
 * verschiedene Artikel, ein Satzbaukasten würde also falsches Deutsch erzeugen.
 */
export interface DisclosureWorte {
  eins: string;
  viele: (n: number) => string;
}

const VORLAGEN_WORTE: DisclosureWorte = {
  eins: '1 weitere Vorlage passt nicht zu Ihrer Anlage',
  viele: (n) => `${n} weitere Vorlagen passen nicht zu Ihrer Anlage`,
};

/**
 * Die gezählte Aufklapp-Zeile („2 weitere passen nicht zu Ihrer Anlage").
 * Null, wenn alles passt — dann gibt es nichts zu verstecken. Der Wortlaut ist
 * überschreibbar, damit die Rezept-Galerie dieselbe Regel mit ihrem eigenen
 * Wort benutzen kann.
 */
export function hiddenDisclosure<T extends FilterableOffer>(
  part: TemplatePartition<T>,
  worte: DisclosureWorte = VORLAGEN_WORTE,
): string | null {
  const n = part.notFitting.length;
  if (n === 0) return null;
  return n === 1 ? worte.eins : worte.viele(n);
}

/**
 * Audit A-2: der EINE Grund, wenn ALLE ausgeblendeten Vorlagen am selben Ding
 * scheitern — damit der eingeklappte Leer-Zustand ihn nennen kann, statt ihn
 * einen Klick tief im Aufklapper zu verstecken. Null, wenn nichts fehlt oder
 * die Gründe sich unterscheiden (dann bleibt der Aufklapper die Wahrheit).
 */
export function sharedReason<T extends FilterableOffer>(
  part: TemplatePartition<T>,
): string | null {
  if (part.notFitting.length === 0) return null;
  const first = part.notFitting[0].reason;
  return part.notFitting.every((n) => n.reason === first) ? first : null;
}
