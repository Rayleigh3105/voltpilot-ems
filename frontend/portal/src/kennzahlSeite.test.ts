import { describe, expect, it } from 'vitest';
import type { Kennzahl } from './api';
import * as S from './kennzahlSeite';
import { bb1Seite, ez2029, kz24Seite, kz4Seite, vergleichKz4, vermerkMaerz } from './test/kennzahlSeiteFixtures';

/** Geschütztes Leerzeichen (U+00A0) zwischen Zahl und Einheit. */
const NB = String.fromCharCode(160);
const t = (s: string) => s.replace(/\u00a0/g, ' ');

/**
 * Das reine Modell der Seite einer Kennzahl (Konzept Auswerten a1 §6.5, §6.12, §6.13) in der Welt des Konzepts
 * (`test/kennzahlSeiteFixtures.ts`, Bühnen-Uhr 30.04.2029): gerechnet wird nichts - die Sätze setzen nur die Zahlen des
 * Servers.
 */
describe('Antwort zuerst', () => {
  it('über der Bezugsbasis: Monat, Ort, Richtung, Größe und die Bedingung mit Zahl (SP4)', () => {
    const k = kz4Seite();
    const a = S.antwort(k, S.seitenMonate(k, vergleichKz4()))!;
    expect(t(a.satz)).toBe(
      'Im März 2029 brauchte der Prozess Spritzguss 2,2 % mehr Energie, als die Bezugsbasis bei 306.000 kg Produktionsmenge erwarten ließ.',
    );
    expect(a.formal).toEqual({ vor: 'kWh je kg · Prozess Spritzguss · verglichen mit der', basis: 'Bezugsbasis BB-0001' });
    expect(a.marke).toEqual({ text: 'über der Bezugsbasis', art: 'warn' });
  });

  it('besser als erwartet: dieselbe Form mit „weniger“ und dem Wort der Übersicht', () => {
    const k = kz4Seite('besser');
    const a = S.antwort(k, S.seitenMonate(k, vergleichKz4('besser')))!;
    expect(t(a.satz)).toContain('brauchte der Prozess Spritzguss 3,4 % weniger Energie, als die Bezugsbasis');
    expect(a.marke).toEqual({ text: 'besser als die Bezugsbasis', art: 'ok' });
  });

  it('noch kein Vergleich: der Wert des Monats, kein Urteil, „Vergleich ab …“ als Marke (§6.13)', () => {
    const k = kz4Seite('noch_kein_vergleich');
    const a = S.antwort(k, S.seitenMonate(k, vergleichKz4('noch_kein_vergleich')))!;
    expect(t(a.satz)).toBe('Im März 2029 lag der Prozess Spritzguss bei 0,29 kWh je kg.');
    expect(a.marke).toEqual({ text: 'Vergleich ab Juni 2029', art: 'ohne' });
  });

  it('ohne Bezugsbasis: das Vorjahr, roh und ohne Farbe (VG3)', () => {
    const k = kz24Seite();
    const a = S.antwort(k, S.seitenMonate(k, null))!;
    expect(t(a.satz)).toBe('Im März 2029 lag das Gebäude Halle 1 bei 20,64 kWh je m² - genauso viel wie im März 2028.');
    expect(a.formal).toEqual({ vor: 'kWh je m² · Gebäude Halle 1 · ohne Bezugsbasis', basis: null });
    expect(a.marke).toEqual({ text: 'unverändert ggü. Vorjahr', art: 'neutral' });
  });

  it('ohne jeden Wert der zwölf Monate: ein Satz, keine erfundene Null', () => {
    const k = kz24Seite();
    const ohne: Kennzahl = { ...k, auswertung: { ...k.auswertung!, wert: null, vorjahr: null } };
    expect(S.antwort(ohne, [])!.satz).toBe('Für März 2029 gibt es noch keinen Wert.');
    expect(S.ohneWerteSatz('2028-04', '2029-03')).toBe('Von April 2028 bis März 2029 gibt es noch keinen Monatswert.');
  });
});

describe('Verlässlichkeit direkt darunter (§6.1 Regel 2)', () => {
  it('vorläufige Bezugsbasis aus einem einzigen Monat - mit dem Weg zur Bezugsbasis', () => {
    const bb = bb1Seite();
    expect(S.vertrauen(kz4Seite(), { basis: bb.basis, fassung: bb.fassungen[1] }, true)).toEqual({
      art: 'warn',
      fett: 'Vorsicht beim Lesen:',
      satz: 'Die Bezugsbasis stammt aus einem einzigen Monat (Oktober 2026) und ist vorläufig.',
      weg: { wort: 'Bezugsbasis ansehen', ziel: 'bezugsbasis' },
    });
  });

  it('fällige Überprüfung geht vor - derselbe Schritt wie in der Wiedervorlage', () => {
    const bb = bb1Seite();
    const faellig = { ...bb.basis, frist: { ueberpruefung_faellig: true, faellig_am: '2029-04-01', faellig_seit_tagen: 29, wiedervorlage_monate: 12 } };
    expect(S.vertrauen(kz4Seite(), { basis: faellig, fassung: bb.fassungen[1] }, true)).toMatchObject({
      fett: 'Bezugsbasis seit 01.04.2029 zur Überprüfung fällig.',
      weg: { wort: 'Bestätigen oder neu fassen' },
    });
  });

  it('ohne Bezugsbasis der Hinweis aufs Vorjahr; „Bezugsbasis festlegen“ nur mit Recht', () => {
    expect(S.vertrauen(kz24Seite(), null, true)?.weg).toEqual({ wort: 'Bezugsbasis festlegen', ziel: 'festlegen' });
    expect(S.vertrauen(kz24Seite(), null, false)?.weg).toBeNull();
    // Ein Anteil hat nie eine Bezugsbasis (B2): kein Hinweis aus Gewohnheit.
    expect(S.vertrauen({ ...kz24Seite(), rechenform: 'anteil' }, null, true)).toBeNull();
  });

  it('noch kein Vergleich: der Satz mit dem Datum statt zwölf leerer Monate', () => {
    expect(S.vertrauen(kz4Seite('noch_kein_vergleich'), null, true)?.satz).toBe(
      'Die Bezugsbasis gilt erst ab Mai 2029; ein Urteil gibt es, sobald dieser Monat abgeschlossen ist.',
    );
  });
});

describe('Kacheln, Grafik und Monatsliste', () => {
  const k = kz4Seite();
  const monate = S.seitenMonate(k, vergleichKz4());

  it('die Kachel des Monats: Zahl, Urteil, Vormonat (Pfeil, ohne Farbe) und die Mengen des Servers', () => {
    const x = S.kacheln(k, monate)!;
    expect([x.monat, x.zahl, x.einheit]).toEqual(['März 2029', '0,29', 'kWh je kg']);
    expect(x.marken).toEqual([
      { text: 'über der Bezugsbasis', art: 'warn' },
      { text: `▼ 2${NB}% ggü. Vormonat`, art: 'neutral' },
    ]);
    expect(x.erwartetWert).toEqual({ wert: '0,28 kWh je kg', bei: `306.000${NB}kg` });
    expect(x.gemessen).toEqual({ zahl: '88.740', einheit: 'kWh', fett: `1.928${NB}kWh mehr`, rest: ' als erwartet' });
    expect(x.erwartet).toEqual({ zahl: '86.812', einheit: 'kWh', unter: `bei 306.000${NB}kg Produktionsmenge` });
  });

  it('ohne Wert im Monat sagt die Kachel „noch kein Wert“ einmal - keine Marke, die es wiederholt', () => {
    const a = k.auswertung!;
    const leer: Kennzahl = {
      ...k,
      auswertung: {
        ...a,
        wert: null,
        vorjahr: null,
        vormonat: null,
        monate: a.monate.map((m) => ({ ...m, wert: null, delta_prozent: null, urteil: 'nicht_anwendbar', grund: 'keine_werte', erwartet_wert: null, abweichung: null, zusammen: null, vorjahr: null })),
        vergleich: { ...a.vergleich!, urteil: 'nicht_anwendbar', delta_prozent: null, richtung: null, grund: 'keine_werte', satz: 'März 2029: nicht bewertbar - kein gemessener Wert.' },
      },
    };
    const x = S.kacheln(leer, S.seitenMonate(leer, null))!;
    expect([x.zahl, x.marken]).toEqual([null, []]);
  });

  it('die Infozeile: Monat, gemessen statt erwartet, Abweichung mit Urteil in Worten (nie nur Farbe)', () => {
    expect(S.infozeile(monate[11])).toEqual({
      monat: 'März 2029',
      wert: `88.740${NB}kWh`,
      statt: 'statt 86.812 erwartet',
      urteil: { text: `2,2${NB}% mehr · über der Bezugsbasis`, ton: 'warn' },
    });
    expect(S.infozeile(monate[6]).urteil).toEqual({ text: `1,5${NB}% mehr · im Rahmen der Bezugsbasis`, ton: 'neutral' });
  });

  it('das Fazit über den Zeitraum ab Gültigkeit der Bezugsbasis (§10.6) und die Zahl der Monate je Urteil', () => {
    const f = S.fazit(k.auswertung!.zeitraum, monate)!;
    expect(t(f.fett)).toBe('April 2028 bis März 2029: 3,0 % mehr als erwartet');
    expect(f.rest).toBe('; 10 von 12 Monaten über der Bezugsbasis, 2 im Rahmen.');
    // Nur, was vorkommt - nie „0 von 6 Monaten über der Bezugsbasis“.
    const rahmen = monate.map((m) => ({ ...m, art: 'im_rahmen' as const }));
    expect(S.fazit(k.auswertung!.zeitraum, rahmen)!.rest).toBe('; 12 von 12 Monaten im Rahmen.');
    expect(S.fazit(null, monate)).toBeNull();
  });

  it('Zusammengezählt: der Endwert des Servers seit dem ersten Monat mit Urteil, die Linie im Ton ihrer Richtung', () => {
    expect(S.zusammenEnde(monate, 'kWh')).toMatchObject({ seit: 'April 2028', ton: 'warn' });
    expect(S.zusammenEnde(S.seitenMonate(kz4Seite('noch_kein_vergleich'), vergleichKz4('noch_kein_vergleich')), 'kWh')).toBeNull();
  });

  it('ein Monat ohne Vergleich bleibt leer - nie 0 - und nennt seinen Grund', () => {
    const leer = S.seitenMonate(kz4Seite('noch_kein_vergleich'), vergleichKz4('noch_kein_vergleich'));
    expect(leer.every((m) => m.art === 'leer' && m.delta === null && m.deltaZeichen === null)).toBe(true);
    expect(S.infozeile(leer[11]).urteil).toEqual({ text: 'nicht bewertbar - für diesen Monat gilt noch keine Fassung der Bezugsbasis BB-0001.', ton: 'leise' });
    // Mit dem Vorjahr (vor der ersten Fassung): der Wert gegen das Vorjahr, roh.
    expect(S.infozeile(leer[11], { wert: '0,29', text: 'unverändert ggü. Vorjahr' })).toEqual({
      monat: 'März 2029', wert: '0,29 kWh je kg', statt: 'Vorjahr 0,29', urteil: { text: 'unverändert ggü. Vorjahr', ton: 'neutral' },
    });
  });

  it('das Urteil in der Liste: volle Wörter, „im Rahmen“ kurz; ohne Abweichung keine Marke', () => {
    expect(S.urteilMarke('schlechter', '2.2')).toEqual({ text: 'über der Bezugsbasis', art: 'warn' });
    expect(S.urteilMarke('im_rahmen', '1.5')).toEqual({ text: 'im Rahmen', art: 'neutral' });
    expect(S.urteilMarke('besser', '-3.4')).toEqual({ text: 'besser als die Bezugsbasis', art: 'ok' });
    expect(S.urteilMarke('ohne_urteil', '2.0')).toEqual({ text: 'ohne Urteil', art: 'ohne' });
    expect(S.urteilMarke(null, null)).toBeNull();
  });

  it('Vorzeichen mit echtem Minus; Pfeil des Vormonats erst ab 0,5 %', () => {
    expect([S.deltaMitZeichen('2.2'), S.deltaMitZeichen('-3.4'), S.deltaMitZeichen('0.0')]).toEqual([`+2,2${NB}%`, `−3,4${NB}%`, `0,0${NB}%`]);
    expect(S.vormonatText('-0.4')).toBe('unverändert ggü. Vormonat');
    expect(S.vormonatText('4.3')).toBe(`▲ 4${NB}% ggü. Vormonat`);
  });
});

describe('Rechenweg, Energieziel, Auffälligkeit, Bezugsbasis', () => {
  it('Woraus gerechnet: der Monat vorn, das Ergebnis hinten; erwartet mit vier Stellen und dem Nenner', () => {
    const stuecke = [
      { text: `Gerechnet aus 88.740${NB}kWh (`, sprung: null },
      { text: 'Spritzguss', sprung: null },
      { text: `) geteilt durch 306.000${NB}kg (`, sprung: null },
      { text: 'Produktionsmenge', sprung: null },
      { text: ').', sprung: null },
    ];
    expect(S.worausStuecke(stuecke, 'März 2029', `0,29 kWh je kg`).map((s) => s.text).join('')).toBe(
      `März 2029: 88.740${NB}kWh (Spritzguss) geteilt durch 306.000${NB}kg (Produktionsmenge) = 0,29 kWh je kg.`,
    );
    const m = S.seitenMonate(kz4Seite(), vergleichKz4())[11];
    expect(S.erwartetSatz(m, '0.2837', 'kWh/kg', { wert: '306000', einheit: 'kg' })).toEqual({
      vor: `Erwartet: 0,2837 kWh je kg aus der Bezugsbasis mal 306.000${NB}kg = `,
      fett: `86.812${NB}kWh`,
    });
  });

  it('die Karte des Energieziels: Satz mit Zeitraum, Skala und Stand nach x von y Monaten mit der verantwortlichen Person', () => {
    const z = S.zielKarte(kz4Seite().auswertung!, ez2029())!;
    expect(z.titel).toBe('Energieziel 2029');
    expect(t(z.satz)).toBe('4 % weniger Energie, als die Bezugsbasis erwarten lässt · März bis Dezember 2029');
    expect([z.jetzt, z.ziel, t(z.zielLabel), t(z.jetztLabel!)]).toEqual(['2.2', '-4.0', 'Ziel −4 %', 'bisher +2,2 %']);
    expect(t(z.fuss)).toBe('Stand nach 1 von 10 Monaten: 2,2 % mehr · verantwortlich Ines Kaltenbach');
    expect(S.zielKarte(kz24Seite().auswertung!, null)).toBeNull();
  });

  it('die Leitkennzahl aus den offenen Energiezielen: das kleinste Kennzeichen - wie Übersicht und Liste', () => {
    const ez = ez2029();
    expect(S.leitkennzahlAusZielen([ez, { ...ez, kennzahl: { ...ez.kennzahl, kennzeichen: 'KZ-0023' } }])).toBe('KZ-0004');
    expect(S.leitkennzahlAusZielen([{ ...ez, zustand: 'bewertet' }])).toBeNull();
  });

  it('die offene Auffälligkeit des Monats - ohne offene keine Karte', () => {
    expect(S.offeneAuffaelligkeit([vermerkMaerz()], '2029-03')?.titel).toBe('Auffälligkeit zu März 2029 · offen.');
    expect(S.offeneAuffaelligkeit([{ ...vermerkMaerz(), zustand: 'beantwortet' }], '2029-03')).toBeNull();
  });

  it('die Bezugsbasis in Klartext: Vergleichszeitraum, Erwartung mit Band, Gilt mit Freigabe und Überprüfung', () => {
    const bb = bb1Seite();
    expect(S.basisKlartext(bb.basis, bb.fassungen[1], 'kWh je kg', '2029-04-01').map((z) => [z.name, t(z.wert), z.leise && t(z.leise)])).toEqual([
      ['Vergleichszeitraum', 'Oktober 2026 · 1 von 12 Monaten', 'vorläufig, bis zwölf Monate vorliegen'],
      ['Erwartung', '0,2837 kWh je kg', 'im Rahmen: ± 2 %'],
      ['Gilt', 'seit 01.11.2027 · Fassung 2', 'freigegeben von Ines Kaltenbach am 25.11.2027 · nächste Überprüfung bis 30.04.2030'],
    ]);
    // Zur echten Uhr der Demo (Oktober 2026) gilt Fassung 2 erst künftig: „ab“, nie „seit“ einem Tag, der noch nicht war.
    expect(S.basisKlartext(bb.basis, bb.fassungen[1], 'kWh je kg', '2026-10-01')[2].wert).toBe('ab 01.11.2027 · Fassung 2');
    // Der Stichtag ist der Tag nach dem Monat des Urteils - ohne Auswertung der Tag im Browser.
    expect([S.stichtag('2029-03', 'x'), S.stichtag('2026-12', 'x'), S.stichtag(null, '2026-10-06')]).toEqual(['2029-04-01', '2027-01-01', '2026-10-06']);
  });

  it('Über diese Kennzahl: Geltung im Akkusativ', () => {
    expect(S.ueberKennzahl(kz4Seite()).geltung).toBe('Gilt für den Prozess Spritzguss · verantwortlich Ines Kaltenbach · berechnet seit 01.10.2026');
  });
});
