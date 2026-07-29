import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZuordnenDialog } from './ZuordnenDialog';
import type { AdoptableSource } from '../rollen';

// PR 3 (vp-vier-erzeuger-p9): when an orphaned same-type component exists, the
// dialog LEADS with "Wieder verbinden" (re-pin) - adopting again would mint a
// duplicate (the Pilsting ghost). "Als neue Komponente anlegen" stays one
// click away and runs the unchanged adoption path.

vi.mock('../entitiesApi', () => ({
  entitiesApi: {
    repin: vi.fn().mockResolvedValue({ id: 'wr1' }),
    adopt: vi.fn().mockResolvedValue({ id: 'new-entity' }),
  },
}));
vi.mock('../api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../api')>();
  return {
    ...mod,
    api: { ...mod.api, setTopologyRoles: vi.fn().mockResolvedValue(undefined) },
  };
});

import { entitiesApi } from '../entitiesApi';

const source: AdoptableSource = {
  id: 'src-new',
  role: 'pv-generation',
  brand: 'fronius_sunspec',
  model: 'fronius-eco-27-3-s',
  label: 'Fronius Anlage WR2',
  roleLabel: 'PV-Erzeuger',
  summary: 'Fronius Anlage WR2',
  suggestedType: 'producer',
};

describe('ZuordnenDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leads with "Wieder verbinden" and re-pins instead of adopting', async () => {
    const onAssigned = vi.fn();
    render(
      <ZuordnenDialog
        siteId="site-1"
        source={source}
        candidates={[{ entityId: 'wr1', label: 'Fronius WR1' }]}
        onClose={() => {}}
        onAssigned={onAssigned}
      />,
    );
    const reconnect = screen.getByRole('radio', { name: /Wieder verbinden/ });
    expect((reconnect as HTMLInputElement).checked).toBe(true);
    // The guided adoption form stays hidden while reconnect is chosen.
    expect(screen.queryByLabelText('Name der Komponente')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    await waitFor(() => expect(onAssigned).toHaveBeenCalled());
    expect(entitiesApi.repin).toHaveBeenCalledWith('site-1', 'wr1', 'src-new');
    expect(entitiesApi.adopt).not.toHaveBeenCalled();
  });

  it('"Als neue Komponente anlegen" switches back to the adoption form', async () => {
    render(
      <ZuordnenDialog
        siteId="site-1"
        source={source}
        candidates={[{ entityId: 'wr1', label: 'Fronius WR1' }]}
        onClose={() => {}}
        onAssigned={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Als neue Komponente anlegen' }));
    expect(screen.getByLabelText('Name der Komponente')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    await waitFor(() => expect(entitiesApi.adopt).toHaveBeenCalled());
    expect(entitiesApi.repin).not.toHaveBeenCalled();
  });

  it('without candidates there is no reconnect choice - the plain adoption form', () => {
    render(
      <ZuordnenDialog
        siteId="site-1"
        source={source}
        onClose={() => {}}
        onAssigned={() => {}}
      />,
    );
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByLabelText('Name der Komponente')).toBeInTheDocument();
  });
});
