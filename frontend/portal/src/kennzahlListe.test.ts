import { describe, expect, it } from 'vitest';
import type { Kennzahl, KennzahlAuswertung } from './api';
import { miniAbweichung, miniLinie } from './auswertenGrafik';
import { abweichungKurz, abweichungSatz, prozentText, urteilAnsicht, URTEIL_WORT } from './bezugsbasisUrteil';
import {
  archivTitel,
  grundKurz,
  karteMitBasis,
  bandText,
  kennzahlenListe,
  miniZusammenfassung,
  ortText,
  reiheOhneBasis,
  vorjahrText,
  zahlUndEinheit,
  zielJahre,
  zielStandSatz,
  zielWert,
} from './kennzahlListe';
import { referenzListe, REFERENZ } from './test/kennzahlListeFixtures';

const NB = String.fromCharCode(160);

/**
 * Die Liste „Kennzahlen“ (Konzept Auswerten a1 §6.4) als reines Modell: Gruppen, Wörter des Urteils, Hinweiskarte und die
 * Zustände ohne Urteil - an der Welt des Konzepts zum 30.04.2029 (`referenzListe`).
 */
describe('Konzept Auswerten a1 §6.4 · die Liste „Kennzahlen“', () => {
  it('ordnet in „Mit Bezugsbasis“ (Handlungsbedarf zuerst), „Zum Beobachten“ und „Archiviert“', () => {
    const l = kennzahlenListe(referenzListe());
    expect(l.mit.map((k) => k.kennzeichen)).toEqual(['KZ-0004', 'KZ-0023', 'KZ-0021']);
    expect(l.ohne.map((k) => k.kennzeichen)).toEqual(['KZ-0022', 'KZ-0024', 'KZ-0025']);
    expect(l.archiviert).toHaveLength(5);
    expect(l.ohneAuswertung).toEqual([]);
    expect(archivTitel(5)).toBe('Archiviert · 5 Kennzahlen');
    expect(archivTitel(1)).toBe('Archiviert · 1 Kennzahl');
  });

  it('die Karte spricht das Urteil mit den Wörtern der Übersicht und die Zahl als Satz', () => {
    const [kz4, kz23, kz21] = kennzahlenListe(referenzListe(), REFERENZ.kz4).mit;
    expect(kz4.zahl).toBe('0,29');
    expect(kz4.einheit).toBe('kWh je kg');
    expect(kz4.per).toBe('März 2029 · Prozess Spritzguss');
    expect(kz4.urteil).toEqual({ wort: 'über der Bezugsbasis', ton: 'warn' });
    expect(kz4.abweichung).toBe(`2,2${NB}% mehr als erwartet`);
    expect(kz4.leit).toBe(true);
    expect(kz4.ziel).toEqual({
      kopf: 'Energieziel 2029',
      jahre: '2029',
      wert: `4${NB}% weniger`,
      stand: `bisher 2,2${NB}% mehr (1 von 10 Monaten)`,
    });
    expect(kz23.per).toBe('März 2029 · Unternehmen');
    expect(kz23.vorlaeufig).toBe(true);
    expect(kz23.abweichungKurz).toBe(`6,5${NB}% mehr`);
    expect(kz21.urteil).toEqual({ wort: 'im Rahmen der Bezugsbasis', ton: 'neutral' });
    expect(kz21.abweichung).toBeNull();
    expect(kz21.abweichungKurz).toBe(`0,0${NB}% · Band ± 2${NB}%`);
    expect(kz21.leit).toBe(false);
  });

  it('die Hinweiskarte nur bei Handlungsbedarf; sonst ein ruhiger Satz, ohne Urteil gar nichts', () => {
    const welt = referenzListe();
    const l = kennzahlenListe(welt);
    expect(l.hinweis).toEqual({
      art: 'warn',
      titel: '2 Kennzahlen liegen über der Bezugsbasis',
      text: `Stromeinsatz Spritzguss je kg (2,2${NB}% mehr als erwartet) und Stromeinsatz Montage je Stück - Unternehmen (6,5${NB}% mehr) · März 2029`,
      textKurz: 'Stromeinsatz Spritzguss je kg und Stromeinsatz Montage je Stück - Unternehmen · März 2029',
      ziele: [REFERENZ.kz4, REFERENZ.kz23],
    });
    const ruhig = welt.filter((k) => k.kennzeichen !== 'KZ-0004' && k.kennzeichen !== 'KZ-0023');
    expect(kennzahlenListe(ruhig).hinweis).toEqual({ art: 'ruhig', text: 'Alle Kennzahlen mit Urteil liegen im Rahmen oder besser · März 2029.' });
    expect(kennzahlenListe(welt.filter((k) => !k.auswertung?.vergleich)).hinweis).toBeNull();
  });

  it('ohne Urteil sagt die Karte kurz, warum - nie eine erfundene Null', () => {
    expect(grundKurz('basis_fehlt', '2026-09', '2026-11')).toBe('Vergleich ab Dezember 2026');
    expect(grundKurz('basis_fehlt', '2026-09', '2026-12')).toBe('Vergleich ab Januar 2027');
    expect(grundKurz('basis_fehlt', '2026-09', null)).toBe('September 2026: noch keine Bezugsbasis');
    expect(grundKurz('keine_werte', '2029-03', null)).toBe('März 2029: noch kein Wert');
    expect(grundKurz('variable_ausserhalb', '2029-03', null)).toBe('März 2029: außerhalb der Spanne');
    expect(grundKurz('variable_fehlt', '2029-03', null)).toBe('März 2029: Bezugsgröße fehlt');
    expect(grundKurz('basis_beendet', '2029-03', null)).toBe('Bezugsbasis beendet');

    const k = referenzListe().find((x) => x.kennzeichen === 'KZ-0004') as Kennzahl;
    const a = k.auswertung as KennzahlAuswertung;
    const ohneWert = karteMitBasis({ ...k, auswertung: { ...a, wert: null, vergleich: { ...a.vergleich!, urteil: 'nicht_anwendbar', grund: 'keine_werte', delta_prozent: null } } }, false);
    expect(ohneWert.urteil).toBeNull();
    expect(ohneWert.ohneUrteil).toBe('März 2029: noch kein Wert');
    expect(ohneWert.zahl).toBeNull();
    // Unvollständig: die Zahl mit Richtung, aber ohne Urteil (G2).
    const unvollstaendig = karteMitBasis({ ...k, auswertung: { ...a, vergleich: { ...a.vergleich!, urteil: 'ohne_urteil', delta_prozent: '3.1' } } }, false);
    expect(unvollstaendig.urteil).toBeNull();
    expect(unvollstaendig.ohneUrteil).toBe(`3,1${NB}% mehr · ohne Urteil, Werte unvollständig`);
  });

  it('zum Beobachten: das Vorjahr ohne Farbe, Pfeil erst ab 0,5 %', () => {
    expect(vorjahrText({ periode: '2028-03', wert: '20.64', delta_prozent: '0.0', richtung: 'gleich' })).toBe('unverändert ggü. Vorjahr');
    expect(vorjahrText({ periode: '2028-03', wert: '20.64', delta_prozent: '0.4', richtung: 'mehr' })).toBe('unverändert ggü. Vorjahr');
    expect(vorjahrText({ periode: '2028-03', wert: '20.64', delta_prozent: '3.2', richtung: 'mehr' })).toBe(`▲ 3${NB}% ggü. Vorjahr`);
    expect(vorjahrText({ periode: '2028-03', wert: '20.64', delta_prozent: '-12.6', richtung: 'weniger' })).toBe(`▼ 13${NB}% ggü. Vorjahr`);
    expect(vorjahrText(null)).toBeNull();
    const r = reiheOhneBasis(referenzListe().find((x) => x.kennzeichen === 'KZ-0024') as Kennzahl);
    expect(r.zahl).toBe('20,64');
    expect(r.einheit).toBe('kWh je m²');
    expect(r.unter).toBe('Gebäude Halle 1 · Ines Kaltenbach');
    expect(r.bezugsbasis).toBeNull();
    expect(r.linie.strecken).toHaveLength(1);
  });

  it('Fix vp-kennzahl-undefined: eine angelegte Bezugsbasis ohne erste Fassung (B1, freigabe_status null) spricht „ohne Fassung“, nie undefined', () => {
    const kz21 = referenzListe().find((x) => x.kennzeichen === 'KZ-0021') as Kennzahl;
    const ohneFassung = reiheOhneBasis({ ...kz21, bezugsbasis: { kennzeichen: 'BB-0006', fassung: null, freigabe_status: null, vorlaeufig: false } });
    expect(ohneFassung.bezugsbasis).toBe('BB-0006 ohne Fassung');
  });

  it('der Wert in zwei Teilen, mit „mindestens“/„höchstens“ bei einer Grenze (Q3)', () => {
    expect(zahlUndEinheit('0.2564102564', 'kWh/kg')).toEqual({ zahl: '0,26', einheit: 'kWh je kg', vor: null });
    expect(zahlUndEinheit('30.8333', 'kWh/Person', 'untergrenze').vor).toBe('mindestens');
    expect(zahlUndEinheit('10.55', 'kWh/h', 'obergrenze').vor).toBe('höchstens');
    expect(zahlUndEinheit(null, 'kWh/kg')).toEqual({ zahl: null, einheit: null, vor: null });
  });

  it('der Ort ohne den Namen des Unternehmens', () => {
    expect(ortText({ geltung_art: 'unternehmen', geltung_name: 'Kunststoffwerk Ahrenberg GmbH' })).toBe('Unternehmen');
    expect(ortText({ geltung_art: 'prozess', geltung_name: 'Spritzguss' })).toBe('Prozess Spritzguss');
  });

  it('das Energieziel: Jahre, Zielwert und Stand über die Zielperiode', () => {
    expect(zielJahre({ zielperiode: '2029-03/2029-12' })).toBe('2029');
    expect(zielJahre({ zielperiode: '2028-07/2029-06' })).toBe('2028/2029');
    expect(zielWert({ zielwert_prozent: '-4.0' })).toBe(`4${NB}% weniger`);
    const ziel = { id: 'z', kennzeichen: 'EZ-2029-0001', zielwert_prozent: '-4.0', zielperiode: '2029-03/2029-12' };
    expect(zielStandSatz({ ...ziel, delta_prozent: null, richtung: null, urteil: null, monate_bewertbar: 0, monate_soll: 10 })).toBe(
      'noch kein Monat bewertbar (0 von 10)',
    );
    expect(zielStandSatz({ ...ziel, delta_prozent: '-1.5', richtung: 'weniger', urteil: 'im_rahmen', monate_bewertbar: 3, monate_soll: 10 })).toBe(
      `bisher 1,5${NB}% weniger (3 von 10 Monaten)`,
    );
  });

  it('Zielwert und Band mit genau den Stellen, die sie tragen - nie auf ganze Prozent gerundet (Review r3)', () => {
    expect(zielWert({ zielwert_prozent: '-2.5' })).toBe(`2,5${NB}% weniger`);
    expect(zielWert({ zielwert_prozent: '3.0' })).toBe(`3${NB}% mehr`);
    expect(bandText('2.0')).toBe(`± 2${NB}%`);
    expect(bandText('2.5')).toBe(`± 2,5${NB}%`);
    const welt = referenzListe().map((k) =>
      k.id === REFERENZ.kz21 && k.auswertung?.vergleich
        ? { ...k, auswertung: { ...k.auswertung, vergleich: { ...k.auswertung.vergleich, band_prozent: '2.5' } } }
        : k,
    );
    const kz21 = kennzahlenListe(welt).mit.find((k) => k.id === REFERENZ.kz21);
    expect(kz21?.band).toBe(`± 2,5${NB}%`);
    expect(kz21?.abweichungKurz).toBe(`0,0${NB}% · Band ± 2,5${NB}%`);
  });

  it('den Stern trägt die Leitkennzahl, die der Server nennt - nie eine hier abgeleitete (§10.8, Review r3)', () => {
    // Ohne Nennung (der Server hat keine Leitkennzahl, etwa weil ihr jeder Wert fehlt) trägt keine Karte den Stern.
    expect(kennzahlenListe(referenzListe()).mit.filter((k) => k.leit)).toEqual([]);
    // Nennt der Server eine andere Kennzahl, trägt nur sie ihn - auch wenn KZ-0004 ein offenes Ziel hat.
    const mit = kennzahlenListe(referenzListe(), REFERENZ.kz21).mit;
    expect(mit.filter((k) => k.leit).map((k) => k.kennzeichen)).toEqual(['KZ-0021']);
    // Am Standort ohne die Leitkennzahl: kein Stern - keine Ersatz-Leitkennzahl aus der gefilterten Liste.
    const amStandort = referenzListe().filter((k) => k.id !== REFERENZ.kz4);
    expect(kennzahlenListe(amStandort, REFERENZ.kz4).mit.some((k) => k.leit)).toBe(false);
  });

  it('die Mini-Grafik in Worten für den Vorleser', () => {
    const [kz4] = kennzahlenListe(referenzListe()).mit;
    expect(miniZusammenfassung(kz4.mini)).toBe('12 Monate: 10 Monate über der Bezugsbasis und 2 Monate im Rahmen.');
  });
});

describe('die Wörter des Urteils - eine Quelle für Karte, Seite und Leitkachel (§10.8)', () => {
  it('nennt nur die drei Urteile; „ohne Urteil“ und „nicht anwendbar“ tragen kein Wort', () => {
    expect(URTEIL_WORT).toEqual({
      besser: 'besser als die Bezugsbasis',
      schlechter: 'über der Bezugsbasis',
      im_rahmen: 'im Rahmen der Bezugsbasis',
    });
    expect(urteilAnsicht('schlechter')?.ton).toBe('warn');
    expect(urteilAnsicht('besser')?.ton).toBe('ok');
    expect(urteilAnsicht('ohne_urteil')).toBeNull();
    expect(urteilAnsicht('nicht_anwendbar')).toBeNull();
    expect(urteilAnsicht(undefined)).toBeNull();
  });
  it('die Abweichung als Satz, ohne Ursache (U6)', () => {
    expect(prozentText('-3.45')).toBe(`3,5${NB}%`);
    expect(abweichungSatz('2.2', 'mehr')).toBe(`2,2${NB}% mehr als erwartet`);
    expect(abweichungSatz('-3.4', 'weniger')).toBe(`3,4${NB}% weniger als erwartet`);
    expect(abweichungSatz('0.0', 'gleich')).toBe('genau wie erwartet');
    expect(abweichungKurz('6.5', 'mehr')).toBe(`6,5${NB}% mehr`);
  });
});

describe('die Geometrie der Mini-Grafiken (§6.12)', () => {
  const monat = (periode: string, delta: string | null, urteil: KennzahlAuswertung['monate'][number]['urteil']) => ({ periode, delta_prozent: delta, urteil });

  it('Säulen um die Nulllinie: oben mehr, unten weniger, die Farbe vom Server, fehlend gestrichelt', () => {
    const g = miniAbweichung([monat('a', '3.0', 'schlechter'), monat('b', '-3.0', 'besser'), monat('c', '1.0', 'im_rahmen'),
      monat('d', '2.5', 'ohne_urteil'), monat('e', null, 'nicht_anwendbar')], '2.0', { breite: 100, hoehe: 34 });
    expect(g.nullY).toBe(17);
    expect(g.saeulen.map((s) => s.art)).toEqual(['schlechter', 'besser', 'im_rahmen', 'ohne_urteil', 'leer']);
    // „schlechter“ wächst nach oben (kleineres y), „besser“ nach unten.
    const oben = Number(/V([\d.]+)/.exec(g.saeulen[0].pfad)?.[1]);
    const unten = Number(/V([\d.]+)/.exec(g.saeulen[1].pfad)?.[1]);
    expect(oben).toBeLessThan(17);
    expect(unten).toBeGreaterThan(17);
    // Das Band ± 2 % liegt symmetrisch um die Nulllinie.
    expect(g.band.y + g.band.hoehe / 2).toBeCloseTo(17, 5);
  });

  it('ein Ausreißer drückt die anderen Monate nicht flach (Grenze ± 6 %)', () => {
    const g = miniAbweichung([monat('a', '40', 'schlechter'), monat('b', '6', 'schlechter')], '2.0');
    const hoehe = (p: string) => Number(/V([\d.]+)Q/.exec(p)?.[1]);
    expect(hoehe(g.saeulen[0].pfad)).toBe(hoehe(g.saeulen[1].pfad));
  });

  it('die Linie zum Beobachten unterbricht bei einem Monat ohne Wert und markiert den jüngsten Punkt', () => {
    const l = miniLinie(['1', '2', null, '3'], { breite: 40, hoehe: 20, rand: 5 });
    expect(l.strecken).toHaveLength(2);
    expect(l.letzter).toEqual({ x: 35, y: 5 });
    expect(miniLinie([null, null]).strecken).toEqual([]);
  });
});
