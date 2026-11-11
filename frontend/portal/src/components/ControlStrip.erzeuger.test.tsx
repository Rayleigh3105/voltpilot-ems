import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ControlStrip, type ErzeugerZeile } from './ControlStrip';
import { erzeugerBlatt, erzeugerKette, erzeugerLage, geregeltHeute } from '../erzeuger';
import { erzeugerBeispiel, vorgabenHeuteBeispiel, type ErzeugerFall } from '../test/erzeugerFixtures';
import type { ExportGuardView } from '../curtailment';

/**
 * Die Steuerzeile einer Erzeugeranlage (EZ-8, EW-11 A): dieselbe Zeile und dieselbe Geste wie beim
 * Speicher, aber die Kette Netzbetreiber › Direktvermarkter › Anlage; das Blatt zeigt die ganze Kette.
 */
const NOW = new Date(2026, 9, 21, 15, 44, 0);
const sp = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ');

function zeile(fall: ErzeugerFall): ErzeugerZeile {
  const j = erzeugerBeispiel(fall, NOW);
  const l = erzeugerLage(j, NOW);
  const mitternacht = new Date(NOW);
  mitternacht.setHours(0, 0, 0, 0);
  return { kette: erzeugerKette(l, NOW), blatt: erzeugerBlatt(l, NOW, geregeltHeute(vorgabenHeuteBeispiel(fall, NOW), l, mitternacht.getTime())) };
}

describe('ControlStrip · Erzeugeranlage', () => {
  it('am Rechner: die Kette in ganzen Wörtern, die Pille sagt, wer strenger ist', () => {
    const { container } = render(<ControlStrip view={null} variant="zeile" erzeuger={zeile('buettner')} />);
    expect(sp(container.querySelector('.vp-steuer-kette')?.textContent)).toBe(
      'Netzbetreiber 60 %›Direktvermarkter 80,0 kW›Anlage 58,9 kWDaten 3 s alt',
    );
    expect(container.querySelector('.vp-steuer-hinweis.is-info')?.textContent).toBe('NB strenger');
    // Die Anlage folgt: das letzte Glied trägt den Haken (grün), keine Warnung.
    expect(container.querySelectorAll('.vp-steuer-glied.tone-ok')).toHaveLength(1);
    expect(container.querySelector('.vp-steuer-glied.tone-warn')).toBeNull();
  });

  it('am Telefon: „NB“ und „DV“ sichtbar, die ganzen Wörter für den Bildschirmleser', () => {
    const { container } = render(<ControlStrip view={null} variant="zeile" isPhone erzeuger={zeile('buettner')} />);
    const glieder = [...container.querySelectorAll('.vp-steuer-glied')];
    expect(glieder.map((g) => sp(g.querySelector('[aria-hidden="true"]:not(svg)')?.textContent))).toEqual(['NB 60 %', 'DV 80,0 kW', '']);
    expect(sp(glieder[0].querySelector('.vp-sr-only')?.textContent)).toBe('Netzbetreiber 60 %');
  });

  it('Gore: gehaltene Vorgabe als Hinweis, die eigene Grenze als mittleres Glied', () => {
    const { container } = render(<ControlStrip view={null} variant="zeile" erzeuger={zeile('gore')} />);
    expect(container.querySelector('.vp-steuer-hinweis:not(.is-info)')?.textContent).toBe('1 Hinweis');
    expect(sp(container.querySelector('.vp-steuer-glied.tone-warn')?.textContent)).toBe('Netzbetreiber 100 % (gehalten)');
    expect(sp(container.querySelector('.vp-steuer-kette')?.textContent)).toContain('Nulleinspeisung 41,2 kW');
  });

  it('„Warum?“ zeigt die ganze Kette, Warum und Grenze - und führt zur Steuerung', async () => {
    const onOpenSub = vi.fn();
    const guard: ExportGuardView = { line: 'Einspeisegrenze 99,0 kW.', kurz: 'Einspeisegrenze 99,0 kW', tone: 'ok', agoNote: '', deviceLimitLine: null };
    render(<ControlStrip view={null} variant="zeile" guard={guard} erzeuger={zeile('buettner')} onOpenSub={onOpenSub} />);
    fireEvent.click(screen.getByRole('button', { name: /Warum\?/ }));
    const blatt = await screen.findByRole('dialog', { name: 'Steuerung jetzt' });
    const zeilen = [...blatt.querySelectorAll('.vp-ez-zeilen li')].map((li) => sp(li.textContent));
    expect(zeilen).toEqual([
      'NetzbetreiberNetz Musterstadt GmbH · Stufe 60 % · seit 14:3259,4 kW',
      'DirektvermarkterStadtwerke Beispiel · Abruf seit 13:05 · bereit ✓80,0 kW',
      'Anlagefolgt ✓ · 2 von 2 Motoren laufen58,9 kW',
    ]);
    expect(sp(within(blatt).getByRole('img').getAttribute('aria-label'))).toBe(
      sp('Erzeugung 58,9 kW von 99,0 kW, Grenze des Netzbetreibers 59,4 kW, Sollwert des Direktvermarkters 80,0 kW'),
    );
    expect(sp(within(blatt).getByText(/strenger als der Direktvermarkter/).textContent)).toBe('59,4 kW – der Netzbetreiber ist strenger als der Direktvermarkter');
    expect(within(blatt).getByText('Netzbetreiber 2× · Direktvermarkter 1×')).toBeInTheDocument();
    // Die stehende Einspeisegrenze der Anlage gehört in „Grenze“, neben die wirksame Grenze.
    expect(within(blatt).getByText('Einspeisegrenze 99,0 kW.')).toBeInTheDocument();
    fireEvent.click(within(blatt).getByRole('button', { name: /Zur Steuerung/ }));
    expect(onOpenSub).toHaveBeenCalledWith('steuerung');
  });

  it('ohne Speicher-Auftrag und ohne Einspeisegrenze steht die Zeile trotzdem da', () => {
    const { container } = render(<ControlStrip view={null} variant="zeile" erzeuger={zeile('gore')} />);
    expect(container.querySelector('.vp-steuer')).not.toBeNull();
    expect(render(<ControlStrip view={null} variant="zeile" />).container.firstChild).toBeNull();
  });
});
