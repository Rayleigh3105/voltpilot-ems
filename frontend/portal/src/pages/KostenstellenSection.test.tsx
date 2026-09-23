import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { ALLE_NICHT_ABRUFBAR, KEINE_SUMME, MENGEN_RECHT, MENGEN_ROLLEN, OHNE_MENGEN } from '../kostenstellenUebersicht';
import { setSelbstauskunft } from '../rollen';
import { ahrenbergKostenstelleEnergie } from '../test/kostenstellenFixtures';
import { kostenstellenAhrenberg } from '../test/messstelleSeiteFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import matrixDatei from '../../../../docs/contracts/v2/rechte-matrix.json';
import { KostenstellenReiter } from './KostenstellenSection';

/**
 * Kostenstelle B (21.09.2026) am Reiter „Kostenstellen“: unternehmensweit wie bisher; ein standortbeschränkter
 * Bearbeiter sieht Kennzeichen und Namen mit EINEM Satz, wer die Mengen sieht, und fragt `…/energie` nie; ein echter
 * Fehler bleibt die Störungsmeldung mit „Erneut versuchen“.
 */

const wahl = { periode: 'monat' as const, am: '2026-10-01' };

async function zeige() {
  render(<KostenstellenReiter katalog={kostenstellenAhrenberg()} wahl={wahl} heute="2026-11-05" onWahl={() => {}} />);
  await act(async () => {});
}

afterEach(() => vi.restoreAllMocks());

describe('Kostenstellen-Reiter nach Recht', () => {
  it('unternehmensweit (Kundenadministrator): Mengen je Karte wie bisher, kein Satz ohne Mengen', async () => {
    const energie = vi.spyOn(api, 'kostenstelleEnergie').mockImplementation(async (id, p, am) => ahrenbergKostenstelleEnergie(id, p, am));
    await zeige();
    expect(energie).toHaveBeenCalled();
    expect(screen.getByTestId('kostenstellen-keine-summe').textContent).toBe(KEINE_SUMME);
    expect(screen.queryByTestId('kostenstellen-ohne-mengen')).toBeNull();
    expect(screen.getAllByTestId('block-summe').length).toBeGreaterThan(0);
  });

  it('Doppelt gezählt: der Satz steht am Kopf der Karte UND an jedem Posten, der schon in der Summe steckt', async () => {
    vi.spyOn(api, 'kostenstelleEnergie').mockImplementation(async (id, p, am) => ahrenbergKostenstelleEnergie(id, p, am));
    await zeige();
    const karte = screen.getAllByTestId('kostenstelle-karte').find((k) => k.getAttribute('data-kennzeichen') === '4100');
    expect(karte?.querySelector('[data-testid="doppelzaehlung"]')?.textContent).toContain('MS-07 ist bereits in MS-20 enthalten (Anteil 70 %)');
    const amPosten = [...(karte?.querySelectorAll('[data-testid="posten-doppelt"]') ?? [])].map((n) => n.textContent);
    expect(amPosten).toEqual([
      'MS-06 ist bereits in MS-20 enthalten',
      'MS-11 ist bereits in MS-20 enthalten',
      'MS-07 ist bereits in MS-20 enthalten (Anteil 70 %)',
    ]);
    expect(screen.getAllByTestId('posten-doppelt')).toHaveLength(3);
  });

  it('Bearbeiter an einem Standort: Kennzeichen und Namen, EIN Satz mit Rollen und Kundenadministrator, kein Aufruf von …/energie', async () => {
    setSelbstauskunft(rechteSeed('PH').me);
    const energie = vi.spyOn(api, 'kostenstelleEnergie');
    await zeige();
    expect(energie).not.toHaveBeenCalled();
    expect(screen.getByTestId('kostenstellen-ohne-mengen').textContent).toBe(`${OHNE_MENGEN} Ihr Kundenadministrator: Jonas Wendlinger.`);
    const karten = screen.getAllByTestId('kostenstelle-karte');
    expect(karten.map((k) => k.getAttribute('data-kennzeichen'))).toContain('4200');
    expect(karten.find((k) => k.getAttribute('data-kennzeichen') === '4200')?.textContent).toContain('Montage');
    for (const leer of ['block-summe', 'nicht-verteilt', 'kostenstellen-keine-summe']) expect(screen.queryByTestId(leer)).toBeNull();
    expect(screen.queryByText(ALLE_NICHT_ABRUFBAR)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('echter Fehler (503) bei unternehmensweiter Sicht: weiter die Störungsmeldung mit „Erneut versuchen“', async () => {
    vi.spyOn(api, 'kostenstelleEnergie').mockRejectedValue(new ApiError(503, 'Nicht erreichbar'));
    await zeige();
    expect(screen.getByText(ALLE_NICHT_ABRUFBAR)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeTruthy();
    expect(screen.queryByTestId('kostenstellen-ohne-mengen')).toBeNull();
  });

  it('der Satz nennt genau die Rollen, die `messwerte.ansehen` unternehmensweit tragen (rechte-matrix.json)', () => {
    const zeile = (matrixDatei as { aktionen: { kennung: string; zellen: Record<string, string> }[] }).aktionen.find((a) => a.kennung === MENGEN_RECHT);
    const mitU = Object.entries(zeile?.zellen ?? {}).filter(([, z]) => z === 'U').map(([r]) => r).sort();
    expect(mitU).toEqual([...MENGEN_ROLLEN].sort());
  });
});
