import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Programmstand } from '../programmstand';
import { SteuerWarum } from './SteuerWarum';

/** UEMS EZ-16: das Blatt „Steuerung jetzt“ nennt einen alten Programmstand im Abschnitt „Warum“. */
const ALT: Programmstand = {
  zustand: 'aelter',
  ist: 2605,
  ist_text: '26.05',
  soll: 2610,
  soll_text: '26.10',
  soll_quelle: 'bibliothek',
  gemessen_am: '2026-10-21T10:00:00Z',
  warnen: true,
};

function blatt(programmstand: Programmstand | null) {
  render(
    <SteuerWarum offen isPhone={false} onClose={() => undefined} view={null} guard={null} spalten={null} programmstand={programmstand} />,
  );
}

describe('SteuerWarum · Programmstand', () => {
  it('ein alter Stand steht als Grund „Programm“', () => {
    blatt(ALT);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Warum')).toBeInTheDocument();
    expect(within(dialog).getByText('Programm')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Die Anlagensteuerung fährt einen alten Stand (26.05, erwartet 26.10).'),
    ).toBeInTheDocument();
  });

  it('Erzeugeranlage (EZ-8): der alte Stand steht hinter „Daten“ im Warum der Kette', () => {
    render(
      <SteuerWarum
        offen
        isPhone={false}
        onClose={() => undefined}
        view={null}
        guard={null}
        spalten={null}
        erzeuger={{ zeilen: [], balken: null, warum: [['Daten', 'vor 5 s · WAGO antwortet']], grenze: [] }}
        programmstand={ALT}
      />,
    );
    const gruende = within(screen.getByRole('dialog')).getAllByRole('term').map((t) => t.textContent);
    expect(gruende).toEqual(['Daten', 'Programm']);
  });

  it('ein aktueller Stand erklärt keine Steuerung', () => {
    blatt({ ...ALT, zustand: 'aktuell', ist: 2610, ist_text: '26.10', warnen: false });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText('Programm')).toBeNull();
    expect(within(dialog).queryByText('Warum')).toBeNull();
  });
});
