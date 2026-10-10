import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EinstellungFassung, GeraetEinstellungen, Messkanal, UemsGeraet } from './api';
import {
  aenderungPruefen,
  eingetragenText,
  einstellungGruppen,
  eintragenText,
  felderAusWert,
  geraetKarte,
  jetztEingabe,
  kadenzText,
  kanalZeile,
  NICHT_ERFASST,
  wertAusFeldern,
  zeitpunktAus,
  ZEIT_SAETZE,
  type AenderungEingabe,
} from './geraetEinstellungen';

/**
 * Die Geräteseite ergänzt (UEMS AP-04 IP-12) — die reinen Ableitungen der drei
 * Karten und des Dialogs „Ändern ab <Zeitpunkt>“, am Referenzunternehmen
 * Ahrenberg: GR-4 mit dem Zählerwechsel Z-5a → Z-5b (18.11.2026 10:40, A1) und
 * EK-2 am Controller C-1 mit dem Wandler 250/5 → 400/5 A (A5).
 */

const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vectors: any = JSON.parse(readFileSync(resolve(V2, 'quelle-einstellung-vectors.json'), 'utf8'));

const EK2 = 'k-8-2';
const C1_EINBAU = '2026-10-01T00:00:00+02:00';

function fassung(over: Partial<EinstellungFassung> = {}): EinstellungFassung {
  return {
    id: 'f-1',
    entity_id: EK2,
    kanal: null,
    art: 'wandler_strom',
    art_kundenwort: 'Wandlerverhältnis Strom',
    wert: { primaer_a: 250, sekundaer_a: 5 },
    wert_text: '250/5 A',
    anwendung: 'angewendet',
    anwendung_text: 'angewendet — mit der Verbindung zugestellt',
    zustellung: 'verbindung',
    herkunft: 'bestand',
    gueltig_ab: C1_EINBAU,
    gueltig_bis: null,
    status: 'gueltig',
    tatsaechlich_ab: null,
    rueckwirkend: false,
    begruendung: null,
    eingetragen: { am: C1_EINBAU, von: 'VoltPilot', rolle: null, art: null },
    ...over,
  };
}

function eingabe(over: Partial<AenderungEingabe> = {}): AenderungEingabe {
  return {
    art: 'wandler_strom',
    entityId: EK2,
    kanal: null,
    felder: { primaer_a: '400', sekundaer_a: '5' },
    anwendung: 'angewendet',
    datum: '2027-02-01',
    uhrzeit: '00:00',
    frueher: true,
    tatsaechlichDatum: '2027-01-20',
    tatsaechlichUhrzeit: '00:00',
    begruendung: 'Wandler getauscht',
    ...over,
  };
}

const JETZT = '2027-01-25T09:00:00+01:00';

describe('Folgen-Text der Einstellungs-Änderung (A5-Wortlaut, aus Fakten gebildet)', () => {
  it('A5: 250/5 → 400/5 A, angewendet, tatsächlich am 20.01.2027 — genau die Sätze des Vertrags', () => {
    const a5 = vectors.cases.folgen.find((c: { name: string }) => c.name.startsWith('A5'));
    const u = aenderungPruefen(eingabe(), [fassung()], C1_EINBAU, JETZT);
    expect(u.fehler).toEqual({});
    expect(u.bisher).toBe('250/5 A');
    expect(u.folgen).toEqual(a5.expected);
    expect(u.folgen[1]).toBe(
      'Der Zeitraum vom 20.01.2027 bis 01.02.2027 ist mit 250/5 A erfasst. Berichtigen Sie ihn über eine Korrektur, sobald Korrekturen verfügbar sind.',
    );
    expect(u.neu).toEqual({
      entity_id: EK2,
      kanal: null,
      art: 'wandler_strom',
      wert: { primaer_a: 400, sekundaer_a: 5 },
      anwendung: 'angewendet',
      gueltig_ab: '2027-02-01T00:00:00+01:00',
      tatsaechlich_ab: '2027-01-20T00:00:00+01:00',
      begruendung: 'Wandler getauscht',
    });
  });

  it('ändern sich die Fakten, ändern sich die Sätze — kein fest hinterlegter Satz', () => {
    // A5 nennt 08:00 Uhr; und gälte bis dahin 300/5 A, stünde 300/5 A im Satz.
    const u = aenderungPruefen(
      eingabe({ uhrzeit: '08:00', tatsaechlichUhrzeit: '06:30' }),
      [fassung({ wert: { primaer_a: 300, sekundaer_a: 5 }, wert_text: '300/5 A' })],
      C1_EINBAU,
      JETZT,
    );
    expect(u.folgen).toEqual([
      'Werte vor dem 01.02.2027, 08:00 Uhr bleiben unverändert.',
      'Der Zeitraum vom 20.01.2027, 06:30 Uhr bis 01.02.2027, 08:00 Uhr ist mit 300/5 A erfasst. Berichtigen Sie ihn über eine Korrektur, sobald Korrekturen verfügbar sind.',
      'Die Zustellung an die VoltPilot-Box steht noch aus; bis dahin erfasst sie wie bisher. Bereits erfasste Werte berechnet VoltPilot nie neu.',
    ]);
  });

  it('A4: im Gerät eingestellt, ohne früheren Zeitpunkt — der Wandler-Satz und „rechnet nichts um“', () => {
    const a4 = vectors.cases.folgen.find((c: { name: string }) => c.name.startsWith('A4'));
    const u = aenderungPruefen(
      eingabe({
        entityId: null,
        felder: { primaer_a: '1000', sekundaer_a: '5' },
        anwendung: 'dokumentiert',
        datum: '2027-01-15',
        uhrzeit: '09:00',
        frueher: false,
      }),
      [
        fassung({
          entity_id: null,
          wert: { primaer_a: 600, sekundaer_a: 5 },
          wert_text: '600/5 A',
          anwendung: 'dokumentiert',
          gueltig_ab: '2024-03-12T00:00:00+01:00',
        }),
      ],
      '2024-03-12T00:00:00+01:00',
      '2027-01-10T09:00:00+01:00',
    );
    expect(u.folgen).toEqual(a4.expected);
    expect(u.neu?.tatsaechlich_ab).toBeNull();
  });

  it('eine Fassung einer ANDEREN Quelle ist kein Vorgänger', () => {
    const u = aenderungPruefen(eingabe({ frueher: false }), [fassung({ entity_id: 'k-8-1' })], C1_EINBAU, JETZT);
    expect(u.bisher).toBeNull();
    expect(u.folgen[1]).toMatch(/^Wenn der Wandler schon früher getauscht wurde/);
  });
});

describe('Prüfung vor dem Eintragen — dieselbe Reihenfolge wie der Server', () => {
  it('ohne gültigen Wert keine Folgen und keine Anfrage', () => {
    const u = aenderungPruefen(eingabe({ felder: { primaer_a: '', sekundaer_a: '5' } }), [fassung()], C1_EINBAU, JETZT);
    expect(u.fehler.wert).toBeDefined();
    expect(u.folgen).toEqual([]);
    expect(u.neu).toBeNull();
  });

  it('unverändert, Beginn belegt, vor dem Einbau, tatsächlich nach „gilt ab“', () => {
    const bestand = [fassung()];
    expect(aenderungPruefen(eingabe({ felder: felderAusWert('wandler_strom', { primaer_a: 250, sekundaer_a: 5 }), frueher: false }), bestand, C1_EINBAU, JETZT).fehler)
      .toEqual({ wert: 'Das ist schon der Wert, der zu diesem Zeitpunkt gilt.' });
    expect(aenderungPruefen(eingabe({ datum: '2026-10-01', frueher: false }), bestand, C1_EINBAU, JETZT).fehler.gueltig_ab)
      .toBe('Zu diesem Zeitpunkt beginnt schon eine Fassung dieser Einstellung.');
    expect(aenderungPruefen(eingabe({ datum: '2026-09-30', frueher: false }), bestand, C1_EINBAU, JETZT).fehler.gueltig_ab)
      .toBe('Zu diesem Zeitpunkt war das Gerät noch nicht eingebaut.');
    expect(aenderungPruefen(eingabe({ tatsaechlichDatum: '2027-02-02' }), bestand, C1_EINBAU, JETZT).fehler)
      .toEqual({ tatsaechlich_ab: 'Die tatsächliche Änderung liegt vor „Gilt ab“ und nicht vor dem Einbau.' });
  });

  it('die Uhrzeit der Zeitumstellung wird nie geraten', () => {
    expect(zeitpunktAus('2027-03-28', '02:30')).toEqual({ fehler: ZEIT_SAETZE.nicht_vorhanden });
    expect(zeitpunktAus('2026-10-25', '02:30')).toEqual({ fehler: ZEIT_SAETZE.zweimal });
    expect(zeitpunktAus('2026-10-25', '03:30')).toEqual({ iso: '2026-10-25T03:30:00+01:00' });
    expect(zeitpunktAus('', '08:00')).toEqual({ fehler: ZEIT_SAETZE.datum_fehlt });
  });

  it('Werte aus den Feldern: Dezimalkomma, ja/nein, Text', () => {
    expect(wertAusFeldern('skalierung', { faktor: '0,1' })).toEqual({ faktor: 0.1 });
    expect(wertAusFeldern('vorzeichen_umgekehrt', { umgekehrt: 'ja' })).toEqual({ umgekehrt: true });
    expect(wertAusFeldern('offset', { wert: '-2', einheit: ' °C ' })).toEqual({ wert: -2, einheit: '°C' });
    expect(felderAusWert('offset', { wert: 1.5, einheit: 'kW' })).toEqual({ wert: '1,5', einheit: 'kW' });
    expect(felderAusWert('skalierung', { automatisch: true })).toEqual({ faktor: '' });
  });

  it('der Knopf nennt den Zeitpunkt, „jetzt“ ist die Minute in Europe/Berlin', () => {
    expect(eintragenText('2027-02-01', '08:00')).toBe('Ab 01.02.2027, 08:00 Uhr eintragen');
    expect(eintragenText('2027-02-01', '00:00')).toBe('Ab 01.02.2027 eintragen');
    expect(eintragenText('', '08:00')).toBe('Eintragen');
    expect(jetztEingabe('2026-11-18T09:40:31Z')).toEqual({ datum: '2026-11-18', uhrzeit: '10:40' });
  });

  it('nach dem Eintragen: Wert, Zeitpunkt und die Messstellen des Protokolls', () => {
    expect(
      eingetragenText({
        fassung: fassung({ wert_text: '400/5 A', gueltig_ab: '2027-02-01T08:00:00+01:00' }),
        beendet: fassung(),
        folgen: [],
        messstellen: ['MS-11'],
      }),
    ).toBe('Eingetragen: Wandlerverhältnis Strom 400/5 A ab 01.02.2027, 08:00 Uhr. Im Protokoll von MS-11 vermerkt.');
  });
});

describe('Kanal-Zeile: welche Messstelle ein Kanal speist, und ob führend', () => {
  const kanal = (over: Partial<Messkanal> = {}): Messkanal => ({
    kanal: 'energy_import_kwh',
    anzeigename: 'Wirkenergie Bezug',
    einheit: 'kWh',
    wertart: 'counter',
    groesse: 'Wirkenergie',
    richtung: 'Bezug',
    aktiv: true,
    kadenz_s: 900,
    speist: [],
    ...over,
  });
  const speist = (messstelle: string, rolle: 'fuehrend' | 'vergleich', zweck: string | null = null) => ({
    messstelle_id: `id-${messstelle}`,
    messstelle,
    groesse: 'Wirkenergie',
    richtung: 'Bezug',
    rolle,
    zweck,
    gueltig_ab: '2026-11-18T10:40:00+01:00',
    gueltig_bis: null,
  });

  it('K-5 · Wirkenergie Bezug: „speist MS-06 (führend)“', () => {
    const z = kanalZeile(kanal({ speist: [speist('MS-06', 'fuehrend')] }), 'k-5');
    expect(z.name).toBe('Wirkenergie Bezug');
    expect(z.detail).toBe('Zählerstand · kWh · alle 15 min');
    expect(z.speist).toEqual([{ text: 'speist MS-06 (führend)', fuehrend: true }]);
    expect(z.abgewaehlt).toBe(false);
  });

  it('ein Vergleich trägt seine Rolle und seinen Zweck — und steht hinter der führenden', () => {
    const z = kanalZeile(kanal({ speist: [speist('MS-01', 'vergleich', 'Plausibilität'), speist('MS-06', 'fuehrend')] }));
    expect(z.speist).toEqual([
      { text: 'speist MS-06 (führend)', fuehrend: true },
      { text: 'speist MS-01 (Vergleich · Plausibilität)', fuehrend: false },
    ]);
  });

  it('ohne Bindung keine Marke; ohne Katalog-Name der Kanal-Name; abgewählt bleibt sichtbar', () => {
    const z = kanalZeile(kanal({ anzeigename: null, kanal: 'power_kw', wertart: null, kadenz_s: null, aktiv: false, speist: undefined }));
    expect(z.name).toBe('Leistung');
    expect(z.detail).toBe('kWh');
    expect(z.speist).toEqual([]);
    expect(z.abgewaehlt).toBe(true);
  });

  it('Kadenz in Worten', () => {
    expect(kadenzText(10)).toBe('alle 10 s');
    expect(kadenzText(300)).toBe('alle 5 min');
    expect(kadenzText(3600)).toBe('alle 1 h');
    expect(kadenzText(90)).toBe('alle 90 s');
    expect(kadenzText(null)).toBeNull();
  });
});

describe('Karte „Gerät“', () => {
  const gr4 = (over: Partial<UemsGeraet> = {}): UemsGeraet => ({
    id: 'g-z5b',
    kennzeichen: 'GR-4',
    einbau_kennzeichen: 'Z-5b',
    geraeteart: 'zaehler',
    hersteller: null,
    typ: null,
    seriennummer: '88231',
    bezeichnung: null,
    eingebaut_am: '2026-11-18T10:40:00+01:00',
    ausgebaut_am: null,
    aus_bestand: false,
    komponenten: [{ entity_id: 'k-5', gueltig_ab: '2026-11-18T10:40:00+01:00', gueltig_bis: null }],
    teile: [],
    vorgaenger: [
      {
        id: 'g-z5a',
        einbau_kennzeichen: 'Z-5a',
        hersteller: null,
        typ: null,
        seriennummer: '4471023',
        eingebaut_am: '2024-03-12T00:00:00+01:00',
        ausgebaut_am: '2026-11-18T10:40:00+01:00',
      },
    ],
    ...over,
  });
  const namen = { komponenten: new Map([['k-5', 'Unterzähler Spritzguss SG01–SG06']]), messstellen: ['MS-06', 'MS-06'] };

  it('Z-5b: Typ, Seriennummer, eingebaut am — und der Vorgänger „ausgebaut am …“', () => {
    const k = geraetKarte(gr4(), namen);
    expect(k.titel).toBe('Zähler Z-5b');
    expect(k.kennzeichen).toBe('GR-4');
    expect(k.zeilen).toEqual([
      { label: 'Hersteller und Typ', wert: NICHT_ERFASST },
      { label: 'Seriennummer', wert: '88231' },
      { label: 'Eingebaut am', wert: '18.11.2026, 10:40 Uhr' },
      { label: 'Speist', wert: 'Unterzähler Spritzguss SG01–SG06' },
      { label: 'Messstellen', wert: 'MS-06' },
    ]);
    expect(k.vorgaenger).toEqual([
      { label: 'Z-5a', wert: 'ausgebaut am 18.11.2026, 10:40 Uhr', detail: 'Seriennr. 4471023 · eingebaut am 12.03.2024' },
    ]);
  });

  it('aus dem Bestand abgeleitet: „In VoltPilot seit“, nie „eingebaut am“; ohne Wechsel kein Vorgänger', () => {
    const k = geraetKarte(
      gr4({ einbau_kennzeichen: 'GR-4', seriennummer: null, aus_bestand: true, eingebaut_am: '2024-03-12T00:00:00+01:00', vorgaenger: [] }),
      { komponenten: new Map(), messstellen: [] },
    );
    expect(k.titel).toBe('Zähler GR-4');
    expect(k.kennzeichen).toBeNull();
    expect(k.zeilen).toContainEqual({ label: 'Seriennummer', wert: NICHT_ERFASST });
    expect(k.zeilen).toContainEqual({
      label: 'In VoltPilot seit',
      wert: '12.03.2024',
      detail: 'Beginn des Verlaufs — der Einbautag ist nicht erfasst.',
    });
    expect(k.zeilen).toContainEqual({ label: 'Speist', wert: 'eine weitere Komponente' });
    expect(k.zeilen.some((z) => z.label === 'Messstellen')).toBe(false);
    expect(k.vorgaenger).toEqual([]);
  });

  it('Controller C-1: Hersteller, Typ und die Energiekarten nach Steckplatz', () => {
    const k = geraetKarte(
      gr4({
        kennzeichen: 'GR-7',
        einbau_kennzeichen: 'C-1',
        geraeteart: 'controller',
        hersteller: 'WAGO',
        typ: 'PFC200 750-8212',
        seriennummer: null,
        vorgaenger: [],
        teile: [3, 2].map((steckplatz) => ({
          id: `t-${steckplatz}`,
          teilart: 'energiekarte',
          steckplatz,
          bezeichnung: `EK-${steckplatz - 1}`,
          typ: '750-494/000-001',
          seriennummer: null,
          eingebaut_am: C1_EINBAU,
          ausgebaut_am: null,
        })),
      }),
      namen,
    );
    expect(k.titel).toBe('Controller C-1');
    expect(k.zeilen[0]).toEqual({ label: 'Hersteller und Typ', wert: 'WAGO · PFC200 750-8212' });
    expect(k.karten).toEqual([
      { label: 'Steckplatz 2', wert: 'EK-1', detail: '750-494/000-001' },
      { label: 'Steckplatz 3', wert: 'EK-2', detail: '750-494/000-001' },
    ]);
  });
});

describe('Karte „Einstellungen“: der Wert, der jetzt gilt, und die Historie', () => {
  const einstellungen = (historie: EinstellungFassung[]): GeraetEinstellungen => ({
    geraet_id: 'g-c1',
    geraet: 'GR-7',
    einbau: 'C-1',
    stichtag: JETZT,
    gueltig: [],
    historie,
  });
  const namen = { komponenten: new Map([[EK2, 'Zähler Energiekarte EK-2']]), kanaele: new Map([[`${EK2}|power_kw`, 'Wirkleistung']]) };

  it('A5 angekündigt: gilt 250/5 A, ab 01.02.2027 400/5 A — Historie jüngste zuerst mit „geplant“ und „rückwirkend“', () => {
    const [g] = einstellungGruppen(
      einstellungen([
        fassung({ gueltig_bis: '2027-02-01T00:00:00+01:00' }),
        fassung({
          id: 'f-2',
          wert: { primaer_a: 400, sekundaer_a: 5 },
          wert_text: '400/5 A',
          anwendung_text: 'angewendet — Zustellung ausstehend',
          herkunft: 'eintrag',
          gueltig_ab: '2027-02-01T00:00:00+01:00',
          tatsaechlich_ab: '2027-01-20T00:00:00+01:00',
          begruendung: 'Wandler getauscht',
          eingetragen: { am: '2027-01-25T09:00:00+01:00', von: 'Ines Krämer', rolle: null, art: null },
        }),
      ]),
      JETZT,
      namen,
    );
    expect(g.titel).toBe('Wandlerverhältnis Strom');
    // Die Seite trägt nur EK-2: ihr Name stünde doppelt da. Mit einer zweiten Komponente steht er da.
    expect(g.quelle).toBeNull();
    expect(einstellungGruppen(einstellungen([fassung()]), JETZT, { ...namen, komponenten: new Map([...namen.komponenten, ['k-8-1', 'EK-1']]) })[0].quelle)
      .toBe('Komponente Zähler Energiekarte EK-2');
    expect(g.wert).toBe('250/5 A');
    expect(g.detail).toBe('angewendet — mit der Verbindung zugestellt · gilt seit 01.10.2026');
    expect(g.geplant).toBe('Ab 01.02.2027: 400/5 A');
    expect(g.historie.map((h) => [h.wert, h.zeitraum, h.marken])).toEqual([
      ['400/5 A', 'ab 01.02.2027', ['geplant']],
      ['250/5 A', '01.10.2026 – 01.02.2027', []],
    ]);
    expect(g.historie[0].zeilen).toEqual([
      'angewendet — Zustellung ausstehend',
      'tatsächlich geändert am 20.01.2027',
      'Begründung: Wandler getauscht',
      'eingetragen am 25.01.2027, 09:00 Uhr von Ines Krämer',
    ]);
  });

  it('nach dem 01.02.2027 gilt 400/5 A; rückwirkend steht als Wort da; Reihenfolge wie der Vertrag', () => {
    const gruppen = einstellungGruppen(
      einstellungen([
        fassung({
          id: 'v',
          art: 'vorzeichen_umgekehrt',
          art_kundenwort: 'Vorzeichen umgekehrt',
          kanal: 'power_kw',
          wert: { umgekehrt: true },
          wert_text: 'ja',
          rueckwirkend: true,
        }),
        fassung({ gueltig_bis: '2027-02-01T00:00:00+01:00' }),
        fassung({ id: 'f-2', wert_text: '400/5 A', gueltig_ab: '2027-02-01T00:00:00+01:00' }),
      ]),
      '2027-02-02T12:00:00+01:00',
      namen,
    );
    expect(gruppen.map((g) => [g.titel, g.quelle, g.wert, g.geplant])).toEqual([
      ['Wandlerverhältnis Strom', null, '400/5 A', null],
      ['Vorzeichen umgekehrt', 'Messwert Wirkleistung', 'ja', null],
    ]);
    expect(gruppen[1].historie[0].marken).toEqual(['rückwirkend']);
  });

  it('eine Fassung an einer ANDEREN Komponente desselben Geräts steht nicht auf dieser Seite; eine am Gerät schon', () => {
    const gruppen = einstellungGruppen(
      einstellungen([
        fassung({ entity_id: 'k-8-1', wert_text: '400/5 A' }),
        fassung({ id: 'am-geraet', entity_id: null, art: 'skalierung', art_kundenwort: 'Skalierung', wert_text: '×10' }),
      ]),
      JETZT,
      namen,
    );
    expect(gruppen.map((g) => [g.titel, g.quelle, g.wert])).toEqual([['Skalierung', null, '×10']]);
  });
});
