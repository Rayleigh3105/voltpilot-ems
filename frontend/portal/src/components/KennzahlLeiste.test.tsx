import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { KennzahlLeiste } from './KennzahlLeiste';
import type { KennzahlZelle } from '../kennzahl';

/**
 * Die geteilte Kennzahlen-Leiste (Portfolio Revision 2 §5.4).
 *
 * Sie ist render-only, also prüft dieser Test genau das, was sie SELBST
 * entscheidet: dass die Spaltenzahl der Zahl der SPRECHENDEN Zellen folgt,
 * dass die Einheit ein eigenes leises Feld bleibt und dass eine leere Leiste
 * gar nicht erst erscheint.
 */

function zelle(over: Partial<KennzahlZelle> & { id: string }): KennzahlZelle {
  return { label: over.id, wert: '1', einheit: null, unterzeile: null, ...over };
}

function leiste(zellen: KennzahlZelle[]) {
  const { container } = render(<KennzahlLeiste zellen={zellen} label="Kennzahlen" />);
  return container.querySelector('.vp-leiste') as HTMLElement | null;
}

describe('KennzahlLeiste', () => {
  it('rendert GAR NICHTS, solange keine Zelle etwas zu sagen hat', () => {
    // Eine leere Leiste wäre ein Rahmen ohne Inhalt - die Fläche sagt dann
    // ihren Ruhe-Satz, nicht ein leeres Gitter.
    expect(leiste([])).toBeNull();
  });

  it('setzt die Spaltenzahl auf die Zahl der WIRKLICH sprechenden Zellen', () => {
    // Eine feste Spaltenzahl liesse eine Flotte ohne Geld-Modus mit einer
    // Lücke rendern - genau die Waise, gegen die die Leiste gebaut ist.
    const el = leiste([zelle({ id: 'a' }), zelle({ id: 'b' }), zelle({ id: 'c' })])!;
    expect(el.style.getPropertyValue('--vp-leiste-cols')).toBe('3');
  });

  it('hält die Einheit als EIGENES, leises Feld neben der Zahl', () => {
    const el = leiste([zelle({ id: 'pv', label: 'PV jetzt', wert: '41,2', einheit: 'kW' })])!;
    expect(within(el).getByText('41,2')).toBeTruthy();
    const einheit = el.querySelector('.vp-leiste-einheit')!;
    expect(einheit.textContent).toBe('kW');
  });

  it('hebt GENAU die Leit-Zelle hervor', () => {
    const el = leiste([zelle({ id: 'a', lead: true }), zelle({ id: 'b' })])!;
    expect(el.querySelectorAll('.vp-leiste-zelle.is-lead')).toHaveLength(1);
  });

  it('gibt einer ungeraden LETZTEN Zelle am Telefon die volle Breite', () => {
    // Auch am Telefon (zwei Spalten) darf keine Waise entstehen.
    const el = leiste([zelle({ id: 'a' }), zelle({ id: 'b' }), zelle({ id: 'c' })])!;
    const zellen = [...el.querySelectorAll('.vp-leiste-zelle')];
    expect(zellen[2].className).toContain('is-voll');
    expect(zellen[0].className).not.toContain('is-voll');
  });

  it('tönt NUR die Unterzeile - die Zahl bleibt in jeder Lage die Marken-Tinte', () => {
    // Ein Vorbehalt („2 von 3 Anlagen melden gerade") ist keine Störung.
    const el = leiste([
      zelle({ id: 'pv', wert: '41,2', unterzeile: '1 von 3 Anlagen melden gerade', ton: 'warn' }),
    ])!;
    expect(el.querySelector('.vp-leiste-sub.is-warn')).toBeTruthy();
    expect(el.querySelector('.vp-leiste-wert')!.className).not.toContain('warn');
  });

  it('ist eine benannte GRUPPE, keine Liste', () => {
    render(<KennzahlLeiste zellen={[zelle({ id: 'a' })]} label="Kennzahlen Ihrer Anlagen" />);
    expect(screen.getByRole('group', { name: 'Kennzahlen Ihrer Anlagen' })).toBeTruthy();
  });
});
