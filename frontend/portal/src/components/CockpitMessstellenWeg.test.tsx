import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { FIXTURE_IDS } from '../test/standorteFixtures';
import { CockpitMessstellenWeg } from './CockpitMessstellenWeg';

/**
 * UEMS AP-13 IP-11 (E2 = A, Q4, O18) — der EINE Weg, den das Anlagen-Cockpit bekommt. Gemessen wird beides:
 * dass er DA ist, wenn die Anlage Messstellen hat, und dass ein reiner Betriebskunde nichts Neues bekommt —
 * kein Wort, kein Platzhalter und nicht einmal eine Anfrage.
 */
describe('CockpitMessstellenWeg · der EINE Weg unter der Bühne (AP-13 IP-11, O18)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('nennt die Zählung des Registers und führt in genau diese Anlage', async () => {
    const register = vi.spyOn(api, 'messstellenRegister').mockResolvedValue(ahrenbergRegister({ anlage: FIXTURE_IDS.an1 }));
    render(<CockpitMessstellenWeg siteId={FIXTURE_IDS.an1} misst />);
    const weg = await screen.findByTestId('cockpit-messstellen-weg');
    expect(weg).toHaveAttribute('href', `#/portfolio/messstellen?anlage=${FIXTURE_IDS.an1}`);
    expect(weg).toHaveTextContent('Messstellen dieser Anlage');
    expect(weg.textContent).toMatch(/\d+ von \d+ Messstellen? liefer[nt] Daten/);
    // Gefragt wird NUR diese Anlage — die Zählung des Cockpits ist die seiner Messstellen, nicht die des Hauses.
    expect(register).toHaveBeenCalledWith({ anlage: FIXTURE_IDS.an1 });
  });

  it('ein Betriebskunde ohne Messfunktion sieht nichts — und die Fläche fragt gar nicht erst', () => {
    const register = vi.spyOn(api, 'messstellenRegister');
    const { container } = render(<CockpitMessstellenWeg siteId={FIXTURE_IDS.an1} misst={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(register).not.toHaveBeenCalled();
  });

  it('eine Anlage ohne Messstelle bekommt keinen Weg — und eine Störung lässt das Cockpit, wie es war', async () => {
    const leer = ahrenbergRegister();
    vi.spyOn(api, 'messstellenRegister').mockResolvedValue({
      ...leer,
      register: [],
      aggregat: { ...leer.aggregat, unternehmen: { erfuellt: 0, gesamt: 0, text: 'Noch keine Messstellen' } },
    });
    const { container, rerender } = render(<CockpitMessstellenWeg siteId={FIXTURE_IDS.an2} misst />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());

    vi.spyOn(api, 'messstellenRegister').mockRejectedValue(new Error('Cloud gerade nicht erreichbar'));
    rerender(<CockpitMessstellenWeg siteId={FIXTURE_IDS.an3} misst />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
