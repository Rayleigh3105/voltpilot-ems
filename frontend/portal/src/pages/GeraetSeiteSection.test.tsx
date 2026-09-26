import { bestandSnapshot, bestandsZeit } from '../test/bestandsschutzSnapshot';
import { sichtbareListe } from '../test/rollenFixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GeraetSeiteSection } from './GeraetSeiteSection';
import * as auth from '../auth';
import { BAUSTEIN_ORDNUNG, type BausteinId } from '../geraetRahmen';
import { NUR_LESEN } from '../befehle';
import { SEITE } from '../befehleVerlauf';
import { adminApi } from '../admin/adminApi';
import { consumersApi } from '../consumers/consumersApi';
import type { Consumer } from '../consumers/types';
import { fleetApi } from '../admin/fleetApi';
import { entitiesApi } from '../entitiesApi';
import { requestNavigation } from '../navigationBlocker';
import {
  api,
  type CommandHistory,
  type Device,
  type RegisterWriteTarget,
  type Site,
  type SiteComponents,
  type SiteEntities,
  type SiteInterventions,
  type SiteSource,
  type SiteTopology,
} from '../api';
import { gr4Einstellungen, gr4Z5b, k5Kanaele } from '../test/geraetHerkunftFixtures';

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
      // Die vom Gerät GEMELDETE Anbindungsfamilie (PR 2b) - sie entscheidet
      // seit Stufe 0, welchen Register-Katalog die Messbibliothek zeigt.
      family: 'hybrid_3p',
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
      family: 'sunspec_live',
      label: null,
      reportedAt: FRISCH,
      adoptedEntityId: 'fr1',
    },
    {
      id: 'src-goe',
      kind: 'source',
      role: 'consumer',
      brand: 'go-e',
      model: 'Charger Gemini',
      // ⚠ Der WEG entscheidet über die Register-Sektion (`geraetGesicht`), die
      // FAMILIE über den Katalog - beide gehören zu einem HTTP-Gerät.
      communication: 'goe_http_api',
      family: 'goe_http_api',
      label: null,
      reportedAt: FRISCH,
      adoptedEntityId: null,
    },
    {
      // Ein Selbstbau-Gerät: die Box meldet es, der Katalog kennt dafür keine
      // Registerliste - genau der Fall der Ausblende-Regel.
      id: 'src-eigen',
      kind: 'source',
      role: 'consumer',
      brand: null,
      model: null,
      family: 'modbus-generic',
      label: null,
      reportedAt: FRISCH,
      adoptedEntityId: null,
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
  {
    deviceId: 'gw',
    sourceId: 'src-goe',
    kind: 'source',
    role: 'consumer',
    label: null,
    brand: 'go-e',
    model: 'Charger Gemini',
    pvKw: null,
    powerKw: null,
    loadKw: 7.4,
    health: 'ok',
    readAt: FRISCH,
    reportedAt: FRISCH,
  },
  {
    deviceId: 'gw',
    sourceId: 'src-eigen',
    kind: 'source',
    role: 'consumer',
    label: null,
    brand: null,
    model: null,
    pvKw: null,
    powerKw: null,
    loadKw: 0.4,
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
  interventions?: SiteInterventions;
  consumers?: Consumer[];
  targets?: RegisterWriteTarget[];
  writes?: RegisterWriteEvent[];
  /** Überschreibt die gemeldeten Messpunkte (P4: der BMS-Block). */
  sources?: SiteSource[];
} = {}) {
  vi.spyOn(api, 'measurementSelection').mockResolvedValue({
    deviceId: 'gw', siteId: 's-1', desiredRevision: 0, catalogVersion: '2026.08.26.1',
    status: 'idle', statusReason: 'Keine zusätzlichen Messwerte ausgewählt.',
    activationNotice: 'Startet jetzt, kein Backfill.',
    disableNotice: 'Historie bleibt erhalten.', selections: [],
    volumeEstimate: { enabledPointCount: 0, samplesPerMinute: 0, requestsPerMinute: 0,
      dutyCyclePercent: 0, softWarning: false, hardRejected: false, reasons: [],
      rawGbPerYear: 0, longTermGbPerYear: 0, totalGbPerYear: 0, retentionSummary: '' },
  });
  vi.spyOn(api, 'measurementCatalog').mockResolvedValue({
    catalogVersion: '2026.08.26.1', edgeMinVersion: 'unreleased',
    customPointActionLabel: 'Eigenen Messwert hinzufügen', total: 0, offset: 0, limit: 100,
    groups: [], semanticStatuses: [], points: [],
  });
  vi.spyOn(api, 'siteEntities').mockImplementation(
    over.entities ?? (() => Promise.resolve(entities)),
  );
  vi.spyOn(api, 'topology').mockResolvedValue(topology);
  vi.spyOn(api, 'siteSources').mockResolvedValue(over.sources ?? sources);
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
  vi.spyOn(api, 'edgeVersions').mockResolvedValue(sichtbareListe([
    {
      deviceId: 'gw',
      siteId: 's-1',
      coreVersion: 'edge-2026.08.10',
      paletteVersion: '0.9.0',
      reportedAt: FRISCH,
    },
  ]));
  vi.spyOn(api, 'siteChargers').mockResolvedValue({ budget: null, chargers: [] });
  vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
  vi.spyOn(api, 'commandHistory').mockResolvedValue(over.commands ?? commands());
  // Die Aktionszeile (Stufe 2 §6.2) - was ein Blatt ABSETZEN kann. Alle drei
  // sind fail-soft und gattungs-getaktet: ein Zähler bezahlt sie nie.
  vi.spyOn(api, 'siteInterventions').mockResolvedValue(
    over.interventions ?? { automationPaused: false, pausedUntil: null, interventions: [] },
  );
  vi.spyOn(api, 'schedule').mockResolvedValue(
    { slots: [], generatedAt: null } as never,
  );
  vi.spyOn(api, 'geraetSummenwerte').mockResolvedValue([]);
  // Der Baustein „Heute" (E2 a) liest den Tagesverlauf - ein leerer Tag ist eine
  // Auskunft, kein Fehler.
  vi.spyOn(api, 'entityHistory').mockResolvedValue({
    range: 'day', from: '2026-08-15T22:00:00Z', to: '2026-08-16T22:00:00Z', bucketMinutes: 15, channels: {},
  });
  vi.spyOn(consumersApi, 'list').mockResolvedValue(over.consumers ?? []);
  vi.spyOn(consumersApi, 'overrides').mockResolvedValue([]);
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

it('AP-13 Bestandsschutz · Geräteseite ohne Messfunktion', async () => {
  bestandsZeit();
  const fest = <T,>(daten: T): T => JSON.parse(JSON.stringify(daten).replaceAll(FRISCH, '2026-09-02T10:19:00Z'));
  stub({ sources: fest(sources), entities: async () => fest(entities) });
  vi.spyOn(api, 'topology').mockResolvedValue(fest(topology));
  const view = render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[fest(box)]} />);
  await screen.findByRole('heading', { name: 'Deye SUN-30K' });
  await bestandSnapshot('geraeteseite', view);
  vi.restoreAllMocks();
});

/**
 * Öffnet „Technik & Diagnose" (E1 a) - die eigene Ansicht für Register,
 * Rohdaten und Plattform-Sicht - und liefert ihren Inhalt.
 */
async function technikOeffnen(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId('geraet-technik-oeffnen'));
  return screen.findByTestId('geraet-technik');
}

/** Ein Teil der Technik-Ansicht („register", „rohdaten", „plattform" …). */
async function technikTeil(id: string): Promise<HTMLElement> {
  const technik = await technikOeffnen();
  await waitFor(() => expect(technik.querySelector(`[data-technik="${id}"]`)).not.toBeNull());
  return technik.querySelector(`[data-technik="${id}"]`) as HTMLElement;
}

describe('GeraetSeiteSection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '#/');
  });

  it('führt ein GERÄT unter seinem technischen Namen samt Live-Werten', async () => {
    stub();
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
    );

    expect(await screen.findByRole('heading', { name: 'Deye SUN-30K' })).toBeInTheDocument();
    // Der KUNDENname lebt an der Komponente, nie am Gerät.
    expect(screen.getByRole('heading', { name: 'Deye SUN-30K' }).textContent).not.toContain('Scheune');
    // Die BÜHNE führt: die eine große Zahl (der Ladestand) und die Grafik.
    const held = screen.getByTestId('geraet-held');
    expect(held.querySelector('[data-kachel="speicher"]')).toHaveTextContent('76,0');
    expect(within(held).getByRole('img', { name: /Energiefluss am Wechselrichter/ })).toBeInTheDocument();
    // Die Richtung ist ein WORT, nie ein Minus.
    expect(within(held).getByText('Einspeisung')).toBeInTheDocument();
    // Kein „Gerät entfernen" an einem Gerät HINTER der Box - das gibt es nur an der Box.
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    expect(screen.queryByRole('menuitem', { name: /Gerät entfernen/ })).not.toBeInTheDocument();
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

    // Er führt mit seiner Erzeugung, nicht mit dem Speicher-Bild.
    const held = await screen.findByTestId('geraet-held');
    expect(within(held).getByTestId('geraet-heldsatz')).toHaveTextContent(/^Erzeugt gerade 21,2/);
    expect(within(held).getByRole('img', { name: /^Erzeugung/ })).toBeInTheDocument();
    expect(within(held).queryByRole('img', { name: /Energiefluss am Wechselrichter/ })).toBeNull();
    // S5: ohne gemeldete Begrenzung DIESES Geräts gibt es keinen Kasten, der
    // erklärt, dass er leer ist.
    expect(screen.queryByRole('heading', { name: 'Einspeise-Begrenzung' })).toBeNull();
    expect(screen.queryByText('Grenzen dieses Geräts')).toBeNull();
  });

  it('gibt dem PV-Melder die Einspeise-Begrenzung, sobald seine Box sie für ihn meldet', async () => {
    stub();
    vi.spyOn(api, 'curtailmentStatus').mockResolvedValue({
      units: 2, certifiedUnits: 1,
      perUnit: [{ sourceId: 'src-7c1e9a2b', certified: true, appliedCapKw: null, match: null }],
    } as never);
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-7c1e9a2b" devices={[box]} />,
    );
    const karte = await screen.findByTestId('baustein-steuerung');
    expect(within(karte).getByRole('heading', { name: 'Einspeise-Begrenzung' })).toBeInTheDocument();
    expect(karte).toHaveTextContent(/nimmt Einspeise-Begrenzungen von VoltPilot an/);
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
    expect(within(held).getByTestId('geraet-heldsatz')).toHaveTextContent('Dieser Zähler meldet gerade keinen Wert.');
    // Die Box-Lehre: ein Baustein, der nur seine Nicht-Zuständigkeit erklärt,
    // entfällt - „nur Messung" sagt der Kopf.
    expect(screen.queryByTestId('baustein-aktivitaet')).toBeNull();
    expect(screen.queryByTestId('baustein-steuerung')).toBeNull();
    expect(within(screen.getByTestId('geraet-kopf')).getByText(/nur Messung/)).toHaveAttribute('title', NUR_LESEN);
  });

  it('listet die Komponenten dieses Geräts mit dem Weg in die Zentrale', async () => {
    stub();
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
    );
    const details = await screen.findByTestId('baustein-details');
    // „Misst" nennt die Komponenten DIESES Geräts - mit dem Kundennamen, den
    // sie in der Zentrale tragen.
    const misst = within(details).getByText('Misst').parentElement as HTMLElement;
    expect(misst).toHaveTextContent('Wechselrichter Scheune');
    const zentrale = within(details).getByRole('link', { name: /In der Zentrale/ });
    expect(zentrale.getAttribute('href')).toBe('#/anlage/s-1/modell');
  });

  // P4: „BMS" - nur da, wenn eine Batterie per CAN am Gerät hängt. Heute hängt
  // an keiner Anlage eine, also ist die Abwesenheit des Kastens der Normalfall
  // (und ausdrücklich kein Kasten, der erklärt, dass er nichts weiß).
  it('zeigt KEINEN BMS-Kasten, solange keine Batterie per CAN gekoppelt ist', async () => {
    stub();
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
    );
    expect(await screen.findByTestId('baustein-details')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'BMS' })).not.toBeInTheDocument();
  });

  it('zeigt den BMS-Kasten mit dem gemeldeten Ladestand, sobald gekoppelt ist', async () => {
    stub({
      sources: sources.map((s) => (s.sourceId === 'inverter'
        ? { ...s, bms: { bms_soc_pct: 47, bms_voltage_v: 642, bms_type: 10 } }
        : s)),
    });
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
    );
    expect(await screen.findByRole('heading', { name: 'BMS' })).toBeInTheDocument();
    expect(screen.getByText('Ladestand laut BMS')).toBeInTheDocument();
    expect(screen.getByText('Shenggao Electric CAN')).toBeInTheDocument();
  });

  // UEMS AP-04 IP-12: „Gerät & Verbindung" (vor V7 die Sektion „Komponenten —
  // Was misst und steuert es?") trägt Gerät, Einstellungen und Messkanäle -
  // ergänzt, nicht neu gebaut: die Detail-Zeilen stehen weiter darüber.
  it('trägt in „Gerät & Verbindung“ die Karte „Gerät“, die Einstellungen und die Messkanäle mit „speist …“', async () => {
    stub();
    vi.spyOn(api, 'uemsGeraete').mockResolvedValue({
      geraete: [{ ...gr4Z5b(), komponenten: [{ entity_id: 'batt', gueltig_ab: '2026-11-18T10:40:00+01:00', gueltig_bis: null }] }],
    });
    vi.spyOn(api, 'komponenteMesskanaele').mockResolvedValue(k5Kanaele());
    vi.spyOn(api, 'geraetEinstellungen').mockResolvedValue(gr4Einstellungen());
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
    );
    const sektion = await screen.findByTestId('baustein-details');
    const karte = await within(sektion).findByTestId('geraet-karte');
    expect(within(karte).getByText('Zähler Z-5b')).toBeInTheDocument();
    expect(within(karte).getByText('Wechselrichter Scheune')).toBeInTheDocument();
    expect(await within(sektion).findByTestId('geraet-einstellungen')).toBeInTheDocument();
    expect(within(sektion).getAllByText('speist MS-06 (führend)')).toHaveLength(2);
    expect(api.komponenteMesskanaele).toHaveBeenCalledWith('s-1', 'batt');
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
    // S1: WO gepflegt wird, steht nicht mehr im Kopf, sondern in Technik ›
    // Einrichtung - als Satz unter der gleichnamigen Überschrift.
    const einrichtung = await technikTeil('einrichtung');
    expect(within(einrichtung).getByText('Wird im Portal gepflegt (Fassung 3).')).toBeInTheDocument();
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
    const details = await screen.findByTestId('baustein-details');
    const link = within(details).getByRole('link', { name: /Regeln dieser Anlage/ });
    expect(link.getAttribute('href')).toBe('#/anlage/s-1/steuerung');
  });

  it('traegt GENAU EINEN Rueckweg: die Brotkrume Anlage - Komponenten - Geraet', async () => {
    stub();
    const view = render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    const pfad = await screen.findByRole('navigation', { name: 'Pfad zur Geräteseite' });
    expect(within(pfad).getByRole('link', { name: 'Anlage' }).getAttribute('href'))
      .toBe('#/anlage/s-1');
    expect(within(pfad).getByRole('link', { name: 'Aufbau' }).getAttribute('href'))
      .toBe('#/anlage/s-1/modell');
    expect(pfad.querySelector('[aria-current="page"]')?.textContent).toBeTruthy();
    // Der frueher direkt darunter stehende ZWEITE Rueckweg ist ersatzlos
    // entfallen (Stufe 0, Paragraph 2.1) - er zeigte auf dieselbe Seite.
    expect(screen.queryByRole('link', { name: /Zurück zu den Komponenten/ })).toBeNull();
    expect(view.container.querySelectorAll('nav[aria-label="Pfad zur Geräteseite"]'))
      .toHaveLength(1);
  });

  it('bietet keinen Standortwechsel fuer Geraete mehr an', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    await screen.findByTestId('geraet-rahmen');
    expect(screen.queryByRole('button', { name: 'Gerät verschieben' })).toBeNull();
  });

  it('bearbeitet ein Portal-Gerät auf derselben Geräteseite statt in einem Dialog', async () => {
    stub();
    window.history.replaceState(
      null,
      '',
      '#/anlage/s-1/geraet/edge-45gz7da/src-7c1e9a2b?bearbeiten=1',
    );
    const row: SiteComponents['components'][number] = {
      id: 'fr1', role: 'pv-generation', entityType: 'producer', label: 'Dach Süd',
      brand: 'fronius', model: 'eco-27', family: 'sunspec_live',
      communication: 'fronius_sunspec',
      connection: { ip: '192.168.254.30', port: 502, unit_id: 1 },
      templateRef: 'builtin:fronius:eco-27', templateVersion: 1,
      definitionVersion: 3, edgeSourceId: 'src-7c1e9a2b', syncStatus: 'in_sync',
      capacityKwp: 27,
    };
    const updatedRow: SiteComponents['components'][number] = {
      ...row, label: 'Garage Süd', definitionVersion: 4, syncStatus: 'pending',
    };
    const refreshedEntities: SiteEntities = {
      ...entities,
      entities: entities.entities.map((entity) => entity.id === row.id
        ? { ...entity, label: updatedRow.label }
        : entity),
    };
    let saved = false;
    vi.mocked(api.siteEntities).mockImplementation(async () =>
      saved ? refreshedEntities : entities);
    vi.mocked(api.siteComponents).mockImplementation(async () => ({
      componentAuthority: 'portal', components: [saved ? updatedRow : row],
    }));
    vi.spyOn(api, 'componentVersions').mockResolvedValue([]);
    vi.spyOn(api, 'componentTemplates').mockResolvedValue([{
      templateRef: row.templateRef, kind: 'builtin', version: 1,
      brand: 'fronius', brandLabel: 'Fronius', model: 'eco-27', modelLabel: 'Eco 27.0-3-S',
      communication: 'fronius_sunspec', communicationLabel: 'SunSpec Modbus TCP',
      transportSchema: [
        { key: 'ip', label: 'IP-Adresse', required: true },
        { key: 'port', label: 'Port', type: 'number', default: 502 },
        { key: 'unit_id', label: 'Modbus-Adresse', type: 'number', default: 1 },
      ],
    }]);
    const connectionTest = vi.spyOn(api, 'testComponentConnection').mockResolvedValue({
      results: [{ id: 'verbindung', ok: true }],
    });
    vi.spyOn(api, 'updateComponent').mockImplementation(async () => {
      saved = true;
      return {
        componentAuthority: 'portal',
        components: [updatedRow],
      };
    });

    render(
      <GeraetSeiteSection
        site={site}
        boxRef="edge-45gz7da"
        geraetId="src-7c1e9a2b"
        devices={[box]}
      />,
    );

    expect(await screen.findByTestId('geraet-bearbeiten')).toBeVisible();
    expect(window.location.hash).toBe('#/anlage/s-1/geraet/edge-45gz7da/src-7c1e9a2b');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('geraet-rahmen')).toBeNull();
    expect(screen.getByLabelText('Anzeigename')).toHaveValue('Dach Süd');
    expect(screen.getByText('Pilsting')).toBeVisible();

    fireEvent.change(screen.getByLabelText('Anzeigename'), { target: { value: 'Garage Süd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Änderungen speichern' }));

    expect(await screen.findByText(/Änderungen als neue Fassung gespeichert/)).toBeVisible();
    const componentSection = await screen.findByTestId('baustein-details');
    await waitFor(() => expect(componentSection).toHaveTextContent('Garage Süd'));
    expect(componentSection).not.toHaveTextContent('Dach Süd');
    expect(await screen.findByRole('heading', { name: 'Garage Süd' })).toBeVisible();
    expect(api.siteEntities).toHaveBeenCalledTimes(2);
    expect(connectionTest).not.toHaveBeenCalled();
    window.history.replaceState(null, '', '#/');
  });

  it('wartet beim Routenwechsel auf die Bearbeitungsdaten des neuen Standorts', async () => {
    stub();
    const siteB: Site = { ...site, id: 's-2', name: 'Landshut' };
    const boxB: Device = { ...box, id: 'gw-b', siteId: siteB.id, name: siteB.name };
    const rowA: SiteComponents['components'][number] = {
      id: 'fr1', role: 'pv-generation', entityType: 'producer', label: 'Dach Süd',
      brand: 'fronius', model: 'eco-27', family: 'sunspec_live',
      communication: 'fronius_sunspec',
      connection: { ip: '192.168.254.30', port: 502, unit_id: 1 },
      templateRef: 'builtin:fronius:eco-27', templateVersion: 1, definitionVersion: 3,
      edgeSourceId: 'src-7c1e9a2b', syncStatus: 'in_sync', capacityKwp: 27,
    };
    const rowB = {
      ...rowA,
      id: 'fr-b',
      label: 'Dach Nord',
      connection: { ip: '10.0.0.44', port: 502, unit_id: 2 },
    };
    const entitiesB: SiteEntities = {
      ...entities,
      entities: entities.entities.map((entity) => entity.id === 'fr1'
        ? { ...entity, id: 'fr-b', label: 'Dach Nord', deviceId: 'gw-b' }
        : { ...entity, deviceId: 'gw-b' }),
      localSetup: entities.localSetup.map((entry) => entry.id === 'src-7c1e9a2b'
        ? { ...entry, adoptedEntityId: 'fr-b' }
        : entry),
    };
    const componentsA: SiteComponents = { componentAuthority: 'portal', components: [rowA] };
    const componentsB: SiteComponents = { componentAuthority: 'portal', components: [rowB] };
    let resolveEntitiesB!: (value: SiteEntities) => void;
    let resolveComponentsB!: (value: SiteComponents) => void;
    const pendingEntitiesB = new Promise<SiteEntities>((resolve) => {
      resolveEntitiesB = resolve;
    });
    const pendingComponentsB = new Promise<SiteComponents>((resolve) => {
      resolveComponentsB = resolve;
    });
    vi.mocked(api.siteEntities).mockImplementation((siteId) =>
      siteId === siteB.id ? pendingEntitiesB : Promise.resolve(entities));
    vi.mocked(api.siteComponents).mockImplementation((siteId) =>
      siteId === siteB.id ? pendingComponentsB : Promise.resolve(componentsA));
    vi.spyOn(api, 'componentVersions').mockResolvedValue([]);
    vi.spyOn(api, 'componentTemplates').mockResolvedValue([{
      templateRef: rowA.templateRef, kind: 'builtin', version: 1,
      brand: 'fronius', brandLabel: 'Fronius', model: 'eco-27', modelLabel: 'Eco 27.0-3-S',
      communication: 'fronius_sunspec', communicationLabel: 'SunSpec Modbus TCP',
      transportSchema: [
        { key: 'ip', label: 'IP-Adresse', required: true },
        { key: 'port', label: 'Port', type: 'number', default: 502 },
        { key: 'unit_id', label: 'Modbus-Adresse', type: 'number', default: 1 },
      ],
    }]);
    const update = vi.spyOn(api, 'updateComponent').mockResolvedValue({
      componentAuthority: 'portal', components: [{ ...rowB, label: 'Carport Nord' }],
    });

    window.history.replaceState(
      null,
      '',
      '#/anlage/s-1/geraet/edge-45gz7da/src-7c1e9a2b?bearbeiten=1',
    );
    const view = render(
      <GeraetSeiteSection site={site} boxRef={box.externalRef} geraetId="src-7c1e9a2b" devices={[box]} />,
    );
    expect(await screen.findByLabelText('Anzeigename')).toHaveValue('Dach Süd');

    window.history.replaceState(
      null,
      '',
      '#/anlage/s-2/geraet/edge-45gz7da/src-7c1e9a2b?bearbeiten=1',
    );
    view.rerender(
      <GeraetSeiteSection site={siteB} boxRef={boxB.externalRef} geraetId="src-7c1e9a2b" devices={[boxB]} />,
    );
    await waitFor(() => expect(screen.queryByTestId('geraet-bearbeiten')).toBeNull());
    expect(window.location.hash).toContain('bearbeiten=1');

    await act(async () => {
      resolveEntitiesB(entitiesB);
      await pendingEntitiesB;
    });
    expect(window.location.hash).toContain('bearbeiten=1');
    expect(screen.queryByTestId('geraet-bearbeiten')).toBeNull();

    await act(async () => {
      resolveComponentsB(componentsB);
      await pendingComponentsB;
    });
    const name = await screen.findByLabelText('Anzeigename');
    expect(name).toHaveValue('Dach Nord');
    expect(window.location.hash).not.toContain('bearbeiten=1');
    fireEvent.change(name, { target: { value: 'Carport Nord' } });
    fireEvent.click(screen.getByRole('button', { name: 'Änderungen speichern' }));

    await waitFor(() => expect(update).toHaveBeenCalledWith(
      's-2', 'fr-b', expect.objectContaining({
        label: 'Carport Nord',
        connection: expect.objectContaining({ ip: '10.0.0.44', unit_id: 2 }),
      }),
    ));
  });

  it('beendet einen Bearbeitungs-Deep-Link sichtbar, wenn Komponentendaten ausfallen', async () => {
    stub();
    vi.mocked(api.siteComponents).mockRejectedValue(new Error('down'));
    window.history.replaceState(
      null,
      '',
      '#/anlage/s-1/geraet/edge-45gz7da/inverter?bearbeiten=1',
    );

    render(
      <GeraetSeiteSection site={site} boxRef={box.externalRef} geraetId="inverter" devices={[box]} />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Die Bearbeitungsdaten dieses Geräts konnten nicht geladen werden.',
    );
    expect(window.location.hash).not.toContain('bearbeiten=1');
  });

  it('meldet einen veralteten Komponenten-Link sichtbar auf der Geräteseite', async () => {
    stub();
    window.history.replaceState(
      null,
      '',
      '#/anlage/s-1/geraet/edge-45gz7da/inverter?bearbeiten=1&komponente=entfernt',
    );

    render(
      <GeraetSeiteSection
        site={site}
        boxRef="edge-45gz7da"
        geraetId="inverter"
        devices={[box]}
      />,
    );

    await waitFor(() => expect(screen.getAllByRole('alert').some((alert) =>
      alert.textContent?.includes('Diese Komponente ist an diesem Gerät nicht mehr verfügbar.'),
    )).toBe(true));
    expect(window.location.hash).toBe('#/anlage/s-1/geraet/edge-45gz7da/inverter');
    expect(screen.getByTestId('geraet-rahmen')).toBeVisible();
  });

  it('räumt einen alten Deep-Link-Fehler beim gültigen Bearbeiten-Einstieg ab', async () => {
    stub();
    const row: SiteComponents['components'][number] = {
      id: 'fr1', role: 'pv-generation', entityType: 'producer', label: 'Dach Süd',
      brand: 'fronius', model: 'eco-27', family: 'sunspec_live',
      communication: 'fronius_sunspec',
      connection: { ip: '192.168.254.30', port: 502, unit_id: 1 },
      templateRef: 'builtin:fronius:eco-27', templateVersion: 1,
      definitionVersion: 3, edgeSourceId: 'src-7c1e9a2b', syncStatus: 'in_sync',
      capacityKwp: 27,
    };
    vi.mocked(api.siteComponents).mockResolvedValue({
      componentAuthority: 'portal', components: [row],
    });
    vi.spyOn(api, 'componentVersions').mockResolvedValue([]);
    vi.spyOn(api, 'componentTemplates').mockResolvedValue([{
      templateRef: row.templateRef, kind: 'builtin', version: 1,
      brand: 'fronius', brandLabel: 'Fronius', model: 'eco-27', modelLabel: 'Eco 27.0-3-S',
      communication: 'fronius_sunspec', communicationLabel: 'SunSpec Modbus TCP',
      transportSchema: [
        { key: 'ip', label: 'IP-Adresse', required: true },
        { key: 'port', label: 'Port', type: 'number', default: 502 },
        { key: 'unit_id', label: 'Modbus-Adresse', type: 'number', default: 1 },
      ],
    }]);
    window.history.replaceState(
      null,
      '',
      '#/anlage/s-1/geraet/edge-45gz7da/src-7c1e9a2b?bearbeiten=1&komponente=entfernt',
    );

    render(
      <GeraetSeiteSection
        site={site}
        boxRef="edge-45gz7da"
        geraetId="src-7c1e9a2b"
        devices={[box]}
      />,
    );

    await waitFor(() => expect(screen.getAllByRole('alert').some((alert) =>
      alert.textContent?.includes('Diese Komponente ist an diesem Gerät nicht mehr verfügbar.'),
    )).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    expect(await screen.findByTestId('geraet-bearbeiten')).toBeVisible();
    expect(screen.queryByText('Diese Komponente ist an diesem Gerät nicht mehr verfügbar.')).toBeNull();
  });

  it('ändert auch an einer real komponierten OCPP-Wallbox den gemeinsamen Anzeigenamen', async () => {
    let alias = 'Garage';
    let resolveRename!: () => void;
    const renamePending = new Promise<void>((resolve) => {
      resolveRename = resolve;
    });
    let resolveChargers!: (value: Awaited<ReturnType<typeof api.siteChargers>>) => void;
    const chargers = new Promise<Awaited<ReturnType<typeof api.siteChargers>>>((resolve) => {
      resolveChargers = resolve;
    });
    stub({
      entities: () => Promise.resolve({
        ...entities,
        entities: [
          ...entities.entities,
          {
            id: 'wallbox-1', entityType: 'ev-charger', typeLabel: 'Ladepunkt',
            role: 'consumer', label: alias, control: true, deviceId: null,
            capabilities: { measure: [{ channel: 'power_kw' }] }, guards: null,
            syncStatus: 'in_sync', observed: null, edgeSourceId: null,
          },
        ],
      }),
    });
    const charging: Awaited<ReturnType<typeof api.siteChargers>> = {
      budget: null,
      chargers: [{
        deviceId: 'gw', chargePointId: 'CP-1', label: alias, priority: false,
        connected: true, ready: true, lastSeen: FRISCH, connectors: [{
          connectorId: 1, status: 'Available', charging: false, powerKw: 0,
        }], entityId: 'wallbox-1',
      }],
    };
    vi.mocked(api.siteChargers)
      .mockImplementationOnce(() => chargers)
      .mockImplementation(async () => ({
        ...charging,
        chargers: charging.chargers.map((charger) => ({ ...charger, label: alias })),
      }));
    // Reale OCPP-Komponenten haben bewusst KEINE Portal-Treiberdefinition:
    // kein templateRef, keine connection_json, trotzdem einen Alias.
    vi.mocked(api.siteComponents).mockResolvedValue({
      componentAuthority: 'portal',
      components: [],
    });
    vi.spyOn(entitiesApi, 'rename').mockImplementation(async (_siteId, _entityId, next) => {
      await renamePending;
      alias = next ?? '';
      return {} as never;
    });
    vi.spyOn(api, 'ocppStations').mockResolvedValue([{ deviceId: 'gw', chargePointId: 'CP-1', connected: true,
      connectedAt: FRISCH, disconnectedAt: null, lastSeen: FRISCH, bootedAt: FRISCH,
      chargeBoxSerialNumber: null, chargePointModel: 'P30', chargePointSerialNumber: 'serial-1',
      chargePointVendor: 'KEBA', firmwareVersion: '1.9.4', iccid: null, imsi: null,
      meterSerialNumber: null, meterType: null, diagnosticsStatus: null, diagnosticsStatusAt: null,
      firmwareStatus: null, firmwareStatusAt: null, supportedFeatureProfiles: [],
      connectors: [{ connectorId: 1, status: 'Available', errorCode: 'NoError', info: null,
        vendorId: null, vendorErrorCode: null, stationTimestamp: FRISCH, reportedAt: FRISCH }],
    }]);
    vi.spyOn(api, 'ocppEvents').mockResolvedValue([]);
    vi.spyOn(api, 'ocppGaps').mockResolvedValue([]);
    vi.spyOn(api, 'ocppTransactions').mockResolvedValue([]);
    vi.spyOn(api, 'ocppMeterValues').mockResolvedValue([]);
    vi.spyOn(api, 'ocppConfiguration').mockResolvedValue([]);
    vi.spyOn(api, 'ocppActionPermissions').mockResolvedValue({ actions: {} });
    vi.spyOn(api, 'ocppActions').mockResolvedValue([]);

    window.history.replaceState(
      null,
      '',
      '#/anlage/s-1/geraet/edge-45gz7da/cp-CP-1?bearbeiten=1&komponente=wallbox-1',
    );
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="cp-CP-1" devices={[box]} />);
    await waitFor(() => expect(api.siteEntities).toHaveBeenCalledWith('s-1'));
    expect(window.location.hash).toContain('bearbeiten=1');
    expect(screen.queryByTestId('geraet-bearbeiten')).toBeNull();
    await act(async () => {
      resolveChargers(charging);
      await chargers;
    });
    expect(await screen.findByTestId('geraet-bearbeiten')).toBeVisible();
    expect(window.location.hash).toBe('#/anlage/s-1/geraet/edge-45gz7da/cp-CP-1');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.vp-modal')).toBeNull();
    expect(screen.queryByTestId('ocpp-rahmen')).toBeNull();
    fireEvent.change(screen.getByLabelText('Anzeigename'), { target: { value: 'Carport' } });
    const editorHref = window.location.href;
    let blocked = false;
    act(() => {
      window.history.pushState(null, '', '#/anlage/s-1/modell');
      blocked = requestNavigation(window.location.href, true);
    });
    expect(blocked).toBe(true);
    await waitFor(() => expect(window.location.href).toBe(editorHref));
    const discard = await screen.findByRole('dialog', { name: 'Änderung verwerfen?' });
    fireEvent.click(within(discard).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.getByLabelText('Anzeigename')).toHaveValue('Carport');
    fireEvent.click(screen.getByRole('button', { name: 'Änderungen speichern' }));

    await waitFor(() => expect(entitiesApi.rename).toHaveBeenCalledWith(
      's-1', 'wallbox-1', 'Carport',
    ));
    expect(screen.getByLabelText('Anzeigename')).toBeDisabled();
    const savingHref = window.location.href;
    act(() => {
      window.history.pushState(null, '', '#/anlage/s-1/modell');
      blocked = requestNavigation(window.location.href, true);
    });
    expect(blocked).toBe(true);
    await waitFor(() => expect(window.location.href).toBe(savingHref));
    expect(screen.queryByRole('dialog', { name: 'Änderung verwerfen?' })).toBeNull();
    await act(async () => {
      resolveRename();
      await renamePending;
    });
    expect(await screen.findByText(/Anzeigename gespeichert/)).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Carport' })).toBeVisible();
  });

  it('zeigt die Befehle DIESES Geräts und führt auf die volle Liste', async () => {
    // Der Wechselrichter trägt seit der Ziel-Attribution seinen Speicher-Strom
    // (`deviceIsBox: false`) - die Seite fragt den Server mit SEINER Kennung.
    stub({ commands: commands({ deviceIsBox: false, deviceRef: 'inverter' }) });
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);

    const aktivitaet = await screen.findByTestId('baustein-aktivitaet');
    // Der Server entscheidet, was zu diesem Gerät gehört - die Fläche fragt ihn
    // mit der Adresse, unter der die Seite geöffnet wurde.
    expect(api.commandHistory).toHaveBeenCalledWith('s-1', expect.objectContaining({
      device: 'inverter',
      limit: SEITE,
    }));
    const alle = within(aktivitaet).getByRole('link', { name: /Alle/ });
    expect(alle.getAttribute('href')).toBe('#/anlage/s-1/befehle?geraet=inverter');
    // KEINE Filter - weder auf der Seite noch als Zustand im Link (D4a).
    expect(screen.queryByRole('button', { name: 'Nur Abweichungen' })).not.toBeInTheDocument();
    expect(alle.getAttribute('href')).not.toContain('ergebnis=');
    // Und die Grenze wird ERKLÄRT - hinter dem ⓘ der Karte (V8): die
    // anlagenweiten Befehle gehören der Box.
    fireEvent.click(within(aktivitaet).getByRole('button', { name: /Hinweise zu „Aktivität"/ }));
    expect(screen.getByText(/Anlagenweite Befehle/)).toBeInTheDocument();
  });

  /**
   * Die AKTIONSZEILE (Stufe 2 §6.2): sie steht OBEN und LÖST nur aus - geöffnet
   * wird der BESTEHENDE Dialog, es entsteht kein zweiter Auslöse-Pfad.
   */
  it('bietet am HYBRID die Speicher-Handlungen und öffnet ihre Folgen-Karte', async () => {
    // Steuerbar heisst: das Rücklesen DIESES Geräts trägt wirklich.
    stub({ commands: commands({ deviceIsBox: false, deviceRef: 'inverter' }) });
    // Steuerbar heisst: das Rücklesen DIESES Geräts trägt wirklich - genau die
    // Bedingung, mit der auch die Jetzt-Zone der Steuerung urteilt.
    vi.spyOn(api, 'controlStatus').mockResolvedValue({
      deviceId: 'gw',
      commandedKw: -6.5,
      confirmedKw: -6.5,
      allMatch: true,
      controlEnabled: true,
      certified: true,
      mismatchRoles: null,
      slotStart: null,
      checkedAt: FRISCH,
    } as never);
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);

    // K1: EIN Schalter mit dem echten Zustand - „Automatik" gilt gerade.
    const steuerung = await screen.findByTestId('geraet-steuerung');
    expect(within(steuerung).getByRole('radio', { name: /Automatik/ })).toHaveAttribute('aria-checked', 'true');
    const setzen = vi.spyOn(api, 'startBatteryOverride');
    fireEvent.click(within(steuerung).getByRole('radio', { name: /Laden/ }));

    // Es ist die BESTEHENDE Folgen-Karte - und der Tipp allein schreibt
    // NICHTS: erst ihr Ja setzt den Eingriff ab.
    expect(await screen.findByText(/Das passiert/)).toBeInTheDocument();
    expect(setzen).not.toHaveBeenCalled();
  });

  it('bietet an einem PV-Melder nur den Register-Weg', async () => {
    stub({ commands: commands({ deviceIsBox: false, deviceRef: 'src-7c1e9a2b' }) });
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-7c1e9a2b" devices={[box]} />,
    );

    await screen.findByTestId('geraet-held');
    // Ein PV-Melder hat keinen Schalter - was der Zustand nicht hergibt, wird
    // nicht angeboten.
    expect(screen.queryByTestId('geraet-steuerung')).toBeNull();
    // Der Register-Weg wohnt in Technik › Register (E1 a) - derselbe Drawer.
    const register = await technikTeil('register');
    expect(within(register).getByTestId('geraet-regwrite')).toBeInTheDocument();
  });

  it('bietet GAR KEINE Zeile an, wo es nichts abzusetzen gibt', async () => {
    // Ohne belegten Schreibweg (leere Ziel-Liste) und ohne Speicher-Handlung
    // bleibt die Zeile weg - nie ein Knopf ins Leere.
    vi.spyOn(api, 'controlStatus').mockResolvedValue(null);
    stub({
      commands: commands({ deviceIsBox: false, deviceRef: 'src-7c1e9a2b' }),
      targets: [],
    });
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-7c1e9a2b" devices={[box]} />,
    );

    expect(await screen.findByTestId('baustein-aktivitaet')).toBeInTheDocument();
    // Ohne Handlung KEIN Schalter - nie ein Knopf ins Leere.
    expect(screen.queryByTestId('geraet-steuerung')).not.toBeInTheDocument();
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
    const aktivitaet = await screen.findByTestId('baustein-aktivitaet');
    // Ohne Zeile steht der GRUND da, nie ein leerer Kasten.
    expect(await within(aktivitaet).findByText(/kein Befehl geschickt/)).toBeInTheDocument();
    fireEvent.click(within(aktivitaet).getByRole('button', { name: /Hinweise zu „Aktivität"/ }));
    expect(screen.getByText(/Anlagenweite Befehle/)).toBeInTheDocument();
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
    // Der Baustein bleibt - ein Ausfall wird BENANNT, nie als leerer Verlauf
    // ausgegeben (das wäre die entlastende Aussage, die niemand geprüft hat).
    expect(await screen.findByTestId('baustein-aktivitaet')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Verlauf nicht abrufbar/)).toBeInTheDocument(),
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

    const register = await technikTeil('register');
    fireEvent.click(await within(register).findByTestId('geraet-regwrite'));
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

      const register = await technikTeil('register');
      fireEvent.click(await within(register).findByTestId('geraet-regwrite'));
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
    const register = await technikTeil('register');
    expect(await within(register).findByTestId('geraet-regwrite-grund')).toBeInTheDocument();
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

    // Lesen und Schreiben sind EIN Teil „Register" - in Technik & Diagnose (E1 a).
    expect(await technikTeil('register')).toBeInTheDocument();
    // Das Rohwort des Schreibvorgangs - das einzige, das es heute gibt.
    await waitFor(() => expect(screen.getByText('Rohwert 7000')).toBeInTheDocument());
    // Die Warnklasse trägt ihr WORT, nie nur eine Farbe.
    expect(screen.getByText('Netz-Anmeldung')).toBeInTheDocument();
  });

});

// ---------------------------------------------------------------------------
// PR 1f: die PLATTFORM-Sicht auf DERSELBEN Seite (M7-Rollen-Tor)
// ---------------------------------------------------------------------------

describe('GeraetSeiteSection · Plattform-Sicht', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Die Technik-Ansicht ist eine ADRESSE - sie bliebe sonst offen.
    window.location.hash = '';
  });

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
    await screen.findByRole('heading', { level: 1 });
    // Sie ist der LETZTE Teil von „Technik & Diagnose" - nie ein Kasten auf der
    // Kunden-Seite.
    await waitFor(() => expect(screen.getByTestId('geraet-technik-oeffnen')).toHaveTextContent(/Plattform-Sicht/));
    const teil = await technikTeil('plattform');
    expect(within(teil).getByText('Plattform-Sicht (Admin)')).toBeTruthy();
    expect(within(teil).getByTestId('geraet-admin')).toBeTruthy();
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

/**
 * Geraeteseiten Stufe 0, Teil (b) - der gemeldete Messbibliothek-Fehler
 * (Konzept `vp-geraeteseite-rahmen-r2` Paragraph 2.3/7.1, Captain-Entscheid D5a).
 *
 * Die Bibliothek fragte mit der Geraete-UUID der BOX nach "welche Punkte kann
 * die Box lesen" - und das ist server-seitig die Familien-VEREINIGUNG aller
 * komponierten Punkte dieser Box, praktisch also die Familie des primaeren
 * Wechselrichters. Auf JEDER Geraeteseite. Seit Stufe 0 schneidet `?family=`
 * auf das Geraet, dessen Seite die Bibliothek traegt.
 */
describe('Stufe 0 · die Messbibliothek zeigt den Katalog DIESES Geraets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  /** Die `?family=`-Werte des paginierten Bibliotheks-Abrufs. */
  function gefragteFamilien(): string[] {
    const call = vi.mocked(api.measurementCatalog).mock.calls
      .find((candidate) => candidate[1].get('selectedOnly') == null);
    return call ? call[1].getAll('family') : [];
  }

  it('Wallbox sieht keine Wechselrichter-Register', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-goe" devices={[box]} />);
    await technikTeil('register');
    await screen.findByRole('heading', { name: 'Beobachtete Messwerte' });
    fireEvent.click(screen.getByRole('button', { name: /Messwert beobachten/ }));
    await waitFor(() => expect(gefragteFamilien().length).toBeGreaterThan(0));
    expect(gefragteFamilien()).toEqual(['goe.api_v2']);
    // Genau der gemeldete Fehler: die Familie des Deye taucht nicht mehr auf,
    // und die Box-Frage wird gar nicht mehr gestellt.
    expect(gefragteFamilien()).not.toContain('hybrid_3p');
    for (const call of vi.mocked(api.measurementCatalog).mock.calls) {
      expect(call[1].get('availableOnly')).toBeNull();
    }
  });

  it('ein zweiter Wechselrichter sieht NUR seine eigene Familie', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-7c1e9a2b" devices={[box]} />);
    await technikTeil('register');
    await screen.findByRole('heading', { name: 'Beobachtete Register' });
    fireEvent.click(screen.getByRole('button', { name: /Register beobachten/ }));
    await waitFor(() => expect(gefragteFamilien().length).toBeGreaterThan(0));
    const familien = gefragteFamilien();
    expect(familien).not.toContain('hybrid_3p');
    expect(familien.length).toBeGreaterThan(0);
    expect(familien.every((f) => f.startsWith('sunspec.model_'))).toBe(true);
  });

  it('nennt die ehrliche Grenze: die Box liest heute nur ueber den primaeren Wechselrichter', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-7c1e9a2b" devices={[box]} />);
    await technikTeil('register');
    const hinweis = await screen.findByTestId('measure-beobachten-hinweis');
    expect(hinweis.textContent).toMatch(/primären Wechselrichter/);
  });

  it('haelt auf dem primaeren Wechselrichter beide Zusagen: eigener Katalog, kein Hinweis', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    await technikTeil('register');
    await screen.findByRole('heading', { name: 'Beobachtete Register' });
    fireEvent.click(screen.getByRole('button', { name: /Register beobachten/ }));
    await waitFor(() => expect(gefragteFamilien().length).toBeGreaterThan(0));
    expect(gefragteFamilien()).toEqual(['hybrid_3p']);
    expect(screen.queryByTestId('measure-beobachten-hinweis')).toBeNull();
  });

  it('Geraet ohne Katalog-Familie: KEINE Messbibliothek, kein leerer Kasten', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-eigen" devices={[box]} />);
    // Die Seite selbst steht (der Beweis ist nicht vakuum) ...
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(api.siteSources).toHaveBeenCalled());
    // ... nur die Bibliothek entfaellt, und sie fragt auch nichts ab.
    expect(screen.queryByRole('heading', { name: 'Beobachtete Register' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Beobachtete Messwerte' })).toBeNull();
    expect(api.measurementCatalog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Der KERN (Konzept „Geräteseiten: Ein Blick, eine Antwort")
// ---------------------------------------------------------------------------

describe('GeraetSeiteSection · Kern', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('ordnet die Bausteine KANONISCH - fehlende fallen still weg (S5)', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    const rahmen = await screen.findByTestId('geraet-rahmen');
    await screen.findByTestId('baustein-aktivitaet');

    const ids = Array.from(rahmen.querySelectorAll('[data-baustein]'))
      .map((el) => el.getAttribute('data-baustein') as BausteinId);
    // Am steuerbaren Hybrid stehen alle fünf Bausteine - jeder GENAU einmal.
    // (Die Reihenfolge am Telefon setzt das CSS über `order`, am Rechner die
    // zwei Spalten; im DOM stehen sie spaltenweise.)
    expect([...ids].sort()).toEqual([...BAUSTEIN_ORDNUNG].sort());
    expect(ids[0]).toBe('buehne');
    expect(ids[ids.length - 1]).toBe('details');
    for (const id of ids) {
      expect(rahmen.querySelector(`[data-baustein="${id}"]`)?.className).toMatch(new RegExp(`is-${id}`));
    }
    // „Gerät & Verbindung" ist am Rechner offen - und es gibt keine
    // Sprungleiste mehr (S4).
    expect(screen.getByTestId('baustein-details')).toHaveAttribute('open');
    expect(screen.queryByRole('navigation', { name: /Abschnitte/ })).toBeNull();
  });

  it('öffnet „Technik & Diagnose" als eigene ADRESSE und kehrt zurück', async () => {
    window.location.hash = '#/anlage/s-1/geraet/edge-45gz7da/inverter';
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    await screen.findByTestId('geraet-held');

    const technik = await technikOeffnen();
    // Ein Parameter im Hash, nie eine zweite Raute (der HashRouter läse sie als Route).
    expect(window.location.hash).toBe('#/anlage/s-1/geraet/edge-45gz7da/inverter?ansicht=technik');
    expect(within(technik).getAllByRole('heading', { level: 2 }).map((h) => h.textContent))
      .toContain('Rohdaten');
    // Die Bühne steht in der Technik-Ansicht nicht.
    expect(screen.queryByTestId('geraet-held')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Deye SUN-30K/ }));
    await screen.findByTestId('geraet-held');
    expect(window.location.hash).not.toContain('ansicht=technik');
  });

  it('führt ein altes Lesezeichen `?abschnitt=register` in Technik › Register', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    window.location.hash = '#/anlage/s-1/geraet/edge-45gz7da/inverter?abschnitt=register';
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    const technik = await screen.findByTestId('geraet-technik');
    const register = technik.querySelector('[data-technik="register"]') as HTMLElement;
    expect(register).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(register));
  });

  it('springt über `?abschnitt=` zu einem Baustein - ohne einen zweiten `#anker`', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    window.location.hash = '#/anlage/s-1/geraet/edge-45gz7da/inverter?abschnitt=aktivitaet';
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    const aktivitaet = await screen.findByTestId('baustein-aktivitaet');
    await waitFor(() => expect(document.activeElement).toBe(aktivitaet));
    expect(window.location.hash).toBe('#/anlage/s-1/geraet/edge-45gz7da/inverter?abschnitt=aktivitaet');
  });
});

// ---------------------------------------------------------------------------
// Geräteseiten Stufe 3a: „Beobachtete Register" (Konzept §7.2/§7.4)
// ---------------------------------------------------------------------------

describe('Stufe 3a · die Messbibliothek, richtig herum', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  it('trägt am Wechselrichter alle DREI Teile - beobachtet, hinzufügen, lesen/schreiben', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    const sektion = await technikTeil('register');

    // 1 · die Beobachtungen führen (situativ leer: die Sektion BLEIBT und sagt,
    //     wie man sie füllt).
    expect(await within(sektion).findByRole('heading', { name: 'Beobachtete Register' })).toBeTruthy();
    expect(await within(sektion).findByText(/Noch kein Register beobachtet/)).toBeTruthy();
    // 2 · der Katalog DIESES Geräts.
    expect(within(sektion).getByRole('button', { name: /Register beobachten/ })).toBeTruthy();
    // 3 · bekannte Werte und Fachwerkzeuge sind klar getrennt, aber am selben Ort.
    expect(within(sektion).getByRole('heading', { name: 'Zuletzt bekannte Werte' })).toBeTruthy();
    expect(within(sektion).getByRole('heading', { name: 'Register direkt prüfen' })).toBeTruthy();
    expect(within(sektion).getByTestId('geraet-regread')).toBeTruthy();
    expect(within(sektion).getByLabelText('Adresse des Registers, das jetzt gelesen wird')).toBeTruthy();
  });

  it('die Wallbox trägt nur die zwei Beobachtungs-Teile - kein Lesen, kein Schreiben', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-goe" devices={[box]} />);
    const sektion = await technikTeil('register');

    // D3a: dieselbe Liste, das andere Wort - die Fähigkeit ist dieselbe.
    expect(await within(sektion).findByRole('heading', { name: 'Beobachtete Messwerte' })).toBeTruthy();
    expect(within(sektion).getByRole('button', { name: /Messwert beobachten/ })).toBeTruthy();
    // Ein HTTP-Gerät hat keine Register: der Teil entfällt, statt leer dazustehen.
    expect(within(sektion).queryByTestId('geraet-regread')).toBeNull();
    expect(within(sektion).queryByText('Register jetzt lesen')).toBeNull();
  });

  it('die BRÜCKE: aus einer Lesung wird eine Beobachtung - vorbefüllt, nicht gespeichert', async () => {
    stub();
    vi.spyOn(api, 'registerWritePreview').mockResolvedValue({
      requestId: 'r-1', mode: 'lesen', ok: true, outcome: 'gelesen',
      beforeRaw: 3000, afterRaw: null, beforeScaled: 30, afterScaled: null,
      adopted: null, errorCode: null, message: null, targetLabel: null,
      address: 231, addressHex: '0x00E7', registerLabel: 'Einspeisegrenze',
      registerClass: 'netz_compliance', scaleNote: null, scaleUnit: 'kW',
      noteRequired: true, confirm: null,
    } as never);
    vi.spyOn(api, 'customMeasurementEstimate').mockResolvedValue({
      enabledPointCount: 1, samplesPerMinute: 2, requestsPerMinute: 2, dutyCyclePercent: 1,
      softWarning: false, hardRejected: false, reasons: [], rawGbPerYear: 0.1,
      longTermGbPerYear: 0, totalGbPerYear: 0.1, retentionSummary: '90 Tage roh',
    });
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    await technikTeil('register');

    fireEvent.change(screen.getByLabelText('Adresse des Registers, das jetzt gelesen wird'), {
      target: { value: '0x00E7' },
    });
    fireEvent.click(screen.getByTestId('geraet-regread'));
    // Die gelesene Zeile bietet die Brücke an ...
    const bruecke = await screen.findByTestId('beob-bruecke-abruf:0x00e7');
    fireEvent.click(bruecke);

    // ... und das Formular steht VORBEFÜLLT offen.
    const dialog = await screen.findByRole('dialog', { name: 'Eigenen Messwert hinzufügen' });
    expect(within(dialog).getByLabelText('Bezeichnung')).toHaveValue('Einspeisegrenze');
    expect(within(dialog).getByLabelText('Registeradresse (dezimal)')).toHaveValue(231);
    expect(within(dialog).getByLabelText('Einheit')).toHaveValue('kW');
    // Bis hierher ist NICHTS angelegt - erst der Klick im Formular schreibt.
    expect(api.customMeasurementEstimate).not.toHaveBeenCalled();
  });

  it('ein Lese-Timeout behauptet nie, dass vielleicht geschrieben wurde', async () => {
    stub();
    vi.spyOn(api, 'registerWritePreview').mockResolvedValue({
      requestId: 'r-timeout', mode: 'lesen', ok: false, outcome: 'fehler',
      beforeRaw: null, afterRaw: null, beforeScaled: null, afterScaled: null,
      adopted: null, errorCode: 'timeout',
      message: 'Es ist nicht sicher, ob geschrieben wurde.', targetLabel: null,
      address: 231, addressHex: '0x00E7', registerLabel: null,
      registerClass: null, scaleNote: null, scaleUnit: null,
      noteRequired: false, confirm: null,
    } as never);
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />);
    await technikTeil('register');

    fireEvent.change(screen.getByLabelText('Adresse des Registers, das jetzt gelesen wird'), {
      target: { value: '0x00E7' },
    });
    fireEvent.click(screen.getByTestId('geraet-regread'));

    const fehler = await screen.findByRole('alert');
    expect(fehler).toHaveTextContent('Es wurde nichts geschrieben');
    expect(fehler).not.toHaveTextContent('nicht sicher');
  });

  it('trägt die KOMPONENTE dieser Seite in jeden Auswahl-Aufruf', async () => {
    stub();
    // Erst eine Komponente MIT Vorlage ist die bearbeitbare Zeile dieser Seite -
    // und nur sie schneidet die Auswahl (`editRow`).
    vi.spyOn(api, 'siteComponents').mockResolvedValue({
      componentAuthority: 'portal',
      components: [{
        id: 'fr1',
        communication: 'fronius_sunspec',
        connection: { ip: '192.168.254.30', port: 502, unit_id: 1, interval_s: 5 },
        definitionVersion: 3,
        edgeSourceId: 'src-7c1e9a2b',
        templateRef: 'builtin:fronius:eco-27',
      }],
    } as never);
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-7c1e9a2b" devices={[box]} />);
    await technikTeil('register');
    await screen.findByRole('heading', { name: 'Beobachtete Register' });
    await waitFor(() => expect(api.measurementCatalog).toHaveBeenCalled());

    // Der TRANSPORT bleibt die Box, die AUSWAHL gehört der Komponente (Stufe 3b).
    expect(api.measurementSelection).toHaveBeenCalledWith('gw', 'fr1');
    expect(vi.mocked(api.measurementCatalog).mock.calls[0][1].get('entityId')).toBe('fr1');
  });
});

/**
 * Geräteseiten Stufe 4 - DIE NEUN BLÄTTER am gerenderten DOM.
 *
 * `geraetGesicht.test.ts` prüft die AUSWAHL (welche Sektion, welche Kachel);
 * hier steht, dass sie auch ankommt: die angesprungene Kachel, die primäre
 * Handlung des Verbraucher-Blatts und der Grund einer entfallenen Sektion in
 * der Diagnose (§4.6).
 */
describe('Stufe 4 · die Blätter am DOM', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  it('§5.3 · markiert die Speicher-Kachel, wenn sie angesprungen wurde', async () => {
    stub();
    window.location.hash = '#/anlage/s-1/geraet/edge-45gz7da/inverter'
      + '?abschnitt=jetzt&kachel=speicher';
    const { container } = render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
    );
    await screen.findByTestId('geraet-held');
    await waitFor(() => {
      const k = container.querySelector('[data-kachel="speicher"]');
      expect(k).not.toBeNull();
      expect(k?.className).toMatch(/is-markiert/);
    });
    // ⚠ Nur DIE eine - eine Markierung an jeder Kachel (oder an der ganzen
    // Bühne) wäre keine.
    expect(container.querySelectorAll('.is-markiert')).toHaveLength(1);
  });

  it('⚠ ohne den Parameter wird NICHTS markiert', async () => {
    stub();
    const { container } = render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
    );
    await screen.findByTestId('geraet-held');
    expect(container.querySelector('[data-kachel="speicher"]')).not.toBeNull();
    expect(container.querySelectorAll('.is-markiert')).toHaveLength(0);
  });

  it('§5.4 · das Verbraucher-Blatt trägt seine Sofortaktion im JETZT', async () => {
    const verbraucher: Consumer = {
      id: 'wb',
      siteId: 's-1',
      label: 'Wallbox',
      type: 'wallbox',
      connection: 'connected',
      controlKind: 'continuous',
      ratedPowerKw: 11,
      enabled: true,
      version: 1,
      controlActivation: 'active',
      confirmationChannel: 'power_kw',
    } as unknown as Consumer;
    stub({ consumers: [verbraucher] });
    vi.spyOn(api, 'siteEntities').mockResolvedValue({
      registry: null,
      entities: [{
        id: 'wb',
        entityType: 'wallbox',
        typeLabel: 'Wallbox',
        role: 'consumer',
        label: 'Wallbox',
        control: true,
        deviceId: 'gw',
        edgeSourceId: 'src-goe',
        capabilities: { measure: ['power_kw'], actuate: ['setpoint_kw'], failsafe: 'release' },
        guardConfig: null,
        health: 'ok',
        lastTelemetryAt: FRISCH,
        syncStatus: 'in_sync',
        staleOnDevice: false,
        capacityKwp: null,
      }] as never,
      localSetup: [{
        id: 'src-goe', kind: 'source', label: 'go-e Charger', role: 'consumer',
        brand: 'goe', communication: 'goe_http_api', family: null, adoptedEntityId: 'wb',
      }] as never,
    } as unknown as SiteEntities);
    vi.spyOn(api, 'siteSources').mockResolvedValue([
      {
        deviceId: 'gw', sourceId: 'src-goe', kind: 'source', role: 'consumer',
        label: 'go-e Charger', brand: 'goe', model: null,
        pvKw: null, powerKw: null, loadKw: 7.4,
        health: 'ok', readAt: FRISCH, reportedAt: FRISCH,
      },
    ] as unknown as SiteSource[]);
    vi.spyOn(consumersApi, 'fulfillment').mockResolvedValue({
      tasks: [{ state: 'running', atRisk: false }],
    } as never);

    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-goe" devices={[box]} />,
    );
    const held = await screen.findByTestId('geraet-held');
    // K1: die Handlung ist der Schalter der Steuerung - „Ein" als Segment, nie
    // ein „Jetzt starten" neben einem Zustand, der ihm widersprechen kann.
    const steuerung = await screen.findByTestId('geraet-steuerung');
    expect(within(steuerung).getByRole('radio', { name: /Ein/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Jetzt starten/i })).toBeNull();
    // Und die ZEILEN der Bühne tragen die geteilte D3-Aussage - „gemessen"
    // wird nur gesagt, wo `consumerHasMeasurement` es belegt.
    const zeilen = held.querySelector('.vp-buehne-zeilen');
    expect(zeilen?.textContent).toMatch(/gemessen/i);
  });

  it('⚠ §5.6 · der Zähler hat keinen Befehls-Baustein - „nur Messung" sagt der Kopf', async () => {
    stub();
    vi.spyOn(api, 'siteEntities').mockResolvedValue({
      registry: null,
      entities: [{
        id: 'meter',
        entityType: 'grid-meter',
        typeLabel: 'Netz-Zähler',
        role: 'grid',
        label: 'Netzanschluss',
        control: false,
        deviceId: 'gw',
        edgeSourceId: 'src-meter',
        capabilities: { measure: ['power_kw'], actuate: [], failsafe: 'measure-only' },
        guardConfig: null,
        health: 'ok',
        lastTelemetryAt: FRISCH,
        syncStatus: 'in_sync',
        staleOnDevice: false,
        capacityKwp: null,
      }] as never,
      localSetup: [{
        id: 'src-meter', kind: 'source', label: 'Zähler', role: 'grid-meter',
        brand: null, communication: 'modbus_tcp', family: null, adoptedEntityId: 'meter',
      }] as never,
    } as unknown as SiteEntities);
    vi.spyOn(api, 'siteSources').mockResolvedValue([
      {
        deviceId: 'gw', sourceId: 'src-meter', kind: 'source', role: 'grid-meter',
        label: 'Zähler', brand: null, model: null,
        pvKw: null, powerKw: -3.4, loadKw: null,
        health: 'ok', readAt: FRISCH, reportedAt: FRISCH,
      },
    ] as unknown as SiteSource[]);

    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-meter" devices={[box]} />,
    );
    await screen.findByTestId('geraet-held');
    // S5: kein Kasten, der erklärt, dass er leer ist - der Baustein fehlt, und
    // das Abzeichen im Kopf sagt, warum.
    await waitFor(() => expect(screen.queryByTestId('baustein-aktivitaet')).toBeNull());
    expect(within(screen.getByTestId('geraet-kopf')).getByText(/nur Messung/)).toHaveAttribute('title', NUR_LESEN);
  });
});

/**
 * K4 · ein I/O-Modul und ein Verbraucher an seinem Relais-Ausgang. Das Modul
 * zeigt seinen Klemmenplan, der Verbraucher bekommt seine EIGENE Seite - und
 * seine Befehle fragt die Seite über seine Komponente, nie über ein `io-…`,
 * das der Server nicht kennt.
 */
describe('K4 · I/O-Modul und Verbraucher am Ausgang', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  const modulEntities: SiteEntities = {
    ...entities,
    entities: [
      ...entities.entities,
      {
        id: 'modul', entityType: 'io-module', typeLabel: 'I/O-Modul', role: 'consumer',
        label: 'I/O-Modul Keller', control: false, deviceId: 'gw',
        capabilities: { measure: [] }, guards: null, syncStatus: 'in_sync', observed: null,
        edgeSourceId: 'src-ebyte',
      },
      {
        id: 'heiz', entityType: 'heating-rod', typeLabel: 'Heizstab', role: 'consumer',
        label: 'Heizstab Keller', control: true, deviceId: 'gw',
        capabilities: { measure: [], actuate: [{ command: 'on_off' }] }, guards: null,
        syncStatus: 'in_sync', observed: null, edgeSourceId: null,
      },
    ],
    localSetup: [
      ...entities.localSetup,
      {
        id: 'src-ebyte', kind: 'source', role: 'consumer', brand: 'ebyte', model: 'M31-AXAX8080G',
        communication: 'ebyte_modbus_tcp', family: 'ebyte-m31', label: 'I/O-Modul Keller',
        reportedAt: FRISCH, adoptedEntityId: 'modul',
      },
    ],
  };
  const heizstab = {
    id: 'heiz', type: 'heating-rod', name: 'Heizstab Keller', controlKind: 'on_off', ratedPowerKw: 6,
    enabled: true, version: 1, connection: 'connected', edgeSourceId: null,
    ioEntityId: 'modul', ioChannel: 1, controlActivation: 'active', confirmationChannel: 'relay_state',
  } as unknown as Consumer;

  function stubK4() {
    stub({
      entities: () => Promise.resolve(modulEntities),
      consumers: [heizstab],
      sources: [...sources, {
        ...sources[1], sourceId: 'src-ebyte', role: 'consumer', brand: 'ebyte', model: 'M31-AXAX8080G', pvKw: null,
      }],
    });
    vi.mocked(api.siteComponents).mockResolvedValue({
      componentAuthority: 'portal',
      components: [{
        id: 'modul', role: 'io-module', entityType: 'io-module', label: 'I/O-Modul Keller',
        communication: 'ebyte_modbus_tcp', connection: { ip: '192.168.254.40', port: 502, interval_s: 5 },
        definitionVersion: 1, edgeSourceId: 'src-ebyte', syncStatus: 'in_sync',
      }],
    } as never);
    vi.spyOn(consumersApi, 'ioModulZustand').mockResolvedValue({
      entityId: 'modul', label: 'I/O-Modul Keller', receivedAt: FRISCH,
      outputs: [1, 2, 3, 4].map((channel) => ({
        channel, on: channel === 1, consumerId: channel === 1 ? 'heiz' : null,
        consumerName: channel === 1 ? 'Heizstab Keller' : null,
      })),
      inputs: [1, 2].map((channel) => ({ channel, on: false, consumerId: null, consumerName: null })),
    });
  }

  it('zeigt am Modul den Klemmenplan - der belegte Ausgang führt auf die Seite seines Verbrauchers', async () => {
    stubK4();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-ebyte" devices={[box]} />);
    const plan = await screen.findByTestId('io-klemmenplan');
    // Der Zustand kommt aus der EIGENEN Meldung des Moduls - erst dann stehen die Kacheln.
    await waitFor(() => expect(plan.querySelector('[data-kanal="do1"]')).not.toBeNull());
    const do1 = plan.querySelector('[data-kanal="do1"]') as HTMLElement;
    expect(within(do1).getByRole('link').getAttribute('href'))
      .toBe('#/anlage/s-1/geraet/edge-45gz7da/io-heiz');
    // Ein belegter Ausgang schaltet NICHT selbst - das tut die Seite seines Verbrauchers.
    expect(within(do1).queryByRole('button')).toBeNull();
    // Ein freier Ausgang lässt sich testweise schalten.
    const do2 = plan.querySelector('[data-kanal="do2"]') as HTMLElement;
    expect(within(do2).getByRole('button', { name: /DO2 einschalten/ })).toBeInTheDocument();
    // Die Bühne sagt, WAS läuft - nicht noch einmal, wie viele.
    expect(await screen.findByTestId('geraet-heldsatz')).toHaveTextContent('Eingeschaltet: Heizstab Keller.');
    // Das Modul selbst bekommt keinen Befehl.
    expect(screen.queryByText(/VoltPilot steuert/)).toBeNull();
  });

  it('gibt dem Verbraucher am Ausgang seine eigene Seite - Befehle über seine Komponente', async () => {
    stubK4();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="io-heiz" devices={[box]} />);
    expect(await screen.findByRole('heading', { name: 'Heizstab Keller' })).toBeInTheDocument();
    expect(screen.getByTestId('geraet-typ')).toHaveTextContent('Verbraucher · Ausgang DO1 · I/O-Modul Keller');
    await waitFor(() => expect(api.commandHistory).toHaveBeenCalledWith('s-1', expect.objectContaining({
      entity: 'heiz',
    })));
    for (const call of vi.mocked(api.commandHistory).mock.calls) {
      expect(call[1].device ?? null).not.toBe('io-heiz');
    }
    const aktivitaet = await screen.findByTestId('baustein-aktivitaet');
    expect(within(aktivitaet).getByRole('link', { name: /Alle/ }).getAttribute('href'))
      .toBe('#/anlage/s-1/befehle?komponente=heiz');
  });
});
