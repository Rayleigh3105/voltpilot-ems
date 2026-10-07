import { describe, expect, it } from 'vitest';
import type { Ablesung, MessstelleRegisterZeile, MessstelleWerte } from './api';
import {
  ablesungFehltSatz,
  ablesungKachel,
  ablesungZeilen,
  balken,
  fussSatz,
  herkunftKarte,
  leitKachel,
  letzterVollerMonat,
  monatPlus,
  monatsTage,
  protokollSatz,
  rolle,
  standKachel,
  standText,
  statusZeile,
  werteStart,
  zahlUndEinheit,
} from './messstelleSeite';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import { ANFANG_NICHT_GEMESSEN, antwort, MS_21, schritt, voll } from './test/werteKarteFixtures';
import { betrag, zaehltSatz } from './werteEingabe';

/**
 * Die reine Seite einer Messstelle (Konzept Messen m1, §6.4/§6.5; Messen-Bau m2 PR2): Kopf, Kacheln, Monate, Ablesungen
 * und Herkunft - gegen eine Monatsreihe der Werte-Route und das Register von Ahrenberg.
 */

const ZONE = 'Europe/Berlin';
const NBSP = ' ';

/** Ein Monat der Route im Raster `monat`; ohne Menge ein Monat ohne Wert (`keine Werte`, nie 0). */
function monat(m: string, menge: number | null): MessstelleWerte['werte'][number] {
  const bis = `${monatPlus(m, 1)}-01T00:00:00+01:00`;
  return schritt({
    von: `${m}-01T00:00:00+02:00`,
    bis,
    gebildet_aus: 'monat',
    fassung: 'endgueltig',
    ...(menge === null ? { zustand: 'keine Werte', menge: null } : voll(menge, 720)),
  });
}

/** Dreizehn Monate bis September 2026 - Gas Heizung Verwaltung (m³), September 2025 wie September 2026. */
function serie(mengen: Record<string, number | null> = {}): MessstelleWerte {
  const monate = Array.from({ length: 13 }, (_, i) => monatPlus('2025-09', i));
  return antwort(
    MS_21,
    'monat',
    '2025-09-01T00:00:00+02:00',
    '2026-10-01T00:00:00+02:00',
    monate.map((m) => monat(m, m in mengen ? mengen[m] : 8000 + Number(m.slice(5)) * 10)),
  );
}

const ablesung = (zeitpunkt: string, stand: number, monat: string | null = null): Ablesung => ({
  quelle: 'q',
  zeitpunkt,
  fassung: 1,
  stand,
  monat,
  woher: 'eingabe',
  urheber: { name: 'Ines Kaltenbach', rolle: 'energiemanager' },
  korrektur: null,
  eingetragen_am: zeitpunkt,
});

/** MS-21 als Ablesezähler: zuletzt abgelesen am 01.10.2026, die nächste fehlt ab dem 01.12.2026. */
function abgelesen(zustand: 'liefert' | 'liefert_nicht_seit' = 'liefert'): MessstelleRegisterZeile {
  const z = ahrenbergRegister().register.find((x) => x.kennzeichen === 'MS-21')!;
  return {
    ...z,
    quelle: {
      stand: 'ablesung',
      fuehrend: null,
      davor: null,
      vergleichsquellen: 0,
      ablesung: { seit: '2024-10-01T00:00:00+02:00', zuletzt: '2026-10-01T00:00:00+02:00', faellig_ab: '2026-12-01T00:00:00+01:00' },
    },
    beobachtung: {
      zustand,
      text: zustand === 'liefert' ? 'Abgelesen am 01.10.2026' : 'Ablesung überfällig seit 01.12.2026',
      seit: null,
      toleranz_s: null,
      kadenz_s: null,
      geraet: null,
    },
    letzter_wert: { wert: 49451, text: null, einheit: 'm³', zeitpunkt: '2026-10-01T00:00:00+02:00' },
  };
}

describe('Rolle und Monate', () => {
  it('die Rolle der Hauptgröße: Bezug ist Verbrauch (violett), Erzeugung PV, Abgabe Einspeisung - sonst die Größe selbst', () => {
    expect(rolle({ groesse: 'Wirkenergie', richtung: 'Bezug' })).toEqual({ wort: 'Verbrauch', ton: 'load' });
    expect(rolle({ groesse: 'Wirkenergie', richtung: 'Erzeugung' })).toEqual({ wort: 'Erzeugung', ton: 'pv' });
    expect(rolle({ groesse: 'Wirkenergie', richtung: 'Abgabe' })).toEqual({ wort: 'Einspeisung', ton: 'grid' });
    expect(rolle({ groesse: 'Temperatur', richtung: 'richtungslos' })).toEqual({ wort: 'Temperatur', ton: 'neutral' });
  });

  it('der letzte vollständige Monat, Monate rechnen über das Jahr, die Tage eines Fensters', () => {
    expect(letzterVollerMonat('2026-10-06')).toBe('2026-09');
    expect(letzterVollerMonat('2027-01-01')).toBe('2026-12');
    expect(monatPlus('2026-09', -12)).toBe('2025-09');
    expect(monatPlus('2026-12', 1)).toBe('2027-01');
    expect(monatsTage('2025-10', '2026-02')).toEqual({ von: '2025-10-01', bis: '2026-02-28' });
  });

  it('startet beim letzten vollständigen Monat - eine eben eingerichtete Messstelle dort, wo es schon Werte gibt', () => {
    expect(werteStart({ heute: '2026-10-06', herkunft: 'ablesung', quelleSeit: '2024-10-01' })).toEqual({ art: 'monat', wert: '2026-09' });
    expect(werteStart({ heute: '2026-10-06', herkunft: 'geraet', quelleSeit: null })).toEqual({ art: 'monat', wert: '2026-09' });
    // MS-03 der Demo: seit heute vom Gerät - der heutige Tag; eine neue Ablesestelle der laufende Monat.
    expect(werteStart({ heute: '2026-10-06', herkunft: 'geraet', quelleSeit: '2026-10-06' })).toEqual({ art: 'tag', wert: '2026-10-06' });
    expect(werteStart({ heute: '2026-10-06', herkunft: 'ablesung', quelleSeit: '2026-10-02' })).toEqual({ art: 'monat', wert: '2026-10' });
  });
});

describe('die Leitkachel (§6.4 Punkt 4)', () => {
  const r = rolle({ groesse: 'Volumen', richtung: 'Bezug' });

  it('die Menge des Monats in ihrer Rolle, unverändert ggü. Vorjahr, zwölf Monate Verlauf und der Vorjahresmonat darunter', () => {
    const k = leitKachel({ serie: serie({ '2025-09': 8200, '2026-09': 8200 }), monat: '2026-09', rolle: r, herkunft: 'ablesung', ablesenMoeglich: true });
    expect(k.name).toBe('Verbrauch · September 2026');
    expect(k.ton).toBe('load');
    // m³ trägt auch im Monat eine Stelle (E11), kWh keine.
    expect(`${k.wert} ${k.einheit}`).toBe('8.200,0 m³');
    expect(k.marke).toEqual({ text: 'unverändert ggü. Vorjahr', ton: 'neutral' });
    expect(k.verlauf).toHaveLength(12);
    expect(k.verlauf.at(-1)).toBe(8200);
    expect(k.unter).toBe(`September 2025: 8.200,0${NBSP}m³ · aus Ablesungen`);
    expect(k.fehlt).toBeNull();
  });

  it('der Vergleich rechnet der Bericht-Zwilling; die Kachel nennt nur Pfeil und ganze Prozent (E11, Schreibweise des Vertrags)', () => {
    const mehr = leitKachel({ serie: serie({ '2025-09': 8000, '2026-09': 8240 }), monat: '2026-09', rolle: r, herkunft: 'ablesung', ablesenMoeglich: true });
    expect(mehr.marke?.text).toBe(`▲ 3${NBSP}% ggü. Vorjahr`);
    const weniger = leitKachel({ serie: serie({ '2025-09': 8000, '2026-09': 7600 }), monat: '2026-09', rolle: r, herkunft: 'ablesung', ablesenMoeglich: true });
    expect(weniger.marke?.text).toBe(`▼ 5${NBSP}% ggü. Vorjahr`);
    // Unter einem halben Prozent ist es „unverändert“ - in beide Richtungen.
    const kaum = leitKachel({ serie: serie({ '2025-09': 8000, '2026-09': 7980 }), monat: '2026-09', rolle: r, herkunft: 'ablesung', ablesenMoeglich: true });
    expect(kaum.marke?.text).toBe('unverändert ggü. Vorjahr');
  });

  // Ein unvollständiger Monat mit Zahl (z. B. MS-03 der Demo im Monat der Bindung): Anfang nicht gemessen.
  const unvollstaendig = (abdeckung: number) => ({
    zustand: 'unvollständig',
    erhalten: abdeckung,
    erwartet: 100,
    abdeckung_prozent: abdeckung,
    kennzeichen: [ANFANG_NICHT_GEMESSEN],
  });

  it('ein unvollständiger Monat sagt es und vergleicht nicht mit dem Vorjahr (Review r4 S3)', () => {
    const s = serie({ '2025-09': 8000, '2026-09': 6100 });
    s.werte = s.werte.map((w) => (w.von.startsWith('2026-09') ? { ...w, ...unvollstaendig(72) } : w));
    const k = leitKachel({ serie: s, monat: '2026-09', rolle: r, herkunft: 'geraet', ablesenMoeglich: false });
    expect(k.wert).not.toBe('—');
    expect(k.marke).toEqual({ text: 'unvollständig', ton: 'warn' });
    // Ein unvollständiger Vorjahresmonat: keine Marke, und die Zeile darunter sagt es.
    const v = serie({ '2025-09': 5000, '2026-09': 8000 });
    v.werte = v.werte.map((w) => (w.von.startsWith('2025-09') ? { ...w, ...unvollstaendig(60) } : w));
    const kv = leitKachel({ serie: v, monat: '2026-09', rolle: r, herkunft: 'geraet', ablesenMoeglich: false });
    expect(kv.marke).toBeNull();
    expect(kv.unter).toContain('unvollständig');
  });

  it('ein negativer Monat (saldiert) bleibt negativ: im Verlauf mit seiner Zahl, als Balken mit Betrag und `negativ` (Review r4 S5)', () => {
    const leer = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [monatPlus('2025-09', i), null]));
    const s = serie({ ...leer, '2026-08': 1200, '2026-09': -600 });
    const k = leitKachel({ serie: s, monat: '2026-09', rolle: r, herkunft: 'geraet', ablesenMoeglich: false });
    expect(k.verlauf.at(-1)).toBe(-600);
    const b = balken(s, '2026-09');
    const sep = b.find((x) => x.monat === '2026-09')!;
    const aug = b.find((x) => x.monat === '2026-08')!;
    expect(sep.negativ).toBe(true);
    expect(sep.hoehe).toBeCloseTo(0.5);
    expect(aug.negativ).toBe(false);
    expect(aug.hoehe).toBe(1);
  });

  it('fehlt die Ablesung des Monats: „–“ mit Grund und Schritt - nie eine 0; ohne Vorjahr kein Vergleich', () => {
    const k = leitKachel({ serie: serie({ '2025-09': null, '2026-09': null }), monat: '2026-09', rolle: r, herkunft: 'ablesung', ablesenMoeglich: true });
    expect(k.wert).toBe('—');
    expect(k.einheit).toBe('');
    expect(k.marke).toBeNull();
    expect(k.fehlt).toEqual({ satz: 'Für September fehlt noch die Ablesung.', schritt: 'Ablesung eintragen' });
    expect(k.unter).toBe('September 2025: keine Werte · aus Ablesungen');
    // Ohne Recht (oder am Stichtag) kein Schritt; bei einem Gerät keine Ablesung.
    expect(leitKachel({ serie: serie({ '2026-09': null }), monat: '2026-09', rolle: r, herkunft: 'ablesung', ablesenMoeglich: false }).fehlt?.schritt).toBeNull();
    expect(leitKachel({ serie: serie({ '2026-09': null }), monat: '2026-09', rolle: r, herkunft: 'geraet', ablesenMoeglich: true }).fehlt).toBeNull();
  });

  it('ein Gerät, dessen Quelle erst im Monat beginnt: „—“ mit dem Satz der Route und ohne Schritt (D5 mit Namen)', () => {
    const s = serie();
    const id = s.quellen[0].id;
    const teilweise: MessstelleWerte = {
      ...s,
      quellen: [{ ...s.quellen[0], gueltig_ab: '2026-09-15T17:30:00+02:00' }],
      werte: s.werte.map((w) => (w.von.startsWith('2026-09') ? { ...w, menge: null, zustand: null, grund: 'quelle_teilweise' as const } : w)),
    };
    const k = leitKachel({ serie: teilweise, monat: '2026-09', rolle: r, herkunft: 'geraet', ablesenMoeglich: false, namen: { [id]: { quelle: 'Gaszähler Verwaltung (GR-12)', kanal: 'Volumen (GR-12)' } } });
    expect(k.wert).toBe('—');
    expect(k.fehlt?.schritt).toBeNull();
    expect(k.fehlt?.satz).toContain('Gaszähler Verwaltung (GR-12) gilt seit 15.09.2026');
    // Ohne Namen kein Satz mit einer Kennung.
    expect(leitKachel({ serie: teilweise, monat: '2026-09', rolle: r, herkunft: 'geraet', ablesenMoeglich: false }).fehlt).toBeNull();
  });
});

describe('Ein Zeitraum ohne Ablesung (§8.1)', () => {
  it('sagt, was fehlt - statt „Ein Monat summiert ganze Ablesezeiträume …“', () => {
    expect(ablesungFehltSatz('monat', '2029-04')).toBe('Für April 2029 fehlt noch die Ablesung.');
    expect(ablesungFehltSatz('jahr', '2029')).toBe('Für 2029 fehlen noch die Ablesungen.');
  });
});

describe('Balken der Monate (§6.4 Punkt 5)', () => {
  it('eine Skala für alle; der gewählte Monat kräftig, ein Monat ohne Wert ohne Balken', () => {
    const b = balken(serie({ '2026-09': 9000, '2026-08': null }), '2026-09');
    expect(b).toHaveLength(13);
    expect(b.at(-1)).toMatchObject({ monat: '2026-09', kurz: 'S', titel: 'September 2026', hoehe: 1, gewaehlt: true });
    expect(b.at(-2)).toMatchObject({ monat: '2026-08', hoehe: null, zahl: '—' });
    expect(b[0].hoehe).toBeGreaterThan(0);
    expect(b[0].hoehe).toBeLessThan(1);
    expect(b.filter((x) => x.gewaehlt)).toHaveLength(1);
  });

  it('die große Zahl trennt Zahl und Einheit am geschützten Leerzeichen', () => {
    expect(zahlUndEinheit(`88.200${NBSP}kWh`)).toEqual({ wert: '88.200', einheit: 'kWh' });
    expect(zahlUndEinheit('—')).toEqual({ wert: '—', einheit: '' });
  });
});

describe('Kopf, Statuszeile und Kacheln aus dem Register', () => {
  it('die Statuszeile ist der Satz des Servers - wann die nächste Ablesung fällig ist, sagt die Kachel', () => {
    expect(statusZeile(abgelesen())).toEqual({ ton: 'ok', text: 'Abgelesen am 01.10.2026' });
    expect(statusZeile(abgelesen('liefert_nicht_seit'))).toEqual({ ton: 'warn', text: 'Ablesung überfällig seit 01.12.2026' });
    expect(statusZeile(null, ZONE)).toBeNull();
  });

  it('„Nächste Ablesung“ ist die Frist des Registers: im Plan bis dahin, danach überfällig', () => {
    expect(ablesungKachel(abgelesen(), ZONE, '2026-10-20T08:00:00Z')).toEqual({
      tag: '01.12.',
      jahr: '2026',
      marke: { text: 'im Plan', ton: 'ok' },
      satz: 'spätestens; danach gilt sie als überfällig',
    });
    expect(ablesungKachel(abgelesen(), ZONE, '2026-12-02T08:00:00Z')?.marke).toEqual({ text: 'überfällig', ton: 'warn' });
    // Ein Gerätezähler hat keine nächste Ablesung.
    expect(ablesungKachel(ahrenbergRegister().register.find((x) => x.kennzeichen === 'MS-06')!, ZONE, '2026-10-20T08:00:00Z')).toBeNull();
  });

  it('der Zählerstand: abgelesen am Tag - vom Gerät mit der Uhrzeit des Werts', () => {
    expect(standKachel(abgelesen(), ZONE, '2026-10-20T08:00:00Z')).toEqual({ wert: '49.451', einheit: 'm³', unter: 'abgelesen am 01.10.2026' });
    const ms06 = ahrenbergRegister().register.find((x) => x.kennzeichen === 'MS-06')!;
    const geraet = { ...ms06, letzter_wert: { wert: 970680.4, text: null, einheit: 'kWh', zeitpunkt: '2026-10-20T06:55:00Z' } };
    expect(standKachel(geraet, ZONE, '2026-10-20T08:15:00Z')).toEqual({ wert: '970.680,4', einheit: 'kWh', unter: 'Stand 08:55' });
  });
});

describe('Ablesungen und Herkunft', () => {
  const wirksam = [
    ablesung('2026-08-01T00:00:00+02:00', 3121950),
    ablesung('2026-09-01T00:00:00+02:00', 3195900, '2026-08-01'),
    ablesung('2026-10-01T00:00:00+02:00', 3284100, '2026-09-01'),
  ];

  it('die neueste zuerst, mit dem Monat, zu dem sie zählt, und seiner Menge; die erste ist der Anfangsstand', () => {
    const z = ablesungZeilen({ wirksam, einheit: 'kWh', zone: ZONE, serie: antwort({ ...MS_21, einheit: 'kWh' }, 'monat', '', '', [monat('2026-09', 88200)]) });
    expect(z.map((x) => [x.tag, x.jahr, x.stand])).toEqual([
      ['01.10.', '2026', `3.284.100${NBSP}kWh`],
      ['01.09.', '2026', `3.195.900${NBSP}kWh`],
      ['01.08.', '2026', `3.121.950${NBSP}kWh`],
    ]);
    expect(z[0].neben).toBe(`zählt zu September 2026 · 88.200${NBSP}kWh im Monat`);
    // Ohne Menge in der Reihe nur der Monat.
    expect(z[1].neben).toBe('zählt zu August 2026');
    expect(z[2].neben).toBe('Anfangsstand');
  });

  it('woher die Werte kommen: von Hand abgelesen mit Rhythmus und Anzahl - vom Gerät seit dem Beginn der Quelle', () => {
    expect(herkunftKarte({ herkunft: 'ablesung', zeile: abgelesen(), zone: ZONE, ablesungen: 25 })).toEqual({
      herkunft: 'ablesung',
      titel: 'Von Hand abgelesen',
      satz: 'monatlich · 25 Ablesungen seit 01.10.2024',
    });
    expect(herkunftKarte({ herkunft: 'ablesung', zeile: abgelesen(), zone: ZONE, ablesungen: null }).satz).toBe('monatlich');
    const ms06 = ahrenbergRegister().register.find((x) => x.kennzeichen === 'MS-06')!;
    expect(herkunftKarte({ herkunft: 'geraet', zeile: ms06, zone: ZONE, ablesungen: null }).titel).toBe('Automatisch von einem Gerät');
    expect(herkunftKarte({ herkunft: 'keine', zeile: null, zone: ZONE, ablesungen: null })).toEqual({
      herkunft: 'keine',
      titel: 'Noch keine Quelle',
      satz: 'Werte kommen, sobald Sie einen Zähler verbinden oder eine Ablesung eintragen.',
    });
  });

  it('„Zählt zum Oktober 2026 – dem Zeitraum seit der letzten Ablesung am 01.10.“', () => {
    expect(zaehltSatz('2026-10', '2026-10-01T00:00:00+02:00', ZONE)).toBe('Zählt zum Oktober 2026 – dem Zeitraum seit der letzten Ablesung am 01.10.');
    expect(zaehltSatz('2026-10', null, ZONE)).toBe('Zählt zum Oktober 2026.');
  });
});

describe('Protokoll, Fuß und Zahlen', () => {
  it('der Verweis auf das Protokoll zählt die Einträge der ersten Seite - mehr heißt „Mehr als“', () => {
    expect(protokollSatz(3, false, '2026-10-05T19:15:00Z', ZONE)).toBe('3 Einträge · zuletzt 05.10.2026');
    expect(protokollSatz(1, false, null, ZONE)).toBe('1 Eintrag');
    expect(protokollSatz(20, true, '2026-10-05T22:30:00Z', ZONE)).toBe('Mehr als 20 Einträge · zuletzt 06.10.2026');
  });

  it('die Zone einmal am Fuß, mit dem Stand der Seite', () => {
    expect(standText('2026-10-06T16:10:00Z', ZONE)).toBe('Stand 06.10.2026, 18:10');
    expect(fussSatz('Zeiten in Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg)', '2026-10-06T16:10:00Z', ZONE)).toBe(
      'Zeiten: Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg) · Stand 06.10.2026, 18:10',
    );
  });

  it('Zahlen der Eingabe mit Tausenderpunkt, Komma und echtem Minus (statt „1 250 000“)', () => {
    expect(betrag(1250000)).toBe('1.250.000');
    expect(betrag('3284100.5')).toBe('3.284.100,5');
    expect(betrag(-40)).toBe('−40');
    expect(betrag(null)).toBe('— keine Werte');
  });
});
