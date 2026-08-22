import { describe, expect, it } from 'vitest';
import {
  abschlussTitel,
  feldGruppen,
  fortschritt,
  fortschrittAnteil,
  geraeteFuerTyp,
  keineVorlageHinweis,
  legtAn,
  neueKomponente,
  rollenWahl,
  schritte,
  typKarten,
  vorschlagRolle,
} from './anlegenFlow';
import type { ComponentTemplate } from './komponentenAssistent';

function tpl(over: Partial<ComponentTemplate> & { templateRef: string }): ComponentTemplate {
  return {
    kind: 'builtin',
    version: 1,
    brand: 'deye',
    brandLabel: 'Deye',
    model: 'm',
    modelLabel: 'M',
    communication: 'solarman_v5',
    communicationLabel: 'Solarman-V5',
    ...over,
  } as ComponentTemplate;
}

const wechselrichter = tpl({ templateRef: 'builtin:deye:a', deviceType: 'inverter' });
const wallbox = tpl({
  templateRef: 'builtin:go-e:charger',
  brand: 'go-e',
  brandLabel: 'go-e',
  deviceType: 'wallbox',
});
const schalter = tpl({
  templateRef: 'builtin:shelly:relais',
  brand: 'shelly',
  brandLabel: 'Shelly',
  deviceType: 'switch',
});
/** Eine Vorlage, die ihren Typ NICHT nennt - der ältere Backend-Stand. */
const unbekannt = tpl({ templateRef: 'certified:acme:x', kind: 'certified', deviceType: null });

const alle = [wechselrichter, wallbox, schalter, unbekannt];

describe('typKarten', () => {
  it('bietet die sechs Karten des Konzepts an', () => {
    expect(typKarten(alle).map((k) => k.id)).toEqual([
      'wechselrichter',
      'wallbox',
      'ladesaeule',
      'verbraucher',
      'zaehler',
      'eigenbau',
    ]);
  });

  it('zaehlt nur die EIGENEN Vorlagen einer Karte', () => {
    const k = typKarten(alle);
    expect(k.find((x) => x.id === 'wechselrichter')?.treffer).toBe(1);
    expect(k.find((x) => x.id === 'wallbox')?.treffer).toBe(1);
    expect(k.find((x) => x.id === 'zaehler')?.treffer).toBe(0);
  });

  it('nennt den GRUND, wenn es fuer einen Typ keine eigene Vorlage gibt', () => {
    const zaehler = typKarten(alle).find((k) => k.id === 'zaehler');
    expect(zaehler?.hinweis).toBe(keineVorlageHinweis('zaehler'));
    expect(typKarten(alle).find((k) => k.id === 'wechselrichter')?.hinweis).toBeNull();
  });

  it('behauptet ohne jede Vorlage gar nichts', () => {
    for (const k of typKarten([])) expect(k.hinweis).toBeNull();
  });
});

describe('geraeteFuerTyp', () => {
  it('filtert auf die Geraetetyp-Dimension des Katalogs', () => {
    expect(geraeteFuerTyp(alle, 'wechselrichter').templates.map((t) => t.templateRef)).toEqual([
      'builtin:deye:a',
      'certified:acme:x',
    ]);
    expect(geraeteFuerTyp(alle, 'wallbox').templates.map((t) => t.templateRef)).toEqual([
      'builtin:go-e:charger',
      'certified:acme:x',
    ]);
    expect(geraeteFuerTyp(alle, 'wechselrichter').erweitert).toBe(false);
  });

  it('versteckt eine Vorlage OHNE Typ nirgends - unbekannt ist kein Ausschluss', () => {
    for (const typ of ['wechselrichter', 'wallbox', 'verbraucher'] as const) {
      expect(geraeteFuerTyp(alle, typ).templates).toContain(unbekannt);
    }
  });

  it('WEITET sich sichtbar, wo der Katalog nichts Eigenes hat (die Kompatibilitaets-Haelfte)', () => {
    const zaehler = geraeteFuerTyp(alle, 'zaehler');
    expect(zaehler.erweitert).toBe(true);
    expect(zaehler.templates).toEqual(alle);
  });

  it('gibt fuer Ladesaeule und Eigenbau NICHTS aus - sie haben keine Vorlagen-Auswahl', () => {
    expect(geraeteFuerTyp(alle, 'ladesaeule')).toEqual({ templates: [], erweitert: false });
    expect(geraeteFuerTyp(alle, 'eigenbau')).toEqual({ templates: [], erweitert: false });
  });

  it('weitet ohne jede Vorlage nicht - eine leere Liste erklaert sich selbst', () => {
    expect(geraeteFuerTyp([], 'zaehler')).toEqual({ templates: [], erweitert: false });
  });
});

describe('rollenWahl / vorschlagRolle', () => {
  it('stellt nur beim Wechselrichter eine echte Rest-Frage', () => {
    expect(rollenWahl('wechselrichter', []).map((r) => r.rolle)).toEqual([
      'inverter',
      'pv-generation',
    ]);
    expect(rollenWahl('wallbox', []).map((r) => r.rolle)).toEqual(['consumer']);
    expect(rollenWahl('zaehler', []).map((r) => r.rolle)).toEqual(['grid-meter']);
    expect(rollenWahl('ladesaeule', [])).toEqual([]);
  });

  it('nennt den Grund einer gesperrten Rolle, statt sie nur auszugrauen', () => {
    const [meter] = rollenWahl('zaehler', ['grid-meter']);
    expect(meter.verfuegbar).toBe(false);
    expect(meter.grund).toMatch(/bereits einen Netz-Zähler/);
  });

  it('schlaegt beim zweiten Wechselrichter den weiteren Erzeuger vor - blockiert ihn aber nie', () => {
    expect(vorschlagRolle('wechselrichter', [])).toBe('inverter');
    expect(vorschlagRolle('wechselrichter', ['inverter'])).toBe('pv-generation');
    expect(rollenWahl('wechselrichter', ['inverter']).every((r) => r.verfuegbar)).toBe(true);
  });

  it('schlaegt nichts vor, wo nichts frei ist', () => {
    expect(vorschlagRolle('zaehler', ['grid-meter'])).toBeNull();
    expect(vorschlagRolle('ladesaeule', [])).toBeNull();
  });
});

describe('Schritte', () => {
  it('gibt jedem Weg seine eigene Leiste', () => {
    expect(schritte('wechselrichter')).toEqual([
      'Was anbinden',
      'Gerät wählen',
      'Verbinden',
      'Testen',
      'Fertig',
    ]);
    expect(schritte('eigenbau')).toHaveLength(6);
    expect(schritte('ladesaeule')).toEqual(['Was anbinden', 'Anbinden']);
    expect(schritte(null)[0]).toBe('Was anbinden');
  });

  it('zaehlt den Fortschritt, ohne ueber den Rand zu laufen', () => {
    const s = schritte('wechselrichter');
    expect(fortschritt(s, 2)).toBe('Schritt 2 von 5');
    expect(fortschritt(s, 99)).toBe('Schritt 5 von 5');
    expect(fortschritt(s, 0)).toBe('Schritt 1 von 5');
    expect(fortschrittAnteil(s, 5)).toBe(1);
    expect(fortschrittAnteil([], 1)).toBe(0);
  });

  it('weiss, dass die Ladesaeulen-Karte nichts anlegt', () => {
    expect(legtAn('ladesaeule')).toBe(false);
    expect(legtAn('wechselrichter')).toBe(true);
    expect(legtAn('eigenbau')).toBe(true);
  });
});

describe('feldGruppen', () => {
  it('haelt Pflichtfelder oben und raeumt den Rest unter Erweitert', () => {
    const g = feldGruppen([
      { key: 'ip', required: true },
      { key: 'port' },
      { key: 'serial', required: true },
      { key: 'invert', required: false },
    ] as { key: string; required?: boolean }[]);
    expect(g.pflicht.map((f) => f.key)).toEqual(['ip', 'serial']);
    expect(g.erweitert.map((f) => f.key)).toEqual(['port', 'invert']);
  });
});

describe('neueKomponente', () => {
  it('nimmt bei einer Uebernahme die uebernommene Zeile', () => {
    expect(neueKomponente([{ id: 'a' }], [{ id: 'a' }], 'a')).toBe('a');
  });

  it('findet die eine neue Zeile', () => {
    expect(neueKomponente([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }])).toBe('b');
  });

  it('raet nicht, wenn es mehrdeutig ist', () => {
    expect(neueKomponente([], [{ id: 'a' }, { id: 'b' }])).toBeNull();
    expect(neueKomponente([{ id: 'a' }], [{ id: 'a' }])).toBeNull();
  });
});

describe('abschlussTitel', () => {
  it('unterscheidet Anlegen von Wiederverbinden', () => {
    expect(abschlussTitel('Dach Süd', false)).toBe('„Dach Süd" ist angelegt.');
    expect(abschlussTitel('Dach Süd', true)).toBe('„Dach Süd" ist wieder verbunden.');
    expect(abschlussTitel('  ', false)).toBe('„Die Komponente" ist angelegt.');
  });
});
