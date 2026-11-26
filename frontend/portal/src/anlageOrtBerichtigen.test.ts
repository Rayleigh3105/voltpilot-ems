import { describe, expect, it } from 'vitest';
import type { StandortAmStichtag } from './api';
import {
  adresseWaehlen,
  distanzMeter,
  geaendert,
  landFolgen,
  mehrereStandorte,
  ortAnfrage,
  ortFormAus,
  ortZeileText,
  pinZiehen,
  uebernahmeAnbieten,
  WEIT_GEZOGEN_METER,
} from './anlageOrtBerichtigen';

function standort(over: Partial<StandortAmStichtag> = {}): StandortAmStichtag {
  return {
    id: 'st-1',
    kurzzeichen: 'ST-1',
    name: 'Hof Sonnenfeld',
    adresse: { strasse: 'Lindenweg 54', plz: '91710', ort: 'Treuchtlingen', land: 'DE' },
    zeitzone: 'Europe/Berlin',
    zustand: 'aktiv',
    esFehlt: [],
    bestand: 'vorhanden',
    bestandText: null,
    anlagen: [],
    anlagenZahl: 1,
    gebaeudeZahl: 0,
    bereichZahl: 0,
    flaecheM2: null,
    flaecheQuelle: null,
    lage: { breitengrad: 48.95, laengengrad: 10.92 },
    ...over,
  };
}

describe('distanzMeter', () => {
  it('ist 0 am selben Punkt', () => {
    expect(distanzMeter({ breitengrad: 48.95, laengengrad: 10.92 }, { breitengrad: 48.95, laengengrad: 10.92 })).toBe(0);
  });

  it('misst rund 111 km je Breitengrad', () => {
    const m = distanzMeter({ breitengrad: 48.0, laengengrad: 10.0 }, { breitengrad: 49.0, laengengrad: 10.0 });
    expect(m).toBeGreaterThan(110000);
    expect(m).toBeLessThan(112000);
  });
});

describe('ortFormAus', () => {
  it('liest Adresse und Punkt aus dem Standort', () => {
    const f = ortFormAus(standort());
    expect(f).toEqual({
      adresse: { strasse: 'Lindenweg 54', plz: '91710', ort: 'Treuchtlingen', land: 'DE' },
      punkt: { breitengrad: 48.95, laengengrad: 10.92 },
    });
  });

  it('ist null ohne vollständige Adresse oder ohne Lage (Rand-Fall)', () => {
    expect(ortFormAus(standort({ adresse: null }))).toBeNull();
    expect(ortFormAus(standort({ lage: null }))).toBeNull();
    expect(ortFormAus(standort({ adresse: { strasse: null, plz: null, ort: 'X', land: 'DE' } }))).toBeNull();
  });
});

describe('pinZiehen und adresseWaehlen (Regel 3: die Adresse setzt den Pin, ein gezogener Pin ändert nie die Adresse)', () => {
  const form = ortFormAus(standort())!;

  it('pinZiehen ändert nur den Punkt', () => {
    const next = pinZiehen(form, { breitengrad: 1, laengengrad: 2 });
    expect(next.punkt).toEqual({ breitengrad: 1, laengengrad: 2 });
    expect(next.adresse).toBe(form.adresse);
  });

  it('adresseWaehlen setzt Adresse und Punkt aus dem Vorschlag', () => {
    const neueAdresse = { strasse: 'Hauptplatz 1', plz: null, ort: 'Wien', land: 'AT' as const };
    const next = adresseWaehlen(form, neueAdresse, { breitengrad: 48.2, laengengrad: 16.37 });
    expect(next).toEqual({ adresse: neueAdresse, punkt: { breitengrad: 48.2, laengengrad: 16.37 } });
  });

  it('adresseWaehlen ohne Punkt (von Hand eingegeben) behält den bisherigen Punkt', () => {
    const neueAdresse = { strasse: 'Hauptstraße 1', plz: '12345', ort: 'X', land: 'DE' as const };
    const next = adresseWaehlen(form, neueAdresse, null);
    expect(next.punkt).toBe(form.punkt);
  });
});

describe('geaendert (Regel 2: "Speichern" nur bei einer echten Änderung)', () => {
  const form = ortFormAus(standort())!;

  it('ist falsch, solange sich nichts ändert', () => {
    expect(geaendert(form, form)).toBe(false);
    expect(geaendert({ ...form }, form)).toBe(false);
  });

  it('erkennt eine geänderte Adresse', () => {
    expect(geaendert({ ...form, adresse: { ...form.adresse, ort: 'Anders' } }, form)).toBe(true);
  });

  it('erkennt einen gezogenen Pin', () => {
    expect(geaendert(pinZiehen(form, { breitengrad: 1, laengengrad: 1 }), form)).toBe(true);
  });
});

describe('ortAnfrage', () => {
  it('baut den Rumpf von PUT …/ort', () => {
    const form = ortFormAus(standort())!;
    expect(ortAnfrage(form)).toEqual({
      adresse: { strasse: 'Lindenweg 54', plz: '91710', ort: 'Treuchtlingen', land: 'DE' },
      lage: { breitengrad: 48.95, laengengrad: 10.92 },
    });
  });
});

describe('uebernahmeAnbieten (§6.6: über 150 m "Adresse übernehmen?")', () => {
  const aktuell = { strasse: 'Lindenweg 54', plz: '91710', ort: 'Treuchtlingen', land: 'DE' as const };
  const vorZug = { breitengrad: 48.95, laengengrad: 10.92 };

  it('bietet nichts unter 150 m an', () => {
    const nachZug = { breitengrad: 48.9501, laengengrad: 10.92 }; // ~11 m
    const aufgeloest = { strasse: 'Lindenweg 56', plz: '91710', ort: 'Treuchtlingen', land: 'DE' as const };
    expect(uebernahmeAnbieten(vorZug, nachZug, aufgeloest, aktuell)).toBe(false);
  });

  it('bietet ab 150 m an, wenn die Adresse sich unterscheidet', () => {
    const nachZug = { breitengrad: 48.953, laengengrad: 10.92 }; // ~333 m
    expect(distanzMeter(vorZug, nachZug)).toBeGreaterThan(WEIT_GEZOGEN_METER);
    const aufgeloest = { strasse: 'Lindenweg 56', plz: '91710', ort: 'Treuchtlingen', land: 'DE' as const };
    expect(uebernahmeAnbieten(vorZug, nachZug, aufgeloest, aktuell)).toBe(true);
  });

  it('bietet nichts an, wenn die aufgelöste Adresse dieselbe ist', () => {
    const nachZug = { breitengrad: 48.953, laengengrad: 10.92 };
    expect(uebernahmeAnbieten(vorZug, nachZug, aktuell, aktuell)).toBe(false);
  });

  it('bietet nichts an, ohne aufgelöste Adresse', () => {
    const nachZug = { breitengrad: 48.953, laengengrad: 10.92 };
    expect(uebernahmeAnbieten(vorZug, nachZug, null, aktuell)).toBe(false);
  });
});

describe('mehrereStandorte (§6.2: "Gehört zu" erst ab zwei Standorten)', () => {
  it('ist falsch mit null, leer oder genau einem vorhandenen Standort', () => {
    expect(mehrereStandorte(null)).toBe(false);
    expect(mehrereStandorte({ stichtag: '2026-01-01', standorte: [], nichtGezeigt: [], nochNichtZugeordnet: null })).toBe(false);
    expect(
      mehrereStandorte({ stichtag: '2026-01-01', standorte: [standort()], nichtGezeigt: [], nochNichtZugeordnet: null }),
    ).toBe(false);
  });

  it('ist wahr mit zwei vorhandenen Standorten', () => {
    expect(
      mehrereStandorte({
        stichtag: '2026-01-01',
        standorte: [standort(), standort({ id: 'st-2' })],
        nichtGezeigt: [],
        nochNichtZugeordnet: null,
      }),
    ).toBe(true);
  });

  it('zählt einen archivierten oder noch nicht vorhandenen Standort nicht mit', () => {
    expect(
      mehrereStandorte({
        stichtag: '2026-01-01',
        standorte: [standort(), standort({ id: 'st-2', bestand: 'archiviert' })],
        nichtGezeigt: [],
        nochNichtZugeordnet: null,
      }),
    ).toBe(false);
  });
});

describe('ortZeileText (§6.2/E3)', () => {
  it('zeigt bei einem Standort nur die Adresse', () => {
    expect(ortZeileText(standort(), false)).toBe('Lindenweg 54, Treuchtlingen');
  });

  it('zeigt bei mehreren Standorten zuerst den Namen', () => {
    expect(ortZeileText(standort(), true)).toBe('Hof Sonnenfeld · Lindenweg 54, Treuchtlingen');
  });

  it('nennt eine fehlende Adresse statt einer leeren Zeile', () => {
    expect(ortZeileText(standort({ adresse: null }), false)).toBe('Adresse noch nicht hinterlegt');
  });
});

describe('landFolgen (§6.1 Regel 4: Gebotszone und Zeitzone folgen dem Land)', () => {
  it.each([
    ['DE', 'DE-LU', 'Europe/Berlin'],
    ['AT', 'AT', 'Europe/Vienna'],
    ['CH', 'CH', 'Europe/Zurich'],
  ] as const)('%s -> %s, %s', (land, gebotszone, zeitzone) => {
    expect(landFolgen(land)).toEqual({ gebotszone, zeitzone });
  });
});
