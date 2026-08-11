import { describe, expect, it } from 'vitest';
import { buildGuidedFlow, parseGuidedFlow, type GuidedRule } from '../flows/guidedBuilder';
import type { EditorEntity } from '../flows/model';
import {
  nachweisAbschnitt,
  probelaufZeile,
  regelDetail,
  versionenZeile,
} from './detail';
import { flowKarte, rezeptKarte, VERLAUF_NOCH_NICHT, type RezeptRegelInput } from './zustand';
import type { Consumer } from '../consumers/types';

const ENTITIES: EditorEntity[] = [
  { id: 'e-grid', entityType: 'grid-meter', label: 'Netzanschluss', measure: ['power_kw'], actuate: [] },
  { id: 'e-wb', entityType: 'wallbox', label: 'Wallbox Garage', measure: ['power_kw'], actuate: ['on_off'] },
];

const REGEL: GuidedRule = {
  conditions: [
    { kind: 'entity', entityId: 'e-grid', channel: 'power_kw', direction: 'below', threshold: -3.5 },
  ],
  combinator: 'and',
  action: { kind: 'onoff', entityId: 'e-wb', ttlS: 300 },
};

const DOC = buildGuidedFlow(REGEL, 'Wallbox nur bei PV-Überschuss', 's-1');

function flowKarteFixture() {
  return flowKarte({
    flowId: 'f-1',
    name: 'Wallbox nur bei PV-Überschuss',
    activeVersion: 3,
    latestVersion: 3,
    latestLifecycle: 'active',
    latestDocument: DOC,
  }, ENTITIES);
}

function consumer(over: Partial<Consumer> = {}): Consumer {
  return {
    id: 'c-rod', type: 'heating-rod', typeLabel: 'Heizstab', name: 'Heizstab Keller',
    controlKind: 'on_off', ratedPowerKw: 4, minPowerKw: null, levelsKw: null,
    resolutionKw: null, powerRangesKw: null, storageRelation: 'consumer_first',
    defaultGridEnergyPolicy: 'allow', allowStorageDischarge: false, failsafe: 'off',
    enabled: true, version: 1, connection: 'connected', edgeSourceId: 's',
    controlActivation: 'active', hasDraftPolicy: true, draftPolicyVersion: 1, ...over,
  };
}

function rezeptFixture(over: Partial<RezeptRegelInput> = {}) {
  return rezeptKarte({
    consumer: consumer(),
    anyStatusReported: false,
    satz: 'Täglich von 11:00 bis 15:00 Uhr schaltet VoltPilot Heizstab Keller ein.',
    ...over,
  });
}

describe('Der Detail-Einschub (5b.5)', () => {
  it('zerlegt eine Baukasten-Regel in WENN/DANN und nennt die IMMER-Zeile', () => {
    const v = regelDetail({
      karte: flowKarteFixture(),
      entities: ENTITIES,
      rule: parseGuidedFlow(DOC),
    });
    expect(v.wenn).toHaveLength(1);
    expect(v.wenn[0]).toContain('Netzanschluss');
    expect(v.dann).toBe('Schaltet VoltPilot Wallbox Garage ein');
    expect(v.ersatz).toBeNull();
    expect(v.immer).toContain('Geräteschutz');
    expect(v.bearbeiten).toBe('Bearbeiten (Baukasten)');
  });

  it('behauptet bei einer Editor-Regel nichts und führt in den Editor zurück', () => {
    const karte = flowKarte({
      flowId: 'f-2', name: 'Eigenbau', activeVersion: null, latestVersion: 1,
      latestLifecycle: 'draft',
      latestDocument: { ...DOC, nodes: [...DOC.nodes, { id: 'x', type: 'vp.logic.and', type_version: '1.0.0' }] },
    }, ENTITIES);
    const v = regelDetail({ karte, entities: ENTITIES, rule: null });
    expect(v.wenn).toEqual([]);
    expect(v.dann).toBeNull();
    expect(v.ersatz).toContain('Bausteine');
    expect(v.bearbeiten).toBe('Im Editor öffnen');
  });

  it('eine Rezept-Regel trägt ihren EINEN Satz statt WENN/DANN', () => {
    const v = regelDetail({ karte: rezeptFixture(), entities: ENTITIES });
    expect(v.wenn).toEqual([
      'Täglich von 11:00 bis 15:00 Uhr schaltet VoltPilot Heizstab Keller ein.',
    ]);
    expect(v.dann).toBeNull();
    expect(v.bearbeiten).toBe('Regel bearbeiten');
    // Verbraucher-Regeln sind eigenständig versioniert - hier wird keine
    // Flow-Version behauptet.
    expect(v.versionen).toBeNull();
  });
});

describe('Der Verlauf ist in dieser Stufe ehrlich leer', () => {
  it('nennt den Abschnitt, zeigt aber keine erfundene Zeile', () => {
    const v = regelDetail({ karte: flowKarteFixture(), entities: ENTITIES, rule: parseGuidedFlow(DOC) });
    expect(v.verlauf.titel).toBe('Verlauf dieser Regel');
    expect(v.verlauf.zeilen).toEqual([]);
    expect(v.verlauf.note).toBe(VERLAUF_NOCH_NICHT);
    expect(JSON.stringify(v.verlauf)).not.toMatch(/× geschaltet|\d\d:\d\d/);
  });
});

describe('Simulation und Nachweis sind getrennt (5b.5)', () => {
  it('nennt das Jahres-Ergebnis einer durchgerechneten Flow-Regel', () => {
    const zeile = probelaufZeile({
      simulationId: 's', scenario: 'voltpilot', finishedAt: '2026-08-08T10:00:00Z',
      headline: { voltpilotVorteilNettoEur: 62 },
    });
    expect(zeile).toContain('+62,00');
    expect(zeile).toContain('ohne diese Regel');
  });

  it('behauptet OHNE Probelauf keine Zahl, sondern sagt es', () => {
    expect(probelaufZeile(null)).toBeNull();
    expect(probelaufZeile({
      simulationId: 's', scenario: 'voltpilot', finishedAt: 'x', headline: {},
    })).toBeNull();
    const a = nachweisAbschnitt({ karte: flowKarteFixture(), entities: ENTITIES });
    expect(a.zeilen).toEqual([]);
    expect(a.note).toContain('noch nicht durchgerechnet');
  });

  it('ein negatives Ergebnis wird als solches gezeigt, nie geschönt', () => {
    const zeile = probelaufZeile({
      simulationId: 's', scenario: 'voltpilot', finishedAt: 'x',
      headline: { voltpilotVorteilNettoEur: -12.5 },
    });
    expect(zeile).toContain('−12,50');
  });

  it('eine Rezept-Regel zeigt den ERFÜLLUNGS-Nachweis mit seiner Ehrlichkeitsstufe', () => {
    const a = nachweisAbschnitt({
      karte: rezeptFixture(),
      entities: ENTITIES,
      fulfilment: {
        tasks: [{
          requirementId: 'r-1', periodStart: 'a', deadline: 'b',
          requiredEnergyKwh: 4, actualEnergyKwh: 2.1,
          energyConfirmation: 'assumed', state: 'running', atRisk: false,
        }],
      },
    });
    expect(a.titel).toBe('Erfüllungs-Nachweis');
    expect(a.zeilen[1]).toContain('2,1 / 4,0 kWh');
    expect(a.zeilen[1]).toContain('angenommen');
    expect(a.note).toContain('nie behauptet');
  });

  it('eine Rezept-Regel ohne Aufgaben sagt, dass es noch keinen Nachweis gibt', () => {
    const a = nachweisAbschnitt({ karte: rezeptFixture(), entities: ENTITIES });
    expect(a.zeilen).toEqual([]);
    expect(a.note).toContain('noch kein Nachweis');
  });
});

describe('Versionen', () => {
  it('markiert die aktive und sortiert neueste zuerst', () => {
    expect(versionenZeile([1, 3, 2], 3)).toBe('v3 aktiv · v2 · v1');
  });

  it('ohne Versionen wird nichts behauptet', () => {
    expect(versionenZeile([], 1)).toBeNull();
    expect(versionenZeile(null, null)).toBeNull();
  });
});
