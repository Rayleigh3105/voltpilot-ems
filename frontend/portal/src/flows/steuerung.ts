/**
 * U3: the "Strategie vs Automation" split is PRESENTATION only - one FlowDocument,
 * one validator, one compiler, one lifecycle. A flow is a "Strategie" when its
 * graph carries a strategy node (group === 'strategie'); everything else is an
 * "Automation" (Node-RED-style device/logic rules). Pure + unit-tested
 * (steuerung.test.ts); the report §4.6 "mode-tab classification" rule
 * (strategy presence wins) lives here.
 */
import { catalogType, type CatalogType, type FlowDocument } from './model';

export type SteuerungMode = 'strategie' | 'automation';

/** Does the document carry any strategy node? (strategy presence wins.) */
export function hasStrategyNode(doc: FlowDocument): boolean {
  return doc.nodes.some((n) => catalogType(n.type)?.group === 'strategie');
}

/** The mode a flow is classified under (strategy presence wins). */
export function flowMode(doc: FlowDocument): SteuerungMode {
  return hasStrategyNode(doc) ? 'strategie' : 'automation';
}

export interface ModeMeta {
  key: SteuerungMode;
  label: string;
  /** One plain-German line under the tab. */
  hint: string;
}

export const MODES: ModeMeta[] = [
  {
    key: 'strategie',
    label: 'Strategien',
    hint: 'Fortlaufende Ziele, die VoltPilot mit-optimiert - Markt, Lastspitzen, Eigenverbrauch.',
  },
  {
    key: 'automation',
    label: 'Automationen',
    hint: 'Eigene Wenn/Dann-Regeln für Ihre Geräte - wie in Node-RED, aber geprüft und sicher.',
  },
];

/**
 * The palette pre-filter per mode (U3, report §4.2): Automationen shows
 * daten/logik/aktion (never a strategy node); Strategien shows strategie plus
 * its data feeds + the control action. Both share the daten + aktion groups so
 * a chain can always be completed.
 */
export function paletteFilterFor(mode: SteuerungMode): (type: CatalogType) => boolean {
  if (mode === 'automation') {
    return (type) => type.group !== 'strategie';
  }
  return (type) => type.group === 'strategie' || type.group === 'daten' || type.group === 'aktion';
}
