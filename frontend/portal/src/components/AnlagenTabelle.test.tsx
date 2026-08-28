import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AnlagenTabelle } from './AnlagenTabelle';
import type { AnlagenZeile, SpaltenId } from '../portfolioCockpit';
import type { VorschauZeile } from '../portfolioVorschau';

/**
 * Die EINE Anlagen-Tabelle in zwei Dichten (Portfolio Revision 2 §5.2 / E1).
 *
 * Sie ist render-only; geprüft wird, was SIE entscheidet: die Zellen je
 * Spalte, die Auslassung als „—", der Zustand als Punkt + WORT + Alter, und
 * dass die Vorschau ihren Ladezustand von „nichts da" unterscheidet.
 */

const SPALTEN: SpaltenId[] = [
  'pv-jetzt',
  'erzeugung-heute',
  'verbrauch-heute',
  'speicher',
  'netz-heute',
  'erloese',
];

function zeile(over: Partial<AnlagenZeile> & { id: string; name: string }): AnlagenZeile {
  return {
    unterzeile: 'Eigenverbrauch',
    speicherOhneGeraet: false,
    pvJetztKw: 13.7,
    erzeugungKwh: 104,
    verbrauchKwh: 180,
    ladestandPct: 62,
    ladestandWort: 'lädt',
    netz: { richtung: 'bezug', kw: 6.3 },
    heuteEur: 1.57,
    zustand: { wort: 'Online', alter: null, ton: 'ok' },
    ...over,
  } as AnlagenZeile;
}

function tabelle(over: Partial<Parameters<typeof AnlagenTabelle>[0]> = {}) {
  return render(
    <AnlagenTabelle
      zeilen={[zeile({ id: 'a', name: 'Filiale Nord' })]}
      spalten={SPALTEN}
      dichte="kompakt"
      offen={null}
      onToggle={() => {}}
      onOeffnen={() => {}}
      vorschau={null}
      {...over}
    />,
  );
}

describe('AnlagenTabelle — die Zeile ist die Komponenten-Zeile eine Ebene höher', () => {
  it('rendert GAR NICHTS ohne Zeilen - die Fläche sagt dann ihren eigenen Satz', () => {
    const { container } = tabelle({ zeilen: [] });
    expect(container.querySelector('table')).toBeNull();
  });

  it('führt die Dichte als Attribut, nicht als anderer Inhalt', () => {
    const { container } = tabelle({ dichte: 'komfortabel' });
    expect(container.querySelector('.vp-at')!.getAttribute('data-dichte')).toBe('komfortabel');
  });

  it('zeigt NUR die übergebenen Spalten - eine leere Menge lässt Anlage + Zustand', () => {
    tabelle({ spalten: [] });
    const kopf = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(kopf).toEqual(['Anlage', 'Zustand']);
  });

  it('trägt die Einheit im KOPF, nicht in jeder Zelle', () => {
    tabelle({ spalten: ['erzeugung-heute'] });
    const kopf = screen.getByRole('columnheader', { name: /Erzeugung heute/ });
    expect(within(kopf).getByText('kWh')).toBeTruthy();
  });

  it('setzt „—" für einen fehlenden Wert, nie eine erfundene 0', () => {
    const { container } = tabelle({
      zeilen: [zeile({ id: 'a', name: 'Neubau', pvJetztKw: null, heuteEur: null, netz: null })],
      spalten: ['pv-jetzt', 'netz-heute', 'erloese'],
    });
    const zellen = [...container.querySelectorAll('tbody td.num')].map((c) => c.textContent);
    expect(zellen).toEqual(['—', '—', '—']);
  });

  it('nennt die Netz-RICHTUNG, nie ein Vorzeichen', () => {
    tabelle({
      zeilen: [zeile({ id: 'a', name: 'A', netz: { richtung: 'einspeisung', kw: 30 } })],
      spalten: ['netz-heute'],
    });
    const zelle = screen.getAllByRole('cell')[1];
    expect(zelle.textContent).toContain('↑');
    expect(zelle.textContent).not.toContain('-30');
  });

  it('zeigt den Zustand als Punkt + WORT + Alter', () => {
    const { container } = tabelle({
      zeilen: [
        zeile({
          id: 'a',
          name: 'Hof',
          zustand: { wort: 'Meldet sich nicht', alter: 'seit 3 Std.', ton: 'warn' },
        }),
      ],
    });
    // Die Farbe allein ist keine Unterscheidung - das Wort steht daneben.
    expect(screen.getByText('Meldet sich nicht')).toBeTruthy();
    expect(screen.getByText('seit 3 Std.')).toBeTruthy();
    expect(container.querySelector('.vp-at-dot.is-warn')).toBeTruthy();
  });

  it('NENNT den Speicher ohne Gerät an seiner Zeile', () => {
    tabelle({ zeilen: [zeile({ id: 'a', name: 'A', speicherOhneGeraet: true })] });
    expect(screen.getByText('Speicher ohne Gerät')).toBeTruthy();
  });

  it('öffnet über ZEILE und NAME die Anlage; nur der getrennte Chevron klappt Details auf', () => {
    const onToggle = vi.fn();
    const onOeffnen = vi.fn();
    tabelle({ onToggle, onOeffnen });

    const name = screen.getByRole('button', { name: 'Anlage Filiale Nord öffnen' });
    fireEvent.click(name);
    expect(onOeffnen).toHaveBeenCalledWith('a');
    expect(onToggle).not.toHaveBeenCalled();

    fireEvent.click(name.closest('tr')!);
    expect(onOeffnen).toHaveBeenCalledTimes(2);

    const details = screen.getByRole('button', { name: 'Details zu Filiale Nord anzeigen' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(details);
    expect(onToggle).toHaveBeenCalledWith('a');
    expect(onOeffnen).toHaveBeenCalledTimes(2);
  });

  it('unterscheidet „lädt noch" von „nichts da"', () => {
    const { rerender } = tabelle({ offen: 'a', vorschau: null });
    expect(screen.getByText('Wird geladen …')).toBeTruthy();
    const geladen: VorschauZeile[] = [
      { key: 'plan', label: 'Heute geplant', text: 'Mittags laden.', tag: 'Geplant' },
    ];
    rerender(
      <AnlagenTabelle
        zeilen={[zeile({ id: 'a', name: 'Filiale Nord' })]}
        spalten={SPALTEN}
        dichte="kompakt"
        offen="a"
        onToggle={() => {}}
        onOeffnen={() => {}}
        vorschau={geladen}
      />,
    );
    expect(screen.queryByText('Wird geladen …')).toBeNull();
    expect(screen.getByText('Mittags laden.')).toBeTruthy();
    expect(screen.getByText('Geplant')).toBeTruthy();
  });

  it('behält den zusätzlichen Absprung IN der Vorschau', () => {
    const onOeffnen = vi.fn();
    tabelle({
      offen: 'a',
      onOeffnen,
      vorschau: [{ key: 'plan', label: 'Heute geplant', text: 'x' }],
    });
    fireEvent.click(screen.getByRole('button', { name: /Cockpit öffnen/ }));
    expect(onOeffnen).toHaveBeenCalledWith('a');
  });
});

// ---------------------------------------------------------------------------
// Die Telefon-Fassung: EINE Karte je Zeile
// ---------------------------------------------------------------------------

/**
 * ⚠ `useIsPhone` liest `matchMedia`, das jsdom gar nicht kennt - ohne diese
 * Attrappe misst JEDER Test oben den Schreibtisch (die Haus-Regel des
 * Mobil-Umbaus). Sie wird danach wieder entfernt, damit sie keine andere
 * Datei erreicht.
 */
function stubPhone(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({
      matches,
      media: '(max-width: 720px)',
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
});

describe('am Telefon: EINE Karte je Zeile, dieselben Daten', () => {
  it('rendert Karten statt einer Tabelle - acht Spalten passen dort nie', () => {
    stubPhone(true);
    const { container } = tabelle();
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelectorAll('.vp-at-karte')).toHaveLength(1);
  });

  it('führt die DREI Jetzt-Werte - die Tages-Summen stehen in der Vorschau', () => {
    stubPhone(true);
    const { container } = tabelle();
    const labels = [...container.querySelectorAll('.vp-at-karte-nums .l')].map((n) => n.textContent);
    expect(labels).toEqual(['PV jetzt', 'Speicher', 'Netz jetzt']);
  });

  it('lässt eine Kachel ohne Wert GANZ weg, statt „—" zu stapeln', () => {
    stubPhone(true);
    const { container } = tabelle({
      zeilen: [zeile({ id: 'a', name: 'Neubau', pvJetztKw: null, ladestandPct: null, netz: null })],
    });
    expect(container.querySelector('.vp-at-karte-nums')).toBeNull();
  });

  it('klappt die Vorschau in der Karte auf', () => {
    stubPhone(true);
    const { container } = tabelle({
      offen: 'a',
      vorschau: [{ key: 'plan', label: 'Heute geplant', text: 'Mittags laden.' }],
    });
    expect(container.querySelector('.vp-at-karte-vor')).toBeTruthy();
    expect(screen.getByText('Mittags laden.')).toBeTruthy();
  });

  it('öffnet die Anlage über die Karte und klappt Details nur über den Chevron auf', () => {
    stubPhone(true);
    const onOeffnen = vi.fn();
    const onToggle = vi.fn();
    const { container } = tabelle({ onOeffnen, onToggle });

    fireEvent.click(container.querySelector('.vp-at-karte-nums')!);
    expect(onOeffnen).toHaveBeenCalledWith('a');

    fireEvent.click(screen.getByRole('button', { name: 'Details zu Filiale Nord anzeigen' }));
    expect(onToggle).toHaveBeenCalledWith('a');
    expect(onOeffnen).toHaveBeenCalledTimes(1);
  });
});
