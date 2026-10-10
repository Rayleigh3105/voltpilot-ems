import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BEGRIFFE, NORMWOERTER_IM_FACHWORT } from '../begriffe';
import { BegriffeZeile } from './BegriffeZeile';

describe('K3 · Begriffe einer Seite in Alltagssprache', () => {
  it('zeigt je Begriff sein Wort und erklärt es auf Nachfrage — mit Beispiel und Fachwort', () => {
    render(<BegriffeZeile begriffe={['kennzahl', 'bezugsbasis']} />);
    expect(screen.getByTestId('begriffe').textContent).toBe('Begriffe:KennzahlBezugsbasis');
    const knopf = screen.getByRole('button', { name: 'Was heißt „Bezugsbasis“?' });
    fireEvent.click(knopf);
    fireEvent.mouseEnter(knopf);
    fireEvent.focus(knopf);
    const blase = screen.getByRole('tooltip');
    expect(blase.textContent).toContain(BEGRIFFE.bezugsbasis.klartext);
    expect(blase.textContent).toContain('Fachwort: energetische Ausgangsbasis');
  });

  it('zeigt ohne Begriffe nichts', () => {
    const { container } = render(<BegriffeZeile begriffe={[]} />);
    expect(container.textContent).toBe('');
  });

  it('jeder Begriff hat ein Wort und einen Satz — kein Kürzel, keine Normnummer', () => {
    for (const [schluessel, b] of Object.entries(BEGRIFFE)) {
      expect(b.wort.length, schluessel).toBeGreaterThan(0);
      expect(b.klartext.endsWith('.'), schluessel).toBe(true);
      // Entscheid 14 (Konzept Verbessern v1): die genannten Normwörter dürfen im Fachwort stehen, sonst nichts davon.
      const normwoerter = NORMWOERTER_IM_FACHWORT[schluessel as keyof typeof NORMWOERTER_IM_FACHWORT] ?? [];
      const fachwort = normwoerter.reduce((rest, wort) => rest.replaceAll(wort, ' '), b.fachwort ?? '');
      for (const text of [b.klartext, b.beispiel ?? '', fachwort]) {
        expect(text, schluessel).not.toMatch(/(^|[^\p{L}])(ISO|EnPI|EnB|SEU|KPI)([^\p{L}]|$)|\d+\.\d+\s*$|konform|zertifizier/iu);
      }
    }
  });
});
