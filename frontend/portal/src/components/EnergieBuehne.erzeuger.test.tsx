import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EnergieBuehne } from './EnergieBuehne';
import { erzeugerBuehne, erzeugerLage } from '../erzeuger';
import { tagAus } from '../tagesleiste';
import { erzeugerBeispiel, type ErzeugerFall } from '../test/erzeugerFixtures';

/**
 * Die Bühne einer Erzeugeranlage (EZ-8): Satz zur Vorgabe, oberer Knoten „Erzeugung“ mit Motor oder
 * Sonne, Netz aus dem Netzpunkt des Bilds, „Hof“ = Erzeugung + Netzpunkt - ohne Netzpunkt (EW-16 C)
 * stehen Netz und Hof als „—“, nie 0. Darunter die Spuren der Vorgaben und die Erzeugung je Einheit.
 */
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;

const NOW = new Date(2026, 9, 21, 15, 44, 0);
const sp = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ');

function buehne(fall: ErzeugerFall) {
  const j = erzeugerBeispiel(fall, NOW);
  const tag = tagAus(null, null, NOW);
  const erz = erzeugerBuehne(j, erzeugerLage(j, NOW), tag, NOW);
  return render(<EnergieBuehne jetzt={erz.jetzt} betrieb="eigenverbrauch" tag={tag} isPhone={false} now={NOW} erzeuger={erz} />);
}

describe('EnergieBuehne · Erzeugeranlage', () => {
  it('Büttner: Motor, zwei Motoren, Netz und Hof unbekannt - nie 0', () => {
    const { container } = buehne('buettner');
    expect(sp(container.querySelector('.vp-eb-satz')?.textContent)).toBe('Der Netzbetreiber begrenzt die Anlage auf 60 %. Sie erzeugt 58,9 kW.');
    const knoten = (name: RegExp) => sp(screen.getByRole('button', { name }).getAttribute('aria-label'));
    expect(knoten(/^Erzeugung:/)).toBe('Erzeugung: 58,9 kW, Erzeugung · 2 Motoren');
    expect(knoten(/^Netz:/)).toBe('Netz: —, ohne Messung');
    expect(knoten(/^Hof:/)).toBe('Hof: —, Hof');
    expect(container.textContent).not.toMatch(/0,0\s?kW/);
    // Ohne Netzpunkt gibt es keine Aufteilung, also keine Spuren - und keinen Speicher.
    expect(container.querySelectorAll('.vp-lp-spur')).toHaveLength(0);
    expect(container.querySelector('.vp-lp-batt')).toBeNull();
  });

  it('Gore: Sonne, drei WR, Bezug am Netzpunkt und Verbrauch = Erzeugung + Netzpunkt', () => {
    buehne('gore');
    expect(screen.getByText('Die Anlage begrenzt sich selbst: Am Netzpunkt fließt nichts ins Netz.')).toBeInTheDocument();
    expect(sp(screen.getByRole('button', { name: /^Netz:/ }).getAttribute('aria-label'))).toBe('Netz: 0,1 kW, Bezug');
    expect(sp(screen.getByRole('button', { name: /^Verbrauch:/ }).getAttribute('aria-label'))).toBe('Verbrauch: 41,1 kW, Verbrauch');
  });

  it('die Tagesleiste trägt die Spuren der Vorgaben und liest sie für die gewählte Viertelstunde vor', () => {
    const { container } = buehne('buettner');
    expect([...container.querySelectorAll('.vp-tl-vorgabe')].map((g) => g.textContent)).toEqual(['Netzbetreiber', 'Direktverm.']);
    expect(screen.getByRole('slider', { name: 'Tageszeit' }).getAttribute('aria-valuetext')).toBe('15:30 Uhr, jetzt, Vorgabe: Netzbetreiber, Direktvermarkter');
  });

  it('„Erzeugung im Detail“ je Motor; ein Tipp öffnet das Blatt der Erzeugung mit derselben Liste', async () => {
    const { container } = buehne('buettner');
    const liste = container.querySelector('.vp-eb-listen') as HTMLElement;
    expect(within(liste).getByText('Erzeugung im Detail')).toBeInTheDocument();
    expect(sp(liste.textContent)).toContain('Motor 1 · MAN E0836LE Soll 39,6 kW · läuft begrenzt39,6 kW');
    fireEvent.click(within(liste).getAllByRole('button')[0]);
    const blatt = await screen.findByRole('dialog', { name: 'Erzeugung' });
    expect(within(blatt).getByText('Motor 2 · Smartblock 33')).toBeInTheDocument();
  });
});
