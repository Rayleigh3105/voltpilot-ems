import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DeviceDetailDrawer, unclaimConsequences } from './DeviceDrawers';
import type { Device, Site } from '../api';

// The drawer talks to the API only through these two calls; nothing else in
// this file is under test.
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: { deleteDevice: vi.fn(async () => {}), purgeDeviceData: vi.fn(async () => ({})) },
  };
});
import { api } from '../api';

const site: Site = {
  id: 'site-1',
  name: 'Anlage Musterhof',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
} as unknown as Site;

// A device that has been claimed long ago and never delivered - exactly the
// state that renders the "waiting too long" alert with its removal shortcut.
const waitingTooLong: Device = {
  id: 'dev-1',
  siteId: 'site-1',
  externalRef: 'VP-DEMO-0001',
  kind: 'inverter',
  name: 'Wechselrichter Nord',
  status: 'claimed',
  lastSeenAt: null,
  createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
};

function renderDrawer() {
  return render(
    <DeviceDetailDrawer
      device={waitingTooLong}
      sites={[site]}
      onClose={() => {}}
      onChanged={() => {}}
    />
  );
}

describe('unclaimConsequences', () => {
  it('is ONE list, so both removal paths can never promise different things', () => {
    const list = unclaimConsequences(waitingTooLong);
    expect(list).toHaveLength(3);
    expect(list[0]).toContain('Wechselrichter Nord');
    expect(list.join(' ')).toContain('Messdaten');
    expect(list.join(' ')).toContain('Fahrplan');
  });

  it('falls back to the reference when the device has no label', () => {
    expect(unclaimConsequences({ ...waitingTooLong, name: null })[0]).toContain('VP-DEMO-0001');
  });
});

// The E3 Nebenwirkungs-Regel on the portal's device surface: the shortcut in
// the "waiting too long" alert removed the device on a SINGLE click - deleting
// the claim AND every recorded measurement with no consequence list and no
// confirm, while the identical action at the foot of the same drawer had both.
describe('the "Gerät entfernen und neu verbinden" shortcut', () => {
  beforeEach(() => {
    vi.mocked(api.deleteDevice).mockClear();
  });

  it('never removes the device on the first click', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Gerät entfernen und neu verbinden/ }));
    expect(api.deleteDevice).not.toHaveBeenCalled();
  });

  it('names the consequences before asking for confirmation', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Gerät entfernen und neu verbinden/ }));

    // The same three consequences the danger zone shows - stated BEFORE the act.
    for (const line of unclaimConsequences(waitingTooLong)) {
      expect(screen.getAllByText(line).length).toBeGreaterThan(0);
    }
    expect(
      screen.getAllByRole('button', { name: 'Gerät endgültig entfernen' }).length
    ).toBeGreaterThan(0);
  });

  it('changes nothing when the confirmation is cancelled', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Gerät entfernen und neu verbinden/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Abbrechen' })[0]);

    expect(api.deleteDevice).not.toHaveBeenCalled();
    // Back to the collapsed shortcut - the alert still offers the way out.
    expect(
      screen.getByRole('button', { name: /Gerät entfernen und neu verbinden/ })
    ).toBeInTheDocument();
  });

  it('executes the removal once confirmed', async () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Gerät entfernen und neu verbinden/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Gerät endgültig entfernen' })[0]);

    await waitFor(() => expect(api.deleteDevice).toHaveBeenCalledWith('dev-1'));
  });
});

describe('the danger zone at the foot of the drawer', () => {
  beforeEach(() => {
    vi.mocked(api.deleteDevice).mockClear();
  });

  it('still guards the removal with the same list and confirm step', async () => {
    renderDrawer();
    // The collapsed danger-zone button (distinct label from the shortcut).
    fireEvent.click(screen.getByRole('button', { name: 'Gerät entfernen' }));
    expect(api.deleteDevice).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Gerät endgültig entfernen' })[0]);
    await waitFor(() => expect(api.deleteDevice).toHaveBeenCalledWith('dev-1'));
  });

  it('guards the data purge with a type-to-confirm step', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Datenaufzeichnungen löschen' }));

    const confirm = screen.getByRole('button', { name: 'Datenaufzeichnungen endgültig löschen' });
    expect(confirm).toBeDisabled();
    expect(api.purgeDeviceData).not.toHaveBeenCalled();
  });
});
