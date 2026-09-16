import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KennzahlFassung, KennzahlPeriodeArt, KennzahlWert, KennzahlWerte } from './api';
import * as KK from './kennzahlKarte';
import { ahrenbergKennzahlen } from './test/kennzahlenFixtures';
import {
  fassungenVon,
  K10_TAG,
  K11_TAG,
  K1_OKTOBER,
  K3_OKTOBER,
  K7_OKTOBER,
  K8_NOVEMBER,
  KZ,
  KZ_0007,
  KZ_0008,
  kennzahlenDerWelt,
  kennzahlWerteAntwort,
  kennzahlWertVersionenAntwort,
  ohneZeile,
} from './test/kennzahlWerteFixtures';

/**
 * Die Welt „Kennzahlen“ (UEMS AP-11 IP-13) gegen die EINE geteilte Vektor-Datei: K1, K8, K10 und K11 (dazu K3 und K7)
 * sind die Fixtures der Karte — nicht selbst gedachte Zahlen. Zuerst wird bewiesen, dass die Fixtures die Vektoren SIND,
 * dann, dass die Karte die Sätze des Vertrags und des Reports (§5.3, §5.5) spricht.
 *
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const vektoren: Json = JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/kennzahl-vectors.json'), 'utf8'));
const pruefungen = (fall: string, regel: string): Json[] =>
  vektoren.cases.find((c: Json) => c.id === fall).pruefungen.filter((p: Json) => p.regel === regel);

/** Geschütztes Leerzeichen (U+00A0) zwischen Zahl und Einheit. */
const NB = String.fromCharCode(160);
const FASSUNG_DER_ROUTE: Record<string, KennzahlWert['fassung']> = { endgültig: 'endgueltig', vorläufig: 'vorlaeufig' };

const antwort = (w: KennzahlWert, periode: KennzahlPeriodeArt, kennzeichen: string, einheit: string): KennzahlWerte => ({
  kennzahl: { id: 'x', kennzeichen, name: kennzeichen, rechenform: 'quotient', einheit, einheit_anzeige: null },
  periode,
  von: w.von,
  bis: w.bis,
  zeitzone: 'Europe/Berlin',
  version: null,
  werte: [w],
});

const K1 = antwort(K1_OKTOBER, 'monat', 'KZ-0001', 'kWh/Stück');
const K8 = antwort(K8_NOVEMBER, 'monat', 'KZ-0001', 'kWh/Stück');
const K10 = antwort(K10_TAG, 'tag', 'KZ-0007', 'kWh/Person');
const K11 = antwort(K11_TAG, 'tag', 'KZ-0008', 'kWh/h');
const K3 = antwort(K3_OKTOBER, 'monat', 'KZ-0003', 'kWh/Stück');
const K7 = antwort(K7_OKTOBER, 'monat', 'KZ-0001', 'kWh/Stück');
const kz1 = ahrenbergKennzahlen()[0];

describe('die Fixtures SIND die Vektoren (K1, K7, K8, K10, K11, K3)', () => {
  const faelle: [string, KennzahlWert][] = [
    ['K1', K1_OKTOBER],
    ['K7', K7_OKTOBER],
    ['K8', K8_NOVEMBER],
    ['K10', K10_TAG],
    ['K11', K11_TAG],
    ['K3', K3_OKTOBER],
  ];

  it.each(faelle)('%s: Wert, Zähler, Nenner, Zustand, Richtung, Grund, Verlauf, Fassung, Version und Kennzeichen', (fall, w) => {
    const soll = pruefungen(fall, 'wert')[0].ergebnis;
    expect({
      wert: w.wert,
      zaehler: w.zaehler,
      nenner: w.nenner,
      zustand: w.zustand,
      richtung: w.richtung,
      grund: w.grund,
      abdeckung_prozent: w.abdeckung_prozent,
      fassung: w.fassung,
      version: w.version,
      kennzeichen: w.kennzeichen,
    }).toEqual({
      wert: soll.wert,
      zaehler: soll.zaehler,
      nenner: soll.nenner,
      zustand: soll.zustand,
      richtung: soll.richtung,
      grund: soll.grund,
      abdeckung_prozent: soll.abdeckung_prozent,
      fassung: soll.fassung === null ? null : FASSUNG_DER_ROUTE[soll.fassung],
      version: soll.version,
      kennzeichen: soll.kennzeichen,
    });
  });

  it.each(faelle.filter(([fall]) => pruefungen(fall, 'herkunft').length > 0))('%s: die Herkunft ist byte-gleich zur Regel „herkunft“', (fall, w) => {
    const soll = pruefungen(fall, 'herkunft')[0].ergebnis;
    expect(JSON.stringify(w.herkunft)).toBe(JSON.stringify(soll));
  });

  it('K8 hat ohne Version keine Herkunft — der Grund sagt das Warum', () => {
    expect(K8_NOVEMBER.herkunft).toBeNull();
    expect(pruefungen('K8', 'herkunft')).toEqual([]);
  });

  it('die Perioden der Annahmen KZ-0007/KZ-0008 und von KZ-0001 spricht der Zwilling (K1 Regel „periode“)', () => {
    expect(kz1.perioden).toEqual(pruefungen('K1', 'periode')[0].ergebnis.perioden);
    expect(KZ_0007.grundperiode).toBe('tag');
    expect(KZ_0008.grundperiode).toBe('tag');
  });
});

describe('die Werte-Karte (§5.3) — WerteKarte zeichnet sie unverändert', () => {
  it('K1: „0,15 kWh je Stück“, Abzeichen „vollständig“ und „Verlauf 100 %“, Kopf „Oktober 2026 · endgültig“', () => {
    const { karte, grund } = KK.wertKarte(K1, K1_OKTOBER, null);
    expect(karte.zahl).toBe(pruefungen('K1', 'wert')[0].ergebnis.anzeige);
    expect(karte.zahl).toBe(`0,15${NB}kWh je Stück`);
    expect(karte.zustand).toBe('vollständig');
    expect(karte.abdeckung).toBe(`Verlauf 100${NB}%`);
    expect([karte.titel, karte.fassung].join(' · ')).toBe('Oktober 2026 · endgültig');
    expect(karte.kennzeichen).toEqual(['berechnet (Kennzahl)']);
    expect([karte.zustandTon, karte.abdeckungTon]).toEqual(['ok', 'ok']);
    expect(grund).toBeNull();
  });

  it('K10: „mindestens 30,83 kWh je Person · unvollständig · Untergrenze — Menge unvollständig (MS-16 fehlt)“', () => {
    const { karte } = KK.wertKarte(K10, K10_TAG, null);
    expect(karte.zahl).toBe(pruefungen('K10', 'wert')[0].ergebnis.anzeige);
    const untergrenze = karte.kennzeichen.find((k) => k.startsWith('Untergrenze'));
    expect([karte.zahl, karte.zustand, untergrenze].join(' · ')).toBe(
      `mindestens 30,83${NB}kWh je Person · unvollständig · Untergrenze — Menge unvollständig (MS-16 fehlt)`,
    );
    expect(karte.fassung).toBe('vorläufig');
    expect(karte.zustandTon).toBe('warn');
    expect(karte.abdeckung).toBe(`Verlauf 67${NB}%`);
  });

  it('K11: „höchstens 10,55 kWh je h“ mit der Obergrenze als Kennzeichen', () => {
    const { karte } = KK.wertKarte(K11, K11_TAG, null);
    expect(karte.zahl).toBe(pruefungen('K11', 'wert')[0].ergebnis.anzeige);
    expect(karte.kennzeichen).toContain(`Obergrenze — Bezugsgröße unvollständig (Ladezeit: 1${NB}h ohne Statuswerte)`);
    expect([karte.zustandTon, karte.abdeckungTon]).toEqual(['warn', 'warn']);
  });

  it('K8: „—“, keine Werte — und der Kundensatz des Vektors mit dem Nenner aus der Fassung', () => {
    const { karte, grund } = KK.wertKarte(K8, K8_NOVEMBER, KK.eingaengeDer(fassungenVon(KZ.kz1), K8_NOVEMBER));
    expect(karte.zahl).toBe('—');
    expect(karte.zustand).toBe('keine Werte');
    expect(karte.fassung).toBeNull();
    expect(grund).toBe(pruefungen('K8', 'wert')[0].ergebnis.kundensatz);
    expect(grund).toBe('Für November 2026 fehlt der Wert der Bezugsgröße BZ-6 Gutteile Montage Halle 2.');
    expect(KK.herkunftAnzeige(K8, K8_NOVEMBER)).toBeNull();
  });

  it('jeder Kundensatz ohne Zahl aus den Vektoren entsteht aus Grund, Periode und Eingängen (§5.8)', () => {
    let geprueft = 0;
    for (const fall of vektoren.cases) {
      for (const p of fall.pruefungen.filter((x: Json) => x.regel === 'wert' && x.ergebnis.kundensatz && x.eingang.zaehler)) {
        const e = p.eingang;
        const w: KennzahlWert = { ...ohneZeile(e.periode.art, e.periode.schluessel), grund: p.ergebnis.grund, einheit: e.einheit };
        const eingaenge: KennzahlFassung['eingaenge'] = [
          { rolle: 'zaehler', art: e.zaehler.art, id: '1', kennzeichen: e.zaehler.objekt, name: e.zaehler.name },
          { rolle: 'nenner', art: e.nenner.art, id: '2', kennzeichen: e.nenner.objekt, name: e.nenner.name },
        ];
        expect(KK.grundSatz(w, e.periode.art, eingaenge), `${fall.id} ${p.name}`).toBe(p.ergebnis.kundensatz);
        geprueft += 1;
      }
    }
    expect(geprueft).toBeGreaterThanOrEqual(3);
  });

  it('ohne Zeile spricht der Schritt nicht — und ein fremdes Kennzeichen macht die Zahl nicht still wahr', () => {
    expect(KK.wertKarte(K1, ohneZeile('monat', '2026-12'), null).karte.zahl).toBe('—');
    const fremd = { ...K1_OKTOBER, kennzeichen: ['Durchschnitt aus 3 Monaten'] };
    expect(KK.wertKarte(K1, fremd, null).karte).toMatchObject({ zahl: '—', zustand: null });
  });
});

describe('Herkunft, Berechnung, Stammdaten und Kopf', () => {
  it('K1: die Herkunfts-Karte nennt beide Eingänge mit Wert, Zustand, Version bzw. Fassung', () => {
    const h = KK.herkunftAnzeige(K1, K1_OKTOBER);
    expect(h?.eingaenge).toBe(`Menge 6.100${NB}kWh (MS-12, vollständig, Version 1) je 41.000${NB}Stück (BZ-6, Fassung 1)`);
    expect(h?.gebildet).toBe('Berechnung Fassung 1 · gerechnet 01.11.2026 00:20');
    expect(h?.fehlt).toBeNull();
  });

  it('K10 und K11: der unvollständige Eingang sagt seinen Zustand, seinen Verlauf und seine Kennzeichen', () => {
    expect(KK.herkunftAnzeige(K10, K10_TAG)?.eingaenge).toBe(
      `Menge 5.550${NB}kWh (MS-19, unvollständig, Verlauf 67${NB}%, Version 1, berechnet (Summe), 2 von 3 Systemen) je 180${NB}Personen (Mitarbeitende (U), Stichtag 05.11.2026)`,
    );
    expect(KK.herkunftAnzeige(K11, K11_TAG)?.eingaenge).toContain(`je 4,9667${NB}h (BZ-5, unvollständig`);
  });

  /**
   * UEMS AP-13 IP-11 (O10, D1/D2): die Herkunfts-Zeile der Kennzahl ist ein SPRUNG. K7 ist genau der
   * Referenzfall — KZ-0001 Oktober Version 2 nach der Korrektur K-2026-0007; die Zeile muss auf MS-12 ›
   * Werte › Oktober mit `version=2` führen, und BZ-6 muss Text bleiben.
   */
  it('O10: die Herkunfts-Zeile von K7 springt zu MS-12 mit Periode Oktober UND Version 2; BZ-6 bleibt Text', () => {
    const h = KK.herkunftAnzeige(K7, K7_OKTOBER);
    const ms = h?.eingaengeStuecke.find((t) => t.text === 'MS-12');
    expect(ms?.sprung?.hash).toBe('#/portfolio/messstellen/MS-12?periode=2026-10&version=2');
    expect(h?.eingaengeStuecke.some((t) => t.text === 'BZ-6')).toBe(false);
    expect(h?.eingaengeStuecke.filter((t) => t.sprung !== null)).toHaveLength(1);
    // Zusammengefügt ist die Zeile Zeichen für Zeichen der Satz von vorher — kein zweiter Wortlaut.
    expect(h?.eingaengeStuecke.map((t) => t.text).join('')).toBe(h?.eingaenge);
  });

  it('IP-11: K1 trägt Version 1 an derselben Messstelle — der Sprung nennt die Version SEINES Eingangs', () => {
    const h = KK.herkunftAnzeige(K1, K1_OKTOBER);
    expect(h?.eingaengeStuecke.find((t) => t.text === 'MS-12')?.sprung?.hash).toBe(
      '#/portfolio/messstellen/MS-12?periode=2026-10&version=1',
    );
  });

  it('IP-11: die Paare einer Zusammenfassung springen auf ihre Kennzahl-Seiten (K3)', () => {
    const h = KK.herkunftAnzeige(K3, K3_OKTOBER);
    expect(h?.paareStuecke.map((zeile) => zeile.find((t) => t.sprung)?.sprung?.hash)).toEqual([
      '#/portfolio/kennzahlen/KZ-0001',
      '#/portfolio/kennzahlen/KZ-0002',
    ]);
    expect(h?.paareStuecke.map((zeile) => zeile.map((t) => t.text).join(''))).toEqual(h?.paare);
  });

  it('K3: eine Zusammenfassung zeigt die Paare als Zeilen; K7: der Anlass steht ab Version 2 dabei', () => {
    const h = KK.herkunftAnzeige(K3, K3_OKTOBER);
    expect(h?.eingaenge).toBeNull();
    expect(h?.paare).toEqual([
      `KZ-0001 0,15${NB}kWh je Stück (6.100${NB}kWh je 41.000${NB}Stück, vollständig, Version 1, berechnet (Kennzahl))`,
      `KZ-0002 0,50${NB}kWh je Stück (3.600${NB}kWh je 7.200${NB}Stück, vollständig, Version 1, berechnet (Kennzahl), ab 15.10.2026)`,
    ]);
    expect(KK.herkunftAnzeige(K7, K7_OKTOBER)?.gebildet).toBe(
      'Berechnung Fassung 1 · gerechnet 12.11.2026 10:05:33 · Anlass K-2026-0007 (freigegeben 12.11.2026)',
    );
  });

  it('eine Herkunft ohne Satz sagt, was fehlt — nie eine halbe', () => {
    const jahr = { ...K1_OKTOBER, herkunft: { satz: null, fehlt: ['eingaenge' as const] } };
    expect(KK.herkunftAnzeige(K1, jahr)).toEqual({
      eingaenge: null,
      paare: [],
      // AP-13 IP-11: ohne Satz gibt es auch keine Sprünge — die Stücke sind leer, nicht erfunden.
      eingaengeStuecke: [],
      paareStuecke: [],
      gebildet: null,
      fehlt: 'Nicht gespeichert: Eingänge.',
    });
  });

  it('Kopf: „KZ-0001 · Stromeinsatz Montage je Stück — Halle 2 · Gebäude Halle 2 · verantwortlich Ines Kaltenbach“', () => {
    const k = KK.kopf(kz1);
    expect(`${k.titel} · ${k.unter}`).toBe('KZ-0001 · Stromeinsatz Montage je Stück — Halle 2 · Gebäude Halle 2 · verantwortlich Ines Kaltenbach');
    expect(k.archiviert).toBeNull();
    expect(KK.kopf({ ...kz1, archiviert_am: '2027-01-10T09:00:00+01:00' }).archiviert).toBe('archiviert');
  });

  it('Berechnung: „Menge je Bezugsgröße · MS-12 je BZ-6 · Fassung 1 gilt seit Beginn“ — der Verlauf erst ab zwei Fassungen', () => {
    const b = KK.berechnung(kz1, fassungenVon(KZ.kz1), 'Europe/Berlin');
    expect(b?.satz).toBe('Menge je Bezugsgröße · MS-12 je BZ-6 · Fassung 1 gilt seit Beginn');
    expect(b?.wer).toBe('eingetragen von Ines Kaltenbach · 01.10.2026 08:00');
    expect(b?.fassungen).toEqual([]);
    const [eins] = fassungenVon(KZ.kz1);
    const zwei: KennzahlFassung[] = [
      { ...eins, gueltig_bis: '2027-02-28' },
      { ...eins, nummer: 2, gueltig_ab: '2027-03-01', rueckwirkend: true, abzeichen: 'rückwirkend (19 Tage)', begruendung: 'Nenner jetzt Gutteile ohne Nacharbeit', herkunft: 'eintrag', eingetragen_am: '2027-03-20T09:12:00+01:00' },
    ];
    const b2 = KK.berechnung({ ...kz1, fassung: 2 }, zwei, 'Europe/Berlin');
    expect(b2?.satz).toBe('Menge je Bezugsgröße · MS-12 je BZ-6 · Fassung 2 gilt seit 01.03.2027');
    expect(b2?.abzeichen).toBe('rückwirkend (19 Tage)');
    expect(b2?.fassungen.map((f) => [f.titel, f.zeitraum, f.gilt, f.warum])).toEqual([
      ['Fassung 2', 'seit 01.03.2027', true, '„Nenner jetzt Gutteile ohne Nacharbeit“'],
      ['Fassung 1', 'seit Beginn bis 28.02.2027', false, null],
    ]);
    expect(KK.berechnung(ahrenbergKennzahlen()[2], fassungenVon(KZ.kz3), 'Europe/Berlin')?.satz).toBe(
      'Kennzahlen zusammenfassen · KZ-0001, KZ-0002 · Fassung 1 gilt seit Beginn',
    );
  });

  it('Stammdaten: Zweck · Verantwortlich · Geltungsbereich', () => {
    expect(KK.stammdaten(kz1)).toEqual([
      { name: 'Zweck', wert: 'Spezifischer Stromeinsatz der Montagelinie M1 je Gutteil; Basis für den Vergleich mit Lindach.' },
      { name: 'Verantwortlich', wert: 'Ines Kaltenbach' },
      { name: 'Geltungsbereich', wert: 'Gebäude Halle 2' },
    ]);
    expect(KK.stammdaten(KZ_0007)[0].wert).toBe('Kein Zweck angegeben.');
    expect(KK.geltungText(KZ_0008)).toBe('Messstelle Ladepunkt Parkplatz Halle 2');
  });
});

describe('Perioden und Verlauf', () => {
  it('der Umschalter zeigt nur die bildbaren Perioden — und keine Wahl, wo es keine gibt', () => {
    expect(KK.periodenWahl(kz1)).toEqual({ optionen: [{ id: 'monat', label: 'Monat' }, { id: 'jahr', label: 'Jahr' }], vorgabe: 'monat' });
    expect(KK.periodenWahl({ perioden: ['monat'], grundperiode: 'monat' })).toEqual({ optionen: [], vorgabe: 'monat' });
  });

  it('die Anfrage liegt auf Periodengrenzen und endet mit der Periode von heute', () => {
    expect(KK.anfrage('monat', '2026-11-12', 12)).toEqual({ von: '2025-12-01', bis: '2026-11-30' });
    expect(KK.anfrage('jahr', '2026-11-12', 5)).toEqual({ von: '2022-01-01', bis: '2026-12-31' });
    expect(KK.anfrage('tag', '2026-11-12', 31)).toEqual({ von: '2026-10-13', bis: '2026-11-12' });
    expect(KK.anfrage('woche', '2026-11-12', 2)).toEqual({ von: '2026-11-02', bis: '2026-11-15' });
    expect(KK.anfrage('monat', '2026-12-03', 3)).toEqual({ von: '2026-10-01', bis: '2026-12-31' });
    expect(KK.heuteIn('Europe/Berlin', Date.parse('2026-11-11T23:30:00Z'))).toBe('2026-11-12');
  });

  it('Balken je Periode mit Zustandsfarbe, „—“ für keine Werte; vor der ersten Zeile bleibt nichts stehen', () => {
    const { von, bis } = KK.anfrage('monat', '2026-12-10', 12);
    const a = kennzahlWerteAntwort(KZ.kz1, 'monat', von, bis, Date.parse('2026-12-10T12:00:00+01:00'));
    expect(KK.verlauf(a).map((b) => [b.kurz, b.zahl, b.ton, b.anteil])).toEqual([
      ['Okt', `0,15${NB}kWh je Stück`, 'ok', 1],
      ['Nov', '—', 'off', null],
      ['Dez', '—', 'off', null],
    ]);
    expect(KK.letzterSchritt(a)?.schluessel).toBe('2026-11');
    const leer = kennzahlWerteAntwort(KZ.kz1, 'jahr', '2025-01-01', '2026-12-31', Date.parse('2026-12-10T12:00:00+01:00'));
    expect(KK.verlauf(leer).map((b) => b.zahl)).toEqual(['—', '—']);
  });

  it('K10/K11 im Verlauf: die Richtung steht an der Zahl, die Höhe ist nur ein Bild', () => {
    const a = kennzahlWerteAntwort(KZ.kz7, 'tag', '2026-11-04', '2026-11-06', Date.parse('2026-12-10T12:00:00+01:00'));
    expect(KK.verlauf(a).map((b) => [b.kurz, b.zahl, b.ton])).toEqual([
      ['05.11.', `mindestens 30,83${NB}kWh je Person`, 'warn'],
      ['06.11.', '—', 'off'],
    ]);
  });
});

describe('die Liste (Name, letzter Wert, Zustand, Geltung, Verantwortlich; R-A7)', () => {
  const jetzt = Date.parse('2026-11-10T09:00:00+01:00');
  const liste = (id: string) => {
    const k = kennzahlenDerWelt().find((x) => x.id === id)!;
    const { von, bis } = KK.anfrage(k.grundperiode!, '2026-11-10', KK.ANZAHL_VERLAUF[k.grundperiode!]);
    return KK.listenKarte(k, { art: 'geladen', antwort: kennzahlWerteAntwort(id, k.grundperiode!, von, bis, jetzt) });
  };

  it('KZ-0001 am 10.11.2026: 0,15 kWh je Stück, vollständig, „Oktober 2026 · endgültig“', () => {
    expect(liste(KZ.kz1)).toEqual({
      id: KZ.kz1,
      kennzeichen: 'KZ-0001',
      name: 'Stromeinsatz Montage je Stück — Halle 2',
      unter: 'Gebäude Halle 2 · verantwortlich Ines Kaltenbach',
      archiviert: null,
      zahl: `0,15${NB}kWh je Stück`,
      zustand: 'vollständig',
      zustandTon: 'ok',
      periode: 'Oktober 2026 · endgültig',
      hinweis: null,
      fehler: null,
    });
    expect(liste(KZ.kz3).zahl).toBe(`0,20${NB}kWh je Stück`);
  });

  it('ohne jede Zeile im Fenster nur „—“ — kein Tag daneben, der nach einem fehlenden Wert aussähe (KZ-0008 am 10.11.)', () => {
    expect(liste(KZ.kz8)).toMatchObject({ zahl: '—', zustand: null, periode: null, hinweis: null });
  });

  it('R-A7: kennt die Werte-Route die Kennzahl für diesen Leser nicht, steht die Hinweiszeile — ohne Wert', () => {
    const k = kennzahlenDerWelt()[2];
    expect(KK.listenKarte(k, { art: 'ausserhalb' })).toMatchObject({
      name: 'Stromeinsatz Montage je Stück — Unternehmen',
      zahl: null,
      zustand: null,
      hinweis: 'umfasst Standorte außerhalb Ihres Zugriffs',
    });
    expect(KK.listenKarte(k, { art: 'fehler' })).toMatchObject({ zahl: null, fehler: 'Die Werte konnten nicht geladen werden.' });
  });
});

describe('Versionen (§5.5) — WertVersionen.tsx zeichnet sie', () => {
  const nachKorrektur = Date.parse('2026-11-12T12:00:00+01:00');

  it('der Einstieg steht erst ab zwei Versionen: K7 „2 Versionen“, K1 keiner', () => {
    expect(KK.versionenEinstieg(K7_OKTOBER)?.text).toBe('2 Versionen');
    expect(KK.versionenEinstieg(K1_OKTOBER)).toBeNull();
    expect(KK.wertKarte(K7, K7_OKTOBER, null).karte.zahl).toBe(pruefungen('K7', 'wert')[0].ergebnis.anzeige);
  });

  it('K7: Version 2 gilt jetzt, vorher 0,1488 — mit den Vergleichs-Stellen, sonst läsen beide 0,15', () => {
    const h = KK.kennzahlHistorie(kennzahlWertVersionenAntwort(KZ.kz1, 'monat', '2026-10-01', nachKorrektur));
    const [v2, v1] = h.versionen;
    expect([v2.titel, v2.etikett, v2.vorher?.zahl, v2.danach.zahl]).toEqual([
      'Version 2',
      'gilt jetzt',
      `0,1488${NB}kWh je Stück`,
      `0,1473${NB}kWh je Stück`,
    ]);
    expect(v2.danach.info).toBe(`vollständig · Verlauf 100${NB}%`);
    expect(v2.entscheidungen[0].vorgang).toBe('Korrektur K-2026-0007');
    expect(v2.entscheidungen[0].fassung?.wer).toBe('freigegeben von Ines Kaltenbach');
    expect(v2.entscheidungen[0].fassung?.wann).toBe('12.11.2026 10:05:33');
    expect(v2.entscheidungen[0].angelegt?.warum).toBe('„Zählerablesung 31.10. berichtigt (Ablesefehler 60 kWh)“');
    expect([v1.titel, v1.etikett, v1.gebildet]).toEqual(['Version 1', 'Original', 'gebildet am 01.11.2026 00:20']);
  });

  it('eine geänderte Berechnung spricht ihre Fassung; ohne Entscheidung sagt der Anlass, was geschah', () => {
    const e = KK.kennzahlEntscheidung(
      { vorgang: 'berechnung', kennung: 'KZ-0001', fassung: 2, status: null, methode: null, art: 'eintrag', wer: { name: 'Ines Kaltenbach', rolle: 'Energiemanager', art: 'kunde' }, wann: '2027-03-20T09:12:00+01:00', warum: 'Nenner jetzt Gutteile ohne Nacharbeit', beleg: null, fehlt: [], angelegt: null },
      'Europe/Berlin',
    );
    expect([e.vorgang, e.fassung?.wer, e.fassung?.warum]).toEqual(['Berechnung Fassung 2', 'eingetragen von Ines Kaltenbach', '„Nenner jetzt Gutteile ohne Nacharbeit“']);
    const h = kennzahlWertVersionenAntwort(KZ.kz1, 'monat', '2026-10-01', nachKorrektur);
    h.versionen[1].entscheidungen = [];
    h.versionen[1].anlass = { art: 'eingang', beleg: 'Berichtigung BZ-1 Oktober 2026, Fassung 2 (I-2026-0003)' };
    expect(KK.kennzahlHistorie(h).versionen[0].ohneEntscheidung).toBe('Anlass Berichtigung BZ-1 Oktober 2026, Fassung 2 (I-2026-0003)');
  });
});
