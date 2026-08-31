import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { FahrzeugeKarte } from './FahrzeugeKarte';
import type { SiteFahrzeuge } from '../fahrzeugProfile';

const A = 'tagref_1f2e3d4c5b6a798877665544';
const B = 'tagref_00112233445566778899aabb';

const daten: SiteFahrzeuge = {
  fahrzeuge: [
    { tagRef: A, name: 'Dienstwagen', laedt: true, letzterLadepunkt: 'cp-1',
      steuerart: { quelle: 'sofort' } },
    { tagRef: B, letzteSichtungAm: '2026-08-30T18:42:00Z' },
  ],
};

function auf(node: HTMLElement | null): void {
  if (node) fireEvent.click(node);
}

describe('FahrzeugeKarte', () => {
  it('fasst zusammen, ohne eine Zahl ohne ihren Gegenstand zu nennen', () => {
    render(<FahrzeugeKarte daten={daten} onSpeichern={vi.fn()} />);
    expect(screen.getByText('2 Karten · 1 lädt gerade')).toBeTruthy();
  });

  it('nennt die benannte Karte samt Steuerart und die unbenannte bei ihrer Kurzform', () => {
    render(<FahrzeugeKarte daten={daten} onSpeichern={vi.fn()} />);
    auf(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('Dienstwagen')).toBeTruthy();
    expect(screen.getByText('Sofort laden')).toBeTruthy();
    expect(screen.getByText('Karte 0011…')).toBeTruthy();
    expect(screen.getByText('Lädt wie der Ladepunkt')).toBeTruthy();
  });

  // ⚠ Der NAME der Säule, wo einer bekannt ist - nie die nackte Kennung.
  it('nennt den Ort über den übergebenen Namen', () => {
    render(<FahrzeugeKarte daten={daten} ladepunktName={(id) => (id === 'cp-1' ? 'Hof Nord' : null)}
      onSpeichern={vi.fn()} />);
    auf(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('an Hof Nord')).toBeTruthy();
  });

  it('sagt ohne eine einzige Karte den WEG statt einer leeren Liste', () => {
    render(<FahrzeugeKarte daten={{ fahrzeuge: [] }} onSpeichern={vi.fn()} />);
    auf(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(/Noch keine Ladekarte gesehen/)).toBeTruthy();
  });

  // ⚠ Das Pseudonym steht NIE vollständig in der Fläche - der Kunde erkennt
  // seine Karte an vier Zeichen, 24 helfen niemandem.
  it('zeigt das Pseudonym nie vollständig', () => {
    render(<FahrzeugeKarte daten={daten} onSpeichern={vi.fn()} />);
    auf(screen.getByRole('button', { expanded: false }));
    expect(document.body.textContent).not.toContain(A);
    expect(document.body.textContent).not.toContain(B);
  });

  it('öffnet den Dialog auf der Zeile und speichert den Wunsch', async () => {
    const onSpeichern = vi.fn().mockResolvedValue(undefined);
    render(<FahrzeugeKarte daten={daten} onSpeichern={onSpeichern} />);
    auf(screen.getByRole('button', { expanded: false }));
    auf(screen.getByText('Dienstwagen').closest('button'));
    const speichern = await screen.findByRole('button', { name: 'Speichern' });
    // Das Speichern ist asynchron - ohne `act` schliesst der Dialog nach dem
    // Test und React warnt (die Zustands-Aenderung liefe ausserhalb).
    await act(async () => { fireEvent.click(speichern); });
    expect(onSpeichern).toHaveBeenCalledTimes(1);
    expect(onSpeichern.mock.calls[0][0]).toBe(A);
  });

  // ⚠ Ohne Schreibweg gibt es keinen Knopf - eine Fläche, die nur ANSEHEN
  // kann, darf nicht so aussehen, als könnte man etwas ändern.
  it('bleibt ohne Schreibweg reine Anzeige', () => {
    render(<FahrzeugeKarte daten={daten} />);
    auf(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('Dienstwagen').closest('button')).toBeNull();
  });
});
