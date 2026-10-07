import { describe, expect, it } from 'vitest';
import type { BewertungRangliste, EnergieeinsatzEinstufungFassung, MessstelleWerte } from './api';
import {
  einsatzAntwort,
  einsatzStatus,
  einsatzVerbrauch,
  einstufungVon,
  geltendeEinstufung,
  kriterienInWorten,
  zaehlerZeilen,
} from './einsatzSeite';
import { ahrenbergEinsaetze, ahrenbergRangliste } from './test/bewertungFixtures';

const NB = String.fromCharCode(160);
const EE1 = ahrenbergEinsaetze()[0];

/** Die Monatsmengen einer Messstelle in der Form von `…/werte` (raster monat). */
function monatswerte(kennzeichen: string, mengen: Record<string, number | null>, zustaende: Record<string, 'unvollständig' | 'mit Ersatzwert'> = {}): MessstelleWerte {
  return {
    messstelle: { id: `ms-${kennzeichen}`, kennzeichen, name: kennzeichen, art: 'gemessen', groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' },
    raster: 'monat', von: '', bis: '', zeitzone: 'Europe/Berlin', zeitzone_herkunft: 'standort', version: 1, quellen: [], zuordnung: null,
    werte: Object.entries(mengen).map(([monat, menge]) => ({
      von: `${monat}-01T00:00:00+02:00`, bis: '', beschriftung: null, stunden: null, tagesdauer: null, menge, mittel: null, min: null, max: null,
      zustand: menge === null ? 'keine Werte' : (zustaende[monat] ?? 'vollständig'), kennzeichen: [], erhalten: null, erwartet: null, abdeckung_prozent: null,
      fassung: 'endgueltig', endgueltig_ab: null, version: 1, gebildet_aus: 'monat', quelle: null, grund: null, ereignisse: [], herkunft: null, versionen: 1,
    })),
  };
}

/** Rangliste mit EE-1 als einzigem Bereich; `ms` sind seine Messstellen mit Menge und Monatswerten. */
function mitEE1(
  menge: string | null,
  anteil: string | null,
  ms: { kz: string; menge: string; mw: Record<string, number | null>; zustaende?: Record<string, 'unvollständig' | 'mit Ersatzwert'> }[] = [],
  zustand = menge === null ? 'keine Werte' : 'vollständig',
): BewertungRangliste {
  const r = ahrenbergRangliste();
  const e = r.einsaetze.find((x) => x.id === EE1.id)!;
  return {
    ...r,
    monate: 12,
    einsaetze: [{
      ...e, menge, anteil_prozent: anteil, zustand,
      messstellen: ms.map((m) => ({ id: `ms-${m.kz}`, kennzeichen: m.kz, anlage_id: null, einheit: 'kWh', menge: m.menge, monatswerte: monatswerte(m.kz, m.mw, m.zustaende) })),
    }],
  };
}

const fassung = (f: Partial<EnergieeinsatzEinstufungFassung>): EnergieeinsatzEinstufungFassung => ({
  fassung: 1, einstufung: 'wesentlich', begruendung: '41,8 % des Stromeinsatzes.', grund: ['K1'], herkunft: {} as EnergieeinsatzEinstufungFassung['herkunft'],
  vorgeschlagen_ab: '2026-11-06', gueltig_ab: '2026-11-06', gueltig_bis: null, rueckwirkend: false,
  akteur: { sub: 'ik', name: 'Ines Kaltenbach', rolle: 'energiemanager', art: 'kunde' }, vieraugen: false, freigabe_status: 'freigegeben',
  entschieden_von: null, entschieden_am: null, created_at: '2026-11-06T09:00:00Z', ...f,
});

describe('Seite eines Energieeinsatzes: Antwort zuerst', () => {
  it('Monat, Anteil und Vorjahr in einem Satz; der Gedankenstrich bricht nie an den Zeilenanfang', () => {
    const v = einsatzVerbrauch(EE1.id, '2026-09', mitEE1('88200', '44.2'), mitEE1('88200', '44.0'), null);
    expect(v).toMatchObject({ menge: 88200, einheit: 'kWh', vollstaendig: true, anteil: '44.2', vorjahr: { richtung: 'gleich' }, verlauf: null });
    expect(einsatzAntwort(EE1, v)).toBe(`${EE1.name} brauchte im September 2026 88.200${NB}kWh${NB}– 44${NB}% des Stroms, so viel wie im Vorjahr.`);
    const mehr = einsatzVerbrauch(EE1.id, '2026-09', mitEE1('88200', '44.2'), mitEE1('80000', '40'), null);
    expect(einsatzAntwort(EE1, mehr)).toBe(`${EE1.name} brauchte im September 2026 88.200${NB}kWh${NB}– 44${NB}% des Stroms, 10${NB}% mehr als im Vorjahr.`);
  });

  it('ein unvollständiges Vorjahr (Zähler kam erst im Vorjahr dazu) gibt keinen Vergleich, sondern sagt das (Review r3, MUSS)', () => {
    const v = einsatzVerbrauch(EE1.id, '2026-09', mitEE1('88200', '44.2'), mitEE1('29400', '15', [], 'unvollständig'), null);
    expect(v.vorjahr).toEqual({ text: 'Vorjahr unvollständig', richtung: null });
    expect(einsatzAntwort(EE1, v)).toBe(`${EE1.name} brauchte im September 2026 88.200${NB}kWh${NB}– 44${NB}% des Stroms.`);
    // Ist der Monat selbst unvollständig, gibt es ebenfalls keinen Vergleich - die Antwort sagt „unvollständig“.
    const selbst = einsatzVerbrauch(EE1.id, '2026-09', mitEE1('29400', '15', [], 'unvollständig'), mitEE1('88200', '44'), null);
    expect(selbst.vorjahr).toBeNull();
    expect(einsatzAntwort(EE1, selbst)).toBe(`${EE1.name} brauchte im September 2026 29.400${NB}kWh${NB}– 15${NB}% des Stroms (unvollständig).`);
  });

  it('Ersatz ist Teil der Menge: verglichen wie vollständig, die Antwort nennt den Ersatzwert', () => {
    const v = einsatzVerbrauch(EE1.id, '2026-09', mitEE1('88200', '44.2', [], 'mit Ersatzwert'), mitEE1('80000', '40'), null);
    expect(v).toMatchObject({ vollstaendig: true, vorjahr: { richtung: 'rauf' } });
    expect(einsatzAntwort(EE1, v)).toBe(`${EE1.name} brauchte im September 2026 88.200${NB}kWh${NB}– 44${NB}% des Stroms, 10${NB}% mehr als im Vorjahr (mit Ersatzwert).`);
  });

  it('die Einheit kommt aus der Rangliste: ein Gas-Einsatz in m³ steht nie als „kWh“', () => {
    const r = mitEE1('1240', null);
    r.einsaetze[0] = { ...r.einsaetze[0], traeger: 'Gas', einheit: 'm³' };
    const v = einsatzVerbrauch(EE1.id, '2026-09', r, null, null);
    expect(v.einheit).toBe('m³');
    expect(einsatzAntwort({ ...EE1, name: 'Heizung Verwaltung', traeger: 'Gas' }, v)).toBe(`Heizung Verwaltung brauchte im September 2026 1.240${NB}m³.`);
  });

  it('ohne Werte sagt die Seite das, nie „0 kWh“; Gas wird noch nicht gemessen', () => {
    const v = einsatzVerbrauch(EE1.id, '2026-09', mitEE1(null, null), null, null);
    expect(einsatzAntwort(EE1, v)).toBe(`${EE1.name}: Für September 2026 liegen keine Werte vor.`);
    expect(einsatzAntwort({ ...EE1, name: 'Heizung Verwaltung', traeger: 'Gas' }, v)).toBe(
      'Heizung Verwaltung: Gas wird noch nicht gemessen – für September 2026 gibt es keine Menge.',
    );
  });

  it('der Verlauf summiert die Monatsmengen der Zähler nur, wenn sie genau die Menge des Bereichs ergeben', () => {
    const mw = { '2025-10': 1000, '2026-09': 2000 } as Record<string, number | null>;
    const genau = mitEE1('3000', '40', [{ kz: 'MS-20', menge: '3000', mw }]);
    const v = einsatzVerbrauch(EE1.id, '2026-09', null, null, genau);
    expect(v.verlauf).toHaveLength(12);
    expect(v.verlauf?.[0]).toEqual({ monat: '2025-10', wert: 1000 });
    expect(v.verlauf?.[11]).toEqual({ monat: '2026-09', wert: 2000 });
    expect(v.verlauf?.[5]).toEqual({ monat: '2026-03', wert: null });
    // Zählt ein Zähler nur anteilig, ergäbe die Summe eine zu große Linie — dann keine.
    const anteilig = mitEE1('2100', '40', [{ kz: 'MS-20', menge: '3000', mw }]);
    expect(einsatzVerbrauch(EE1.id, '2026-09', null, null, anteilig).verlauf).toBeNull();
  });

  it('der Verlauf summiert mehrere Zähler über den Zwilling; fehlt einer oder ist er unvollständig, bleibt der Monat eine Lücke', () => {
    const zwei = mitEE1('4500', '40', [
      { kz: 'MS-20', menge: '3000', mw: { '2026-08': 1000, '2026-09': 2000 } },
      { kz: 'MS-21', menge: '1500', mw: { '2026-08': 500, '2026-09': 1000, '2026-07': 300 }, zustaende: { '2026-09': 'mit Ersatzwert', '2026-07': 'unvollständig' } },
    ]);
    const v = einsatzVerbrauch(EE1.id, '2026-09', null, null, zwei).verlauf!;
    expect(v[11]).toEqual({ monat: '2026-09', wert: 3000 });
    expect(v[10]).toEqual({ monat: '2026-08', wert: 1500 });
    // Juli: MS-20 ohne Wert, MS-21 unvollständig - nie 300 als Monatswert des Bereichs.
    expect(v[9]).toEqual({ monat: '2026-07', wert: null });
  });
});

describe('Gemessen von, Status und Gründe der Einstufung', () => {
  it('je Zähler die Menge des letzten vollen Monats aus `letzter_monat`', () => {
    const e = { ...EE1, messstellen: [{ ...EE1.messstellen[0], letzter_monat: monatswerte('MS-20', { '2026-09': 88200 }) }, { ...EE1.messstellen[0], id: 'x', letzter_monat: null }] };
    const z = zaehlerZeilen(e, () => 'Halle 2');
    expect(z[0]).toMatchObject({ wert: `88.200${NB}kWh`, monat: 'Sep 2026', zustand: 'vollständig', ton: 'ok', ort: 'Halle 2' });
    expect(z[1]).toMatchObject({ wert: null, monat: null, ton: 'aus' });
  });

  it('Status nach der geltenden Einstufung; ein beendeter Einsatz sagt das zuerst', () => {
    const gilt = geltendeEinstufung([fassung({ fassung: 1, gueltig_bis: '2026-12-01' }), fassung({ fassung: 2, einstufung: 'nicht_wesentlich', gueltig_ab: '2026-12-01' })]);
    expect(gilt?.fassung).toBe(2);
    expect(einsatzStatus(EE1, gilt)).toEqual({ text: 'Nicht wesentlich', seit: 'seit 01.12.2026', ton: 'neutral' });
    expect(einsatzStatus(EE1, fassung({}))).toEqual({ text: 'Wesentlicher Bereich', seit: 'seit 06.11.2026', ton: 'wesentlich' });
    expect(einsatzStatus(EE1, null).text).toBe('Noch nicht eingestuft');
    expect(einsatzStatus({ ...EE1, gueltig_bis: '2027-01-31' }, fassung({}))).toEqual({ text: 'Beendet', seit: 'am 31.01.2027', ton: 'beendet' });
    expect(geltendeEinstufung([fassung({ freigabe_status: 'beantragt' })])).toBeNull();
    expect(einstufungVon(fassung({}))).toBe('Ines Kaltenbach · eingestuft als wesentlich am 06.11.2026');
  });

  it('Kriterien in Worten statt K1 bis K3, mit Schwelle; ohne Menge in der Datengrundlage nichts zu prüfen', () => {
    const r = mitEE1('1017050', '40.6');
    const rang = { ...r.einsaetze[0], urteil: { ...r.einsaetze[0].urteil, K1: 'ueber_schwelle' as const, K2: 'unter_schwelle' as const, K3: 'ueber_schwelle' as const } };
    expect(kriterienInWorten(r, rang)).toEqual([
      { stand: 'erfuellt', text: `40,6${NB}% des Stroms`, zusatz: `ab 10${NB}%`, urteil: 'erfüllt' },
      { stand: 'nicht_erfuellt', text: `gehört nicht zu den größten Bereichen, die zusammen 80${NB}% ausmachen`, zusatz: null, urteil: 'nicht erfüllt' },
      { stand: 'erfuellt', text: `1.017.050${NB}kWh im Jahr`, zusatz: `ab 100.000${NB}kWh`, urteil: 'erfüllt' },
    ]);
    expect(kriterienInWorten(r, { ...rang, menge: null })).toBeNull();
    expect(kriterienInWorten(null, rang)).toBeNull();
  });

  it('nicht belastbar / nicht anwendbar sind kein „nicht erfüllt“: das Wort der Regel und der Grund (Review r3, MUSS)', () => {
    // 67,8 % zugeordnet (K8 unter 80 %) → K2 nicht belastbar; sechs Monate Datengrundlage → K3 nicht anwendbar.
    const r = { ...mitEE1('88200', '44.2'), monate: 6, abdeckung_prozent: '67.8' };
    const rang = { ...r.einsaetze[0], urteil: { ...r.einsaetze[0].urteil, K1: 'ueber_schwelle' as const, K2: 'nicht_belastbar' as const, K3: 'nicht_anwendbar' as const } };
    const [k1, k2, k3] = kriterienInWorten(r, rang)!;
    expect(k1.stand).toBe('erfuellt');
    expect(k2).toEqual({
      stand: 'offen',
      text: `Platz unter den größten Bereichen, die zusammen 80${NB}% ausmachen`,
      zusatz: `nicht belastbar – erst ab 80${NB}% zugeordnetem Strom (jetzt 68${NB}%)`,
      urteil: 'nicht belastbar',
    });
    expect(k3).toEqual({ stand: 'offen', text: `88.200${NB}kWh in 6 Monaten`, zusatz: 'nicht anwendbar – die Schwelle gilt für zwölf Monate', urteil: 'nicht anwendbar' });
    // Ohne vollständigen Hauptzähler-Wert ist auch K1 nicht prüfbar.
    const ohneAnteil = kriterienInWorten({ ...r, abdeckung_prozent: null }, { ...rang, anteil_prozent: null, urteil: { ...rang.urteil, K1: 'nicht_anwendbar' as const } })!;
    expect(ohneAnteil[0]).toMatchObject({ stand: 'offen', text: 'Anteil am Strom unbekannt', urteil: 'nicht anwendbar' });
    expect(ohneAnteil[1].zusatz).toBe(`nicht belastbar – erst ab 80${NB}% zugeordnetem Strom`);
    // Eine vereinbarte Schwelle mit Nachkommastelle bleibt, wie sie ist.
    const genau = { ...r, kriterien: { ...r.kriterien, werte: { ...r.kriterien.werte, K1: '7.5' } } };
    expect(kriterienInWorten(genau, rang)![0].zusatz).toBe(`ab 7,5${NB}%`);
  });
});
