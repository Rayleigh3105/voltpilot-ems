import { describe, expect, it } from 'vitest';

import type { SiteEarnings } from './api';
import {
  CHIP_MIN_ABSTAND,
  KERNSATZ,
  MEHRERE_MONATE_HINWEIS,
  NICHTS_EINGESPEIST_HINWEIS,
  UNTER_DURCHSCHNITT_ZUSATZ,
  capTextLength,
  chartLayout,
  gesamtMarke,
  soVerdient,
  spreadChips,
  verdictChip,
} from './soVerdient';

/**
 * Die ECHTEN Zahlen des Konzepts (`vp-ertrag-kombi-konzept-t7` §2), damit die
 * Tests dieselbe Geschichte prüfen, die das Bild erzählt:
 *
 *  - **August 2026 (real):** AW 6,9 · Ø 7,0 **vorläufig** · erzielt 9,9
 *    ⇒ Prämie 0,00 €, und die 0,1-ct-Lage kann sich noch drehen (S3).
 *  - **Prämien-Monat:** Ø 5,8 **amtlich** · AW 6,9 ⇒ Satz 1,1 ct
 *    × 9.573,8 kWh = 105,31 € (S1) — dieselben Vektoren wie
 *    `marktpraemie.test.ts`.
 */
function anlage(over: Partial<SiteEarnings> = {}): SiteEarnings {
  return {
    siteId: 's1',
    name: 'Solarpark Dachau',
    range: 'month',
    from: '2026-07-31T22:00:00Z',
    to: '2026-08-31T22:00:00Z',
    plantKind: 'direktvermarktung',
    tarifArt: 'dynamisch',
    tarifParamCtKwh: 18,
    tarifPriced: true,
    anzulegenderWertCtKwh: 6.9,
    coveredSlots: 2880,
    firstCoveredDate: '2026-08-01',
    reason: null,
    einspeiseErloesEur: 947.8,
    eigenverbrauchsWertEur: 120,
    stromkostenEur: 80,
    nettoErgebnisEur: 987.8,
    savedEur: 210,
    arbitrageEur: null,
    pvShiftEur: null,
    baselineEur: null,
    actualEur: null,
    marktpraemieEur: 0,
    bezugspreisCtKwh: 30.2,
    realizedExportCtKwh: 9.9,
    marketValueSolarCtKwh: 7.0,
    marketValueProvisional: true,
    bezogenKwh: 265,
    eingespeistKwh: 9573.8,
    selbstverbrauchKwh: 400,
    batterieBewegtKwh: 900,
    series: [],
    ...over,
  };
}

/** Der Prämien-Monat aus dem Konzept: Ø 5,8 amtlich, Satz 1,1 ct, 105,31 €. */
function praemienMonat(over: Partial<SiteEarnings> = {}): SiteEarnings {
  return anlage({
    marketValueSolarCtKwh: 5.8,
    marketValueProvisional: false,
    realizedExportCtKwh: 7.4,
    marktpraemieEur: 105.31,
    // 9.573,8 kWh × 7,4 ct + 105,31 € = 813,77 € ⇒ effektiv 8,5 ct je kWh.
    einspeiseErloesEur: 813.77,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// S1 — der Prämien-Monat: der Beweis steckt in der Geometrie
// ---------------------------------------------------------------------------

describe('soVerdient · S1 Prämien-Monat', () => {
  it('zeigt beide Säulen, den Prämien-Block und die Aufstockungs-Rechnung', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    expect(v.form).toBe('chart');
    expect(v.state).toBe('praemien_monat');
    expect(v.titel).toBe('So verdient Ihre Anlage · August 2026');
    expect(v.chart).toMatchObject({ oeCt: 5.8, erCt: 7.4, awCt: 6.9, vorlaeufig: false });
    // Der Satz IST `AW − Ø` — dieselbe Größe wie in der Prämien-Rechnung.
    expect(v.chart!.satzCt).toBeCloseTo(1.1, 10);
    expect(v.praemie.state).toBe('aufstockung');
    expect(v.praemie.note).toContain('6,9 − 5,8 = 1,1');
  });

  it('ist der SICHTBARE Beweis: die Blockhöhe IST der Abstand der beiden Linien', () => {
    // Genau das ist die Pointe — die Prämie hängt am Ø, nicht an der eigenen
    // Säule. Also muss der grüne Block EXAKT von Ø auf AW reichen: keine
    // Fuge, keine Rundung, kein Pixel Abzug (im Browser nachgemessen, PR-Fund).
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    const l = chartLayout(v.chart!);
    const linienAbstand = l.oeLine!.y1 - l.awLine!.y1;
    expect(l.praemieBar!.height).toBeCloseTo(linienAbstand, 6);
  });

  it('legt die Weißfuge ÜBER die Grenze, statt sie einem Segment abzuziehen', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    const l = chartLayout(v.chart!);
    // Beide Segmente stoßen exakt aneinander …
    expect(l.praemieBar!.y + l.praemieBar!.height).toBeCloseTo(l.erBar.y, 6);
    // … und die Fuge sitzt mittig auf dieser Grenze.
    expect(l.fuge!.y + l.fuge!.height / 2).toBeCloseTo(l.erBar.y, 6);
    expect(l.fuge!.height).toBe(2);
  });

  it('hat ohne Prämie weder Block noch Fuge', () => {
    const l = chartLayout(soVerdient({ money: anlage(), siteId: 's1' })!.chart!);
    expect(l.praemieBar).toBeNull();
    expect(l.fuge).toBeNull();
  });

  it('trägt die Gesamtmarke nur, weil die Rechnung mit dem Server aufgeht', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    expect(v.chart!.topLabel).toBe('7,4 + 1,1 = 8,5 ct je kWh');
  });

  it('verschweigt die Gesamtmarke, sobald §51 Satz und Erlös auseinandertreibt', () => {
    // Negativpreis-Viertelstunden setzen die Prämie aus: der Monats-SATZ bleibt
    // 1,1 ct, effektiv kommt weniger an. Dann behauptet das Bild keine Summe.
    const v = soVerdient({
      money: praemienMonat({ einspeiseErloesEur: 760 }),
      siteId: 's1',
    })!;
    expect(v.chart!.topLabel).toBe('7,4 + 1,1 ct');
  });
});

// ---------------------------------------------------------------------------
// S2 / S3 — „voll aus dem Markt", einmal deutlich, einmal knapp + vorläufig
// ---------------------------------------------------------------------------

describe('soVerdient · S2 starker Monat (amtlich)', () => {
  it('zeigt keinen Geister-Block und keinen Fehlerton — die Null ist gut', () => {
    const v = soVerdient({
      money: anlage({ marketValueSolarCtKwh: 7.8, marketValueProvisional: false }),
      siteId: 's1',
    })!;
    expect(v.state).toBe('voll_aus_dem_markt');
    expect(v.chart!.satzCt).toBe(0);
    expect(v.chart!.vorlaeufig).toBe(false);
    expect(v.verdict!.ton).toBe('vorteil');
    expect(v.praemie.state).toBe('voll_aus_dem_markt');
    expect(v.praemie.wert).toContain('0,00');
    // Kein Prämien-Block ⇒ genau EIN Chip (der Garantiewert).
    expect(chartLayout(v.chart!).chips).toHaveLength(1);
  });
});

describe('soVerdient · S3 der reale August: knapp + vorläufig', () => {
  it('markiert den vorläufigen Stand und lässt die Prämien-Zeile warnen', () => {
    const v = soVerdient({ money: anlage(), siteId: 's1' })!;
    expect(v.state).toBe('voll_aus_dem_markt');
    expect(v.chart!.vorlaeufig).toBe(true);
    expect(v.verdict!.text).toBe('+ 2,9 ct über dem Monatsdurchschnitt');
    // Die 0,1-ct-Lage kann kippen — das sagt die Zeile, nicht das Bild.
    expect(v.praemie.vorlaeufigKnapp).toBe(true);
    expect(v.praemie.hinweise.some((h) => h.includes('kann sich noch ändern'))).toBe(true);
  });

  it('bleibt bei 0,1 ct ehrlich winzig, statt den Abstand aufzublasen', () => {
    // Der Grenzfall des Konzepts: Ø 7,0 gegen Garantiewert 6,9. Beide Linien
    // müssen existieren und dürfen NICHT künstlich getrennt werden — die
    // Aussage trägt dort der `marktpraemie`-Satz, nicht die Geometrie.
    const v = soVerdient({ money: anlage(), siteId: 's1' })!;
    const l = chartLayout(v.chart!);
    const abstand = l.awLine!.y1 - l.oeLine!.y1;
    expect(abstand).toBeGreaterThan(0);
    expect(abstand).toBeLessThan(4);
    // Und der eine Chip hängt trotzdem per Leader-Linie an seiner echten Höhe.
    expect(l.chips[0].anchorY).toBeCloseTo(l.awLine!.y1, 6);
    expect(l.chips[0].leader.y1).toBeCloseTo(l.awLine!.y1, 6);
  });
});

// ---------------------------------------------------------------------------
// S4 — unter Ø: der Captain-Override (05.08.2026)
// ---------------------------------------------------------------------------

describe('soVerdient · S4 unter dem Durchschnitt (Captain-Override)', () => {
  const unten = () =>
    soVerdient({ money: anlage({ realizedExportCtKwh: 6.1, range: 'day' }), siteId: 's1' })!;

  it('ist AUFMERKSAM, nicht neutral — unter Ø zu verkaufen ist das Gegenteil von Optimieren', () => {
    const v = unten();
    expect(v.verdict!.ton).toBe('aufmerksam');
    expect(v.verdict!.ton).not.toBe('neutral');
  });

  it('nennt den Grund im Wortlaut des Captains, nicht nur in der Farbe', () => {
    const v = unten();
    expect(v.verdict!.text).toBe(
      `0,9 ct unter dem Monatsdurchschnitt — ${UNTER_DURCHSCHNITT_ZUSATZ}`,
    );
    expect(v.verdict!.text).toContain('prüfenswert');
    expect(v.verdict!.text).toContain('verkauft normalerweise über dem Durchschnitt');
  });

  it('darf sich nie wie ein hinnehmbarer Normaltag lesen', () => {
    const v = unten();
    const t = v.verdict!.text.toLowerCase();
    // Die ENTSCHULDIGUNGEN, die der Captain ausdrücklich verworfen hat — der
    // Vorgänger-Entwurf las sich als „ein trüber Tag ist kein Fehler".
    for (const entschuldigung of ['kein fehler', 'trüber tag', 'in ordnung', 'keine sorge']) {
      expect(t).not.toContain(entschuldigung);
    }
    // Und der Chip ist NIE nur die nackte Einordnung: der Prüf-Zusatz gehört
    // dazu, sonst läse er sich wie jede andere Lage.
    expect(v.verdict!.text).not.toBe(v.verdict!.vergleich);
    expect(v.verdict!.text.length).toBeGreaterThan(v.verdict!.vergleich.length);
  });

  it('behält den ehrlichen Tages-Zusatz: abgerechnet wird der MONAT', () => {
    const v = unten();
    expect(v.praemie.anteiligText).toBe('anteilig — abgerechnet je Monat');
    expect(v.praemie.hinweise).toContain('anteilig — abgerechnet je Monat');
    // Und die eigene Säule sagt, dass sie einen Tag zeigt.
    expect(v.chart!.eigenCaption).toBe('Ihre Anlage · Tag');
  });

  it('lässt das Bild ehrlich: die eigene Säule endet UNTER der Ø-Linie', () => {
    const l = chartLayout(unten().chart!);
    // Kleineres y = höher. Die eigene Säule muss tiefer beginnen als der Ø.
    expect(l.erBar.y).toBeGreaterThan(l.oeLine!.y1);
  });

  it('bleibt neutral, solange die Lage wirklich auf Höhe des Ø liegt', () => {
    const v = soVerdient({ money: anlage({ realizedExportCtKwh: 7.02 }), siteId: 's1' })!;
    expect(v.verdict!.ton).toBe('neutral');
    expect(v.verdict!.text).toBe('etwa auf Höhe des Monatsdurchschnitts');
  });
});

// ---------------------------------------------------------------------------
// S5 — AW fehlt: gleiche Bild-Familie, nur ohne Garantie (Captain bestätigt)
// ---------------------------------------------------------------------------

describe('soVerdient · S5 kein anzulegender Wert', () => {
  const ohneAw = () =>
    soVerdient({ money: anlage({ anzulegenderWertCtKwh: null }), siteId: 's1' })!;

  it('bleibt dieselbe Bild-Familie wie S2/S3 — beide Säulen, Vergleich lebendig', () => {
    const v = ohneAw();
    expect(v.form).toBe('chart');
    expect(v.state).toBe('ohne_garantiewert');
    expect(v.chart!.oeCt).toBe(7.0);
    expect(v.chart!.erCt).toBe(9.9);
    // Der Timing-Vergleich funktioniert WEITER — das ist der ganze Punkt.
    expect(v.verdict!.text).toBe('+ 2,9 ct über dem Monatsdurchschnitt');
  });

  it('lässt Garantie-Linie und Prämien-Block ehrlich weg', () => {
    const v = ohneAw();
    expect(v.chart!.awCt).toBeNull();
    expect(v.chart!.satzCt).toBe(0);
    const l = chartLayout(v.chart!);
    expect(l.awLine).toBeNull();
    expect(l.chips).toHaveLength(0);
    // An der Stelle der fehlenden Linie steht der GRUND.
    expect(l.awFehltNote!.map((n) => n.text)).toEqual(['Garantiewert', 'nicht hinterlegt']);
  });

  it('zeigt „—" mit Grund und dem Weg dorthin — nie „0,00 €"', () => {
    const v = ohneAw();
    expect(v.praemie.state).toBe('kein_wert');
    expect(v.praemie.wert).toBe('—');
    expect(v.praemie.note).toContain('Kein anzulegender Wert hinterlegt');
    expect(v.praemie.href).toBeTruthy();
  });

  it('erfindet auch dann keine Null, wenn der Server eine 0 liefert', () => {
    const v = soVerdient({
      money: anlage({ anzulegenderWertCtKwh: null, marktpraemieEur: 0 }),
      siteId: 's1',
    })!;
    expect(v.praemie.wert).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// S6 — Ø fehlt: ein leerer Platz MIT Grund, nie eine erfundene Säule
// ---------------------------------------------------------------------------

describe('soVerdient · S6 kein Monatsmarktwert', () => {
  const ohneOe = () =>
    soVerdient({
      money: anlage({
        marketValueSolarCtKwh: null,
        marketValueProvisional: null,
        marktpraemieEur: null,
        realizedExportCtKwh: 9.1,
      }),
      siteId: 's1',
    })!;

  it('zeigt einen gestrichelten Leer-Platzhalter statt eines Werts', () => {
    const v = ohneOe();
    expect(v.state).toBe('ohne_monatswert');
    expect(v.chart!.oeCt).toBeNull();
    const l = chartLayout(v.chart!);
    expect(l.oeBar).toBeNull();
    expect(l.oeLine).toBeNull();
    expect(l.oePlaceholder!.dash.text).toBe('—');
    expect(l.oePlaceholder!.grund.map((g) => g.text)).toEqual(['noch nicht', 'veröffentlicht']);
  });

  it('lässt den Verdikt-Chip weg — ohne Maßstab wird nichts behauptet', () => {
    expect(ohneOe().verdict).toBeNull();
  });

  it('zeigt erzielt gegen Garantie weiter und nennt den Grund in der Zeile', () => {
    const v = ohneOe();
    expect(v.chart!.erCt).toBe(9.1);
    expect(v.chart!.awCt).toBe(6.9);
    expect(v.praemie.state).toBe('nicht_berechenbar');
    expect(v.praemie.note).toContain('noch kein Monatsmarktwert Solar veröffentlicht');
  });
});

// ---------------------------------------------------------------------------
// S7 — nichts eingespeist: kein Bild ohne eigene Säule
// ---------------------------------------------------------------------------

describe('soVerdient · S7 nichts eingespeist', () => {
  const leer = () =>
    soVerdient({
      money: anlage({
        realizedExportCtKwh: null,
        eingespeistKwh: null,
        einspeiseErloesEur: null,
        marktpraemieEur: null,
      }),
      siteId: 's1',
    })!;

  it('fällt auf den Satz zurück, statt eine Säule zu erfinden', () => {
    const v = leer();
    expect(v.form).toBe('fallback');
    expect(v.state).toBe('nichts_eingespeist');
    expect(v.chart).toBeNull();
    expect(v.verdict).toBeNull();
    expect(v.hinweis).toBe(NICHTS_EINGESPEIST_HINWEIS);
    expect(v.kernsatz).toBeNull();
  });

  it('übernimmt nur die Prämien-Zeile — die Preis-Karte behält ihre Zahlen', () => {
    // Der Ø kann veröffentlicht sein, obwohl diese Anlage nichts eingespeist
    // hat. Ihn hier zu absorbieren würde eine echte Zahl verschlucken.
    expect(leer().absorbiert).toEqual(['marktpraemie']);
  });
});

// ---------------------------------------------------------------------------
// S8 — mehrere Monate: lieber kein Monat als der falsche
// ---------------------------------------------------------------------------

describe('soVerdient · S8 Mehrmonats-Zeitraum', () => {
  const jahr = () =>
    soVerdient({
      money: anlage({
        range: 'year',
        from: '2025-12-31T23:00:00Z',
        to: '2026-12-31T23:00:00Z',
        marktpraemieEur: 512.4,
        marketValueSolarCtKwh: 6.8,
        realizedExportCtKwh: 8.2,
      }),
      siteId: 's1',
    })!;

  it('zeigt KEIN Bild — ein Ø über zwölf Monatswerte wäre eine Behauptung', () => {
    const v = jahr();
    expect(v.form).toBe('rows');
    expect(v.state).toBe('mehrere_monate');
    expect(v.chart).toBeNull();
    expect(v.verdict).toBeNull();
    expect(v.hinweis).toBe(MEHRERE_MONATE_HINWEIS);
    expect(v.hinweis).toContain('wählen Sie einen Monat');
  });

  it('nennt keinen Monat in der Überschrift, statt einen zu wählen', () => {
    const v = jahr();
    expect(v.titel).toBe('So verdient Ihre Anlage');
    expect(v.monatLabel).toBeNull();
    expect(v.praemie.label).toBe('Marktprämie');
  });

  it('trägt die absorbierten Kacheln WÖRTLICH weiter', () => {
    const v = jahr();
    expect(v.zeilen[0].wert).toBe('8,2 ct/kWh');
    expect(v.zeilen[0].note).toBe('1,4 ct über dem Monatsdurchschnitt');
    expect(v.zeilen[1].label).toBe('Monatsmarktwert Solar');
  });

  it('zeigt die Prämie NUR in ihrer Fußzeile — nicht zusätzlich als Kachel', () => {
    // Im Browser aufgefallen: derselbe Betrag samt Rechnung stand zweimal auf
    // EINER Karte. Absorbiert wird sie trotzdem, sonst stünde sie ein drittes
    // Mal auf der Preis-Karte.
    const v = jahr();
    expect(v.zeilen.map((z) => z.id)).toEqual(['marktwert', 'monatsmarktwert']);
    expect(v.absorbiert).toEqual(['marktwert', 'monatsmarktwert', 'marktpraemie']);
    expect(v.praemie.wert).toContain('512,40');
  });
});

// ---------------------------------------------------------------------------
// S9 — nicht direkt vermarktet: gar keine Karte
// ---------------------------------------------------------------------------

describe('soVerdient · S9 nicht direkt vermarktet', () => {
  it('rendert nicht — ohne Direktvermarktung gibt es keine Prämie als Maßstab', () => {
    expect(soVerdient({ money: anlage({ plantKind: 'eigenverbrauch' }), siteId: 's1' })).toBeNull();
  });

  it('rendert auch ohne Antwort nicht, statt ein leeres Bild zu bauen', () => {
    expect(soVerdient({ money: null })).toBeNull();
    expect(soVerdient({ money: undefined })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Der Rahmen: Kernsatz, Absorption und die eine Wahrheit
// ---------------------------------------------------------------------------

describe('soVerdient · der Rahmen', () => {
  it('trägt den Kernsatz unter JEDEM Bild — er ist in beiden Prämien-Lagen wahr', () => {
    for (const m of [anlage(), praemienMonat(), anlage({ anzulegenderWertCtKwh: null })]) {
      expect(soVerdient({ money: m, siteId: 's1' })!.kernsatz).toBe(KERNSATZ);
    }
    expect(KERNSATZ).toContain('richtet sich nach dem Durchschnitt');
    expect(KERNSATZ).toContain('ungeschmälert');
  });

  it('absorbiert im Bild-Fall genau die drei Export-Zeilen', () => {
    expect(soVerdient({ money: anlage(), siteId: 's1' })!.absorbiert).toEqual([
      'marktwert',
      'monatsmarktwert',
      'marktpraemie',
    ]);
  });

  it('baut ohne bekannte Anlage keinen Link ins Leere', () => {
    const v = soVerdient({ money: anlage({ anzulegenderWertCtKwh: null }) })!;
    expect(v.praemie.href).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Die reinen Geometrie-Helfer — Kollision, Kappung, ehrliche Skala
// ---------------------------------------------------------------------------

describe('spreadChips · kollidierende Chips werden entzerrt, nicht verschoben', () => {
  it('spreizt zwei zu nahe Chips symmetrisch um ihre Mitte', () => {
    const chips = [{ y: 100 }, { y: 110 }];
    spreadChips(chips);
    expect(chips[0].y).toBe(105 - 17);
    expect(chips[1].y).toBe(105 + 17);
    expect(chips[1].y - chips[0].y).toBe(34);
  });

  it('lässt weit auseinanderliegende Chips unangetastet', () => {
    const chips = [{ y: 40 }, { y: 40 + CHIP_MIN_ABSTAND }];
    spreadChips(chips);
    expect(chips.map((c) => c.y)).toEqual([40, 40 + CHIP_MIN_ABSTAND]);
  });

  it('spreizt auch, wenn der tiefere Chip zuerst kommt', () => {
    const chips = [{ y: 120 }, { y: 112 }];
    spreadChips(chips);
    expect(chips[0].y).toBe(116 + 17); // war unten, bleibt unten
    expect(chips[1].y).toBe(116 - 17);
  });

  it('fasst einen einzelnen Chip nicht an', () => {
    const chips = [{ y: 77 }];
    expect(spreadChips(chips)[0].y).toBe(77);
  });

  it('greift im echten Prämien-Monat: die beiden Chips liegen sonst übereinander', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    const l = chartLayout(v.chart!);
    expect(l.chips).toHaveLength(2);
    // Entzerrt dargestellt …
    expect(Math.abs(l.chips[0].y - l.chips[1].y)).toBe(34);
    // … aber die Leader-Linien zeigen weiterhin auf die ECHTEN Höhen.
    expect(l.chips[0].leader.y1).toBeCloseTo(l.chips[0].anchorY, 6);
    expect(l.chips[1].leader.y1).toBeCloseTo(l.chips[1].anchorY, 6);
    expect(Math.abs(l.chips[0].anchorY - l.chips[1].anchorY)).toBeLessThan(CHIP_MIN_ABSTAND);
  });
});

describe('capTextLength · eine Zeile läuft nie über ihr Fenster', () => {
  it('kappt eine zu breite Zeile hart', () => {
    expect(capTextLength('Ein sehr langer Chip-Titel', 10, 60)).toBe(60);
  });

  it('lässt eine bequem passende Zeile in Ruhe', () => {
    expect(capTextLength('1,1 ct', 10, 200)).toBeUndefined();
  });

  it('kappt auch dann, wenn nur die ERSATZ-Schrift breiter ausfällt', () => {
    // Die Schätzung ist absichtlich großzügig: lieber einmal zu oft stauchen
    // als eine Zeile still über den Rand laufen lassen.
    expect(capTextLength('Marktprämie', 10, 60)).toBe(60);
  });
});

describe('chartLayout · die Skala ist ehrlich ab 0', () => {
  it('setzt die Nulllinie auf die Basis und misst jede Höhe dagegen', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    const l = chartLayout(v.chart!);
    // Doppelter Wert ⇒ doppelte Höhe: nur bei einer 0-Basis gilt das.
    const halb = chartLayout({ ...v.chart!, oeCt: 2.9, erCt: 7.4, satzCt: 0, awCt: null });
    const voll = chartLayout({ ...v.chart!, oeCt: 5.8, erCt: 7.4, satzCt: 0, awCt: null });
    expect(voll.oeBar!.height / halb.oeBar!.height).toBeCloseTo(2, 6);
    // Und jede Säule sitzt wirklich auf der Nulllinie auf.
    expect(l.oeBar!.y + l.oeBar!.height).toBeCloseTo(l.baseline.y1, 6);
    expect(l.erBar.y + l.erBar.height).toBeCloseTo(l.baseline.y1, 6);
  });

  it('lässt Kopfraum, ohne die Skala zu stauchen', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    const l = chartLayout(v.chart!);
    // Die höchste Marke (Säule + Block) darf die Beschriftung nicht überlaufen.
    expect(l.praemieBar!.y).toBeGreaterThan(l.erLabel.y);
  });

  it('hält die Beschriftung der eigenen Säule innerhalb der Bühne', () => {
    // Die längste Form ist die Gesamtmarke — sie darf weder links heraus- noch
    // in die Chip-Zone laufen.
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    const l = chartLayout(v.chart!);
    const halbeBreite = (l.erLabel.text.length * l.erLabel.fontSize * 0.34) / 1;
    expect(l.erLabel.x - halbeBreite).toBeGreaterThanOrEqual(0);
    expect(l.erLabel.x + halbeBreite).toBeLessThanOrEqual(l.width);
  });

  it('gibt der breiten Bühne mehr Chip-Zone, ohne die Aussage zu ändern', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    const schmal = chartLayout(v.chart!);
    const breit = chartLayout(v.chart!, { wide: true });
    expect(breit.width).toBeGreaterThan(schmal.width);
    // Dieselbe Ordnung: Prämien-Block über der eigenen Säule, beide über 0.
    expect(breit.praemieBar!.y).toBeLessThan(breit.erBar.y);
    expect(breit.erBar.y + breit.erBar.height).toBeCloseTo(breit.baseline.y1, 6);
  });

  it('beschriftet jedes Element direkt — eine Legende wäre nicht nötig', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    const l = chartLayout(v.chart!);
    const texte = l.captions.map((c) => c.text);
    expect(texte).toContain('Ø Monatsmarktwert');
    expect(texte).toContain('Solar (alle Anlagen)');
    expect(texte).toContain('Ihre Anlage');
    expect(texte).toContain('erzielt + Prämie');
    expect(l.oeWert!.text).toBe('5,8 ct');
  });

  it('taggt eine vorläufige Ø-Säule ruhig statt als Alarm', () => {
    const v = soVerdient({ money: anlage(), siteId: 's1' })!;
    const l = chartLayout(v.chart!);
    expect(l.oeStand!.text).toBe('vorläufig');
    // Der Tag sitzt ÜBER dem Wert, nicht auf der Säule.
    expect(l.oeStand!.y).toBeLessThan(l.oeWert!.y);
  });
});

describe('gesamtMarke · sie erscheint nur, wenn sie wirklich aufgeht', () => {
  it('rechnet den effektiven Erlös aus Server-Summen gegen', () => {
    expect(gesamtMarke(7.4, 1.1, 813.77, 9573.8)).toBeCloseTo(8.5, 10);
  });

  it('schweigt bei einer Abweichung, statt eine falsche Summe zu behaupten', () => {
    expect(gesamtMarke(7.4, 1.1, 760, 9573.8)).toBeNull();
  });

  it('schweigt ohne Satz und ohne Menge', () => {
    expect(gesamtMarke(9.9, 0, 947.8, 9573.8)).toBeNull();
    expect(gesamtMarke(7.4, 1.1, 813.77, null)).toBeNull();
    expect(gesamtMarke(7.4, 1.1, null, 9573.8)).toBeNull();
    expect(gesamtMarke(7.4, 1.1, 813.77, 0)).toBeNull();
  });
});

describe('verdictChip · ohne Maßstab wird nichts behauptet', () => {
  it('bleibt null, sobald eine der beiden Größen fehlt', () => {
    expect(verdictChip(null, 7.0)).toBeNull();
    expect(verdictChip(9.9, null)).toBeNull();
  });

  it('setzt das „+" nur in der Über-Lage', () => {
    expect(verdictChip(9.9, 7.0)!.text.startsWith('+ ')).toBe(true);
    expect(verdictChip(6.1, 7.0)!.text.startsWith('+')).toBe(false);
    expect(verdictChip(7.0, 7.0)!.text.startsWith('+')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Barrierefreiheit: derselbe Satz für Auge und Screenreader
// ---------------------------------------------------------------------------

describe('soVerdient · der zugängliche Name erzählt den Zustand', () => {
  it('nennt im Prämien-Monat beide Säulen und die Aufstockung', () => {
    const a = soVerdient({ money: praemienMonat(), siteId: 's1' })!.chart!.ariaLabel;
    expect(a).toContain('Ihre Anlage erzielte 7,4 ct');
    expect(a).toContain('Monatsdurchschnitt aller Solaranlagen liegt bei 5,8 ct');
    expect(a).toContain('stockt um 1,1 ct auf den Garantiewert 6,9 ct auf');
  });

  it('sagt im starken Monat, dass die Prämie RUHT — nicht, dass sie fehlt', () => {
    const a = soVerdient({ money: anlage(), siteId: 's1' })!.chart!.ariaLabel;
    expect(a).toContain('(vorläufig)');
    expect(a).toContain('2,9 ct über dem Monatsdurchschnitt');
    expect(a).toContain('Marktprämie ruht');
  });

  it('benennt die Aufmerksamkeits-Lage auch ohne Farbe', () => {
    const a = soVerdient({
      money: anlage({ realizedExportCtKwh: 6.1 }),
      siteId: 's1',
    })!.chart!.ariaLabel;
    expect(a).toContain('0,9 ct unter dem Monatsdurchschnitt');
  });

  it('nennt die fehlenden Größen beim Namen', () => {
    const ohneAw = soVerdient({
      money: anlage({ anzulegenderWertCtKwh: null }),
      siteId: 's1',
    })!.chart!.ariaLabel;
    expect(ohneAw).toContain('Garantiewert ist nicht hinterlegt');

    const ohneOe = soVerdient({
      money: anlage({ marketValueSolarCtKwh: null, marktpraemieEur: null }),
      siteId: 's1',
    })!.chart!.ariaLabel;
    expect(ohneOe).toContain('noch kein Monatsdurchschnitt veröffentlicht');
  });
});
