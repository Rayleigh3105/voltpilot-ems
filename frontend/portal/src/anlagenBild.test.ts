import { describe, expect, it } from 'vitest';
import { anlagenBild, layoutAnlagenBild } from './anlagenBild';
import type { PlantComponent } from './komponenten';
import type { GeraeteKarte } from './zentraleListe';

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

describe('anlagenBild — reine elektrische Projektion', () => {
  it('ordnet Geräte einmalig nach ihrem elektrischen Hauptort ein', () => {
    const bild = anlagenBild([
      card({ id: 'box', art: 'box', titel: 'VoltPilot-Box', komponenten: [] }),
      card(),
      card({
        id: 'hybrid',
        titel: 'Deye Hybrid',
        komponenten: [
          component({ role: 'pv' }),
          component({ id: 'batt', role: 'storage', control: true, schaltbar: false }),
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

    expect(bild.knoten.map((k) => [k.titel, k.zone])).toEqual([
      ['PV-Wechselrichter', 'pv'],
      ['Deye Hybrid', 'storage'],
      ['Wallbox Garage', 'consumer'],
    ]);
    expect(bild.service?.titel).toBe('VoltPilot-Box');
    expect(bild.knoten.find((k) => k.titel === 'Deye Hybrid')?.zustandLabel).toBe(
      'Ungesteuert',
    );
    expect(bild.slots.some((s) => s.id === 'slot-grid')).toBe(false);
  });

  it('ordnet neu gemeldete Quellen nach ihrer vorhandenen Rollenangabe ein', () => {
    const bild = anlagenBild([
      card({
        id: 'neu-pv',
        art: 'neu',
        titel: 'Fronius gemeldet',
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
      { label: 'Komponente', wert: '4,2 kW', stand: 'vor 8 Sek.' },
    ]);
  });

  it('zeigt konkrete optionale Plätze und keinen zweiten Standard-Netzzähler', () => {
    const leer = anlagenBild([]);
    expect(leer.slots.map((s) => s.label)).toEqual([
      'PV-Wechselrichter hinzufügen',
      'Speicher hinzufügen',
      'Netz-Zähler hinzufügen',
      'Ladesäule anbinden',
      'Verbraucher hinzufügen',
    ]);
    expect(leer.slots.find((s) => s.id === 'slot-storage')?.initialRolle).toBe('inverter');

    const mitNetz = anlagenBild([
      card({ komponenten: [component({ role: 'grid', primary: true })] }),
    ]);
    expect(mitNetz.slots.some((s) => s.id === 'slot-grid')).toBe(false);
  });

  it('berechnet stabile, überlappungsfreie Koordinaten innerhalb jeder Spalte', () => {
    const bild = anlagenBild([
      card({ id: 'pv-1' }),
      card({ id: 'pv-2', titel: 'PV 2' }),
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
