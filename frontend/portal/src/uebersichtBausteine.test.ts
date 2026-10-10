import { describe, expect, it } from 'vitest';
import type { Bilanz } from './api';
import { UEMS_NOCH_NICHT_GERECHNET_SATZ } from './glossar';
import { standortBereichRoute, standortMessstellenRoute } from './nav';
import { GELD_BAUSTEINE, UEMS_UEBERSICHT_BAUSTEINE } from './portfolioCockpit';
import { ahrenbergBilanz } from './test/bilanzFixtures';
import { kennzahlenDerWelt } from './test/kennzahlWerteFixtures';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import faelle from './test/oberflaechenFaelle.json';
import { FIXTURE_IDS, werkAhrenberg, werkLindach } from './test/standorteFixtures';
import type { UebersichtEbene } from './uebersicht';
import {
  bausteineMitInhalt,
  blaettere,
  energiebilanzBaustein,
  gebaeudeZeilen,
  kennzahlenDerEbene,
  laeuftNoch,
  letzterGebildeter,
  messstellenBaustein,
  zeitraumText,
  type AnlageBilanz,
  type GebaeudeEingang,
} from './uebersichtBausteine';

/**
 * Die Übersichts-Bausteine je Ebene (UEMS AP-13 IP-7, E3 = A, E13 = A, Ü1–Ü5) gegen die Referenzfälle O2
 * (Unternehmens-Übersicht Ahrenberg, Oktober 2026) und O3 (Standort-Übersicht Werk Lindach, 18.10.2026) aus
 * `test/oberflaechenFaelle.json`. Die Zahlen schreibt die Anzeige mit Tausenderpunkt (E11, `uemsErgebnis.zahl`) —
 * der Fall mit schmalem Leerzeichen; verglichen wird die Zahl, nicht ihre Schreibweise.
 */

const NBSP = String.fromCharCode(160);
const eben = (s: string | null | undefined) => (s ?? '').split(NBSP).join(' ');
const ziffern = (s: string) => Number((/[\d.]+(?= kWh)/.exec(eben(s))?.[0] ?? 'NaN').split('.').join(''));
type Fall = { id: string; gegeben: Record<string, unknown>; erwartet: Record<string, unknown> };
const fall = (id: string) => (faelle as unknown as { faelle: Fall[] }).faelle.find((f) => f.id === id)!;
const O2 = fall('O2');
const O3 = fall('O3');

const { an1, an2, an3, st1, st2 } = FIXTURE_IDS;
const NAMEN: Record<string, string> = { [an1]: 'Werk Ahrenberg – Halle 1', [an2]: 'Werk Ahrenberg – Halle 2', [an3]: 'Werk Lindach' };
const UNTERNEHMEN: UebersichtEbene = { art: 'unternehmen', name: 'Kunststoffwerk Ahrenberg GmbH', standorte: [werkAhrenberg(), werkLindach()] };
const LINDACH: UebersichtEbene = { art: 'standort', standort: werkLindach() };
const AHRENBERG: UebersichtEbene = { art: 'standort', standort: werkAhrenberg() };

const bilanzen = (ids: string[], periode: Bilanz['periode'], am: string): AnlageBilanz[] =>
  ids.map((id) => ({ anlage: { id, name: NAMEN[id] }, bilanz: ahrenbergBilanz(id, periode, am) }));

const gebaeude = (orte: { id: string; kurzzeichen: string; name: string }[], stichtag: string): GebaeudeEingang[] =>
  orte.map((g) => ({
    ...g,
    heute: ahrenbergRegister({ ort: g.kurzzeichen }),
    imZeitraum: ahrenbergRegister({ ort: g.kurzzeichen, stichtag }).register.map((z) => z.kennzeichen),
  }));

describe('O2 · Unternehmens-Übersicht Ahrenberg, Oktober 2026 (gelesen am 10.11.2026)', () => {
  const heute = '2026-11-10';
  const am = letzterGebildeter('monat', heute);

  it('die Zeit-Leiste steht auf dem letzten gebildeten Monat: Oktober 2026 (Ü3)', () => {
    expect(am).toBe('2026-10-01');
    expect(zeitraumText('monat', am)).toBe('Oktober 2026');
    expect(laeuftNoch('monat', am, heute)).toBe(false);
    expect(laeuftNoch('monat', blaettere('monat', am, 1), heute)).toBe(true);
  });

  it('Messstellen: die Zeile je Standort IST die Zeile des Registers — Werk Ahrenberg „15 von 16“, keine dritte Zählung (E13)', () => {
    const register = ahrenbergRegister();
    const zeilen = messstellenBaustein(UNTERNEHMEN, register)!;
    expect(zeilen.map((z) => [z.name, z.text])).toEqual([
      [null, register.aggregat.unternehmen.text],
      ['Werk Ahrenberg', O2.erwartet.datenlage_st1],
      ['Werk Lindach', register.aggregat.standorte.find((s) => s.id === st2)!.text],
    ]);
    expect(zeilen[0].text).toBe((O2.gegeben.register_unternehmen as { text: string }).text);
    // Befund an O2: das Register leitet den Standort einer Zeile aus ihrem ORT ab — MS-22 („Lindach nicht
    // zugeordnet“, Ort keiner) zählt dort nicht, also „3 von 3“ statt der Annahme „4 von 4“. Der Baustein spricht,
    // was das Register sagt.
    expect(zeilen[2].text).toBe('3 von 3 Messstellen liefern Daten');
    expect(zeilen[1].ziel).toEqual(standortMessstellenRoute(st1));
    expect(zeilen[2].ziel).toEqual(standortMessstellenRoute(st2));
  });

  it('Energiebilanz: Netzbezug 174 400 kWh · 3 von 3 Systemen · Lindach ab 15.10.2026, Werk Ahrenberg 165 300 kWh · 2 von 2 (AP-10 E9)', () => {
    const bild = energiebilanzBaustein({ ebene: UNTERNEHMEN, periode: 'monat', am, heute, anlagen: bilanzen([an1, an2, an3], 'monat', am) })!;
    expect(eben(bild.summe!.text)).toBe('174.400 kWh · 3 von 3 Systemen · Werk Lindach ab 15.10.2026');
    expect(ziffern(bild.summe!.text)).toBe(O2.gegeben.summe_unternehmen_kwh);
    const ahrenberg = bild.gruppen.find((g) => g.key === st1)!;
    expect(eben(ahrenberg.summe!.text)).toBe('165.300 kWh · 2 von 2 Systemen');
    expect(ziffern(ahrenberg.summe!.text)).toBe(O2.gegeben.summe_st1_kwh);
    expect(bild.gruppen.map((g) => g.name)).toEqual(['Werk Ahrenberg', 'Werk Lindach']);
    expect(eben(bild.gruppen[1].summe!.text)).toBe('9.100 kWh · 1 von 1 System');
    expect(bild.gruppen[0].systeme.map((s) => [s.name, eben(s.zahl)])).toEqual([
      ['Werk Ahrenberg – Halle 1', '128.400 kWh'],
      ['Werk Ahrenberg – Halle 2', '36.900 kWh'],
    ]);
    // Kein eigener Rest auf der Ebene: der Satz nennt nie „nicht zugeordnet“.
    expect(JSON.stringify(bild)).not.toContain('zugeordnet');
  });

  it('fehlt ein System, heißt die Summe „mindestens …“ und nennt es — nie still weniger', () => {
    const ohneLindach = bilanzen([an1, an2, an3], 'monat', am).map((a) => (a.anlage.id === an3 ? { ...a, bilanz: null } : a));
    const bild = energiebilanzBaustein({ ebene: UNTERNEHMEN, periode: 'monat', am, heute, anlagen: ohneLindach })!;
    expect(eben(bild.summe!.text)).toBe('mindestens 165.300 kWh · 2 von 3 Systemen (Werk Lindach fehlt)');
    expect(bild.summe!.ton).toBe('warn');
  });

  it('eine Anlage ohne Hauptzähler ist kein System — sie fehlt nicht, sie zählt nicht', () => {
    const mitFremder = [...bilanzen([an1, an2, an3], 'monat', am), { anlage: { id: 'x', name: 'Ohne Zähler' }, bilanz: ahrenbergBilanz('x', 'monat', am) }];
    const bild = energiebilanzBaustein({ ebene: UNTERNEHMEN, periode: 'monat', am, heute, anlagen: mitFremder })!;
    expect(eben(bild.summe!.text)).toContain('3 von 3 Systemen');
  });

  it('der laufende Monat hat keine Zahl, nur den Grund-Satz (E11)', () => {
    const november = blaettere('monat', am, 1);
    const bild = energiebilanzBaustein({ ebene: UNTERNEHMEN, periode: 'monat', am: november, heute, anlagen: bilanzen([an1, an2, an3], 'monat', november) })!;
    expect(bild.summe).toBeNull();
    expect(bild.hinweis).toBe(UEMS_NOCH_NICHT_GERECHNET_SATZ);
  });

  it('Kennzahlen: fünf Karten mit Geltung im Unternehmen (AP-11)', () => {
    // Die Welt der Bühne trägt fünf lebende Kennzahlen (AP-11 IP-13) — dieselbe Zahl wie O2.
    expect(kennzahlenDerEbene(UNTERNEHMEN, kennzahlenDerWelt())).toHaveLength(O2.erwartet.kennzahlen_karten as number);
  });

  it('kein Geld-Baustein aus AP-13 (Ü5)', () => {
    for (const id of UEMS_UEBERSICHT_BAUSTEINE) expect(GELD_BAUSTEINE).not.toContain(id);
    const bild = energiebilanzBaustein({ ebene: UNTERNEHMEN, periode: 'monat', am, heute, anlagen: bilanzen([an1, an2, an3], 'monat', am) });
    expect(JSON.stringify(bild)).not.toMatch(/€|EUR|Erlös|Vorteil/);
    expect(O2.erwartet.geld_bausteine).toBe(0);
  });
});

describe('O3 · Standort-Übersicht Werk Lindach am 18.10.2026', () => {
  const heute = '2026-10-19';
  const am = letzterGebildeter('tag', heute);
  const orte = [
    { id: 'g4', kurzzeichen: 'G-4', name: 'Lagerhalle Lindach' },
    { id: 'g5', kurzzeichen: 'G-5', name: 'Montagehalle Lindach' },
  ];

  it('Tag: der letzte gebildete ist gestern, der 18.10.2026', () => {
    expect(am).toBe(O3.gegeben.tag);
    expect(zeitraumText('tag', am)).toBe('18.10.2026');
  });

  it('Energiebilanz: Netzbezug 100 kWh · 1 von 1 System — kein „nicht zugeordnet“ auf dem Standort', () => {
    const bild = energiebilanzBaustein({ ebene: LINDACH, periode: 'tag', am, heute, anlagen: bilanzen([an3], 'tag', am) })!;
    expect(`Netzbezug ${eben(bild.summe!.text)}`).toBe(O3.erwartet.energiebilanz);
    expect(JSON.stringify(bild)).not.toContain('zugeordnet');
    expect(bild.gruppen[0].systeme[0].ziel).toEqual({ page: 'anlagen', siteId: an3, sub: 'energiebilanz' });
  });

  it('Gebäude-Zeilen: Lagerhalle 60 kWh, Montagehalle 30 kWh (je 1 Messstelle) — der Rest 10 kWh bleibt an der Anlage (Ü4)', () => {
    const zeilen = gebaeudeZeilen({ standortId: st2, periode: 'tag', am, heute, anlagen: bilanzen([an3], 'tag', am), gebaeude: gebaeude(orte, am) });
    const soll = O3.erwartet.gebaeude_zeilen as Record<string, string>;
    expect(zeilen.map((z) => eben(z.gemessen))).toEqual([soll['G-4'], soll['G-5']]);
    expect(zeilen.map((z) => z.datenlage)).toEqual(['1 von 1 Messstelle liefert Daten', '1 von 1 Messstelle liefert Daten']);
    expect(zeilen.every((z) => JSON.stringify(z.ziel) === JSON.stringify(standortBereichRoute(st2, 'gebaeude')))).toBe(true);
    expect(JSON.stringify(zeilen)).not.toContain('10');
  });

  it('Messstellen: die Zeile des Registers für Werk Lindach (Befund 3 von 3 statt 4 von 4, siehe O2)', () => {
    expect(messstellenBaustein(LINDACH, ahrenbergRegister())!.map((z) => z.text)).toEqual(['3 von 3 Messstellen liefern Daten']);
    expect(O3.erwartet.datenlage).toBe('4 von 4 Messstellen liefern Daten');
  });

  it('kein Kennzahlen-Baustein: am 18.10.2026 hat Werk Lindach noch keine Kennzahl — der Baustein erscheint nie leer', () => {
    expect(kennzahlenDerEbene(LINDACH, [])).toBeNull();
    expect(O3.erwartet.kennzahlen_baustein).toBeNull();
    const zeilen = gebaeudeZeilen({ standortId: st2, periode: 'tag', am, heute, anlagen: bilanzen([an3], 'tag', am), gebaeude: gebaeude(orte, am) });
    const energie = energiebilanzBaustein({ ebene: LINDACH, periode: 'tag', am, heute, anlagen: bilanzen([an3], 'tag', am) });
    expect(bausteineMitInhalt({ messstellen: messstellenBaustein(LINDACH, ahrenbergRegister()), energiebilanz: energie, gebaeude: zeilen, kennzahlen: null })).toEqual([
      'messstellen',
      'energiebilanz',
    ]);
  });
});

describe('O4-Gegenprobe · Werk Ahrenberg im Oktober: Halle 2 gemessen im Gebäude 32 000 kWh (3 Messstellen)', () => {
  it('die Gebäude-Zeile rechnet über den Zwilling `gebaeude`, MS-14 (Außenfläche) zählt nicht mit', () => {
    const zeilen = gebaeudeZeilen({
      standortId: st1,
      periode: 'monat',
      am: '2026-10-01',
      heute: '2026-11-10',
      anlagen: bilanzen([an1, an2], 'monat', '2026-10-01'),
      gebaeude: gebaeude([{ id: 'g2', kurzzeichen: 'G-2', name: 'Halle 2' }], '2026-10-31'),
    });
    expect(eben(zeilen[0].gemessen)).toBe('gemessen im Gebäude 32.000 kWh (3 Messstellen)');
    expect(ziffern(zeilen[0].gemessen!)).toBe(fall('O4').gegeben.summe_im_gebaeude);
  });

  it('ohne Werte im Zeitraum sagt die Zeile „keine Werte“, nie 0', () => {
    // 19.10.2026: die Messstellen stehen in Halle 2, die Referenzfälle nennen für den Tag keine Werte.
    const zeilen = gebaeudeZeilen({
      standortId: st1,
      periode: 'tag',
      am: '2026-10-19',
      heute: '2026-11-10',
      anlagen: bilanzen([an1, an2], 'tag', '2026-10-19'),
      gebaeude: gebaeude([{ id: 'g2', kurzzeichen: 'G-2', name: 'Halle 2' }], '2026-10-19'),
    });
    expect(eben(zeilen[0].gemessen)).toBe('gemessen im Gebäude: keine Werte (3 Messstellen)');
    const energie = energiebilanzBaustein({ ebene: AHRENBERG, periode: 'tag', am: '2026-10-19', heute: '2026-11-10', anlagen: bilanzen([an1, an2], 'tag', '2026-10-19') })!;
    expect(eben(energie.summe!.text)).toBe('keine Werte · 0 von 2 Systemen');
  });
});
