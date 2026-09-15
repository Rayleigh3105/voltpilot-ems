import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { UEMS_NOCH_NICHT_GERECHNET, UEMS_NOCH_NICHT_GERECHNET_SATZ } from '../glossar';
import { f8Tag, nochNichtGebildetStunden, nochNichtGebildetTag, normalTag, ohneQuelleTag } from '../test/werteKarteFixtures';
import { karte, liste, type MessstellenKarte } from '../uemsWerteKarte';
import { WerteKarte, WerteListe } from './WerteKarte';

/**
 * Die Tages- und Monatskarte GERENDERT (Captain 15.09.2026, beide Punkte JA): die drei Lagen stehen verschieden da,
 * und die Anzahl der Lücken steht im Abzeichen des Verlaufs. Ahrenberg MS-10 am 02.11. (gewöhnlich), 03.11. (F8)
 * und 05.11.2026 (noch nicht gebildet), MS-21 ohne Datenquelle.
 */

afterEach(cleanup);

const zeige = (k: MessstellenKarte): HTMLElement => {
  render(<WerteKarte karte={k} grund={k.grund} />);
  return screen.getByTestId('werte-karte');
};

/** Der sichtbare Text mit gewöhnlichen Leerzeichen (die Karte setzt U+00A0 vor die Einheit). */
const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('WerteKarte — drei Lagen, jede mit ihrem eigenen Satz', () => {
  it('Wert da: Zahl und Zustand, kein Satz eines fehlenden Werts', () => {
    const k = zeige(karte(normalTag())!);
    expect(text(k.querySelector('.vp-wk-zahl')!)).toBe('2.304 kWh');
    expect(text(k)).toContain('vollständig (Menge aus Zählerständen)');
    expect(within(k).queryByTestId('werte-grund')).toBeNull();
  });

  it('noch nicht gebildet: der Strich und der Satz — kein Abzeichen, nie „keine Werte“', () => {
    const k = zeige(karte(nochNichtGebildetTag())!);
    expect(text(k.querySelector('.vp-wk-zahl')!)).toBe('—');
    expect(within(k).getByTestId('werte-grund').textContent).toBe(UEMS_NOCH_NICHT_GERECHNET_SATZ);
    expect(k.querySelector('.vp-wk-abzeichen')).toBeNull();
    expect(text(k)).not.toContain('keine Werte');
  });

  it('keine Werte: der Strich und das Wort des Vertrags — ohne den Satz des noch nicht Gebildeten', () => {
    const k = zeige(karte(ohneQuelleTag())!);
    expect(text(k.querySelector('.vp-wk-zahl')!)).toBe('—');
    expect(text(k.querySelector('.vp-wk-abzeichen')!)).toBe('keine Werte');
    expect(within(k).queryByTestId('werte-grund')).toBeNull();
  });

  it('die Zeile eines noch nicht gebildeten Schritts trägt das Wort, nie den Satz', () => {
    render(<WerteListe titel="Stunden" zeilen={liste(nochNichtGebildetStunden())} />);
    const zeilen = screen.getAllByTestId('werte-zeile');
    expect(zeilen).toHaveLength(24);
    expect(text(zeilen[23].querySelector('.vp-wk-zeile-info')!)).toBe(UEMS_NOCH_NICHT_GERECHNET);
    expect(zeilen.slice(0, 23).every((z) => !text(z).includes(UEMS_NOCH_NICHT_GERECHNET))).toBe(true);
    expect(screen.queryByText(UEMS_NOCH_NICHT_GERECHNET_SATZ)).toBeNull();
  });
});

describe('WerteKarte — die Anzahl der Lücken', () => {
  it('F8: „Verlauf 85 % · 1 Lücke“ in EINEM Abzeichen, kein eigenes daneben', () => {
    const k = zeige(karte(f8Tag())!);
    expect(text(within(k).getByTestId('werte-verlauf'))).toBe('Verlauf 85 % · 1 Lücke');
    expect(k.querySelector('.vp-wk-abzeichen')!.children).toHaveLength(2);
  });

  it('null Lücken: das Abzeichen des Verlaufs sagt nur den Verlauf', () => {
    const k = zeige(karte(normalTag())!);
    expect(text(within(k).getByTestId('werte-verlauf'))).toBe('Verlauf 100 %');
    expect(text(k)).not.toContain('Lücke');
  });
});
