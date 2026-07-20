/**
 * Customer control-flow templates (E3b): ready-made FREE-node flows a Portal-User
 * can start from - "Wallbox nur bei PV-Überschuss" and "Heizstab-Zeitplan",
 * built ONLY from catalog node types (consumer device-control + logic/data
 * nodes), so they carry no gated strategy and activate normally once VoltPilot's
 * activation path is on. Every template resolves against the site's OWN entities
 * (a template needs a controllable consumer; the PV-surplus one also needs the
 * grid meter) and is applyDerivedClaims-stamped, so it validates clean against
 * the client validator the moment it is built. Pure - unit-tested in
 * customerTemplates.test.ts.
 */
import { type EditorEntity, type FlowDocument } from './model';
import { buildGuidedFlow } from './guidedBuilder';

/** The site's controllable on/off consumers (Wallbox / Heizstab / gen. Last). */
export function controllableConsumers(entities: EditorEntity[]): EditorEntity[] {
  return entities.filter(
    (e) => e.entityType !== 'battery-hybrid' && e.actuate.includes('on_off'),
  );
}

/** The site's grid-meter entity (measures the connection-point power). */
export function gridMeterEntity(entities: EditorEntity[]): EditorEntity | null {
  return (
    entities.find((e) => e.entityType === 'grid-meter' && e.measure.includes('power_kw'))
    ?? entities.find((e) => e.measure.includes('power_kw') && e.actuate.length === 0)
    ?? null
  );
}

/**
 * "Wallbox nur bei PV-Überschuss": when the grid meter shows net export beyond a
 * threshold (PV surplus), switch the consumer on. Reads grid power → threshold
 * (below the export limit) → the consumer's on/off. Built through the SHARED
 * guided-builder emitter (buildGuidedFlow), so it is a builder-openable rule and
 * cannot drift from the guided subset. The edge core still arbitrates + clamps
 * the resulting desire (guards, §14a) - a wish, not a forced write.
 */
export function pvSurplusConsumerFlow(
  name: string,
  consumerId: string,
  gridId: string,
  siteId?: string,
): FlowDocument {
  return buildGuidedFlow(
    {
      conditions: [
        { kind: 'entity', entityId: gridId, channel: 'power_kw', direction: 'below', threshold: -2, hysteresis: 0.5 },
      ],
      combinator: 'and',
      action: { kind: 'onoff', entityId: consumerId, ttlS: 300 },
    },
    name,
    siteId,
  );
}

/**
 * "Heizstab-Zeitplan": switch the consumer on inside a daily time window (e.g.
 * midday PV hours). Schedule window → the consumer's on/off. Built through the
 * SHARED guided-builder emitter.
 */
export function scheduleConsumerFlow(
  name: string,
  consumerId: string,
  siteId?: string,
): FlowDocument {
  return buildGuidedFlow(
    {
      conditions: [{ kind: 'schedule', from: '11:00', to: '15:00', days: 'alle' }],
      combinator: 'and',
      action: { kind: 'onoff', entityId: consumerId, ttlS: 600 },
    },
    name,
    siteId,
  );
}

/** A resolved template: either a ready-to-save document, or an honest reason. */
export type TemplateResolution =
  | { doc: FlowDocument; consumerLabel: string }
  | { reason: string };

export interface CustomerTemplateDef {
  id: string;
  name: string;
  /** One plain-German line for the gallery card. */
  description: string;
  /** What the customer needs for this template (shown when it cannot resolve). */
  requires: string;
  /** Build the document from the site's entities, or explain why it cannot. */
  resolve(entities: EditorEntity[], siteId?: string): TemplateResolution;
}

const NO_CONSUMER =
  'Für diese Vorlage braucht Ihre Anlage ein steuerbares Gerät (z. B. Wallbox oder Heizstab).';

export const CUSTOMER_TEMPLATES: CustomerTemplateDef[] = [
  {
    id: 'pv-surplus-consumer',
    name: 'Wallbox nur bei PV-Überschuss',
    description:
      'Schaltet Ihr Gerät ein, sobald überschüssiger Solarstrom ins Netz fließt - '
      + 'so laden Sie bevorzugt mit eigener Sonne.',
    requires: 'ein steuerbares Gerät und einen Netz-Zähler',
    resolve(entities, siteId) {
      const consumer = controllableConsumers(entities)[0];
      if (!consumer) return { reason: NO_CONSUMER };
      const grid = gridMeterEntity(entities);
      if (!grid) {
        return { reason: 'Für diese Vorlage braucht Ihre Anlage einen Netz-Zähler.' };
      }
      return {
        doc: pvSurplusConsumerFlow(this.name, consumer.id, grid.id, siteId),
        consumerLabel: consumer.label,
      };
    },
  },
  {
    id: 'schedule-consumer',
    name: 'Heizstab-Zeitplan',
    description:
      'Schaltet Ihr Gerät in einem festen Zeitfenster ein (z. B. mittags) - '
      + 'die Zeiten passen Sie im Editor an.',
    requires: 'ein steuerbares Gerät',
    resolve(entities, siteId) {
      const consumer = controllableConsumers(entities)[0];
      if (!consumer) return { reason: NO_CONSUMER };
      return {
        doc: scheduleConsumerFlow(this.name, consumer.id, siteId),
        consumerLabel: consumer.label,
      };
    },
  },
];
