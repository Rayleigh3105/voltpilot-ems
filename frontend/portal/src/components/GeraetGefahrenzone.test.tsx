import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeraetGefahrenzone } from './GeraetGefahrenzone';
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

describe('GeraetGefahrenzone — der eine Löschort der Geräteseite', () => {
  it('renders the danger zone card with the delete action for a producer', () => {
    const z = zustandOf(entity('p', 'producer', { label: 'Wechselrichter Scheune', edgeSourceId: 'src-1' }));
    render(<GeraetGefahrenzone siteId="s1" zustand={z} name="Wechselrichter Scheune" onDone={() => {}} />);
    expect(screen.getByLabelText('Gefahrenzone')).toBeTruthy();
    expect(screen.getByText('Gefahrenzone')).toBeTruthy();
    // No dialog until the customer opens it.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /Komponente entfernen/ })).toBeTruthy();
  });

  it('two-step confirm: the button stays locked until the name is typed', async () => {
    const remove = vi.spyOn(entitiesApi, 'removeComponent').mockResolvedValue(undefined);
    const onDone = vi.fn();
    const z = zustandOf(entity('p', 'producer', { label: 'Wechselrichter Scheune', edgeSourceId: 'src-1' }));
    render(<GeraetGefahrenzone siteId="s1" zustand={z} name="Wechselrichter Scheune" onDone={onDone} />);

    fireEvent.click(screen.getByRole('button', { name: /Komponente entfernen/ }));
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

  it('battery: shows reason AND way — no dead button — and unregisters at the site', async () => {
    const unregister = vi.spyOn(api, 'unregisterBattery').mockResolvedValue([]);
    const onDone = vi.fn();
    const z = zustandOf(entity('b', 'battery-hybrid', {
      capabilities: { measure: [{ channel: 'soc_pct', unit: '%' }] },
    }));
    render(<GeraetGefahrenzone siteId="s1" zustand={z} name="Speicher" onDone={onDone} />);

    // The reason is stated, and the way is an ENABLED button (never disabled).
    expect(screen.getByText(/Grundausstattung/)).toBeTruthy();
    const way = screen.getByRole('button', { name: /Batterie am Standort abmelden/ });
    expect(way).toBeEnabled();
    fireEvent.click(way);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Die Optimierung plant ohne diesen Speicher.')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Speicher' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Batterie endgültig abmelden/ }));

    await vi.waitFor(() => expect(unregister).toHaveBeenCalledWith('s1'));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('a synthesized base row shows only the reason — no action button', () => {
    const z = zustandOf(entity('netz', 'grid-meter', { label: 'Netzanschluss', sourceKind: 'composed' }));
    render(<GeraetGefahrenzone siteId="s1" zustand={z} name="Netzanschluss" onDone={() => {}} />);
    expect(screen.getByText(/Grundausstattung/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('mobile: the confirmation is a bottom-sheet with the same consequence list', () => {
    phone(true);
    const z = zustandOf(entity('p', 'producer', { label: 'Wechselrichter Scheune', edgeSourceId: 'src-1' }));
    render(<GeraetGefahrenzone siteId="s1" zustand={z} name="Wechselrichter Scheune" onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Komponente entfernen/ }));
    const dialog = screen.getByRole('dialog');
    // The phone form is the bottom-sheet building block, and it carries the list.
    expect(dialog.closest('.vp-bs-wrap')).toBeTruthy();
    expect(within(dialog).getByTestId('gz-folgen')).toBeTruthy();
  });
});
