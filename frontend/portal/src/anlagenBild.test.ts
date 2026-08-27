import { describe, expect, it } from 'vitest';
import { anlagenBild, layoutAnlagenBild } from './anlagenBild';
import type { PlantComponent } from './komponenten';
import type { GeraeteKarte } from './zentraleListe';
import type { Device, EdgeVersion } from './api';

function component(over: Partial<PlantComponent> = {}): PlantComponent {
  return {
    id: 'c-1',
    entityId: 'c-1',
    aspect: 'main',
    label: 'Komponente',
    alias: null,
    derivedLabel: 'Komponente',
    renameable: true,
    role: 'pv',
    summary: 'misst',
    deviceIds: ['d-1'],
    provenance: null,
    reading: null,
    channels: [],
    control: false,
    schaltbar: false,
    freigabeQuelle: null,
    freigabeFaehig: false,
    primary: false,
    health: 'ok',
    measuredVia: null,
    orphaned: false,
    ...over,
  };
}

function card(over: Partial<GeraeteKarte> = {}): GeraeteKarte {
  return {
    id: 'd-1',
    art: 'geraet',
    titel: 'PV-Wechselrichter',
    untertitel: 'PV-Wechselrichter',
    zustand: 'Liefert Daten · vor 8 Sek.',
    ton: 'ok',
    href: '#/geraet/d-1',
    komponenten: [component()],
    zusatz: null,
    ...over,
  };
}

function boxKarte(over: Partial<GeraeteKarte> = {}): GeraeteKarte {
  return card({
    id: 'box',
    art: 'box',
    titel: 'VoltPilot-Box VP-1',
    untertitel: 'Ihre Verbindung zu VoltPilot',
    zustand: 'verbunden · vor 5 Sek.',
    ton: 'ok',
    href: '#/anlage/s-1/box/VP-1',
    komponenten: [],
    ...over,
  });
}

const box: Device = {
  id: 'gw',
  siteId: 's-1',
  externalRef: 'VP-1',
  kind: 'inverter',
  name: null,
  status: 'active',
  lastSeenAt: new Date().toISOString(),
  createdAt: null,
};

describe('anlagenBild — reine elektrische Projektion', () => {
  it('stellt einen Hybrid EINMAL unter PV dar, mit sichtbarer Speicher-Rolle', () => {
    const bild = anlagenBild([
      boxKarte(),
      card(),
      card({
        id: 'hybrid',
        titel: 'Deye Hybrid',
        komponenten: [
          component({
            id: 'pv',
            role: 'pv',
            reading: { value: 27, unit: 'kW', caption: 'erzeugt' },
          }),
          component({
            id: 'batt',
            role: 'storage',
            control: true,
            schaltbar: false,
            reading: { value: 76, unit: '%', caption: 'Ladestand' },
          }),
          component({ id: 'grid', role: 'grid' }),
          component({ id: 'house', role: 'house' }),
        ],
      }),
      card({
        id: 'wallbox',
        art: 'ladepunkt',
        titel: 'Wallbox Garage',
        komponenten: [component({ role: 'consumer' })],
      }),
    ]);

    // Der Hybrid wohnt unter PV, nicht unter Speicher.
    expect(bild.knoten.map((k) => [k.titel, k.zone])).toEqual([
      ['PV-Wechselrichter', 'pv'],
      ['Deye Hybrid', 'pv'],
      ['Wallbox Garage', 'consumer'],
    ]);
    // Das physische Gerät erscheint NIE zusätzlich als zweiter Knoten im Speicher.
    expect(bild.knoten.filter((k) => k.titel === 'Deye Hybrid')).toHaveLength(1);
    // Seine Speicher-/Netz-Rolle steht sichtbar an seiner PV-Darstellung; die
    // abgeleitete Hausverteilung ist kein eigenes Gerät und bleibt aussen vor.
    const hybrid = bild.knoten.find((k) => k.titel === 'Deye Hybrid')!;
    expect(hybrid.nebenrollen).toEqual(['storage', 'grid']);
    expect(hybrid.zustandLabel).toBe('Ungesteuert');
    // Die Zahl an der PV-Darstellung ist die PV-Produktion, nie der zuerst
    // gelieferte Speicherwert.
    expect(hybrid.werte[0]).toMatchObject({ zone: 'pv', wert: '27,0\u00a0kW' });
  });

  it('gibt einem reinen Erzeuger keine Nebenrollen', () => {
    const bild = anlagenBild([card()]);
    expect(bild.knoten[0].zone).toBe('pv');
    expect(bild.knoten[0].nebenrollen).toEqual([]);
  });

  it('behält die integrierte Speicherrolle auch ohne Speichertelemetrie ehrlich sichtbar', () => {
    const bild = anlagenBild([
      card({
        titel: 'Hybrid ohne Speicherwert',
        komponenten: [
          component({
            id: 'pv',
            role: 'pv',
            reading: { value: 4.2, unit: 'kW', caption: 'erzeugt' },
          }),
          component({ id: 'batt', role: 'storage', reading: null }),
        ],
      }),
    ]);
    expect(bild.knoten).toHaveLength(1);
    expect(bild.knoten[0].zone).toBe('pv');
    expect(bild.knoten[0].nebenrollen).toEqual(['storage']);
    expect(bild.knoten[0].werte).toEqual([
      { label: 'Komponente', wert: '4,2\u00a0kW', zone: 'pv', stand: 'vor 8 Sek.' },
    ]);
  });

  it('ordnet neu gemeldete Quellen nach ihrer vorhandenen Rollenangabe ein', () => {
    const bild = anlagenBild([
      card({
        id: 'neu-pv',
        art: 'neu',
        titel: 'Fronius gemeldet',
        href: null,
        komponenten: [],
        quelle: {
          id: 'source-1',
          role: 'pv-generation',
          brand: 'fronius',
          model: null,
          label: null,
          roleLabel: 'Erzeuger (PV)',
          summary: 'Fronius',
          suggestedType: 'producer',
        },
      }),
    ]);
    expect(bild.knoten[0].zone).toBe('pv');
    expect(bild.knoten[0].rollen).toEqual(['pv']);
    // Ein noch nicht übernommenes Gerät hat keine Detailseite, aber die Quelle.
    expect(bild.knoten[0].href).toBeNull();
    expect(bild.knoten[0].quelle?.id).toBe('source-1');
  });

  it('trägt alle Zustände als Wort und macht fehlende Werte niemals zu 0', () => {
    const bild = anlagenBild([
      card(),
      card({ id: 'warn', titel: 'Zähler gestört', ton: 'warn', zustand: 'meldet sich gerade nicht' }),
      card({ id: 'off', titel: 'Wallbox aus', ton: 'off', zustand: 'getrennt · gestern' }),
      card({ id: 'neu', art: 'neu', titel: 'Neues Gerät', zustand: 'noch keine Komponente' }),
    ]);

    expect(bild.knoten.map((k) => k.zustandLabel)).toEqual([
      'Online',
      'Gestört',
      'Nicht verbunden',
      'Zuordnung ausstehend',
    ]);
    expect(bild.knoten.every((k) => k.werte.length === 0)).toBe(true);
    expect(JSON.stringify(bild)).not.toMatch(/"wert":"?0/);
  });

  it('behält am belegten Livewert dessen Frischeanker', () => {
    const bild = anlagenBild([
      card({
        komponenten: [component({ reading: { value: 4.2, unit: 'kW', caption: 'erzeugt' } })],
      }),
    ]);
    expect(bild.knoten[0].werte).toEqual([
      { label: 'Komponente', wert: '4,2\u00a0kW', zone: 'pv', stand: 'vor 8 Sek.' },
    ]);
  });

  it('führt KEINE inline „hinzufügen"-Plätze mehr', () => {
    const bild = anlagenBild([boxKarte(), card()]);
    expect('slots' in bild).toBe(false);
    expect(JSON.stringify(bild)).not.toMatch(/hinzufügen|Optional/);
  });

  it('berechnet stabile, überlappungsfreie Koordinaten innerhalb jeder Spalte', () => {
    const bild = anlagenBild([
      card({ id: 'pv-1' }),
      card({
        id: 'pv-2',
        titel: 'Hybrid PV 2',
        komponenten: [
          component({ id: 'pv-2-pv', role: 'pv' }),
          component({ id: 'pv-2-storage', role: 'storage' }),
          component({ id: 'pv-2-grid', role: 'grid' }),
        ],
      }),
      card({ id: 'pv-3', titel: 'PV 3' }),
      card({ id: 'storage', komponenten: [component({ role: 'storage' })] }),
    ]);
    const a = layoutAnlagenBild(bild);
    const b = layoutAnlagenBild(bild);
    expect(a).toEqual(b);

    for (const item of a.items) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x + item.w).toBeLessThanOrEqual(a.breite);
      expect(item.y).toBeGreaterThanOrEqual(0);
      expect(item.y + item.h).toBeLessThan(a.serviceY);
    }
    for (const zone of ['pv', 'storage', 'house', 'grid', 'consumer'] as const) {
      const items = a.items.filter((i) => i.zone === zone).sort((x, y) => x.y - y.y);
      for (let i = 1; i < items.length; i += 1) {
        expect(items[i - 1].y + items[i - 1].h).toBeLessThan(items[i].y);
      }
    }
  });
});

describe('anlagenBild — die Datenverbindungs-Karte der Box', () => {
  it('reicht die Box-Seite als Link durch und zeigt die private LAN-Adresse + Softwarestand', () => {
    const edge: EdgeVersion = {
      deviceId: 'gw',
      siteId: 's-1',
      coreVersion: 'edge-2026.08.1-9b37439a1234',
      paletteVersion: null,
      reportedAt: new Date().toISOString(),
      newestRelease: 'edge-2026.08.1',
      upToDate: true,
    };
    const bild = anlagenBild([boxKarte(), card()], {
      boxDevice: { ...box, lanHost: '192.168.0.28:8484', lanSource: 'erreicht', lanSeenAt: new Date().toISOString() },
      edge,
      now: Date.now(),
    });
    expect(bild.service?.href).toBe('#/anlage/s-1/box/VP-1');
    // Die gemeldete PRIVATE Adresse — verbatim inklusive Port, nie eine WAN-Adresse.
    expect(bild.service?.lan.wert).toBe('192.168.0.28:8484');
    expect(bild.service?.lan.bekannt).toBe(true);
    expect(bild.service?.lan.mono).toBe(true);
    // Der installierte Edge-Softwarestand als Tag + Build.
    expect(bild.service?.version.wert).toBe('edge-2026.08.1 (Build 9b37439a)');
    expect(bild.service?.version.bekannt).toBe(true);
  });

  it('behauptet nie eine Adresse oder Version, die die Box nicht gemeldet hat', () => {
    // Eine Box ohne gemeldete LAN-Adresse und ohne Software-Stand.
    const bild = anlagenBild([boxKarte(), card()], { boxDevice: box, edge: null, now: Date.now() });
    expect(bild.service?.lan.bekannt).toBe(false);
    expect(bild.service?.lan.wert).toBe('meldet Ihre Box noch nicht');
    expect(bild.service?.version.bekannt).toBe(false);
    expect(bild.service?.version.wert).toBe('meldet keinen Stand');
    // Kein Datenweg produziert je eine WAN-/öffentliche IP: die einzige Quelle
    // ist die von der Box gemeldete lokale `lanHost`.
    expect(bild.service?.lan.wert).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it('verwirft eine öffentliche/WAN-Adresse selbst dann, wenn sie in lanHost ankommt', () => {
    const bild = anlagenBild([boxKarte()], {
      boxDevice: {
        ...box,
        lanHost: '203.0.113.42:8484',
        lanSource: 'erreicht',
        lanSeenAt: new Date().toISOString(),
      },
      edge: null,
      now: Date.now(),
    });
    expect(bild.service?.lan.bekannt).toBe(false);
    expect(bild.service?.lan.wert).toBe('meldet Ihre Box noch nicht');
    expect(JSON.stringify(bild.service)).not.toContain('203.0.113.42');
  });

  it('zeigt keine Loopback-Schreibweise und keinen Port 0 als Adresse im Kundennetz', () => {
    for (const lanHost of [
      '127.0.0.1:8484',
      '[::1]:8484',
      '[::ffff:127.0.0.1]:8484',
      '192.168.0.28:0',
      '[fd12:3456:789a::28]:0',
    ]) {
      const bild = anlagenBild([boxKarte()], {
        boxDevice: {
          ...box,
          lanHost,
          lanSource: 'erreicht',
          lanSeenAt: new Date().toISOString(),
        },
        now: Date.now(),
      });
      expect(bild.service?.lan.bekannt).toBe(false);
      expect(JSON.stringify(bild.service)).not.toContain(lanHost);
    }
  });

  it('lässt belegbare RFC1918- und ULA-Adressen mit gültigem Port durch', () => {
    for (const lanHost of ['10.23.4.5:1', '[fd12:3456:789a::28]:65535']) {
      const bild = anlagenBild([boxKarte()], {
        boxDevice: {
          ...box,
          lanHost,
          lanSource: 'erreicht',
          lanSeenAt: new Date().toISOString(),
        },
        now: Date.now(),
      });
      expect(bild.service?.lan).toMatchObject({ bekannt: true, wert: lanHost });
    }
  });

  it('ist ohne Box gar keine Karte', () => {
    const bild = anlagenBild([card()]);
    expect(bild.service).toBeNull();
  });
});
