import { describe, expect, it } from 'vitest';
import type { Device, EntityLocalSetup, SiteEntity } from './api';
import { anlagensteuerungGeraetId, anlagensteuerungIdOf } from './geraetAdresse';
import { geraetKarte } from './geraetEinstellungen';
import { geraetAdressierbar, geraetSeite, type GeraetSeiteInput } from './geraetSeite';
import { plantModel } from './komponenten';
import { ENTITY_GORE, gore, goreGeraet, goreWerte, JETZT } from './test/anlagensteuerungFixtures';

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
