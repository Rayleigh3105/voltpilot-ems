import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BEGRIFFE } from '../begriffe';
import { BegriffAufklapper } from './BegriffAufklapper';

/** „Was ist eine Messstelle?“ (Konzept Messen m1, §7, Stufe 2): zu ein leiser Verweis, offen Klartext, Beispiel, Abgrenzung. */
describe('BegriffAufklapper', () => {
  it('ist zu, bis jemand tippt; offen stehen Klartext, das eigene Beispiel, der Satz der Fläche und die Abgrenzung', () => {
    render(<BegriffAufklapper begriff="messstelle" beispiel={<>Bei Ihnen zum Beispiel <b>Hauptzähler Halle 1</b>.</>} />);
    const details = screen.getByTestId('begriff-auf-messstelle') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const frage = screen.getByText('Was ist eine Messstelle?');
    fireEvent.click(frage);
    details.open = true;
    expect(screen.getByText(BEGRIFFE.messstelle.klartext)).toBeInTheDocument();
    expect(screen.getByText('Hauptzähler Halle 1')).toBeInTheDocument();
    // Das allgemeine Beispiel weicht dem aus der eigenen Firma.
    expect(screen.queryByText(BEGRIFFE.messstelle.beispiel!)).toBeNull();
    expect(screen.getByText(BEGRIFFE.messstelle.mehr!)).toBeInTheDocument();
    expect(screen.getByText(BEGRIFFE.messstelle.abgrenzung!)).toBeInTheDocument();
  });

  it('ohne eigenes Beispiel das allgemeine; ohne eigene Frage „Was heißt „…“?“', () => {
    render(<BegriffAufklapper begriff="bezugsgroesse" />);
    expect(screen.getByText(`Was heißt „${BEGRIFFE.bezugsgroesse.wort}“?`)).toBeInTheDocument();
    if (BEGRIFFE.bezugsgroesse.beispiel) expect(screen.getByText(BEGRIFFE.bezugsgroesse.beispiel)).toBeInTheDocument();
  });
});
