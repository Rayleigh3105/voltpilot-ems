import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listComponentTemplates = vi.fn();
const createComponentTemplate = vi.fn();
const addComponentTemplateVersion = vi.fn();
const setComponentTemplateWithdrawn = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    listComponentTemplates: () => listComponentTemplates(),
    createComponentTemplate: (i: unknown) => createComponentTemplate(i),
    addComponentTemplateVersion: (r: string, i: unknown) => addComponentTemplateVersion(r, i),
    setComponentTemplateWithdrawn: (r: string, v: number, w: boolean) =>
      setComponentTemplateWithdrawn(r, v, w),
  },
}));

const { VorlagenPage } = await import('./VorlagenPage');

function v(over: Record<string, unknown> = {}) {
  return {
    templateRef: 'certified:acme:relais',
    kind: 'certified',
    version: 1,
    brand: 'acme',
    brandLabel: 'ACME',
    model: 'relais',
    modelLabel: 'Relais 16',
    communication: 'modbus_tcp',
    communicationLabel: 'Modbus TCP',
    transportSchema: [{ key: 'ip' }],
    channels: null,
    writes: null,
    certificationStatus: 'certified',
    usedByComponents: 0,
    ...over,
  };
}

const BUILTIN = v({
  templateRef: 'builtin:deye:sun-30k',
  kind: 'builtin',
  brand: 'deye',
  brandLabel: 'Deye',
  model: 'sun-30k',
  modelLabel: 'SUN-30K',
  certificationStatus: 'builtin',
});

describe('VorlagenPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listComponentTemplates.mockResolvedValue([v(), BUILTIN]);
    setComponentTemplateWithdrawn.mockResolvedValue(v({ withdrawnAt: '2026-08-12T10:00:00Z' }));
  });

  it('zeigt Vorlagen mit Herkunft, Prüfstand und der wählbaren Fassung', async () => {
    render(<VorlagenPage />);
    await screen.findByText(/ACME · Relais 16/);

    const table = screen.getByTestId('vorlagen');
    expect(within(table).getByText('Von VoltPilot eingetragen')).toBeInTheDocument();
    expect(within(table).getByText('Eingebaut')).toBeInTheDocument();
    expect(within(table).getAllByText('Fassung 1').length).toBeGreaterThan(0);
    expect(screen.getByTestId('bestand')).toHaveTextContent('1 eingebaute Vorlagen');
  });

  it('⚠ eine eingebaute Vorlage zeigt ihren Sperrgrund und bietet keine Änderung an', async () => {
    render(<VorlagenPage />);
    fireEvent.click(await screen.findByText(/Deye · SUN-30K/));

    expect(screen.getByTestId('gesperrt')).toHaveTextContent(/Neustart/);
    expect(screen.queryByRole('button', { name: /Neue Fassung/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Zurückziehen/ })).not.toBeInTheDocument();
  });

  it('eine selbst eingetragene Vorlage lässt sich versionieren und zurückziehen', async () => {
    render(<VorlagenPage />);
    fireEvent.click(await screen.findByText(/ACME · Relais 16/));

    expect(screen.getByRole('button', { name: /Neue Fassung/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Zurückziehen/ }));

    // Der Haus-Dialog fragt VORHER und nennt die Folgen.
    const folgen = await screen.findByTestId('confirm-consequences');
    expect(folgen).toHaveTextContent(/nicht mehr zur Auswahl/);
    expect(folgen).toHaveTextContent(/nicht gelöscht/);
    expect(setComponentTemplateWithdrawn).not.toHaveBeenCalled();

    // ⚠ Der Zeilen-Knopf und der Bestätigen-Knopf heißen gleich - der Dialog
    // ist das, was jetzt zählt, also wird auf ihn eingegrenzt.
    const dialog = folgen.closest('.vp-drawer') ?? document.body;
    fireEvent.click(within(dialog as HTMLElement).getByRole('button', { name: 'Zurückziehen' }));
    await waitFor(() =>
      expect(setComponentTemplateWithdrawn).toHaveBeenCalledWith('certified:acme:relais', 1, true),
    );
  });

  it('die Nutzungszahl steht VOR der Rücknahme in der Folgenliste', async () => {
    listComponentTemplates.mockResolvedValue([v({ usedByComponents: 3 })]);
    render(<VorlagenPage />);
    fireEvent.click(await screen.findByText(/ACME · Relais 16/));
    fireEvent.click(screen.getByRole('button', { name: /Zurückziehen/ }));

    expect(await screen.findByTestId('confirm-consequences')).toHaveTextContent(
      /3 Komponenten laufen damit/,
    );
  });

  it('eine zurückgezogene Fassung lässt sich wieder freigeben', async () => {
    listComponentTemplates.mockResolvedValue([v({ withdrawnAt: '2026-08-12T10:00:00Z' })]);
    render(<VorlagenPage />);
    fireEvent.click(await screen.findByText(/ACME · Relais 16/));

    expect(screen.getByText('Zurückgezogen')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Wieder freigeben' }));
    await waitFor(() =>
      expect(setComponentTemplateWithdrawn).toHaveBeenCalledWith('certified:acme:relais', 1, false),
    );
  });

  it('legt eine neue Vorlage an - OHNE ein Schlüssel-Feld anzubieten', async () => {
    createComponentTemplate.mockResolvedValue(v());
    render(<VorlagenPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Vorlage eintragen/ }));

    expect(screen.queryByLabelText(/Schlüssel/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Marke (Kennung)'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('Marke (Anzeige)'), { target: { value: 'ACME' } });
    fireEvent.change(screen.getByLabelText('Modell (Kennung)'), { target: { value: 'relais' } });
    fireEvent.change(screen.getByLabelText('Modell (Anzeige)'), { target: { value: 'Relais' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vorlage eintragen' }));

    await waitFor(() => expect(createComponentTemplate).toHaveBeenCalled());
    const sent = createComponentTemplate.mock.calls[0][0];
    expect(sent.brand).toBe('acme');
    // ⚠ Absent heißt „hier nicht erklärt" - ein leeres Feld darf NICHT zu [] werden.
    expect('channels' in sent).toBe(false);
    expect('writes' in sent).toBe(false);
  });

  it('ein Fehlschlag zeigt den deutschen Grund des Servers', async () => {
    const { ApiError } = await import('../../api');
    createComponentTemplate.mockRejectedValue(new ApiError(400, 'Die Messwert-Liste ist leer.'));
    render(<VorlagenPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Vorlage eintragen/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Vorlage eintragen' }));

    expect(await screen.findByText('Die Messwert-Liste ist leer.')).toBeInTheDocument();
  });

  it('ein Ladefehler ist ein Fehler, nie eine leere Liste', async () => {
    listComponentTemplates.mockRejectedValue(new Error('boom'));
    render(<VorlagenPage />);
    expect(await screen.findByText(/konnten nicht geladen werden/)).toBeInTheDocument();
    expect(screen.queryByTestId('vorlagen')).not.toBeInTheDocument();
  });
});
