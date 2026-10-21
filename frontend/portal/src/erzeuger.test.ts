import { describe, expect, it } from 'vitest';
import {
  abschnitte,
  dauer,
  einheitPunkt,
  ERZEUGER_PUNKT as P,
  erzeugerBlatt,
  erzeugerKette,
  erzeugerKnoten,
  erzeugerLage,
  erzeugerSatz,
  erzeugerStatus,
  vorgabeSpuren,
  werHatGeregelt,
  type ErzeugerJetzt,
} from './erzeuger';
import { erzeugerBeispiel } from './test/erzeugerFixtures';

const NOW = new Date(2026, 9, 21, 15, 44, 0);
const sp = (s: string) => s.replace(/ /g, ' ');
const mitternacht = new Date(2026, 9, 21).getTime();

function mit(fall: 'buettner' | 'gore', aenderung: (j: ErzeugerJetzt) => void): ErzeugerJetzt {
  const j = erzeugerBeispiel(fall, NOW);
  aenderung(j);
  return j;
}

describe('erzeugerLage', () => {
  it('Büttner: zwei Motoren, Netzbetreiber 60 %, Abruf 80 kW, kein Netzpunkt (EW-16 C)', () => {
    const l = erzeugerLage(erzeugerBeispiel('buettner', NOW), NOW);
    expect(l.art).toBe('bhkw');
    expect(l.erzeugungKw).toBeCloseTo(58.9);
    // Ohne Netzpunkt gibt es weder Netz noch Hof - nie 0.
    expect(l.netzKw).toBeNull();
    expect(l.hofKw).toBeNull();
    expect(l.gasspeicherPct).toBe(62);
    expect(l.nb).toMatchObject({ kanal: 2, verbunden: true, begrenzt: true, prozent: 60, gehalten: false });
    expect(l.dv).toMatchObject({ kanal: 1, abruf: true, stopp: false, bereit: true, sollKw: 80 });
    expect(l.quelle).toBe('netzbetreiber');
    expect(l.folgt).toBe(true);
    expect(l.grenzeKw).toBeCloseTo(59.4);
    expect(l.einheiten.map((e) => [e.name, e.typName, e.istKw, e.zustand])).toEqual([
      ['Motor 1', 'MAN E0836LE', 39.6, 'laeuft_begrenzt'],
      ['Motor 2', 'Smartblock 33', 19.3, 'laeuft_begrenzt'],
    ]);
    expect(l.veraltet).toBe(false);
  });

  it('Gore: Hof = Erzeugung + Netzpunkt, Leitstelle getrennt hält 100 %', () => {
    const l = erzeugerLage(erzeugerBeispiel('gore', NOW), NOW);
    expect(l.art).toBe('pv');
    expect(l.netzKw).toBeCloseTo(0.1);
    expect(l.hofKw).toBeCloseTo(41.1);
    expect(l.gasspeicherPct).toBeNull();
    expect(l.nb.gehalten).toBe(true);
    expect(l.nb.begrenzt).toBe(false);
    expect(l.quelle).toBe('netzpunkt');
    expect(l.einheiten).toHaveLength(3);
  });

  it('ein Gültigkeitsbit = 0 macht den Wert unbekannt, nie 0 (Lesart 5)', () => {
    const l = erzeugerLage(mit('gore', (j) => {
      j.werte[P.aGueltig].wert = 0b01000; // Netzpunkt nicht gültig
      j.werte[P.sBits].wert = 0; // Wirkung nicht gültig
      j.werte[einheitPunkt(2, 'bits')].wert = 0b10; // Werte der Einheit nicht gültig
    }), NOW);
    expect(l.netzKw).toBeNull();
    expect(l.hofKw).toBeNull();
    expect(l.quelle).toBeNull();
    expect(l.folgt).toBeNull();
    expect(l.grenzeKw).toBeNull();
    expect(l.einheiten[1].istKw).toBeNull();
    expect(l.einheiten[1].zustand).toBeNull();
    expect(l.einheiten[1].sollKw).toBeCloseTo(13.7);
  });

  it('Qualität invalid oder device_error ist kein Wert; ein unbekanntes Aufzählungswort auch nicht', () => {
    const l = erzeugerLage(mit('buettner', (j) => {
      j.werte[P.pErzeugungW].qualitaet = 'device_error';
      j.werte[P.quelleP].wert = 42;
    }), NOW);
    expect(l.erzeugungKw).toBeNull();
    expect(l.quelle).toBeNull();
  });

  it('veraltet: Qualität stale oder Lesung älter als zwei Minuten', () => {
    expect(erzeugerLage(mit('gore', (j) => { j.werte[P.pErzeugungW].qualitaet = 'stale'; }), NOW).veraltet).toBe(true);
    expect(erzeugerLage(erzeugerBeispiel('gore', NOW), new Date(NOW.getTime() + 3 * 60_000)).veraltet).toBe(true);
    expect(erzeugerLage(mit('gore', (j) => { j.werte = {}; }), NOW).veraltet).toBe(true);
  });

  it('nicht bereit: Störung vor dem Direktvermarkter, sonst die Gründe aus t_bits Bit 4–9', () => {
    const gemeldet = erzeugerLage(mit('buettner', (j) => {
      j.werte[P.dvBits].wert = 0b00011; // gültig, Abruf, NICHT bereit gemeldet
      j.werte[einheitPunkt(1, 'bits')].wert = 0b1_0000_0011; // Gasspeicher leer (Bit 8)
    }), NOW);
    expect(gemeldet.nichtBereit).toBe('dem Direktvermarkter nicht bereit gemeldet: Gasspeicher leer');
    expect(erzeugerLage(mit('buettner', (j) => { j.werte[P.anlageZustand].wert = 4; }), NOW).nichtBereit).toBe('Störung');
    expect(erzeugerLage(erzeugerBeispiel('gore', NOW), NOW).nichtBereit).toBeNull();
  });
});

describe('Status oben', () => {
  it('Büttner: Netzbetreiber begrenzt 60 %, Direktvermarkter ruft ab', () => {
    expect(erzeugerStatus(erzeugerLage(erzeugerBeispiel('buettner', NOW), NOW)).map((s) => sp(s.text))).toEqual([
      'Netzbetreiber begrenzt 60 %',
      'Direktvermarkter ruft ab',
    ]);
  });
  it('Gore: Leitstelle getrennt als Warnung, keine Begrenzung bei 100 %', () => {
    expect(erzeugerStatus(erzeugerLage(erzeugerBeispiel('gore', NOW), NOW))).toEqual([
      { key: 'leitstelle', text: 'Leitstelle getrennt', ton: 'warn' },
    ]);
  });
  it('Anlage nicht bereit; veraltete Werte behaupten nichts', () => {
    const l = erzeugerLage(mit('buettner', (j) => { j.werte[P.anlageZustand].wert = 5; }), NOW);
    expect(erzeugerStatus(l).map((s) => s.text)).toContain('Anlage nicht bereit');
    expect(erzeugerStatus(erzeugerLage(erzeugerBeispiel('buettner', NOW), new Date(NOW.getTime() + 600_000)))).toEqual([]);
  });
});

describe('Soll-Kette', () => {
  it('Büttner: Netzbetreiber 60 % › Direktvermarkter 80 kW › ✓ Anlage 58,9 kW, NB strenger', () => {
    const k = erzeugerKette(erzeugerLage(erzeugerBeispiel('buettner', NOW), NOW), NOW);
    expect(k.glieder.map((g) => sp(g.text))).toEqual(['Netzbetreiber 60 %', 'Direktvermarkter 80,0 kW', 'Anlage 58,9 kW']);
    expect(k.glieder.map((g) => g.kurz && sp(g.kurz))).toEqual(['NB 60 %', 'DV 80,0 kW', null]);
    expect(k.glieder.map((g) => g.ton)).toEqual(['ruhig', 'ruhig', 'ok']);
    expect(k.glieder[0].bindet).toBe(true);
    expect(k.pille).toEqual({ text: 'NB strenger', ton: 'info' });
    expect(sp(k.alter ?? '')).toBe('Daten 3 s alt');
  });
  it('Gore: NB 100 % (gehalten) › Nulleinspeisung 41,2 kW › ✓ Anlage 41,0 kW mit einem Hinweis', () => {
    const k = erzeugerKette(erzeugerLage(erzeugerBeispiel('gore', NOW), NOW), NOW);
    expect(k.glieder.map((g) => sp(g.text))).toEqual(['Netzbetreiber 100 % (gehalten)', 'Nulleinspeisung 41,2 kW', 'Anlage 41,0 kW']);
    expect(k.glieder[0].ton).toBe('warn');
    expect(k.pille).toEqual({ text: '1 Hinweis', ton: 'warn' });
  });
  it('folgt die Anlage nicht, wird das letzte Glied bernstein; veraltet bleibt alles ruhig', () => {
    const l = erzeugerLage(mit('buettner', (j) => { j.werte[P.sBits].wert = 0b01; }), NOW);
    expect(erzeugerKette(l, NOW).glieder.at(-1)?.ton).toBe('warn');
    const alt = new Date(NOW.getTime() + 600_000);
    const k = erzeugerKette(erzeugerLage(erzeugerBeispiel('gore', NOW), alt), alt);
    expect(k.glieder.every((g) => g.ton === 'ruhig')).toBe(true);
    expect(k.pille).toBeNull();
    expect(k.alter).toBe('zuletzt 15:43');
  });
});

describe('Blatt „Steuerung jetzt“', () => {
  it('Büttner: die ganze Kette mit Namen, Warum und Grenze', () => {
    const j = erzeugerBeispiel('buettner', NOW);
    const l = erzeugerLage(j, NOW);
    const b = erzeugerBlatt(l, NOW, werHatGeregelt(j, l, mitternacht, NOW.getTime()));
    expect(b.zeilen.map((z) => [z.titel, sp(z.unter), sp(z.wert)])).toEqual([
      ['Netzbetreiber', 'Netz Musterstadt GmbH · Stufe 60 % · seit 14:32', '59,4 kW'],
      ['Direktvermarkter', 'Stadtwerke Beispiel · Abruf seit 13:05 · bereit ✓', '80,0 kW'],
      ['Anlage', 'folgt ✓ · 2 von 2 Motoren laufen', '58,9 kW'],
    ]);
    expect(b.balken).toEqual({ maxKw: 99, istKw: 58.9, nbKw: 59.4, dvKw: 80 });
    expect(Object.fromEntries(b.warum.map(([k, v]) => [k, sp(v)]))).toEqual({
      'Es gilt': '59,4 kW – der Netzbetreiber ist strenger als der Direktvermarkter',
      Seit: '14:32 (1 h 12 min)',
      Daten: '3 s alt · Wago antwortet',
      Heute: 'Netzbetreiber 2× · Direktvermarkter 1×',
    });
    expect(b.grenze.map(([k, v]) => [k, sp(v)])).toEqual([['Wirksam', 'höchstens 59,4 kW'], ['Weg des DV', 'Relais und 4–20 mA']]);
  });
  it('Gore: Leitstelle getrennt, eigene Grenze, cos φ nur mit Vorgabe', () => {
    const j = mit('gore', (x) => { x.werte[P.nbBits].wert = 0b10001; x.werte[P.nbCosphi] = { wert: -0.97, gelesenAm: x.werte[P.nbBits].gelesenAm, qualitaet: 'good' }; });
    const l = erzeugerLage(j, NOW);
    const b = erzeugerBlatt(l, NOW, null);
    expect(b.zeilen.map((z) => z.titel)).toEqual(['Netzbetreiber', 'Nulleinspeisung', 'Anlage']);
    expect(sp(b.zeilen[0].unter)).toBe('Netz Musterstadt GmbH · Leitstelle 100 % · getrennt, Wert gehalten');
    expect(b.zeilen[0].ton).toBe('warn');
    expect(b.zeilen[0].wert).toBe('keine Grenze');
    expect(sp(b.warum[0][1])).toBe('41,2 kW – die Anlage regelt selbst am Netzpunkt (Nulleinspeisung)');
    expect(b.grenze.map(([k, v]) => [k, sp(v)])).toContainEqual(['cos φ', '0,97 untererregt (Vorgabe des Netzbetreibers)']);
  });
});

describe('Bühne', () => {
  it('Satz zur Vorgabe: Büttner ohne Netzpunkt nennt die Erzeugung, Gore die Nulleinspeisung', () => {
    expect(sp(erzeugerSatz(erzeugerLage(erzeugerBeispiel('buettner', NOW), NOW)))).toBe(
      'Der Netzbetreiber begrenzt die Anlage auf 60 %. Sie erzeugt 58,9 kW.',
    );
    expect(erzeugerSatz(erzeugerLage(erzeugerBeispiel('gore', NOW), NOW))).toBe(
      'Die Anlage begrenzt sich selbst: Am Netzpunkt fließt nichts ins Netz.',
    );
    const mitNetz = erzeugerLage(mit('buettner', (j) => { j.werte[P.aGueltig].wert = 0b11001; j.werte[P.pNvpW].wert = -44_300; j.werte[P.pNvpW].qualitaet = 'good'; }), NOW);
    expect(sp(erzeugerSatz(mitNetz))).toBe('Der Netzbetreiber begrenzt die Anlage auf 60 %. Sie speist 44,3 kW ein.');
    expect(mitNetz.hofKw).toBeCloseTo(14.6);
  });
  it('Knoten: Motor oder Sonne je Anlagenart, Hof bei Biogas, Netz ohne Messung', () => {
    expect(erzeugerKnoten(erzeugerLage(erzeugerBeispiel('buettner', NOW), NOW))).toEqual({
      symbol: 'motor', erzeugungZeile: 'Erzeugung · 2 Motoren', lastName: 'Hof', netzZeile: 'ohne Messung',
    });
    expect(erzeugerKnoten(erzeugerLage(erzeugerBeispiel('gore', NOW), NOW))).toEqual({
      symbol: 'sonne', erzeugungZeile: 'Erzeugung · 3 WR', lastName: 'Verbrauch', netzZeile: null,
    });
  });
});

describe('Heute: Wer hat geregelt, Spuren', () => {
  it('zählt Anzahl und Dauer je Urheber aus den Zustandswechseln', () => {
    const j = erzeugerBeispiel('buettner', NOW);
    const z = werHatGeregelt(j, erzeugerLage(j, NOW), mitternacht, NOW.getTime());
    expect(z?.map((x) => [x.urheber, x.anzahl, sp(dauer(x.dauerMs))])).toEqual([
      ['Netzbetreiber', 2, '2 h 27 min'],
      ['Direktvermarkter', 1, '2 h 39 min'],
    ]);
    const g = erzeugerBeispiel('gore', NOW);
    // Die getrennte Leitstelle ist keine Begrenzung; die Anlage selbst regelt seit 5 h.
    expect(werHatGeregelt(g, erzeugerLage(g, NOW), mitternacht, NOW.getTime())?.map((x) => [x.urheber, x.anzahl, x.dauerMs])).toEqual([
      ['Netzbetreiber', 0, 0],
      ['Anlage selbst', 1, 300 * 60_000],
    ]);
  });
  it('ohne Wechsel keine Zählung (nie „0×“ erfunden)', () => {
    const j = mit('buettner', (x) => { x.wechselHeute = {}; });
    expect(werHatGeregelt(j, erzeugerLage(j, NOW), mitternacht, NOW.getTime())).toBeNull();
  });
  it('Abschnitte beginnen frühestens um Mitternacht und laufen bis jetzt', () => {
    const a = abschnitte([{ ab: new Date(mitternacht - 3_600_000).toISOString(), wert: 1 }, { ab: new Date(mitternacht + 600_000).toISOString(), wert: 0 }], (w) => w === 1, mitternacht, NOW.getTime());
    expect(a).toEqual([{ von: mitternacht, bis: mitternacht + 600_000 }]);
  });
  it('Spuren je Viertelstunde: Netzbetreiber und Direktvermarkter, bei Gore „Anlage selbst“', () => {
    const viertel = Array.from({ length: 96 }, (_, i) => ({ start: mitternacht + i * 900_000 }));
    const j = erzeugerBeispiel('buettner', NOW);
    const s = vorgabeSpuren(j, erzeugerLage(j, NOW), viertel, NOW.getTime(), 900_000);
    expect(s.map((x) => [x.name, x.kurz, x.farbe])).toEqual([['Netzbetreiber', 'Netzbetreiber', 'netz'], ['Direktvermarkter', 'Direktverm.', 'markt']]);
    // 14:32 liegt in der Viertelstunde 58 (14:30), 15:44 in 62; danach nichts.
    expect(s[0].an[57]).toBe(false);
    expect(s[0].an[58]).toBe(true);
    expect(s[0].an[62]).toBe(true);
    expect(s[0].an[63]).toBe(false);
    const g = erzeugerBeispiel('gore', NOW);
    expect(vorgabeSpuren(g, erzeugerLage(g, NOW), viertel, NOW.getTime(), 900_000).map((x) => x.name)).toEqual(['Netzbetreiber', 'Anlage selbst']);
  });
});
