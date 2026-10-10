import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MessstelleWerteEntscheidung, MessstelleWerteWert } from './api';
import {
  BEGRUENDUNG,
  BESSER,
  EW_A,
  EW_C,
  F10_VORSCHLAG,
  K_F10,
  WIDERRUF,
  f10Historie,
  f10Tag,
  f10TagWert,
  f21Historie,
  f21Stunden,
  f21Tag,
  f21TagWert,
} from './test/wertVersionenFixtures';
import { f8Tag, normalTag, ohneQuelleTag, schritt } from './test/werteKarteFixtures';
import { menge, pruefe, type Ergebnis } from './uemsErgebnis';
import {
  FASSUNG_FEHLT,
  GILT_JETZT,
  KEINE_HISTORIE,
  OHNE_ENTSCHEIDUNG,
  OHNE_GRUND,
  OHNE_GRUND_FREIGABE,
  ORIGINAL,
  einstieg,
  entscheidung,
  hatHistorie,
  historie,
} from './uemsWertVersionen';
import { liste } from './uemsWerteKarte';

/**
 * Versionen am Wert (UEMS AP-08 IP-18) — die reine Ableitung gegen die Fälle
 * F21 (drei Versionen, zwei Entscheidungen in einer) und F10 (Freigabe ohne
 * Grund, System-Vorschlag). Die Zahlen der Antworten sind die Erwartungen von
 * `verbrauch-vectors.json` (hier gegengeprüft), der Satz des Vorschlags der von
 * `korrektur-vorschlag-vectors.json`.
 */

type Json = any;

const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const lies = (datei: string): Json => JSON.parse(readFileSync(resolve(V2, datei), 'utf8'));
const verbrauch = lies('verbrauch-vectors.json');
const vorschlag = lies('korrektur-vorschlag-vectors.json');

const ZONE = 'Europe/Berlin';
const kwh = (wert: number) => menge(wert, 'kWh', 'tag');

const ersatzwertErwartung = (block: string, name: string): Json => {
  const b = (verbrauch.ersatzwerte as Json[]).find((x) => x.name.startsWith(block));
  const e = (b?.expected as Json[] | undefined)?.find((x) => x.name === name);
  if (!e) throw new Error(`keine Erwartung ${block} · ${name}`);
  return e;
};

/** Der Wert trägt die Zahlen der Erwartung — sonst prüfte der Test eine erfundene Welt. */
const gleichDerErwartung = (w: MessstelleWerteWert, e: Json) => {
  expect([w.von, w.bis], e.name).toEqual([e.von, e.bis]);
  expect([w.menge, w.zustand, w.version], e.name).toEqual([e.menge, e.zustand, e.version]);
  expect([w.erhalten, w.erwartet, w.abdeckung_prozent], e.name).toEqual([e.erhalten, e.erwartet, e.abdeckung_prozent]);
  expect(w.kennzeichen, e.name).toEqual(e.kennzeichen);
  const ergebnis: Ergebnis = {
    wert: w.menge,
    einheit: 'kWh',
    ebene: 'tag',
    zustand: w.zustand!,
    abdeckungProzent: w.abdeckung_prozent,
    kennzeichen: w.kennzeichen,
  };
  expect(pruefe(ergebnis), e.name).toEqual([]);
};

/** Alle Texte einer Historie — für die Wächter über das ganze Bild. */
const texte = (x: unknown): string[] =>
  typeof x === 'string' ? [x] : x && typeof x === 'object' ? Object.values(x).flatMap(texte) : [];

describe('Versionen am Wert · die Fixtures sind die Fälle des Vertrags', () => {
  it('F21: Version 1, 2 und 3 des 03.11. tragen die Zahlen von verbrauch-vectors.json', () => {
    // Version 1 ist der Bestand von F11 (die Lücke des Box-Tauschs), auf dem F21 aufbaut.
    const v1 = (verbrauch.cases as Json[])
      .find((c) => c.name.startsWith('f11-'))
      .expected.find((x: Json) => x.name === 'Tag 03.11.2026 (Version 1)');
    gleichDerErwartung(f21TagWert(1), v1);
    gleichDerErwartung(f21TagWert(2), ersatzwertErwartung('F11 · EW-2026-0003', 'Tag 03.11.2026 (Version 2)'));
    gleichDerErwartung(f21TagWert(3), ersatzwertErwartung('F21 · Widerruf und EW-2026-0005', 'Tag 03.11.2026 (Version 3)'));
  });

  it('F10: der Satz des System-Vorschlags ist der des Vertrags', () => {
    const fall = (vorschlag.cases as Json[]).find((c) => c.name === 'f10-nachlieferung-k-2026-0007');
    expect(F10_VORSCHLAG).toBe(fall.satz);
  });
});

describe('Versionen am Wert · der Einstieg an der Karte', () => {
  it('ab zwei Versionen: „3 Versionen“, gefragt mit von und bis des Schritts — unverändert', () => {
    const e = einstieg(f21Tag());
    expect(e?.text).toBe('3 Versionen');
    expect(e?.anfrage).toEqual({ raster: 'tag', von: '2026-11-03T00:00:00+01:00', bis: '2026-11-04T00:00:00+01:00' });
    expect(einstieg(f10Tag())?.text).toBe('2 Versionen');
  });

  it('bei einer Version, ohne Zahl der Versionen und an der Stunde wird gar nicht gefragt', () => {
    expect(einstieg(normalTag())).toBeNull();
    expect(einstieg(f8Tag())).toBeNull();
    expect(einstieg(ohneQuelleTag())).toBeNull();
    expect(einstieg(f21Stunden())).toBeNull();
    expect(hatHistorie(null)).toBe(false);
    expect(hatHistorie(0)).toBe(false);
    expect(hatHistorie(1)).toBe(false);
    expect(hatHistorie(2)).toBe(true);
  });

  it('eine Stunde ohne eigene Version bleibt in der Liste ein Strich, ohne Wort', () => {
    const zeilen = liste(f21Stunden());
    expect(zeilen[13].zahl).toBe(menge(96.0, 'kWh', 'stunde'));
    for (const z of zeilen.slice(14)) {
      expect([z.zahl, z.zustand, z.abdeckung, z.kennzeichen]).toEqual(['—', null, null, []]);
    }
  });
});

describe('Versionen am Wert · F21: drei Versionen, der Widerruf und die bessere Methode', () => {
  const h = historie(f21Historie());

  it('neueste zuerst: Version 3 gilt jetzt, Version 1 ist das Original', () => {
    expect(h.leer).toBeNull();
    expect(h.versionen.map((v) => [v.titel, v.etikett])).toEqual([
      ['Version 3', GILT_JETZT],
      ['Version 2', null],
      ['Version 1', ORIGINAL],
    ]);
  });

  it('je Version wert_alt nach wert_neu — die Zahl über menge, nie selbst formatiert', () => {
    const [v3, v2, v1] = h.versionen;
    expect(v3.vorher?.zahl).toBe(kwh(2304.0));
    expect(v3.danach.zahl).toBe(kwh(2354.4));
    expect(v3.danach.zahl).toBe('2.354 kWh');
    expect(v2.vorher).toEqual({ zahl: kwh(1344.0), info: 'unvollständig · Verlauf 58 %', ton: 'warn' });
    expect(v2.danach).toEqual({ zahl: kwh(2304.0), info: 'mit Ersatzwert · Verlauf 58 %', ton: 'warn' });
    // Version 1 hat nichts davor.
    expect(v1.vorher).toBeNull();
    expect(v1.danach.zahl).toBe(kwh(1344.0));
  });

  it('die erste Version ist der Anfang: gebildet, ohne Entscheidung, nie „geändert“', () => {
    const v1 = h.versionen[2];
    expect(v1.entscheidungen).toEqual([]);
    expect(v1.ohneEntscheidung).toBeNull();
    expect(v1.gebildet).toBe('gebildet am 04.11.2026 00:15');
  });

  it('Version 2: der Ersatzwert ist „eingetragen von“ — wer, wann in der Zone des Standorts, warum in ihren Worten', () => {
    expect(h.versionen[1].entscheidungen).toEqual([
      {
        schluessel: `${EW_A}|1`,
        vorgang: `Ersatzwert ${EW_A}`,
        fassung: {
          wer: 'eingetragen von Ines Kaltenbach',
          wann: '06.11.2026 11:20',
          warum: `„${BEGRUENDUNG}“`,
          warumFehlt: false,
          beleg: null,
        },
        was: 'Methode „Zuwachs gleichmäßig verteilen“',
        angelegt: null,
        fehlt: null,
      },
    ]);
  });

  it('Version 3: ZWEI Entscheidungen in ihrer Reihenfolge — die Rücknahme nennt, wie der Ersatzwert angefangen hat', () => {
    const [widerruf, besser] = h.versionen[0].entscheidungen;
    expect(widerruf.vorgang).toBe(`Ersatzwert ${EW_A}`);
    expect(widerruf.fassung).toMatchObject({ wer: 'zurückgenommen von Ines Kaltenbach', wann: '20.11.2026 15:10', warum: `„${WIDERRUF}“` });
    expect(widerruf.angelegt).toEqual({
      wer: 'eingetragen von Ines Kaltenbach',
      wann: '06.11.2026 11:20',
      warum: `„${BEGRUENDUNG}“`,
      warumFehlt: false,
      beleg: null,
    });
    expect(besser.vorgang).toBe(`Ersatzwert ${EW_C}`);
    expect(besser.fassung).toMatchObject({ wer: 'eingetragen von Ines Kaltenbach', wann: '20.11.2026 15:12', warum: `„${BESSER}“` });
    expect(besser.was).toBe('Methode „Zuwachs nach dem Profil der Vergleichsquelle verteilen“');
    expect(besser.angelegt).toBeNull();
  });

  it('kein Text der Historie sagt „geändert“, und keiner nennt ein Vertragswort', () => {
    const alle = texte(h);
    expect(alle.filter((t) => /geändert/i.test(t))).toEqual([]);
    expect(alle.filter((t) => /gleichmaessig|profil_|zurueckgenommen|wirksam|ersatzwert\b/.test(t))).toEqual([]);
  });
});

describe('Versionen am Wert · F10: ein System-Vorschlag, freigegeben ohne Grund', () => {
  const h = historie(f10Historie());

  it('Menge gleich, Verlauf von 85 auf 100 % — beides steht da', () => {
    const v2 = h.versionen[0];
    expect(v2.vorher).toEqual({ zahl: kwh(2304.0), info: 'vollständig · Verlauf 85 %', ton: 'ok' });
    expect(v2.danach).toEqual({ zahl: kwh(2304.0), info: 'vollständig · Verlauf 100 %', ton: 'ok' });
    expect(f10TagWert(2).kennzeichen).toEqual(['korrigiert (Version 2)']);
  });

  it('das fehlende „warum“ ist ein ehrlicher Satz, nie die Art, der Status oder der Vorschlags-Satz', () => {
    const [freigabe] = h.versionen[0].entscheidungen;
    expect(freigabe.vorgang).toBe(`Korrektur ${K_F10}`);
    expect(freigabe.was).toBe('Nachlieferung nach Endgültigkeit');
    expect(freigabe.fassung).toEqual({
      wer: 'freigegeben von Jonas Wendlinger',
      wann: '12.11.2026 10:15',
      warum: OHNE_GRUND_FREIGABE,
      warumFehlt: true,
      beleg: null,
    });
  });

  it('die anlegende Fassung ist „vorgeschlagen von VoltPilot“ mit dem Satz des Vorschlags', () => {
    const [freigabe] = h.versionen[0].entscheidungen;
    expect(freigabe.angelegt).toEqual({
      wer: 'vorgeschlagen von VoltPilot',
      wann: '12.11.2026 09:02',
      warum: `„${F10_VORSCHLAG}“`,
      warumFehlt: false,
      beleg: null,
    });
  });
});

describe('Versionen am Wert · die Ränder', () => {
  const basis: MessstelleWerteEntscheidung = {
    vorgang: 'korrektur',
    kennung: 'K-2026-0009',
    fassung: 1,
    status: 'vorschlag',
    methode: null,
    art: 'wert_berichtigt',
    wer: { name: 'Ines Kaltenbach', rolle: 'energiemanager', art: 'kunde' },
    wann: '2027-03-28T03:30:00+02:00',
    warum: null,
    beleg: 'Ablesebeleg 28.03.',
    fehlt: ['warum'],
    angelegt: null,
  };

  it('eine Korrektur fängt als Vorschlag an; ohne Grund sagt es der Satz, der Beleg steht daneben', () => {
    const e = entscheidung(basis, ZONE);
    expect(e.fassung).toEqual({
      wer: 'vorgeschlagen von Ines Kaltenbach',
      wann: '28.03.2027 03:30',
      warum: OHNE_GRUND,
      warumFehlt: true,
      beleg: 'Beleg: Ablesebeleg 28.03.',
    });
    expect(e.was).toBe('Wert berichtigt (mit Beleg)');
  });

  it('abgelehnt und zurückgenommen sprechen ihr Wort; die anlegende Fassung ohne Grund sagt es auch', () => {
    const angelegt = { wer: basis.wer!, wann: '2027-03-28T03:30:00+02:00', warum: null, beleg: null };
    expect(entscheidung({ ...basis, fassung: 2, status: 'abgelehnt', warum: 'Beleg passt nicht', fehlt: [], angelegt }, ZONE).fassung?.wer).toBe(
      'abgelehnt von Ines Kaltenbach',
    );
    const zurueck = entscheidung({ ...basis, fassung: 3, status: 'zurueckgenommen', warum: 'doppelt', fehlt: [], angelegt }, ZONE);
    expect(zurueck.fassung?.wer).toBe('zurückgenommen von Ines Kaltenbach');
    expect(zurueck.angelegt).toMatchObject({ wer: 'vorgeschlagen von Ines Kaltenbach', warum: OHNE_GRUND, warumFehlt: true });
  });

  it('eine nicht gespeicherte Fassung erfindet weder wer noch warum', () => {
    const e = entscheidung({ ...basis, fassung: 2, status: null, art: null, wer: null, wann: null, beleg: null, fehlt: ['fassung'] }, ZONE);
    expect(e).toEqual({ schluessel: 'K-2026-0009|2', vorgang: 'Korrektur K-2026-0009', fassung: null, was: null, angelegt: null, fehlt: FASSUNG_FEHLT });
  });

  it('eine spätere Version ohne Entscheidung sagt das; eine Historie ohne Versionen ebenso', () => {
    const f = f21Historie();
    f.versionen[1].entscheidungen = [];
    expect(historie(f).versionen[1].ohneEntscheidung).toBe(OHNE_ENTSCHEIDUNG);
    expect(historie({ ...f21Historie(), grund: 'keine_quelle', versionen: [] })).toEqual({ versionen: [], leer: KEINE_HISTORIE });
  });

  it('eine Version ohne Zahl ist ein Strich ohne Wort — nie 0', () => {
    const f = f21Historie();
    f.versionen[0].wert_neu = schritt({ ...f.versionen[0].wert_neu, menge: null, zustand: null, grund: 'noch_nicht_gebildet' });
    const v1 = historie(f).versionen[2];
    expect(v1.danach).toEqual({ zahl: '—', info: null, ton: 'off' });
  });
});
