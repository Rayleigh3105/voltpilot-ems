import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { AnlegenFlow } from './AnlegenFlow';

const template = {
  templateRef: 'builtin:deye:sun-30k-sg01hp3',
  kind: 'builtin',
  version: 1,
  brand: 'deye',
  brandLabel: 'Deye',
  model: 'sun-30k-sg01hp3',
  modelLabel: 'SUN-30K-SG01HP3-EU',
  deviceType: 'inverter',
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

/** Dieselbe Marke MIT Skalierungs-Feld - den Hebel gibt es nur, wo es sie gibt. */
const templateMitSkala = {
  ...template,
  transportSchema: [
    ...template.transportSchema,
    {
      key: 'power_scale',
      label: 'Leistungsskalierung',
      type: 'select',
      default: 0,
      options: [
        { value: 0, label: 'Automatisch' },
        { value: 10, label: 'Dekawatt (×10)' },
      ],
    },
  ],
};

/** Das Geschwister-Modell, das den Modell-Hebel überhaupt erst möglich macht. */
const geschwisterTemplate = {
  ...template,
  templateRef: 'builtin:deye:sun-25k-sg02hp3-eu-am3',
  model: 'sun-25k-sg02hp3-eu-am3',
  modelLabel: 'SUN-25K-SG02HP3-EU-AM3',
};

const componentTemplates = vi.fn();
const siteComponents = vi.fn();
const testComponentConnection = vi.fn();
const createComponent = vi.fn();
const readCustomComponent = vi.fn();
const createCustomComponent = vi.fn();
const matchComponent = vi.fn();
// Der Anbinde-Assistent hinter der Ladesäulen-Karte holt sich seine zwei Listen
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

function knopf(name: string | RegExp) {
  return screen.getByRole('button', { name });
}

/** Schritt 1 → 2: die Typ-Karte „Wechselrichter". */
async function bisZurGeraetewahl() {
  render(<AnlegenFlow siteId="s1" onClose={() => {}} onSaved={() => {}} />);
  fireEvent.click(await screen.findByTestId('typ-wechselrichter'));
  return screen.findByRole('combobox', { name: 'Gerät' });
}

/** Schritt 1 → 3: Typ, Modell, Weiter. */
async function bisZurVerbindung(modell = template.modelLabel) {
  await bisZurGeraetewahl();
  fireEvent.click(screen.getByRole('combobox', { name: 'Gerät' }));
  fireEvent.click(screen.getByRole('option', { name: new RegExp(modell) }));
  fireEvent.click(knopf('Weiter'));
  await screen.findByLabelText(/IP-Adresse/);
}

function fuelleFormular() {
  fireEvent.change(screen.getByLabelText(/IP-Adresse/), { target: { value: '192.168.0.28' } });
  fireEvent.change(screen.getByLabelText(/Seriennummer/), { target: { value: '2985159064' } });
}

/** Schritt 1 → 4: bis der Test gelaufen ist. */
async function bisZumTest(modell = template.modelLabel) {
  await bisZurVerbindung(modell);
  fuelleFormular();
  fireEvent.click(knopf('Weiter'));
  await screen.findByText('Verbindung testen');
}

function standardMocks() {
  vi.clearAllMocks();
  componentTemplates.mockResolvedValue([template]);
  chargingConfig.mockResolvedValue({
    gridLimitKw: null,
    priorityChargePointIds: [],
    chargePoints: [],
  });
  siteChargers.mockResolvedValue({ budget: null, chargers: [] });
  siteComponents.mockResolvedValue({ componentAuthority: 'portal', components: [] });
  testComponentConnection.mockResolvedValue({
    results: [{ id: 'verbindung', ok: true, reading: { pvKw: 12.4, socPct: 87 } }],
  });
  createComponent.mockResolvedValue({
    componentAuthority: 'portal',
    components: [{ id: 'neu-1', definitionVersion: 2 }],
  });
  matchComponent.mockResolvedValue(undefined);
}

describe('der neue Anlege-Fluss', () => {
  beforeEach(standardMocks);

  it('fragt ZUERST nach dem Gerätetyp - sechs Karten, keine Vorlagen-Herkunft', async () => {
    render(<AnlegenFlow siteId="s1" onClose={() => {}} onSaved={() => {}} />);
    await screen.findByText('Was möchten Sie anbinden?');
    for (const id of [
      'wechselrichter',
      'wallbox',
      'ladesaeule',
      'verbraucher',
      'zaehler',
      'eigenbau',
    ]) {
      expect(screen.getByTestId(`typ-${id}`)).toBeInTheDocument();
    }
    // Die alte Frage nach der HERKUNFT der Vorlage gibt es nicht mehr.
    expect(screen.queryByText('Gerät aus dem VoltPilot-Katalog')).toBeNull();
    expect(screen.queryByText('Geprüfte Vorlage')).toBeNull();
  });

  it('zeigt die benannten Schritte des gewählten Weges', async () => {
    render(<AnlegenFlow siteId="s1" onClose={() => {}} onSaved={() => {}} />);
    const leiste = await screen.findByLabelText('Schritte');
    expect(leiste.textContent).toContain('Was anbinden');
    expect(leiste.textContent).toContain('Gerät wählen');
    expect(leiste.textContent).toContain('Verbinden');
    expect(leiste.textContent).toContain('Testen');
    expect(leiste.textContent).toContain('Fertig');
    // Der Eigenbau-Weg stellt andere Fragen - und sagt das.
    fireEvent.click(screen.getByTestId('typ-eigenbau'));
    expect((await screen.findByLabelText('Schritte')).textContent).toContain('Messwerte');
  });

  it('rendert die Verbindungsfelder AUS dem transport_schema der Vorlage', async () => {
    await bisZurVerbindung();
    expect(screen.getByLabelText(/IP-Adresse des Datenloggers/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Seriennummer/)).toBeInTheDocument();
  });

  it('räumt die Experten-Angaben unter „Erweitert" - erreichbar, aber nicht im Weg', async () => {
    await bisZurVerbindung();
    // Der Port ist KEIN Pflichtfeld - er steht im Aufklapper, mit seiner Vorgabe.
    const details = screen.getByText('Erweitert').closest('details') as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.contains(screen.getByLabelText('Port'))).toBe(true);
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('8899');
    // Die Pflichtfelder stehen oben, nicht darin.
    expect(details.contains(screen.getByLabelText(/IP-Adresse/))).toBe(false);
  });

  it('hält „Weiter" zu, solange Pflichtfelder fehlen', async () => {
    await bisZurVerbindung();
    expect(knopf('Weiter')).toBeDisabled();
    expect(screen.getByText(/Es fehlt noch/)).toBeInTheDocument();
    fuelleFormular();
    expect(knopf('Weiter')).toBeEnabled();
  });

  it('testet beim Betreten des Schritts „Testen" von selbst', async () => {
    await bisZumTest();
    await waitFor(() => expect(testComponentConnection).toHaveBeenCalledTimes(1));
    await screen.findByText(/Diese Messwerte kommen gerade an/);
    expect(screen.getByText('Solarleistung')).toBeInTheDocument();
    expect(screen.getByText('Ladestand')).toBeInTheDocument();
    // Verbrauch/Netz hat dieses Gerät nicht gemeldet - sie erscheinen NICHT als 0.
    expect(screen.queryByText('Verbrauch')).toBeNull();
  });

  it('hält „Komponente anlegen" zu, bis das Gerät wirklich geantwortet hat', async () => {
    testComponentConnection.mockResolvedValue({
      results: [{ id: 'verbindung', ok: false, errorCode: 'no_answer' }],
    });
    await bisZumTest();
    await screen.findByText(/antwortet aber nicht wie erwartet/);
    expect(knopf('Komponente anlegen')).toBeDisabled();
    expect(screen.queryByTestId('fertigmachen')).toBeNull();
  });

  it('entwertet den Beleg, sobald ein Feld geändert wird', async () => {
    await bisZumTest();
    await waitFor(() => expect(knopf('Komponente anlegen')).toBeEnabled());
    fireEvent.click(knopf('Zurück'));
    fireEvent.change(await screen.findByLabelText(/IP-Adresse/), {
      target: { value: '192.168.0.99' },
    });
    fireEvent.click(knopf('Weiter'));
    // Genau das ist der Sinn der Pflicht: eine andere Adresse ist ein anderes
    // Gerät - es wird ERNEUT getestet.
    await waitFor(() => expect(testComponentConnection).toHaveBeenCalledTimes(2));
  });

  it('führt vom Typ bis zum Anlegen - mit denselben Aufrufen wie zuvor', async () => {
    const onSaved = vi.fn();
    render(<AnlegenFlow siteId="s1" onClose={() => {}} onSaved={onSaved} />);
    fireEvent.click(await screen.findByTestId('typ-wechselrichter'));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Gerät' }));
    fireEvent.click(screen.getByRole('option', { name: new RegExp(template.modelLabel) }));
    fireEvent.click(knopf('Weiter'));
    await screen.findByLabelText(/IP-Adresse/);
    fuelleFormular();
    fireEvent.click(knopf('Weiter'));

    await screen.findByTestId('fertigmachen');
    expect(screen.getByText(/trägt die Energiebilanz/)).toBeInTheDocument();
    fireEvent.click(knopf('Komponente anlegen'));

    await waitFor(() => expect(createComponent).toHaveBeenCalled());
    expect(createComponent.mock.calls[0][1]).toMatchObject({
      templateRef: template.templateRef,
      role: 'inverter',
      connection: { ip: '192.168.0.28', serial: '2985159064' },
    });
    expect(onSaved).toHaveBeenCalled();
    // Schritt 5: was entstanden ist - und der Abschluss behauptet KEINE Zustellung.
    await screen.findByTestId('schritt-fertig');
    expect(screen.getByText(/ist angelegt\./)).toBeInTheDocument();
    expect(screen.getByText(/sobald sie das nächste Mal/)).toBeInTheDocument();
    expect(knopf('Zur Komponente')).toBeInTheDocument();
  });

  it('springt aus „Fertig" auf die angelegte Komponente', async () => {
    const onClose = vi.fn();
    render(<AnlegenFlow siteId="s1" onClose={onClose} onSaved={() => {}} />);
    fireEvent.click(await screen.findByTestId('typ-wechselrichter'));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Gerät' }));
    fireEvent.click(screen.getByRole('option', { name: new RegExp(template.modelLabel) }));
    fireEvent.click(knopf('Weiter'));
    await screen.findByLabelText(/IP-Adresse/);
    fuelleFormular();
    fireEvent.click(knopf('Weiter'));
    fireEvent.click(await screen.findByRole('button', { name: 'Komponente anlegen' }));
    await screen.findByTestId('schritt-fertig');

    fireEvent.click(knopf('Zur Komponente'));
    expect(window.location.hash).toBe('#/anlage/s1/modell?komponente=neu-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('verlinkt NICHTS, wenn die neue Komponente nicht belegt ist', async () => {
    // Ein Server, der die Liste nicht zurückgibt (oder ein Nebenlauf): dann
    // wird keine Komponente behauptet, sondern nur geschlossen.
    createComponent.mockResolvedValue({ componentAuthority: 'portal', components: [] });
    await bisZumTest();
    fireEvent.click(await screen.findByRole('button', { name: 'Komponente anlegen' }));
    await screen.findByTestId('schritt-fertig');
    expect(screen.queryByRole('button', { name: 'Zur Komponente' })).toBeNull();
    // ⚠ Im FUSS, nicht das Kreuz im Kopf - beide heißen „Schließen".
    expect(
      within(screen.getByTestId('anlegen-fuss')).getByRole('button', { name: 'Schließen' }),
    ).toBeInTheDocument();
  });

  /*
    „Weiteres Gerät anbinden" ohne den Dialog zu schließen. Geprüft wird das
    BEOBACHTBARE: der zweite Durchlauf beginnt wirklich von vorn - nichts
    vorgewählt, kein Name des ersten Geräts, und ein NEUER Verbindungstest.
    (Ein stehengebliebenes „bestanden" liesse das zweite Gerät ohne eine
    einzige Prüfung anlegen - genau davor schützt die Testpflicht.)
  */
  it('setzt für ein zweites Gerät wirklich alles zurück', async () => {
    await bisZumTest();
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Erstes Gerät' },
    });
    fireEvent.click(knopf('Komponente anlegen'));
    await screen.findByTestId('schritt-fertig');
    expect(screen.getByText(/„Erstes Gerät" ist angelegt\./)).toBeInTheDocument();

    fireEvent.click(knopf('Weiteres Gerät anbinden'));
    await screen.findByText('Was möchten Sie anbinden?');
    fireEvent.click(screen.getByTestId('typ-wechselrichter'));
    // Nichts ist vorgewählt - der zweite Durchlauf beginnt wirklich von vorn.
    expect((await screen.findByRole('combobox', { name: 'Gerät' })).textContent).toContain(
      'Marke und Modell wählen',
    );
    expect(knopf('Weiter')).toBeDisabled();
    fireEvent.click(screen.getByRole('combobox', { name: 'Gerät' }));
    fireEvent.click(screen.getByRole('option', { name: new RegExp(template.modelLabel) }));
    fireEvent.click(knopf('Weiter'));
    await screen.findByLabelText(/IP-Adresse/);
    fuelleFormular();
    fireEvent.click(knopf('Weiter'));

    // Der NAME des ersten Geräts reist nicht mit - er würde beim Speichern
    // mitgeschickt und die zweite Komponente falsch benennen.
    expect(((await screen.findByLabelText('Name')) as HTMLInputElement).value).toBe('');
    // Und getestet wird wirklich neu - kein stehengebliebener Beleg.
    await waitFor(() => expect(testComponentConnection).toHaveBeenCalledTimes(2));
    fireEvent.click(knopf('Komponente anlegen'));
    await waitFor(() => expect(createComponent).toHaveBeenCalledTimes(2));
    expect(createComponent.mock.calls[1][1].label).toBeUndefined();
  });

  it('nennt eine Ablehnung des Servers im Klartext', async () => {
    createComponent.mockRejectedValue(
      new ApiError(422, 'Bitte prüfen Sie zuerst die Verbindung zu diesem Gerät.'),
    );
    await bisZumTest();
    fireEvent.click(await screen.findByRole('button', { name: 'Komponente anlegen' }));
    await screen.findByText('Bitte prüfen Sie zuerst die Verbindung zu diesem Gerät.');
    // Und der Fluss bleibt stehen, wo er war - kein „Fertig" ohne Ergebnis.
    expect(screen.queryByTestId('schritt-fertig')).toBeNull();
  });
});

describe('die Rolle folgt der Typ-Karte', () => {
  beforeEach(standardMocks);

  it('stellt nur beim Wechselrichter die Rest-Frage - und schlägt die erste vor', async () => {
    await bisZurGeraetewahl();
    const wahl = await screen.findByTestId('rollen-wahl');
    expect(wahl.textContent).toContain('Wechselrichter / Speicher');
    expect(wahl.textContent).toContain('Weiterer Erzeuger');
    expect(wahl.querySelector('.is-on')?.textContent).toContain('Wechselrichter / Speicher');
  });

  it('schlägt auf einer Anlage MIT Wechselrichter den weiteren Erzeuger vor', async () => {
    siteComponents.mockResolvedValue({
      componentAuthority: 'portal',
      components: [{ id: 'wr', role: 'inverter', definitionVersion: 1 }],
    });
    await bisZurGeraetewahl();
    const wahl = await screen.findByTestId('rollen-wahl');
    expect(wahl.querySelector('.is-on')?.textContent).toContain('Weiterer Erzeuger');
    // ⚠ Blockiert wird nichts: der Server übernimmt eine komponierte Zeile.
    for (const b of wahl.querySelectorAll('button')) expect(b).toBeEnabled();
  });

  it('stellt bei der Wallbox gar keine Frage und legt sie als Verbraucher an', async () => {
    componentTemplates.mockResolvedValue([
      { ...template, templateRef: 'builtin:go-e:charger', brand: 'go-e', brandLabel: 'go-e',
        model: 'charger', modelLabel: 'go-e Charger', deviceType: 'wallbox' },
    ]);
    render(<AnlegenFlow siteId="s1" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByTestId('typ-wallbox'));
    await screen.findByRole('combobox', { name: 'Gerät' });
    expect(screen.queryByTestId('rollen-wahl')).toBeNull();

    fireEvent.click(screen.getByRole('combobox', { name: 'Gerät' }));
    fireEvent.click(screen.getByRole('option', { name: /go-e Charger/ }));
    fireEvent.click(knopf('Weiter'));
    fuelleFormular();
    fireEvent.click(knopf('Weiter'));
    fireEvent.click(await screen.findByRole('button', { name: 'Komponente anlegen' }));
    await waitFor(() => expect(createComponent).toHaveBeenCalled());
    expect(createComponent.mock.calls[0][1]).toMatchObject({ role: 'consumer' });
  });

  it('nennt an der Zähler-Karte den GRUND der weiten Liste, statt sie leer zu lassen', async () => {
    render(<AnlegenFlow siteId="s1" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByTestId('typ-zaehler'));
    // Der Katalog kennt (noch) keine Zähler-Vorlage - die Liste weitet sich
    // SICHTBAR, statt den alten Weg ersatzlos zu streichen.
    expect(await screen.findByTestId('typ-erweitert')).toHaveTextContent(
      /noch keine eigene Vorlage/,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Gerät' }));
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('sperrt den zweiten Netz-Zähler mit seinem Grund', async () => {
    siteComponents.mockResolvedValue({
      componentAuthority: 'portal',
      components: [{ id: 'z', role: 'grid-meter', definitionVersion: 1 }],
    });
    render(<AnlegenFlow siteId="s1" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByTestId('typ-zaehler'));
    expect(await screen.findByText(/bereits einen Netz-Zähler/)).toBeInTheDocument();
  });
});

describe('die anderen Türen desselben Flusses', () => {
  beforeEach(standardMocks);

  it('führt hinter der Ladesäulen-Karte den ANBINDE-Assistenten, ohne etwas anzulegen', async () => {
    render(<AnlegenFlow siteId="s1" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByTestId('typ-ladesaeule'));

    const block = await screen.findByTestId('typ-ladesaeule');
    expect(block).toHaveTextContent(/verbinden sich selbst/);
    // ⚠ Es ist DERSELBE Körper wie im Drawer der Ladevorgänge-Seite (E1).
    expect(await screen.findByTestId('ladesaeule-anbinden')).toBeTruthy();
    expect(screen.getByLabelText('Kennung')).toBeTruthy();
    // Weiterhin KEIN Gerät-Anlegen.
    expect(screen.queryByRole('combobox', { name: 'Gerät' })).toBeNull();
    expect(screen.queryByText('Verbindung testen')).toBeNull();
  });

  /*
    Einheitsmodell Stufe 6: „Gerät daraus anlegen" an einer EIGENEN Vorlage.
    Die Typ-Frage ist damit schon beantwortet - der Fluss startet vorbefüllt im
    Eigenbau-Weg, und „Zurück" schließt, statt in eine Frage zu führen, die es
    hier nicht gibt.
  */
  it('startet mit einer eigenen Vorlage direkt im Eigenbau-Weg, vorbefüllt', async () => {
    const onClose = vi.fn();
    render(
      <AnlegenFlow
        siteId="s1"
        onClose={onClose}
        onSaved={() => {}}
        vorlage={{
          templateRef: 'custom:s1:waermepumpe',
          label: 'Wärmepumpe Keller',
          version: 1,
          connection: { port: 5020, unit_id: 3 },
          channels: [
            {
              label: 'Vorlauf',
              unit: '°C',
              register: { kind: 'holding', address: 100, data_type: 'u16' },
              scale: 0.1,
            },
          ],
        } as never}
      />,
    );
    await screen.findByText('Wo steht das Gerät?');
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('5020');
    // ⚠ Die ADRESSE bleibt leer - eine Vorlage beschreibt einen Gerätetyp,
    // kein Exemplar.
    expect((screen.getByLabelText('Adresse im Netzwerk') as HTMLInputElement).value).toBe('');
    fireEvent.click(knopf('Zurück'));
    expect(onClose).toHaveBeenCalled();
  });

  it('führt die Eigenbau-Schritte IM selben Fluss bis zum Anlegen', async () => {
    readCustomComponent.mockResolvedValue({
      ok: true,
      raw: 13750,
      registers: [13750],
      value: 1375,
      unit: '°C',
      hint: 'Diese Temperatur sieht nach einer falschen Skalierung aus.',
      receipt: true,
    });
    createCustomComponent.mockResolvedValue({ components: [{ id: 'sb-1' }] });

    render(<AnlegenFlow siteId="s1" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByTestId('typ-eigenbau'));
    await screen.findByText('Wo steht das Gerät?');

    // Ein öffentliches Ziel wird SOFORT benannt und lässt nicht weiter.
    fireEvent.change(screen.getByLabelText('Adresse im Netzwerk'), {
      target: { value: '8.8.8.8' },
    });
    expect(
      screen.getAllByRole('status').map((e) => e.textContent).join(' '),
    ).toMatch(/nicht nachweisbar/);
    expect(knopf('Weiter')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Adresse im Netzwerk'), {
      target: { value: '192.168.1.50' },
    });
    fireEvent.click(knopf('Weiter'));

    await screen.findByText('Welche Messwerte liefert das Gerät?');
    // Die Schrittleiste des Wirts ist mitgewandert.
    expect(screen.getByLabelText('Schritte').querySelector('.is-active')?.textContent)
      .toContain('Messwerte');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Vorlauf' } });
    fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: '100' } });
    fireEvent.click(knopf('Jetzt lesen'));
    await screen.findByText('13.750');
    expect(screen.getByText('1.375 °C')).toBeInTheDocument();

    await waitFor(() => expect(knopf('Weiter')).toBeEnabled());
    fireEvent.click(knopf('Weiter'));
    await screen.findByText('Was ist dieses Gerät?');
    fireEvent.click(knopf('Weiter'));
    fireEvent.click(await screen.findByRole('button', { name: 'Komponente anlegen' }));

    await waitFor(() => expect(createCustomComponent).toHaveBeenCalled());
    // Der GEMEINSAME Abschluss-Schritt - der Selbstbau-Weg hat keinen eigenen.
    await screen.findByTestId('schritt-fertig');
    expect(knopf('Zur Komponente')).toBeInTheDocument();
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
    standardMocks();
    testComponentConnection.mockResolvedValue(unplausibel);
  });

  it('zeigt die gelesenen Werte und die verletzte Regel statt eines nackten „unplausibel"', async () => {
    await bisZumTest();
    await screen.findByText(/Ladestand liest 0 %/);
    expect(screen.getByText('6,1 kW')).toBeTruthy();
    expect(screen.getByText('4,3 kW')).toBeTruthy();
    // Der Ladestand selbst wird NIE als Wert gezeigt - er ist ja der Befund.
    expect(screen.queryByText('Ladestand')).toBeNull();
  });

  it('führt über die Rückfrage bis zum Speichern - MIT der genannten Zustimmung', async () => {
    await bisZumTest();
    const anbieten = await screen.findByTestId('override-anbieten');
    // Ohne den Klick bleibt das Anlegen zu - die Pflicht gilt unverändert.
    expect(knopf('Komponente anlegen')).toBeDisabled();

    fireEvent.click(anbieten);
    await screen.findByText('Ohne Ladestand fortfahren?');
    expect(screen.getByText(/Steuerung des Speichers bleibt aus/)).toBeTruthy();
    fireEvent.click(screen.getByText('Trotzdem fortfahren'));

    await screen.findByTestId('override-aktiv');
    fireEvent.click(await screen.findByRole('button', { name: 'Komponente anlegen' }));
    await waitFor(() => expect(createComponent).toHaveBeenCalled());
    expect(createComponent.mock.calls[0][1]).toMatchObject({
      role: 'inverter',
      acceptMissingChannel: 'soc_pct',
    });
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
    await bisZumTest();
    await screen.findByText(/Modellauswahl/);
    expect(screen.queryByTestId('override-anbieten')).toBeNull();
    expect(knopf('Komponente anlegen')).toBeDisabled();
  });
});

describe('Alias-Kontinuität im neuen Fluss', () => {
  beforeEach(standardMocks);

  it('füllt das Namensfeld NICHT mit dem Modellnamen vor', async () => {
    await bisZumTest();
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(name.value).toBe('');
    expect(name.placeholder).toBe(template.modelLabel);
    fireEvent.click(knopf('Komponente anlegen'));
    await waitFor(() => expect(createComponent).toHaveBeenCalled());
    expect(createComponent.mock.calls[0][1].label).toBeUndefined();
  });

  it('kündigt die ÜBERNAHME an, bevor gespeichert wird', async () => {
    matchComponent.mockResolvedValue({
      entityId: 'wr1',
      label: 'Fronius Anlage WR1',
      role: 'pv-generation',
      orphaned: true,
    });
    await bisZumTest();
    const hinweis = await screen.findByText(/statt eine zweite anzulegen/);
    expect(hinweis).toHaveTextContent('Fronius Anlage WR1');
    expect(screen.getByText(/Leer lassen behält den bisherigen Namen/)).toHaveTextContent(
      'Fronius Anlage WR1',
    );
    expect(screen.getByText('Vorhandene Komponente wird wieder verbunden')).toBeInTheDocument();

    // Und der Abschluss sagt „wieder verbunden", nicht „angelegt".
    fireEvent.click(knopf('Komponente anlegen'));
    await screen.findByTestId('schritt-fertig');
    expect(screen.getByText(/ist wieder verbunden\./)).toBeInTheDocument();
  });

  it('entwertet den Übernahme-Vorschlag, sobald die Verbindung sich ändert', async () => {
    matchComponent.mockResolvedValue({ entityId: 'wr1', label: 'Fronius Anlage WR1' });
    await bisZumTest();
    await screen.findByText(/statt eine zweite anzulegen/);
    fireEvent.click(knopf('Zurück'));
    fireEvent.change(await screen.findByLabelText(/IP-Adresse/), {
      target: { value: '192.168.0.99' },
    });
    expect(screen.queryByText(/statt eine zweite anzulegen/)).toBeNull();
  });

  it('bleibt ohne die Vorschlags-Route unverändert (älteres Backend)', async () => {
    matchComponent.mockRejectedValue(new ApiError(404, 'nicht gefunden'));
    await bisZumTest();
    await screen.findByLabelText('Name');
    expect(screen.queryByText(/statt eine zweite anzulegen/)).toBeNull();
    expect(knopf('Komponente anlegen')).toBeEnabled();
  });
});

describe('die Hebel des Verbindungstests', () => {
  beforeEach(() => {
    standardMocks();
    componentTemplates.mockResolvedValue([templateMitSkala, geschwisterTemplate]);
  });

  it('führt beim unmöglichen Messwert zurück in die Modellwahl', async () => {
    testComponentConnection.mockResolvedValue({
      results: [
        {
          id: 'verbindung',
          ok: false,
          errorCode: 'implausible',
          reading: { pvKw: 6.1 },
          finding: { channel: 'soc_pct', rule: 'out_of_range', raw: 12700, value: 1270 },
        },
      ],
    });
    await bisZumTest();
    fireEvent.click(await screen.findByTestId('hebel-modell'));
    const picker = await screen.findByRole('combobox', { name: 'Gerät' });
    expect(picker.textContent).toContain('SUN-30K-SG01HP3-EU');
    fireEvent.click(picker);
    expect(screen.getAllByRole('option').map((o) => o.textContent).join(' ')).toContain(
      'SUN-25K-SG02HP3-EU-AM3',
    );
  });

  it('springt bei „nichts antwortet" die Seriennummer an, ohne sie zu ändern', async () => {
    testComponentConnection.mockResolvedValue({ errorCode: 'unreachable' });
    await bisZumTest();
    fireEvent.click(await screen.findByTestId('hebel-logger'));
    await waitFor(() =>
      expect((screen.getByLabelText(/Seriennummer/) as HTMLInputElement).value).toBe('2985159064'),
    );
  });

  it('öffnet „Erweitert", wenn der Hebel auf ein Feld darin zeigt', async () => {
    testComponentConnection.mockResolvedValue({
      results: [{ id: 'verbindung', ok: true, reading: { pvKw: 300, socPct: 87 } }],
    });
    await bisZumTest();
    fireEvent.click(await screen.findByTestId('hebel-skalierung'));
    // ⚠ Ein Sprung ins Eingeklappte wäre ein Klick ins Unsichtbare.
    const details = (await screen.findByText('Erweitert')).closest(
      'details',
    ) as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Leistungsskalierung' })).toHaveTextContent('10');
  });

  it('bietet GAR KEINEN Hebel, wo es keinen belegten gibt', async () => {
    componentTemplates.mockResolvedValue([template]);
    await bisZumTest();
    await screen.findByText(/Das Gerät antwortet/);
    expect(screen.queryByTestId('test-hebel')).toBeNull();
  });
});
