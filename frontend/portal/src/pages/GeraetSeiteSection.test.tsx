import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GeraetSeiteSection } from './GeraetSeiteSection';
import * as auth from '../auth';
import { adminApi } from '../admin/adminApi';
import { fleetApi } from '../admin/fleetApi';
import {
  api,
  type CommandHistory,
  type Device,
  type RegisterWriteTarget,
  type Site,
  type SiteEntities,
  type SiteSource,
  type SiteTopology,
} from '../api';

const site: Site = {
  id: 's-1',
  name: 'Pilsting',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

const FRISCH = new Date().toISOString();

const box: Device = {
  id: 'gw',
  siteId: 's-1',
  externalRef: 'edge-45gz7da',
  kind: 'inverter',
  name: 'Pilsting',
  status: 'active',
  lastSeenAt: FRISCH,
  createdAt: null,
};

const entities: SiteEntities = {
  registry: null,
  entities: [
    {
      id: 'batt',
      entityType: 'battery-hybrid',
      typeLabel: 'Batteriespeicher',
      role: 'storage',
      label: 'Wechselrichter Scheune',
      control: true,
      deviceId: 'gw',
      capabilities: {
        measure: [{ channel: 'soc_pct' }, { channel: 'battery_power_kw' }],
        actuate: [{ command: 'setpoint_kw' }],
      },
      guards: null,
      syncStatus: 'in_sync',
      observed: null,
      edgeSourceId: null,
    },
    {
      id: 'fr1',
      entityType: 'producer',
      typeLabel: 'Erzeuger',
      role: 'pv',
      label: 'Dach Süd',
      control: false,
      deviceId: 'gw',
      capabilities: { measure: [{ channel: 'pv_power_kw' }] },
      guards: null,
      syncStatus: 'in_sync',
      observed: null,
      edgeSourceId: 'src-7c1e9a2b',
    },
  ],
  localSetup: [
    {
      id: 'inverter',
      kind: 'inverter',
      role: null,
      brand: 'deye',
      model: 'SUN-30K-SG01HP3-EU',
      label: null,
      reportedAt: FRISCH,
      adoptedEntityId: null,
    },
    {
      id: 'src-7c1e9a2b',
      kind: 'source',
      role: 'pv-generation',
      brand: 'fronius_sunspec',
      model: 'Eco 27.0-3-S',
      label: null,
      reportedAt: FRISCH,
      adoptedEntityId: 'fr1',
    },
  ],
  staleOnDevice: [],
};

const topology: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    {
      id: 'batt',
      entityType: 'battery-hybrid',
      typeLabel: 'Batteriespeicher',
      label: 'Wechselrichter Scheune',
      category: 'storage',
      health: 'ok',
      capabilities: [
        { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 76 },
        { channel: 'battery_power_kw', unit: 'kW', role: 'storage', primary: false, value: 9.3 },
      ],
    },
  ],
  topology: { schema_version: '1.0', nodes: [] },
} as unknown as SiteTopology;

const sources: SiteSource[] = [
  {
    deviceId: 'gw',
    sourceId: 'inverter',
    kind: 'primary',
    role: null,
    label: null,
    brand: 'deye',
    model: 'SUN-30K-SG01HP3-EU',
    pvKw: 0.2,
    powerKw: -30,
    loadKw: 5.5,
    health: 'ok',
    readAt: FRISCH,
    reportedAt: FRISCH,
  },
  {
    deviceId: 'gw',
    sourceId: 'src-7c1e9a2b',
    kind: 'source',
    role: 'pv-generation',
    label: null,
    brand: 'fronius_sunspec',
    model: 'Eco 27.0-3-S',
    pvKw: 21.2,
    powerKw: null,
    loadKw: null,
    health: 'ok',
    readAt: FRISCH,
    reportedAt: FRISCH,
  },
];

/**
 * Der Verlauf DIESES Geräts (Sektion F). Voreinstellung: die Box, eine
 * bestätigte Batterie-Periode.
 */
function commands(over: Partial<CommandHistory> = {}): CommandHistory {
  return {
    recordingSince: '2026-08-01T00:00:00Z',
    accuracySeconds: 15,
    from: '2026-08-16T00:00:00Z',
    to: '2026-08-16T12:00:00Z',
    entityId: null,
    entityLabel: null,
    deviceRef: 'edge-45gz7da',
    deviceIsBox: true,
    writes: true,
    truncated: false,
    entries: [
      {
        id: 1,
        stream: 'batterie',
        kind: 'periode',
        eventKind: null,
        startedAt: '2026-08-16T10:00:00Z',
        endedAt: '2026-08-16T10:30:00Z',
        mode: 'plan',
        path: 'remote',
        whyKind: null,
        whyRef: null,
        commandedKwFirst: -6.5,
        commandedKwLast: -6.5,
        commandedKwMin: -6.5,
        commandedKwMax: -6.5,
        verdict: 'bestaetigt',
        cycles: null,
        cyclesConfirmed: null,
        cyclesNoAnswer: null,
        cyclesMismatch: null,
        controlEnabled: true,
        released: true,
        foreignInfluence: false,
        entityId: 'batt',
        source: 'cloud_abgeleitet',
        detail: null,
      },
    ],
    control: null,
    curtailment: null,
    ...over,
  };
}

/**
 * Die Ziele des Register-Werkzeugs: die primäre Lane der Box und die Komponente
 * hinter ihr (die Fronius-Quelle).
 */
function targets(over: Partial<RegisterWriteTarget>[] = []): RegisterWriteTarget[] {
  const basis: RegisterWriteTarget[] = [
    {
      lane: 'primary', deviceId: 'gw', entityId: null, label: 'Deye SUN-30K',
      brand: 'deye', model: 'SUN-30K-SG01HP3-EU', family: 'hybrid_3p',
      communication: 'solarman_v5', host: '192.168.0.28', port: 8899, unitId: 1,
      writable: true, reason: null,
    },
    {
      lane: 'entity', deviceId: 'gw', entityId: 'fr1', label: 'Dach Süd',
      brand: 'fronius_sunspec', model: 'Eco 27.0-3-S', family: null,
      communication: 'fronius_sunspec', host: '192.168.254.30', port: 502, unitId: 1,
      writable: true, reason: null,
    },
  ];
  return over.length ? basis.map((t, i) => ({ ...t, ...(over[i] ?? {}) })) : basis;
}

function stub(over: {
  entities?: () => Promise<SiteEntities>;
  commands?: CommandHistory;
  targets?: RegisterWriteTarget[];
  writes?: RegisterWriteEvent[];
} = {}) {
  vi.spyOn(api, 'siteEntities').mockImplementation(
    over.entities ?? (() => Promise.resolve(entities)),
  );
  vi.spyOn(api, 'topology').mockResolvedValue(topology);
  vi.spyOn(api, 'siteSources').mockResolvedValue(sources);
  vi.spyOn(api, 'siteComponents').mockResolvedValue({
    componentAuthority: 'portal',
    components: [
      {
        id: 'fr1',
        communication: 'fronius_sunspec',
        connection: { ip: '192.168.254.30', port: 502, unit_id: 1, interval_s: 5 },
        definitionVersion: 3,
        edgeSourceId: 'src-7c1e9a2b',
      },
    ],
  });
  vi.spyOn(api, 'controlStatus').mockResolvedValue(null);
  vi.spyOn(api, 'curtailmentStatus').mockResolvedValue(null);
  vi.spyOn(api, 'edgeVersions').mockResolvedValue([
    {
      deviceId: 'gw',
      siteId: 's-1',
      coreVersion: 'edge-2026.08.10',
      paletteVersion: '0.9.0',
      reportedAt: FRISCH,
    },
  ]);
  vi.spyOn(api, 'siteChargers').mockResolvedValue({ budget: null, chargers: [] });
  vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
  vi.spyOn(api, 'commandHistory').mockResolvedValue(over.commands ?? commands());
  vi.spyOn(api, 'registerWriteTargets').mockResolvedValue(over.targets ?? targets());
  vi.spyOn(api, 'registerWriteHistory').mockResolvedValue(over.writes ?? []);
  vi.spyOn(api, 'registerKnowledge').mockResolvedValue([
    {
      family: 'hybrid_3p', brand: 'deye', label: 'Deye 3-phasig',
      registers: [{
        address: 231, addressHex: '0x00E7', label: 'Einspeisegrenze',
        clazz: 'netz_compliance', scale: 10, unit: 'kW', note: null,
      }],
    },
  ]);
}

describe('GeraetSeiteSection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('führt ein GERÄT unter seinem technischen Namen samt Live-Werten', async () => {
    stub();
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
    );

    expect(await screen.findByRole('heading', { name: 'Deye SUN-30K' })).toBeInTheDocument();
    // Der KUNDENname lebt an der Komponente, nie am Gerät.
    expect(screen.getByRole('heading', { name: 'Deye SUN-30K' }).textContent).not.toContain('Scheune');
    // Geräteseiten Stufe 2: der HELD führt, und er trägt das Live-Bild.
    expect(screen.getByTestId('geraet-held')).toBeInTheDocument();
    expect(screen.getByText('Solarstrom')).toBeInTheDocument();
    // Die Richtung ist ein WORT, nie ein Minus.
    expect(screen.getByText('Einspeisung')).toBeInTheDocument();
    // Keine Gefahrenzone an einem Gerät HINTER der Box.
    expect(screen.queryByRole('button', { name: /Gerät entfernen/ })).not.toBeInTheDocument();
  });

  /**
   * ⚠ Der Captain-Punkt 2 als Test (Geräteseiten Stufe 2): dieselbe Seite
   * beantwortet je Gerätetyp eine ANDERE erste Frage - vorher lief jeder Typ
   * durch dieselbe Sektionsliste in derselben Reihenfolge.
   */
  it('⚠ gibt einem PV-MELDER ein anderes Gesicht als dem Hauptgerät', async () => {
    stub();
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-7c1e9a2b" devices={[box]} />,
    );

    // Er führt mit seiner Erzeugung, nicht mit der Verbindungs-Karte.
    const held = await screen.findByTestId('geraet-held');
    expect(within(held).getByText('Erzeugung')).toBeInTheDocument();
    expect(within(held).getByText('Erzeugung jetzt')).toBeInTheDocument();
    // Und er bekommt die Einspeise-Begrenzung, die ein Speicher-Gerät nicht hat.
    expect(screen.getByRole('heading', { name: 'Einspeise-Begrenzung' }))
      .toBeInTheDocument();
    expect(screen.queryByText('Grenzen dieses Geräts')).toBeNull();
  });

  it('⚠ an einen ZÄHLER geht kein Befehl - also gibt es dort keinen leeren Kasten', async () => {
    stub({
      entities: () => Promise.resolve({
        ...entities,
        localSetup: [
          entities.localSetup[0],
          { ...entities.localSetup[1], role: 'grid-meter' },
        ],
      }),
    });
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-7c1e9a2b" devices={[box]} />,
    );

    const held = await screen.findByTestId('geraet-held');
    expect(within(held).getByText('Bezug & Einspeisung')).toBeInTheDocument();
    // Die Box-Lehre: eine Sektion, die nur ihre Nicht-Zuständigkeit erklärt,
    // entfällt - sie stand vorher an JEDEM Gerät.
    expect(screen.queryByText('Befehle an dieses Gerät')).toBeNull();
  });

  it('listet die Komponenten dieses Geräts mit dem Weg in die Zentrale', async () => {
    stub();
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
    );
    expect(await screen.findByText('Misst & steuert')).toBeInTheDocument();
    // Der Träger UND seine PV-Aspekt-Zeile („Solarmodule am …") - die
    // Aspekt-Zeile FOLGT dem Alias ihres Trägers, deshalb steht der Name
    // zweimal da (`komponenten.ts`).
    expect(screen.getAllByText(/Wechselrichter Scheune/).length).toBeGreaterThanOrEqual(2);
    const zentrale = screen.getAllByRole('link', { name: /In der Zentrale/ });
    expect(zentrale[0].getAttribute('href')).toBe('#/anlage/s-1/modell');
  });

  it('zeigt die gespeicherte Anbindung eines Geräts', async () => {
    stub();
    render(
      <GeraetSeiteSection
        site={site}
        boxRef="edge-45gz7da"
        geraetId="src-7c1e9a2b"
        devices={[box]}
      />,
    );
    expect(await screen.findByText('192.168.254.30 : 502')).toBeInTheDocument();
    expect(screen.getByText('Modbus-Adresse 1')).toBeInTheDocument();
    expect(screen.getByText('wird im Portal gepflegt (Fassung 3)')).toBeInTheDocument();
  });

  it('nennt den GRUND, wenn die Adresse kein Gerät meint - nie eine leere Seite', async () => {
    stub();
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-weg" devices={[box]} />,
    );
    expect(await screen.findByText(/nicht \(mehr\) zu finden/)).toBeInTheDocument();
    expect(screen.getByText(/meldet sich an Ihrer Box gerade nicht/)).toBeInTheDocument();
  });

  it('bleibt bedienbar, wenn ein NEBENabruf ausfällt', async () => {
    stub();
    vi.spyOn(api, 'siteSources').mockRejectedValue(new Error('down'));
    vi.spyOn(api, 'siteComponents').mockRejectedValue(new Error('down'));
    vi.spyOn(api, 'topology').mockRejectedValue(new Error('down'));
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
    );
    expect(await screen.findByRole('heading', { name: 'Deye SUN-30K' })).toBeInTheDocument();
    // Die zwei Sektionen sagen WARUM sie leer sind, statt still zu bleiben.
    await waitFor(() =>
      expect(screen.getByText(/meldet keine Verbindungsdaten/)).toBeInTheDocument(),
    );
    // Der HELD nennt seinen Grund genauso - eine Reihe von „—" ist keine
    // Auskunft (Geräteseiten Stufe 2).
    expect(screen.getByText(/noch keine Messwerte geliefert/)).toBeInTheDocument();
  });

  it('zeigt einen Fehlerzustand mit Wiederholen, wenn der TRAGENDE Abruf ausfällt', async () => {
    stub({ entities: () => Promise.reject(new Error('down')) });
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    expect(await screen.findByText(/konnte nicht geladen werden/)).toBeInTheDocument();
  });

  /*
    Anlagen-Zentrale Stufe 3 (PR 3c, §13.3): der Wohnort der Regeln BLEIBT die
    Steuerung. Die Geräteseite sagt nur, WELCHE dieses Gerät nutzen, und führt
    dorthin - ein zweiter Regel-Ort wäre die Doppelung, die die Stufe abräumt.
  */
  it('führt von den Steuerungs-Bezügen in die Steuerung dieser Anlage', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    const link = await screen.findByRole('link', { name: /Regeln und Anwendungen dieser Anlage/ });
    expect(link.getAttribute('href')).toBe('#/anlage/s-1/steuerung');
  });

  it('führt zurück ins Anlagen-Modell', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    const back = await screen.findByRole('link', { name: /Zurück zum Anlagen-Modell/ });
    expect(back.getAttribute('href')).toBe('#/anlage/s-1/modell');
  });

  it('zeigt die Befehle DIESES Geräts und führt auf die volle Liste', async () => {
    // Der Wechselrichter trägt seit der Ziel-Attribution seinen Speicher-Strom
    // (`deviceIsBox: false`) - die Seite fragt den Server mit SEINER Kennung.
    stub({ commands: commands({ deviceIsBox: false, deviceRef: 'inverter' }) });
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);

    expect(await screen.findByText('Befehle an dieses Gerät')).toBeInTheDocument();
    // Der Server entscheidet, was zu diesem Gerät gehört - die Fläche fragt ihn
    // mit der Adresse, unter der die Seite geöffnet wurde.
    expect(api.commandHistory).toHaveBeenCalledWith('s-1', { device: 'inverter' });
    const alle = screen.getByRole('link', { name: /Alle anzeigen/ });
    expect(alle.getAttribute('href')).toBe('#/anlage/s-1/befehle?geraet=inverter');
    // Der Schnell-Chip filtert den MINI-Film clientseitig UND reist im Link
    // mit - der Zustand geht am Sprung nicht verloren (Revision B §6).
    fireEvent.click(screen.getByRole('button', { name: 'Nur Abweichungen' }));
    expect(screen.getByRole('link', { name: /Alle anzeigen/ }).getAttribute('href'))
      .toContain('ergebnis=abweichend');
    // Und die Grenze wird ERKLÄRT: die anlagenweiten Befehle gehören der Box.
    expect(screen.getByText(/Anlagenweite Befehle/)).toBeInTheDocument();
  });

  it('erklärt an einem Gerät HINTER der Box, wo die anlagenweiten Befehle stehen', async () => {
    stub({ commands: commands({ deviceIsBox: false, deviceRef: 'src-7c1e9a2b', entries: [] }) });
    render(
      <GeraetSeiteSection
        site={site}
        boxRef="edge-45gz7da"
        geraetId="src-7c1e9a2b"
        devices={[box]}
      />,
    );
    expect(await screen.findByText(/Anlagenweite Befehle/)).toBeInTheDocument();
    // Ohne Zeile steht der GRUND da, nie ein leerer Kasten.
    expect(screen.getByText(/kein Befehl geschickt/)).toBeInTheDocument();
  });

  it('sagt die F4-Antwort, wenn an dieses Gerät gar nicht geschrieben wird', async () => {
    stub({ commands: commands({ writes: false, entries: [] }) });
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    expect(await screen.findByText(/nur gelesen/)).toBeInTheDocument();
  });

  it('bleibt bedienbar, wenn der Verlauf ausfällt', async () => {
    stub();
    vi.spyOn(api, 'commandHistory').mockRejectedValue(new Error('down'));
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    // Die Sektion bleibt - sie sagt, dass noch nicht aufgezeichnet wurde,
    // statt eine leere Behauptung zu machen.
    expect(await screen.findByText('Befehle an dieses Gerät')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Aufzeichnung hat noch nicht begonnen/)).toBeInTheDocument(),
    );
  });

  /**
   * E · Register schreiben: die Strecke ist NICHT verschwunden, sie wohnt jetzt
   * am Gerät - mit VORGEWÄHLTEM Ziel, und für den KUNDEN (ohne Admin-Rolle).
   */
  it('bietet dem Kunden das Register-Werkzeug mit vorgewähltem Ziel', async () => {
    stub();
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-7c1e9a2b" devices={[box]} />,
    );

    fireEvent.click(await screen.findByTestId('geraet-regwrite'));
    // Es ist DERSELBE Drawer wie überall - eine zweite Strecke könnte über
    // denselben Vorgang etwas anderes behaupten.
    const drawer = await screen.findByTestId('regwrite');
    // Vorgewählt ist die Komponente DIESES Geräts, nicht die Box.
    await waitFor(() =>
      expect((within(drawer).getByLabelText(/Dach Süd/) as HTMLInputElement).checked).toBe(true),
    );
  });

  /**
   * ⚠ DER BEFUND DES CAPTAIN-REVIEWS, als Test (Geräteseiten Stufe 2, E4): die
   * Seite des Deye empfahl, „den primären Wechselrichter als Ziel zu wählen" -
   * also sich selbst. Sie IST die primäre Lane; der Knopf steht jetzt dort.
   */
  it('⚠ das HAUPTGERÄT bekommt seinen Knopf, nicht die Empfehlung, sich selbst zu wählen',
    async () => {
      // Genau die Live-Lage: die Speicher-Komponente des Deye hängt am
      // Solarman-Logger, der Server bildet sie deshalb auf die primäre Lane ab.
      stub({ targets: [
        targets()[0],
        {
          lane: 'primary', deviceId: 'gw', entityId: 'batt', label: 'Speicher',
          brand: 'deye', model: 'SUN-30K-SG01HP3-EU', family: 'hybrid_3p',
          communication: 'solarman_v5', host: '192.168.0.28', port: 8899, unitId: 1,
          writable: true, reason: null, primaryAlias: true,
        },
      ] });
      render(
        <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
      );

      fireEvent.click(await screen.findByTestId('geraet-regwrite'));
      const drawer = await screen.findByTestId('regwrite');
      // Vorgewählt ist das Gerät selbst - und NIRGENDS steht ein Transport-Wort.
      await waitFor(() =>
        expect((within(drawer).getByLabelText(/Deye SUN-30K/) as HTMLInputElement).checked)
          .toBe(true),
      );
      expect(document.body.textContent).not.toMatch(/Solarman/i);
      expect(document.body.textContent).not.toMatch(/primären Wechselrichter als Ziel/i);
    });

  it('nennt den Grund, wenn dieses Gerät keinen Schreibweg hat', async () => {
    stub({ targets: [targets()[0]] });
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-7c1e9a2b" devices={[box]} />,
    );
    // Ein Knopf, der strukturell nichts bewirken kann, wird nicht angeboten.
    expect(await screen.findByTestId('geraet-regwrite-grund')).toBeInTheDocument();
    expect(screen.queryByTestId('geraet-regwrite')).toBeNull();
  });

  /**
   * D · Gelesene Register: die Sicht entsteht aus dem BESTAND - und die
   * Roh-Spalte bleibt ehrlich leer, wo kein Wort über die Leitung kam.
   */
  it('zeigt die gelesenen Register mit ihrer Frische - und sagt die Grenze', async () => {
    stub({
      commands: commands({ deviceIsBox: false }),
      writes: [{
        id: 7, requestId: 'r-7', source: 'portal', deviceId: 'gw', deviceRef: 'edge-45gz7da',
        lane: 'entity', entityId: 'fr1', targetLabel: 'Dach Süd', registerKind: 'holding',
        address: 231, addressHex: '0x00E7', addressInput: '0x00E7', valueInput: '7000',
        note: null, valueRaw: 7000, expectedBefore: 3300, registerLabel: 'Einspeisegrenze',
        registerClass: 'netz_compliance', scaleNote: 'Rohwert × 0.01 = 70,0 kW', origin: 'kunde',
        actorName: 'demo', actorRole: null, viaTenantSwitcher: false,
        requestedAt: FRISCH, beforeRaw: 3300, afterRaw: 7000, adopted: true,
        outcome: 'ok', reason: null, answeredAt: FRISCH,
      }],
    });
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-7c1e9a2b" devices={[box]} />,
    );

    // Seit Stufe 2 sind Lesen und Schreiben EINE Sektion „Register" (§4.2).
    expect(await screen.findByRole('heading', { name: 'Register' })).toBeInTheDocument();
    // Das Rohwort des Schreibvorgangs - das einzige, das es heute gibt.
    await waitFor(() => expect(screen.getByText('7000')).toBeInTheDocument());
    // Die Warnklasse trägt ihr WORT, nie nur eine Farbe.
    expect(screen.getByText('Netz-Anmeldung')).toBeInTheDocument();
  });

});

// ---------------------------------------------------------------------------
// PR 1f: die PLATTFORM-Sicht auf DERSELBEN Seite (M7-Rollen-Tor)
// ---------------------------------------------------------------------------

describe('GeraetSeiteSection · Plattform-Sicht', () => {
  afterEach(() => vi.restoreAllMocks());

  function stubAdmin() {
    vi.spyOn(adminApi, 'listDevices').mockResolvedValue([
      {
        deviceId: 'gw',
        externalRef: 'edge-45gz7da',
        label: 'Pilsting',
        siteId: 's-1',
        siteName: 'Pilsting',
        tenantId: 't-1',
        tenantName: 'Kunde',
        kind: 'inverter',
        ist: 'edge-2026.08.1-9b37439a02c1',
        soll: 'edge-2026.08.1',
        sollSeq: 14,
        channel: 'stable',
        pinned: false,
        state: 'bestaetigt',
        reason: null,
        blocker: null,
        lastSeenAt: FRISCH,
        reportedAt: FRISCH,
        provisioned: false,
        note: null,
        provisionedAt: null,
      },
    ]);
    vi.spyOn(fleetApi, 'fleet').mockResolvedValue({
      sites: [],
      releases: [],
      journal: [],
      kpi: null,
    } as never);
    vi.spyOn(adminApi, 'controlCandidates').mockResolvedValue([]);
    vi.spyOn(adminApi, 'edgeUpdates').mockResolvedValue({
      releases: [],
      journal: [],
      rollout: null,
      fleet: [],
      kpi: null,
    } as never);
  }

  it('zeigt dem KUNDEN keine Plattform-Sicht', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    stubAdmin();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('geraet-admin')).toBeNull();
    // Und die Admin-Reads werden gar nicht erst geholt.
    expect(adminApi.listDevices).not.toHaveBeenCalled();
  });

  it('zeigt dem PLATTFORM-ADMIN dieselbe Seite PLUS die Plattform-Sicht', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(true);
    stub();
    stubAdmin();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    const block = await screen.findByTestId('geraet-admin');
    expect(within(block).getByText(/Plattform-Sicht/)).toBeTruthy();
    // Die Kunden-Sektionen bleiben unverändert daneben stehen.
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('bleibt ohne Admin-Daten stehen - eine gescheiterte Plattform-Sicht kippt die Seite nicht', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(true);
    stub();
    vi.spyOn(adminApi, 'listDevices').mockRejectedValue(new Error('down'));
    vi.spyOn(fleetApi, 'fleet').mockRejectedValue(new Error('down'));
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(adminApi.listDevices).toHaveBeenCalled());
    expect(screen.queryByTestId('geraet-admin')).toBeNull();
  });
});
