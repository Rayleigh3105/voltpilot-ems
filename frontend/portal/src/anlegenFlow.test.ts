import { describe, expect, it } from 'vitest';
import {
  abschlussTitel,
  feldGruppen,
  fortschritt,
  fortschrittAnteil,
  geraeteFuerTyp,
  keineVorlageHinweis,
  neueKomponente,
  rollenWahl,
  typFuerTemplate,
  vorhandeneGeraete,
  vorschlagRolle,
} from './anlegenFlow';
import type { SiteComponentRow } from './api';
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

describe('keineVorlageHinweis', () => {
  it('nennt den GRUND, wenn es für eine Art keine eigene Vorlage gibt', () => {
    expect(keineVorlageHinweis('zaehler')).toMatch(/Für Zähler gibt es noch keine eigene Vorlage/);
    expect(keineVorlageHinweis('zaehler')).toMatch(/Netz-Zähler/);
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

  it('fuehrt das I/O-Modul unter den schaltbaren Verbrauchern', () => {
    const io = tpl({
      templateRef: 'builtin:ebyte:m31_axax8080g_u',
      brand: 'ebyte',
      brandLabel: 'Ebyte',
      deviceType: 'io_module',
      communication: 'ebyte_modbus_tcp',
    });
    expect(geraeteFuerTyp([...alle, io], 'verbraucher').templates).toContain(io);
    expect(geraeteFuerTyp([...alle, io], 'wechselrichter').templates).not.toContain(io);
    expect(typFuerTemplate(io)).toBe('verbraucher');
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

  it('schlaegt beim zweiten Wechselrichter den weiteren Erzeuger vor - und sperrt die Wechselrichter-Rolle mit Grund', () => {
    expect(vorschlagRolle('wechselrichter', [])).toBe('inverter');
    expect(vorschlagRolle('wechselrichter', ['inverter'])).toBe('pv-generation');
    // Genau EIN Wechselrichter je Anlage: der Server lehnte den zweiten erst beim Speichern ab
    // (409, nach Adresse und Test). Jetzt steht es an der Aufgabe, mit dem nächsten Schritt.
    const [wr, erzeuger] = rollenWahl('wechselrichter', ['inverter'], { inverter: 'Deye Scheune' });
    expect(wr.verfuegbar).toBe(false);
    expect(wr.grund).toContain('bereits einen Wechselrichter („Deye Scheune“)');
    expect(wr.grund).toContain('Bearbeiten Sie ihn im Aufbau');
    expect(erzeuger.verfuegbar).toBe(true);
  });

  it('die elektrische Speicher-Absicht gilt, solange die Anlage keinen angebundenen Wechselrichter hat', () => {
    // Eine nur komponierte, nie eingerichtete Zeile zählt nicht (`vorhandeneGeraete` lässt sie weg).
    expect(vorschlagRolle('wechselrichter', [], 'inverter')).toBe('inverter');
    // Mit einem angebundenen Wechselrichter ist die Rolle gesperrt - der Slot kann sie nicht erzwingen.
    expect(vorschlagRolle('wechselrichter', ['inverter'], 'inverter')).toBe('pv-generation');
    // Eine Rolle, die nicht zu dieser Typ-Karte gehört, wird nie eingeschleust.
    expect(vorschlagRolle('wechselrichter', [], 'consumer')).toBe('inverter');
  });

  it('schlaegt nichts vor, wo nichts frei ist', () => {
    expect(vorschlagRolle('zaehler', ['grid-meter'])).toBeNull();
    expect(vorschlagRolle('ladesaeule', [])).toBeNull();
  });
});

/**
 * Live-Fall „Zuhause" (02.11.2026): die Plattform komponiert beim Verbinden der Box Netz und Haus
 * und aus den Eckdaten des Speichers die Wechselrichter-Zeile - alle OHNE Anbindung, der Server
 * füllt sie beim Speichern. Zählte die Fläche sie als Geräte, sperrte sie den Netz-Zähler auf
 * jeder Anlage mit Box und schlüge „Weiterer Erzeuger" vor, wo der Kunde seinen ERSTEN
 * Wechselrichter einrichtet.
 */
describe('vorhandeneGeraete', () => {
  const zeile = (o: Partial<SiteComponentRow> & Pick<SiteComponentRow, 'id'>): SiteComponentRow =>
    ({ definitionVersion: 1, ...o }) as SiteComponentRow;

  it('zaehlt nur angebundene Zeilen - die komponierte Grundausstattung ist kein Gerät', () => {
    const komponiert = [
      zeile({ id: 'netz', role: 'grid-meter', entityType: 'grid-meter' }),
      zeile({ id: 'haus', role: 'house-load', entityType: 'house-load' }),
      zeile({ id: 'wr', role: 'battery-hybrid', entityType: 'battery-hybrid', connection: null }),
    ];
    expect(vorhandeneGeraete(komponiert)).toEqual({ rollen: [], namen: {} });
    expect(rollenWahl('wechselrichter', vorhandeneGeraete(komponiert).rollen).every((r) => r.verfuegbar)).toBe(true);
    expect(rollenWahl('zaehler', vorhandeneGeraete(komponiert).rollen)[0].verfuegbar).toBe(true);
  });

  it('spricht die Rollen des Assistenten und nennt das Gerät beim Namen', () => {
    const geraete = [
      zeile({ id: 'wr', role: 'battery-hybrid', entityType: 'battery-hybrid', label: 'Deye Scheune', connection: { ip: '192.168.0.28', serial: '2985159064' } }),
      zeile({ id: 'netz', role: 'grid-meter', entityType: 'grid-meter', label: null, connection: { ip: '192.168.0.9' } }),
      zeile({ id: 'wb', role: 'consumer', entityType: 'wallbox', label: 'Wallbox', connection: { ip: '192.168.0.40' } }),
    ];
    expect(vorhandeneGeraete(geraete)).toEqual({
      rollen: ['inverter', 'grid-meter', 'consumer'],
      namen: { inverter: 'Deye Scheune', 'grid-meter': null, consumer: 'Wallbox' },
    });
    const [wr] = rollenWahl('wechselrichter', vorhandeneGeraete(geraete).rollen, vorhandeneGeraete(geraete).namen);
    expect(wr.grund).toContain('„Deye Scheune“');
  });

  it('die bearbeitete Zeile zaehlt nicht als „schon da"', () => {
    const geraete = [zeile({ id: 'wr', role: 'battery-hybrid', connection: { ip: '192.168.0.28' } })];
    expect(vorhandeneGeraete(geraete, 'wr').rollen).toEqual([]);
  });
});

describe('Fortschritt (Schale des Steuerart-Dialogs)', () => {
  it('zaehlt den Fortschritt, ohne ueber den Rand zu laufen', () => {
    const s = ['A', 'B', 'C', 'D'];
    expect(fortschritt(s, 2)).toBe('Schritt 2 von 4');
    expect(fortschritt(s, 0)).toBe('Schritt 1 von 4');
    // Hinter dem letzten Schritt steht das Ergebnis - kein „Schritt 5 von 4".
    expect(fortschritt(s, 5)).toBe('Fertig');
    expect(fortschrittAnteil(s, 5)).toBe(1);
    expect(fortschrittAnteil([], 1)).toBe(0);
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

/**
 * Der erste echte Zähler im Katalog (06.11.2026, Shelly Pro 3EM): am Hausanschluss Netz-Zähler, in einer
 * Unterverteilung Unterzähler (Werner Schramm: 3EM-400 am Netzanschluss, „UV Halle“ und „UV Keller“). Ein Gerät,
 * über das nur gemessen wird, bleibt Netz-Zähler - als Unterzähler könnte die Box ihm keine Rolle zuordnen.
 */
describe('Zähler-Vorlage: Netz-Zähler oder Unterzähler', () => {
  it('fragt bei einer Zähler-Vorlage nach Netz-Zähler oder Unterzähler', () => {
    const wahl = rollenWahl('zaehler', [], {}, 'meter');
    expect(wahl.map((r) => r.rolle)).toEqual(['grid-meter', 'consumer']);
    expect(wahl[1].label).toBe('Unterzähler');
    expect(wahl[1].hint).toMatch(/Unterverteilung/);
    expect(wahl.every((r) => r.verfuegbar)).toBe(true);
    expect(vorschlagRolle('zaehler', [], null, 'meter')).toBe('grid-meter');
  });

  it('schlägt nach dem Netz-Zähler den Unterzähler vor', () => {
    const [netz, unter] = rollenWahl('zaehler', ['grid-meter'], {}, 'meter');
    expect(netz.verfuegbar).toBe(false);
    expect(unter.verfuegbar).toBe(true);
    expect(vorschlagRolle('zaehler', ['grid-meter', 'consumer'], null, 'meter')).toBe('consumer');
  });

  it('ein Gerät, über das gemessen wird, bleibt Netz-Zähler', () => {
    expect(rollenWahl('zaehler', [], {}, 'inverter').map((r) => r.rolle)).toEqual(['grid-meter']);
    expect(rollenWahl('zaehler', []).map((r) => r.rolle)).toEqual(['grid-meter']);
    expect(vorschlagRolle('zaehler', ['grid-meter'], null, 'inverter')).toBeNull();
  });

  it('der Verbraucher außerhalb des Zählers behält seine Worte', () => {
    expect(rollenWahl('verbraucher', [], {}, 'switch')[0].label).toBe('Verbraucher');
    expect(typFuerTemplate(tpl({ templateRef: 'builtin:shelly:shelly-pro-3em', deviceType: 'meter' }))).toBe('zaehler');
  });
});
