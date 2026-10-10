import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BEGRIFFE, fachwortZeile } from '../begriffe';
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

  it('das Fachwort steht zuletzt - bei „Was ist eine Maßnahme?“ die Normwörter (Konzept Verbessern v1, Entscheid 14)', () => {
    render(<BegriffAufklapper begriff="massnahme" />);
    const details = screen.getByTestId('begriff-auf-massnahme') as HTMLDetailsElement;
    expect(screen.getByText('Was ist eine Maßnahme?')).toBeInTheDocument();
    details.open = true;
    const zeilen = [...details.querySelectorAll('.vp-begriff-auf-text p')].map((p) => p.textContent);
    expect(zeilen).toEqual([
      BEGRIFFE.massnahme.klartext,
      BEGRIFFE.massnahme.beispiel,
      BEGRIFFE.massnahme.abgrenzung,
      fachwortZeile(BEGRIFFE.massnahme.fachwort!),
    ]);
    expect(zeilen.at(-1)).toMatch(/^Fachwörter: Aktionsplan .*Korrekturmaßnahme/u);
  });

  it('ohne Fachwort keine letzte Zeile (Messstelle)', () => {
    render(<BegriffAufklapper begriff="messstelle" />);
    expect(screen.getByTestId('begriff-auf-messstelle').querySelector('.vp-begriff-auf-fachwort')).toBeNull();
  });

  it('ohne eigenes Beispiel das allgemeine; ohne eigene Frage „Was heißt „…“?“', () => {
    render(<BegriffAufklapper begriff="kennzahl" />);
    expect(screen.getByText(`Was heißt „${BEGRIFFE.kennzahl.wort}“?`)).toBeInTheDocument();
    if (BEGRIFFE.kennzahl.beispiel) expect(screen.getByText(BEGRIFFE.kennzahl.beispiel)).toBeInTheDocument();
  });
});
