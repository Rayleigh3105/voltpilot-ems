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

    // Reconnecting keeps the old component's role - the card shows no new one.
    expect(screen.queryByText('Wird angezeigt als')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Wieder verbinden' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'Zuordnen' }));
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

  // vp-geraet-zuordnen-dialog: what the box reported and what it is shown as
  // stand as ONE read-only pair (label above value, never glued together), the
  // honesty line speaks customer words, and nothing contradicts the name field.
  const varianten: Array<[string, Partial<AdoptableSource>, string, string[]]> = [
    ['PV-Erzeugung', { role: 'pv-generation', suggestedType: 'producer' }, 'PV-Erzeugung', ['Anlagenleistung (kWp)', 'MaStR-Nummer (optional)']],
    ['Netzanschluss', { role: 'grid-meter', suggestedType: 'grid-meter' }, 'Netzanschluss', []],
    ['Wallbox', { role: 'consumer', brand: 'go-e', suggestedType: 'wallbox' }, 'Wallbox', ['Anschlussleistung (kW, optional)']],
    ['Verbraucher', { role: 'consumer', brand: null, suggestedType: 'generic-load' }, 'Verbraucher', ['Anschlussleistung (kW, optional)']],
  ];

  it.each(varianten)('zeigt %s als ruhiges Paar „gemeldet / angezeigt als"', (_name, teil, angezeigt, felder) => {
    render(
      <ZuordnenDialog
        siteId="site-1"
        source={{ ...source, summary: 'Heizstab', ...teil }}
        onClose={() => {}}
        onAssigned={() => {}}
      />,
    );
    const karte = screen.getByRole('region', { name: 'Gemeldetes Gerät' });
    const paare = Array.from(karte.querySelectorAll('dl > div')).map((d) => [
      d.querySelector('dt')?.textContent,
      d.querySelector('dd')?.textContent,
    ]);
    expect(paare).toEqual([
      ['Von Ihrer Box gemeldet', 'Heizstab'],
      ['Wird angezeigt als', angezeigt],
    ]);
    expect(karte).toHaveTextContent(
      'Die Zuordnung legt nur fest, wie das Gerät im Portal erscheint. An der Steuerung ändert sie nichts.',
    );
    const labels = Array.from(document.querySelectorAll('.vp-zuordnen-dialog label'))
      .map((l) => l.textContent);
    expect(labels).toEqual(['Name der Komponente', ...felder]);
    expect(screen.getByRole('button', { name: 'Zuordnen' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Fertig' })).toBeNull();
  });

  it('trägt keinen Widerspruch und kein Entwicklerwort mehr', () => {
    render(
      <ZuordnenDialog
        siteId="site-1"
        source={{ ...source, summary: 'Heizstab', role: 'consumer', suggestedType: 'generic-load' }}
        onClose={() => {}}
        onAssigned={() => {}}
      />,
    );
    const text = document.querySelector('.vp-zuordnen-dialog')?.textContent ?? '';
    // The name field IS in the dialog - no "name it later" note beside it.
    expect(text).not.toMatch(/Nach dem Zuordnen/);
    expect(text).not.toMatch(/Steuer-Rechte|Rolle|reine Darstellung/);
    expect(text).not.toMatch(/Was misst dieses Gerät\?/);
  });

  it('ohne bekannte Art: nur das gemeldete Gerät, der Hinweis auf VoltPilot, Zuordnen gesperrt', () => {
    render(
      <ZuordnenDialog
        siteId="site-1"
        source={{ ...source, summary: 'Unbekanntes Gerät', role: null, suggestedType: null }}
        onClose={() => {}}
        onAssigned={() => {}}
      />,
    );
    const karte = screen.getByRole('region', { name: 'Gemeldetes Gerät' });
    expect(karte.querySelectorAll('dl > div')).toHaveLength(1);
    expect(screen.queryByText('Wird angezeigt als')).toBeNull();
    expect(screen.getByText(/VoltPilot für Sie einrichten/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Name der Komponente')).toBeNull();
    expect(screen.getByRole('button', { name: 'Zuordnen' })).toBeDisabled();
  });
});
