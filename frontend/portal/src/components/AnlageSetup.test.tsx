import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageSetup } from './AnlageSetup';
import { api, ApiError, type Site, type SiteEntities } from '../api';
import { entitiesApi } from '../entitiesApi';

/**
 * M5 (#533) — die Render-Hälfte des Einrichtungspfads. Die erschöpfende
 * Zustandsdeckung liegt in `setupPath.test.ts`; hier wird bewiesen, dass die
 * KETTE funktioniert: gemeldetes Gerät → geführte Übernahme (katalog-geführt,
 * keine freie Typwahl) → Brücke „übernommen — Regel dafür anlegen?".
 */

const site: Site = {
  id: 's-1',
  name: 'Meine neue Anlage',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

function entitiesWith(sources: SiteEntities['localSetup']): SiteEntities {
  return { registry: null, entities: [], localSetup: sources, staleOnDevice: [] };
}

const GOE: SiteEntities['localSetup'][number] = {
  id: 'goe-1',
  kind: 'source',
  role: 'consumer',
  brand: 'go-e',
  label: 'Charger',
  reportedAt: '2026-07-21T10:00:00Z',
  adoptedEntityId: null,
};

function renderSetup(over: Partial<Parameters<typeof AnlageSetup>[0]> = {}) {
  return render(
    <AnlageSetup
      site={site}
      deviceCount={1}
      onOpenSteuerung={() => {}}
      onOpenGeraete={() => {}}
      onReload={() => {}}
      onStay={() => {}}
      {...over}
    />,
  );
}

describe('AnlageSetup - die Anlege-Kette', () => {
  it('zeigt die drei Schritte statt Platzhalter-Karten', async () => {
    vi.spyOn(api, 'siteEntities').mockResolvedValue(entitiesWith([]));
    const { container } = renderSetup({ deviceCount: 0 });
    await waitFor(() => expect(container.querySelectorAll('.vp-setup-step')).toHaveLength(3));
    expect(screen.getByText('Ihr Weg zum fertigen EMS')).toBeInTheDocument();
    expect(screen.getAllByText('Gerät verbinden').length).toBeGreaterThan(0);
    expect(screen.getByText('Geräte übernehmen')).toBeInTheDocument();
    expect(screen.getByText('Steuerung wählen')).toBeInTheDocument();
  });

  it('bietet das gemeldete Gerät katalog-geführt an - ohne freie Typwahl', async () => {
    vi.spyOn(api, 'siteEntities').mockResolvedValue(entitiesWith([GOE]));
    renderSetup();
    await waitFor(() => expect(screen.getByText('Als Wallbox übernehmen')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Als Wallbox übernehmen'));
    // Die geführte Übernahme fragt NUR, was der Kunde weiß - kein Typ-Select,
    // keine Guard-Konfiguration.
    await waitFor(() => expect(screen.getByLabelText(/Anschlussleistung/)).toBeInTheDocument());
    expect(document.querySelector('select')).toBeNull();
    expect(screen.queryByLabelText(/Guard|Grenze/i)).toBeNull();
  });

  it('übernimmt und schlägt danach die Regel vor (die Brücke)', async () => {
    vi.spyOn(api, 'siteEntities').mockResolvedValue(entitiesWith([GOE]));
    const adopt = vi
      .spyOn(entitiesApi, 'adopt')
      .mockResolvedValue({ id: 'e-1', entityType: 'wallbox', role: 'wallbox', label: null, deviceId: null });
    const onStay = vi.fn();
    const onOpenSteuerung = vi.fn();
    renderSetup({ onStay, onOpenSteuerung });

    await waitFor(() => expect(screen.getByText('Als Wallbox übernehmen')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Als Wallbox übernehmen'));
    await waitFor(() => expect(screen.getByLabelText(/Anschlussleistung/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Anschlussleistung/), { target: { value: '11' } });
    fireEvent.click(screen.getByText('Übernehmen'));

    await waitFor(() => expect(screen.getByText('Regel dafür anlegen?')).toBeInTheDocument());
    expect(adopt).toHaveBeenCalledWith('s-1', expect.objectContaining({
      sourceId: 'goe-1',
      entityType: 'wallbox',
      maxPowerKw: 11,
    }));
    // Der Pfad bleibt stehen, bis der Kunde weitergeht.
    expect(onStay).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByText('Regel dafür anlegen?'));
    expect(onOpenSteuerung).toHaveBeenCalled();
    expect(onStay).toHaveBeenLastCalledWith(false);
  });

  it('bleibt ehrlich, wenn das Backend die Übernahme nicht erlaubt', async () => {
    vi.spyOn(api, 'siteEntities').mockResolvedValue(entitiesWith([GOE]));
    vi.spyOn(entitiesApi, 'adopt').mockRejectedValue(new ApiError(403, 'nope'));
    renderSetup();
    await waitFor(() => expect(screen.getByText('Als Wallbox übernehmen')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Als Wallbox übernehmen'));
    await waitFor(() => expect(screen.getByText('Übernehmen')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Übernehmen'));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('VoltPilot'),
    );
  });

  it('sagt ehrlich, wenn das Gerät noch nichts meldet', async () => {
    vi.spyOn(api, 'siteEntities').mockResolvedValue(entitiesWith([]));
    renderSetup();
    await waitFor(() =>
      expect(screen.getByText(/meldet noch keine Geräte/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/^Als .* übernehmen$/)).toBeNull();
  });

  it('überlebt ein älteres Backend ohne Entitäts-Endpunkt', async () => {
    vi.spyOn(api, 'siteEntities').mockRejectedValue(new ApiError(404, 'nope'));
    const { container } = renderSetup();
    await waitFor(() => expect(container.querySelectorAll('.vp-setup-step')).toHaveLength(3));
  });
});
