import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RollenBreakdown } from './RollenBreakdown';
import type { RollenKanonischerWert } from '../api';

afterEach(cleanup);
const wert = (role: string): RollenKanonischerWert => ({ role, wert: -3.5, einheit: 'kW', zuordnung_vorhanden: true,
  unvollstaendig: true, stand: '2026-09-16T10:15:00+02:00', geraete: [
    { entity_id: 'a', name: 'Zähler Halle 1', art: 'gesamtwert', wert: -3.5, liefernd: true, grund: null },
    { entity_id: 'b', name: 'Zähler Halle 2', art: 'messkanal', wert: null, liefernd: false, grund: 'veraltet' },
  ] });
describe('Rollen-Aufschlüsselung', () => {
  it.each([['pv', 'Gesamt-PV'], ['consumer', 'Verbrauch'], ['grid', 'Netz']])('%s zeigt Stand und benennt stumme Geräte', (role, label) => {
    render(<RollenBreakdown wert={wert(role)} />);
    expect(screen.getByText('Stand 10:15 Uhr')).toBeTruthy();
    const knopf = screen.getByRole('button', { name: new RegExp(label) });
    fireEvent.click(knopf);
    expect(knopf.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Zähler Halle 2')).toBeTruthy();
    expect(screen.getByText('liefert gerade nicht')).toBeTruthy();
    expect(screen.getByText(/aus 1 von 2 Geräten/)).toBeTruthy();
    expect(screen.getByText(/Er zählt in der Anlagenzahl einmal/)).toBeTruthy();
    fireEvent.click(knopf);
    expect(screen.queryByText('Zähler Halle 2')).toBeNull();
  });
  it('bleibt ohne Zuordnung zeichengleich leer', () => {
    const { container } = render(<RollenBreakdown wert={{ ...wert('consumer'), zuordnung_vorhanden: false }} />);
    expect(container.innerHTML).toBe('');
  });
});
