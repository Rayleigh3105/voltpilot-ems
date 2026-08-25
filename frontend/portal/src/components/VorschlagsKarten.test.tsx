import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { VorschlagsKarten } from './VorschlagsKarten';
import type { Vorschlag } from '../vorschlaege';

const v: Vorschlag = {
  key: 'ueberschuss:c1',
  art: 'ueberschuss',
  komponenteId: 'c1',
  komponenteName: 'Wallbox',
  titel: '„Wallbox" heute 11:00–15:00 Uhr laufen lassen',
  begruendung: 'In diesem Fenster erwartet der Fahrplan 9,0 kWh Solar-Überschuss.',
  regelName: 'Wallbox bei Solar-Überschuss',
  prefill: { intent: 'react' },
};

describe('VorschlagsKarten', () => {
  it('rendert ohne Vorschläge GAR NICHTS (kein leerer Kopf, keine Karte)', () => {
    const { container } = render(
      <VorschlagsKarten vorschlaege={[]} onUebernehmen={() => {}} onStumm={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('zeigt Titel, Begründung MIT Zahl und die drei Handlungen', () => {
    render(<VorschlagsKarten vorschlaege={[v]} onUebernehmen={() => {}} onStumm={() => {}} />);
    expect(screen.getByText(/Wallbox.*11:00/)).toBeInTheDocument();
    expect(screen.getByText(/9,0 kWh/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Übernehmen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Später' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ablehnen' })).toBeInTheDocument();
  });

  it('nennt die FRIST von „Später" und „Ablehnen", bevor geklickt wird', () => {
    render(<VorschlagsKarten vorschlaege={[v]} onUebernehmen={() => {}} onStumm={() => {}} />);
    expect(screen.getByRole('button', { name: 'Später' }))
      .toHaveAttribute('title', expect.stringContaining('einen Tag'));
    expect(screen.getByRole('button', { name: 'Ablehnen' }))
      .toHaveAttribute('title', expect.stringContaining('sieben Tage'));
  });

  it('reicht die Handlungen mit ihrem Vorschlag durch', () => {
    const uebernehmen = vi.fn();
    const stumm = vi.fn();
    render(<VorschlagsKarten vorschlaege={[v]} onUebernehmen={uebernehmen} onStumm={stumm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
    expect(uebernehmen).toHaveBeenCalledWith(v);
    fireEvent.click(screen.getByRole('button', { name: 'Später' }));
    expect(stumm).toHaveBeenCalledWith(v, 'spaeter');
    fireEvent.click(screen.getByRole('button', { name: 'Ablehnen' }));
    expect(stumm).toHaveBeenCalledWith(v, 'abgelehnt');
  });

  it('der Kopf trägt die ZAHL der Vorschläge', () => {
    render(<VorschlagsKarten
      vorschlaege={[v, { ...v, key: 'guenstig:c2', komponenteId: 'c2' }]}
      onUebernehmen={() => {}}
      onStumm={() => {}}
    />);
    expect(screen.getByText(/2 Vorschläge/)).toBeInTheDocument();
  });

  it('während einer laufenden Handlung sind alle Knöpfe gesperrt', () => {
    render(<VorschlagsKarten vorschlaege={[v]} busy onUebernehmen={() => {}} onStumm={() => {}} />);
    for (const n of ['Übernehmen', 'Später', 'Ablehnen']) {
      expect(screen.getByRole('button', { name: n })).toBeDisabled();
    }
  });
});
