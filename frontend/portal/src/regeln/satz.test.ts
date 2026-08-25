import { describe, expect, it } from 'vitest';
import { buildGuidedFlow, type GuidedRule } from '../flows/guidedBuilder';
import type { EditorEntity } from '../flows/model';
import {
  aktionSatz,
  bedingungSatz,
  dannZeile,
  flowSatz,
  guidedSatz,
  IMMER_ZEILE,
  wennZeilen,
} from './satz';

const ENTITIES: EditorEntity[] = [
  { id: 'e-grid', entityType: 'grid-meter', label: 'Netzanschluss', measure: ['power_kw'], actuate: [] },
  { id: 'e-batt', entityType: 'battery-hybrid', label: 'Speicher', measure: ['soc_pct'], actuate: ['setpoint_kw'] },
  { id: 'e-wb', entityType: 'wallbox', label: 'Wallbox Garage', measure: ['power_kw'], actuate: ['on_off'] },
];

const PV_REGEL: GuidedRule = {
  conditions: [
    { kind: 'entity', entityId: 'e-grid', channel: 'power_kw', direction: 'below', threshold: -3.5, hysteresis: 0.5 },
  ],
  combinator: 'and',
  action: { kind: 'onoff', entityId: 'e-wb', ttlS: 300 },
};

describe('Der Regel-Satz (5b.3)', () => {
  it('macht aus einer Baukasten-Regel EINEN lesbaren Satz', () => {
    expect(guidedSatz(PV_REGEL, ENTITIES)).toBe(
      'Wenn Leistung von Netzanschluss unter -3,5 kW liegt, '
      + 'schaltet VoltPilot Wallbox Garage ein.',
    );
  });

  it('verbindet mehrere Bedingungen mit dem gewählten Wort', () => {
    const rule: GuidedRule = {
      ...PV_REGEL,
      conditions: [
        PV_REGEL.conditions[0],
        { kind: 'schedule', from: '11:00', to: '15:00', days: 'werktage' },
      ],
      combinator: 'or',
    };
    expect(guidedSatz(rule, ENTITIES)).toContain(' oder es an Werktagen zwischen 11:00 und 15:00 Uhr ist,');
  });

  it('benennt den Börsenpreis und den Ladestand in Kundendeutsch', () => {
    expect(bedingungSatz({ kind: 'price', direction: 'below', threshold: 5 }, ENTITIES))
      .toBe('der Börsenpreis unter 5 ct/kWh liegt');
    expect(bedingungSatz(
      { kind: 'entity', entityId: 'e-batt', channel: 'soc_pct', direction: 'above', threshold: 25 },
      ENTITIES,
    )).toBe('Ladestand von Speicher über 25 % liegt');
  });

  it('ein PV-Kanal wird benannt, ein unbekannter Kanal bleibt roh (offenes Vokabular)', () => {
    expect(bedingungSatz(
      { kind: 'entity', entityId: 'e-grid', channel: 'pv_power_kw', direction: 'above', threshold: 3 },
      ENTITIES,
    )).toContain('PV-Leistung von Netzanschluss');
    expect(bedingungSatz(
      { kind: 'entity', entityId: 'e-grid', channel: 'kessel_temp', direction: 'above', threshold: 60 },
      ENTITIES,
    )).toContain('kessel_temp von Netzanschluss');
  });

  it('nennt eine unbekannte Komponente „Ihr Gerät" statt einer Id', () => {
    const satz = aktionSatz({ kind: 'onoff', entityId: 'weg', ttlS: 300 }, ENTITIES);
    expect(satz).toBe('schaltet VoltPilot Ihr Gerät ein');
    expect(satz).not.toContain('weg');
  });

  it('schreibt den Sollwert und die Benachrichtigung aus', () => {
    expect(aktionSatz({ kind: 'setpoint', entityId: 'e-batt', value: 4.5, ttlS: 300 }, ENTITIES))
      .toBe('stellt VoltPilot Speicher auf 4,5 kW');
    expect(aktionSatz({ kind: 'notify', message: 'Speicher leer' }, ENTITIES))
      .toBe('meldet VoltPilot: „Speicher leer“');
  });

  it('zerlegt die Regel für den Einschub in WENN-Zeilen und EINE DANN-Zeile', () => {
    const rule: GuidedRule = {
      ...PV_REGEL,
      conditions: [PV_REGEL.conditions[0], { kind: 'price', direction: 'below', threshold: 5 }],
      combinator: 'and',
    };
    const wenn = wennZeilen(rule, ENTITIES);
    expect(wenn).toHaveLength(2);
    expect(wenn[0].startsWith('Leistung von Netzanschluss')).toBe(true);
    expect(wenn[1].startsWith('und ')).toBe(true);
    expect(dannZeile(rule, ENTITIES)).toBe('Schaltet VoltPilot Wallbox Garage ein');
  });

  it('leitet den Satz aus dem echten Dokument ab (Roundtrip über den Emitter)', () => {
    const doc = buildGuidedFlow(PV_REGEL, 'Wallbox nur bei PV-Überschuss', 's-1');
    const out = flowSatz(doc, ENTITIES);
    expect(out.rule).not.toBeNull();
    expect(out.satz).toBe(guidedSatz(PV_REGEL, ENTITIES));
  });

  it('behauptet bei einer Editor-Regel NICHTS und zählt stattdessen die Bausteine', () => {
    const doc = buildGuidedFlow(PV_REGEL, 'x', 's-1');
    // Ein Fremd-Knoten macht das Dokument reicher als der Baukasten-Ausschnitt.
    const reicher = {
      ...doc,
      nodes: [...doc.nodes, { id: 'extra', type: 'vp.logic.and', type_version: '1.0.0' }],
    };
    const out = flowSatz(reicher, ENTITIES);
    expect(out.satz).toBeNull();
    expect(out.rule).toBeNull();
    expect(out.ersatz).toBe(`Eigene Regel · ${reicher.nodes.length} Bausteine`);
  });

  it('zählt einen einzelnen Baustein im Singular und verträgt ein fehlendes Dokument', () => {
    expect(flowSatz(null, ENTITIES).ersatz).toBe('Eigene Regel · 0 Bausteine');
    const eins = {
      schema_version: '1.0' as const,
      name: 'x',
      runtime: 'edge' as const,
      nodes: [{ id: 'n1', type: 'vp.entity.read', type_version: '1.0.0' }],
      edges: [],
      triggers: [],
    };
    expect(flowSatz(eins, ENTITIES).ersatz).toBe('Eigene Regel · 1 Baustein');
  });

  it('die IMMER-Zeile nennt, was KEINE Regel aushebelt — ohne einen Live-Zustand', () => {
    expect(IMMER_ZEILE).toContain('Geräteschutz');
    expect(IMMER_ZEILE).toContain('Netzvorgaben');
    expect(IMMER_ZEILE).not.toMatch(/gerade|jetzt/i);
    // Steuerung Stufe 2: der Fahrplan-Vorrang steht NICHT mehr hier — er gilt
    // nicht für jede Regel gleich (siehe VORRANG_ZEILE).
    expect(IMMER_ZEILE).not.toContain('Fahrplan');
  });
});
