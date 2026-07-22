/**
 * Portal v3 M5 Part C. The load-bearing rule is the FALLBACK: without the
 * device's feature-flagged node-status block the editor shows channel values
 * only and NO node state - a guessed state would read to the customer as proof
 * their rule fired.
 */
import { describe, expect, it } from 'vitest';
import { chipText, liveValues, nodeStateView, readChannelOf } from './liveValues';
import type { FlowDocument } from './model';

const DOC: FlowDocument = {
  schema_version: '1.0',
  name: 'Test',
  runtime: 'edge',
  nodes: [
    {
      id: 'lesen1',
      type: 'vp.entity.read',
      type_version: '1.0.0',
      parameters: { entity_id: 'netz1', channel: 'power_kw' },
    },
    {
      id: 'soc1',
      type: 'vp.entity.read',
      type_version: '1.0.0',
      parameters: { entity_id: 'batt1', channel: 'soc_pct' },
    },
    { id: 'schwelle1', type: 'vp.logic.threshold', type_version: '1.1.0', parameters: {} },
  ],
  edges: [
    { id: 'e1', from: { node: 'lesen1', port: 'value' }, to: { node: 'schwelle1', port: 'input' } },
    { id: 'e2', from: { node: 'soc1', port: 'value' }, to: { node: 'schwelle1', port: 'input' } },
  ],
  triggers: [{ id: 't1', kind: 'interval', every_s: 60 }],
};

describe('liveValues', () => {
  it('puts a channel chip on the wires leaving a data node', () => {
    const view = liveValues({
      doc: DOC,
      channels: [
        { entityId: 'netz1', channel: 'power_kw', value: 2.94 },
        { entityId: 'batt1', channel: 'soc_pct', value: 76 },
      ],
    });
    expect(view.chips.e1).toBe(chipText('power_kw', 2.94));
    expect(view.chips.e1).toMatch(/2,9/);
    expect(view.chips.e1).toMatch(/kW$/);
    expect(view.chips.e2).toMatch(/^76.*%$/);
  });

  it('shows "—" for a known channel without a reading, and NO chip without a source', () => {
    const view = liveValues({
      doc: DOC,
      channels: [{ entityId: 'netz1', channel: 'power_kw', value: null }],
    });
    expect(view.chips.e1).toBe('—');
    expect(view.chips.e2).toBeUndefined(); // no source at all -> no chip
  });

  it('shows NO node state when the device does not report one', () => {
    const noBlock = liveValues({ doc: DOC, channels: [] });
    expect(noBlock.nodeStates).toEqual({});
    expect(noBlock.hasNodeStates).toBe(false);

    const emptyBlock = liveValues({ doc: DOC, statuses: [] });
    expect(emptyBlock.nodeStates).toEqual({});
    expect(emptyBlock.hasNodeStates).toBe(false);
  });

  it('renders exactly the states the device reported, for known nodes only', () => {
    const view = liveValues({
      doc: DOC,
      statuses: [
        { nodeId: 'schwelle1', state: 'active', text: 'erfüllt' },
        { nodeId: 'geloescht', state: 'active' },
      ],
    });
    expect(Object.keys(view.nodeStates)).toEqual(['schwelle1']);
    expect(view.nodeStates.schwelle1).toEqual({ label: 'erfüllt', tone: 'ok' });
    expect(view.hasNodeStates).toBe(true);
  });
});

describe('nodeStateView', () => {
  const now = new Date('2026-07-22T15:00:00Z');

  it('appends a since-time when the device sent one', () => {
    const at = new Date('2026-07-22T12:02:00Z');
    const view = nodeStateView({ nodeId: 'n', state: 'active', text: 'EIN', since: at.toISOString() }, now);
    const hh = String(at.getHours()).padStart(2, '0');
    expect(view.label).toBe(`EIN · seit ${hh}:02`);
    expect(view.tone).toBe('ok');
  });

  it('falls back to plain German words and ignores a nonsense timestamp', () => {
    expect(nodeStateView({ nodeId: 'n', state: 'idle' }, now)).toEqual({ label: 'wartet', tone: 'off' });
    expect(nodeStateView({ nodeId: 'n', state: 'error' }, now)).toEqual({ label: 'Fehler', tone: 'error' });
    expect(nodeStateView({ nodeId: 'n', state: 'active', since: 'kaputt' }, now).label).toBe('erfüllt');
    expect(nodeStateView({ nodeId: 'n', state: 'active', since: '2030-01-01T00:00:00Z' }, now).label)
      .toBe('erfüllt');
  });
});

describe('readChannelOf', () => {
  it('only data nodes with a complete mapping read a channel', () => {
    expect(readChannelOf(DOC.nodes[0])).toEqual({ entityId: 'netz1', channel: 'power_kw' });
    expect(readChannelOf(DOC.nodes[2])).toBeNull();
    expect(readChannelOf({ type: 'vp.entity.read', parameters: { entity_id: 'x' } })).toBeNull();
    expect(readChannelOf({
      type: 'vp.modbus.read', parameters: { entity_id: 'x', channel: 'druck' },
    })).toEqual({ entityId: 'x', channel: 'druck' });
  });
});
