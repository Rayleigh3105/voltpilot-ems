import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ModusContainer } from './ModusContainer';
import { activeModes, type ActiveMode } from '../surface';
import type { SiteProfile } from '../profiles';
import { api, type Site, type SiteAsset } from '../api';

/** The market mode (masterdata-driven), with its four claimed settings + views. */
function marktMode(): ActiveMode {
  const mode = activeModes({
    config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
  }).find((m) => m.kind === 'marktvermarktung');
  if (!mode) throw new Error('expected a marktvermarktung mode');
  return mode;
}

function profile(over: Partial<SiteProfile> & { id: string; label: string }): SiteProfile {
  return {
    state: null,
    derivedActive: false,
    active: false,
    unlocks: { views: [], widgets: [], moneyStream: null },
    requirements: [],
    blockedReason: null,
    origin: null,
    flowRef: null,
    gatedNodeTypes: [],
    gatedNodesEnabled: true,
    ...over,
  };
}

function site(over: Partial<Site> = {}): Site {
  return {
    id: 's-1',
    name: 'Solarpark Dachau',
    biddingZone: 'DE-LU',
    latitude: 48.26,
    longitude: 11.43,
    plantKind: 'direktvermarktung',
    anzulegenderWertCtKwh: 8.11,
    tarifArt: 'dynamisch',
    tarifParamCtKwh: 18,
    netzladenErlaubt: false,
    maxFeedInKw: 75,
    ...over,
  };
}

function battery(over: Partial<SiteAsset> = {}): SiteAsset {
  return {
    id: 'a-batt',
    type: 'battery',
    deviceId: 'd-1',
    capacityKwh: 10,
    maxChargeKw: 5,
    maxDischargeKw: 5,
    roundtripEfficiencyPct: null,
    speicherschonung: 'ausgewogen',
    pvCapacityKwp: null,
    moduleCount: null,
    azimuthDeg: null,
    tiltDeg: null,
    commissionedOn: null,
    registry: null,
    registryUnitId: null,
    registryFetchedAt: null,
    ...over,
  };
}

const NOOP = {
  onToggle: vi.fn(),
  onBack: vi.fn(),
  onNavigate: vi.fn(),
  onOpenFlow: vi.fn(),
  onSiteSaved: vi.fn(),
  onBatterySaved: vi.fn(),
};

describe('ModusContainer (v3.1-M2 shell)', () => {
  it('an ACTIVE mode shows its settings and the mode’s views', () => {
    const mode = marktMode();
    render(
      <ModusContainer
        profile={profile({ id: 'marktvermarktung', label: 'Marktvermarktung', active: true, origin: 'masterdata' })}
        mode={mode}
        activeModes={[mode]}
        site={site()}
        battery={battery()}
        earnings={null}
        busy={false}
        {...NOOP}
      />,
    );

    // Settings section renders the claimed settings' rows.
    expect(screen.getByText('Einstellungen')).toBeInTheDocument();
    expect(screen.getByText('Netzladen des Speichers')).toBeInTheDocument();
    expect(screen.getByText('Anzulegender Wert')).toBeInTheDocument();

    // The mode's own views (= the sidebar group's entries).
    expect(screen.getByText('Ansichten dieses Modus')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fahrplan/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Marktpreise/ })).toBeInTheDocument();

    // A masterdata mode is honestly labelled and never promises an editable flow.
    expect(screen.getByText('Von VoltPilot eingerichtet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Flow öffnen/ })).toBeNull();
  });

  it('clicking a view navigates via onNavigate (active mode)', () => {
    const mode = marktMode();
    const onNavigate = vi.fn();
    render(
      <ModusContainer
        profile={profile({ id: 'marktvermarktung', label: 'Marktvermarktung', active: true })}
        mode={mode}
        activeModes={[mode]}
        site={site()}
        battery={battery()}
        earnings={null}
        busy={false}
        {...NOOP}
        onNavigate={onNavigate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Fahrplan/ }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'sub', sub: 'fahrplan' });
  });

  it('an INACTIVE mode shows NO settings section (owner correction: no teaser)', () => {
    render(
      <ModusContainer
        profile={profile({
          id: 'marktvermarktung',
          label: 'Marktvermarktung',
          active: false,
          requirements: [{ label: 'Dynamischer Tarif', met: false }],
        })}
        mode={null}
        activeModes={[]}
        site={site()}
        battery={battery()}
        earnings={null}
        busy={false}
        {...NOOP}
      />,
    );

    // No settings at all - not a locked teaser.
    expect(screen.queryByText('Einstellungen')).toBeNull();
    expect(screen.queryByText('Netzladen des Speichers')).toBeNull();

    // But benefit, prerequisites and the mode's views still render.
    expect(screen.getByText('Voraussetzungen')).toBeInTheDocument();
    expect(screen.getByText(/Dynamischer Tarif fehlt/)).toBeInTheDocument();
    expect(screen.getByText('Ansichten dieses Modus')).toBeInTheDocument();
    // Inactive views are shown but not clickable (no empty-state landings).
    expect(screen.queryByRole('button', { name: /Fahrplan/ })).toBeNull();
    expect(screen.getByText(/sobald Sie den Modus einschalten/)).toBeInTheDocument();
  });

  it('the head switch toggles the mode without navigating away', () => {
    const onToggle = vi.fn();
    const onBack = vi.fn();
    render(
      <ModusContainer
        profile={profile({ id: 'marktvermarktung', label: 'Marktvermarktung', active: false })}
        mode={null}
        activeModes={[]}
        site={site()}
        battery={battery()}
        earnings={null}
        busy={false}
        {...NOOP}
        onToggle={onToggle}
        onBack={onBack}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: /Marktvermarktung einschalten/ }));
    expect(onToggle).toHaveBeenCalledWith('marktvermarktung', 'an');
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe('ModusContainer settings editing (v3.1-M3)', () => {
  /** Opens the inline editor of the setting row whose label matches `label`. */
  function openEditor(label: string): HTMLElement {
    const row = screen.getByText(label).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Bearbeiten/ }));
    return row;
  }

  it('edits Netzladen and saves the FULL site payload (never blanks a Technik field)', async () => {
    const s = site({ netzladenErlaubt: false });
    const updateSite = vi.spyOn(api, 'updateSite').mockResolvedValue({ ...s, netzladenErlaubt: true });
    const onSiteSaved = vi.fn();
    const mode = marktMode();
    render(
      <ModusContainer
        profile={profile({ id: 'marktvermarktung', label: 'Marktvermarktung', active: true })}
        mode={mode}
        activeModes={[mode]}
        site={s}
        battery={battery()}
        earnings={null}
        busy={false}
        {...NOOP}
        onSiteSaved={onSiteSaved}
      />,
    );

    openEditor('Netzladen des Speichers');
    fireEvent.change(screen.getByLabelText('Netzladen des Speichers'), {
      target: { value: 'erlaubt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(onSiteSaved).toHaveBeenCalled());
    // THE regression guard: the container save is a FULL representation, so a
    // focused tariff-field save carries EVERY Technik field through unchanged -
    // name, coords, plant kind AND the maximale Einspeiseleistung are not blanked.
    expect(updateSite).toHaveBeenCalledWith('s-1', {
      name: 'Solarpark Dachau',
      biddingZone: 'DE-LU',
      latitude: 48.26,
      longitude: 11.43,
      plantKind: 'direktvermarktung',
      anzulegenderWertCtKwh: 8.11,
      tarifArt: 'dynamisch',
      tarifParamCtKwh: 18,
      netzladenErlaubt: true,
      maxFeedInKw: 75,
    });
    updateSite.mockRestore();
  });

  it('edits the anzulegender Wert and saves the full payload', async () => {
    const s = site({ anzulegenderWertCtKwh: 8.11 });
    const updateSite = vi.spyOn(api, 'updateSite').mockResolvedValue(s);
    const onSiteSaved = vi.fn();
    const mode = marktMode();
    render(
      <ModusContainer
        profile={profile({ id: 'marktvermarktung', label: 'Marktvermarktung', active: true })}
        mode={mode}
        activeModes={[mode]}
        site={s}
        battery={battery()}
        earnings={null}
        busy={false}
        {...NOOP}
        onSiteSaved={onSiteSaved}
      />,
    );

    openEditor('Anzulegender Wert');
    fireEvent.change(screen.getByLabelText('Anzulegender Wert (ct/kWh)'), {
      target: { value: '9,25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(onSiteSaved).toHaveBeenCalled());
    expect(updateSite).toHaveBeenCalledWith(
      's-1',
      expect.objectContaining({ anzulegenderWertCtKwh: 9.25, name: 'Solarpark Dachau', maxFeedInKw: 75 }),
    );
    updateSite.mockRestore();
  });

  it('edits the Speicherschonung and saves the full battery params + changed preset', async () => {
    const saveBattery = vi.spyOn(api, 'saveBattery').mockResolvedValue([]);
    const onBatterySaved = vi.fn();
    const mode = marktMode();
    render(
      <ModusContainer
        profile={profile({ id: 'marktvermarktung', label: 'Marktvermarktung', active: true })}
        mode={mode}
        activeModes={[mode]}
        site={site()}
        battery={battery({ speicherschonung: 'ausgewogen' })}
        earnings={null}
        busy={false}
        {...NOOP}
        onBatterySaved={onBatterySaved}
      />,
    );

    // Read-first: the effective preset is shown before editing.
    expect(screen.getByText('Ausgewogen (empfohlen)')).toBeInTheDocument();

    openEditor('Umgang mit dem Speicher');
    const ausgewogen = screen.getByRole('radio', { name: /Ausgewogen/ }) as HTMLInputElement;
    expect(ausgewogen.checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Schonend/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(onBatterySaved).toHaveBeenCalled());
    // saveBattery is a full-representation upsert of the battery params, so the
    // container carries capacity/charge/discharge/device through and adds the
    // changed preset.
    expect(saveBattery).toHaveBeenCalledWith('s-1', {
      capacityKwh: 10,
      maxChargeKw: 5,
      maxDischargeKw: 5,
      roundtripEfficiencyPct: null,
      deviceId: 'd-1',
      speicherschonung: 'schonend',
    });
    saveBattery.mockRestore();
  });

  it('an untouched Speicherschonung save never sends the preset (keeps a custom value)', async () => {
    const saveBattery = vi.spyOn(api, 'saveBattery').mockResolvedValue([]);
    const onBatterySaved = vi.fn();
    const mode = marktMode();
    render(
      <ModusContainer
        profile={profile({ id: 'marktvermarktung', label: 'Marktvermarktung', active: true })}
        mode={mode}
        activeModes={[mode]}
        site={site()}
        battery={battery({ speicherschonung: 'individuell' })}
        earnings={null}
        busy={false}
        {...NOOP}
        onBatterySaved={onBatterySaved}
      />,
    );

    openEditor('Umgang mit dem Speicher');
    // Nothing pre-selected; the honest note explains a pick replaces the value.
    expect(
      (screen.getAllByRole('radio') as HTMLInputElement[]).filter((r) => r.checked),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(onBatterySaved).toHaveBeenCalled());
    expect(saveBattery).toHaveBeenCalledWith(
      's-1',
      expect.not.objectContaining({ speicherschonung: expect.anything() }),
    );
    saveBattery.mockRestore();
  });

  it('the Speicherschonung row is read-only when no battery is configured', () => {
    const mode = marktMode();
    render(
      <ModusContainer
        profile={profile({ id: 'marktvermarktung', label: 'Marktvermarktung', active: true })}
        mode={mode}
        activeModes={[mode]}
        site={site()}
        battery={null}
        earnings={null}
        busy={false}
        {...NOOP}
      />,
    );
    const row = screen.getByText('Umgang mit dem Speicher').closest('li') as HTMLElement;
    expect(within(row).queryByRole('button', { name: /Bearbeiten/ })).toBeNull();
    expect(within(row).getByText('Kein Speicher hinterlegt')).toBeInTheDocument();
  });
});
