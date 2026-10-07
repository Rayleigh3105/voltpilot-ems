import { describe, expect, it } from 'vitest';
import type { MessstelleRegisterZeile, MessstellenRegister } from './api';
import {
  fortschritt,
  gespeichertText,
  rundeAus,
  rundenTitel,
  rundenUnter,
  rundeZaehltSatz,
  vorpruefung,
  zuletztText,
} from './ableseRunde';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';

/**
 * Die Ablese-Runde je Gebäude (Konzept Messen m1, §6.5 Variante 3A) gegen das Register von Ahrenberg: vier Zähler in
 * Halle 1 (G-1, darunter die Bereiche B-1 und B-2) werden von Hand abgelesen, zuletzt am 01.10.2026 - der Szenario-Tag
 * des Konzepts ist der 02.11.2026, 07:30 MEZ.
 */

const ZONE = 'Europe/Berlin';
const ERSTER_OKTOBER = '2026-10-01T00:00:00+02:00';

/** Ein Zähler des Registers als Ablesezähler mit seinem letzten Stand. */
function abgelesen(z: MessstelleRegisterZeile, stand: number, zeitpunkt = ERSTER_OKTOBER): MessstelleRegisterZeile {
  return {
    ...z,
    lebenszyklus: 'aktiv',
    quelle: { stand: 'ablesung', fuehrend: null, davor: null, vergleichsquellen: 0, ablesung: { seit: '2024-10-01T00:00:00+02:00', zuletzt: zeitpunkt, faellig_ab: '2026-12-01T00:00:00+01:00' } },
    letzter_wert: { wert: stand, text: null, einheit: 'kWh', zeitpunkt },
  };
}

function halle1(): MessstellenRegister {
  const r = ahrenbergRegister();
  const stand: Record<string, number> = { 'MS-03': 1_204_500, 'MS-06': 647_760, 'MS-07': 523_560, 'MS-08': 747_120 };
  return {
    ...r,
    register: r.register.map((z) => {
      if (!(z.kennzeichen in stand)) return z;
      const a = abgelesen(z, stand[z.kennzeichen]);
      // MS-07 ist hier der Hauptzähler der Halle - er steht in der Runde zuerst.
      return z.kennzeichen === 'MS-07' && a.elektrische_stellung ? { ...a, elektrische_stellung: { ...a.elektrische_stellung, stellung: 'Hauptzähler' } } : a;
    }),
  };
}

describe('Welche Zähler zur Runde gehören', () => {
  it('die Ablesezähler am Ort und darunter, der Hauptzähler zuerst, dann nach Kennzeichen', () => {
    const r = rundeAus(halle1(), 'G-1', ZONE)!;
    expect(r.zaehler.map((z) => z.kennzeichen)).toEqual(['MS-07', 'MS-03', 'MS-06', 'MS-08']);
    // Der Name des Orts kommt aus einer Zeile, die direkt an ihm steht (MS-03 an G-1).
    expect(r.ortName).toBe(halle1().register.find((z) => z.kennzeichen === 'MS-03')!.ort.name);
    expect(rundenTitel(r)).toBe(`${r.ortName} ablesen`);
    expect(r.zuletztAm).toBe('2026-10-01');
    expect(rundenUnter(r)).toBe(`4 Zähler · Werk Ahrenberg · zuletzt abgelesen am 01.10.2026`);
    // Gebundene Zähler (MS-04 in B-2) und berechnete (MS-09) gehören nicht dazu; ein Ort ohne Ablesezähler hat keine Runde.
    expect(r.zaehler.some((z) => z.kennzeichen === 'MS-04' || z.kennzeichen === 'MS-09')).toBe(false);
    expect(rundeAus(halle1(), 'G-2', ZONE)).toBeNull();
  });

  it('ein Bereich gehört zur Runde seines Gebäudes; am Standort nur die Zähler ohne Gebäude (Review r4 S11)', () => {
    // Wie der Server (`ableseort`): MS-07 und MS-08 in B-2 liest man in der Runde von Halle 1, eine eigene Runde B-2 gibt es nicht.
    expect(rundeAus(halle1(), 'B-2', ZONE)).toBeNull();
    // Alle Zähler von Hand abgelesen: die Runde des Standorts nimmt nur die, die an keinem Gebäude hängen - nie die
    // sechzehn aller Gebäude.
    const r = ahrenbergRegister();
    const alle: MessstellenRegister = { ...r, register: r.register.map((z) => abgelesen(z, 1000)) };
    const st = rundeAus(alle, 'ST-1', ZONE)!;
    const gebaeude = new Set(st.zaehler.map((x) => alle.register.find((z) => z.id === x.id)!.ort.pfad.find((k) => k.startsWith('G-')) ?? null));
    expect([...gebaeude]).toEqual([null]);
    const amStandort = alle.register.filter((z) => z.ort.kennzeichen === 'ST-1' && z.hauptgroesse?.wertart === 'Zählerstand');
    expect(amStandort.length).toBeGreaterThan(0);
    expect(new Set(st.zaehler.map((z) => z.kennzeichen))).toEqual(new Set(amStandort.map((z) => z.kennzeichen)));
    expect(rundenTitel(st)).toBe('Werk Ahrenberg ablesen');
    expect(rundenUnter(st)).not.toContain('Werk Ahrenberg ·');
    // Halle 1 nimmt die Zähler der Halle und ihrer Bereiche, keinen am Standort.
    const g1 = rundeAus(alle, 'G-1', ZONE)!;
    expect(g1.zaehler.every((x) => alle.register.find((z) => z.id === x.id)!.ort.pfad.includes('G-1'))).toBe(true);
  });

  it('ein Gebäude nur mit Zählern in Bereichen kennt das Register nicht beim Namen - dann das Kurzzeichen, bis der Ortsbaum antwortet', () => {
    const r = halle1();
    // MS-03 (direkt an G-1) wird gebunden: an G-1 hängt keine Messstelle mehr, nur in B-1/B-2.
    r.register = r.register.map((z) => (z.kennzeichen === 'MS-03' ? { ...z, ort: { ...z.ort, kennzeichen: 'B-1', ort_art: 'bereich' as const, pfad: ['B-1', 'G-1', 'ST-1'] } } : z));
    r.register = r.register.filter((z) => !(z.ort.kennzeichen === 'G-1'));
    const runde = rundeAus(r, 'G-1', ZONE)!;
    expect(runde.ortName).toBeNull();
    expect(rundenTitel(runde)).toBe('G-1 ablesen');
    expect(rundenTitel(runde, 'Halle 1')).toBe('Halle 1 ablesen');
  });
});

describe('Was jede Reihe sagt', () => {
  it('der letzte Stand zum Vergleich - mit Tag nur, wo er nicht der der Runde ist', () => {
    const reg = halle1();
    reg.register = reg.register.map((z) => (z.kennzeichen === 'MS-08' ? abgelesen(z, 747_120, '2026-09-01T00:00:00+02:00') : z));
    const r = rundeAus(reg, 'G-1', ZONE)!;
    const z = (kz: string) => r.zaehler.find((x) => x.kennzeichen === kz)!;
    expect(zuletztText(z('MS-06'), r, ZONE)).toBe('zuletzt 647.760 kWh');
    expect(zuletztText(z('MS-08'), r, ZONE)).toBe('zuletzt 747.120 kWh am 01.09.2026');
    expect(fortschritt(3, 8)).toEqual({ zahl: '3 von 8', wort: 'eingetragen' });
    expect(gespeichertText(216_300, 'kWh', ERSTER_OKTOBER, ZONE)).toBe('gespeichert · 216.300 kWh seit 01.10.');
    expect(gespeichertText(null, 'kWh', ERSTER_OKTOBER, ZONE)).toBe('gespeichert');
  });
});

describe('Die Prüfung vor dem Senden (dieselben Regeln wie der Dialog)', () => {
  const r = rundeAus(halle1(), 'G-1', ZONE)!;
  const ms06 = r.zaehler.find((z) => z.kennzeichen === 'MS-06')!;
  const RUNDE = '2026-11-02T07:30:00+01:00';

  it('am 02.11.2026: zählt zum Oktober - der Monat mit dem größten Anteil, wie die Vorgabe im Dialog', () => {
    expect(vorpruefung(ms06, '662.180', RUNDE, ZONE)).toEqual({ art: 'senden', stand: '662.180', zuordnung_monat: '2026-10' });
    expect(rundeZaehltSatz(r, RUNDE, ZONE)).toBe('Zählt zum Oktober 2026 – dem Zeitraum seit der letzten Ablesung am 01.10.');
  });

  it('keine Zahl, vor der letzten Ablesung, über drei Monate: der Satz bleibt am Zähler, nichts wird gesendet', () => {
    expect(vorpruefung(ms06, 'abc', RUNDE, ZONE)).toEqual({ art: 'satz', satz: 'Bitte geben Sie eine Zahl ein, zum Beispiel 1.234,5.' });
    expect(vorpruefung(ms06, '662.180', '2026-09-30T12:00:00+02:00', ZONE)).toMatchObject({ art: 'satz', satz: expect.stringContaining('Liegt nicht nach der letzten Ablesung (01.10.2026, 00:00)') });
    expect(vorpruefung(ms06, '662.180', '2027-01-15T12:00:00+01:00', ZONE)).toMatchObject({ art: 'satz', satz: expect.stringContaining('über drei oder mehr Monate') });
  });

  it('verschiedene letzte Tage: kein gemeinsamer Satz über der Runde', () => {
    const reg = halle1();
    reg.register = reg.register.map((z) => (z.kennzeichen === 'MS-08' ? abgelesen(z, 747_120, '2026-09-01T00:00:00+02:00') : z));
    expect(rundeZaehltSatz(rundeAus(reg, 'G-1', ZONE)!, RUNDE, ZONE)).toBeNull();
  });
});
