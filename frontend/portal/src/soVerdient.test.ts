import { describe, expect, it } from 'vitest';

import type { SiteEarnings } from './api';
import type { BalkenZeile } from './balkenliste';
import { NBSP } from './format';
import {
  KERNSATZ,
  MEHRERE_MONATE_HINWEIS,
  NICHTS_EINGESPEIST_HINWEIS,
  RUNDUNG_HINWEIS,
  UNTER_DURCHSCHNITT_ZUSATZ,
  soVerdient,
  verdictChip,
} from './soVerdient';

/**
 * Die ECHTEN Zahlen des Konzepts (`vp-ertrag-kombi-konzept-t7` §2), damit die
 * Tests dieselbe Geschichte prüfen, die die Karte erzählt:
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
    gesamtertragEur: null,
    expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null,
    expectedMarketValueTo: null,
    expectedMarketValueSlots: null,
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

function zeile(v: ReturnType<typeof soVerdient>, id: string): BalkenZeile {
  const z = v!.balken!.zeilen.find((x) => x.id === id);
  if (!z) throw new Error(`Zeile ${id} fehlt`);
  return z;
}

const n = (s: string) => s.replace(new RegExp(NBSP, 'g'), ' ');

// ---------------------------------------------------------------------------
// S1 — der Prämien-Monat: das Plus ist eine Länge, die Prämie liegt obendrauf
// ---------------------------------------------------------------------------

describe('soVerdient · S1 Prämien-Monat', () => {
  it('zeigt Ø, eigene Anlage und den Erlös je kWh — in dieser Reihenfolge', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    expect(v.form).toBe('balken');
    expect(v.state).toBe('praemien_monat');
    expect(v.titel).toBe('So verdient Ihre Anlage · August 2026');
    expect(v.monatLabel).toBe('August 2026');
    expect(v.balken!.zeilen.map((z) => z.id)).toEqual(['markt', 'anlage', 'erloes']);
    expect(v.balken!.zeilen.map((z) => n(z.wert))).toEqual(['5,8 ct', '7,4 ct', '8,5 ct']);
    expect(v.verdict!.text).toBe('+ 1,6 ct über dem Monatsdurchschnitt');
  });

  it('der Erlös je kWh ist Einspeise-Erlös ÷ Menge — dieselbe Zahl wie in der Abrechnung', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    const erloes = zeile(v, 'erloes');
    const ende = erloes.segmente[erloes.segmente.length - 1].bis;
    expect(ende).toBeCloseTo((813.77 / 9573.8) * 100, 10);
    expect(erloes.summe).toBe(true);
  });

  it('legt den Prämien-Block auf den Börsen-Teil — und deckt ihn danach auf', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    const [boerse, praemie] = zeile(v, 'erloes').segmente;
    expect(boerse).toMatchObject({ rolle: 'einspeisung', von: 0, bis: 7.4 });
    expect(praemie).toMatchObject({ rolle: 'praemie', von: 7.4, danach: true });
    // Die Länge des Blocks IST der Satz: Garantiewert − Ø (1,1 ct).
    expect(praemie.bis - praemie.von).toBeCloseTo(1.1, 3);
  });

  it('sagt in der Unterzeile, woher der Block kommt — und benennt ihn mit seiner Farbe', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    const unter = zeile(v, 'erloes').unter!;
    expect(n(unter.text)).toBe('+ 1,1 ct Marktprämie · Garantiewert 6,9 − Ø 5,8');
    expect(unter.schluessel).toBe('praemie');
    expect(v.rundung).toBeNull();
  });

  it('der Vergleich ist fair: Börse gegen Börse, beide auf derselben Skala', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    expect(zeile(v, 'markt').segmente).toEqual([{ rolle: 'markt', von: 0, bis: 5.8, vorlaeufig: false }]);
    expect(zeile(v, 'anlage').segmente).toEqual([{ rolle: 'einspeisung', von: 0, bis: 7.4 }]);
    expect(v.balken!.skala.min).toBe(0);
    expect(v.balken!.skala.max).toBeCloseTo(8.5, 3);
  });

  it('zeigt die Prämien-Rechnung auf Abruf, nicht als Kleingedrucktes', () => {
    const v = soVerdient({ money: praemienMonat(), siteId: 's1' })!;
    expect(v.praemie.state).toBe('aufstockung');
    expect(v.praemie.rechnung).toContain('6,9 − 5,8 = 1,1');
    expect(v.praemie.rechnung).toContain('9.573,8');
  });
});

// ---------------------------------------------------------------------------
// § 51: an Tagen mit negativem Börsenpreis ruht die Prämie zeitweise
// ---------------------------------------------------------------------------

describe('soVerdient · die Prämie ruht zeitweise (§ 51)', () => {
  // Nur 60 € statt 105,31 € kamen an: ein Teil der Einspeisung lag bei
  // negativem Börsenpreis. Der Erlös je kWh wird damit kleiner.
  const teil = () =>
    soVerdient({
      money: praemienMonat({ marktpraemieEur: 60, einspeiseErloesEur: (9573.8 * 7.4) / 100 + 60 }),
      siteId: 's1',
    })!;

  it('zeichnet die ANGEKOMMENE Prämie als Block, nicht den Satz', () => {
    const [, praemie] = zeile(teil(), 'erloes').segmente;
    expect(praemie.bis - praemie.von).toBeCloseTo((60 / 9573.8) * 100, 6);
  });

  it('nennt den Satz und den Grund in der Unterzeile', () => {
    expect(n(zeile(teil(), 'erloes').unter!.text)).toBe(
      '+ 0,6 ct Marktprämie · Satz 1,1 ct, ruht bei negativem Börsenpreis',
    );
  });

  it('liest einen auf Cent gerundeten Betrag bei kleiner Menge nicht als „ruht"', () => {
    // 7 kWh × 1,1 ct = 0,077 € — gemeldet gerundet 0,08 €: das ist voll, nicht zeitweise.
    const v = soVerdient({
      money: praemienMonat({ eingespeistKwh: 7, marktpraemieEur: 0.08, einspeiseErloesEur: 0.598 }),
      siteId: 's1',
    })!;
    expect(n(zeile(v, 'erloes').unter!.text)).toBe('+ 1,1 ct Marktprämie · Garantiewert 6,9 − Ø 5,8');
    expect(n(v.praemie.rechnung!)).toContain('× 7,0 kWh eingespeist');
  });

  it('und die Prämien-Rechnung nennt die Menge, für die die Prämie galt', () => {
    const rechnung = n(teil().praemie.rechnung!);
    expect(rechnung).toContain('1,1 ct/kWh × 5.454,5 kWh bei Börsenpreis ab 0 ct');
    expect(rechnung).toContain('(von 9.573,8 kWh eingespeist)');
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
    expect(v.verdict!.ton).toBe('vorteil');
    expect(zeile(v, 'erloes').segmente).toHaveLength(1);
    expect(zeile(v, 'erloes').unter!.text).toBe('Marktprämie ruht — Monatsmarktwert über Ihrem Garantiewert');
    expect(v.praemie.state).toBe('voll_aus_dem_markt');
    expect(v.praemie.wert).toContain('0,00');
  });

  it('sagt „auf Höhe", wenn der Monatswert genau auf dem Garantiewert liegt', () => {
    const v = soVerdient({
      money: anlage({ marketValueSolarCtKwh: 6.9, marketValueProvisional: false }),
      siteId: 's1',
    })!;
    expect(zeile(v, 'erloes').unter!.text).toBe('Marktprämie ruht — Monatsmarktwert auf Höhe Ihres Garantiewerts');
  });
});

describe('soVerdient · S3 der reale August: knapp + vorläufig', () => {
  it('schraffiert den vorläufigen Ø und lässt die Prämien-Zeile warnen', () => {
    const v = soVerdient({ money: anlage(), siteId: 's1' })!;
    expect(v.state).toBe('voll_aus_dem_markt');
    expect(zeile(v, 'markt').segmente[0].vorlaeufig).toBe(true);
    expect(zeile(v, 'markt').unter!.text).toBe('Monatsmarktwert Solar · an der Börse · vorläufig');
    expect(v.verdict!.text).toBe('+ 2,9 ct über dem Monatsdurchschnitt');
    // Die 0,1-ct-Lage kann kippen — das sagt die Zeile, nicht das Bild.
    expect(v.praemie.vorlaeufigKnapp).toBe(true);
    expect(v.praemie.hinweise.some((h) => h.includes('kann sich noch ändern'))).toBe(true);
  });

  it('behauptet ohne Stand weder „vorläufig" noch „amtlich"', () => {
    const v = soVerdient({ money: anlage({ marketValueProvisional: null }), siteId: 's1' })!;
    expect(zeile(v, 'markt').unter!.text).toBe('Monatsmarktwert Solar · an der Börse');
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
    expect(v.verdict!.text).toBe(`0,9 ct unter dem Monatsdurchschnitt — ${UNTER_DURCHSCHNITT_ZUSATZ}`);
    expect(v.verdict!.text).toContain('prüfenswert');
    expect(v.verdict!.text).toContain('verkauft normalerweise über dem Durchschnitt');
  });

  it('darf sich nie wie ein hinnehmbarer Normaltag lesen', () => {
    const v = unten();
    const t = v.verdict!.text.toLowerCase();
    for (const entschuldigung of ['kein fehler', 'trüber tag', 'in ordnung', 'keine sorge']) {
      expect(t).not.toContain(entschuldigung);
    }
    expect(v.verdict!.text).not.toBe(v.verdict!.vergleich);
    expect(v.verdict!.text.length).toBeGreaterThan(v.verdict!.vergleich.length);
  });

  it('behält den ehrlichen Tages-Zusatz: abgerechnet wird der MONAT', () => {
    const v = unten();
    expect(v.praemie.anteiligText).toBe('anteilig — abgerechnet je Monat');
    expect(v.praemie.hinweise).toContain('anteilig — abgerechnet je Monat');
  });

  it('lässt das Bild ehrlich: der eigene Balken ist KÜRZER als der Ø', () => {
    const v = unten();
    expect(zeile(v, 'anlage').segmente[0].bis).toBeLessThan(zeile(v, 'markt').segmente[0].bis);
  });

  it('bleibt neutral, solange die Lage wirklich auf Höhe des Ø liegt', () => {
    const v = soVerdient({ money: anlage({ realizedExportCtKwh: 7.02 }), siteId: 's1' })!;
    expect(v.verdict!.ton).toBe('neutral');
    expect(v.verdict!.text).toBe('etwa auf Höhe des Monatsdurchschnitts');
  });
});

// ---------------------------------------------------------------------------
// Negativer Börsenpreis: der Balken geht nach links, eine Nulllinie trennt
// ---------------------------------------------------------------------------

describe('soVerdient · ein Tag mit negativem Börsenpreis', () => {
  // Die Konzept-Fixture `dv-praemie-ruht`: −1,42 € für 580 kWh, Prämie 0,61 €.
  const minus = () =>
    soVerdient({
      money: anlage({
        range: 'day',
        from: '2026-08-23T22:00:00Z',
        to: '2026-08-24T22:00:00Z',
        realizedExportCtKwh: -0.35,
        marketValueSolarCtKwh: 6.2,
        marketValueProvisional: false,
        anzulegenderWertCtKwh: 8.11,
        marktpraemieEur: 0.61,
        einspeiseErloesEur: -1.42,
        eingespeistKwh: 580,
      }),
      siteId: 's1',
    })!;

  it('zieht die Skala unter null und nennt die Werte mit Vorzeichen und Minus-Ton', () => {
    const v = minus();
    expect(v.balken!.skala.min).toBeLessThan(0);
    expect(n(zeile(v, 'anlage').wert)).toBe('− 0,4 ct');
    expect(zeile(v, 'anlage').minus).toBe(true);
    expect(n(zeile(v, 'erloes').wert)).toBe('− 0,2 ct');
  });

  it('stapelt keinen Block auf einen negativen Börsen-Teil — die Prämie steht im Text', () => {
    const v = minus();
    expect(zeile(v, 'erloes').segmente).toHaveLength(1);
    expect(zeile(v, 'erloes').unter!.schluessel).toBeNull();
    expect(n(zeile(v, 'erloes').unter!.text)).toBe(
      '+ 0,1 ct Marktprämie · Satz 1,91 ct, ruht bei negativem Börsenpreis',
    );
  });
});

// ---------------------------------------------------------------------------
// Die Rundung wird gesagt, nicht versteckt
// ---------------------------------------------------------------------------

describe('soVerdient · Rundung', () => {
  it('sagt es, wenn die gerundeten Teile nicht auf den gerundeten Erlös aufgehen', () => {
    // 7,46 + 1,86 = 9,32 ⇒ angezeigt 7,5 + 1,9 ≠ 9,3.
    const v = soVerdient({
      money: praemienMonat({
        realizedExportCtKwh: 7.46,
        marktpraemieEur: 18.6,
        einspeiseErloesEur: 93.2,
        eingespeistKwh: 1000,
      }),
      siteId: 's1',
    })!;
    expect(v.rundung).toBe(RUNDUNG_HINWEIS);
  });
});

// ---------------------------------------------------------------------------
// S5 — AW fehlt: der Börsen-Vergleich lebt, die Prämie hat einen Grund
// ---------------------------------------------------------------------------

describe('soVerdient · S5 kein anzulegender Wert', () => {
  const ohneAw = () =>
    soVerdient({ money: anlage({ anzulegenderWertCtKwh: null, marktpraemieEur: null }), siteId: 's1' })!;

  it('vergleicht weiter Börse gegen Börse', () => {
    const v = ohneAw();
    expect(v.form).toBe('balken');
    expect(v.state).toBe('ohne_garantiewert');
    expect(v.verdict!.text).toBe('+ 2,9 ct über dem Monatsdurchschnitt');
  });

  it('erfindet keinen Prämien-Block und nennt den Grund', () => {
    const v = ohneAw();
    expect(zeile(v, 'erloes').segmente).toHaveLength(1);
    expect(zeile(v, 'erloes').unter!.text).toBe('ohne Marktprämie — kein Garantiewert hinterlegt');
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
// S6 — Ø fehlt: eine leere Spur MIT Grund, nie ein erfundener Balken
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

  it('zeigt „—" und eine leere Spur statt eines Werts', () => {
    const v = ohneOe();
    expect(v.state).toBe('ohne_monatswert');
    const markt = zeile(v, 'markt');
    expect(markt.vorhanden).toBe(false);
    expect(markt.wert).toBe('—');
    expect(markt.segmente).toEqual([]);
    expect(markt.unter!.text).toBe('Monatsmarktwert Solar · noch nicht veröffentlicht');
  });

  it('lässt den Verdikt-Chip weg — ohne Maßstab wird nichts behauptet', () => {
    expect(ohneOe().verdict).toBeNull();
  });

  it('zeigt die eigene Anlage weiter und nennt den Grund der fehlenden Prämie', () => {
    const v = ohneOe();
    expect(n(zeile(v, 'anlage').wert)).toBe('9,1 ct');
    expect(zeile(v, 'erloes').unter!.text).toBe('ohne Marktprämie — sie steht erst mit dem Monatsmarktwert fest');
    expect(v.praemie.state).toBe('nicht_berechenbar');
  });
});

// ---------------------------------------------------------------------------
// S7 — nichts eingespeist: kein Bild ohne eigene Einspeisung
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

  it('fällt auf den Satz zurück, statt einen Balken zu erfinden', () => {
    const v = leer();
    expect(v.form).toBe('fallback');
    expect(v.state).toBe('nichts_eingespeist');
    expect(v.balken).toBeNull();
    expect(v.verdict).toBeNull();
    expect(v.hinweis).toBe(NICHTS_EINGESPEIST_HINWEIS);
    expect(v.kernsatz).toBeNull();
    expect(v.praemie.label).toContain('Marktprämie');
  });
});

// ---------------------------------------------------------------------------
// S8 — mehrere Monate: Börse gegen Ø ja, EIN Prämien-Satz nein
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

  it('zeigt nur den Börsen-Vergleich — der Erlös mit Prämie wird je Monat abgerechnet', () => {
    const v = jahr();
    expect(v.form).toBe('balken');
    expect(v.state).toBe('mehrere_monate');
    expect(v.balken!.zeilen.map((z) => z.id)).toEqual(['markt', 'anlage']);
    expect(v.hinweis).toBe(MEHRERE_MONATE_HINWEIS);
    expect(v.hinweis).toContain('wählen Sie einen Monat');
  });

  it('ordnet ohne Chip ein — die Einordnung steht an der eigenen Anlage', () => {
    const v = jahr();
    expect(v.verdict).toBeNull();
    expect(zeile(v, 'anlage').unter!.text).toContain('1,4 ct über dem Monatsdurchschnitt');
    expect(v.kernsatz).toBeNull();
  });

  it('nennt keinen Monat in der Überschrift, statt einen zu wählen', () => {
    const v = jahr();
    expect(v.titel).toBe('So verdient Ihre Anlage');
    expect(v.monatLabel).toBeNull();
    expect(v.praemie.label).toBe('Marktprämie');
  });

  it('zeigt die Prämie NUR in ihrer Fußzeile', () => {
    const v = jahr();
    expect(v.balken!.zeilen.some((z) => z.wert.includes('512') || z.unter?.text.includes('512'))).toBe(false);
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

  it('rendert auch ohne Antwort nicht', () => {
    expect(soVerdient({ money: null })).toBeNull();
    expect(soVerdient({ money: undefined })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Der Rahmen: Kernsatz, Verdikt, Link
// ---------------------------------------------------------------------------

describe('soVerdient · der Rahmen', () => {
  it('trägt den Kernsatz in jeder Monats-Lage — er ist in beiden Prämien-Lagen wahr', () => {
    for (const m of [anlage(), praemienMonat(), anlage({ anzulegenderWertCtKwh: null })]) {
      expect(soVerdient({ money: m, siteId: 's1' })!.kernsatz).toBe(KERNSATZ);
    }
    expect(KERNSATZ).toContain('richtet sich nach dem Durchschnitt');
    expect(KERNSATZ).toContain('ungeschmälert');
  });

  it('baut ohne bekannte Anlage keinen Link ins Leere', () => {
    const v = soVerdient({ money: anlage({ anzulegenderWertCtKwh: null }) })!;
    expect(v.praemie.href).toBeNull();
  });
});

describe('verdictChip · ohne Maßstab wird nichts behauptet', () => {
  it('bleibt null, sobald eine der beiden Größen fehlt', () => {
    expect(verdictChip(null, 7)).toBeNull();
    expect(verdictChip(7, null)).toBeNull();
  });

  it('setzt das „+" nur in der Über-Lage', () => {
    expect(verdictChip(9.9, 7.0)!.text).toBe('+ 2,9 ct über dem Monatsdurchschnitt');
    expect(verdictChip(6.1, 7.0)!.text.startsWith('+')).toBe(false);
    expect(verdictChip(7.02, 7.0)!.text.startsWith('+')).toBe(false);
  });
});
