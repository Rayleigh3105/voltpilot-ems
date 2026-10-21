import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ENTITY_GORE, GERAET_GORE, goreGeraet, goreWerte, JETZT, SITE_GORE } from '../test/anlagensteuerungFixtures';
import { GeraetHerkunft } from './GeraetHerkunft';

/**
 * Geräteseite › „Gerät & Verbindung“ einer Anlagensteuerung (UEMS EZ-10 (2)): die Einheiten an der Karte „Gerät“
 * wie die Energiekarten an einer WAGO-Steuerung, mit Zustand aus den Werten; dazu Netzpunkt und Datenstand.
 */
afterEach(() => vi.restoreAllMocks());

function gore(werte = goreWerte()) {
  vi.spyOn(api, 'uemsGeraete').mockResolvedValue({ geraete: [goreGeraet()] });
  vi.spyOn(api, 'komponenteMesskanaele').mockResolvedValue({ messkanaele: [] } as never);
  vi.spyOn(api, 'geraetEinstellungen').mockResolvedValue({ gueltig: [], historie: [] } as never);
  const lesen = vi.spyOn(api, 'anlagensteuerungWerte').mockResolvedValue(werte);
  render(<GeraetHerkunft siteId={SITE_GORE} komponenten={[{ entityId: ENTITY_GORE, label: 'Anlagensteuerung Gore' }]} jetzt={JETZT} />);
  return lesen;
}

describe('AnlagensteuerungEinheiten', () => {
  it('die Wechselrichter stehen als Erzeugungseinheiten, nie als Energiekarten', async () => {
    const lesen = gore();
    const karte = await screen.findByTestId('geraet-karte');
    expect(within(karte).getByText('Erzeugungseinheiten')).toBeInTheDocument();
    expect(within(karte).queryByText('Energiekarten')).not.toBeInTheDocument();
    expect(lesen).toHaveBeenCalledWith(SITE_GORE, GERAET_GORE);
    const einheiten = within(karte).getByTestId('geraet-einheiten');
    expect(within(einheiten).getByText('Wechselrichter 1')).toBeInTheDocument();
    expect(within(einheiten).getByText('WR Dach Nord')).toBeInTheDocument();
    expect(await within(einheiten).findByText(/PV-Wechselrichter · Growatt MAX 125KTL3-X · 125.kW · läuft begrenzt/)).toBeInTheDocument();
  });

  it('Netzpunkt und Datenstand als Zeilen', async () => {
    gore();
    const anlage = await screen.findByTestId('geraet-anlagensteuerung');
    expect(await within(anlage).findByText(/speist 41,2.kW ein/)).toBeInTheDocument();
    expect(within(anlage).getByText(/gemessen · Messung 3.s alt/)).toBeInTheDocument();
    expect(within(anlage).getByText('Datenstand')).toBeInTheDocument();
  });
});
