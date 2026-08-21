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
    // Switch the single condition to a price condition (leaves the threshold
    // empty). Seit dem Picker-System ist es der Haus-Picker, kein `select`.
    fireEvent.click(screen.getByRole('combobox', { name: 'Art der Bedingung' }));
    fireEvent.click(screen.getByRole('option', { name: /Börsenpreis/ }));
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

/**
 * Audit fixes (2026-07-24 control audit): N-1 (the notification has no delivery
 * channel, so it is not offered to customers), B-1 (a plant with no switchable
 * device is a named dead end, not an enabled button that cannot succeed), B-2
 * (the price lock says why and by whom) and A-3 (the message field is labelled).
 */
describe('GuidedRuleBuilder · audit fixes', () => {
  const NO_TARGETS: EditorEntity[] = [
    { id: 'gm', entityType: 'grid-meter', label: 'Netz', measure: ['power_kw'], actuate: [] },
  ];

  it('N-1: never offers the notification to a customer surface', () => {
    render(<GuidedRuleBuilder entities={ENTITIES} onCancel={() => {}} onBuild={() => {}} siteId="s1" />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Aktion' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Gerät ein/aus',
      'Sollwert setzen',
    ]);
  });

  it('N-1: the technical layer keeps it, labelled as diagnosis only', () => {
    render(
      <GuidedRuleBuilder
        entities={ENTITIES}
        onCancel={() => {}}
        onBuild={() => {}}
        siteId="s1"
        allowDiagnosticActions
      />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Aktion' }));
    fireEvent.click(screen.getByRole('option', { name: /Benachrichtigung/ }));
    // A-3: a real label, not a placeholder that vanishes while typing.
    expect(screen.getByLabelText('Nachricht')).toBeInTheDocument();
    // ...and the honest note that nothing is delivered yet.
    expect(document.body.textContent).toMatch(/noch nicht zugestellt/);
  });

  it('B-1: names the dead end instead of offering an impossible button', () => {
    const onBuild = vi.fn();
    render(<GuidedRuleBuilder entities={NO_TARGETS} onCancel={() => {}} onBuild={onBuild} siteId="s1" />);

    expect(screen.queryByRole('button', { name: /Weiter zur Prüfung/ })).toBeNull();
    expect(document.body.textContent).toMatch(/kein schaltbares Gerät/);
    // A real next step, into the page where a device is assigned.
    const link = screen.getByRole('link', { name: /Anlagen-Modell/ });
    expect(link.getAttribute('href')).toBe('#/anlage/s1/modell');
    expect(onBuild).not.toHaveBeenCalled();
  });

  it('B-1: the technical layer still builds a diagnostic rule without a device', () => {
    const onBuild = vi.fn<(name: string, doc: FlowDocument) => void>();
    render(
      <GuidedRuleBuilder
        entities={NO_TARGETS}
        onCancel={() => {}}
        onBuild={onBuild}
        siteId="s1"
        allowDiagnosticActions
      />,
    );
    // The action that needs no device is PRE-SELECTED - no dead end here.
    expect(screen.getByRole('combobox', { name: 'Aktion' }))
      .toHaveTextContent('Benachrichtigung (nur Diagnose)');
    fireEvent.change(screen.getByLabelText('Nachricht'), { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: /Weiter zur Prüfung/ }));
    expect(onBuild).toHaveBeenCalledTimes(1);
  });

  it('⚠ eine GESPERRTE Bedingung bleibt sichtbar und nennt ihren Grund', () => {
    // Das native `<option disabled>` konnte den Grund nur in den Text der
    // Zeile pressen; der Picker trägt ihn als eigene Zeile - und wählen lässt
    // sie sich weiterhin nicht.
    const onBuild = vi.fn();
    render(
      <GuidedRuleBuilder
        entities={ENTITIES}
        onCancel={() => {}}
        onBuild={onBuild}
        siteId="s1"
        lockedKinds={['price']}
      />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Art der Bedingung' }));
    const zeile = screen.getByRole('option', { name: /Börsenpreis/ });
    expect(zeile).toHaveTextContent('Noch nicht freigeschaltet');
    fireEvent.click(zeile);
    // Nicht gewählt: die Bedingung bleibt die vorgewählte (das Zeitfenster).
    expect(screen.getByRole('combobox', { name: 'Art der Bedingung' }))
      .toHaveTextContent('Zeitfenster');
  });

  it('⚠ ein Zeitfenster nimmt eine FREI getippte Uhrzeit an', () => {
    // Das Raster ist ein Vorschlag - eine Regel, die heute 06:07 erlaubt, darf
    // das durch die Umstellung nicht verlieren.
    const onBuild = vi.fn<(name: string, doc: FlowDocument) => void>();
    render(<GuidedRuleBuilder entities={ENTITIES} onCancel={() => {}} onBuild={onBuild} siteId="s1" />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Art der Bedingung' }));
    fireEvent.click(screen.getByRole('option', { name: 'Zeitfenster' }));
    const von = screen.getByRole('combobox', { name: 'Von' });
    fireEvent.change(von, { target: { value: '607' } });
    fireEvent.blur(von);
    expect((von as HTMLInputElement).value).toBe('06:07');
  });

  it('B-2: says why the price condition is locked and by whom', () => {
    render(
      <GuidedRuleBuilder
        entities={ENTITIES}
        onCancel={() => {}}
        onBuild={() => {}}
        siteId="s1"
        lockedKinds={['price']}
      />,
    );
    // The lock is explained where it can be READ - not inside the branch that
    // only renders for the very option the lock makes unselectable.
    expect(document.body.textContent).toMatch(/mit der Marktoptimierung freigeschaltet/);
    expect(document.body.textContent).not.toMatch(/\(gesperrt\)/);
  });
});
