import { describe, expect, it } from 'vitest';
import type { EnergiemanagementVerzeichnis, EnergiemanagementVerzeichnisZeile } from './api';
import { eintraegeZahl, eintragTitel, verzeichnisMonate } from './verzeichnisMonate';

/** Das Verzeichnis nach Monaten (Konzept Nachweisen n1, Runde 2, §6.9) - Zeilen wie die Demo am 30.04.2029. */
const zeile = (z: Partial<EnergiemanagementVerzeichnisZeile> & Pick<EnergiemanagementVerzeichnisZeile, 'gruppe' | 'art' | 'kennzeichen' | 'titel' | 'tag'>): EnergiemanagementVerzeichnisZeile => ({
  nr: null,
  entschieden_von: null,
  eingetragen_von: 'Ines Kaltenbach',
  pruefsumme: null,
  ort: 'in_voltpilot',
  gruppe_wort: z.gruppe,
  ort_satz: 'in VoltPilot',
  ...z,
});

const verzeichnis = (zeilen: EnergiemanagementVerzeichnisZeile[]): EnergiemanagementVerzeichnis => ({
  stichtag: '2029-04-30T12:38:00+02:00',
  verantwortung: '',
  filter: { gruppe: null, von: null, bis: null, person: null, person_name: null },
  gruppen: [{ gruppe: 'alle', gruppe_wort: 'alle', zuschnitt: [], satz: null, zeilen }],
});

const DEMO = verzeichnis([
  zeile({ gruppe: 'grundlagen', art: 'energiepolitik', kennzeichen: 'D-0001', titel: 'Energiepolitik', nr: 1, entschieden_von: 'Robert Falk', tag: '2026-12-15' }),
  zeile({ gruppe: 'grundlagen', art: 'energiepolitik', kennzeichen: 'D-0001', titel: 'Energiepolitik', nr: 2, entschieden_von: 'Robert Falk', tag: '2029-03-20' }),
  zeile({ gruppe: 'kompetenz_kommunikation', art: 'bekanntmachung', kennzeichen: 'D-0001', titel: 'Energiepolitik: bekannt gemacht an alle Mitarbeitenden beider Werke', nr: 2, tag: '2029-03-25' }),
  zeile({ gruppe: 'bewertung_messplanung', art: 'berichtsstand', kennzeichen: 'BR-2029-0002', titel: 'Energetische Bewertung April 2028 bis März 2029', nr: 1, tag: '2029-04-30' }),
  ...[5, 4].map((nr) => zeile({ gruppe: 'bewertung_messplanung', art: 'kriterien_fassung', kennzeichen: 'Kriterien', titel: 'Kriterien der energetischen Bewertung', nr, tag: '2029-04-30' })),
  ...['KZ-0021', 'KZ-0022', 'KZ-0023', 'KZ-0024', 'KZ-0025'].map((kz) => zeile({ gruppe: 'kennzahlen_bezugsbasen', art: 'kennzahl_fassung', kennzeichen: kz, titel: kz, nr: 1, tag: '2029-04-30' })),
  zeile({ gruppe: 'audits_feststellungen', art: 'wirksamkeit', kennzeichen: 'F-2029-0001', titel: 'Wirksamkeit: wirksam', nr: 1, entschieden_von: 'Ines Kaltenbach', tag: '2029-04-15' }),
  zeile({ gruppe: 'grundlagen', art: 'verfahren', kennzeichen: 'D-0009', titel: 'Vorgehen ohne Tag', tag: null }),
]);

describe('Verzeichnis nach Monaten', () => {
  it('neueste zuerst, je Monat; Gleichartiges derselben Person vom selben Tag ist eine Zeile, Zeilen ohne Tag am Ende', () => {
    const m = verzeichnisMonate(DEMO);
    expect(m.map((x) => x.titel)).toEqual(['April 2029', 'März 2029', 'Dezember 2026', 'Ohne Tag']);
    expect(m[0].eintraege.map((e) => [e.titel, e.unter])).toEqual([
      ['Energetische Bewertung April 2028 bis März 2029', null],
      ['Kriterien und Kennzahlen', '7 Einträge'],
      ['Wirksamkeit: wirksam', null],
    ]);
    expect(m[0].eintraege[1].zeilen).toHaveLength(7);
    expect(m[1].eintraege.map((e) => e.titel)).toEqual(['Energiepolitik bekannt gemacht', 'Energiepolitik, Fassung 2']);
    // „Fassung 1“ bleibt still (§0.3 Regel 3).
    expect(m[2].eintraege[0].titel).toBe('Energiepolitik');
    expect(m[2].eintraege[0].person).toBe('Robert Falk');
    expect(m[3].eintraege[0].tag).toBeNull();
  });

  it('die Suche findet Titel, Kennzeichen und Personen, ohne Groß und klein', () => {
    expect(verzeichnisMonate(DEMO, 'robert').flatMap((m) => m.eintraege.map((e) => e.titel))).toEqual(['Energiepolitik, Fassung 2', 'Energiepolitik']);
    expect(verzeichnisMonate(DEMO, 'kz-0023').flatMap((m) => m.eintraege.map((e) => e.titel))).toEqual(['KZ-0023']);
    expect(verzeichnisMonate(DEMO, 'nichts davon')).toEqual([]);
  });

  it('Titel: Fassung ab 2, die Bekanntmachung kurz, ein neuer Stand mit Nummer; die Zahl der Einträge ohne Urteil', () => {
    expect(eintragTitel(zeile({ gruppe: 'berichte', art: 'berichtsstand', kennzeichen: 'BR-2026-0001', titel: 'Monatsbericht Werk Ahrenberg Oktober 2026', nr: 2, tag: '2026-12-20' }))).toBe(
      'Monatsbericht Werk Ahrenberg Oktober 2026, Stand 2',
    );
    expect(eintraegeZahl(DEMO)).toBe('13 Einträge');
    expect(eintraegeZahl(verzeichnis([]))).toBe('0 Einträge');
  });
});
