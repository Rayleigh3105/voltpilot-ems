import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SiteEarnings } from '../../api';
import FIXTURES from '../../erloeseFixtures.json';
import { speicherAussage } from '../../speicherAussage';
import { SpeicherKarte } from './SpeicherKarte';

/**
 * **Die Karte „Ihr Speicher" als FLÄCHE** (Konzept
 * `vp-erloese-lesbar-konzept-u3` §3.10 „Anatomie C" (3), Captain-Entscheid
 * **E7 = (a): ohne grüne Fläche**).
 *
 * Sie ist die Nachfolgerin des abgelösten `SpeicherBlock` — dieselbe Aussage,
 * dieselben Wörter, aber eine KARTE neben dem Kontoauszug statt eines
 * eingefärbten Kastens IN einer fremden Karte („Fläche in der Fläche", §B2).
 *
 * Geprüft wird hier, was nur die Fläche beantworten kann: dass kein Betrag in
 * einem Chip steht (Prinzip 2), dass das Chip-Vokabular GESCHLOSSEN ist
 * (Prinzip 5) und dass ein fehlender Wert seinen Weg NENNT statt eine Null zu
 * erfinden.
 */

interface Fixture {
  id: string;
  now: string;
  savedSpeicherEur: number | null;
  money: SiteEarnings;
}
const FX = FIXTURES.fixtures as unknown as Fixture[];

/** Das GESCHLOSSENE Chip-Vokabular der Ergebnis-Fläche (§3.10, E6 = a). */
const CHIP_VOKABULAR = [
  'Zwischenstand',
  'unter Null',
  'vorläufig',
  'Bewertet',
  'Gemessen',
  'Geplant',
  'Kein Abzug',
];

function karte(id: string) {
  const f = FX.find((x) => x.id === id)!;
  const stur = f.savedSpeicherEur;
  const steuerung = stur == null || f.money.savedEur == null ? null : f.money.savedEur - stur;
  const money: SiteEarnings = {
    ...f.money,
    savedSpeicherEur: stur,
    savedSteuerungEur: steuerung,
    steuerungSplitReason: stur == null ? 'no_battery_data' : null,
  };
  const aussage = speicherAussage(money, { now: new Date(f.now) });
  if (!aussage || !aussage.hatAussage) throw new Error(`Fixture ${id} hat keine Speicher-Aussage`);
  return render(<SpeicherKarte aussage={aussage} nachtragHref="#/anlage/demo/technik" />);
}

describe('SpeicherKarte · die Anatomie C', () => {
  it('ist eine eigene Karte mit Label und Zustands-Chip — ohne grüne Fläche (E7)', () => {
    const { container } = karte('dv-tag-laufend');
    const sec = container.querySelector('section.vp-c-card.vp-c-speicher') as HTMLElement;
    expect(sec).toBeTruthy();
    expect(within(sec).getByText('Ihr Speicher')).toBeInTheDocument();
    // Der laufende Tag trägt „Zwischenstand" — ein ZUSTANDSWORT, kein Betrag.
    const chips = [...sec.querySelectorAll('.vp-chip')].map((c) => c.textContent?.trim() ?? '');
    expect(chips).toContain('Zwischenstand');
    for (const chip of chips) {
      expect(CHIP_VOKABULAR).toContain(chip);
      // Prinzip 2: Beträge leben in EINER Spalte, nie in einem Chip.
      expect(chip).not.toMatch(/€|\d/);
    }
  });

  it('nennt beide Zeilen mit ihrem Betrag rechts und die sture Referenz als Sekundärzeile', () => {
    const { container } = karte('dv-tag-laufend');
    const zeilen = [...container.querySelectorAll('.vp-c-sp-zeile')];
    expect(zeilen).toHaveLength(2);
    expect(zeilen[0].textContent).toMatch(/Speicher heute/);
    expect(zeilen[1].textContent).toMatch(/davon Steuerung/);
    // Die sture Referenz steht als ruhige Sekundärzeile, nicht als Chip.
    const sek = container.querySelector('.vp-c-sp-sek') as HTMLElement;
    expect(sek.textContent).toMatch(/^stur/);
    expect(sek.classList.contains('vp-chip')).toBe(false);
  });

  it('trägt den Bestand mit „Kein Abzug" — der Betrag im Satz, das Wort im Chip', () => {
    const { container } = karte('dv-tag-laufend');
    const bestand = container.querySelector('.vp-c-sp-bestand') as HTMLElement;
    expect(bestand).toBeTruthy();
    expect(bestand.textContent).toMatch(/Planwert/);
    expect(within(bestand).getByText('Kein Abzug')).toHaveClass('vp-chip');
  });

  it('sagt ohne Batterie-Stammdaten „—" und NENNT den Weg statt eine Null zu erfinden', () => {
    const { container } = karte('dv-kein-split');
    expect(container.querySelector('.vp-c-speicher')).toBeTruthy();
    // Die Zeile STEHT DA — der Kunde sieht, dass die Frage gestellt wurde —,
    // aber sie trägt „—" statt einer erfundenen Null.
    const zeilen = [...container.querySelectorAll('.vp-c-sp-zeile')];
    const werte = zeilen.map((z) => z.querySelector('.vp-c-sp-wert')?.textContent?.trim());
    expect(werte).toContain('—');
    // … und daneben steht der Weg, und der ist ein echter Link.
    const link = screen.getByRole('link', { name: /Speicher-Daten fehlen/ });
    expect(link).toHaveAttribute('href', '#/anlage/demo/technik');
  });
});
