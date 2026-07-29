import { describe, expect, it } from 'vitest';
import type { History, HistoryBucket, HistoryRange } from './api';
import {
  anzeigeWert,
  energieBilanz,
  energieDiagramm,
  energieSummen,
  kwFromKwh,
  gridCostHinweis,
  isCurrentPeriod,
  sumChannel,
  summenTitel,
  toggleSerie,
  vorzeichenLabel,
  zeitraumHinweis,
} from './energieBilanz';

function bucket(o: Partial<HistoryBucket> = {}): HistoryBucket {
  return {
    start: '2026-07-24T10:00:00Z',
    pvKwh: null,
    loadKwh: null,
    gridImportKwh: null,
    gridExportKwh: null,
    batteryChargeKwh: null,
    batteryDischargeKwh: null,
    socMinPct: null,
    socMaxPct: null,
    socLastPct: null,
    priceEurMwh: null,
    costEur: null,
    ...o,
  };
}

function hist(
  buckets: HistoryBucket[],
  totals: Partial<History['totals']> = {},
  range: HistoryRange = 'day',
): History {
  return {
    range,
    from: '',
    to: '',
    bucketMinutes: range === 'day' ? 15 : range === 'week' ? 60 : 1440,
    buckets,
    totals: {
      consumptionKwh: null,
      pvGenerationKwh: null,
      gridImportKwh: null,
      gridExportKwh: null,
      gridCostEur: null,
      tarifArt: 'ohne',
      batterySavingsPlannedEur: null,
      autarkiePct: null,
      eigenverbrauchPct: null,
      ...totals,
    },
    protocol: [],
    plan: [],
  };
}

const by = (summen: ReturnType<typeof energieSummen>, key: string) =>
  summen.find((s) => s.key === key)!;

describe('energieSummen — die sechs Energiemengen des Zeitraums', () => {
  it('summiert alle sechs Kanäle über die Buckets, incl. laden/entladen', () => {
    const s = energieSummen([
      bucket({
        pvKwh: 10,
        loadKwh: 4,
        gridImportKwh: 0.5,
        gridExportKwh: 5,
        batteryChargeKwh: 2,
        batteryDischargeKwh: 0,
      }),
      bucket({
        pvKwh: 6,
        loadKwh: 3,
        gridImportKwh: 1.5,
        gridExportKwh: 1,
        batteryChargeKwh: 1,
        batteryDischargeKwh: 3,
      }),
    ]);
    expect(s.map((x) => x.key)).toEqual([
      'erzeugt',
      'verbraucht',
      'bezogen',
      'eingespeist',
      'geladen',
      'entladen',
    ]);
    expect(by(s, 'erzeugt').kwh).toBe(16);
    expect(by(s, 'verbraucht').kwh).toBe(7);
    expect(by(s, 'bezogen').kwh).toBe(2);
    expect(by(s, 'eingespeist').kwh).toBe(6);
    // Die zwei Summen, die `totals` NICHT liefert — clientseitig gebildet.
    expect(by(s, 'geladen').kwh).toBe(3);
    expect(by(s, 'entladen').kwh).toBe(3);
  });

  it('ist null, wenn KEIN Bucket den Kanal trug — nie eine erfundene 0', () => {
    const s = energieSummen([bucket({ pvKwh: 5 }), bucket({ pvKwh: 2 })]);
    expect(by(s, 'erzeugt').kwh).toBe(7);
    expect(by(s, 'geladen').kwh).toBeNull();
    expect(by(s, 'entladen').kwh).toBeNull();
    expect(by(s, 'bezogen').kwh).toBeNull();
  });

  it('zählt eine GEMESSENE 0 als Wert (ein Speicher, der ruhte, ist kein Loch)', () => {
    const s = energieSummen([bucket({ batteryChargeKwh: 0, batteryDischargeKwh: 0 })]);
    expect(by(s, 'geladen').kwh).toBe(0);
    expect(by(s, 'entladen').kwh).toBe(0);
  });

  it('ignoriert NaN/Infinity statt sie durchzurechnen', () => {
    expect(sumChannel([bucket({ pvKwh: Number.NaN }), bucket({ pvKwh: 3 })], 'pvKwh')).toBe(3);
    expect(sumChannel([bucket({ pvKwh: Number.POSITIVE_INFINITY })], 'pvKwh')).toBeNull();
  });

  it('trägt je Summe ein deutsches Etikett, eine Farbe und einen Hinweis', () => {
    for (const s of energieSummen([bucket({ pvKwh: 1 })])) {
      expect(s.label).toMatch(/^[A-ZÄÖÜ]/);
      expect(s.hinweis.length).toBeGreaterThan(10);
      expect(s.farbe).toBeTruthy();
    }
  });
});

describe('energieBilanz — Summen + Quoten + Kosten', () => {
  it('nimmt Quoten und Kosten aus totals (die brauchen Preise/Plan)', () => {
    const b = energieBilanz(
      hist([bucket({ pvKwh: 10, gridImportKwh: 2 })], {
        autarkiePct: 82,
        eigenverbrauchPct: 64,
        gridCostEur: 0.94,
      }),
    );
    expect(b.autarkiePct).toBe(82);
    expect(b.eigenverbrauchPct).toBe(64);
    expect(b.gridCostEur).toBe(0.94);
    expect(b.empty).toBe(false);
  });

  it('meldet empty, wenn nicht eine einzige Summe vorliegt', () => {
    expect(energieBilanz(hist([bucket(), bucket()])).empty).toBe(true);
    expect(energieBilanz(hist([])).empty).toBe(true);
    expect(energieBilanz(hist([bucket({ loadKwh: 0 })])).empty).toBe(false);
  });

  it('benennt die Bewertungsbasis der Netzkosten ehrlich (Stufe 3)', () => {
    // Seit dem strukturierten Bezugspreis rechnet der Server mit dem Tarif,
    // sobald einer greift (`tarifPriced`); ohne Preispflege bleibt es der
    // Börsenpreis - und ein älteres Backend ohne das Flag behauptet nie einen
    // Tarif, der nicht eingerechnet ist.
    expect(gridCostHinweis(true)).toBe('bewertet zu Ihrem Stromtarif');
    expect(gridCostHinweis(false)).toBe('zu Börsenpreisen');
    expect(gridCostHinweis(null)).toBe('zu Börsenpreisen');
    expect(gridCostHinweis(undefined)).toBe('zu Börsenpreisen');
    expect(energieBilanz(hist([], { tarifArt: 'dynamisch', tarifPriced: true })).gridCostHinweis).toBe(
      'bewertet zu Ihrem Stromtarif',
    );
    expect(energieBilanz(hist([], { tarifArt: 'dynamisch' })).gridCostHinweis).toBe(
      'zu Börsenpreisen',
    );
  });
});

describe('Zeitraum-Ehrlichkeit — nie zwei Zahlen unter einem Wort', () => {
  const now = new Date(2026, 6, 24, 12, 0); // Fr, 24.07.2026

  it('erkennt den laufenden Zeitraum je Bereich', () => {
    expect(isCurrentPeriod(new Date(2026, 6, 24), 'day', now)).toBe(true);
    expect(isCurrentPeriod(new Date(2026, 6, 23), 'day', now)).toBe(false);
    expect(isCurrentPeriod(new Date(2026, 6, 20), 'week', now)).toBe(true); // Mo derselben KW
    expect(isCurrentPeriod(new Date(2026, 6, 13), 'week', now)).toBe(false);
    expect(isCurrentPeriod(new Date(2026, 6, 1), 'month', now)).toBe(true);
    expect(isCurrentPeriod(new Date(2026, 5, 30), 'month', now)).toBe(false);
    expect(isCurrentPeriod(new Date(2026, 0, 1), 'year', now)).toBe(true);
    expect(isCurrentPeriod(new Date(2025, 11, 31), 'year', now)).toBe(false);
  });

  it('gibt im laufenden Zeitraum KEINEN Hinweis (es gibt keinen Widerspruch)', () => {
    expect(zeitraumHinweis(new Date(2026, 6, 24), 'day', now)).toBeNull();
    expect(zeitraumHinweis(new Date(2026, 6, 1), 'month', now)).toBeNull();
  });

  it('nennt bei einem vergangenen Zeitraum ausdrücklich sein Etikett', () => {
    const note = zeitraumHinweis(new Date(2026, 5, 15), 'month', now);
    expect(note).toContain('Juni 2026');
    expect(note).toContain('nicht für heute');
  });

  it('führt den Zeitraum im Titel der Kennzahl-Zeile', () => {
    expect(summenTitel(new Date(2026, 6, 24), 'month')).toBe('Energie im Zeitraum · Juli 2026');
    expect(summenTitel(new Date(2026, 6, 24), 'year')).toBe('Energie im Zeitraum · 2026');
  });
});

// --- B1-a: die Reihen des EINEN Diagramms -----------------------------------

describe('energieDiagramm — EIN Diagramm, alle Reihen', () => {
  const now = new Date('2026-07-24T10:30:00Z');

  const tagesBuckets = [
    bucket({
      start: '2026-07-24T10:00:00Z',
      pvKwh: 2.5, // 15-Min-Bucket → 10 kW
      loadKwh: 0.5, // → 2 kW
      gridImportKwh: 0,
      gridExportKwh: 1.5, // → −6 kW
      batteryChargeKwh: 0.5,
      batteryDischargeKwh: 0, // → +2 kW
      socLastPct: 76,
    }),
    bucket({
      start: '2026-07-24T10:15:00Z',
      pvKwh: 0,
      loadKwh: 0.75,
      gridImportKwh: 0.5,
      gridExportKwh: 0,
      batteryChargeKwh: 0,
      batteryDischargeKwh: 0.25,
      socLastPct: 74,
    }),
  ];

  const serie = (d: ReturnType<typeof energieDiagramm>, key: string) =>
    d.serien.find((s) => s.key === key)!;

  it('trägt genau die fünf Reihen der Standardansicht', () => {
    const d = energieDiagramm(hist(tagesBuckets), now);
    expect(d.serien.map((s) => s.key)).toEqual(['pv', 'haus', 'netz', 'batterie', 'soc']);
    expect(d.serien.map((s) => s.label)).toEqual([
      'PV-Erzeugung',
      'Hausverbrauch',
      'Netz',
      'Batterie',
      'Ladestand',
    ]);
  });

  it('rechnet am Tag kWh in mittlere kW um, der Ladestand bleibt Prozent', () => {
    const d = energieDiagramm(hist(tagesBuckets), now);
    expect(d.einheit).toBe('kW');
    expect(d.balken).toBe(false);
    expect(serie(d, 'pv').werte).toEqual([10, 0]);
    expect(serie(d, 'haus').werte).toEqual([2, 3]);
    expect(serie(d, 'soc').werte).toEqual([76, 74]);
    expect(serie(d, 'soc').unit).toBe('%');
    expect(serie(d, 'soc').zweiteAchse).toBe(true);
  });

  it('spiegelt Netz und Batterie vorzeichenrichtig um die Nulllinie', () => {
    const d = energieDiagramm(hist(tagesBuckets), now);
    // Netz: Bezug positiv, Einspeisung negativ.
    expect(serie(d, 'netz').werte).toEqual([-6, 2]);
    expect(serie(d, 'netz').signed).toBe(true);
    expect(serie(d, 'netz').vorzeichen).toBe('+ Bezug / − Einspeisung');
    // Batterie: laden positiv, entladen negativ.
    expect(serie(d, 'batterie').werte).toEqual([2, -1]);
    expect(serie(d, 'batterie').vorzeichen).toBe('+ laden / − entladen');
  });

  it('zeigt ab der Woche kWh-Balken statt kW-Linien (SolarEdge/Fronius-Wechsel)', () => {
    const d = energieDiagramm(
      hist([bucket({ pvKwh: 40, loadKwh: 12, socLastPct: 80 })], {}, 'month'),
      now,
    );
    expect(d.balken).toBe(true);
    expect(d.einheit).toBe('kWh');
    expect(serie(d, 'pv').werte).toEqual([40]); // keine kW-Umrechnung
    expect(serie(d, 'pv').linie).toBe(false);
    // Der Ladestand bleibt auch dort eine %-Linie.
    expect(serie(d, 'soc').linie).toBe(true);
    expect(serie(d, 'soc').unit).toBe('%');
  });

  it('lässt einen fehlenden Wert abwesend — nie eine 0-Linie', () => {
    const d = energieDiagramm(
      hist([bucket({ pvKwh: 2.5, socLastPct: null }), bucket({ pvKwh: null })]),
      now,
    );
    expect(serie(d, 'pv').werte).toEqual([10, null]);
    expect(serie(d, 'pv').leer).toBe(false);
    expect(serie(d, 'haus').werte).toEqual([null, null]);
  });

  it('nennt bei einer leeren Reihe den ehrlichen Grund — nie „keine Batterie"', () => {
    const d = energieDiagramm(hist([bucket({ pvKwh: 1 })]), now);
    const batt = serie(d, 'batterie');
    expect(batt.leer).toBe(true);
    expect(batt.fehlt).toContain('keine Werte');
    for (const s of d.serien) {
      expect(s.fehlt ?? '').not.toMatch(/kein(e|en)? (Batterie|Speicher vorhanden|Zähler)/);
    }
    expect(serie(d, 'pv').fehlt).toBeNull();
    expect(d.leer).toBe(false);
  });

  it('meldet leer, wenn keine einzige Reihe einen Wert hat', () => {
    expect(energieDiagramm(hist([bucket(), bucket()]), now).leer).toBe(true);
    expect(energieDiagramm(hist([]), now).leer).toBe(true);
  });

  it('setzt den Jetzt-Marker nur im Tagesbereich auf den laufenden Bucket', () => {
    expect(energieDiagramm(hist(tagesBuckets), now).jetztIndex).toBe(1);
    expect(energieDiagramm(hist(tagesBuckets), new Date('2026-07-24T10:05:00Z')).jetztIndex).toBe(0);
    // Ein Zeitraum ganz in der Zukunft hat keinen Jetzt-Marker.
    expect(energieDiagramm(hist(tagesBuckets), new Date('2026-07-23T00:00:00Z')).jetztIndex).toBe(-1);
    // Ab der Woche gibt es keinen (die Buckets sind Tage/Stunden).
    expect(energieDiagramm(hist(tagesBuckets, {}, 'month'), now).jetztIndex).toBe(-1);
  });

  it('schützt gegen eine unsinnige Bucket-Länge statt Infinity zu zeichnen', () => {
    expect(kwFromKwh(1, 0)).toBeNull();
    expect(kwFromKwh(null, 15)).toBeNull();
    expect(kwFromKwh(2.5, 15)).toBe(10);
  });
});

describe('Tooltip-Klartext — alle Reihen zu einem Zeitpunkt', () => {
  it('macht aus dem Vorzeichen ein Wort, nie ein Minuszeichen', () => {
    expect(vorzeichenLabel('netz', 4.4)).toBe('Netzbezug');
    expect(vorzeichenLabel('netz', -55)).toBe('Einspeisung');
    expect(vorzeichenLabel('netz', 0)).toBe('Netz ausgeglichen');
    expect(vorzeichenLabel('batterie', 10)).toBe('Batterie lädt');
    expect(vorzeichenLabel('batterie', -3)).toBe('Batterie entlädt');
    expect(vorzeichenLabel('batterie', 0.01)).toBe('Batterie hält');
    expect(vorzeichenLabel('pv', 70)).toBe('PV-Erzeugung');
    expect(vorzeichenLabel('haus', 5)).toBe('Hausverbrauch');
    expect(vorzeichenLabel('soc', 76)).toBe('Ladestand');
  });

  it('zeigt den Betrag ohne Vorzeichen, wo das Wort die Richtung trägt', () => {
    expect(anzeigeWert({ signed: true }, -55)).toBe(55);
    expect(anzeigeWert({ signed: false }, 70)).toBe(70);
    // Eine unsignierte Reihe behält ein (physikalisch mögliches) Minus.
    expect(anzeigeWert({ signed: false }, -0.2)).toBe(-0.2);
  });
});

describe('toggleSerie — die Legende ist die Bedienung', () => {
  it('blendet eine Reihe aus und wieder ein', () => {
    const off = toggleSerie(new Set(), 'Netz', 5);
    expect([...off]).toEqual(['Netz']);
    expect([...toggleSerie(off, 'Netz', 5)]).toEqual([]);
  });

  it('lässt die LETZTE sichtbare Reihe nie ausblenden', () => {
    let hidden = new Set<string>();
    for (const key of ['PV-Erzeugung', 'Hausverbrauch', 'Netz', 'Batterie', 'Ladestand']) {
      hidden = toggleSerie(hidden, key, 5);
    }
    expect(hidden.size).toBe(4);
    expect(hidden.has('Ladestand')).toBe(false);
  });

  it('mutiert die übergebene Menge nicht (React-State-Disziplin)', () => {
    const before = new Set(['Netz']);
    const after = toggleSerie(before, 'Batterie', 5);
    expect([...before]).toEqual(['Netz']);
    expect(after.has('Batterie')).toBe(true);
  });
});
