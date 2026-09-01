import { describe, expect, it } from 'vitest';
import type { HistoryBucket, SiteEarningsBucket } from './api';
import { NBSP } from './format';
import { PANELS3 } from './chartStyle';
import {
  DETAIL_INHALT,
  ertragKumuliert,
  hatWerte,
  jetztIndex,
  KEIN_GELD_GRUND,
  netzReihe,
  ohneSpeicherAnker,
  PANEL_TITEL,
  panelLayout,
  preisReihe,
  REIHE,
  speicherReihe,
  speicherTagSatz,
  tagesbildAussage,
  tagesbildKern,
  titelTopPct,
} from './tagesbild';

function bucket(over: Partial<HistoryBucket> = {}): HistoryBucket {
  return {
    start: '2026-08-10T00:00:00Z',
    pvKwh: 0,
    loadKwh: 0.5,
    gridImportKwh: 0.5,
    gridExportKwh: 0,
    batteryChargeKwh: 0,
    batteryDischargeKwh: 0,
    socMinPct: 50,
    socMaxPct: 50,
    socLastPct: 50,
    priceEurMwh: 80,
    costEur: 0.1,
    ...over,
  };
}

function geldEimer(start: string, netto: number | null): SiteEarningsBucket {
  return {
    start,
    einspeiseErloesEur: null,
    eigenverbrauchsWertEur: null,
    stromkostenEur: null,
    nettoEur: netto,
  };
}

describe('Panel-Aufteilung (F8 verschärft: drei Flächen, EINE Zeitachse)', () => {
  it('legt alle drei Flächen übereinander und beschriftet die Achse ganz unten', () => {
    const l = panelLayout(true, true);
    expect([l.preis.sichtbar, l.leistung.sichtbar, l.ertrag.sichtbar]).toEqual([true, true, true]);
    // Von oben nach unten, ohne Überlappung.
    expect(l.preis.topPct).toBeLessThan(l.leistung.topPct);
    expect(l.preis.topPct + (l.preis.heightPct ?? 0)).toBeLessThanOrEqual(l.leistung.topPct);
    expect(l.leistung.topPct + (l.leistung.heightPct ?? 0)).toBeLessThanOrEqual(l.ertrag.topPct);
    // K9: die geteilte Zeitachse wird GENAU EINMAL beschriftet - unten.
    expect(l.achseIndex).toBe(2);
  });

  it('lässt eine Fläche ohne Daten auf Höhe 0 schrumpfen, statt sie leer zu behaupten', () => {
    const ohneErtrag = panelLayout(true, false);
    expect(ohneErtrag.ertrag.sichtbar).toBe(false);
    expect(ohneErtrag.ertrag.heightPct).toBe(0);
    // Die Leistung übernimmt den Platz und trägt jetzt die Achse.
    expect(ohneErtrag.leistung.bottomPx).toBe(PANELS3.ohneErtragBottomPx);
    expect(ohneErtrag.achseIndex).toBe(1);

    const ohnePreis = panelLayout(false, true);
    expect(ohnePreis.preis.sichtbar).toBe(false);
    // Ohne Preis rückt die Leistung nach oben - kein leerer Kopfraum.
    expect(ohnePreis.leistung.topPct).toBe(PANELS3.preis.topPct);
    expect(ohnePreis.achseIndex).toBe(2);
  });

  it('hängt die Überschrift an ihre Fläche, nicht an eine feste Zeile', () => {
    const mit = panelLayout(true, true);
    const ohne = panelLayout(false, true);
    expect(titelTopPct(mit.leistung)).toBeGreaterThan(titelTopPct(ohne.leistung));
    // Nie über den oberen Rand hinaus.
    expect(titelTopPct({ topPct: 2, heightPct: 10, sichtbar: true })).toBe(0);
  });

  it('nennt in jeder Überschrift eine AUSSAGE und die Einheit als Wort', () => {
    for (const titel of Object.values(PANEL_TITEL)) {
      expect(titel.text).toMatch(/^Was /);
      expect(titel.einheit.length).toBeGreaterThan(0);
      // K4: die Einheit steht nie nackt als Kürzel da.
      expect(titel.einheit).not.toMatch(/^– (kW|kWh|%|ct\/kWh|€)$/);
    }
    // K3: der Umschalter nennt seinen Inhalt, statt eine Wundertüte zu sein.
    expect(DETAIL_INHALT).toBe('Ladestand, Netz');
  });
});

describe('Die gemessenen Reihen — „null bleibt eine Lücke, nie eine 0"', () => {
  it('rechnet kWh je Eimer in mittlere kW um', () => {
    const b = [bucket({ batteryChargeKwh: 1.5, batteryDischargeKwh: 0 })];
    expect(speicherReihe(b, 15)).toEqual([6]);
    expect(netzReihe([bucket({ gridImportKwh: 0, gridExportKwh: 0.25 })], 15)).toEqual([-1]);
  });

  it('lässt einen Eimer LEER, dem ein Kanal fehlt', () => {
    expect(speicherReihe([bucket({ batteryDischargeKwh: null })], 15)).toEqual([null]);
    expect(netzReihe([bucket({ gridImportKwh: null })], 15)).toEqual([null]);
    expect(preisReihe([bucket({ priceEurMwh: null })])).toEqual([null]);
  });

  it('rechnet den Börsenpreis in ct/kWh (der Endpunkt liefert EUR/MWh)', () => {
    expect(preisReihe([bucket({ priceEurMwh: 212 })])).toEqual([21.2]);
  });

  it('meldet eine leere Reihe als leer', () => {
    expect(hatWerte([null, null])).toBe(false);
    expect(hatWerte([null, 0])).toBe(true);
  });
});

describe('K9 · der Jetzt-Anker', () => {
  const times = ['2026-08-10T10:00:00Z', '2026-08-10T10:15:00Z', '2026-08-10T10:30:00Z'];

  it('zeigt auf den Eimer, in dem jetzt liegt', () => {
    expect(jetztIndex(times, new Date('2026-08-10T10:20:00Z'))).toBe(1);
  });

  it('behauptet auf einem ABGESCHLOSSENEN Tag keinen Jetzt-Punkt', () => {
    expect(jetztIndex(times, new Date('2026-08-11T09:00:00Z'))).toBe(-1);
    expect(jetztIndex(times, new Date('2026-08-09T09:00:00Z'))).toBe(-1);
  });
});

describe('Panel 3 · die Ertragskurve auf der geteilten Zeitachse', () => {
  const times = [
    '2026-08-10T00:00:00Z',
    '2026-08-10T00:15:00Z',
    '2026-08-10T00:30:00Z',
    '2026-08-10T00:45:00Z',
    '2026-08-10T01:00:00Z',
    '2026-08-10T01:15:00Z',
  ];

  it('summiert die STUNDEN-Eimer auf das Viertelstunden-Raster und hält dazwischen', () => {
    const r = ertragKumuliert(times, [
      geldEimer('2026-08-10T00:00:00Z', 2),
      geldEimer('2026-08-10T01:00:00Z', 3),
    ]);
    // Der Stand steigt an der vollen Stunde und ist dazwischen konstant - die
    // Kurve behauptet keine Auflösung, die das Geld nicht hat.
    expect(r.werte).toEqual([2, 2, 2, 2, 5, 5]);
    expect(r.endEur).toBe(5);
    expect(r.endText).toBe(`${REIHE.ertrag} 5,00${NBSP}€`);
    expect(r.vorhanden).toBe(true);
  });

  it('lässt die Zeit VOR dem ersten bewerteten Eimer leer, statt eine 0 zu behaupten', () => {
    const r = ertragKumuliert(times, [geldEimer('2026-08-10T01:00:00Z', 3)]);
    expect(r.werte.slice(0, 4)).toEqual([null, null, null, null]);
    expect(r.werte.slice(4)).toEqual([3, 3]);
  });

  it('behält den vollen Endstand, auch wenn die Achse vor dem letzten Geld-Eimer endet', () => {
    // Sonst stünde am Kurvenende eine kleinere Zahl als in der Ergebnis-Karte.
    const r = ertragKumuliert(times.slice(0, 2), [
      geldEimer('2026-08-10T00:00:00Z', 2),
      geldEimer('2026-08-10T05:00:00Z', 4),
    ]);
    expect(r.endEur).toBe(6);
    expect(r.werte).toEqual([2, 2]);
  });

  it('nennt die Summenkurve „Ergebnis“ — nie „mit VoltPilot“', () => {
    // Der K8-Anker im Kopf sagt „Mit VoltPilot verdient X €" und meint das
    // NETZ-Ergebnis; die Kurve traegt zusaetzlich den Wert des Eigenverbrauchs.
    // Zwei Zahlen unter EINEM Wort - im Browser sofort sichtbar gewesen.
    expect(REIHE.ertrag).toBe('Ergebnis');
    const r = ertragKumuliert(times, [geldEimer('2026-08-10T00:00:00Z', 2)]);
    expect(r.endText).not.toContain('VoltPilot');
  });

  it('ist ohne Geld-Reihe schlicht nicht vorhanden', () => {
    expect(ertragKumuliert(times, null).vorhanden).toBe(false);
    expect(ertragKumuliert(times, []).vorhanden).toBe(false);
    expect(ertragKumuliert([], [geldEimer('2026-08-10T00:00:00Z', 2)]).vorhanden).toBe(false);
  });

  it('behandelt einen Eimer ohne Netto wie die Geld-Karte: er trägt nichts bei', () => {
    const r = ertragKumuliert(times, [
      geldEimer('2026-08-10T00:00:00Z', null),
      geldEimer('2026-08-10T01:00:00Z', 3),
    ]);
    expect(r.werte).toEqual([0, 0, 0, 0, 3, 3]);
  });
});

describe('K1 + K8 · der Kernaussage-Kopf', () => {
  const tag = [
    bucket({ batteryChargeKwh: 3, batteryDischargeKwh: 0 }),
    bucket({ batteryChargeKwh: 0, batteryDischargeKwh: 2 }),
  ];

  it('nennt das GEMESSENE savedEur und verankert es am exakten Paar', () => {
    const k = tagesbildKern({
      geld: { savedEur: 2.73, baselineEur: 3.1, actualEur: 0.37 },
      buckets: tag,
      plantKind: 'eigenverbrauch',
    })!;
    expect(k.wert).toBe(`2,73${NBSP}€`);
    expect(k.satz).toContain('hat die Steuerung an diesem Tag gebracht');
    expect(k.satz).toContain(`3,0${NBSP}kWh geladen`);
    expect(k.satz).toContain(`2,0${NBSP}kWh abgegeben`);
    expect(k.ton).toBe('ok');
    // K8: keine Zahl ohne Vergleichsanker - und der Anker ist das Paar, das der
    // Geld-Held der Anlage seit jeher rechnet.
    expect(k.anker).toBe(
      `Stromkosten mit VoltPilot 0,37${NBSP}€ · Ohne Speicher wären es 3,10${NBSP}€.`,
    );
  });

  it('spricht bei einer Direktvermarktungs-Anlage von „ungeregelt", nicht „ohne Speicher"', () => {
    const k = tagesbildKern({
      geld: { savedEur: 6.74, baselineEur: -3.1, actualEur: -9.84 },
      buckets: tag,
      plantKind: 'direktvermarktung',
    })!;
    expect(k.anker).toBe(
      `Erlös mit VoltPilot 9,84${NBSP}€ · Ungeregelt wären es 3,10${NBSP}€.`,
    );
  });

  it('sagt den ehrlichen GRUND, wenn das Geld nicht berechenbar ist', () => {
    const k = tagesbildKern({
      geld: { savedEur: null, baselineEur: null, actualEur: null },
      buckets: tag,
      plantKind: 'eigenverbrauch',
    })!;
    expect(k.satz).toBeNull();
    expect(k.grund).toBe(KEIN_GELD_GRUND);
    expect(k.wert).toBeNull();
  });

  it('sagt „bisher", solange der Tag noch LÄUFT - und trägt die Bestandszeile', () => {
    const k = tagesbildKern({
      geld: {
        savedEur: -4.69,
        baselineEur: 9.16,
        actualEur: 4.47,
        speicherDeltaKwh: 44.2,
        speicherWertCtKwh: 18.9,
        speicherWertEur: 8.3538,
        speicherWertBasis: 'plan',
        to: '2026-08-22T00:00:00Z',
        range: 'day',
      },
      buckets: tag,
      plantKind: 'eigenverbrauch',
      now: new Date('2026-08-21T10:19:00Z'),
    })!;
    // Ohne das Wort läse sich die Kasse bis JETZT als Tagesergebnis.
    expect(k.satz).toContain('an diesem Tag bisher gebracht');
    // Die zweite Wahrheit steht DANEBEN, nie in der Zahl.
    expect(k.wert).toBe(`-4,69${NBSP}€`);
    expect(k.bestand?.text).toContain('Speicherenergie seit Tagesbeginn gespeichert');
    expect(k.bestand?.badge).toBe('Kein Abzug');
  });

  it('sagt am ABGESCHLOSSENEN Tag wieder „an diesem Tag"', () => {
    const k = tagesbildKern({
      geld: { savedEur: 2.73, baselineEur: 3.1, actualEur: 0.37, to: '2026-08-11T00:00:00Z' },
      buckets: tag,
      plantKind: 'eigenverbrauch',
      now: new Date('2026-08-12T09:00:00Z'),
    })!;
    expect(k.satz).toContain('hat die Steuerung an diesem Tag gebracht');
    expect(k.satz).not.toContain('bisher');
  });

  it('bleibt ohne die Bestandsfelder zeichengleich zu vorher (älteres Backend)', () => {
    const k = tagesbildKern({
      geld: { savedEur: 2.73, baselineEur: 3.1, actualEur: 0.37 },
      buckets: tag,
      plantKind: 'eigenverbrauch',
      now: new Date('2026-08-21T10:19:00Z'),
    })!;
    expect(k.bestand).toBeNull();
    // Ohne Fensterende wird nicht behauptet, der Tag laufe noch.
    expect(k.satz).not.toContain('bisher');
  });

  it('rendert GAR NICHTS, solange das Geld noch nicht geladen ist', () => {
    expect(tagesbildKern({ geld: null, buckets: tag, plantKind: 'eigenverbrauch' })).toBeNull();
  });

  it('macht aus Rundungsrauschen keine Aussage — und dann auch keinen Anker', () => {
    const k = tagesbildKern({
      geld: { savedEur: 0.001, baselineEur: 3.1, actualEur: 3.099 },
      buckets: tag,
      plantKind: 'eigenverbrauch',
    })!;
    expect(k.wert).toBeNull();
    expect(k.anker).toBeNull();
    expect(k.satz).not.toBeNull();
  });

  it('erfindet keinen Anker ohne das exakte Paar', () => {
    expect(ohneSpeicherAnker({ savedEur: 1, baselineEur: null, actualEur: 1 }, 'eigenverbrauch'))
      .toBeNull();
    expect(ohneSpeicherAnker(null, 'eigenverbrauch')).toBeNull();
  });
});

describe('Der Tages-Satz aus den gemessenen Energien', () => {
  it('nennt nur, was wirklich bewegt wurde', () => {
    expect(speicherTagSatz([bucket({ batteryChargeKwh: 4, batteryDischargeKwh: 0 })])).toBe(
      `der Speicher hat 4,0${NBSP}kWh geladen.`,
    );
    expect(speicherTagSatz([bucket({ batteryChargeKwh: 0, batteryDischargeKwh: 4 })])).toBe(
      `der Speicher hat 4,0${NBSP}kWh abgegeben.`,
    );
    expect(speicherTagSatz([bucket({ batteryChargeKwh: 0, batteryDischargeKwh: 0 })])).toBe(
      'der Speicher stand an diesem Tag still.',
    );
  });

  it('behauptet ohne jede Messung gar nichts', () => {
    expect(
      speicherTagSatz([bucket({ batteryChargeKwh: null, batteryDischargeKwh: null })]),
    ).toBeNull();
    expect(speicherTagSatz([])).toBeNull();
  });
});

describe('Die Aussage unter dem Bild', () => {
  it('erklärt die geteilte Zeitachse — immer', () => {
    expect(tagesbildAussage(false)).toContain('teilen eine Zeitachse');
  });

  it('sagt mit Ertrags-Fläche AUSDRÜCKLICH, dass die Gegenwelt nicht gemessen ist', () => {
    const satz = tagesbildAussage(true);
    expect(satz).toContain('nicht gemessen');
    expect(satz).toContain('Tagesergebnis steht oben');
  });
});
