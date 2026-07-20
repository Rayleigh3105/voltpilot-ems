import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GuidedRuleBuilder } from './GuidedRuleBuilder';
import type { EditorEntity, FlowDocument } from '../flows/model';
import { isValid, validateFlow } from '../flows/validate';
import { parseGuidedFlow } from '../flows/guidedBuilder';

const ENTITIES: EditorEntity[] = [
  { id: 'wb', entityType: 'wallbox', label: 'Wallbox', measure: ['power_kw'], actuate: ['on_off', 'setpoint_kw'] },
  { id: 'gm', entityType: 'grid-meter', label: 'Netz', measure: ['power_kw'], actuate: [] },
];

describe('GuidedRuleBuilder', () => {
  it('builds a valid, builder-openable document from the default schedule rule', () => {
    const onBuild = vi.fn<(name: string, doc: FlowDocument) => void>();
    render(<GuidedRuleBuilder entities={ENTITIES} onCancel={() => {}} onBuild={onBuild} siteId="s1" />);

    fireEvent.click(screen.getByRole('button', { name: /Weiter zur Prüfung/ }));

    expect(onBuild).toHaveBeenCalledTimes(1);
    const [, doc] = onBuild.mock.calls[0];
    expect(isValid(validateFlow(doc, ENTITIES))).toBe(true);
    const rule = parseGuidedFlow(doc);
    expect(rule).not.toBeNull();
    expect(rule!.conditions[0].kind).toBe('schedule');
    expect(rule!.action).toEqual({ kind: 'onoff', entityId: 'wb', ttlS: 300 });
  });

  it('reports an honest error when a price condition has no threshold', () => {
    const onBuild = vi.fn();
    render(<GuidedRuleBuilder entities={ENTITIES} onCancel={() => {}} onBuild={onBuild} siteId="s1" />);
    // Switch the single condition to a price condition (leaves the threshold empty).
    fireEvent.change(screen.getByLabelText('Art der Bedingung'), { target: { value: 'price' } });
    fireEvent.click(screen.getByRole('button', { name: /Weiter zur Prüfung/ }));
    expect(onBuild).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toMatch(/vollständig ausfüllen/);
  });

  it('adds a second condition and builds a compound rule', () => {
    const onBuild = vi.fn<(name: string, doc: FlowDocument) => void>();
    render(<GuidedRuleBuilder entities={ENTITIES} onCancel={() => {}} onBuild={onBuild} siteId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /Bedingung/ }));
    // The second condition defaults to an entity condition; give it a threshold.
    const thresholds = screen.getAllByLabelText('Schwelle');
    fireEvent.change(thresholds[thresholds.length - 1], { target: { value: '-2' } });
    fireEvent.click(screen.getByRole('button', { name: /Weiter zur Prüfung/ }));

    expect(onBuild).toHaveBeenCalledTimes(1);
    const [, doc] = onBuild.mock.calls[0];
    expect(isValid(validateFlow(doc, ENTITIES))).toBe(true);
    const rule = parseGuidedFlow(doc);
    expect(rule!.conditions).toHaveLength(2);
    // The AND combinator node is present in the emitted graph.
    expect(doc.nodes.some((n) => n.type === 'vp.logic.and')).toBe(true);
  });
});
