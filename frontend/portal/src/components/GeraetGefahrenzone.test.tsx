import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeraetGefahrenzone, gefahrMenueLabel } from './GeraetGefahrenzone';
import { api } from '../api';
import { entitiesApi } from '../entitiesApi';
import { plantModel } from '../komponenten';
import { gefahrenzone, type GefahrenzoneZustand } from '../geraetLoeschen';
import type { SiteEntity } from '../api';

function phone(an: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (q: string) => ({
      matches: q.includes('max-width') ? an : !an,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

function entity(id: string, entityType: string, overrides: Partial<SiteEntity> = {}): SiteEntity {
  return {
    id,
    entityType,
    typeLabel: entityType,
    role: entityType,
    label: null,
    control: false,
    deviceId: 'gw',
    capabilities: { measure: [{ channel: 'power_kw', unit: 'kW' }] },
    guards: null,
    syncStatus: 'in_sync',
    observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
    edgeSourceId: null,
    ...overrides,
  };
}

/** The gefahrenzone state for a one-entity plant. */
function zustandOf(e: SiteEntity): GefahrenzoneZustand {
  const model = plantModel([e], null, []);
  return gefahrenzone(model.components, (id) => (id === e.id ? e : undefined));
}

beforeEach(() => phone(false));
afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error - the stub belongs to the individual test
  delete window.matchMedia;
});

describe('GeraetGefahrenzone — die Rückfrage hinter „⋯ › Entfernen" (V7)', () => {
  it('nennt den Menü-Eintrag je Zustand - und keinen, wo es keinen Weg gibt', () => {
    expect(gefahrMenueLabel(zustandOf(entity('p', 'producer', { label: 'Wechselrichter Scheune', edgeSourceId: 'src-1' }))))
      .toBe('Komponente entfernen …');
    expect(gefahrMenueLabel(zustandOf(entity('b', 'battery-hybrid', {
      capabilities: { measure: [{ channel: 'soc_pct', unit: '%' }] },
    })))).toBe('Batterie am Standort abmelden …');
    // Eine plattform-eigene Grundausstattung: KEIN Knopf ins Leere.
    expect(gefahrMenueLabel(zustandOf(entity('netz', 'grid-meter', { label: 'Netzanschluss', sourceKind: 'composed' }))))
      .toBeNull();
    expect(gefahrMenueLabel(null)).toBeNull();
  });

  it('zeigt nichts, solange das Menü die Rückfrage nicht öffnet', () => {
    const z = zustandOf(entity('p', 'producer', { label: 'Wechselrichter Scheune', edgeSourceId: 'src-1' }));
    render(<GeraetGefahrenzone siteId="s1" zustand={z} name="Wechselrichter Scheune" offen={false} onSchliessen={() => {}} onDone={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('two-step confirm: the button stays locked until the name is typed', async () => {
    const remove = vi.spyOn(entitiesApi, 'removeComponent').mockResolvedValue(undefined);
    const onDone = vi.fn();
    const z = zustandOf(entity('p', 'producer', { label: 'Wechselrichter Scheune', edgeSourceId: 'src-1' }));
    render(<GeraetGefahrenzone siteId="s1" zustand={z} name="Wechselrichter Scheune" offen onSchliessen={() => {}} onDone={onDone} />);

    const dialog = screen.getByRole('dialog');
    // The honest consequence list is present.
    const folgen = within(dialog).getByTestId('gz-folgen');
    expect(folgen.querySelectorAll('li').length).toBeGreaterThanOrEqual(3);

    const confirm = within(dialog).getByRole('button', { name: /Endgültig entfernen/ });
    expect(confirm).toBeDisabled();
    // A wrong name keeps it locked.
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'falsch' } });
    expect(confirm).toBeDisabled();
    // The exact name unlocks it.
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Wechselrichter Scheune' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith('s1', 'p'));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('battery: states the reason in the confirmation and unregisters at the site', async () => {
    const unregister = vi.spyOn(api, 'unregisterBattery').mockResolvedValue([]);
    const onDone = vi.fn();
    const z = zustandOf(entity('b', 'battery-hybrid', {
      capabilities: { measure: [{ channel: 'soc_pct', unit: '%' }] },
    }));
    render(<GeraetGefahrenzone siteId="s1" zustand={z} name="Speicher" offen onSchliessen={() => {}} onDone={onDone} />);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Grundausstattung/)).toBeTruthy();
    expect(within(dialog).getByText('Die Optimierung plant ohne diesen Speicher.')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Speicher' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Batterie endgültig abmelden/ }));

    await vi.waitFor(() => expect(unregister).toHaveBeenCalledWith('s1'));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('a synthesized base row renders nothing - its reason lives in Technik › Einrichtung', () => {
    const z = zustandOf(entity('netz', 'grid-meter', { label: 'Netzanschluss', sourceKind: 'composed' }));
    const { container } = render(
      <GeraetGefahrenzone siteId="s1" zustand={z} name="Netzanschluss" offen onSchliessen={() => {}} onDone={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancel closes through the host - the page owns the open state', () => {
    const onSchliessen = vi.fn();
    const z = zustandOf(entity('p', 'producer', { label: 'Wechselrichter Scheune', edgeSourceId: 'src-1' }));
    render(<GeraetGefahrenzone siteId="s1" zustand={z} name="Wechselrichter Scheune" offen onSchliessen={onSchliessen} onDone={() => {}} />);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Abbrechen/ }));
    expect(onSchliessen).toHaveBeenCalled();
  });

  it('mobile: the confirmation is a bottom-sheet with the same consequence list', () => {
    phone(true);
    const z = zustandOf(entity('p', 'producer', { label: 'Wechselrichter Scheune', edgeSourceId: 'src-1' }));
    render(<GeraetGefahrenzone siteId="s1" zustand={z} name="Wechselrichter Scheune" offen onSchliessen={() => {}} onDone={() => {}} />);
    const dialog = screen.getByRole('dialog');
    // The phone form is the bottom-sheet building block, and it carries the list.
    expect(dialog.closest('.vp-bs-wrap')).toBeTruthy();
    expect(within(dialog).getByTestId('gz-folgen')).toBeTruthy();
  });
});
