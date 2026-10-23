import { describe, expect, it } from 'vitest';
import type { Device, EntityLocalSetup, SiteEntity } from './api';
import { anlagensteuerungGeraetId, anlagensteuerungIdOf } from './geraetAdresse';
import { geraetKarte } from './geraetEinstellungen';
import { gesicht, typWort } from './geraetGesicht';
import { geraetAdressierbar, geraetSeite, type GeraetSeiteInput } from './geraetSeite';
import { plantModel } from './komponenten';
import { ENTITY_GORE, GERAET_GORE, gore, goreGeraet, goreWerte, JETZT, werte } from './test/anlagensteuerungFixtures';

/**
 * Die Steuerung als Gerät (UEMS EZ-10 (2), EW-3 A): eine Anlagensteuerung liest die Box über eine Datenquelle,
 * nicht über eine eigene Quelle - sie bekommt trotzdem ihre eigene Geräteseite `as-<Entität>` und ist nie ein
 * Teil des Wechselrichters. Ihre Erzeugungseinheiten stehen an der Karte „Gerät“, nie als Energiekarten.
 */
const NOW = Date.parse(JETZT);

const BOX: Device = {
  id: 'box-gore',
  siteId: 'site-gore',
  externalRef: 'edge-gore',
  kind: 'inverter',
  name: 'Box Gore',
  status: 'active',
  lastSeenAt: JETZT,
  createdAt: '2026-10-01T10:00:00Z',
};

const HYBRID: SiteEntity = {
  id: 'ent-batt',
  entityType: 'battery-hybrid',
  typeLabel: 'Batteriespeicher',
  role: 'storage',
  label: 'Speicher',
  control: true,
  deviceId: 'box-gore',
  capabilities: { measure: [{ channel: 'soc_pct' }] },
  guards: null,
  syncStatus: 'in_sync',
  observed: null,
  edgeSourceId: null,
};

const STEUERUNG: SiteEntity = {
  id: ENTITY_GORE,
  entityType: 'anlagensteuerung',
  typeLabel: 'Anlagensteuerung',
  role: null,
  label: 'Anlagensteuerung Gore',
  control: false,
  deviceId: null,
  capabilities: { measure: [] },
  guards: null,
  syncStatus: 'in_sync',
  observed: null,
  edgeSourceId: null,
} as unknown as SiteEntity;

const LOCAL: EntityLocalSetup[] = [
  { id: 'inverter', kind: 'inverter', role: null, brand: 'Deye', model: 'SUN-12K', label: null, reportedAt: JETZT, adoptedEntityId: null } as EntityLocalSetup,
];

function input(over: Partial<GeraetSeiteInput> = {}): GeraetSeiteInput {
  const entities = [HYBRID, STEUERUNG];
  return {
    ref: 'edge-gore',
    geraetId: anlagensteuerungGeraetId(ENTITY_GORE),
    siteName: 'Gore',
    devices: [BOX],
    devicesFetchedAt: NOW,
    entities,
    localSetup: LOCAL,
    sources: [],
    components: null,
    control: null,
    curtailment: null,
    charging: null,
    strategies: null,
    model: plantModel(entities, null, LOCAL, []),
    anlagensteuerung: gore(),
    anlagensteuerungWerte: goreWerte(),
    now: NOW,
    ...over,
  };
}

describe('Anlagensteuerung als Gerät', () => {
  it('Adresse `as-<Entität>` hin und zurück, adressierbar', () => {
    expect(anlagensteuerungGeraetId('e1')).toBe('as-e1');
    expect(anlagensteuerungIdOf('as-e1')).toBe('e1');
    expect(anlagensteuerungIdOf('io-e1')).toBeNull();
    expect(geraetAdressierbar('as-e1')).toBe(true);
  });

  it('plantModel: ein eigenes Gerät - der Wechselrichter nimmt die Steuerung nicht', () => {
    const model = plantModel([HYBRID, STEUERUNG], null, LOCAL, []);
    const as = model.devices.find((d) => d.id === `as-${ENTITY_GORE}`);
    expect(as?.label).toBe('Anlagensteuerung Gore');
    const ids = (id: string) => model.devices.find((d) => d.id === id)?.componentIds
      .map((cid) => model.components.find((c) => c.id === cid)?.entityId);
    expect(ids(`as-${ENTITY_GORE}`)).toEqual([ENTITY_GORE]);
    expect(ids('inverter')).not.toContain(ENTITY_GORE);
  });

  it('geraetSeite: Titel, Modell und Weg aus der Anlagensteuerung, Zustand aus ihren Werten', () => {
    const v = geraetSeite(input());
    expect(v.gefunden).toBe(true);
    expect(v.kopf.titel).toBe('Anlagensteuerung Gore');
    expect(v.kopf.modell).toBe('WAGO PFC200 750-8212');
    expect(v.kopf.unterzeile).toContain('Anlagensteuerung an Ihrer VoltPilot-Box Box Gore');
    expect(v.kopf.zustand).toMatchObject({ wort: 'liefert Daten', ton: 'ok' });
    expect(v.verbindung.find((z) => z.label === 'Anbindung')?.wert).toBe('Modbus TCP · Registerbild Erzeuger');
    expect(v.verbindung.find((z) => z.label === 'Adresse')).toMatchObject({ wert: '192.168.1.50:503', detail: 'Geräte-ID 1 · Datenquelle DQ-1' });
    expect(v.komponenten.map((c) => c.entityId)).toEqual([ENTITY_GORE]);
  });

  it('ohne Werte „noch keine Daten“, nie „liefert Daten“; ohne Komponente die leere Seite mit Grund', () => {
    expect(geraetSeite(input({ anlagensteuerungWerte: null })).kopf.zustand).toMatchObject({ wort: 'noch keine Daten', ton: 'off' });
    const weg = geraetSeite(input({ geraetId: 'as-unbekannt' }));
    expect(weg.gefunden).toBe(false);
    expect(weg.grund).toBe('Diese Anlagensteuerung ist an dieser Anlage nicht mehr eingebaut.');
  });

  it('geraetKarte: Erzeugungseinheiten sind keine Energiekarten', () => {
    const k = geraetKarte(goreGeraet(), { komponenten: new Map(), messstellen: [] });
    expect(k.karten).toEqual([]);
    expect(k.einheiten.map((e) => e.te_nr)).toEqual([1, 2, 3]);
    expect(k.einheiten[0]).toMatchObject({ bezeichnung: 'WR Dach Nord', registry_unit_id: 'SEE912345678901', nennleistung_kw: 125 });
  });
});

/**
 * EZ-22, Gore „Neue Halle“ nach EZ-21: die Steuerung trägt ihren Pin, die Box meldet dafür eine Quelle der Rolle
 * `plant-controller`. Über den Pin wurde die Quelle zum Gerät, und dessen Seite trug das Gesicht eines Zählers
 * („Zähler“, „noch keine Daten“, Einspeisung/Bezug-Skala ±10 kW), obwohl die Steuerung las. Die Seite der
 * Steuerung ist `as-…`; ihr Gesicht spricht aus dem Bild.
 */
describe('Anlagensteuerung mit Pin: ein Gerät, ihr eigenes Gesicht (EZ-22)', () => {
  const NB = String.fromCharCode(160);
  const PIN = 'src-as-192.168.4.165-503-1';
  const MIT_PIN = { ...STEUERUNG, edgeSourceId: PIN } as SiteEntity;
  const LOCAL_PIN: EntityLocalSetup[] = [
    ...LOCAL,
    { id: PIN, kind: 'source', role: 'plant-controller', brand: null, model: null, label: 'Anlagensteuerung', reportedAt: JETZT, adoptedEntityId: null } as EntityLocalSetup,
  ];
  const model = plantModel([HYBRID, MIT_PIN], null, LOCAL_PIN, []);
  /** Wie auf dem Bildschirmfoto vom 23.10.2026: läuft begrenzt, der Netzpunkt bezieht. */
  const neueHalle = werte(GERAET_GORE, {
    'erzeuger.a.a_gueltig': 0b01001,
    'erzeuger.a.p_nvp_w': 877100,
    'erzeuger.a.p_erzeugung_w': 312400,
    'erzeuger.a.anlage_zustand': { wert: 3, text: 'läuft begrenzt' },
    'erzeuger.wirkung.s_bits': 0b11,
    'erzeuger.wirkung.quelle_p': { wert: 1, text: 'Netzbetreiber' },
    'erzeuger.wirkung.p_grenze_w': 375000,
  });
  const gesichtMit = (w: ReturnType<typeof werte> | null) => gesicht({
    art: 'quelle',
    geraetId: anlagensteuerungGeraetId(ENTITY_GORE),
    rolle: null,
    communication: null,
    komponenten: model.components.filter((c) => c.entityId === ENTITY_GORE),
    entities: [HYBRID, MIT_PIN],
    anlagensteuerungWerte: w,
    now: NOW,
  });

  it('die gemeldete Quelle ist kein zweites Gerät: die Steuerung bleibt `as-…`, der Pin wird nichts Neues', () => {
    expect(model.devices.map((d) => d.id)).toEqual(['as-' + ENTITY_GORE, 'inverter']);
    expect(model.newlyReported).toEqual([]);
    const v = geraetSeite(input({ entities: [HYBRID, MIT_PIN], localSetup: LOCAL_PIN, model }));
    expect(v.kopf.unterzeile).toContain('Anlagensteuerung an Ihrer VoltPilot-Box');
    expect(v.kopf.zustand).toMatchObject({ wort: 'liefert Daten', ton: 'ok' });
  });

  it('Gesicht: Erzeugung, Netzpunkt, Anlage und Grenze aus dem Bild - kein Zähler, keine Skala', () => {
    const g = gesichtMit(neueHalle);
    expect(typWort(g)).toBe('Anlagensteuerung');
    expect(g.gattung).not.toBe('zaehler');
    expect(g.held.balken).toBeNull();
    expect(g.held.kacheln.map((k) => [k.label, k.wert, k.wort])).toEqual([
      ['Erzeugung', `312,4${NB}kW`, null],
      ['Netzpunkt', `877,1${NB}kW`, 'Bezug'],
      ['Anlage', 'läuft begrenzt', null],
      ['Wirksame Grenze', `375,0${NB}kW`, 'Netzbetreiber'],
    ]);
    expect(g.held.kacheln.find((k) => k.key === 'zustand')?.ton).toBe('ok');
    expect(g.held.satz).toBe(`Die Anlage erzeugt gerade 312,4${NB}kW.`);
  });

  it('Gore, erste Lesung (EZ-1 E21): ohne gültige Vorgabe nennt die Grenze den Ersatzwert, nie den Netzbetreiber', () => {
    // n_bits Bit 0 = 0, Wort 24 = 1000 (100 %), quelle_p 6 - die 100 % sind keine Vorgabe des Netzbetreibers.
    const ersterLauf = werte(GERAET_GORE, {
      'erzeuger.a.a_gueltig': 0b01001,
      'erzeuger.a.p_nvp_w': 848329,
      'erzeuger.a.p_erzeugung_w': 25935,
      'erzeuger.a.anlage_zustand': { wert: 3, text: 'läuft begrenzt' },
      'erzeuger.nb.n_kanal': { wert: 3, text: 'Fernwirktechnik' },
      'erzeuger.nb.n_bits': 0b010,
      'erzeuger.nb.n_p_prozent': 100,
      'erzeuger.wirkung.s_bits': 0b11,
      'erzeuger.wirkung.quelle_p': { wert: 6, text: 'Ersatzwert' },
      'erzeuger.wirkung.p_grenze_w': 265500,
    });
    const g = gesichtMit(ersterLauf);
    expect(g.held.kacheln.find((k) => k.key === 'grenze')).toMatchObject({ wert: `265,5${NB}kW`, wort: 'Ersatzwert' });
    const alles = [g.held.satz, g.held.hinweis, ...g.held.kacheln.flatMap((k) => [k.wert, k.wort])].join(' | ');
    expect(alles).not.toMatch(/Netzbetreiber|100\s?%/);
  });

  it('eine Störung braucht Aufmerksamkeit; ohne Werte bleibt es ehrlich leer', () => {
    const stoerung = werte(GERAET_GORE, { 'erzeuger.a.anlage_zustand': { wert: 4, text: 'Störung' } });
    expect(gesichtMit(stoerung).held.kacheln.find((k) => k.key === 'zustand')).toMatchObject({ wert: 'Störung', ton: 'warn' });
    const leer = gesichtMit(werte(GERAET_GORE, { 'erzeuger.a.p_nvp_w': { wert: null } }));
    expect(leer.held.kacheln.map((k) => k.wert)).toEqual(['—', '—', '—', '—']);
    expect(leer.held.hinweis).toBe('Von dieser Steuerung liegen noch keine Daten vor.');
    expect(gesichtMit(null).held.kacheln.every((k) => k.wert === '—')).toBe(true);
  });
});
