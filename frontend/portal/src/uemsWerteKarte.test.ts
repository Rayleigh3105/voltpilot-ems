import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MessstelleWerte } from './api';
import {
  F8_LUECKE,
  ANFANG_NICHT_GEMESSEN,
  f13Stunden,
  f13Tag,
  f14Stunden,
  f14Tag,
  f16Monat,
  f16Tage,
  f8Stunden,
  f8Tag,
  normalStunden,
  normalTag,
  ohneQuelleStunden,
  ohneQuelleTag,
  schritt,
} from './test/werteKarteFixtures';
import { OHNE_ZAHL, TRENNER, ZUSTAENDE, fassung, satz, tagesdauer } from './uemsErgebnis';
import { anfragen, karte, liste, monatTitel, tagTitel } from './uemsWerteKarte';

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

  it('ein Schritt ohne Zustand (noch nicht gebildet) spricht nichts — nur den Strich', () => {
    const a = f8Tag();
    a.werte = [schritt({ von: a.werte[0].von, bis: a.werte[0].bis, grund: 'noch_nicht_gebildet', quelle: null })];
    expect(karte(a)).toMatchObject({ zahl: OHNE_ZAHL, zustand: null, abdeckung: null, kennzeichen: [] });
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
