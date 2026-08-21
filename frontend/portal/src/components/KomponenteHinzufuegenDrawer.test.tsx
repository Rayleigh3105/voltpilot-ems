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
const readCustomComponent = vi.fn();
const createCustomComponent = vi.fn();
const matchComponent = vi.fn();
// Der Anbinde-Assistent hinter der Ladesäulen-Tür holt sich seine zwei Listen
// selbst (Allowlist + gemeldete Säulen).
const chargingConfig = vi.fn();
const siteChargers = vi.fn();
const admitChargePoint = vi.fn();

vi.mock('../api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../api');
  return {
    ...actual,
    api: {
      componentTemplates: () => componentTemplates(),
      siteComponents: () => siteComponents(),
      testComponentConnection: (...a: unknown[]) => testComponentConnection(...a),
      chargingConfig: (...a: unknown[]) => chargingConfig(...a),
      siteChargers: (...a: unknown[]) => siteChargers(...a),
      admitChargePoint: (...a: unknown[]) => admitChargePoint(...a),
      createComponent: (...a: unknown[]) => createComponent(...a),
      readCustomComponent: (...a: unknown[]) => readCustomComponent(...a),
      createCustomComponent: (...a: unknown[]) => createCustomComponent(...a),
      matchComponent: (...a: unknown[]) => matchComponent(...a),
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
    chargingConfig.mockResolvedValue({
      gridLimitKw: null, priorityChargePointIds: [], chargePoints: [],
    });
    siteChargers.mockResolvedValue({ budget: null, chargers: [] });
    siteComponents.mockResolvedValue({ componentAuthority: 'portal', components: [] });
    testComponentConnection.mockResolvedValue({
      results: [{ id: 'verbindung', ok: true, reading: { pvKw: 12.4, socPct: 87 } }],
    });
    createComponent.mockResolvedValue({ componentAuthority: 'portal', components: [] });
    matchComponent.mockResolvedValue(undefined);
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

  it('öffnet die Selbstbau-Tür in ihren eigenen Assistenten', async () => {
    render(<KomponenteHinzufuegenDrawer siteId="s1" onClose={() => {}} onSaved={() => {}} />);
    const tuer = await screen.findByText('Eigenes Gerät (Modbus)');
    expect(tuer.closest('button')).toBeEnabled();
    // ⚠ Kein Hinhalte-Satz mehr an einer offenen Tür.
    expect(screen.queryByText('Bald verfügbar.')).toBeNull();

    fireEvent.click(tuer);
    // Sie hat KEINE Vorlagen-Auswahl - sie fragt sofort nach dem Gerät, und
    // ihre Schrittleiste heißt anders als die der Katalog-Tür.
    await screen.findByText('Wo steht das Gerät?');
    expect(screen.queryByLabelText('Marke')).toBeNull();
    expect(screen.getByText('Messwerte')).toBeInTheDocument();
  });

  /*
    Anlagen-Zentrale Stufe 3 (PR 3c, §13.4): die vierte Tür erklärt den Weg zur
    Ladesäule - sie legt NICHTS an, weil eine Säule sich selbst verbindet.
  */
  it('führt hinter der Ladesäulen-Tür den ASSISTENTEN, statt ein Gerät anzulegen', async () => {
    render(<KomponenteHinzufuegenDrawer siteId="s1" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByText('Ladesäule (OCPP)'));

    const block = await screen.findByTestId('tuer-ladesaeule');
    expect(block).toHaveTextContent(/verbinden sich selbst/);
    expect(block).toHaveTextContent(/ausschließlich Ladesäulen an, deren Kennung eingetragen ist/);
    // ⚠ Es ist DERSELBE Körper wie im Drawer der Ladevorgänge-Seite (E1) - eine
    // zweite Kopie wären zwei Wahrheiten über denselben Weg.
    expect(await screen.findByTestId('ladesaeule-anbinden')).toBeTruthy();
    expect(screen.getByLabelText('Kennung')).toBeTruthy();
    // Weiterhin KEIN Gerät-Anlegen: keine Marke, kein Verbindungstest.
    expect(screen.queryByLabelText('Marke')).toBeNull();
    expect(screen.queryByText('Verbindung testen')).toBeNull();
  });

  /**
   * Die ganze Reise der Selbstbau-Tür: ein öffentliches Ziel kommt gar nicht
   * erst zur Box, ein privates schon - und ohne gelesenen Messwert bleibt der
   * Weg zu.
   */
  it('führt vom Gerät über „Jetzt lesen" bis zum Anlegen', async () => {
    readCustomComponent.mockResolvedValue({
      ok: true, raw: 13750, registers: [13750], value: 1375, unit: '°C',
      hint: 'Diese Temperatur sieht nach einer falschen Skalierung aus.', receipt: true,
    });
    createCustomComponent.mockResolvedValue({ components: [] });

    render(<KomponenteHinzufuegenDrawer siteId="s1" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByText('Eigenes Gerät (Modbus)'));
    await screen.findByText('Wo steht das Gerät?');

    // Ein öffentliches Ziel wird SOFORT benannt und lässt nicht weiter.
    fireEvent.change(screen.getByLabelText('Adresse im Netzwerk'), {
      target: { value: '8.8.8.8' },
    });
    expect(screen.getByRole('status')).toHaveTextContent(/nicht nachweisbar/);
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Adresse im Netzwerk'), {
      target: { value: '192.168.1.50' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await screen.findByText('Welche Messwerte liefert das Gerät?');
    // Ohne gelesenen Messwert ist der Weg zu.
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Vorlauf' } });
    fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt lesen' }));

    // Roh UND umgerechnet nebeneinander - der Moment, in dem der Fehler
    // sichtbar wird -, plus der Hinweis, der NICHTS sperrt.
    await screen.findByText('13.750');
    expect(screen.getByText('1.375 °C')).toBeInTheDocument();
    expect(screen.getByText(/falschen Skalierung/)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    // Rolle: seit Stufe 4 sind BEIDE wählbar - der Verbraucher wird zunächst
    // ebenfalls nur lesend angelegt, das Schalten gibt ein eigener Schritt frei.
    await screen.findByText('Was ist dieses Gerät?');
    const verbraucher = screen.getByText('Schaltbarer Verbraucher').closest('button')!;
    expect(verbraucher).toBeEnabled();
    expect(verbraucher.textContent).toContain('eigenen Schritt frei');
    expect(screen.getByText(/Energiebilanz/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Komponente anlegen' }));
    await waitFor(() => expect(createCustomComponent).toHaveBeenCalled());
    const [, body] = createCustomComponent.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.connection).toMatchObject({ host: '192.168.1.50', port: 502, unitId: 1 });
    expect(body.channels).toHaveLength(1);
  });

  // --- Alias-Kontinuität (Live-Fall Herzogau, 20.08.2026) --------------------

  it('füllt das Namensfeld NICHT mit dem Modellnamen vor', async () => {
    // Genau diese Vorbefüllung hat den Kundennamen überschrieben: sie wurde
    // mitgeschickt und sah für den Server aus wie eine Eingabe.
    await bisZurVerbindung();
    fuelleFormular();
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(await screen.findByText('Weiterer Erzeuger'));

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(name.value).toBe('');
    expect(name.placeholder).toBe(template.modelLabel);

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await screen.findByText('Prüfen & anlegen');
    fireEvent.click(screen.getByRole('button', { name: 'Komponente anlegen' }));
    await waitFor(() => expect(createComponent).toHaveBeenCalled());
    expect(createComponent.mock.calls[0][1].label).toBeUndefined();
  });

  it('kündigt die ÜBERNAHME der vorhandenen Komponente an, bevor gespeichert wird', async () => {
    matchComponent.mockResolvedValue({
      entityId: 'wr1',
      label: 'Fronius Anlage WR1',
      role: 'pv-generation',
      orphaned: true,
    });
    await bisZurVerbindung();
    fuelleFormular();
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(await screen.findByText('Weiterer Erzeuger'));

    // Der Vorschlag steht VOR dem Klick, mit dem Namen, den der Kunde kennt.
    const hinweis = await screen.findByText(/statt eine zweite anzulegen/);
    expect(hinweis).toHaveTextContent('Fronius Anlage WR1');
    // Und die Hilfe darunter sagt, was ein LEERES Feld bedeutet.
    expect(screen.getByText(/Leer lassen behält den bisherigen Namen/))
      .toHaveTextContent('Fronius Anlage WR1');
    expect((screen.getByLabelText('Name') as HTMLInputElement).placeholder)
      .toBe('Fronius Anlage WR1');

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await screen.findByText('Prüfen & anlegen');
    expect(screen.getByText('Vorhandene Komponente wird wieder verbunden')).toBeInTheDocument();
  });

  it('entwertet den Übernahme-Vorschlag, sobald die Verbindung sich ändert', async () => {
    matchComponent.mockResolvedValue({ entityId: 'wr1', label: 'Fronius Anlage WR1' });
    await bisZurVerbindung();
    fuelleFormular();
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(await screen.findByText('Weiterer Erzeuger'));
    await screen.findByText(/statt eine zweite anzulegen/);

    // Zurück in die Verbindung, eine andere Adresse - das ist ein anderes Gerät.
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    fireEvent.change(await screen.findByLabelText(/IP-Adresse/), {
      target: { value: '192.168.0.99' },
    });
    expect(screen.queryByText(/statt eine zweite anzulegen/)).toBeNull();
  });

  it('bleibt ohne die Vorschlags-Route unverändert (älteres Backend)', async () => {
    matchComponent.mockRejectedValue(new ApiError(404, 'nicht gefunden'));
    await bisZurVerbindung();
    fuelleFormular();
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(await screen.findByText('Weiterer Erzeuger'));
    await screen.findByLabelText('Name');
    // Kein Vorschlag, keine Störung - der Assistent läuft weiter wie vorher.
    expect(screen.queryByText(/statt eine zweite anzulegen/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await screen.findByText('Prüfen & anlegen');
  });
});

describe('der Ausweg aus der Sackgasse (Live-Fall Mühlfeldweg 2)', () => {
  const unplausibel = {
    results: [
      {
        id: 'verbindung',
        ok: false,
        errorCode: 'implausible',
        reading: { pvKw: 6.1, loadKw: 4.3, gridKw: 1.2 },
        finding: { channel: 'soc_pct', rule: 'missing', raw: 0, value: 0 },
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    componentTemplates.mockResolvedValue([template]);
    chargingConfig.mockResolvedValue({
      gridLimitKw: null, priorityChargePointIds: [], chargePoints: [],
    });
    siteChargers.mockResolvedValue({ budget: null, chargers: [] });
    siteComponents.mockResolvedValue({ componentAuthority: 'portal', components: [] });
    createComponent.mockResolvedValue({ componentAuthority: 'portal', components: [] });
    matchComponent.mockResolvedValue(undefined);
    testComponentConnection.mockResolvedValue(unplausibel);
  });

  it('zeigt die gelesenen Werte und die verletzte Regel statt eines nackten „unplausibel"', async () => {
    await bisZurVerbindung();
    fuelleFormular();
    fireEvent.click(screen.getByText('Verbindung testen'));
    await screen.findByText(/Ladestand liest 0 %/);
    expect(screen.getByText('6,1 kW')).toBeTruthy();
    expect(screen.getByText('4,3 kW')).toBeTruthy();
    // Der Ladestand selbst wird NIE als Wert gezeigt - er ist ja der Befund.
    expect(screen.queryByText('Ladestand')).toBeNull();
  });

  it('führt über die Rückfrage bis zum Speichern - MIT der genannten Zustimmung', async () => {
    await bisZurVerbindung();
    fuelleFormular();
    fireEvent.click(screen.getByText('Verbindung testen'));
    const knopf = await screen.findByTestId('override-anbieten');

    // Ohne den Klick bleibt „Weiter" zu - die Pflicht gilt unverändert.
    expect((screen.getByText('Weiter').closest('button') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(knopf);
    // Die Rückfrage nennt die Folgen, inklusive dem, was AUS bleibt.
    await screen.findByText('Ohne Ladestand fortfahren?');
    expect(screen.getByText(/Steuerung des Speichers bleibt aus/)).toBeTruthy();
    fireEvent.click(screen.getByText('Trotzdem fortfahren'));

    await screen.findByTestId('override-aktiv');
    fireEvent.click(screen.getByText('Weiter'));
    fireEvent.click(await screen.findByText('Wechselrichter / Speicher'));
    fireEvent.click(screen.getByText('Weiter'));
    fireEvent.click(await screen.findByText('Komponente anlegen'));

    await waitFor(() => expect(createComponent).toHaveBeenCalled());
    expect(createComponent.mock.calls[0][1]).toMatchObject({
      role: 'inverter',
      acceptMissingChannel: 'soc_pct',
    });
  });

  it('entwertet die Zustimmung, sobald ein Verbindungsfeld sich ändert', async () => {
    await bisZurVerbindung();
    fuelleFormular();
    fireEvent.click(screen.getByText('Verbindung testen'));
    fireEvent.click(await screen.findByTestId('override-anbieten'));
    fireEvent.click(await screen.findByText('Trotzdem fortfahren'));
    await screen.findByTestId('override-aktiv');

    fireEvent.change(screen.getByLabelText(/IP-Adresse/), { target: { value: '192.168.0.29' } });
    expect(screen.queryByTestId('override-aktiv')).toBeNull();
    expect((screen.getByText('Weiter').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('bietet bei einem kaputten Rahmen KEINEN Ausweg an', async () => {
    testComponentConnection.mockResolvedValue({
      results: [
        {
          id: 'verbindung',
          ok: false,
          errorCode: 'implausible',
          reading: { pvKw: 6.1 },
          finding: { channel: 'soc_pct', rule: 'out_of_range', raw: 1250, value: 1250 },
        },
      ],
    });
    await bisZurVerbindung();
    fuelleFormular();
    fireEvent.click(screen.getByText('Verbindung testen'));
    await screen.findByText(/Modellauswahl/);
    expect(screen.queryByTestId('override-anbieten')).toBeNull();
    expect((screen.getByText('Weiter').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * Die Modell-SUCHE (NACHTRAG 5, Captain 21.08.2026).
 *
 * Sie ist der PRIMÄRE Weg über alle Marken; das Stufenmenü bleibt daneben
 * stehen. Beide schöpfen aus derselben Liste - hier wird geprüft, dass ein
 * Treffer wirklich dieselbe Vorlage wählt wie das Menü.
 */
describe('die Modell-Suche im Assistenten', () => {
  // Der Katalog-Eintrag der Vorlage trägt die Nennleistung - der Zusatz
  // beantwortet „ist das meins?" ohne Klick.
  const deye = { ...template, ratedKw: 30 };
  const fronius = {
    ...template,
    templateRef: 'builtin:fronius:symo-15',
    brand: 'fronius',
    brandLabel: 'Fronius',
    model: 'symo-15',
    modelLabel: 'Symo 15.0-3-M',
    family: 'sunspec_live',
    familyLabel: 'SunSpec',
    communication: 'fronius_sunspec',
    communicationLabel: 'SunSpec Modbus TCP',
    ratedKw: 15,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    componentTemplates.mockResolvedValue([deye, fronius]);
    siteComponents.mockResolvedValue({ componentAuthority: 'portal', components: [] });
    matchComponent.mockResolvedValue(undefined);
  });

  async function bisZurTuer() {
    render(<KomponenteHinzufuegenDrawer siteId="s1" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByText('Gerät aus dem VoltPilot-Katalog'));
    return screen.findByLabelText('Modell suchen');
  }

  it('führt ohne Marken-Auswahl direkt zum Modell - tolerant gegen Schreibweisen', async () => {
    const feld = await bisZurTuer();
    // Ohne jeden Bindestrich getippt - genau die Schreibweise, die das
    // Stufenmenü nie gefunden hätte.
    fireEvent.change(feld, { target: { value: 'sun30k' } });

    const treffer = await screen.findByTestId('suche-treffer');
    // Genau die eine Deye - die Fronius ist kein Treffer.
    expect(treffer.querySelectorAll('li').length).toBe(1);
    expect(treffer.textContent).toContain('SUN-30K-SG01HP3-EU');
    expect(treffer.textContent).toContain('Deye');
    // Der Zusatz beantwortet „ist das meins?" ohne Klick.
    expect(treffer.textContent).toContain('30 kW');
    expect(treffer.textContent).toContain('Hybrid, 3-phasig');
  });

  it('wählt über den Treffer DIESELBE Vorlage wie das Stufenmenü', async () => {
    const feld = await bisZurTuer();
    fireEvent.change(feld, { target: { value: 'symo' } });

    // Der Name ist durch die Hervorhebung in Stücke geteilt - geklickt wird
    // die Trefferzeile, nicht ein Textknoten.
    const treffer = await screen.findByTestId('suche-treffer');
    const zeile = treffer.querySelector('button') as HTMLButtonElement;
    expect(zeile.textContent).toContain('Symo 15.0-3-M');
    fireEvent.click(zeile);

    // Schritt 2 mit den Feldern GENAU dieser Vorlage.
    await screen.findByText('Verbindung zu Symo 15.0-3-M');
    // Und die Marke ist MITGEWANDERT, damit der Rückweg über das Stufenmenü
    // beim gefundenen Modell steht statt bei der Marke davor.
    fireEvent.click(screen.getByText('Zurück'));
    const marke = (await screen.findByLabelText('Marke')) as HTMLSelectElement;
    expect(marke.value).toBe('fronius');
  });

  it('sagt bei einem Tippfehler den WEG, statt still leer zu bleiben', async () => {
    const feld = await bisZurTuer();
    fireEvent.change(feld, { target: { value: 'huawei' } });

    const leer = await screen.findByTestId('suche-leer');
    expect(leer.textContent).toContain('Keine Vorlage passt');
    expect(leer.textContent).toContain('Marken-Auswahl');
    expect(screen.queryByTestId('suche-treffer')).toBeNull();
  });

  it('lässt das Stufenmenü daneben stehen', async () => {
    await bisZurTuer();
    // Der Stöber-Weg bleibt der Rückfall - er darf nie verschwinden.
    expect(screen.getByLabelText('Marke')).toBeTruthy();
  });

  it('zeigt ohne Eingabe weder Treffer noch Zähler', async () => {
    await bisZurTuer();
    expect(screen.queryByTestId('suche-treffer')).toBeNull();
    expect(screen.queryByTestId('suche-zaehler')).toBeNull();
    expect(screen.queryByTestId('suche-leer')).toBeNull();
  });
});
