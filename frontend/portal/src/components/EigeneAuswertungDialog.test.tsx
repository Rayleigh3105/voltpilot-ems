import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { EigeneAuswertungDialog } from './EigeneAuswertungDialog';

/**
 * Der geführte Dialog „Eigene Auswertung" (Anwendungs-Programm Stufe 5).
 *
 * Der wichtigste Fall ist die dritte Prüfung: eine Kennzahl, die auf dem
 * gewählten Kanal nicht ehrlich wäre, bleibt SICHTBAR und nennt ihren Grund —
 * sie verschwindet nie. Eine Sperre ohne Grund ist ein Rätsel (die Haus-Regel
 * des Pickers), und ein Kunde, der die Wahl gar nicht mehr sieht, sucht sie.
 */

const ENTITIES = {
  registry: null,
  entities: [
    {
      id: 'e-wp',
      entityType: 'heating-rod',
      typeLabel: 'Heizstab',
      role: 'consumer',
      label: 'Wärmepumpe',
      control: false,
      deviceId: 'd1',
      capabilities: {
        measure: [
          { channel: 'power_kw', unit: 'kW' },
          { channel: 'energy_kwh', unit: 'kWh' },
        ],
      },
      guardConfig: null,
      syncStatus: 'in_sync',
      observed: null,
      edgeSourceId: null,
      orphanedPin: null,
      capacityKwp: null,
    },
  ],
  localSetup: [],
  staleOnDevice: [],
};

const TOPO = {
  schemaVersion: '1.0',
  entities: [
    {
      entityId: 'e-wp',
      entityType: 'heating-rod',
      label: 'Wärmepumpe',
      capabilities: [{ channel: 'power_kw', role: 'consumer', primary: true, value: 1, health: 'ok' }],
    },
  ],
  topology: { nodes: [], flows: [] },
};

function mount(props: Partial<Parameters<typeof EigeneAuswertungDialog>[0]> = {}) {
  return render(
    <EigeneAuswertungDialog
      open
      siteId="s-1"
      bearbeiten={null}
      onSpeichern={props.onSpeichern ?? (() => {})}
      onEntfernen={props.onEntfernen}
      onAbbrechen={props.onAbbrechen ?? (() => {})}
      {...props}
    />,
  );
}

afterEach(() => vi.restoreAllMocks());

function stub() {
  vi.spyOn(api, 'siteEntities').mockResolvedValue(ENTITIES as never);
  vi.spyOn(api, 'topology').mockResolvedValue(TOPO as never);
}

describe('EigeneAuswertungDialog', () => {
  it('führt in fünf Schritten und lädt den Messwert-Baum erst beim Öffnen', async () => {
    stub();
    const { getByText, container } = mount();
    await waitFor(() => expect(getByText('1 · Komponente')).toBeTruthy());
    expect(getByText('2 · Messwert')).toBeTruthy();
    expect(getByText('3 · Kennzahl')).toBeTruthy();
    expect(getByText('4 · Darstellung')).toBeTruthy();
    expect(getByText('5 · Überschrift')).toBeTruthy();
    // Die zwei ARTEN kommen aus dem Katalog, nicht aus dieser Datei.
    expect(container.textContent).toContain('Eigene Kachel');
    expect(container.textContent).toContain('Eigener Verlauf');
  });

  /** Wählt Komponente + Messwert über die zwei Picker (sie liegen im Portal). */
  async function waehle(messwert: string) {
    fireEvent.click(screen.getByRole('combobox', { name: /Komponente/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Wärmepumpe/ }));
    fireEvent.click(screen.getByRole('combobox', { name: /Messwert/ }));
    fireEvent.click(await screen.findByRole('option', { name: new RegExp(messwert) }));
  }

  it('eine unehrliche Kennzahl bleibt SICHTBAR und nennt ihren Grund', async () => {
    stub();
    const { findByText } = mount();
    await findByText('1 · Komponente');
    await waehle('Leistung');

    await waitFor(() => {
      const summe = [...document.querySelectorAll('.vp-eigen-option')].find((o) =>
        o.textContent?.includes('Tagessumme'),
      ) as HTMLElement;
      // Sie ist DA, gesperrt, und sagt WARUM.
      expect(summe).toBeTruthy();
      expect(summe.className).toContain('is-off');
      expect((summe.querySelector('input') as HTMLInputElement).disabled).toBe(true);
      expect(summe.textContent).toContain('Leistung');
      expect(summe.textContent).toContain('Tageshöchstwert');
    });
  });

  it('schlägt einen Titel vor und speichert die Definition', async () => {
    stub();
    const onSpeichern = vi.fn();
    const { findByText } = mount({ onSpeichern });
    await findByText('1 · Komponente');
    await waehle('Leistung');

    await waitFor(() => {
      const feld = screen.getByLabelText(/Überschrift/) as HTMLInputElement;
      expect(feld.value).toContain('Wärmepumpe');
    });
    fireEvent.click(await findByText('Anlegen'));
    expect(onSpeichern).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'e-wp',
        channel: 'power_kw',
        aggregat: 'jetzt',
        darstellung: 'kachel',
        id: null,
      }),
    );
  });

  it('ohne Messwerte wird nichts angeboten, sondern gesagt', async () => {
    vi.spyOn(api, 'siteEntities').mockResolvedValue({
      registry: null,
      entities: [],
      localSetup: [],
      staleOnDevice: [],
    } as never);
    vi.spyOn(api, 'topology').mockResolvedValue({
      schemaVersion: '1.0',
      entities: [],
      topology: { nodes: [], flows: [] },
    } as never);
    const { findByText } = mount();
    await findByText('1 · Komponente');
    // Der v1-Rückfall des Explorers greift - es gibt also immer eine Auswahl,
    // nie eine tote Fläche.
    fireEvent.click(screen.getByRole('combobox', { name: /Komponente/ }));
    expect(await screen.findByRole('listbox')).toBeTruthy();
  });

  it('lässt im v1-Rückfall PV, Haus, Netz und Speicher wirklich getrennt wählen', async () => {
    vi.spyOn(api, 'siteEntities').mockResolvedValue({
      registry: null,
      entities: [],
      localSetup: [],
      staleOnDevice: [],
    } as never);
    vi.spyOn(api, 'topology').mockResolvedValue(null);
    const onSpeichern = vi.fn();
    mount({ onSpeichern });
    await screen.findByText('1 · Komponente');

    fireEvent.click(screen.getByRole('combobox', { name: /Komponente/ }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      'PV-Erzeugung',
      'Haus',
      'Netzanschluss',
      'Speicher',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Haus' }));
    fireEvent.click(screen.getByRole('combobox', { name: /Messwert/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Hausverbrauch/ }));

    await waitFor(() => expect(screen.getByText('Anlegen')).not.toBeDisabled());
    fireEvent.click(screen.getByText('Anlegen'));
    expect(onSpeichern).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'anlage', channel: 'haus' }),
    );
  });

  it('beim Ändern gibt es „Entfernen", beim Anlegen nicht', async () => {
    stub();
    const onEntfernen = vi.fn();
    const bestehend = {
      id: 'eigen:k1',
      titel: 'Meine Kachel',
      darstellung: 'kachel' as const,
      entityId: 'e-wp',
      channel: 'power_kw',
      aggregat: 'jetzt' as const,
    };
    const { queryByText, findByText, rerender } = mount({ bearbeiten: bestehend, onEntfernen });
    await findByText('Entfernen');
    fireEvent.click(await findByText('Entfernen'));
    expect(onEntfernen).toHaveBeenCalledWith('eigen:k1');

    rerender(
      <EigeneAuswertungDialog
        open
        siteId="s-1"
        bearbeiten={null}
        onSpeichern={() => {}}
        onEntfernen={onEntfernen}
        onAbbrechen={() => {}}
      />,
    );
    await waitFor(() => expect(queryByText('Entfernen')).toBeNull());
  });
});
