import { describe, expect, it } from 'vitest';
import type { SiteComponentTemplate } from './api';
import { keineVorlageHinweis } from './anlegenFlow';
import type { AufbauBaum } from './aufbauBaum';
import {
  WEGE,
  einrichtenUnterzeile,
  katalogAnsicht,
  katalogFunde,
  katalogChips,
  kategorieVon,
  markenEintraege,
  modellTitel,
  wahlFuer,
  type KatalogAnsicht,
  type KatalogEingabe,
  type KatalogFund,
} from './geraeteKatalog';
import type { ComponentTemplate } from './komponentenAssistent';

const tpl = (o: Partial<ComponentTemplate> & Pick<ComponentTemplate, 'templateRef' | 'brand' | 'brandLabel' | 'modelLabel'>): ComponentTemplate => ({
  kind: 'builtin',
  version: 1,
  model: o.modelLabel.toLowerCase(),
  communication: 'solarman_v5',
  communicationLabel: 'Solarman-V5 (WiFi-Datenlogger, TCP 8899)',
  deviceType: 'inverter',
  ...o,
});

const DEYE = ['SUN-5K-SG04LP3-EU', 'SUN-8K-SG04LP3-EU', 'SUN-12K-SG04LP3-EU'].map((m) =>
  tpl({ templateRef: `builtin:deye:${m}`, brand: 'deye', brandLabel: 'Deye', modelLabel: m }),
);
const KACO = [
  tpl({ templateRef: 'builtin:kaco:bp10', brand: 'kaco', brandLabel: 'KACO', modelLabel: 'blueplanet 10.0 TL3', communication: 'sunspec_tcp', communicationLabel: 'SunSpec Modbus TCP (TCP 502)' }),
  tpl({ templateRef: 'builtin:kaco:hy10', brand: 'kaco', brandLabel: 'KACO', modelLabel: 'blueplanet hybrid 10.0 NH3 M3', communication: 'kaco_http', communicationLabel: 'App-Schnittstelle der Kommunikationseinheit (HTTP 8484)' }),
];
const GOE = tpl({ templateRef: 'builtin:goe:charger', brand: 'go-e', brandLabel: 'go-e', modelLabel: 'go-e Charger', deviceType: 'wallbox', communication: 'goe_http_api', communicationLabel: 'go-e HTTP API v2 (HTTP/JSON)' });
const SHELLY = tpl({ templateRef: 'builtin:shelly:relais', brand: 'shelly', brandLabel: 'Shelly', modelLabel: 'Shelly Relais / Schaltaktor', deviceType: 'switch', communication: 'shelly_http', communicationLabel: 'Shelly HTTP API (lokal)' });
const EBYTE = tpl({ templateRef: 'builtin:ebyte:m31', brand: 'ebyte', brandLabel: 'Ebyte', modelLabel: 'M31-AXAX8080G-U (8 Eingänge, 8 Relais)', deviceType: 'io_module', communication: 'ebyte_modbus_tcp', communicationLabel: 'Modbus TCP (lokal)' });
const OHNE_TYP = tpl({ templateRef: 'certified:x', brand: 'acme', brandLabel: 'ACME', modelLabel: 'Messgerät X', deviceType: null });

const ALLE = [...DEYE, ...KACO, GOE, SHELLY, EBYTE];

const VORLAGE: SiteComponentTemplate = {
  templateRef: 'site:wp',
  version: 1,
  label: 'Wärmepumpe Keller',
  communication: 'modbus_baukasten',
  channels: [{}, {}, {}],
};

const FUND: KatalogFund = {
  quelle: {
    id: 'src-7',
    role: 'pv-generation',
    brand: 'fronius',
    model: null,
    label: null,
    roleLabel: 'Erzeuger',
    summary: 'Erzeuger · 192.0.2.31',
    suggestedType: 'producer',
  },
  titel: 'Fronius gefunden',
  unterzeile: 'Erzeuger · 192.0.2.31',
  boxName: 'Box Scheune',
};

const ansicht = (o: Partial<KatalogEingabe> = {}): KatalogAnsicht =>
  katalogAnsicht({ templates: ALLE, vorlagen: [VORLAGE], funde: [FUND], q: '', chip: 'alle', marke: null, ...o });
const gruppen = (a: KatalogAnsicht) => a.gruppen.map((g) => `${g.titel}: ${g.eintraege.map((x) => x.titel).join(', ')}`);

describe('kategorieVon', () => {
  it('ordnet nach der Gerätetyp-Dimension - ohne Typ nie geraten', () => {
    expect(kategorieVon(DEYE[0])).toBe('wr');
    expect(kategorieVon(GOE)).toBe('laden');
    expect(kategorieVon(SHELLY)).toBe('schalten');
    expect(kategorieVon(EBYTE)).toBe('schalten');
    expect(kategorieVon(tpl({ ...GOE, deviceType: 'meter' }))).toBe('zaehler');
    expect(kategorieVon(OHNE_TYP)).toBe('weitere');
  });

  it('nennt die Marke nur, wenn das Modell sie nicht schon trägt', () => {
    expect(modellTitel(DEYE[2])).toBe('Deye SUN-12K-SG04LP3-EU');
    expect(modellTitel(GOE)).toBe('go-e Charger');
    expect(modellTitel(SHELLY)).toBe('Shelly Relais / Schaltaktor');
  });
});

describe('katalogChips', () => {
  it('zählt je Art - die Wege ohne Vorlage zählen mit', () => {
    const chips = katalogChips(ALLE, [VORLAGE]);
    expect(chips.map((c) => `${c.label} ${c.anzahl ?? '-'}`)).toEqual([
      'Alle -',
      'Wechselrichter 5',
      'Laden 2',
      'Schalten 2',
      'Batterie 1',
      'Zähler -',
      'Selbst beschreiben 2',
    ]);
  });

  it('zeigt „Weitere Geräte" nur, wenn es Vorlagen ohne Typ gibt', () => {
    expect(katalogChips([...ALLE, OHNE_TYP], []).map((c) => c.id)).toContain('weitere');
    expect(katalogChips(ALLE, []).map((c) => c.id)).not.toContain('weitere');
  });
});

describe('katalogAnsicht — blättern', () => {
  it('zeigt unter „Alle" zuerst das Gemeldete, dann die Arten - Wechselrichter nach Marke (K1)', () => {
    const a = ansicht();
    expect(gruppen(a)).toEqual([
      'Von Ihrer Box gemeldet: Fronius gefunden',
      'Wechselrichter: Deye, KACO',
      'Laden: go-e Charger, Ladesäule mit OCPP 1.6',
      'Schalten: Ebyte M31-AXAX8080G-U (8 Eingänge, 8 Relais), Shelly Relais / Schaltaktor',
      'Batterie: Batterie mit eigenem BMS',
      'Selbst beschreiben: Modbus-TCP-Gerät, Wärmepumpe Keller',
    ]);
    expect(a.gruppen[1].rechts).toBe('5 Modelle');
    // Kein Hinweis-Kasten über allem - das Ehrliche zum Zähler steht unter „Zähler".
    expect(a.hinweis).toBeNull();
  });

  it('beschreibt eine Marke mit Zahl und Anbindung in Kundenworten', () => {
    const [deye, kaco] = markenEintraege([...DEYE, ...KACO]);
    expect(deye.zusatz).toBe('3 Modelle · Solarman-Logger (WLAN-Stick)');
    expect(kaco.zusatz).toBe('2 Modelle · verschiedene Anschlüsse');
  });

  it('klappt eine Marke zu ihren Modellen auf - mit Rückweg', () => {
    const a = ansicht({ chip: 'wr', marke: 'deye' });
    expect(gruppen(a)).toEqual(['Deye: Deye SUN-12K-SG04LP3-EU, Deye SUN-5K-SG04LP3-EU, Deye SUN-8K-SG04LP3-EU']);
    expect(a.zurueck).toBe('Wechselrichter');
  });

  it('sagt beim Zähler ehrlich, dass es keine Vorlage gibt, und bietet das messende Gerät an (K2)', () => {
    const a = ansicht({ chip: 'zaehler' });
    expect(a.hinweis).toBe(keineVorlageHinweis('zaehler'));
    expect(a.gruppen[0].titel).toBe('Gerät wählen, über das gemessen wird');
    expect(a.gruppen[0].eintraege.map((e) => e.titel)).toEqual(['Deye', 'Ebyte', 'go-e', 'KACO', 'Shelly']);
  });

  it('erklärt Laden, das I/O-Modul und die fehlenden Batterie-Modelle', () => {
    expect(ansicht({ chip: 'laden' }).hinweis).toMatch(/meldet sich selbst bei Ihrer Box/);
    expect(ansicht({ chip: 'schalten' }).hinweis).toMatch(/jeden Ausgang einem Verbraucher/);
    expect(ansicht({ chip: 'batterie' }).hinweis).toMatch(/Fertige Batterie-Modelle gibt es im Katalog noch nicht/);
  });

  it('zeigt unter „Selbst beschreiben" den Modbus-Weg und die Verwaltung eigener Vorlagen (K4)', () => {
    const a = ansicht({ chip: 'selbst' });
    expect(gruppen(a)).toEqual(['Selbst beschreiben: Modbus-TCP-Gerät']);
    expect(a.vorlagenVerwalten).toBe(true);
  });

  it('sagt beim OCPP-Weg, dass sich die Säule selbst meldet', () => {
    expect(WEGE.ocpp.zusatz).toMatch(/meldet sich selbst bei Ihrer Box/);
    expect(WEGE.ocpp.zusatz).not.toMatch(/wählt/);
  });
});

describe('katalogAnsicht — Suche', () => {
  it('findet ein Modell in jeder Schreibweise', () => {
    expect(gruppen(ansicht({ q: 'sun12k' }))).toEqual(['Wechselrichter: Deye SUN-12K-SG04LP3-EU']);
    expect(gruppen(ansicht({ q: 'SUN-12K' }))).toEqual(['Wechselrichter: Deye SUN-12K-SG04LP3-EU']);
  });

  it('findet die Wege über ihre Stichwörter', () => {
    expect(gruppen(ansicht({ q: 'ocpp' }))).toEqual(['Laden: Ladesäule mit OCPP 1.6']);
    expect(gruppen(ansicht({ q: 'seplos' }))).toEqual(['Batterie: Batterie mit eigenem BMS']);
  });

  it('findet eigene Vorlagen und was die Box meldet', () => {
    expect(gruppen(ansicht({ q: 'wärmepumpe' }))).toEqual(['Eigene Vorlagen: Wärmepumpe Keller']);
    expect(gruppen(ansicht({ q: 'fronius' }))).toEqual(['Von Ihrer Box gemeldet: Fronius gefunden']);
  });

  it('schlägt ohne Treffer die Wege vor - nie ein stiller leerer Bereich', () => {
    const a = ansicht({ q: 'keba' });
    expect(a.leer).toMatch(/Kein Eintrag passt zu „keba"/);
    expect(gruppen(a)).toEqual(['Passende Wege: Ladesäule mit OCPP 1.6, Batterie mit eigenem BMS, Modbus-TCP-Gerät']);
  });

  it('bleibt in der gewählten Art', () => {
    expect(gruppen(ansicht({ q: 'go-e', chip: 'wr' }))).toEqual(['Passende Wege: Ladesäule mit OCPP 1.6, Batterie mit eigenem BMS, Modbus-TCP-Gerät']);
    expect(gruppen(ansicht({ q: 'go-e', chip: 'laden' }))).toEqual(['Laden: go-e Charger']);
  });

  it('verschweigt den Deckel nie', () => {
    const viele = Array.from({ length: 20 }, (_, i) =>
      tpl({ templateRef: `builtin:deye:x${i}`, brand: 'deye', brandLabel: 'Deye', modelLabel: `SUN-${i + 1}K` }),
    );
    const a = katalogAnsicht({ templates: viele, vorlagen: [], funde: [], q: 'sun', chip: 'alle', marke: null });
    expect(a.zaehler).toBe('12 von 20 Treffern - Suche verfeinern zeigt die übrigen.');
  });
});

describe('wahlFuer', () => {
  it('macht über „Zähler" aus dem Gerät den Netz-Zähler - sonst entscheidet die Vorlage', () => {
    const eintrag = ansicht({ q: 'sun12k' }).gruppen[0].eintraege[0];
    expect(wahlFuer(eintrag, 'zaehler')).toMatchObject({ art: 'modell', rolle: 'grid-meter' });
    expect(wahlFuer(eintrag, 'alle')).toMatchObject({ art: 'modell', rolle: null });
  });

  it('klappt eine Marke nur auf und öffnet die Wege, Vorlagen und Funde', () => {
    const a = ansicht();
    const marke = a.gruppen[1].eintraege[0];
    expect(wahlFuer(marke, 'alle')).toBeNull();
    expect(wahlFuer(a.gruppen[0].eintraege[0], 'alle')).toMatchObject({ art: 'fund' });
    expect(wahlFuer(a.gruppen[2].eintraege[1], 'alle')).toEqual({ art: 'weg', weg: 'ocpp' });
    expect(wahlFuer(a.gruppen[5].eintraege[1], 'alle')).toMatchObject({ art: 'vorlage' });
  });
});

describe('einrichtenUnterzeile', () => {
  it('nennt Leistung, Bauart und Anbindung in Kundenworten - fehlt etwas, fehlt es', () => {
    const t = tpl({
      templateRef: 'builtin:deye:12k',
      brand: 'deye',
      brandLabel: 'Deye',
      modelLabel: 'SUN-12K-SG04LP3-EU',
      ratedKw: 12,
      familyLabel: 'Hybrid, 3-phasig',
    });
    expect(einrichtenUnterzeile(t)).toBe('12 kW · Hybrid, 3-phasig · Solarman-Logger (WLAN-Stick)');
    expect(einrichtenUnterzeile({ ...t, ratedKw: null, familyLabel: null, communication: 'neu', communicationLabel: 'Eigenes Protokoll' })).toBe(
      'Eigenes Protokoll',
    );
  });
});

describe('katalogFunde', () => {
  const geraet = (id: string, art: string, boxName?: string) => ({
    id,
    art,
    titel: `${id} gefunden`,
    unterzeile: 'Erzeuger · 192.0.2.31',
    karte: { quelle: art === 'neu' ? { ...FUND.quelle, id } : undefined },
    boxName,
  });
  const baum = {
    wurzel: null,
    boxZahl: 1,
    anlagen: [
      {
        id: 'a1',
        aktuell: true,
        boxen: [{ id: 'b1', name: 'Box Scheune', geraete: [geraet('src-1', 'neu'), geraet('inv', 'geraet')] }],
        ohneBox: [geraet('src-2', 'neu')],
      },
      { id: 'a2', aktuell: false, boxen: [{ id: 'b2', name: 'Box Hof', geraete: [geraet('src-9', 'neu')] }], ohneBox: [] },
    ],
  } as unknown as AufbauBaum;

  it('nimmt nur, was die Box der geöffneten Anlage meldet - mit der meldenden Box', () => {
    expect(katalogFunde(baum).map((f) => [f.quelle.id, f.boxName])).toEqual([
      ['src-1', 'Box Scheune'],
      ['src-2', null],
    ]);
  });
});
