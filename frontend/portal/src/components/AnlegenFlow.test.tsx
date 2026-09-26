import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { AnlegenFlow } from './AnlegenFlow';
import {
  recordCurrentNavigation,
  recordNewNavigation,
  replaceCurrentNavigation,
  requestNavigation,
} from '../navigationBlocker';

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
const componentTemplate = vi.fn();
const siteComponents = vi.fn();
const testComponentConnection = vi.fn();
const createComponent = vi.fn();
const updateComponent = vi.fn();
const readCustomComponent = vi.fn();
const createCustomComponent = vi.fn();
const matchComponent = vi.fn();
const duplicateCustomComponent = vi.fn();
// P5d: der Batterie-Weg holt seine Kurven-Vorlagen selbst.
const socCurveTemplates = vi.fn();
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
      componentTemplate: (...a: unknown[]) => componentTemplate(...a),
      siteComponents: () => siteComponents(),
      testComponentConnection: (...a: unknown[]) => testComponentConnection(...a),
      chargingConfig: (...a: unknown[]) => chargingConfig(...a),
      siteChargers: (...a: unknown[]) => siteChargers(...a),
      admitChargePoint: (...a: unknown[]) => admitChargePoint(...a),
      createComponent: (...a: unknown[]) => createComponent(...a),
      updateComponent: (...a: unknown[]) => updateComponent(...a),
      readCustomComponent: (...a: unknown[]) => readCustomComponent(...a),
      createCustomComponent: (...a: unknown[]) => createCustomComponent(...a),
      matchComponent: (...a: unknown[]) => matchComponent(...a),
      duplicateCustomComponent: (...a: unknown[]) => duplicateCustomComponent(...a),
      socCurveTemplates: () => socCurveTemplates(),
    },
  };
});

function knopf(name: string | RegExp) {
  return screen.getByRole('button', { name });
}

type FlowProps = Parameters<typeof AnlegenFlow>[0];

/**
 * Die EINRICHTEN-SEITE eines Katalog-Modells (Konzept „Aufbau und
 * Gerätekatalog"): Art und Modell sind im Katalog gewählt, die Seite öffnet mit
 * ihnen - kein Typ-Schritt, kein „Weiter".
 */
function oeffne(over: Partial<FlowProps> = {}) {
  return render(
    <AnlegenFlow
      siteId="s1"
      startTemplate={template as never}
      onClose={() => {}}
      onSaved={() => {}}
      {...over}
    />,
  );
}

/** Die Seite ist da, der Anschluss wartet auf seine Pflichtangaben. */
async function bisZurVerbindung(over: Partial<FlowProps> = {}) {
  oeffne(over);
  await screen.findByLabelText(/IP-Adresse/);
}

function fuelleFormular() {
  fireEvent.change(screen.getByLabelText(/IP-Adresse/), { target: { value: '192.168.0.28' } });
  fireEvent.change(screen.getByLabelText(/Seriennummer/), { target: { value: '2985159064' } });
  // Das Feld verlassen = fertig getippt: der Test läuft sofort (E4).
  fireEvent.blur(screen.getByLabelText(/Seriennummer/));
}

/** Bis der Test gelaufen ist - er läuft von selbst, sobald der Anschluss vollständig ist. */
async function bisZumTest(over: Partial<FlowProps> = {}) {
  await bisZurVerbindung(over);
  fuelleFormular();
  await waitFor(() => expect(testComponentConnection).toHaveBeenCalled());
}

/** „Speichern" im Fuß der Seite. */
function speichernKnopf() {
  return screen.getByTestId('einrichten-speichern');
}

/** Mit Beleg: der Abschnitt „Name" ist offen, „Speichern" frei. */
async function bisZumNamen(over: Partial<FlowProps> = {}) {
  await bisZumTest(over);
  await waitFor(() => expect(speichernKnopf()).toBeEnabled());
  return screen.findByLabelText('So erscheint es im Aufbau');
}

function standardMocks() {
  vi.clearAllMocks();
  componentTemplates.mockResolvedValue([template]);
  componentTemplate.mockResolvedValue(template);
  chargingConfig.mockResolvedValue({
    gridLimitKw: null,
    priorityChargePointIds: [],
    chargePoints: [],
  });
  siteChargers.mockResolvedValue({ budget: null, chargers: [] });
  siteComponents.mockResolvedValue({ componentAuthority: 'portal', components: [] });
  socCurveTemplates.mockResolvedValue([]);
  testComponentConnection.mockResolvedValue({
    results: [{ id: 'verbindung', ok: true, reading: { pvKw: 12.4, socPct: 87 } }],
  });
  createComponent.mockResolvedValue({
    componentAuthority: 'portal',
    components: [{ id: 'neu-1', definitionVersion: 2 }],
  });
  updateComponent.mockResolvedValue({
    componentAuthority: 'portal',
    components: [{ id: 'wr-1', definitionVersion: 4, syncStatus: 'pending' }],
  });
  matchComponent.mockResolvedValue(undefined);
}

describe('die Einrichten-Seite eines Katalog-Geräts', () => {
  beforeEach(standardMocks);

  it('öffnet mit dem gewählten Modell - Kopf mit „Sie brauchen", Abschnitte statt Schritten', async () => {
    oeffne();
    const seite = await screen.findByRole('dialog', { name: 'Gerät einrichten' });
    // Das Modell steht im Kopf der Seite - einmal, nicht zweimal.
    expect(within(seite).getAllByText('Deye SUN-30K-SG01HP3-EU')).toHaveLength(1);
    expect(within(seite).getByText('Sie brauchen:').closest('p')).toHaveTextContent(
      /IP-Adresse des Datenloggers.*Datenlogger-Seriennummer/,
    );
    for (const titel of ['Aufgabe in Ihrer Anlage', 'Anschluss', 'Test mit echten Werten', 'Name']) {
      expect(within(seite).getByRole('heading', { name: new RegExp(titel) })).toBeInTheDocument();
    }
    // Die alte Typ-Frage und das „Weiter" gibt es nicht mehr.
    expect(screen.queryByText('Was möchten Sie anbinden?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Weiter' })).toBeNull();
  });

  it('zeigt spätere Abschnitte nur mit ihrem Satz - kein Formular, das noch nichts tun kann', async () => {
    await bisZurVerbindung();
    expect(screen.getByText('Startet von selbst, sobald der Anschluss vollständig ist.')).toBeInTheDocument();
    expect(screen.getByText('Nach dem Test.')).toBeInTheDocument();
    expect(screen.queryByLabelText('So erscheint es im Aufbau')).toBeNull();
  });

  it('rendert die Verbindungsfelder AUS dem transport_schema der Vorlage', async () => {
    await bisZurVerbindung();
    expect(screen.getByLabelText(/IP-Adresse des Datenloggers/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Seriennummer/)).toBeInTheDocument();
  });

  it('räumt die Experten-Angaben unter „Weitere Angaben" - erreichbar, aber nicht im Weg', async () => {
    await bisZurVerbindung();
    // Der Port ist KEIN Pflichtfeld - er steht im Aufklapper, mit seiner Vorgabe.
    const details = screen.getByText('Weitere Angaben (1)').closest('details') as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.contains(screen.getByLabelText('Port'))).toBe(true);
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('8899');
    // Die Pflichtfelder stehen oben, nicht darin.
    expect(details.contains(screen.getByLabelText(/IP-Adresse/))).toBe(false);
  });

  it('hält „Speichern" zu, solange Pflichtfelder fehlen - und sagt, warum', async () => {
    await bisZurVerbindung();
    expect(speichernKnopf()).toBeDisabled();
    expect(screen.getByText('Speichern geht, sobald der Test echte Werte zeigt.')).toBeInTheDocument();
    expect(screen.getByText('2 Angaben fehlen')).toBeInTheDocument();
    // Ohne vollständige Angaben wird nichts getestet.
    expect(testComponentConnection).not.toHaveBeenCalled();
    fuelleFormular();
    await waitFor(() => expect(speichernKnopf()).toBeEnabled());
    expect(screen.getByText('vollständig')).toBeInTheDocument();
  });

  it('testet von selbst, sobald alles Nötige dasteht', async () => {
    await bisZumTest();
    await waitFor(() => expect(testComponentConnection).toHaveBeenCalledTimes(1));
    await screen.findByText(/Diese Messwerte kommen gerade an/);
    expect(screen.getByText('Solarleistung')).toBeInTheDocument();
    expect(screen.getByText('Ladestand')).toBeInTheDocument();
    // Verbrauch/Netz hat dieses Gerät nicht gemeldet - sie erscheinen NICHT als 0.
    expect(screen.queryByText('Verbrauch')).toBeNull();
    expect(screen.getByText('bestanden')).toBeInTheDocument();
  });

  it('wartet beim Tippen, bis die Eingabe ruht - nicht jeder Tastendruck prüft die Box', async () => {
    await bisZurVerbindung();
    fireEvent.change(screen.getByLabelText(/IP-Adresse/), { target: { value: '192.168.0.28' } });
    fireEvent.change(screen.getByLabelText(/Seriennummer/), { target: { value: '2985159064' } });
    expect(testComponentConnection).not.toHaveBeenCalled();
    await waitFor(() => expect(testComponentConnection).toHaveBeenCalledTimes(1), { timeout: 2500 });
  });

  it('hält „Speichern" zu, bis das Gerät wirklich geantwortet hat', async () => {
    testComponentConnection.mockResolvedValue({
      results: [{ id: 'verbindung', ok: false, errorCode: 'no_answer' }],
    });
    await bisZumTest();
    await screen.findByText(/antwortet aber nicht wie erwartet/);
    expect(speichernKnopf()).toBeDisabled();
    expect(screen.getByText('Ohne gültige Werte des Geräts wird nicht gespeichert.')).toBeInTheDocument();
    expect(screen.queryByLabelText('So erscheint es im Aufbau')).toBeNull();
  });

  it('entwertet den Beleg, sobald ein Feld geändert wird - und prüft neu', async () => {
    await bisZumNamen();
    fireEvent.change(screen.getByLabelText(/IP-Adresse/), { target: { value: '192.168.0.99' } });
    // Genau das ist der Sinn der Pflicht: eine andere Adresse ist ein anderes Gerät.
    expect(speichernKnopf()).toBeDisabled();
    fireEvent.blur(screen.getByLabelText(/IP-Adresse/));
    await waitFor(() => expect(testComponentConnection).toHaveBeenCalledTimes(2));
    expect(testComponentConnection.mock.calls[1][1].connection.ip).toBe('192.168.0.99');
  });

  it('verwirft ein Ergebnis, das noch zur ALTEN Eingabe unterwegs war', async () => {
    let antworte: (v: unknown) => void = () => {};
    testComponentConnection.mockImplementationOnce(() => new Promise((r) => (antworte = r)));
    testComponentConnection.mockResolvedValueOnce({
      results: [{ id: 'verbindung', ok: false, errorCode: 'no_answer' }],
    });
    await bisZumTest();
    // Während der erste Lauf noch unterwegs ist, ändert sich die Adresse …
    fireEvent.change(screen.getByLabelText(/IP-Adresse/), { target: { value: '192.168.0.99' } });
    fireEvent.blur(screen.getByLabelText(/IP-Adresse/));
    await waitFor(() => expect(testComponentConnection).toHaveBeenCalledTimes(2));
    await screen.findByText(/antwortet aber nicht wie erwartet/);
    // … und sein spätes „bestanden" gilt NICHT für die neue Adresse.
    await act(async () => antworte({ results: [{ id: 'verbindung', ok: true, reading: { pvKw: 1 } }] }));
    expect(speichernKnopf()).toBeDisabled();
    expect(screen.getByText(/antwortet aber nicht wie erwartet/)).toBeInTheDocument();
  });

  it('führt vom Modell bis zum Anlegen - mit denselben Aufrufen wie zuvor', async () => {
    const onSaved = vi.fn();
    const onFertig = vi.fn();
    const onClose = vi.fn();
    await bisZumNamen({ onSaved, onFertig, onClose });
    expect(screen.getByText(/trägt die Energiebilanz/)).toBeInTheDocument();
    fireEvent.click(speichernKnopf());

    await waitFor(() => expect(createComponent).toHaveBeenCalled());
    expect(createComponent.mock.calls[0][1]).toMatchObject({
      templateRef: template.templateRef,
      role: 'inverter',
      connection: { ip: '192.168.0.28', serial: '2985159064' },
    });
    expect(onSaved).toHaveBeenCalled();
    // Was entstanden ist, sagt der Wirt - und springt auf die belegte Komponente.
    expect(onFertig).toHaveBeenCalledWith({ id: 'neu-1', titel: template.modelLabel, uebernommen: false });
    expect(onClose).toHaveBeenCalled();
  });

  it('behauptet KEINE Komponente, wenn die neue nicht belegt ist', async () => {
    // Ein Server, der die Liste nicht zurückgibt (oder ein Nebenlauf): dann
    // wird keine Komponente behauptet - der Wirt springt nirgendwohin.
    createComponent.mockResolvedValue({ componentAuthority: 'portal', components: [] });
    const onFertig = vi.fn();
    await bisZumNamen({ onFertig });
    fireEvent.click(speichernKnopf());
    await waitFor(() => expect(onFertig).toHaveBeenCalled());
    expect(onFertig.mock.calls[0][0].id).toBeNull();
  });

  it('nennt eine Ablehnung des Servers im Klartext', async () => {
    createComponent.mockRejectedValue(
      new ApiError(422, 'Bitte prüfen Sie zuerst die Verbindung zu diesem Gerät.'),
    );
    const onClose = vi.fn();
    await bisZumNamen({ onClose });
    fireEvent.click(speichernKnopf());
    await screen.findByText('Bitte prüfen Sie zuerst die Verbindung zu diesem Gerät.');
    // Und die Seite bleibt stehen, mit allen Eingaben - kein Schließen ohne Ergebnis.
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/IP-Adresse/) as HTMLInputElement).value).toBe('192.168.0.28');
  });

  it('führt mit dem Pfeil zurück in den Katalog', async () => {
    const onZurueck = vi.fn();
    oeffne({ onZurueck });
    fireEvent.click(await screen.findByRole('button', { name: 'Zurück zum Katalog' }));
    expect(onZurueck).toHaveBeenCalled();
  });
});

describe('die Aufgabe folgt dem Modell', () => {
  beforeEach(standardMocks);

  it('stellt nur beim Wechselrichter die Rest-Frage - und markiert den Vorschlag', async () => {
    oeffne();
    const wahl = await screen.findByTestId('rollen-wahl');
    expect(wahl.textContent).toContain('Wechselrichter / Speicher');
    expect(wahl.textContent).toContain('Weiterer Erzeuger');
    expect(wahl.querySelector('.is-on')?.textContent).toContain('Wechselrichter / Speicher');
    expect(wahl.querySelector('.is-on')?.textContent).toContain('Vorschlag');
  });

  it('schlägt auf einer Anlage MIT Wechselrichter den weiteren Erzeuger vor - und sagt warum', async () => {
    siteComponents.mockResolvedValue({
      componentAuthority: 'portal',
      components: [{ id: 'wr', role: 'inverter', definitionVersion: 1 }],
    });
    oeffne();
    const wahl = await screen.findByTestId('rollen-wahl');
    await waitFor(() => expect(wahl.querySelector('.is-on')?.textContent).toContain('Weiterer Erzeuger'));
    expect(screen.getByText('Vorschlag, weil Ihre Anlage schon einen Hauptwechselrichter hat.')).toBeInTheDocument();
    // ⚠ Blockiert wird nichts: der Server übernimmt eine komponierte Zeile.
    for (const b of wahl.querySelectorAll('button')) expect(b).toBeEnabled();
  });

  it('stellt bei der Wallbox gar keine Frage und legt sie als Verbraucher an', async () => {
    const wallbox = {
      ...template,
      templateRef: 'builtin:go-e:charger',
      brand: 'go-e',
      brandLabel: 'go-e',
      model: 'charger',
      modelLabel: 'go-e Charger',
      deviceType: 'wallbox',
    };
    componentTemplates.mockResolvedValue([wallbox]);
    await bisZurVerbindung({ startTemplate: wallbox as never });
    expect(screen.queryByTestId('rollen-wahl')).toBeNull();
    expect(screen.queryByRole('heading', { name: /Aufgabe in Ihrer Anlage/ })).toBeNull();
    fuelleFormular();
    await waitFor(() => expect(speichernKnopf()).toBeEnabled());
    fireEvent.click(speichernKnopf());
    await waitFor(() => expect(createComponent).toHaveBeenCalled());
    expect(createComponent.mock.calls[0][1]).toMatchObject({ role: 'consumer' });
  });

  it('macht über „Zähler" aus dem Gerät den Netz-Zähler - mit einem Satz statt einer Frage', async () => {
    await bisZurVerbindung({ startRolle: 'grid-meter' });
    expect(screen.queryByTestId('rollen-wahl')).toBeNull();
    expect(screen.getByText(/Netz-Zähler:/)).toBeInTheDocument();
    fuelleFormular();
    await waitFor(() => expect(speichernKnopf()).toBeEnabled());
    fireEvent.click(speichernKnopf());
    await waitFor(() => expect(createComponent).toHaveBeenCalled());
    expect(createComponent.mock.calls[0][1]).toMatchObject({ role: 'grid-meter' });
  });

  it('sperrt den zweiten Netz-Zähler mit seinem Grund - auch im Fuß', async () => {
    siteComponents.mockResolvedValue({
      componentAuthority: 'portal',
      components: [{ id: 'z', role: 'grid-meter', definitionVersion: 1 }],
    });
    oeffne({ startRolle: 'grid-meter' });
    expect((await screen.findAllByText(/bereits einen Netz-Zähler/)).length).toBeGreaterThan(0);
    expect(speichernKnopf()).toBeDisabled();
  });
});

describe('die anderen Türen desselben Flusses', () => {
  beforeEach(standardMocks);

  it('führt hinter der Ladesäule den ANBINDE-Assistenten, ohne etwas anzulegen', async () => {
    render(<AnlegenFlow siteId="s1" initialTyp="ladesaeule" onClose={() => {}} onSaved={() => {}} />);

    const block = await screen.findByTestId('typ-ladesaeule');
    expect(block).toHaveTextContent(/verbinden sich selbst/);
    // ⚠ Es ist DERSELBE Körper wie im Drawer der Ladevorgänge-Seite (E1).
    expect(await screen.findByTestId('ladesaeule-anbinden')).toBeTruthy();
    expect(screen.getByLabelText('Kennung')).toBeTruthy();
    // Weiterhin KEIN Gerät-Anlegen.
    expect(screen.queryByTestId('einrichten-speichern')).toBeNull();
    expect(screen.queryByText('Verbindung testen')).toBeNull();
  });

  /*
    Einheitsmodell Stufe 6: „Gerät daraus anlegen" an einer EIGENEN Vorlage.
    Die Seite öffnet vorbefüllt - nur die Adresse fehlt, denn eine Vorlage
    beschreibt einen Gerätetyp, kein Exemplar.
  */
  it('öffnet mit einer eigenen Vorlage vorbefüllt - nur die Adresse fehlt', async () => {
    const onZurueck = vi.fn();
    render(
      <AnlegenFlow
        siteId="s1"
        onClose={() => {}}
        onSaved={() => {}}
        onZurueck={onZurueck}
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
    const seite = await screen.findByRole('dialog', { name: 'Gerät einrichten' });
    expect(within(seite).getByText('Wärmepumpe Keller')).toBeInTheDocument();
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('5020');
    expect((screen.getByLabelText('IP-Adresse des Geräts') as HTMLInputElement).value).toBe('');
    // Die Vorlage gibt es schon - die Seite bietet sie nicht noch einmal an.
    expect(screen.queryByLabelText(/Als eigene Vorlage speichern/)).toBeNull();
    fireEvent.click(within(seite).getByRole('button', { name: 'Zurück zum Katalog' }));
    expect(onZurueck).toHaveBeenCalled();
  });

  it('beschreibt ein Modbus-Gerät auf EINER Seite - gelesen wird von selbst, gespeichert erst mit Beleg', async () => {
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
    duplicateCustomComponent.mockResolvedValue([]);
    const onFertig = vi.fn();
    const onClose = vi.fn();
    render(<AnlegenFlow siteId="s1" initialTyp="eigenbau" onClose={onClose} onSaved={() => {}} onFertig={onFertig} />);
    await screen.findByRole('dialog', { name: 'Gerät einrichten' });

    // Ein öffentliches Ziel wird SOFORT benannt - und nichts wird gelesen.
    fireEvent.change(screen.getByLabelText('IP-Adresse des Geräts'), { target: { value: '8.8.8.8' } });
    expect(screen.getAllByRole('status').map((e) => e.textContent).join(' ')).toMatch(/nicht nachweisbar/);
    expect(screen.getByText('Erst die Adresse, dann liest die Box die Messwerte.')).toBeInTheDocument();
    expect(screen.getByTestId('einrichten-speichern')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('IP-Adresse des Geräts'), { target: { value: '192.168.1.50' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Vorlauf' } });
    fireEvent.change(screen.getByLabelText('Register'), { target: { value: '100' } });
    // Kein „Jetzt lesen" nötig: die Box liest, sobald die Eingabe ruht.
    await screen.findByText('13.750', {}, { timeout: 2500 });
    expect(screen.getByText('1.375 °C')).toBeInTheDocument();
    expect(readCustomComponent).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(screen.getByTestId('einrichten-speichern')).toBeEnabled());
    fireEvent.click(screen.getByLabelText(/Als eigene Vorlage speichern/));
    fireEvent.click(screen.getByTestId('einrichten-speichern'));

    await waitFor(() => expect(createCustomComponent).toHaveBeenCalled());
    expect(createCustomComponent.mock.calls[0][1]).toMatchObject({
      connection: { host: '192.168.1.50', port: 502, unitId: 1 },
      channels: [{ label: 'Vorlauf', address: 100 }],
    });
    // Die Vorlage entsteht aus dem NEUEN Gerät - ohne Adresse.
    await waitFor(() => expect(duplicateCustomComponent).toHaveBeenCalledWith('s1', 'sb-1', 'Eigenes Modbus-Gerät'));
    expect(onFertig).toHaveBeenCalledWith({
      id: 'sb-1',
      titel: 'Eigenes Modbus-Gerät',
      uebernommen: false,
      hinweis: 'Die Vorlage steht im Katalog unter „Selbst beschreiben".',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('rechnet eine Handbuch-Nummer nie still um - die Modicon-Lesart ist ein Knopf', async () => {
    readCustomComponent.mockResolvedValue({ ok: true, raw: 1, value: 1, receipt: true });
    render(<AnlegenFlow siteId="s1" initialTyp="eigenbau" onClose={() => {}} onSaved={() => {}} />);
    await screen.findByRole('dialog', { name: 'Gerät einrichten' });
    // Die Messwerte kommen erst nach dem Anschluss dran.
    expect(screen.queryByLabelText('Register')).toBeNull();
    fireEvent.change(screen.getByLabelText('IP-Adresse des Geräts'), { target: { value: '192.168.1.50' } });
    fireEvent.change(screen.getByLabelText('Register'), { target: { value: '40011' } });
    const hinweis = screen.getByTestId('modicon-hinweis');
    expect(hinweis).toHaveTextContent('Holding-Register 10');
    expect((screen.getByLabelText('Register') as HTMLInputElement).value).toBe('40011');
    fireEvent.click(within(hinweis).getByRole('button', { name: 'Als Holding-Register 10 lesen' }));
    expect((screen.getByLabelText('Register') as HTMLInputElement).value).toBe('10');
  });

  it('sagt es, wenn die Vorlage nicht gespeichert werden konnte - das Gerät ist trotzdem angelegt', async () => {
    readCustomComponent.mockResolvedValue({ ok: true, raw: 1, value: 1, receipt: true });
    createCustomComponent.mockResolvedValue({ components: [{ id: 'sb-2' }] });
    duplicateCustomComponent.mockRejectedValue(new ApiError(500, 'kaputt'));
    const onFertig = vi.fn();
    render(<AnlegenFlow siteId="s1" initialTyp="eigenbau" onClose={() => {}} onSaved={() => {}} onFertig={onFertig} />);
    await screen.findByRole('dialog', { name: 'Gerät einrichten' });
    fireEvent.change(screen.getByLabelText('IP-Adresse des Geräts'), { target: { value: '192.168.1.50' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Puffer' } });
    fireEvent.change(screen.getByLabelText('Register'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByTestId('einrichten-speichern')).toBeEnabled(), { timeout: 2500 });
    fireEvent.change(screen.getByLabelText('So erscheint es im Aufbau'), { target: { value: 'Pufferspeicher' } });
    fireEvent.click(screen.getByLabelText(/Als eigene Vorlage speichern/));
    fireEvent.click(screen.getByTestId('einrichten-speichern'));
    await waitFor(() => expect(onFertig).toHaveBeenCalled());
    expect(onFertig.mock.calls[0][0]).toMatchObject({ id: 'sb-2', titel: 'Pufferspeicher' });
    expect(onFertig.mock.calls[0][0].hinweis).toMatch(/Vorlage konnte nicht gespeichert werden/);
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
    // Ohne den Klick bleibt „Speichern" zu - die Pflicht gilt unverändert.
    expect(speichernKnopf()).toBeDisabled();

    fireEvent.click(anbieten);
    await screen.findByText('Ohne Ladestand fortfahren?');
    expect(screen.getByText(/Steuerung des Speichers bleibt aus/)).toBeTruthy();
    fireEvent.click(screen.getByText('Trotzdem fortfahren'));

    await screen.findByTestId('override-aktiv');
    await waitFor(() => expect(speichernKnopf()).toBeEnabled());
    fireEvent.click(speichernKnopf());
    await waitFor(() => expect(createComponent).toHaveBeenCalled());
    expect(createComponent.mock.calls[0][1]).toMatchObject({
      role: 'inverter',
      acceptMissingChannel: 'soc_pct',
    });
  });

  it('bietet die Ladestand-SCHÄTZUNG an - genau hier und nirgends sonst', async () => {
    await bisZumTest();
    const block = await screen.findByTestId('soc-schaetzung');
    expect(within(block).getByLabelText(/Spannung bei 0 %/)).toBeTruthy();
    expect(within(block).getByLabelText(/Spannung bei 100 %/)).toBeTruthy();
    // Die Ehrlichkeit steht DABEI, nicht irgendwo im Kleingedruckten.
    expect(within(block).getByText(/Gesteuert wird Ihr Speicher dadurch nicht/)).toBeTruthy();
    expect(within(block).getByText(/LiFePO4/)).toBeTruthy();
  });

  it('schickt die Eckpunkte MIT der Verbindung - der Test bewertet genau sie', async () => {
    await bisZumTest();
    await screen.findByTestId('soc-schaetzung');
    const rufeVorher = testComponentConnection.mock.calls.length;
    fireEvent.change(screen.getByLabelText(/Spannung bei 0 %/), { target: { value: '600' } });
    fireEvent.change(screen.getByLabelText(/Spannung bei 100 %/), { target: { value: '700' } });
    // Die Eingabe ENTWERTET den Beleg - genau das ist die Verbindungstest-Pflicht.
    expect(screen.queryByTestId('override-anbieten')).toBeNull();
    // Und der erneute Test - er läuft von selbst, sobald die Eingabe ruht - trägt sie zur Box.
    await waitFor(
      () => expect(testComponentConnection.mock.calls.length).toBeGreaterThan(rufeVorher),
      { timeout: 2500 },
    );
    const letzter = testComponentConnection.mock.calls.at(-1)[1];
    expect(letzter.connection.soc_from_voltage).toEqual({ v_empty: 600, v_full: 700 });
  });

  it('zeigt den BELEG der Box - und ohne ihn keine erfundene Zahl', async () => {
    // Zuerst ohne Schätzung: die Fläche behauptet nichts.
    await bisZumTest();
    await screen.findByTestId('soc-schaetzung');
    expect(screen.queryByTestId('soc-schaetzung-beleg')).toBeNull();

    // Jetzt antwortet die Box MIT einer Schätzung - unverändertes Urteil.
    testComponentConnection.mockResolvedValue({
      results: [
        {
          ...unplausibel.results[0],
          finding: {
            ...unplausibel.results[0].finding,
            estimate: { socPct: 36, voltageV: 636 },
          },
        },
      ],
    });
    fireEvent.change(screen.getByLabelText(/Spannung bei 0 %/), { target: { value: '600' } });
    fireEvent.change(screen.getByLabelText(/Spannung bei 100 %/), { target: { value: '700' } });

    await screen.findByTestId('soc-schaetzung-beleg', {}, { timeout: 2500 });
    expect(screen.getByText(/636 V/)).toBeTruthy();
    expect(screen.getByText(/36 % Ladestand/)).toBeTruthy();
    // Der Ausweg bleibt NÖTIG: eine Schätzung ist keine Messung.
    expect(await screen.findByTestId('override-anbieten')).toBeTruthy();
    expect(speichernKnopf()).toBeDisabled();
  });

  it('nennt eine unsinnige Eingabe beim Namen und speichert sie nie', async () => {
    await bisZumTest();
    await screen.findByTestId('soc-schaetzung');
    fireEvent.change(screen.getByLabelText(/Spannung bei 0 %/), { target: { value: '700' } });
    fireEvent.change(screen.getByLabelText(/Spannung bei 100 %/), { target: { value: '600' } });
    expect(await screen.findByTestId('soc-schaetzung-fehler')).toBeTruthy();

    const rufeVorher = testComponentConnection.mock.calls.length;
    await waitFor(
      () => expect(testComponentConnection.mock.calls.length).toBeGreaterThan(rufeVorher),
      { timeout: 2500 },
    );
    const letzter = testComponentConnection.mock.calls.at(-1)[1];
    expect(letzter.connection.soc_from_voltage).toBeUndefined();
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
    expect(speichernKnopf()).toBeDisabled();
  });
});

describe('Alias-Kontinuität im neuen Fluss', () => {
  beforeEach(standardMocks);

  it('füllt das Namensfeld NICHT mit dem Modellnamen vor', async () => {
    const name = (await bisZumNamen()) as HTMLInputElement;
    expect(name.value).toBe('');
    expect(name.placeholder).toBe(template.modelLabel);
    fireEvent.click(speichernKnopf());
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
    const onFertig = vi.fn();
    await bisZumNamen({ onFertig });
    const hinweis = await screen.findByText(/statt eine zweite anzulegen/);
    expect(hinweis).toHaveTextContent('Fronius Anlage WR1');
    expect(screen.getByText(/Leer lassen behält den bisherigen Namen/)).toHaveTextContent(
      'Fronius Anlage WR1',
    );

    // Und der Wirt erfährt „wieder verbunden", nicht „angelegt" - mit der übernommenen Zeile.
    fireEvent.click(speichernKnopf());
    await waitFor(() =>
      expect(onFertig).toHaveBeenCalledWith({ id: 'wr1', titel: 'Fronius Anlage WR1', uebernommen: true }),
    );
  });

  it('entwertet den Übernahme-Vorschlag, sobald die Verbindung sich ändert', async () => {
    matchComponent.mockResolvedValue({ entityId: 'wr1', label: 'Fronius Anlage WR1' });
    await bisZumNamen();
    await screen.findByText(/statt eine zweite anzulegen/);
    // Alles steht auf EINER Seite: die Adresse ändern, ohne zurückzublättern.
    fireEvent.change(screen.getByLabelText(/IP-Adresse/), {
      target: { value: '192.168.0.99' },
    });
    expect(screen.queryByText(/statt eine zweite anzulegen/)).toBeNull();
  });

  it('bleibt ohne die Vorschlags-Route unverändert (älteres Backend)', async () => {
    matchComponent.mockRejectedValue(new ApiError(404, 'nicht gefunden'));
    await bisZumNamen();
    expect(screen.queryByText(/statt eine zweite anzulegen/)).toBeNull();
    expect(speichernKnopf()).toBeEnabled();
  });
});

describe('die Hebel des Verbindungstests', () => {
  beforeEach(() => {
    standardMocks();
    componentTemplates.mockResolvedValue([templateMitSkala, geschwisterTemplate]);
  });

  it('führt beim unmöglichen Messwert zurück in den Katalog - dort steht die Modellwahl', async () => {
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
    const onZurueck = vi.fn();
    await bisZumTest({ onZurueck });
    fireEvent.click(await screen.findByTestId('hebel-modell'));
    expect(onZurueck).toHaveBeenCalled();
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
    await bisZumTest({ startTemplate: templateMitSkala as never });
    fireEvent.click(await screen.findByTestId('hebel-skalierung'));
    // ⚠ Ein Sprung ins Eingeklappte wäre ein Klick ins Unsichtbare.
    const details = (await screen.findByText('Weitere Angaben (2)')).closest(
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

describe('Gerät direkt auf seiner Seite bearbeiten', () => {
  const edit = {
    id: 'wr-1',
    role: 'inverter',
    entityType: 'battery-hybrid',
    label: 'Wechselrichter Scheune',
    brand: 'deye',
    model: 'sun-30k-sg01hp3',
    family: 'hybrid_3p',
    communication: 'solarman_v5',
    connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064' },
    templateRef: template.templateRef,
    templateVersion: 1,
    definitionVersion: 3,
    edgeSourceId: 'inverter',
    syncStatus: 'in_sync',
  };

  beforeEach(() => {
    standardMocks();
    siteComponents.mockResolvedValue({ componentAuthority: 'portal', components: [edit] });
  });

  function renderInline(over: { onClose?: () => void; onSaved?: () => void } = {}) {
    return render(
      <AnlegenFlow
        siteId="s1"
        siteName="Pilsting"
        box={{ id: 'box-b', siteId: 's1', externalRef: 'edge-b', kind: 'gateway',
          name: 'Box Halle 2', status: 'claimed', lastSeenAt: null, createdAt: null }}
        geraetKennung="inverter"
        bearbeiten={edit}
        inlineBearbeitung
        onClose={over.onClose ?? (() => {})}
        onSaved={over.onSaved ?? (() => {})}
      />,
    );
  }

  it('zeigt Name und Aufgabe sofort auf der Seite und speichert eine Umbenennung ohne Test', async () => {
    const onSaved = vi.fn();
    renderInline({ onSaved });

    expect(await screen.findByTestId('geraet-bearbeiten')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    const name = screen.getByLabelText('Anzeigename');
    expect(name).toHaveValue('Wechselrichter Scheune');
    expect(screen.getByText('Pilsting')).toBeVisible();

    fireEvent.change(name, { target: { value: 'Wechselrichter Garage' } });
    fireEvent.click(knopf('Änderungen speichern'));

    await waitFor(() => expect(updateComponent).toHaveBeenCalledWith(
      's1', 'wr-1', expect.objectContaining({
        label: 'Wechselrichter Garage',
        role: 'inverter',
        templateVersion: 1,
      }),
    ));
    expect(testComponentConnection).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it('fordert den Verbindungstest nur nach einer technischen Änderung an', async () => {
    renderInline();
    await screen.findByDisplayValue('Wechselrichter Scheune');
    fireEvent.click(knopf('Technische Daten ändern'));
    fireEvent.change(screen.getByLabelText(/IP-Adresse des Datenloggers/), {
      target: { value: '192.168.0.29' },
    });

    fireEvent.click(knopf('Änderungen speichern'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Prüfen Sie die geänderte Verbindung/);
    expect(updateComponent).not.toHaveBeenCalled();

    fireEvent.click(knopf('Verbindung prüfen'));
    expect(await screen.findByText(/Das Gerät antwortet/)).toBeVisible();
    expect(testComponentConnection).toHaveBeenCalledWith('s1', expect.objectContaining({
      templateVersion: 1,
      deviceId: 'box-b',
      entityId: 'wr-1',
    }));
    fireEvent.click(knopf('Änderungen speichern'));

    await waitFor(() => expect(updateComponent).toHaveBeenCalledWith(
      's1', 'wr-1', expect.objectContaining({
        connection: expect.objectContaining({ ip: '192.168.0.29' }),
      }),
    ));
  });

  it('verwirft geänderte Eingaben erst nach einer zentrierten Rückfrage', async () => {
    const onClose = vi.fn();
    renderInline({ onClose });
    fireEvent.change(await screen.findByLabelText('Anzeigename'), {
      target: { value: 'Nicht gespeichert' },
    });
    fireEvent.click(knopf('Abbrechen'));

    const dialog = await screen.findByRole('dialog', { name: 'Änderungen verwerfen?' });
    expect(dialog).toBeVisible();
    expect(dialog.closest('.vp-center-confirm-backdrop')).not.toBeNull();
    expect(document.querySelector('.vp-modal')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Änderungen verwerfen' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('schützt geänderte Eingaben auch vor einem Browser-Neuladen', async () => {
    renderInline();
    fireEvent.change(await screen.findByLabelText('Anzeigename'), {
      target: { value: 'Noch nicht gespeichert' },
    });

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('blockiert auch imperative Hash-Navigation und stellt die Editor-Adresse wieder her', async () => {
    window.history.replaceState(null, '', '#/anlage/s1/geraet/VP-BOX-1/inverter');
    recordCurrentNavigation();
    renderInline();
    fireEvent.change(await screen.findByLabelText('Anzeigename'), {
      target: { value: 'Noch nicht gespeichert' },
    });
    const editorHref = window.location.href;
    let blocked = false;
    act(() => {
      window.history.pushState(null, '', '#/anlage/s1/modell');
      blocked = requestNavigation(window.location.href, true);
    });

    expect(blocked).toBe(true);
    await waitFor(() => expect(window.location.href).toBe(editorHref));
    const dialog = await screen.findByRole('dialog', { name: 'Änderungen verwerfen?' });
    expect(dialog).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.getByLabelText('Anzeigename')).toHaveValue('Noch nicht gespeichert');
  });

  it('erhält das vorige Verlaufsziel, wenn Zurück abgebrochen wird', async () => {
    window.history.replaceState(null, '', '#/anlage/s1');
    recordCurrentNavigation();
    window.history.pushState(null, '', '#/anlage/s1/modell');
    recordNewNavigation();
    replaceCurrentNavigation('#/anlage/s1/modell?ansicht=liste');
    const previousHref = window.location.href;
    window.history.pushState(null, '', '#/anlage/s1/geraet/VP-BOX-1/inverter');
    recordNewNavigation();
    const editorHref = window.location.href;
    renderInline();
    fireEvent.change(await screen.findByLabelText('Anzeigename'), {
      target: { value: 'Noch nicht gespeichert' },
    });

    act(() => window.history.back());
    await waitFor(() => expect(window.location.href).toBe(previousHref));
    let blocked = false;
    act(() => {
      blocked = requestNavigation(window.location.href, true);
    });
    expect(blocked).toBe(true);
    await waitFor(() => expect(window.location.href).toBe(editorHref));

    const dialog = await screen.findByRole('dialog', { name: 'Änderungen verwerfen?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    act(() => window.history.back());
    await waitFor(() => expect(window.location.href).toBe(previousHref));
  });

  it('setzt bestätigtes Zurück im bestehenden Verlauf fort', async () => {
    window.history.replaceState(null, '', '#/anlage/s1');
    recordCurrentNavigation();
    const firstHref = window.location.href;
    window.history.pushState(null, '', '#/anlage/s1/modell');
    recordNewNavigation();
    const previousHref = window.location.href;
    window.history.pushState(null, '', '#/anlage/s1/geraet/VP-BOX-1/inverter');
    recordNewNavigation();
    renderInline();
    fireEvent.change(await screen.findByLabelText('Anzeigename'), {
      target: { value: 'Noch nicht gespeichert' },
    });

    act(() => window.history.back());
    await waitFor(() => expect(window.location.href).toBe(previousHref));
    act(() => {
      requestNavigation(window.location.href, true);
    });
    const dialog = await screen.findByRole('dialog', { name: 'Änderungen verwerfen?' });
    await waitFor(() => expect(window.location.hash).toContain('/geraet/'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Änderungen verwerfen' }));

    await waitFor(() => expect(window.location.href).toBe(previousHref));
    act(() => window.history.back());
    await waitFor(() => expect(window.location.href).toBe(firstHref));
  });

  it('behält einen eingegebenen Anzeigenamen beim Modellwechsel', async () => {
    componentTemplates.mockResolvedValue([template, geschwisterTemplate]);
    renderInline();

    const name = await screen.findByLabelText('Anzeigename');
    fireEvent.change(name, { target: { value: 'Wechselrichter Garage' } });
    fireEvent.click(knopf('Technische Daten ändern'));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Hersteller und Modell' }));
    fireEvent.click(screen.getByRole('option', { name: new RegExp(geschwisterTemplate.modelLabel) }));

    expect(name).toHaveValue('Wechselrichter Garage');
  });

  it('behält technische Eingaben beim erneuten Wählen des aktiven Modells', async () => {
    renderInline();

    await screen.findByLabelText('Anzeigename');
    fireEvent.click(knopf('Technische Daten ändern'));
    const ip = screen.getByLabelText(/IP-Adresse des Datenloggers/);
    fireEvent.change(ip, { target: { value: '192.168.0.29' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Hersteller und Modell' }));
    fireEvent.click(screen.getByRole('option', { name: new RegExp(template.modelLabel) }));

    expect(ip).toHaveValue('192.168.0.29');
    expect(knopf('Verbindung prüfen')).toBeVisible();
  });

  it('bewahrt die gespeicherte Vorlagenfassung bei einer neueren Katalogfassung', async () => {
    componentTemplates.mockResolvedValue([{ ...template, version: 2 }]);
    renderInline();

    const name = await screen.findByLabelText('Anzeigename');
    fireEvent.change(name, { target: { value: 'Wechselrichter Garage' } });
    fireEvent.click(knopf('Änderungen speichern'));

    await waitFor(() => expect(updateComponent).toHaveBeenCalledWith(
      's1',
      'wr-1',
      expect.objectContaining({ templateRef: template.templateRef, templateVersion: 1 }),
    ));
    expect(testComponentConnection).not.toHaveBeenCalled();
  });

  it('lädt eine abgelöste Bestandsvorlage einzeln für den Editor nach', async () => {
    componentTemplates.mockResolvedValue([geschwisterTemplate]);
    componentTemplate.mockResolvedValue({ ...template, supersededBy: geschwisterTemplate.templateRef });
    renderInline();

    await waitFor(() => expect(componentTemplate).toHaveBeenCalledWith(template.templateRef));
    const name = screen.getByLabelText('Anzeigename');
    fireEvent.change(name, { target: { value: 'Wechselrichter Garage' } });
    fireEvent.click(knopf('Änderungen speichern'));

    await waitFor(() => expect(updateComponent).toHaveBeenCalledWith(
      's1',
      'wr-1',
      expect.objectContaining({ templateRef: template.templateRef, templateVersion: 1 }),
    ));
  });

  it('behandelt ein geleertes bestehendes Secret wieder als unverändert', async () => {
    const secretTemplate = {
      ...template,
      transportSchema: [
        ...template.transportSchema,
        { key: 'password', label: 'Kennwort', type: 'password', secret: true, required: true },
      ],
    };
    const secretEdit = {
      ...edit,
      connection: { ...edit.connection, password: '••••••••' },
    };
    componentTemplates.mockResolvedValue([secretTemplate]);
    render(
      <AnlegenFlow
        siteId="s1"
        bearbeiten={secretEdit}
        inlineBearbeitung
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    const name = await screen.findByLabelText('Anzeigename');
    fireEvent.click(knopf('Technische Daten ändern'));
    const password = await screen.findByLabelText(/Kennwort/);
    fireEvent.change(password, { target: { value: 'neu-geheim' } });
    fireEvent.change(password, { target: { value: '' } });
    fireEvent.change(name, { target: { value: 'Wechselrichter Garage' } });
    fireEvent.click(knopf('Änderungen speichern'));

    await waitFor(() => expect(updateComponent).toHaveBeenCalled());
    expect(updateComponent.mock.calls[0][2].connection).not.toHaveProperty('password');
    expect(testComponentConnection).not.toHaveBeenCalled();
  });

  it('weist null kWp vor dem Speichern als ungültig zurück', async () => {
    renderInline();
    const rollen = await screen.findByRole('radiogroup', { name: 'Aufgabe in der Anlage' });
    fireEvent.click(within(rollen).getByRole('radio', { name: /Weiterer Erzeuger/ }));
    fireEvent.change(screen.getByLabelText('Nennleistung (kWp)'), { target: { value: '0' } });
    fireEvent.click(knopf('Änderungen speichern'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/größer als 0 kWp/);
    expect(updateComponent).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Aufgabe des Geräts ändern?' })).toBeNull();
  });

  it('friert die Bearbeitung ein und unterdrückt Verwerfen während des Speicherns', async () => {
    const result = {
      componentAuthority: 'portal' as const,
      components: [{ ...edit, label: 'Wechselrichter Garage', definitionVersion: 4 }],
    };
    let resolveUpdate!: (value: typeof result) => void;
    updateComponent.mockReturnValue(new Promise<typeof result>((resolve) => {
      resolveUpdate = resolve;
    }));
    const onSaved = vi.fn();
    renderInline({ onSaved });

    const name = await screen.findByLabelText('Anzeigename');
    fireEvent.change(name, { target: { value: 'Wechselrichter Garage' } });
    fireEvent.click(knopf('Änderungen speichern'));
    await waitFor(() => expect(updateComponent).toHaveBeenCalledTimes(1));
    expect(name).toBeDisabled();

    const editorHref = window.location.href;
    let blocked = false;
    act(() => {
      window.history.pushState(null, '', '#/anlage/s1/modell');
      blocked = requestNavigation(window.location.href, true);
    });
    expect(blocked).toBe(true);
    await waitFor(() => expect(window.location.href).toBe(editorHref));
    expect(screen.queryByRole('dialog', { name: 'Änderungen verwerfen?' })).toBeNull();

    await act(async () => {
      resolveUpdate(result);
      await Promise.resolve();
    });
    expect(onSaved).toHaveBeenCalledWith(result);
  });

  it('sperrt technische Eingaben während der laufenden Verbindungsprüfung', async () => {
    const result = {
      results: [{ id: 'verbindung', ok: true, reading: { pvKw: 12.4 } }],
    };
    let resolveTest!: (value: typeof result) => void;
    testComponentConnection.mockReturnValue(new Promise<typeof result>((resolve) => {
      resolveTest = resolve;
    }));
    renderInline();

    await screen.findByLabelText('Anzeigename');
    fireEvent.click(knopf('Technische Daten ändern'));
    const ip = await screen.findByLabelText(/IP-Adresse/);
    fireEvent.change(ip, { target: { value: '192.168.0.29' } });
    fireEvent.click(knopf('Verbindung prüfen'));

    await waitFor(() => expect(testComponentConnection).toHaveBeenCalledTimes(1));
    expect(ip).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Hersteller und Modell' })).toBeDisabled();

    await act(async () => {
      resolveTest(result);
      await Promise.resolve();
    });
    await screen.findByText(/Das Gerät antwortet/);
    expect(ip).toBeEnabled();
    expect(ip).toHaveValue('192.168.0.29');
  });

  it('überschreibt frühe Eingaben nicht, wenn die Vorlage später geladen wird', async () => {
    let resolveTemplates!: (value: (typeof template)[]) => void;
    const templates = new Promise<(typeof template)[]>((resolve) => {
      resolveTemplates = resolve;
    });
    componentTemplates.mockReturnValue(templates);
    renderInline();

    const rollen = await screen.findByRole('radiogroup', { name: 'Aufgabe in der Anlage' });
    fireEvent.click(within(rollen).getByRole('radio', { name: /Weiterer Erzeuger/ }));
    fireEvent.change(screen.getByLabelText('Nennleistung (kWp)'), { target: { value: '28' } });
    await act(async () => {
      resolveTemplates([template]);
      await templates;
    });

    expect(within(rollen).getByRole('radio', { name: /Weiterer Erzeuger/ }))
      .toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Nennleistung (kWp)')).toHaveValue(28);
  });

  it('behält für Verbraucher auch nach dem Vorlagenabruf die gespeicherte Rolle', async () => {
    const consumerEdit = {
      ...edit,
      role: 'consumer' as const,
      entityType: 'consumer',
      label: 'Wallbox Garage',
      templateRef: template.templateRef,
    };
    let resolveTemplates!: (value: (typeof template)[]) => void;
    const templates = new Promise<(typeof template)[]>((resolve) => {
      resolveTemplates = resolve;
    });
    componentTemplates.mockReturnValue(templates);
    siteComponents.mockResolvedValue({ componentAuthority: 'portal', components: [consumerEdit] });
    render(
      <AnlegenFlow
        siteId="s1"
        bearbeiten={consumerEdit}
        inlineBearbeitung
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(await screen.findByLabelText('Anzeigename')).toHaveValue('Wallbox Garage');
    expect(screen.queryByRole('radiogroup', { name: 'Aufgabe in der Anlage' })).toBeNull();
    expect(screen.queryByLabelText('Nennleistung (kWp)')).toBeNull();

    await act(async () => {
      resolveTemplates([template]);
      await templates;
    });

    await waitFor(() => expect(screen.getByText('Verbraucher')).toBeVisible());
    expect(screen.queryByRole('radiogroup', { name: 'Aufgabe in der Anlage' })).toBeNull();
    expect(screen.queryByLabelText('Nennleistung (kWp)')).toBeNull();
  });

  it('bestätigt eine geänderte elektrische Aufgabe mit ihren Folgen', async () => {
    renderInline();
    const rollen = await screen.findByRole('radiogroup', { name: 'Aufgabe in der Anlage' });
    fireEvent.click(within(rollen).getByRole('radio', { name: /Weiterer Erzeuger/ }));
    fireEvent.change(screen.getByLabelText('Nennleistung (kWp)'), { target: { value: '28' } });
    fireEvent.click(knopf('Änderungen speichern'));

    const dialog = await screen.findByRole('dialog', { name: 'Aufgabe des Geräts ändern?' });
    expect(within(dialog).getByText(/Bilanz/)).toBeVisible();
    expect(updateComponent).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Aufgabe ändern und speichern' }));

    await waitFor(() => expect(updateComponent).toHaveBeenCalledWith(
      's1', 'wr-1', expect.objectContaining({ role: 'pv-generation', capacityKwp: 28 }),
    ));
  });
});

/**
 * P5d: die eigene Batterie ist eine EIGENE Karte und ein EIGENER Assistent -
 * beim Anlegen wie beim Bearbeiten.
 */
describe('AnlegenFlow · der Batterie-Weg (P5d)', () => {
  beforeEach(() => {
    standardMocks();
  });

  it('führt vom Batterie-Weg des Katalogs in den Batterie-Assistenten', async () => {
    render(<AnlegenFlow siteId="s1" initialTyp="batterie" onClose={() => {}} onSaved={() => {}} />);
    expect(await screen.findByTestId('anschlussart-mqtt')).toBeVisible();
    // NICHT der Katalog-Weg: kein Anschluss einer Vorlage, sondern der des BMS.
    expect(screen.getByText('Batterie mit eigenem BMS')).toBeInTheDocument();
    expect(screen.queryByLabelText(/IP-Adresse des Datenloggers/)).toBeNull();
  });

  /**
   * Der ENTITÄTSTYP entscheidet, nicht die Rolle: eine selbst angebundene
   * Batterie ist Rolle „storage" und liefe sonst in das Katalog-Formular, das
   * nach Marke und Modell fragt, die es bei ihr nicht gibt.
   */
  it('bearbeitet eine selbst angebundene Batterie in ihrem eigenen Assistenten', async () => {
    const batterie = {
      id: 'batt-1',
      role: 'storage',
      entityType: 'user-defined-battery',
      label: 'Selbstbau-Pack',
      brand: null,
      model: null,
      family: null,
      communication: 'mqtt_local',
      connection: {
        schema_version: '1.0',
        transport: 'mqtt_local',
        broker: { host: '192.168.0.44', port: 1883 },
        publish_interval_s: 15,
        mappings: [],
      },
      templateRef: null,
      templateVersion: null,
      definitionVersion: 2,
      edgeSourceId: null,
      syncStatus: 'in_sync',
    };
    render(
      <AnlegenFlow
        siteId="s1"
        siteName="Pilsting"
        geraetKennung="batt-1"
        bearbeiten={batterie}
        inlineBearbeitung
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(await screen.findByTestId('batterie-bearbeiten')).toBeVisible();
    expect(screen.queryByTestId('geraet-bearbeiten')).toBeNull();
    expect((screen.getByLabelText('Adresse des MQTT-Servers') as HTMLInputElement).value).toBe(
      '192.168.0.44',
    );
  });
});
