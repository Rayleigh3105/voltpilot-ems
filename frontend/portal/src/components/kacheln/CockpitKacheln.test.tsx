import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryTotals, SiteEarnings } from '../../api';
import FIXTURES from '../../erloeseFixtures.json';
import { speicherAussage } from '../../speicherAussage';
import { AutarkieKachel, FahrplanKachel, GeldKachel, NetzKachel, WertKachel } from './CockpitKacheln';

/**
 * Die Kacheln unter der Bühne (Konzept „Cockpit als Tagesfilm“): eine Hülle
 * mit Kopf als Absprung, darunter der Inhalt. Die Geldzahl ist dieselbe
 * Erlöskarte wie auf der Erlöse-Seite - abgeleitet, nie abgeschrieben.
 */
const SPEICHER = (() => {
  const f = (FIXTURES.fixtures as unknown as Array<{ id: string; now: string; money: SiteEarnings }>).find(
    (x) => x.id === 'dv-tag-laufend',
  )!;
  return speicherAussage(f.money, { now: new Date(f.now) })!;
})();

const MONEY = {
  label: 'Unterm Strich · Heute',
  value: '371,43 €',
  kosten: false,
  speicher: SPEICHER,
  attribution: 'Steuerung + 12,10 €',
};

describe('Die Hülle', () => {
  it('der Kopf ist der Absprung, die Leitkachel trägt den Stern', () => {
    const onOpen = vi.fn();
    const { container, getByRole } = render(
      <WertKachel id="wetter" name="Wetter" icon="thermometer" ton="neutral" wert="25,0 °C" sub="sonnig" lead onOpen={onOpen} />,
    );
    fireEvent.click(getByRole('button', { name: /Wetter/ }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(container.querySelector('.vp-k.is-lead .vp-k-stern')).not.toBeNull();
    expect(container.querySelector('.vp-k-platz.is-klein')).not.toBeNull();
  });
});

describe('Unterm Strich', () => {
  it('die eine Geldzahl, der gemessene Speicherbestand steht als eigene Zeile, nie in der Kasse', () => {
    const { container } = render(<GeldKachel money={MONEY} periodSeg={<div className="vp-seg" />} />);
    expect(container.querySelector('.vp-k-platz.is-breit')).not.toBeNull();
    expect(container.querySelector('.vp-c-stm-zahl')?.textContent).toBe('371,43 €');
    const bestand = container.querySelector('.vp-c-sp-bestand');
    expect(bestand?.textContent).toContain('35,8');
    expect(bestand?.querySelector('.vp-chip')?.textContent).toBe('Kein Abzug');
    // Autarkie und Eigenverbrauch sind eigene Kacheln - keine Ringe hier.
    expect(container.querySelector('.vp-c-ck-ring')).toBeNull();
  });

  it('färbt ein negatives Netto und behält sein Vorzeichen im Text', () => {
    const { container } = render(<GeldKachel money={{ ...MONEY, value: '− 4,12 €', kosten: true }} />);
    const zahl = container.querySelector('.vp-c-stm-zahl');
    expect(zahl?.classList.contains('is-kosten')).toBe(true);
    expect(zahl?.textContent).toContain('−');
  });

  it('ohne Geld und ohne Zeitraum gibt es keine Kachel', () => {
    const { container } = render(<GeldKachel money={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('Kacheln ohne Daten', () => {
  it('fehlt die Kennzahl, fehlt die Kachel - nie „0 %“', () => {
    const { container } = render(
      <>
        <AutarkieKachel totals={{ autarkiePct: null } as unknown as HistoryTotals} tag={null} />
        <NetzKachel totals={null} />
      </>,
    );
    expect(container.textContent).toBe('');
  });

  it('der Fahrplan sagt ohne Plan, warum er leer ist', () => {
    const { container } = render(<FahrplanKachel tag={null} kind="eigenverbrauch" leer="Der Plan wird geladen …" />);
    expect(container.textContent).toContain('Der Plan wird geladen');
  });

  it('Autarkie mit Kennzahl: Prozent und Legende nach Herkunft', () => {
    const { container } = render(
      <AutarkieKachel totals={{ autarkiePct: 65.2 } as unknown as HistoryTotals} tag={null} />,
    );
    expect(container.querySelector('.vp-k-gross')?.textContent).toBe('65%');
    expect(container.querySelector('.vp-k-legende')?.textContent).toContain('Netz');
  });
});
