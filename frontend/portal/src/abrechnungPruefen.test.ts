import { describe, expect, it } from 'vitest';
import type { Abrechnung, AbrechnungZeile } from './api';
import {
  abrechnungKarte,
  eingabeText,
  eingabeWert,
  letzterTag,
  parseZeitraum,
  spanneText,
  unterschied,
  WORT,
  zeitraumHash,
  zeitraumJeMonat,
  zeitraumSetzen,
  zeitraumTage,
  zeitraumText,
  zeitraumVorgabe,
} from './abrechnungPruefen';
import { zeitraumZellen } from './verlaufRaster';

const NBSP = ' ';
const HEUTE = new Date(2026, 10, 14, 10); // Sa., 14.11.2026

function zeile(teil: Partial<AbrechnungZeile> = {}): AbrechnungZeile {
  return {
    mengeKwh: 5154,
    herkunft: 'zaehler',
    standVonKwh: 12455,
    standBisKwh: 17609,
    zaehlerFaellt: false,
    fehlendeTage: 0,
    luecken: [],
    ...teil,
  };
}

function abrechnung(teil: Partial<Abrechnung> = {}): Abrechnung {
  return {
    von: '2025-11-01',
    bis: '2026-10-31',
    tage: 365,
    messbeginn: '2024-03-01',
    tageVorMessbeginn: 0,
    bezug: zeile(),
    einspeisung: zeile({ mengeKwh: 3040, standVonKwh: 30118, standBisKwh: 33158 }),
    rechnung: null,
    ...teil,
  };
}

describe('Adresse', () => {
  it('liest und schreibt z=zeitraum&von=&bis=', () => {
    const z = { von: '2025-11-01', bis: '2026-10-31' };
    const hash = zeitraumHash('site-1', z);
    expect(hash).toBe('#/anlage/site-1/messwerte?z=zeitraum&von=2025-11-01&bis=2026-10-31');
    expect(parseZeitraum(hash)).toEqual(z);
  });

  it('ohne gültigen Zeitraum gilt der gewohnte Weg', () => {
    expect(parseZeitraum('#/anlage/x/messwerte?z=monat&at=2026-10-01')).toBeNull();
    expect(parseZeitraum('#/anlage/x/messwerte?z=zeitraum&von=2026-02-30&bis=2026-03-01')).toBeNull();
    expect(parseZeitraum('#/anlage/x/messwerte?z=zeitraum&von=2026-03-02&bis=2026-03-01')).toBeNull();
    expect(parseZeitraum('#/anlage/x/messwerte?z=zeitraum&von=2026-03-01')).toBeNull();
  });
});

describe('Zeitraum', () => {
  it('zählt beide Tage und wechselt nach 92 Tagen auf Monate', () => {
    expect(zeitraumTage({ von: '2025-11-01', bis: '2026-10-31' })).toBe(365);
    expect(zeitraumTage({ von: '2026-03-29', bis: '2026-03-29' })).toBe(1);
    expect(zeitraumJeMonat({ von: '2026-01-01', bis: '2026-04-02' })).toBe(false); // 92 Tage
    expect(zeitraumJeMonat({ von: '2026-01-01', bis: '2026-04-03' })).toBe(true);
  });

  it('beginnt mit der gezeigten Periode, höchstens bis gestern', () => {
    expect(zeitraumVorgabe(new Date(2026, 9, 10, 12), 'month', HEUTE)).toEqual({ von: '2026-10-01', bis: '2026-10-31' });
    expect(zeitraumVorgabe(new Date(2026, 10, 14, 12), 'day', HEUTE)).toEqual({ von: '2026-11-01', bis: '2026-11-13' });
    expect(zeitraumVorgabe(new Date(2026, 5, 1, 12), 'year', HEUTE)).toEqual({ von: '2026-01-01', bis: '2026-11-13' });
    // Am Monatsersten gibt es im laufenden Monat noch keinen ganzen Tag: dann der Vormonat.
    expect(zeitraumVorgabe(new Date(2026, 11, 1, 12), 'day', new Date(2026, 11, 1, 9))).toEqual({
      von: '2026-11-01',
      bis: '2026-11-30',
    });
  });

  it('hält von ≤ bis ≤ gestern, wenn ein Datum sich ändert', () => {
    expect(letzterTag(HEUTE)).toBe('2026-11-13');
    const z = { von: '2026-01-01', bis: '2026-01-31' };
    expect(zeitraumSetzen(z, 'bis', '2026-12-24', HEUTE)).toEqual({ von: '2026-01-01', bis: '2026-11-13' });
    expect(zeitraumSetzen(z, 'von', '2026-03-01', HEUTE)).toEqual({ von: '2026-03-01', bis: '2026-03-01' });
    expect(zeitraumSetzen(z, 'bis', '2025-12-01', HEUTE)).toEqual({ von: '2025-12-01', bis: '2025-12-01' });
    // Länger als drei Jahre: das andere Datum rückt nach.
    expect(zeitraumSetzen(z, 'von', '2020-01-01', HEUTE).bis).toBe('2023-01-02');
  });

  it('schreibt Zeiträume und Spannen deutsch', () => {
    expect(zeitraumText({ von: '2025-11-01', bis: '2026-10-31' })).toBe('01.11.2025 – 31.10.2026');
    expect(spanneText('2026-02-12', '2026-02-14')).toBe('12.–14.02.2026');
    expect(spanneText('2026-01-30', '2026-02-02')).toBe('30.01.–02.02.2026');
    expect(spanneText('2025-12-30', '2026-01-02')).toBe('30.12.2025–02.01.2026');
    expect(spanneText('2026-02-12', '2026-02-12')).toBe('12.02.2026');
  });

  it('legt Tages- bzw. Monatszellen über genau den Zeitraum', () => {
    const tage = zeitraumZellen(new Date(2026, 8, 1, 12), new Date(2026, 8, 30, 12));
    expect(tage).toHaveLength(30);
    expect(tage[0].art).toBe('tag');
    const monate = zeitraumZellen(new Date(2025, 10, 15, 12), new Date(2026, 9, 31, 12));
    expect(monate).toHaveLength(12);
    expect(monate[0].art).toBe('monat');
    expect(monate[0].start.getDate()).toBe(15); // gekürzt auf den Zeitraum
    expect(monate[0].schluessel).toBe('2025-11');
    expect(monate[11].ende.getMonth()).toBe(10); // endet am 01.11.2026, 0 Uhr
  });
});

describe('Eingabe', () => {
  it('liest deutsche Zahlen, leer löscht, Unsinn ist ungültig', () => {
    expect(eingabeWert('5.131')).toBe(5131);
    expect(eingabeWert('5131,4')).toBe(5131.4);
    expect(eingabeWert('  ')).toBeNull();
    expect(eingabeWert('-3')).toBe('ungueltig');
    expect(eingabeWert('5,1,3')).toBe('ungueltig');
    expect(eingabeText(5131)).toBe('5.131');
    expect(eingabeText(5131.4)).toBe('5.131,4');
    expect(eingabeText(null)).toBe('');
  });
});

describe('Unterschied', () => {
  it('ist gemessen minus Rechnung, Prozent der Rechnung, ab 5 % groß', () => {
    expect(unterschied(5154, 5131)).toEqual({ text: `+23${NBSP}kWh · 0,4${NBSP}%`, gross: false });
    expect(unterschied(5154, 4730)).toEqual({ text: `+424${NBSP}kWh · 9,0${NBSP}%`, gross: true });
    expect(unterschied(3040, 3052)).toEqual({ text: `−12${NBSP}kWh · 0,4${NBSP}%`, gross: false });
    expect(unterschied(100, 100)?.text).toBe(`0${NBSP}kWh · 0,0${NBSP}%`);
    expect(unterschied(5154, null)).toBeNull();
    expect(unterschied(null, 5131)).toBeNull();
    expect(unterschied(12, 0)).toEqual({ text: `+12${NBSP}kWh`, gross: false });
  });
});

describe('Karte', () => {
  it('zeigt Mengen, Zählerstände als graue Zeile und den Standardsatz', () => {
    const v = abrechnungKarte(abrechnung(), { bezug: 5131, einspeisung: null });
    expect(v.titel).toBe('Abrechnung prüfen');
    expect(v.zeitraum).toBe('01.11.2025 – 31.10.2026');
    expect(v.zeilen.map((z) => z.label)).toEqual(['Netzbezug', 'Einspeisung']);
    expect(v.zeilen[0].gemessen).toBe(`5.154${NBSP}kWh`);
    expect(v.zeilen[0].herkunft).toBe('Zählerstand 12.455 → 17.609');
    expect(v.zeilen[0].unterschied?.text).toBe(`+23${NBSP}kWh · 0,4${NBSP}%`);
    expect(v.zeilen[1].unterschied).toBeNull();
    expect(v.saetze).toEqual([{ text: WORT.standard, ton: 'normal' }]);
  });

  it('nennt einen größeren Unterschied, ohne zu urteilen', () => {
    const v = abrechnungKarte(abrechnung(), { bezug: 4730, einspeisung: 3052 });
    expect(v.zeilen[0].unterschied?.gross).toBe(true);
    expect(v.saetze.map((s) => s.text)).toEqual([
      'Größerer Unterschied beim Netzbezug. Stimmen Zeitraum und Zählernummer auf der Rechnung?',
    ]);
    expect(JSON.stringify(v)).not.toMatch(/stimmt[^ ]|korrekt|falsch|€/);
  });

  it('ohne Zähler: aus Messwerten summiert und die Lückentage', () => {
    const summe = { herkunft: 'summe' as const, standVonKwh: null, standBisKwh: null };
    const luecke = { fehlendeTage: 3, luecken: [{ von: '2026-02-12', bis: '2026-02-14' }] };
    const v = abrechnungKarte(
      abrechnung({
        bezug: zeile({ ...summe, ...luecke, mengeKwh: 5118 }),
        einspeisung: zeile({ ...summe, ...luecke, mengeKwh: 3021 }),
      }),
      { bezug: null, einspeisung: null },
    );
    expect(v.zeilen[0].herkunft).toBe('aus Messwerten summiert');
    expect(v.saetze).toEqual([
      {
        text: 'An 3 Tagen fehlen Messwerte (12.–14.02.2026) – sie sind in der Summe nicht enthalten.',
        ton: 'warn',
      },
    ]);
  });

  it('Messbeginn im Zeitraum', () => {
    const v = abrechnungKarte(
      abrechnung({ von: '2026-11-01', bis: '2026-11-30', messbeginn: '2026-11-07', tageVorMessbeginn: 6 }),
      { bezug: null, einspeisung: null },
    );
    expect(v.saetze[0]).toEqual({
      text: 'Gemessen wird erst seit dem 07.11.2026 – davor fehlen 6 Tage dieses Zeitraums.',
      ton: 'warn',
    });
  });

  it('keine Einspeisung: nur die Zeile Netzbezug', () => {
    const v = abrechnungKarte(abrechnung({ einspeisung: null }), { bezug: 5131, einspeisung: null });
    expect(v.zeilen.map((z) => z.richtung)).toEqual(['bezug']);
  });

  it('Zählertausch: die Summe mit Ansage', () => {
    const v = abrechnungKarte(
      abrechnung({ bezug: zeile({ herkunft: 'summe', standVonKwh: null, standBisKwh: null, zaehlerFaellt: true }) }),
      { bezug: null, einspeisung: null },
    );
    expect(v.zeilen[0].herkunft).toBe('aus Messwerten summiert');
    expect(v.saetze[0].text).toMatch(/Zählertausch/);
  });

  it('nie gemessen: ein Strich und ein Satz, keine 0', () => {
    const leer = zeile({ mengeKwh: null, herkunft: null, standVonKwh: null, standBisKwh: null });
    const v = abrechnungKarte(abrechnung({ bezug: leer, einspeisung: null, messbeginn: null, tageVorMessbeginn: 365 }), {
      bezug: 5131,
      einspeisung: null,
    });
    expect(v.zeilen[0].gemessen).toBe('–');
    expect(v.zeilen[0].unterschied).toBeNull();
    expect(v.saetze).toEqual([{ text: 'Für diesen Zeitraum liegen keine Messwerte vor.', ton: 'normal' }]);
  });
});
