import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RegelKarteView } from './RegelKarten';
import type { RegelKarte } from '../regeln/zustand';

const karte = (over: Partial<RegelKarte> = {}): RegelKarte => ({
  key: 'flow:f1',
  art: 'baukasten',
  id: 'f1',
  name: 'Wallbox nur bei PV-Überschuss',
  satz: 'Wenn Überschuss über 3 kW, dann Wallbox ein.',
  ersatz: 'Diese Regel hat keinen ableitbaren Satz.',
  zustand: {
    lebenszyklus: 'Läuft',
    geraet: null,
    betrieb: null,
    problem: null,
    zeile: 'Läuft',
    ton: 'on',
    rang: 0,
  },
  chips: [
    { key: 'wallbox', label: 'Wallbox Carport', ton: 'plain' },
    { key: 'weg', label: 'Entfernte Komponente', ton: 'warn' },
    { key: 'wallbox:nachweis', label: 'Heute: 1 von 1 erfüllt', ton: 'ok' },
  ],
  hinweis: null,
  aktivitaet: null,
  an: true,
  version: 3,
  ...over,
});

/**
 * Anlagen-Zentrale Stufe 3 (PR 3c, §13.3): der Wohnort der Regeln BLEIBT die
 * Steuerung - aber jede Regel sagt jetzt, WO ihre Komponente wohnt, und führt
 * dorthin. Der Weg ist derselbe wie aus dem Cockpit und dem Schaltbild.
 */
describe('RegelKarteView · der Weg zurück auf die Komponente', () => {
  const base = { busy: false, onToggle: vi.fn(), onOpen: vi.fn() };

  it('macht aus dem Komponenten-Chip einen Weg in die Zentrale', () => {
    render(<RegelKarteView {...base} karte={karte()} siteId="s-1" />);
    const link = screen.getByRole('link', { name: 'Wallbox Carport' });
    expect(link.getAttribute('href')).toBe('#/anlage/s-1/modell?komponente=wallbox');
  });

  it('führt NIE ins Leere: eine entfernte Komponente und ein Nachweis bleiben Text', () => {
    render(<RegelKarteView {...base} karte={karte()} siteId="s-1" />);
    // Eine entfernte Komponente hat keine Zeile mehr…
    expect(screen.queryByRole('link', { name: 'Entfernte Komponente' })).toBeNull();
    expect(screen.getByText('Entfernte Komponente')).toBeInTheDocument();
    // …und ein Nachweis-Chip benennt gar keine Komponente.
    expect(screen.queryByRole('link', { name: /Heute:/ })).toBeNull();
    expect(screen.getByText('Heute: 1 von 1 erfüllt')).toBeInTheDocument();
  });

  it('bietet ohne Anlage gar keinen Weg an', () => {
    render(<RegelKarteView {...base} karte={karte()} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Wallbox Carport')).toBeInTheDocument();
  });
});
