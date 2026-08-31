import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RanglisteKarte } from './RanglisteKarte';
import type { RanglisteEintrag } from '../verbraucherZone';

/**
 * Die Rangliste-Karte (Paket P4): sortieren mit ▲ ▼, speichern, und die
 * Ehrlichkeitsregeln der Fläche.
 */

const liste: RanglisteEintrag[] = [
  { position: 1, art: 'speicher', entityId: null, name: 'Speicher', mitglieder: [] },
  {
    position: 2, art: 'verbraucher', entityId: 'e-heiz', name: 'Heizstab',
    mitglieder: [{ entityId: 'e-heiz', name: 'Heizstab' }],
  },
  {
    position: 3, art: 'ladepunkt', entityId: null, name: null,
    mitglieder: [
      { entityId: 'e-1', name: 'Stellplatz 2' },
      { entityId: 'e-2', name: 'Carport' },
    ],
  },
];

describe('RanglisteKarte', () => {
  it('zeigt ohne Schreibweg NUR die Liste - kein Knopf, der nichts bewirken kann', () => {
    render(<RanglisteKarte liste={liste} />);
    expect(screen.getByText('Speicher')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ändern' })).toBeNull();
  });

  it('nennt eine Gruppe bei ihren Mitgliedern und sagt, warum sie eine Zeile ist', () => {
    render(<RanglisteKarte liste={liste} onSpeichern={vi.fn()} />);
    expect(screen.getByText('Stellplatz 2 · Carport')).toBeTruthy();
    expect(screen.getByText('2 Ladepunkte')).toBeTruthy();
    expect(screen.getByText(/gleichrangig/)).toBeTruthy();
  });

  it('sortiert mit ▲ ▼ und schickt die Liste FLACH - die Gruppe aufgelöst', async () => {
    const speichern = vi.fn().mockResolvedValue(undefined);
    render(<RanglisteKarte liste={liste} onSpeichern={speichern} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ändern' }));
    fireEvent.click(screen.getByRole('button', { name: /Nach oben: Stellplatz 2 · Carport/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Reihenfolge speichern' }));
    await waitFor(() => expect(speichern).toHaveBeenCalledTimes(1));
    expect(speichern.mock.calls[0][0]).toEqual([
      { art: 'speicher' },
      { art: 'ladepunkt', entityId: 'e-1' },
      { art: 'ladepunkt', entityId: 'e-2' },
      { art: 'verbraucher', entityId: 'e-heiz' },
    ]);
  });

  it('zeigt die Folgen VOR dem Speichern - und sie folgen dem Entwurf', () => {
    render(<RanglisteKarte liste={liste} onSpeichern={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ändern' }));
    expect(screen.getByText(/Ist die Leistung knapp, bekommt Speicher/)).toBeTruthy();
    const hoch = () => fireEvent.click(
      screen.getByRole('button', { name: /Nach oben: Stellplatz 2 · Carport/ }));
    hoch();
    hoch();
    expect(screen.getByText(/Ist die Leistung knapp, bekommt Stellplatz 2 · Carport/)).toBeTruthy();
  });

  it('zählt beim Sortieren selbst - eine Gruppe belegt so viele Plätze wie Geräte', () => {
    render(<RanglisteKarte liste={liste} onSpeichern={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ändern' }));
    fireEvent.click(screen.getByRole('button', { name: /Nach oben: Stellplatz 2 · Carport/ }));
    fireEvent.click(screen.getByRole('button', { name: /Nach oben: Stellplatz 2 · Carport/ }));
    const pos = [...document.querySelectorAll('.vp-vz-pos')].map((n) => n.textContent);
    expect(pos).toEqual(['1', '3', '4']);
  });

  it('▲ ist am obersten und ▼ am untersten Platz gesperrt', () => {
    render(<RanglisteKarte liste={liste} onSpeichern={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ändern' }));
    expect(screen.getByRole('button', { name: 'Nach oben: Speicher' })
      .hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /Nach unten: Stellplatz 2 · Carport/ })
      .hasAttribute('disabled')).toBe(true);
  });

  it('nimmt eine Abbruch-Änderung zurück, statt sie stehen zu lassen', () => {
    render(<RanglisteKarte liste={liste} onSpeichern={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ändern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Nach oben: Heizstab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ändern' }));
    const namen = screen.getAllByText(/Speicher|Heizstab/).map((n) => n.textContent);
    expect(namen[0]).toBe('Speicher');
  });

  it('nennt einen Fehlschlag beim Namen und lässt die Liste offen', async () => {
    const speichern = vi.fn().mockRejectedValue(new Error('Die Reihenfolge muss den Speicher '
      + 'enthalten.'));
    render(<RanglisteKarte liste={liste} onSpeichern={speichern} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ändern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reihenfolge speichern' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toContain('muss den Speicher enthalten'));
    expect(screen.getByRole('button', { name: 'Reihenfolge speichern' })).toBeTruthy();
  });

  it('übernimmt eine neu geladene Liste, solange nicht bearbeitet wird', () => {
    const { rerender } = render(<RanglisteKarte liste={liste} onSpeichern={vi.fn()} />);
    const neu: RanglisteEintrag[] = [{
      position: 1, art: 'verbraucher', entityId: 'e-neu', name: 'Neue Pumpe',
      mitglieder: [{ entityId: 'e-neu', name: 'Neue Pumpe' }],
    }];
    rerender(<RanglisteKarte liste={neu} onSpeichern={vi.fn()} />);
    expect(screen.getByText('Neue Pumpe')).toBeTruthy();
    expect(screen.queryByText('Heizstab')).toBeNull();
  });
});
