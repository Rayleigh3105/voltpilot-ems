import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { WidgetGrid } from './WidgetGrid';
import type { WidgetDef } from '../cockpitWidgets';

/** Portal v3 · M2 — der dünne Render-Beweis des Widget-Rasters (V2: Absprung).
 *  Seit dem Cockpit+Live-Merge (R2) gibt es nur noch Geld-/Modus-Kacheln —
 *  die „Verlauf →"-Andeutung der Fluss-Kacheln ist mit ihnen gegangen. */

function widget(over: Partial<WidgetDef> = {}): WidgetDef {
  return {
    id: 'eigenverbrauch',
    label: 'Eigenverbrauch',
    value: '82 %',
    sub: 'Autarkie heute',
    accent: 'batt',
    lead: false,
    target: { kind: 'sub', sub: 'historie' },
    ...over,
  };
}

describe('WidgetGrid', () => {
  it('rendert eine Kachel je Definition, in gegebener Reihenfolge', () => {
    const { container } = render(
      <WidgetGrid
        widgets={[widget(), widget({ id: 'handel', label: 'Handel', accent: 'grid' })]}
        onSelect={() => {}}
      />,
    );
    const labels = [...container.querySelectorAll('.vp-widget-label')].map((n) => n.textContent);
    expect(labels).toEqual(['Eigenverbrauch', 'Handel']);
    expect(container.querySelector('.vp-widget-batt')).toBeTruthy();
    expect(container.querySelector('.vp-widget-grid')).toBeTruthy();
  });

  it('rendert gar nichts ohne Kacheln (keine leere Karte)', () => {
    const { container } = render(<WidgetGrid widgets={[]} onSelect={() => {}} />);
    expect(container.querySelector('.vp-widgets')).toBeNull();
  });

  it('markiert die führende Kachel, ohne die Reihenfolge zu ändern', () => {
    const { container } = render(
      <WidgetGrid
        widgets={[widget({ id: 'lastspitze', label: 'Lastspitze', lead: true }), widget()]}
        onSelect={() => {}}
      />,
    );
    const tiles = [...container.querySelectorAll('.vp-widget')];
    expect(tiles[0].className).toContain('is-lead');
    expect(tiles[1].className).not.toContain('is-lead');
  });

  it('meldet die angetippte Kachel', () => {
    const onSelect = vi.fn();
    const w = widget();
    const { container } = render(<WidgetGrid widgets={[w]} onSelect={onSelect} />);
    fireEvent.click(container.querySelector('.vp-widget') as HTMLButtonElement);
    expect(onSelect).toHaveBeenCalledWith(w);
  });

  it('trägt keine „Verlauf →"-Andeutung mehr (das Board ist die Live-Fläche)', () => {
    const { container } = render(
      <WidgetGrid
        widgets={[
          widget(),
          widget({ id: 'wetter', label: 'Wetter', accent: 'pv', target: { kind: 'sub', sub: 'wetter' } }),
        ]}
        onSelect={() => {}}
      />,
    );
    expect(container.querySelector('.vp-widget-jump')).toBeNull();
  });
});
