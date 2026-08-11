import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { KomponenteHinzufuegenDrawer } from './KomponenteHinzufuegenDrawer';

const template = {
  templateRef: 'builtin:deye:sun-30k-sg01hp3',
  kind: 'builtin',
  version: 1,
  brand: 'deye',
  brandLabel: 'Deye',
  model: 'sun-30k-sg01hp3',
  modelLabel: 'SUN-30K-SG01HP3-EU',
  family: 'hybrid_3p',
  familyLabel: 'Hybrid, 3-phasig',
  communication: 'solarman_v5',
  communicationLabel: 'Solarman-V5 (WiFi-Datenlogger, TCP 8899)',
  transportSchema: [
    { key: 'ip', label: 'IP-Adresse des Datenloggers', type: 'text', required: true },
    { key: 'port', label: 'Port', type: 'number', default: 8899 },
    { key: 'serial', label: 'Datenlogger-Seriennummer', type: 'text', required: true },
  ],
};

const componentTemplates = vi.fn();
const siteComponents = vi.fn();
const testComponentConnection = vi.fn();
const createComponent = vi.fn();

vi.mock('../api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../api');
  return {
    ...actual,
    api: {
      componentTemplates: () => componentTemplates(),
      siteComponents: () => siteComponents(),
      testComponentConnection: (...a: unknown[]) => testComponentConnection(...a),
      createComponent: (...a: unknown[]) => createComponent(...a),
    },
  };
});

/** Bis zur Verbindungs-Maske: Tür → Marke → Modell. */
async function bisZurVerbindung() {
  render(<KomponenteHinzufuegenDrawer siteId="s1" onClose={() => {}} onSaved={() => {}} />);
  await screen.findByText('Gerät aus dem VoltPilot-Katalog');
  fireEvent.click(screen.getByText('Gerät aus dem VoltPilot-Katalog'));
  fireEvent.change(await screen.findByLabelText('Marke'), { target: { value: 'deye' } });
  fireEvent.change(await screen.findByLabelText('Modell'), {
    target: { value: template.templateRef },
  });
  await screen.findByLabelText(/IP-Adresse/);
}

function fuelleFormular() {
  fireEvent.change(screen.getByLabelText(/IP-Adresse/), { target: { value: '192.168.0.28' } });
  fireEvent.change(screen.getByLabelText(/Seriennummer/), { target: { value: '2985159064' } });
}

describe('der EINE Anlege-Assistent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    componentTemplates.mockResolvedValue([template]);
    siteComponents.mockResolvedValue({ componentAuthority: 'portal', components: [] });
    testComponentConnection.mockResolvedValue({
      results: [{ id: 'verbindung', ok: true, reading: { pvKw: 12.4, socPct: 87 } }],
    });
    createComponent.mockResolvedValue({ componentAuthority: 'portal', components: [] });
  });

  it('rendert die Verbindungsfelder AUS dem transport_schema der Vorlage', async () => {
    await bisZurVerbindung();
    // Genau die drei Felder der Vorlage - der Assistent kennt keine Marke.
    expect(screen.getByLabelText(/IP-Adresse des Datenloggers/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Seriennummer/)).toBeInTheDocument();
    // Die Vorgabe der Vorlage ist vorbelegt.
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('8899');
  });

  it('lässt „Verbindung testen" erst zu, wenn die Pflichtfelder stehen', async () => {
    await bisZurVerbindung();
    expect(screen.getByRole('button', { name: 'Verbindung testen' })).toBeDisabled();
    expect(screen.getByText(/Es fehlt noch/)).toBeInTheDocument();
    fuelleFormular();
    expect(screen.getByRole('button', { name: 'Verbindung testen' })).toBeEnabled();
  });

  it('hält „Weiter" zu, bis das Gerät wirklich geantwortet hat', async () => {
    await bisZurVerbindung();
    fuelleFormular();
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    await screen.findByText(/Diese Messwerte kommen gerade an/);
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled();
  });

  it('zeigt die gemeldeten Messwerte - und nur die gemeldeten', async () => {
    await bisZurVerbindung();
    fuelleFormular();
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    await screen.findByText('Solarleistung');
    expect(screen.getByText('Ladestand')).toBeInTheDocument();
    // Verbrauch/Netz hat dieses Gerät nicht gemeldet - sie erscheinen NICHT als 0.
    expect(screen.queryByText('Verbrauch')).not.toBeInTheDocument();
  });

  it('nennt einen Fehlschlag beim Namen und sperrt „Weiter" weiter', async () => {
    testComponentConnection.mockResolvedValue({
      results: [{ id: 'verbindung', ok: false, errorCode: 'no_answer' }],
    });
    await bisZurVerbindung();
    fuelleFormular();
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    await screen.findByText(/antwortet aber nicht wie erwartet/);
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();
  });

  it('entwertet den Beleg, sobald ein Feld geändert wird', async () => {
    await bisZurVerbindung();
    fuelleFormular();
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/IP-Adresse/), { target: { value: '192.168.0.99' } });
    // Genau das ist der Sinn der Pflicht: eine andere Adresse ist ein anderes Gerät.
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();
  });

  it('führt über Rolle + Bilanz-Hinweis zum Anlegen', async () => {
    await bisZurVerbindung();
    fuelleFormular();
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await screen.findByText('Was ist dieses Gerät?');
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();
    fireEvent.click(screen.getByText('Wechselrichter / Speicher'));
    expect(screen.getByText(/trägt die Energiebilanz/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await screen.findByText('Prüfen & anlegen');
    fireEvent.click(screen.getByRole('button', { name: 'Komponente anlegen' }));
    await waitFor(() => expect(createComponent).toHaveBeenCalled());
    expect(createComponent.mock.calls[0][1]).toMatchObject({
      templateRef: template.templateRef,
      role: 'inverter',
      connection: { ip: '192.168.0.28', serial: '2985159064' },
    });
    // Der Abschluss behauptet KEINE Zustellung.
    await screen.findByText(/sobald sie das nächste Mal/);
  });

  it('nennt eine Ablehnung des Servers im Klartext', async () => {
    // Der DEUTSCHE Server-Grund muss den Kunden erreichen, nicht ein Statuscode.
    createComponent.mockRejectedValue(
      new ApiError(422, 'Bitte prüfen Sie zuerst die Verbindung zu diesem Gerät.'),
    );
    await bisZurVerbindung();
    fuelleFormular();
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(await screen.findByText('Weiterer Erzeuger'));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Komponente anlegen' }));
    await waitFor(() => expect(createComponent).toHaveBeenCalled());
    await screen.findByText('Bitte prüfen Sie zuerst die Verbindung zu diesem Gerät.');
  });

  it('zeigt die Selbstbau-Tür, lässt sie aber nicht anklicken', async () => {
    render(<KomponenteHinzufuegenDrawer siteId="s1" onClose={() => {}} onSaved={() => {}} />);
    const tuer = await screen.findByText('Eigenes Gerät (Modbus)');
    expect(screen.getByText('Bald verfügbar.')).toBeInTheDocument();
    expect(tuer.closest('button')).toBeDisabled();
  });
});
