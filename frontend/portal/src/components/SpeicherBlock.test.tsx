import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SpeicherBlock } from './SpeicherBlock';
import { speicherAussage, type SpeicherEingabe } from '../speicherAussage';

/**
 * Der Speicher-Block der Erlöse-Karte (Erlöse-Konzept
 * `vp-erloese-seite-konzept-e2` §3.5, Captain-Scoping 2).
 *
 * Geprüft wird, was die FLÄCHE zusagt: je Lage die richtigen Zeilen, der Ton
 * NIE allein als Farbe (immer ein Wort daneben) und die Ehrlichkeit ohne
 * Aufteilung. Die ZAHLEN selbst gehören `speicherAussage.test.ts` — hier läuft
 * die echte Ableitung, damit die Fläche nichts zeigen kann, was sie nicht
 * produziert.
 */
const NOW = new Date('2026-09-01T12:00:00Z');

function block(money: SpeicherEingabe, geplantEur?: number | null) {
  const a = speicherAussage(money, { now: NOW, geplantEur });
  if (!a) throw new Error('Ableitung liefert nichts — der Vektor ist falsch.');
  return render(
    <SpeicherBlock aussage={a} nachtragHref="#/anlage/s-1/technik" />,
  );
}

const ABGESCHLOSSEN: SpeicherEingabe = {
  savedEur: 12.4,
  savedSpeicherEur: 9.3,
  savedSteuerungEur: 3.1,
  range: 'day',
  to: '2026-08-31T22:00:00Z',
};

describe('SpeicherBlock · abgeschlossener Tag, beide Zahlen positiv', () => {
  it('zeigt Zeile 1 und Zeile 2 mit dem sturen Speicher als Chip', () => {
    block(ABGESCHLOSSEN);
    expect(screen.getByText('Speicher an diesem Tag')).toBeInTheDocument();
    expect(screen.getByText(/\+ 12,40/)).toBeInTheDocument();
    expect(screen.getByText('davon Steuerung')).toBeInTheDocument();
    expect(screen.getByText(/\+ 3,10/)).toBeInTheDocument();
    expect(screen.getByText(/stur \+ 9,30/)).toBeInTheDocument();
  });

  it('trägt den Ton `ok` — und die Zahl steht trotzdem als Wort da', () => {
    const { container } = block(ABGESCHLOSSEN);
    expect(container.querySelector('.vp-spb-ton-ok')).not.toBeNull();
    // Grün ist Beiwerk: das Vorzeichen ist ein eigenes Zeichen (§3.9).
    expect(screen.getByText(/^\+ 12,40/)).toBeInTheDocument();
  });
});

describe('SpeicherBlock · laufender Tag (der Screenshot-Fall)', () => {
  const LAUFEND: SpeicherEingabe = {
    savedEur: -2.67,
    savedSpeicherEur: -4.12,
    savedSteuerungEur: 1.45,
    range: 'day',
    to: '2026-09-01T22:00:00Z',
  };

  it('nennt die Lage beim Wort statt sie zu färben', () => {
    const { container } = block(LAUFEND);
    expect(screen.getByText('Speicher heute')).toBeInTheDocument();
    expect(screen.getByText('Zwischenstand')).toBeInTheDocument();
    // Kein Grün, kein Rot auf einem Zwischenstand (E8).
    expect(container.querySelector('.vp-spb-ton-neutral')).not.toBeNull();
    expect(container.querySelector('.vp-spb-ton-ok')).toBeNull();
    expect(container.querySelector('.vp-spb-ton-warn')).toBeNull();
  });

  it('zeigt den positiven Steuerungs-Beitrag neben dem negativen Gesamtwert', () => {
    block(LAUFEND);
    expect(screen.getByText(/− 2,67/)).toBeInTheDocument();
    expect(screen.getByText(/\+ 1,45/)).toBeInTheDocument();
    expect(screen.getByText(/stur − 4,12/)).toBeInTheDocument();
  });
});

describe('SpeicherBlock · abgeschlossen unter Null', () => {
  it('warnt in Bernstein UND sagt „unter Null" — nie Rot, nie nur Farbe', () => {
    const { container } = block({
      savedEur: -0.4,
      range: 'day',
      to: '2026-08-31T22:00:00Z',
    });
    expect(container.querySelector('.vp-spb-ton-warn')).not.toBeNull();
    expect(screen.getByText('unter Null')).toBeInTheDocument();
  });
});

describe('SpeicherBlock · ohne Aufteilung', () => {
  it('sagt ehrlich „—" und führt auf die Technik-Seite (nur mit gemeldetem Grund)', () => {
    block({
      savedEur: 12.4,
      steuerungSplitReason: 'no_battery_data',
      range: 'day',
      to: '2026-08-31T22:00:00Z',
    });
    expect(screen.getByText('davon Steuerung')).toBeInTheDocument();
    // Nie eine 0, wo nichts berechenbar ist.
    expect(screen.getByText('—')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Speicher-Daten fehlen/ });
    expect(link).toHaveAttribute('href', '#/anlage/s-1/technik');
  });

  it('lässt Zeile 2 ganz weg, wenn nur das FELD fehlt (älteres Backend)', () => {
    block({ savedEur: 12.4, range: 'day', to: '2026-08-31T22:00:00Z' });
    // Ein fehlendes Feld ist kein fehlendes Stammdatum — dann gibt es weder
    // Zeile 2 noch eine Aufforderung zum Nachtragen (§3.6).
    expect(screen.queryByText('davon Steuerung')).toBeNull();
    expect(screen.queryByRole('link', { name: /Speicher-Daten fehlen/ })).toBeNull();
  });
});

describe('SpeicherBlock · Zeile 3 und Zeile 4', () => {
  it('zeigt Bestand und Planwert je mit eigenem Abzeichen', () => {
    block(
      {
        ...ABGESCHLOSSEN,
        speicherDeltaKwh: 35.8,
        speicherWertCtKwh: 24.8,
        speicherWertEur: 8.87,
        speicherWertBasis: 'plan',
      },
      9.4,
    );
    expect(screen.getByText('Kein Abzug')).toBeInTheDocument();
    expect(screen.getByText('Geplant')).toBeInTheDocument();
    expect(screen.getByText(/Vorab geplant hatte der Fahrplan/)).toBeInTheDocument();
  });

  it('behauptet ohne Messung und ohne Plan gar nichts', () => {
    block(ABGESCHLOSSEN);
    expect(screen.queryByText('Kein Abzug')).toBeNull();
    expect(screen.queryByText('Geplant')).toBeNull();
  });
});
