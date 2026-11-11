import { describe, expect, it } from 'vitest';
import type { AnlagensteuerungWerte, Device, SiteEntity, SiteTopology, UemsDatenquelle } from './api';
import { aufbauBaum, type AufbauGeraet } from './aufbauBaum';
import { aufbauZahlen, filterOptionen, kastenSatz, LEERER_FILTER, tabellenZeilen } from './aufbauTabelle';
import { plantModel } from './komponenten';
import {
  ENTITY_GORE,
  GERAET_GORE,
  gore,
  goreGeraet,
  goreWerte,
  JETZT,
  werte,
} from './test/anlagensteuerungFixtures';
import { aufbauDerAnlage, boxGeraeteBlock } from './boxGeraete';
import { zentraleListe } from './zentraleListe';

/**
 * GE-3 (Konzept „Ein Gerät, ein Eintrag“, GD-2 A vom 23.10.2026): die Wechselrichter hinter der Anlagensteuerung
 * stehen im Aufbau als Geräte unter ihr — mit Ist-Leistung und Zustand je Einheit, und sie zählen als Geräte. Gore
 * zeigt danach „4 Geräte“: die Steuerung und drei Growatt-Wechselrichter.
 */
const NOW = Date.parse(JETZT);
const plain = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ');
const ALLES_OFFEN = { offen: () => true, geraete: new Set<string>() };
const SITE = 'site-gore';
const BOX: Device = {
  id: 'box-gore',
  siteId: SITE,
  externalRef: 'edge-5mz8bdd',
  kind: 'inverter',
  name: null,
  status: 'active',
  lastSeenAt: new Date(NOW - 5_000).toISOString(),
  createdAt: null,
} as Device;
const STEUERUNG = {
  id: ENTITY_GORE,
  entityType: 'anlagensteuerung',
  typeLabel: 'Anlagensteuerung',
  role: 'anlagensteuerung',
  label: 'Anlagensteuerung',
  control: false,
  deviceId: null,
  capabilities: { measure: [] },
  guards: null,
  syncStatus: 'in_sync',
  observed: null,
  edgeSourceId: null,
} as unknown as SiteEntity;
const DQ1 = {
  id: 'dq-gore', kennzeichen: 'DQ-1', name: null, anlage: SITE, protokoll: 'modbus_tcp', adresse: '192.168.4.165:503',
  geraete_ids: [1], netz: null, mehrere_leser: false, steuerquelle: false, vergleichsquelle: false, kadenz_s: 5,
  archiviert_am: null, zustaendige_box: { id: BOX.id, name: null, heimat_anlage: SITE }, zeitraeume: [], rueckmeldung: null,
} as unknown as UemsDatenquelle;

// Die Steuerung liefert (EZ-22: ihre Lebendigkeit steht in der Topologie).
const TOPOLOGIE = {
  schemaVersion: '1.0',
  entities: [{ id: ENTITY_GORE, entityType: 'anlagensteuerung', typeLabel: 'Anlagensteuerung', label: null, category: 'meter', health: 'ok', capabilities: [] }],
  topology: { schema_version: '1.0', nodes: [] },
} as unknown as SiteTopology;

function baumMit(w: AnlagensteuerungWerte | null, mitSteuerungen = true) {
  const model = plantModel([STEUERUNG], TOPOLOGIE, [], []);
  const karten = zentraleListe({
    siteId: SITE, model, devices: [BOX], devicesFetchedAt: NOW, boxRef: BOX.externalRef, localSetup: [], sources: [],
    charging: null, now: NOW,
  });
  return aufbauBaum({
    siteId: SITE, siteName: 'Neue Halle', standorte: null, devices: [BOX], devicesFetchedAt: NOW, karten, localSetup: [],
    charging: null, registryBoxId: BOX.id, overview: null, datenquellen: [DQ1], uemsGeraete: { [SITE]: [goreGeraet()] },
    anlagensteuerungen: mitSteuerungen
      ? {
          [SITE]: {
            liste: { einrichtung: { moeglich: true, grund: null, boxen: [] }, steuerungen: [gore()] },
            werte: w ? { [GERAET_GORE]: w } : {},
          },
        }
      : undefined,
    now: NOW,
  });
}
const zeile = (g: AufbauGeraet) =>
  [g.titel, plain(g.unterzeile), g.artWort, g.zustandWort, plain(g.werte[0]?.text ?? '—')].join(' | ');

describe('Aufbau — Wechselrichter hinter der Steuerung (GE-3)', () => {
  it('Gore: die Steuerung und darunter je Einheit eine Zeile — „4 Geräte“, nach TE-Nr., mit Ist und Zustand', () => {
    const baum = baumMit(goreWerte());
    const box = baum.anlagen[0].boxen[0];
    expect(box.geraete.map((g) => g.id)).toEqual([
      `as-${ENTITY_GORE}`,
      `as-${ENTITY_GORE}~te-1`,
      `as-${ENTITY_GORE}~te-2`,
      `as-${ENTITY_GORE}~te-3`,
    ]);
    expect(box.geraete.slice(1).map(zeile)).toEqual([
      // Name aus der Bezeichnung, sonst „Wechselrichter n“; Typ · Nennleistung; Zustand aus `t_zustand`.
      'WR Dach Nord | Growatt MAX 125KTL3-X · 125 kW | PV-Wechselrichter · über die Steuerung | läuft begrenzt | 52,8 kW',
      'Wechselrichter 2 | Growatt MAX 125KTL3-X · 125 kW | PV-Wechselrichter · über die Steuerung | läuft begrenzt | 53,1 kW',
      // WR 3: ohne Gültigkeitsbit kein Ist und kein Zustand — „—“, nie 0; die Nennleistung kommt aus dem Bild.
      'Wechselrichter 3 | 125 kW | PV-Wechselrichter · über die Steuerung | Werte ungültig | —',
    ]);
    expect(kastenSatz(box.geraete, box.wege)).toBe('4 Geräte');
    expect(baum.anlagen[0].geraeteZahl).toBe(4);
    expect(aufbauZahlen(baum, LEERER_FILTER)).toMatchObject({ geraete: 4, achtung: 1 });
    const einheit = box.geraete[2];
    expect(einheit.einheit).toEqual({ steuerungId: `as-${ENTITY_GORE}`, teNr: 2 });
    expect(einheit.karte.href).toBe(`#/anlage/${SITE}/geraet/edge-5mz8bdd/as-${ENTITY_GORE}~te-2`);
    expect(einheit.anbindungText).toBe('gelesen über Anlagensteuerung');
    expect(einheit.ton).toBe('ok');
    expect(box.geraete[3].ton).toBe('warn');
  });

  it('die Tabelle: Einheiten eine Ebene unter der Steuerung, immer sichtbar (keine Aufklapp-Zeile)', () => {
    const baum = baumMit(goreWerte());
    const z = tabellenZeilen(baum, LEERER_FILTER, ALLES_OFFEN);
    expect(z.map((x) => [x.typ, x.ebene, 'geraet' in x ? x.geraet.titel : x.key])).toEqual([
      ['anlage', 0, SITE],
      ['box', 1, 'box-gore'],
      ['geraet', 2, 'Anlagensteuerung'],
      ['geraet', 3, 'WR Dach Nord'],
      ['geraet', 3, 'Wechselrichter 2'],
      ['geraet', 3, 'Wechselrichter 3'],
    ]);
    // Zugeklappt bleibt ohne Messwert-Unterzeilen trotzdem jede Einheit stehen.
    const zu = tabellenZeilen(baum, LEERER_FILTER, { offen: () => true, geraete: new Set() });
    expect(zu.filter((x) => x.typ === 'geraet')).toHaveLength(4);
  });

  it('Suche nach einer Einheit zeigt sie mit ihrer Steuerung als Ort; der Art-Filter kennt „PV-Wechselrichter“', () => {
    const baum = baumMit(goreWerte());
    const z = tabellenZeilen(baum, { ...LEERER_FILTER, q: 'dach nord' }, ALLES_OFFEN);
    expect(z.filter((x) => x.typ === 'geraet').map((x) => ('geraet' in x ? x.geraet.titel : ''))).toEqual([
      'Anlagensteuerung',
      'WR Dach Nord',
    ]);
    expect(aufbauZahlen(baum, { ...LEERER_FILTER, q: 'dach nord' }).treffer).toBe(1);
    expect(filterOptionen(baum).art.map((o) => [o.label, o.anzahl])).toEqual([
      ['Gerät an Ihrer Box', 1],
      ['PV-Wechselrichter', 3],
    ]);
    // Die MaStR-Nummer findet die Einheit auch.
    const see = tabellenZeilen(baum, { ...LEERER_FILTER, q: 'SEE912345678901' }, ALLES_OFFEN);
    expect(see.filter((x) => x.typ === 'geraet')).toHaveLength(2);
  });

  it('ohne Lesung: „noch keine Daten“ und „—“, nie 0; ohne Antwort der Werte „unbekannt“', () => {
    const leer = baumMit(werte(GERAET_GORE, {}));
    expect(leer.anlagen[0].boxen[0].geraete.slice(1).map((g) => [g.zustandWort, g.werte.length, g.ton])).toEqual([
      ['noch keine Daten', 0, 'off'],
      ['noch keine Daten', 0, 'off'],
      ['noch keine Daten', 0, 'off'],
    ]);
    const ungeladen = baumMit(null);
    expect(ungeladen.anlagen[0].boxen[0].geraete.slice(1).map((g) => g.zustandWort)).toEqual(['unbekannt', 'unbekannt', 'unbekannt']);
    expect(kastenSatz(ungeladen.anlagen[0].boxen[0].geraete, [])).toBe('4 Geräte');
  });

  it('eine Einheit, die nachts „aus“ ist, braucht keine Aufmerksamkeit; „Störung“ schon', () => {
    const w = werte(GERAET_GORE, {
      'erzeuger.te[1].t_bits': 0b11,
      'erzeuger.te[1].t_zustand': 0,
      'erzeuger.te[1].t_p_ist_w': 0,
      'erzeuger.te[2].t_bits': 0b11,
      'erzeuger.te[2].t_zustand': 4,
      'erzeuger.te[3].t_bits': 0b11,
      'erzeuger.te[3].t_zustand': 1,
    });
    const g = baumMit(w).anlagen[0].boxen[0].geraete.slice(1);
    expect(g.map((x) => [x.zustandWort, x.ton, plain(x.werte[0]?.text)])).toEqual([
      ['aus', 'ok', '0,0 kW'],
      ['Störung', 'warn', ''],
      ['bereit', 'ok', ''],
    ]);
  });

  it('ohne die Antwort der Anlagensteuerungen bleibt der Aufbau wie in GE-1: eine Zeile, „1 Gerät“', () => {
    const box = baumMit(null, false).anlagen[0].boxen[0];
    expect(box.geraete.map((g) => g.id)).toEqual([`as-${ENTITY_GORE}`]);
    expect(kastenSatz(box.geraete, box.wege)).toBe('1 Gerät');
  });
});

describe('Box-Seite — dieselben Geräte wie der Aufbau (GE-3 mit GE-4)', () => {
  it('die Steuerung und direkt dahinter ihre Wechselrichter, je mit eigener Seite; Bühne und Box-Zeile zählen vier', () => {
    const anlage = aufbauDerAnlage({
      siteId: SITE, siteName: 'Neue Halle',
      entities: { registry: { deviceId: BOX.id }, entities: [STEUERUNG], localSetup: [], staleOnDevice: [] } as never,
      topology: TOPOLOGIE, devices: [BOX], datenquellen: [DQ1], uemsGeraete: [goreGeraet()],
      anlagensteuerungen: {
        liste: { einrichtung: { moeglich: true, grund: null, boxen: [] }, steuerungen: [gore()] },
        werte: { [GERAET_GORE]: goreWerte() },
      },
      now: NOW,
    });
    const block = boxGeraeteBlock({
      boxId: BOX.id, boxRef: BOX.externalRef, siteId: SITE, box: anlage!.boxen[0], datenquellen: [DQ1], zuordnung: true,
    });
    expect(block.eintraege.map((e) => [e.titel, e.href, e.anbindung])).toEqual([
      ['Anlagensteuerung', `#/anlage/${SITE}/geraet/edge-5mz8bdd/as-${ENTITY_GORE}`, 'Modbus TCP · 192.168.4.165:503'],
      ['WR Dach Nord', `#/anlage/${SITE}/geraet/edge-5mz8bdd/as-${ENTITY_GORE}~te-1`, 'gelesen über Anlagensteuerung'],
      ['Wechselrichter 2', `#/anlage/${SITE}/geraet/edge-5mz8bdd/as-${ENTITY_GORE}~te-2`, 'gelesen über Anlagensteuerung'],
      ['Wechselrichter 3', `#/anlage/${SITE}/geraet/edge-5mz8bdd/as-${ENTITY_GORE}~te-3`, 'gelesen über Anlagensteuerung'],
    ]);
    expect([block.anzahl, block.liefern]).toEqual([4, 3]);
    expect(block.kurz).toMatch(/^4 Geräte/);
  });
});
