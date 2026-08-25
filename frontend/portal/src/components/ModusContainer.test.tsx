import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ModusContainer } from './ModusContainer';
import { activeModes, type ActiveMode } from '../surface';
import type { SiteProfile } from '../profiles';
import { type Site, type SiteAsset } from '../api';

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
    expect(screen.getByText('Ansichten dieses Betriebsmodells')).toBeInTheDocument();
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
    expect(screen.getByText('Ansichten dieses Betriebsmodells')).toBeInTheDocument();
    // Inactive views are shown but not clickable (no empty-state landings).
    expect(screen.queryByRole('button', { name: /Fahrplan/ })).toBeNull();
    expect(screen.getByText(/sobald Sie das Betriebsmodell einschalten/)).toBeInTheDocument();
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

describe('ModusContainer Gewerbe read-only settings (v3.1-M4)', () => {
  /**
   * The Lastspitzenkappung mode, activated independently of the site echo so a
   * test can pair it with EITHER a fully-configured peak block OR an empty one.
   */
  function peakMode(): ActiveMode {
    const mode = activeModes({ signals: { hasLeistungspreis: true } }).find(
      (m) => m.kind === 'lastspitzenkappung',
    );
    if (!mode) throw new Error('expected a lastspitzenkappung mode');
    return mode;
  }

  /** The setting row whose label matches `label`. */
  function settingRow(label: string): HTMLElement {
    return screen.getByText(label).closest('li') as HTMLElement;
  }

  it('renders the three VoltPilot-configured values, read-only, from the site echoes', () => {
    const mode = peakMode();
    render(
      <ModusContainer
        profile={profile({ id: 'lastspitzenkappung', label: 'Lastspitzenkappung', active: true })}
        mode={mode}
        activeModes={[mode]}
        site={site({
          leistungspreisEurKw: 120,
          abrechnungLeistung: 'jahr',
          peakReserveSocPct: 20,
        })}
        battery={battery()}
        earnings={null}
        busy={false}
        {...NOOP}
      />,
    );

    // The three settings appear with their real values (a first-time honesty win:
    // these were admin-only and invisible to the customer before M4).
    const leistungspreis = settingRow('Leistungspreis');
    expect(within(leistungspreis).getByText(/120,00.+€\/kW/)).toBeInTheDocument();
    expect(within(leistungspreis).getByText('Von VoltPilot eingerichtet')).toBeInTheDocument();
    // Read-only for the customer: no edit control anywhere in the block.
    expect(within(leistungspreis).queryByRole('button', { name: /Bearbeiten/ })).toBeNull();

    const abrechnung = settingRow('Abrechnungsperiode');
    expect(within(abrechnung).getByText('jährlich')).toBeInTheDocument();
    expect(within(abrechnung).queryByRole('button', { name: /Bearbeiten/ })).toBeNull();

    const reserve = settingRow('Lastspitzen-Reserve');
    expect(within(reserve).getByText(/20.+%/)).toBeInTheDocument();
    expect(within(reserve).queryByRole('button', { name: /Bearbeiten/ })).toBeNull();
  });

  it('maps a monthly billing period to plain German', () => {
    const mode = peakMode();
    render(
      <ModusContainer
        profile={profile({ id: 'lastspitzenkappung', label: 'Lastspitzenkappung', active: true })}
        mode={mode}
        activeModes={[mode]}
        site={site({ leistungspreisEurKw: 95, abrechnungLeistung: 'monat', peakReserveSocPct: 15 })}
        battery={battery()}
        earnings={null}
        busy={false}
        {...NOOP}
      />,
    );
    expect(within(settingRow('Abrechnungsperiode')).getByText('monatlich')).toBeInTheDocument();
  });

  it('fails soft to „—" for a value VoltPilot has not configured yet', () => {
    const mode = peakMode();
    render(
      <ModusContainer
        profile={profile({ id: 'lastspitzenkappung', label: 'Lastspitzenkappung', active: true })}
        mode={mode}
        activeModes={[mode]}
        // A peak mode active (e.g. via a peak-shaving strategy) but the admin has
        // not yet filled the peak config: every value must fail-soft to „—",
        // never a fabricated number or period.
        site={site()}
        battery={battery()}
        earnings={null}
        busy={false}
        {...NOOP}
      />,
    );

    for (const label of ['Leistungspreis', 'Abrechnungsperiode', 'Lastspitzen-Reserve']) {
      const row = settingRow(label);
      expect(within(row).getByText('—')).toBeInTheDocument();
      expect(within(row).getByText('Von VoltPilot eingerichtet')).toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: /Bearbeiten/ })).toBeNull();
    }
  });
});

describe('ModusContainer Einstellungs-SPIEGEL (E1)', () => {
  /** Die Zeile einer Einstellung. */
  function settingRow(label: string): HTMLElement {
    return screen.getByText(label).closest('li') as HTMLElement;
  }

  it('zeigt die Werte read-only und verweist auf ihre Heimat statt sie zu bearbeiten', () => {
    const mode = marktMode();
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
      />,
    );

    // Lesen ja - die Werte erklären, WOMIT dieser Modus rechnet.
    expect(within(settingRow('Stromtarif')).getByText(/Dynamisch/)).toBeInTheDocument();
    expect(screen.getByText('Ausgewogen (empfohlen)')).toBeInTheDocument();

    // Bearbeiten NEIN - es gibt hier keinen einzigen Bearbeiten-Knopf mehr
    // (genau die Doppel-Editierbarkeit, die E1 ausschließt).
    const list = screen.getByLabelText('Einstellungen');
    expect(within(list).queryByRole('button', { name: /Bearbeiten/ })).toBeNull();

    // Stattdessen der Deep-Link in die Gruppe, in der der Wert WOHNT.
    const tarifLink = within(settingRow('Stromtarif')).getByRole('link', {
      name: /In den Einstellungen ändern/,
    });
    expect(tarifLink).toHaveAttribute('href', '#/anlage/s-1/technik?abschnitt=geld');
    // Der „Umgang mit dem Speicher" wohnt in der Speicher-Gruppe, nicht im Geld.
    expect(
      within(settingRow('Umgang mit dem Speicher')).getByRole('link', {
        name: /In den Einstellungen ändern/,
      }),
    ).toHaveAttribute('href', '#/anlage/s-1/technik?abschnitt=speicher');

    // Und der Container sagt in einem Satz, warum hier nichts zu tippen ist.
    expect(screen.getByText(/in den Einstellungen gepflegt/)).toBeInTheDocument();
  });

  it('verspricht keinen Link, wo es nichts zu ändern gäbe (kein Speicher)', () => {
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
    const row = settingRow('Umgang mit dem Speicher');
    expect(within(row).getByText('Kein Speicher hinterlegt')).toBeInTheDocument();
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).queryByRole('button', { name: /Bearbeiten/ })).toBeNull();
  });

  it('die von-VoltPilot-Werte bleiben ohne Link — sie wohnen weiter im Modus', () => {
    const mode = activeModes({ signals: { hasLeistungspreis: true } }).find(
      (m) => m.kind === 'lastspitzenkappung',
    )!;
    render(
      <ModusContainer
        profile={profile({ id: 'lastspitzenkappung', label: 'Lastspitzenkappung', active: true })}
        mode={mode}
        activeModes={[mode]}
        site={site({ leistungspreisEurKw: 120, abrechnungLeistung: 'jahr', peakReserveSocPct: 20 })}
        battery={battery()}
        earnings={null}
        busy={false}
        {...NOOP}
      />,
    );
    const row = settingRow('Leistungspreis');
    expect(within(row).getByText('Von VoltPilot eingerichtet')).toBeInTheDocument();
    expect(within(row).queryByRole('link')).toBeNull();
    // Ohne kunden-gestellten Wert entfällt auch die Spiegel-Notiz.
    expect(screen.queryByText(/in den Einstellungen gepflegt/)).toBeNull();
  });
});
