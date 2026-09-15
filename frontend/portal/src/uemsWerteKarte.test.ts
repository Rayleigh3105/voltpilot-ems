import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MessstelleWerte, MessstelleWerteWert } from './api';
import {
  F8_LUECKE,
  ANFANG_NICHT_GEMESSEN,
  f13Stunden,
  f13Tag,
  f14Stunden,
  f14Tag,
  f16Monat,
  f16Tage,
  f20Tag,
  f8Stunden,
  f8Tag,
  f9Tag,
  LUECKE_F20,
  nochNichtGebildetStunden,
  nochNichtGebildetTag,
  normalStunden,
  normalTag,
  ohneQuelleStunden,
  ohneQuelleTag,
  schritt,
  MS_06,
  MS16_BINDUNG,
  antwort,
  ms16Oktober,
  ms16OktoberTage,
  tagesgrenzen,
} from './test/werteKarteFixtures';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import { UEMS_LUECKE, UEMS_NOCH_NICHT_GERECHNET, UEMS_NOCH_NICHT_GERECHNET_SATZ } from './glossar';
import { EREIGNIS_TEXTE } from './uemsEreignis';
import { KEINE_WERTE, OHNE_ZAHL, TRENNER, ZUSTAENDE, fassung, satz, tagesdauer } from './uemsErgebnis';
import {
  anfragen,
  karte,
  liste,
  luecken,
  monatTitel,
  periodeAus,
  tagTitel,
  VERSION_FRUEHERE,
  VERSION_NEUESTE,
  versionHinweis,
  nebengroessen,
  ohneQuelle,
  ohneQuelleWeg,
  quellenNamen,
  zeitenKopf,
} from './uemsWerteKarte';
import { f21Tag, f21TagWert } from './test/wertVersionenFixtures';

/**
 * Die Tages- und Monatskarte (UEMS AP-08 IP-11) gegen die Sätze der Fälle F8,
 * F13 und F14 — die Zahlen der Antworten sind die Erwartungen von
 * `verbrauch-vectors.json` (hier gegengeprüft), die Sätze die des
 * Ergebnis-Vertrags `ergebnis-zustand-vectors.json`.
 */

type Json = any;

const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const lies = (datei: string): Json => JSON.parse(readFileSync(resolve(V2, datei), 'utf8'));
const verbrauch = lies('verbrauch-vectors.json');
const ergebnisFaelle = lies('ergebnis-zustand-vectors.json').cases as Json[];

const NB = ' ';
const erwartung = (fall: string, name: string): Json => {
  const f = (verbrauch.cases as Json[]).find((c) => c.name.startsWith(`${fall}-`));
  const e = (f?.expected as Json[] | undefined)?.find((x) => x.name === name);
  if (!e) throw new Error(`keine Erwartung ${fall} · ${name}`);
  return e;
};
const vertragsSatz = (fall: string, name: string): string => {
  const f = ergebnisFaelle.find((c) => c.familie === 'ergebnis' && c.fall === fall && c.name === name);
  if (!f) throw new Error(`kein Satz ${fall} · ${name}`);
  return f.erwartet.satz;
};

/** Die Antwort trägt die Zahlen der Erwartung — sonst prüfte der Test eine erfundene Welt. */
const gleichDerErwartung = (a: MessstelleWerte, index: number, e: Json) => {
  const w = a.werte[index];
  expect(w.von, e.name).toBe(e.von);
  expect(w.bis, e.name).toBe(e.bis);
  expect(w.menge, e.name).toBe(e.menge);
  expect(w.zustand, e.name).toBe(e.zustand);
  expect([w.erhalten, w.erwartet, w.abdeckung_prozent], e.name).toEqual([e.erhalten, e.erwartet, e.abdeckung_prozent]);
  expect(w.kennzeichen, e.name).toEqual(e.kennzeichen);
};

const zeileMit = (a: MessstelleWerte, beschriftung: string) => {
  const z = liste(a).find((x) => x.beschriftung === beschriftung);
  if (!z) throw new Error(`keine Zeile ${beschriftung}`);
  return z;
};

describe('uemsWerteKarte — F8: vollständig aus Zählerständen, Verlauf 85 % (E1)', () => {
  it('die Antworten tragen die Zahlen von F8', () => {
    gleichDerErwartung(f8Tag(), 0, erwartung('f8', 'Tag 03.11.2026'));
    gleichDerErwartung(f8Stunden(), 17, erwartung('f8', 'Stunde 17:00–18:00'));
  });

  it('die Karte zeigt Menge, Zustand samt Herkunft und Verlauf nebeneinander', () => {
    const k = karte(f8Tag())!;
    expect(k.titel).toBe('Di 03.11.2026');
    expect(k.zahl).toBe(`2.304${NB}kWh`);
    expect(k.zustand).toBe('vollständig (Menge aus Zählerständen)');
    expect(k.abdeckung).toBe(`Verlauf 85${NB}%`);
    expect(k.kennzeichen).toEqual([F8_LUECKE]);
    expect(k.tagesdauer).toBeNull();
    expect([k.zustandTon, k.abdeckungTon]).toEqual(['ok', 'warn']);
  });

  it('ohne die Herkunft ist es Zeichen für Zeichen der Satz des Vertrags', () => {
    const k = karte(f8Tag())!;
    const ohneHerkunft = [k.zahl, 'vollständig', k.abdeckung, ...k.kennzeichen].join(TRENNER);
    expect(ohneHerkunft).toBe(vertragsSatz('F8', 'Tag vollständig trotz 85 % Verlauf, mit gezähltem Lücken-Zuwachs'));
  });

  it('die Stundenliste: eine Stunde ohne Werte ist ein Strich, nie 0,0 kWh', () => {
    const a = f8Stunden();
    const leer = zeileMit(a, '15:00–16:00');
    expect(leer.zahl).toBe(OHNE_ZAHL);
    expect(leer.zustand).toBe('keine Werte');
    expect(leer.abdeckung).toBe(`Verlauf 0${NB}%`);
    const nurEinStand = zeileMit(a, '14:00–15:00');
    expect([nurEinStand.zahl, nurEinStand.zustand]).toEqual([OHNE_ZAHL, 'unvollständig']);
    const teil = zeileMit(a, '17:00–18:00');
    expect([teil.zahl, teil.zustand, teil.abdeckung]).toEqual([`46,4${NB}kWh`, 'unvollständig', `Verlauf 48${NB}%`]);
    expect(teil.kennzeichen).toEqual([ANFANG_NICHT_GEMESSEN]);
    // Die Zeile spricht das Wort allein — die Herkunft steht einmal, an der Karte.
    expect(zeileMit(a, '10:00–11:00').zustand).toBe('vollständig');
    for (const z of liste(a)) {
      expect(z.zahl, z.beschriftung).not.toMatch(/^0,0/);
      if (a.werte.find((w) => w.von === z.schluessel)!.menge === null) expect(z.zahl, z.beschriftung).toBe(OHNE_ZAHL);
    }
  });
});

describe('uemsWerteKarte — F13: der 25-Stunden-Tag (E10)', () => {
  it('die Antworten tragen die Zahlen von F13', () => {
    gleichDerErwartung(f13Tag(), 0, erwartung('f13', 'Tag 25.10.2026 (25 h)'));
    const stunden = f13Stunden().werte;
    for (const name of ['Stunde 02:00–03:00 MESZ', 'Stunde 02:00–03:00 MEZ']) {
      const e = erwartung('f13', name);
      // Die Erwartung schreibt UTC, die Route die Ortszeit mit Versatz — derselbe Zeitpunkt.
      const w = stunden.find((x) => Date.parse(x.von) === Date.parse(e.von))!;
      expect([Date.parse(w.bis), w.menge, w.zustand, w.abdeckung_prozent]).toEqual([Date.parse(e.bis), e.menge, e.zustand, e.abdeckung_prozent]);
    }
  });

  it('die Karte sagt „25 Stunden (Zeitumstellung)“ neben 720 kWh', () => {
    const k = karte(f13Tag())!;
    expect(k.titel).toBe('So 25.10.2026');
    expect(k.zahl).toBe(`720${NB}kWh`);
    expect(k.zustand).toBe('vollständig (Menge aus Zählerständen)');
    expect(k.abdeckung).toBe(`Verlauf 100${NB}%`);
    expect(k.tagesdauer).toBe('25 Stunden (Zeitumstellung)');
    expect(k.tagesdauer).toBe(tagesdauer('2026-10-25', 'Europe/Berlin'));
    expect([k.zahl, 'vollständig', k.abdeckung].join(TRENNER)).toBe(vertragsSatz('F13', '25-Stunden-Tag'));
  });

  it('die Stundenliste hat 25 Zeilen und die doppelte Stunde mit MESZ, dann MEZ', () => {
    const zeilen = liste(f13Stunden());
    expect(zeilen).toHaveLength(25);
    const beschriftungen = zeilen.map((z) => z.beschriftung);
    expect(beschriftungen.slice(1, 5)).toEqual(['01:00–02:00', '02:00–03:00 MESZ', '02:00–03:00 MEZ', '03:00–04:00']);
    expect(beschriftungen.filter((b) => / ME(S)?Z$/.test(b))).toEqual(['02:00–03:00 MESZ', '02:00–03:00 MEZ']);
    for (const name of ['Stunde 02:00–03:00 MESZ', 'Stunde 02:00–03:00 MEZ']) {
      const e = erwartung('f13', name);
      const z = zeilen.find((x) => Date.parse(x.schluessel) === Date.parse(e.von))!;
      expect(z.beschriftung).toBe(name.replace('Stunde ', ''));
      expect([z.zahl, z.zustand, z.abdeckung]).toEqual([`28,8${NB}kWh`, e.zustand, `Verlauf 100${NB}%`]);
    }
  });
});

describe('uemsWerteKarte — F14: der 23-Stunden-Tag (E10)', () => {
  it('die Antworten tragen die Zahlen von F14', () => {
    gleichDerErwartung(f14Tag(), 0, erwartung('f14', 'Tag 28.03.2027 (23 h)'));
  });

  it('die Karte sagt „23 Stunden (Zeitumstellung)“ neben 662 kWh', () => {
    const k = karte(f14Tag())!;
    expect(k.titel).toBe('So 28.03.2027');
    expect(k.zahl).toBe(`662${NB}kWh`);
    expect(k.zustand).toBe('vollständig (Menge aus Zählerständen)');
    expect(k.tagesdauer).toBe('23 Stunden (Zeitumstellung)');
    expect([k.zahl, 'vollständig', k.abdeckung].join(TRENNER)).toBe(vertragsSatz('F14', '23-Stunden-Tag'));
  });

  it('die Stundenliste hat 23 Zeilen; die fehlende Stunde erscheint nicht, ohne Lücken-Marke', () => {
    const zeilen = liste(f14Stunden());
    expect(zeilen).toHaveLength(23);
    expect(zeilen.map((z) => z.beschriftung).slice(0, 3)).toEqual(['00:00–01:00', '01:00–02:00', '03:00–04:00']);
    expect(zeilen.some((z) => z.beschriftung.startsWith('02:00'))).toBe(false);
    for (const name of ['Stunde 01:00–02:00 MEZ', 'Stunde 03:00–04:00 MESZ']) {
      const e = erwartung('f14', name);
      const z = zeilen.find((x) => Date.parse(x.schluessel) === Date.parse(e.von))!;
      expect([z.zahl, z.zustand]).toEqual([`28,8${NB}kWh`, e.zustand]);
    }
    expect(zeilen.every((z) => z.zustand === 'vollständig')).toBe(true);
  });
});

describe('uemsWerteKarte — Monat (F16) und die Tagesliste', () => {
  it('die Monatskarte: 55.100 kWh ganz, vollständig aus Zählerständen, ohne Tagesdauer', () => {
    gleichDerErwartung(f16Monat(), 0, erwartung('f16', 'Monat Oktober 2026'));
    const k = karte(f16Monat())!;
    expect(k.titel).toBe('Oktober 2026');
    expect(k.zahl).toBe(`55.100${NB}kWh`);
    expect(k.zustand).toBe('vollständig (Menge aus Zählerständen)');
    expect(k.abdeckung).toBe(`Verlauf 100${NB}%`);
    expect(k.tagesdauer).toBeNull();
  });

  it('die Tagesliste: 31 Tage, ganze kWh, der 25.10. nennt seine 25 Stunden', () => {
    const zeilen = liste(f16Tage());
    expect(zeilen).toHaveLength(31);
    expect(zeilen[0].beschriftung).toBe('Do 01.10.');
    const sonntag = zeilen.find((z) => z.beschriftung === 'So 25.10.')!;
    expect(sonntag.tagesdauer).toBe('25 Stunden (Zeitumstellung)');
    expect(zeilen.filter((z) => z.tagesdauer !== null)).toHaveLength(1);
    expect(zeilen.every((z) => /^\d{1,3}(\.\d{3})* kWh$/.test(z.zahl))).toBe(true);
  });
});

/**
 * ergebnis-zustand 1.7 — Captain 14.09.2026 „Ja, immer zeigen“: wer eine Zahl
 * abrechnet, muss wissen, ob sie sich noch ändern kann. Die Karte sagt darum in
 * BEIDEN Fällen, was die Route für genau die gezeigte Periode liefert.
 */
describe('uemsWerteKarte — die Fassung der gezeigten Periode: vorläufig oder endgültig', () => {
  it('ein endgültiger Tag sagt „endgültig“ — der Normalfall wird gesagt, nicht weggelassen', () => {
    const k = karte(normalTag())!;
    expect([k.fassung, k.fassungWert]).toEqual(['endgültig', 'endgueltig']);
    expect(k.zustand).toBe('vollständig (Menge aus Zählerständen)');
  });

  it('ein vorläufiger Tag sagt „vorläufig“ — ganz zuletzt im Satz des Vertrags', () => {
    const k = karte(f8Tag())!;
    expect([k.fassung, k.fassungWert]).toEqual(['vorläufig', 'vorlaeufig']);
    const mitFassung = [k.zahl, 'vollständig', k.abdeckung, ...k.kennzeichen, k.fassung].join(TRENNER);
    expect(mitFassung).toBe(vertragsSatz('F8', 'Tag vorläufig: die Fassung steht ganz zuletzt (seit 1.7)'));
  });

  it('ein vorläufiger Monat mit endgültigen Tagen: jede Periode sagt ihre eigene Fassung, nichts wird abgeleitet', () => {
    const monat = karte(f16Monat())!;
    expect(monat.fassung).toBe('vorläufig');
    expect(monat.zustand).toBe('vollständig (Menge aus Zählerständen)');
    const tage = f16Tage().werte;
    expect(tage.filter((w) => w.fassung === 'endgueltig')).toHaveLength(28);
    // Der 25.10. liegt im vorläufigen Oktober und ist selbst endgültig.
    expect(karte(f13Tag())!.fassung).toBe('endgültig');
    // Die Zeilen tragen die Fassung nicht (wie die Herkunft: nur an der Karte).
    expect(liste(f16Tage()).some((z) => 'fassung' in z)).toBe(false);
  });

  it('die Fassung ist das Wort des Vertrags und nie ein Zustandswort', () => {
    for (const a of [normalTag(), f8Tag(), f16Monat()]) {
      const k = karte(a)!;
      expect(k.fassung).toBe(fassung(a.werte[0].fassung));
      expect(ZUSTAENDE.map((z) => z.wort)).not.toContain(k.fassung);
      expect(k.zustand).not.toContain(k.fassung!);
    }
  });

  it('ohne Fassung der Route, ohne gesprochenen Schritt oder mit fremdem Wert steht keine Fassung', () => {
    expect(karte(ohneQuelleTag())!.fassung).toBeNull();
    const nochNicht = f8Tag();
    nochNicht.werte = [schritt({ von: nochNicht.werte[0].von, bis: nochNicht.werte[0].bis, grund: 'noch_nicht_gebildet', quelle: null })];
    expect(nochNicht.werte[0].fassung).toBe('vorlaeufig');
    expect(karte(nochNicht)).toMatchObject({ zustand: null, fassung: null, fassungWert: null });
    const fremd = f8Tag();
    fremd.werte = [{ ...fremd.werte[0], fassung: 'vollständig' as never }];
    expect(karte(fremd)).toMatchObject({ zustand: 'vollständig (Menge aus Zählerständen)', fassung: null });
  });

  it('„keine Werte“ innerhalb der Frist ist vorläufig — dann sagt die Karte beides, nebeneinander', () => {
    // Ein Tag ohne einen Rohwert kann innerhalb von sieben Tagen noch Werte bekommen (F9).
    const a = f8Tag();
    a.werte = [{ ...a.werte[0], menge: null, zustand: 'keine Werte', erhalten: 0, abdeckung_prozent: 0, kennzeichen: [] }];
    expect(karte(a)).toMatchObject({ zahl: OHNE_ZAHL, zustand: 'keine Werte', fassung: 'vorläufig' });
  });
});

describe('uemsWerteKarte — null ist ein Strich, überall', () => {
  it('eine Messstelle ohne Quelle: keine Werte, kein Verlauf, keine Herkunft', () => {
    const k = karte(ohneQuelleTag())!;
    expect([k.zahl, k.zustand, k.abdeckung, k.kennzeichen]).toEqual([OHNE_ZAHL, 'keine Werte', null, []]);
    expect(k.zustandTon).toBe('off');
    expect([k.zahl, k.zustand].join(TRENNER)).toBe(vertragsSatz('F8', 'keine Werte'));
    const zeilen = liste(ohneQuelleStunden());
    expect(zeilen).toHaveLength(24);
    expect(new Set(zeilen.map((z) => `${z.zahl} ${z.zustand}`))).toEqual(new Set([`${OHNE_ZAHL} keine Werte`]));
  });

  it('ein Schritt ohne Zustand (noch nicht gebildet) spricht keine Zahl — aber seinen eigenen Satz', () => {
    const a = f8Tag();
    a.werte = [schritt({ von: a.werte[0].von, bis: a.werte[0].bis, grund: 'noch_nicht_gebildet', quelle: null })];
    expect(karte(a)).toMatchObject({
      zahl: OHNE_ZAHL,
      zustand: null,
      abdeckung: null,
      kennzeichen: [],
      fassung: null,
      luecken: null,
      grund: UEMS_NOCH_NICHT_GERECHNET_SATZ,
    });
  });

  it('ein Schritt, der den Vertrag verletzt, wird nicht gesprochen — auch nicht seine Zahl', () => {
    const a = f8Tag();
    // „keine Werte“ mit einer Zahl ist `zahl_verboten`: die 2.304 kWh erscheinen nicht.
    a.werte = [{ ...a.werte[0], zustand: 'keine Werte' }];
    expect(karte(a)).toMatchObject({ zahl: OHNE_ZAHL, zustand: null });
    // Ein unbekannter Satz ist kein Kennzeichen.
    const b = f8Tag();
    b.werte = [{ ...b.werte[0], kennzeichen: ['geschätzt'] }];
    expect(karte(b)).toMatchObject({ zahl: OHNE_ZAHL, zustand: null });
  });

  it('eine Menge in Wh wird in kWh angezeigt, die Ebene bestimmt die Stellen', () => {
    const a = f8Tag();
    a.messstelle = { ...a.messstelle, einheit: 'Wh' };
    a.werte = [{ ...a.werte[0], menge: 2304000, kennzeichen: [] }];
    expect(karte(a)!.zahl).toBe(`2.304${NB}kWh`);
    // Der gewöhnliche Tag davor: 2.304 kWh, 96,0 kWh je Stunde, alles vollständig.
    expect(satz({ wert: 2304, einheit: 'kWh', ebene: 'tag', zustand: 'vollständig', abdeckungProzent: 100, kennzeichen: [] }))
      .toBe([karte(normalTag())!.zahl, 'vollständig', karte(normalTag())!.abdeckung].join(TRENNER));
    expect(liste(normalStunden()).map((z) => z.zahl)).toEqual(Array(24).fill(`96,0${NB}kWh`));
  });
});

describe('uemsWerteKarte — drei Lagen: Wert da · noch nicht gebildet · keine Werte (Captain 15.09.2026)', () => {
  it('jede Lage spricht ihren eigenen Satz — keine sieht aus wie eine andere', () => {
    const da = karte(normalTag())!;
    const nochNicht = karte(nochNichtGebildetTag())!;
    const keine = karte(ohneQuelleTag())!;
    expect([da.zahl, da.zustand, da.grund]).toEqual([`2.304${NB}kWh`, 'vollständig (Menge aus Zählerständen)', null]);
    expect([nochNicht.zahl, nochNicht.zustand, nochNicht.abdeckung, nochNicht.grund]).toEqual([
      OHNE_ZAHL,
      null,
      null,
      UEMS_NOCH_NICHT_GERECHNET_SATZ,
    ]);
    // Seit AP-13 IP-6 sagt auch „keine Werte“ ohne Quelle, warum (E11 = A).
    expect([keine.zahl, keine.zustand, keine.grund]).toEqual([
      OHNE_ZAHL,
      KEINE_WERTE,
      'Keine Quelle: MS-21 Gas Heizung Verwaltung hatte in diesem Zeitraum keine führende Quelle — es gibt keine Zahl, auch keine 0.',
    ]);
    const gesagt = [da, nochNicht, keine].map((k) => [k.zahl, k.zustand, k.grund].filter((t) => t !== null).join(TRENNER));
    expect(new Set(gesagt).size).toBe(3);
    // Nie „keine Werte“ und nie der Strich allein.
    expect(UEMS_NOCH_NICHT_GERECHNET_SATZ).not.toContain(KEINE_WERTE);
    expect(gesagt[1]).not.toBe(OHNE_ZAHL);
  });

  it('Wort und Satz stehen im Glossar — der Satz beginnt mit dem Wort der Zeile', () => {
    const wort = UEMS_NOCH_NICHT_GERECHNET;
    expect(UEMS_NOCH_NICHT_GERECHNET_SATZ.startsWith(`${wort.charAt(0).toUpperCase()}${wort.slice(1)} — `)).toBe(true);
  });

  it('die Liste: die noch nicht gebildete Stunde trägt das Wort, eine Stunde ohne Werte nicht', () => {
    const zeilen = liste(nochNichtGebildetStunden());
    expect(zeilen).toHaveLength(24);
    const letzte = zeilen[23];
    expect(letzte.beschriftung).toMatch(/^23:00–/);
    expect([letzte.zahl, letzte.zustand, letzte.grund]).toEqual([OHNE_ZAHL, null, UEMS_NOCH_NICHT_GERECHNET]);
    expect(zeilen.slice(0, 23).every((z) => z.zahl === `96,0${NB}kWh` && z.grund === null)).toBe(true);
    const leer = zeileMit(f8Stunden(), '15:00–16:00');
    expect([leer.zahl, leer.zustand, leer.grund]).toEqual([OHNE_ZAHL, KEINE_WERTE, null]);
    expect(liste(ohneQuelleStunden()).every((z) => z.grund === null)).toBe(true);
  });

  it('seit AP-13 IP-6 spricht jeder Grund ohne Zahl seinen Satz an der Karte — die Zeile trägt weiter nur „noch nicht gerechnet“', () => {
    const a = f8Tag();
    a.werte = [schritt({ von: a.werte[0].von, bis: a.werte[0].bis, grund: 'ohne_menge_gespeichert' })];
    expect(karte(a)).toMatchObject({
      zahl: OHNE_ZAHL,
      zustand: null,
      grund: 'Dieser Zeitraum ist ohne Menge gespeichert (Stand vor der Umstellung) — der Verlauf ist bekannt, die Zahl nicht.',
    });
    expect(liste(a)[0].grund).toBeNull();
  });
});

describe('uemsWerteKarte — die Anzahl der Lücken an der Karte (Captain 15.09.2026)', () => {
  it('null Lücken: der gewöhnliche Tag nennt keine Anzahl — der Verlauf steht wie bisher', () => {
    const a = normalTag();
    expect(a.werte[0].ereignisse).toEqual([]);
    const k = karte(a)!;
    expect(k.luecken).toBeNull();
    expect(k.abdeckung).toMatch(/^Verlauf 100\s%$/);
  });

  it('genau eine Lücke: F8 nennt „1 Lücke“ — das eine Ereignis, das die Route an den Tag hängt', () => {
    const a = f8Tag();
    expect(a.werte[0].ereignisse.filter((e) => e.art === 'data_gap')).toHaveLength(1);
    const k = karte(a)!;
    expect(k.luecken).toBe(`1 ${UEMS_LUECKE.singular}`);
    expect(k.abdeckung).toMatch(/^Verlauf 85\s%$/);
    // Der Satz der Lücke bleibt unter den Kennzeichen — die Anzahl ersetzt ihn nicht.
    expect(k.kennzeichen).toEqual([F8_LUECKE]);
  });

  it('F20: die Lücke über die Tagesgrenze ist an jedem der beiden Tage genau eine', () => {
    const tage = [
      ['2026-10-20', 'Tag 20.10.2026'],
      ['2026-10-21', 'Tag 21.10.2026'],
    ] as const;
    for (const [tag, name] of tage) {
      const a = f20Tag(tag);
      gleichDerErwartung(a, 0, erwartung('f20', name));
      expect(a.werte[0].ereignisse).toEqual([LUECKE_F20]);
      expect(karte(a)).toMatchObject({ zahl: `2.208${NB}kWh`, luecken: '1 Lücke' });
    }
  });

  it('mehrere Lücken heißen „Lücken“ — F24, die Leistungsreihe von MS-10 am 20.10.2026 (10:14–10:16, 10:29–10:30)', () => {
    const ereignisse = [
      { id: 'e8a1c2d3-0000-4000-8000-000000000241', art: 'data_gap', von: '2026-10-20T10:14:00+02:00', bis: '2026-10-20T10:16:00+02:00' },
      { id: 'e8a1c2d3-0000-4000-8000-000000000242', art: 'data_gap', von: '2026-10-20T10:29:00+02:00', bis: '2026-10-20T10:30:00+02:00' },
    ];
    const w = schritt({ von: '2026-10-20T10:00:00+02:00', bis: '2026-10-20T11:00:00+02:00', abdeckung_prozent: 96, ereignisse });
    expect(luecken(w)).toBe(`2 ${UEMS_LUECKE.plural}`);
  });

  it('jede Lücke einmal: dasselbe Ereignis zweimal bleibt eine Lücke, eine Übergabe ist keine', () => {
    const w = f8Tag().werte[0];
    // Die Übergabe beim Box-Tausch am 04.11.2026 09:38–09:40 ist ein anderes Ereignis (`handover`).
    const uebergabe = { id: 'e8a1c2d3-0000-4000-8000-000000000404', art: 'handover', von: '2026-11-04T09:38:00+01:00', bis: '2026-11-04T09:40:00+01:00' };
    expect(luecken({ ...w, ereignisse: [...w.ereignisse, ...w.ereignisse, uebergabe] })).toBe('1 Lücke');
  });

  it('F9: die nachgelieferte Lücke bleibt als Ereignis, der Verlauf ist 100 % — keine Anzahl, kein Widerspruch', () => {
    const a = f9Tag();
    gleichDerErwartung(a, 0, erwartung('f9', 'Tag 03.11.2026'));
    expect(a.werte[0].ereignisse).toEqual(f8Tag().werte[0].ereignisse);
    const k = karte(a)!;
    expect(k.luecken).toBeNull();
    expect(k.abdeckung).toMatch(/^Verlauf 100\s%$/);
  });

  it('ein Schritt, der nicht gesprochen wird, nennt auch keine Anzahl', () => {
    const a = f8Tag();
    a.werte = [{ ...a.werte[0], kennzeichen: ['geschätzt'] }];
    expect(karte(a)).toMatchObject({ zahl: OHNE_ZAHL, zustand: null, luecken: null });
  });

  it('„Lücke“ ist der Name der Ereignis-Art im Vokabular', () => {
    expect(UEMS_LUECKE.singular).toBe(EREIGNIS_TEXTE.data_gap.name);
  });
});

describe('uemsWerteKarte — Anfragen und Titel', () => {
  it('Tag: die Periode und ihre Stunden; Monat: die Periode und ihre Tage bis zum letzten einschließlich', () => {
    expect(anfragen('tag', '2026-10-25')).toEqual({
      karte: { raster: 'tag', von: '2026-10-25', bis: '2026-10-25' },
      liste: { raster: 'stunde', von: '2026-10-25', bis: '2026-10-25' },
    });
    expect(anfragen('monat', '2026-10')).toEqual({
      karte: { raster: 'monat', von: '2026-10-01', bis: '2026-10-31' },
      liste: { raster: 'tag', von: '2026-10-01', bis: '2026-10-31' },
    });
    expect(anfragen('monat', '2028-02').karte.bis).toBe('2028-02-29');
    expect(anfragen('monat', '2027-02').karte.bis).toBe('2027-02-28');
  });

  it('der Titel liest den Kalendertag der Ortszeit, nie die Zone des Browsers', () => {
    expect(tagTitel('2026-10-25T00:00:00+02:00')).toBe('So 25.10.2026');
    expect(tagTitel('2026-11-01T00:00:00+01:00', false)).toBe('So 01.11.');
    expect(monatTitel('2026-10-01T00:00:00+02:00')).toBe('Oktober 2026');
  });
});

describe('uemsWerteKarte — der Kopf der Werte: die Zone der Antwort (UEMS AP-13 IP-3, E12 = A)', () => {
  const faelle = JSON.parse(readFileSync(resolve(process.cwd(), 'src/test/oberflaechenFaelle.json'), 'utf8'));
  const o14: Json = (faelle.faelle as Json[]).find((f) => f.id === 'O14');

  it('O14: der 25-Stunden-Tag an MS-06 sagt „Zeiten in Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg)“ — aus der Antwort', () => {
    const a = f13Tag();
    expect([a.zeitzone, a.zeitzone_herkunft]).toEqual([o14.gegeben.zone, o14.gegeben.zeitzone_herkunft]);
    const kopf = zeitenKopf(a, 'Werk Ahrenberg');
    expect(kopf).toBe('Zeiten in Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg)');
    // Der Kopf des Falls ist „Sonntag, 25.10.2026 · <Zone>“: den Tag trägt die Karte, die Zone der Kopf der Sektion.
    expect(o14.erwartet.kopf.endsWith(` · ${kopf}`)).toBe(true);
    expect(karte(a)?.tagesdauer).toBe(o14.gegeben.tagesdauer);
    expect(liste(f13Stunden())).toHaveLength(o14.erwartet.stunden_zeilen);
  });

  it('die Herkunft steht immer dabei: Unternehmen und Vorgabe ohne Namen, ohne bekannten Standort nur „des Standorts“', () => {
    expect(zeitenKopf({ zeitzone: 'Europe/Vienna', zeitzone_herkunft: 'unternehmen' }, 'Werk Ahrenberg')).toBe(
      'Zeiten in Europe/Vienna (Zeitzone des Unternehmens)',
    );
    expect(zeitenKopf({ zeitzone: 'Europe/Zurich', zeitzone_herkunft: 'vorgabe' }, 'Werk Ahrenberg')).toBe('Zeiten in Europe/Zurich (Vorgabe)');
    expect(zeitenKopf(f13Tag())).toBe('Zeiten in Europe/Berlin (Zeitzone des Standorts)');
  });
});

describe('uemsWerteKarte — die Version der Adresse (UEMS AP-13 IP-3, E9)', () => {
  /** F21 · MS-10 · 03.11.2026 in Version v — so, wie `…/werte?version=v` den Tag liefert. */
  const tagIn = (v: 1 | 2 | 3): MessstelleWerte => ({ ...f21Tag(), version: v, werte: [f21TagWert(v)] });

  it('Version 3 von 3: „Sie sehen Version 3 — heute die neueste“', () => {
    expect(versionHinweis(tagIn(3), 3)).toBe('Sie sehen Version 3 — heute die neueste');
    expect(VERSION_NEUESTE).toBe('Sie sehen Version {n} — heute die neueste');
  });

  it('eine frühere Version sagt, welche heute gilt', () => {
    expect(versionHinweis(tagIn(1), 1)).toBe('Sie sehen Version 1 — heute gilt Version 3');
    expect(versionHinweis(tagIn(2), 2)).toBe(VERSION_FRUEHERE.replace('{n}', '2').replace('{neueste}', '3'));
  });

  it('ohne Version in der Adresse kein Hinweis — auch nicht bei drei Versionen, die Karte hat ihren Einstieg', () => {
    expect(versionHinweis(f21Tag(), null)).toBeNull();
  });

  it('nur, wenn die Karte GENAU diese Version zeigt und spricht — nie über einem Strich', () => {
    expect(versionHinweis(tagIn(3), 2)).toBeNull();
    const nichtGespeichert = schritt({ ...f21TagWert(2), menge: null, zustand: null, kennzeichen: [], grund: 'version_nicht_gespeichert' });
    expect(versionHinweis({ ...f21Tag(), werte: [nichtGespeichert] }, 2)).toBeNull();
    expect(versionHinweis({ ...f21Tag(), werte: [{ ...f21TagWert(3), versionen: null }] }, 3)).toBeNull();
    expect(versionHinweis({ ...f21Tag(), werte: [{ ...f21TagWert(3), version: 4 }] }, 4)).toBeNull();
    expect(versionHinweis({ ...f21Tag(), werte: [] }, 3)).toBeNull();
  });
});

describe('uemsWerteKarte — die Periode der Adresse (UEMS AP-13 IP-3)', () => {
  it('Tag und Monat, wie `sprungziel` sie schreibt', () => {
    expect(periodeAus('2026-10-25')).toEqual({ art: 'tag', wert: '2026-10-25' });
    expect(periodeAus('2026-10')).toEqual({ art: 'monat', wert: '2026-10' });
    expect(periodeAus('2028-02-29')).toEqual({ art: 'tag', wert: '2028-02-29' });
  });

  it('seit IP-4 auch Woche und Jahr — die vier Zeiträume von E5', () => {
    expect(periodeAus('2026-W43')).toEqual({ art: 'woche', wert: '2026-W43' });
    expect(periodeAus('2026-W53')).toEqual({ art: 'woche', wert: '2026-W53' });
    expect(periodeAus('2026')).toEqual({ art: 'jahr', wert: '2026' });
  });

  it('alles andere öffnet wie ohne Angabe', () => {
    for (const falsch of [null, undefined, '', '2027-W53', '2026-W00', '2026-W54', '2026-W4', '26', '2026-13', '2026-00', '2026-02-30', '2027-02-29', '2026-10-25T00:00', 'gestern']) {
      expect(periodeAus(falsch), String(falsch)).toBeNull();
    }
  });
});

// ------------------------------------------------------------------ AP-13 IP-6 · warum eine Zahl fehlt (E11 = A, Z4, V8)

const register = ahrenbergRegister();
const zeileVon = (kz: string) => {
  const z = register.register.find((r) => r.kennzeichen === kz);
  if (!z) throw new Error(`keine Zeile ${kz}`);
  return z;
};
const grundBeispiel = (code: string): string => (lies('ergebnis-zustand-vectors.json').grund.saetze as Json[]).find((s) => s.code === code)!.beispiel;
const oberflaechenFall = (id: string): Json =>
  (JSON.parse(readFileSync(resolve(process.cwd(), 'src/test/oberflaechenFaelle.json'), 'utf8')).faelle as Json[]).find((f) => f.id === id);
const OKTOBER = { von: '2026-10-01T00:00:00+02:00', bis: '2026-11-01T00:00:00+01:00' };
const ohneZahl = (t: Partial<MessstelleWerteWert>): Partial<MessstelleWerteWert> => ({ quelle: null, fassung: null, version: null, versionen: null, gebildet_aus: null, ...t });
/** Die Vertragsnamen der Referenz („K-11“) stehen im Register als Name der Komponente („Netzzähler Lindach“). */
const MIT_REGISTERNAMEN = (satz: string) => satz.replace('Netzzähler K-11 (GR-10)', 'Netzzähler Lindach (GR-10)');

describe('uemsWerteKarte — O15 · unter dem Strich der Satz des Grundes, einer je Grund (UEMS AP-13 IP-6, E11 = A)', () => {
  it('die acht Beispiele von O15: jede Karte zeigt „—“ und genau den Satz des Vertrags', () => {
    const g = tagesgrenzen('2026-10-31');
    const ms01 = zeileVon('MS-01');
    const b01 = ms01.quelle.fuehrend!;
    const karten: Record<string, ReturnType<typeof karte>> = {
      // MS-21 Gas Heizung Verwaltung: keine Datenquelle.
      keine_quelle: karte(ohneQuelleTag()),
      // MS-16 Netzbezug Lindach, Oktober 2026 — die Bindung beginnt am 15.10. im Monat.
      quelle_teilweise: karte(ms16Oktober(), quellenNamen(zeileVon('MS-16').quelle)),
      // MS-01 Netzbezug Halle 1, eine Viertelstunde am Vorzeichen-Kanal.
      anteil_nicht_gespeichert: karte(
        {
          ...antwort({ ...MS_06, kennzeichen: 'MS-01', name: 'Netzbezug Halle 1' }, 'viertelstunde', g.von, '2026-10-31T00:15:00+02:00', [
            schritt(ohneZahl({ von: g.von, bis: '2026-10-31T00:15:00+02:00', beschriftung: '00:00–00:15', grund: 'anteil_nicht_gespeichert' })),
          ], false),
          quellen: [{ id: b01.id, komponente: b01.komponente, kanal: b01.kanal, herleitung: 'zaehlerstand', anteil: 'positiv', gueltig_ab: b01.gueltig_ab, gueltig_bis: null }],
        },
        quellenNamen(ms01.quelle),
      ),
      // MS-15 Halle 2 nicht zugeordnet, eine Stunde.
      berechnet: karte(
        antwort({ ...MS_06, kennzeichen: 'MS-15', name: 'Halle 2 nicht zugeordnet', art: 'berechnet' }, 'stunde', g.von, g.bis, [
          schritt(ohneZahl({ von: '2026-10-31T10:00:00+01:00', bis: '2026-10-31T11:00:00+01:00', beschriftung: '10:00–11:00', grund: 'berechnet' })),
        ], false),
      ),
      noch_nicht_gebildet: karte(nochNichtGebildetTag()),
      ohne_menge_gespeichert: karte({ ...f8Tag(), werte: [schritt({ ...tagesgrenzen('2026-11-03'), grund: 'ohne_menge_gespeichert' })] }),
      // MS-12 Montage Linie M1, Oktober 2026 mit ?version=3 — der neueste Stand ist Version 2.
      version_nicht_gespeichert: karte({
        ...antwort({ ...MS_06, kennzeichen: 'MS-12', name: 'Montage Linie M1' }, 'monat', OKTOBER.von, OKTOBER.bis, [
          schritt({ ...OKTOBER, grund: 'version_nicht_gespeichert', fassung: null, version: null, versionen: 2 }),
        ]),
        version: 3,
      }),
      // MS-12, Stunde 10:00–11:00 am 31.10.2026 mit ?version=1.
      version_nicht_gebildet: karte({
        ...antwort({ ...MS_06, kennzeichen: 'MS-12', name: 'Montage Linie M1' }, 'stunde', g.von, g.bis, [
          schritt({ von: '2026-10-31T10:00:00+01:00', bis: '2026-10-31T11:00:00+01:00', beschriftung: '10:00–11:00', grund: 'version_nicht_gebildet', version: null, versionen: null }),
        ]),
        version: 1,
      }),
    };
    const codes = (lies('ergebnis-zustand-vectors.json').grund.saetze as Json[]).map((s) => s.code);
    expect(Object.keys(karten)).toEqual(codes);
    for (const code of codes) {
      const k = karten[code]!;
      expect(k.zahl, code).toBe(OHNE_ZAHL);
      expect(k.grund, code).toBe(code === 'quelle_teilweise' ? MIT_REGISTERNAMEN(grundBeispiel(code)) : code === 'anteil_nicht_gespeichert'
        ? 'Die Quelle liest nur den positiven Anteil von Wirkenergie Bezug (Netzzähler Halle 1); eine Menge je Anteil ist nicht gespeichert.'
        : grundBeispiel(code));
    }
    // Der Satz der Tageskarte (Captain 15.09.2026) und der des Vertrags sind derselbe.
    expect(karten.noch_nicht_gebildet!.grund).toBe(UEMS_NOCH_NICHT_GERECHNET_SATZ);
  });

  it('kein Satz ohne seinen Namen (D5): ohne das Register bleibt `quelle_teilweise` und `anteil_nicht_gespeichert` beim Strich', () => {
    expect(karte(ms16Oktober())).toMatchObject({ zahl: OHNE_ZAHL, grund: null });
    // Eine Bindung, die nicht im Zeitraum BEGINNT (sie endet nur), trägt keinen „gilt seit“-Satz.
    const endet = ms16Oktober();
    endet.quellen = [{ ...endet.quellen[0], gueltig_ab: '2024-03-12T00:00:00+01:00', gueltig_bis: '2026-10-15T00:00:00+02:00' }];
    expect(karte(endet, quellenNamen(zeileVon('MS-16').quelle))!.grund).toBeNull();
    // Die Version ohne die Zahl der Versionen: kein Satz mit „undefined“.
    const ohneVersionen = { ...ms16Oktober(), version: 3 };
    ohneVersionen.werte = [{ ...ohneVersionen.werte[0], grund: 'version_nicht_gespeichert' as const, versionen: null }];
    expect(karte(ohneVersionen)!.grund).toBeNull();
  });

  it('der Satz steht nur unter dem Strich — nie unter einer Zahl, nie ohne Grund', () => {
    expect(karte(normalTag())!.grund).toBeNull();
    const widerspruch = f8Tag();
    widerspruch.werte = [{ ...widerspruch.werte[0], grund: 'keine_quelle' }];
    expect(karte(widerspruch)).toMatchObject({ grund: null });
    expect(karte(widerspruch)!.zahl).not.toBe(OHNE_ZAHL);
  });

  it('O16 · MS-16 im Oktober 2026 (W5): „—“ mit dem Satz der Route, darunter 17 vollständige Tage ab 15.10. — die Fläche summiert nichts', () => {
    const o16 = oberflaechenFall('O16').erwartet;
    const k = karte(ms16Oktober(), quellenNamen(zeileVon('MS-16').quelle))!;
    expect(ms16Oktober().quellen.map((q) => q.id)).toEqual([MS16_BINDUNG]);
    expect(zeileVon('MS-16').quelle.fuehrend!.id).toBe(MS16_BINDUNG);
    expect([k.zahl, k.zustand, k.abdeckung, k.fassung]).toEqual([OHNE_ZAHL, null, null, null]);
    expect(`${k.zahl} · ${k.grund}`).toBe(MIT_REGISTERNAMEN(o16.karte_heute));
    const tage = liste(ms16OktoberTage());
    expect(tage).toHaveLength(31);
    expect(tage.filter((z) => z.zustand === 'vollständig')).toHaveLength(o16.tage_darunter);
    expect(tage.slice(0, 14).every((z) => z.zahl === OHNE_ZAHL && z.zustand === KEINE_WERTE)).toBe(true);
    expect(o16.flaeche_summiert).toBe(false);
    expect(k.zahl).not.toMatch(/9[.\s]?100/);
  });
});

describe('uemsWerteKarte — Z4 · Werte ohne Datenquelle und ihr nächster Schritt (UEMS AP-13 IP-6)', () => {
  it('der ganze Zeitraum ohne Bindung: Titel „Keine Datenquelle“ und der Satz des Grundes; eine Bindung im Zeitraum: kein Leerzustand', () => {
    expect(ohneQuelle(ohneQuelleStunden())).toEqual({ titel: 'Keine Datenquelle', satz: grundBeispiel('keine_quelle') });
    expect(ohneQuelle(ohneQuelleTag())).not.toBeNull();
    // Lindach im Oktober: 14 Tage ohne Quelle, aber die Bindung berührt den Monat — die Tage sprechen selbst.
    expect(ohneQuelle(ms16OktoberTage())).toBeNull();
    expect(ohneQuelle(normalTag())).toBeNull();
    expect(ohneQuelle(null)).toBeNull();
  });

  it('MS-21 heute ohne Datenquelle: „Quelle zuordnen“ nur mit Recht, sonst der Satz, wer es kann — nie „Ablesung eintragen“', () => {
    const q = zeileVon('MS-21').quelle;
    expect(q.stand).toBe('keine_datenquelle');
    expect(ohneQuelleWeg(q, '2026-10-19', '2026-10-20', true)).toEqual({ art: 'zuordnen', knopf: 'Quelle zuordnen' });
    expect(ohneQuelleWeg(q, '2026-10-19', '2026-10-20', false)).toEqual({
      art: 'hinweis',
      satz: 'Eine Datenquelle ordnet zu, wer diese Messstelle bearbeiten darf.',
    });
    expect(JSON.stringify([ohneQuelleWeg(q, '2026-10-19', '2026-10-20', true), ohneQuelleWeg(q, '2026-10-19', '2026-10-20', false)])).not.toMatch(/Ablesung/);
  });

  it('MS-16 im September 2026: die Quelle beginnt NACH dem Zeitraum — der Satz nennt sie, der Knopf blättert zum 15.10.2026', () => {
    const q = zeileVon('MS-16').quelle;
    expect(ohneQuelleWeg(q, '2026-09-30', '2026-10-20', true)).toEqual({
      art: 'ab',
      tag: '2026-10-15',
      satz: 'Netzzähler Lindach (GR-10) gilt seit 15.10.2026 — ab dann stehen hier Werte.',
      knopf: 'Ab 15.10.2026 zeigen',
    });
    // Vor ihrem ersten Tag: der Satz „gilt ab“, kein Knopf in einen Zeitraum ohne Werte.
    expect(ohneQuelleWeg(q, '2026-09-30', '2026-10-10', true)).toMatchObject({
      satz: 'Netzzähler Lindach (GR-10) gilt ab 15.10.2026 — ab dann stehen hier Werte.',
      knopf: null,
    });
    // Beginnt die Quelle im Zeitraum, widerspricht das Register dem Leerzustand — dann kein Schritt.
    expect(ohneQuelleWeg(q, '2026-10-31', '2026-10-20', true)).toBeNull();
    expect(ohneQuelleWeg(zeileVon('MS-22').quelle, '2026-09-30', '2026-10-20', true)).toBeNull();
    expect(ohneQuelleWeg(null, '2026-09-30', '2026-10-20', true)).toBeNull();
  });
});

describe('uemsWerteKarte — V8 · Nebengrößen: der letzte Wert aus dem Register (UEMS AP-13 IP-6)', () => {
  it('die Wirkleistung im Wortlaut des Registers; der Satz nennt die Hauptgröße; ohne Nebenwert keine Zeile', () => {
    const haupt = { groesse: 'Wirkenergie', richtung: 'Bezug' };
    expect(nebengroessen({ nebenwerte: [{ groesse: 'Wirkleistung', text: `148,6${NB}kW`, zeit: '10:15 Uhr' }] }, haupt)).toEqual({
      titel: 'Weitere Größen',
      zeilen: [`Wirkleistung 148,6${NB}kW · 10:15 Uhr`],
      satz: 'Letzter Wert aus der Box — Werte und Verlauf gibt es hier nur für Wirkenergie Bezug.',
    });
    expect(nebengroessen({ nebenwerte: [{ groesse: 'Ladestand', text: `62${NB}%`, zeit: '10:15 Uhr' }] }, { groesse: 'Ladestand', richtung: 'richtungslos' })!.satz).toBe(
      'Letzter Wert aus der Box — Werte und Verlauf gibt es hier nur für Ladestand.',
    );
    expect(nebengroessen({ nebenwerte: [] }, haupt)).toBeNull();
    expect(nebengroessen(null, haupt)).toBeNull();
  });
});
