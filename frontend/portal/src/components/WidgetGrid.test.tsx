import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { WidgetGrid } from './WidgetGrid';
import type { WidgetDef } from '../cockpitWidgets';

/** Portal v3 · M2 — der dünne Render-Beweis des Widget-Rasters. */

function widget(over: Partial<WidgetDef> = {}): WidgetDef {
  return {
    id: 'speicher',
    label: 'Speicher',
    value: '76 %',
    sub: 'lädt',
    accent: 'batt',
    lead: false,
    modal: {
      jetzt: { rows: [], note: null, drillIn: null },
      verlauf: { rows: [], note: null, drillIn: null },
    },
    ...over,
  };
}

describe('WidgetGrid', () => {
  it('rendert eine Kachel je Definition, in gegebener Reihenfolge', () => {
    const { container } = render(
      <WidgetGrid
        widgets={[widget(), widget({ id: 'netz', label: 'Netz', accent: 'grid' })]}
        onOpen={() => {}}
      />,
    );
    const labels = [...container.querySelectorAll('.vp-widget-label')].map((n) => n.textContent);
    expect(labels).toEqual(['Speicher', 'Netz']);
    expect(container.querySelector('.vp-widget-batt')).toBeTruthy();
    expect(container.querySelector('.vp-widget-grid')).toBeTruthy();
  });

  it('rendert gar nichts ohne Kacheln (keine leere Karte)', () => {
    const { container } = render(<WidgetGrid widgets={[]} onOpen={() => {}} />);
    expect(container.querySelector('.vp-widgets')).toBeNull();
  });

  it('markiert die führende Kachel, ohne die Reihenfolge zu ändern', () => {
    const { container } = render(
      <WidgetGrid
        widgets={[widget({ id: 'lastspitze', label: 'Lastspitze', lead: true }), widget()]}
        onOpen={() => {}}
      />,
    );
    const tiles = [...container.querySelectorAll('.vp-widget')];
    expect(tiles[0].className).toContain('is-lead');
    expect(tiles[1].className).not.toContain('is-lead');
  });

  it('meldet die angetippte Kachel', () => {
    const onOpen = vi.fn();
    const w = widget();
    const { container } = render(<WidgetGrid widgets={[w]} onOpen={onOpen} />);
    fireEvent.click(container.querySelector('.vp-widget') as HTMLButtonElement);
    expect(onOpen).toHaveBeenCalledWith(w);
  });
});
