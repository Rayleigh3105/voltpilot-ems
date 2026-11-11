/**
 * Zwei Formen für „Geräte an dieser Box" (GE-4, Konzept „Ein Gerät, ein Eintrag"), als Eingabe der EINEN Kette
 * `boxGeraete.aufbauDerAnlage` — dieselbe, die Anlage › Aufbau rechnet:
 *
 * - GORE: Neue Halle (Gore Pleinfeld), Box edge-5mz8bdd, Anlagensteuerung (WAGO PFC200) über DQ-1 Modbus TCP
 *   192.168.4.165:503 Geräte-ID 1, verknüpft über `geraet.data_source_id`; die Box meldet 12 Anfragen/min und
 *   305 Messwerte/min für DQ-1 (Last 51 %).
 * - GATEWAY: Halle Süd, Box Halle, Wechselrichter Dach über DQ-1 (1 : 1), Zählergateway Halle DQ-3 mit vier
 *   Zählern (1 : N), Anschluss ohne Gerät DQ-5 (1 : 0).
 *
 * Alle Zahlen sind Beispiele. Nie ins Produktionsbundle importieren.
 */
import type {
  Device,
  EntityLocalSetup,
  SiteEntity,
  SiteSource,
  SiteTopology,
  UemsDatenquelle,
  UemsGeraet,
} from '../api';
import type { AnlageDaten } from '../boxGeraete';

const ent = (o: Partial<SiteEntity> & Pick<SiteEntity, 'id' | 'entityType'>): SiteEntity =>
  ({
    typeLabel: o.entityType,
    role: o.entityType,
    label: null,
    control: false,
    deviceId: null,
    capabilities: { measure: [] },
    guards: null,
    syncStatus: 'in_sync',
    observed: null,
    edgeSourceId: null,
    ...o,
  }) as unknown as SiteEntity;

const lebendig = (ids: readonly string[]): SiteTopology =>
  ({
    schemaVersion: '1.0',
    entities: ids.map((id) => ({ id, entityType: 'x', typeLabel: 'x', label: null, category: 'meter', health: 'ok', capabilities: [] })),
    topology: { schema_version: '1.0', nodes: [] },
  }) as unknown as SiteTopology;

/** Eine Rückmeldung der Box zu einem Weg; ohne Zahlen = „nicht gemeldet". */
export const liefert = (jetzt: number, anfragen: number | null, messwerte: number | null): UemsDatenquelle['rueckmeldung'] => ({
  zustand: 'liefert',
  fehlerklasse: null,
  seit: null,
  gelesen_am: new Date(jetzt - 20_000).toISOString(),
  anfragen_pro_minute: anfragen,
  messwerte_pro_minute: messwerte,
  gemeldet_am: new Date(jetzt - 10_000).toISOString(),
  text: 'Liefert Daten',
});

export const dq = (
  o: Partial<UemsDatenquelle> & Pick<UemsDatenquelle, 'id' | 'kennzeichen' | 'anlage'>,
  box: { id: string; name: string | null },
): UemsDatenquelle => ({
  name: null,
  protokoll: 'modbus_tcp',
  adresse: '192.168.10.31:502',
  geraete_ids: [1],
  netz: null,
  mehrere_leser: false,
  steuerquelle: false,
  vergleichsquelle: false,
  kadenz_s: 10,
  archiviert_am: null,
  zustaendige_box: { id: box.id, name: box.name, heimat_anlage: o.anlage },
  zeitraeume: [],
  rueckmeldung: null,
  ...o,
});

/** Ein eingebautes UEMS-Gerät, das die Komponente `entity` speist und auf den Weg `dataSource` zeigt. */
const gr = (id: string, entity: string, dataSource: string | null, o: Partial<UemsGeraet> = {}): UemsGeraet => ({
  id,
  kennzeichen: id.toUpperCase(),
  einbau_kennzeichen: id.toUpperCase(),
  ausgebaut_am: null,
  data_source_id: dataSource,
  komponenten: [{ entity_id: entity, gueltig_ab: '2026-10-01T00:00:00Z', gueltig_bis: null }],
  ...o,
});

// --- Gore: Box + Anlagensteuerung + DQ-1 ---------------------------------------------------------------------------

export const GORE_SITE = { id: 'site-gore', name: 'Neue Halle' } as const;
export const GORE_PIN = 'src-as-192.168.4.165-503-1';

export function goreBox(jetzt: number): Device {
  return {
    id: 'box-gore', siteId: GORE_SITE.id, externalRef: 'edge-5mz8bdd', kind: 'edge', name: null,
    status: 'claimed', lastSeenAt: new Date(jetzt - 5_000).toISOString(), createdAt: '2026-10-01T08:00:00Z',
  };
}

export function goreDq1(jetzt: number, over: Partial<UemsDatenquelle> = {}): UemsDatenquelle {
  return dq({
    id: 'dq-1', kennzeichen: 'DQ-1', anlage: GORE_SITE.id, name: 'Anlagensteuerung', adresse: '192.168.4.165:503',
    kadenz_s: 5, rueckmeldung: liefert(jetzt, 12, 305), ...over,
  }, { id: 'box-gore', name: null });
}

/** Gore wie am 23.10.2026 (vor GE-3): ein Gerät „Anlagensteuerung", gelesen über DQ-1. */
export function goreForm(jetzt: number, over: Partial<AnlageDaten> = {}): AnlageDaten {
  const frisch = new Date(jetzt - 12_000).toISOString();
  const entities = [
    ent({ id: 'e-netz', entityType: 'grid-meter', deviceId: 'box-gore', sourceKind: 'composed' } as never),
    ent({ id: 'e-haus', entityType: 'house-load', deviceId: 'box-gore', sourceKind: 'composed' } as never),
    ent({ id: 'e-as', entityType: 'anlagensteuerung', typeLabel: 'Anlagensteuerung', label: 'Anlagensteuerung', edgeSourceId: GORE_PIN }),
  ];
  const localSetup = [{
    id: GORE_PIN, kind: 'source', role: 'plant-controller', brand: null, model: null, label: 'Anlagensteuerung',
    reportedAt: frisch, adoptedEntityId: null,
  } as EntityLocalSetup];
  return {
    siteId: GORE_SITE.id,
    siteName: GORE_SITE.name,
    entities: { registry: null, entities, localSetup, staleOnDevice: [] },
    topology: lebendig(['e-as']),
    sources: [],
    charging: null,
    consumers: [],
    devices: [goreBox(jetzt)],
    devicesFetchedAt: jetzt,
    datenquellen: [goreDq1(jetzt)],
    uemsGeraete: [gr('gr-as', 'e-as', 'dq-1', { geraeteart: 'controller', hersteller: 'WAGO', typ: 'PFC200' })],
    now: jetzt,
    ...over,
  };
}

// --- Halle Süd: Wechselrichter (1 : 1), Zählergateway (1 : 4), Anschluss ohne Gerät -------------------------------

export const HS_SITE = { id: 'site-hs', name: 'Halle Süd' } as const;
export const HS_ZAEHLER = ['haupt', 'kompressor', 'licht', 'buero'] as const;

export function hsBox(jetzt: number): Device {
  return {
    id: 'box-hs', siteId: HS_SITE.id, externalRef: 'VP-HS-0001', kind: 'edge', name: 'Box Halle',
    status: 'claimed', lastSeenAt: new Date(jetzt - 5_000).toISOString(), createdAt: '2026-09-01T08:00:00Z',
  };
}

export function hsWege(jetzt: number): UemsDatenquelle[] {
  const box = { id: 'box-hs', name: 'Box Halle' };
  return [
    dq({ id: 'dq-1', kennzeichen: 'DQ-1', anlage: HS_SITE.id, protokoll: 'sunspec_modbus', adresse: '192.168.10.20:502',
      rueckmeldung: liefert(jetzt, 4, 40) }, box),
    dq({ id: 'dq-3', kennzeichen: 'DQ-3', anlage: HS_SITE.id, name: 'Zählergateway Halle', geraete_ids: [1, 2, 3, 4],
      rueckmeldung: liefert(jetzt, 7, 136) }, box),
    dq({ id: 'dq-5', kennzeichen: 'DQ-5', anlage: HS_SITE.id, adresse: '192.168.10.40:502', rueckmeldung: liefert(jetzt, 1, 10) }, box),
  ];
}

/** Halle Süd: fünf Geräte (eins direkt, vier hinter dem Gateway), ein Gateway, ein Anschluss offen. */
export function gatewayForm(jetzt: number, over: Partial<AnlageDaten> = {}): AnlageDaten {
  const frisch = new Date(jetzt - 12_000).toISOString();
  const quelle = (id: string, entity: string, role: string, brand: string | null, model: string | null): EntityLocalSetup =>
    ({ id, kind: 'source', role, brand, model, label: null, reportedAt: frisch, adoptedEntityId: entity }) as EntityLocalSetup;
  const lesung = (id: string): SiteSource =>
    ({ deviceId: 'box-hs', sourceId: id, kind: 'source', role: null, label: null, brand: null, model: null,
      pvKw: null, powerKw: null, loadKw: null, health: 'ok', readAt: frisch, reportedAt: frisch }) as SiteSource;
  const zaehler = HS_ZAEHLER.map((z, i) => ({
    entity: ent({ id: `e-${z}`, entityType: 'grid-meter', label: `Zähler ${z}`, deviceId: 'box-hs', edgeSourceId: `src-${z}` }),
    setup: quelle(`src-${z}`, `e-${z}`, 'grid-meter', 'janitza', 'UMG 604'),
    uems: gr(`gr-${z}`, `e-${z}`, 'dq-3', { geraete_id: i + 1 }),
  }));
  return {
    siteId: HS_SITE.id,
    siteName: HS_SITE.name,
    entities: {
      registry: null,
      entities: [
        ent({ id: 'e-wr', entityType: 'producer', label: 'Wechselrichter Dach', deviceId: 'box-hs', edgeSourceId: 'src-wr' }),
        ...zaehler.map((z) => z.entity),
      ],
      localSetup: [quelle('src-wr', 'e-wr', 'pv-generation', 'fronius_sunspec', 'Symo GEN24 10.0'), ...zaehler.map((z) => z.setup)],
      staleOnDevice: [],
    },
    topology: lebendig(['e-wr', ...HS_ZAEHLER.map((z) => `e-${z}`)]),
    sources: [lesung('src-wr'), ...HS_ZAEHLER.map((z) => lesung(`src-${z}`))],
    charging: null,
    consumers: [],
    devices: [hsBox(jetzt)],
    devicesFetchedAt: jetzt,
    datenquellen: hsWege(jetzt),
    uemsGeraete: [gr('gr-wr', 'e-wr', 'dq-1'), ...zaehler.map((z) => z.uems)],
    now: jetzt,
    ...over,
  };
}
