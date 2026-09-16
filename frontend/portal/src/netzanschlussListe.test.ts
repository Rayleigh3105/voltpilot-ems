import { describe, expect, it } from 'vitest';
import * as N from './netzanschlussListe';
import { ahrenbergNetzanschluesse } from './test/netzanschlussFixtures';
import { FIXTURE_IDS as I, werkAhrenberg } from './test/standorteFixtures';
import { kopfzeile } from './uemsNetzanschluss';
import { dez } from './bezugsdaten';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import { ebenenReiter, standortBereichFuer } from './ebenenNav';
import { hashForRoute, parseRoute, standortBereichRoute } from './nav';

describe('Netzanschlüsse am Standort', () => {
  it('F16: gleiche Formatierstelle für Liste und Bilanz, kein fehlender Wert als Null', () => {
    const liste = ahrenbergNetzanschluesse();
    expect(N.leistung(liste[0])).toBe(kopfzeile('NA-1', dez('550'), dez('630'), null).text);
    expect(N.leistung(liste[0])).toBe('vereinbart 550\u00a0kW · Anschluss 630\u00a0kVA');
    expect(N.leistung({ ...liste[0], vereinbart_kw: '550.450', anschluss_kva: '27.600' }))
      .toBe('vereinbart 550,45\u00a0kW · Anschluss 27,6\u00a0kVA');
    expect(N.bilanzKopf(liste, I.an1, '2026-10-20')).toContain(N.leistung(liste[0]));
    expect(N.leistung({ ...liste[0], vereinbart_kw: null, anschluss_kva: null })).toBe('');
    expect(N.bilanzKopf(liste, I.an2, '2026-09-30')).toBe('Netzanschluss: nicht angelegt');
  });
  it('die Bindung gilt einschließlich ihres letzten Tags; später ist sie nicht aktuell', () => {
    const liste = ahrenbergNetzanschluesse();
    liste[0].anlagen[0].gueltig_bis = '2026-10-19';
    expect(N.anschlussDerAnlage(liste, I.an1, '2026-10-19')?.kennzeichen).toBe('NA-1');
    expect(N.anschlussDerAnlage(liste, I.an1, '2026-10-20')).toBeNull();
  });
  it('Wechsel nennt den Vortag; doppelter Tag und belegtes Ziel bleiben abgelehnt', () => {
    const liste = ahrenbergNetzanschluesse(),
      frei = { ...liste[0], id: 'frei', anlagen: [] };
    expect(N.bindungPruefen(liste, frei, I.an1, '2026-10-20', '2026-10-20')).toEqual({
      feld: null,
      text: 'Die bisherige Bindung endet am 19.10.2026.',
    });
    expect(N.bindungPruefen(liste, frei, I.an1, '2024-03-12', '2026-10-20').feld).toBe('ab');
    expect(N.bindungPruefen(liste, liste[1], I.an1, '2026-10-20', '2026-10-20').text).toContain('andere Anlage');
  });
  it('künftige Bindungen werden nicht überschrieben und Anschluss-Ende begrenzt die Bindung', () => {
    const liste = ahrenbergNetzanschluesse(),
      frei = { ...liste[0], id: 'frei', anlagen: [], gueltig_bis: '2026-10-31' };
    liste[0].anlagen[0].gueltig_ab = '2026-11-01';
    expect(N.bindungPruefen(liste, frei, I.an1, '2026-10-20', '2026-10-20').feld).toBeNull();
    expect(N.bindungPruefen(liste, { ...frei, gueltig_bis: null }, I.an1, '2026-10-20', '2026-10-20').feld).toBe('ab');
    expect(N.bindungPruefen(liste, frei, I.an1, '2026-11-01', '2026-10-20').feld).toBe('ab');
  });
  it('Prüfung ruft den Zwilling an; Dezimalwerte gehen ungerundet an die Route', () => {
    const e = {
      ...N.neuerEntwurf('NA-0004'),
      name: 'Hauptanschluss Halle 1',
      malo: '47110000001',
      anschluss_kva: '630',
      vereinbart_kw: '550,45',
    };
    expect(N.pruefen(e, I.st1)).toEqual({});
    expect(N.anfrage(e)).toMatchObject({ vereinbart_kw: '550.45', gueltig_ab: null, gueltig_bis: null });
    for (const val of ['0', '-1', '1,2,3', 'NaN'])
      expect(N.pruefen({ ...e, anschluss_kva: val }, I.st1).anschluss_kva).toBeTruthy();
    expect(N.pruefen({ ...e, malo: '123' }, I.st1).malo).toBeTruthy();
    expect(N.pruefen({ ...e, name: '' }, I.st1).name).toBeTruthy();
    expect(N.anfrage({ ...e, anschluss_kva: '1.250,45' }).anschluss_kva).toBe('1250.45');
    expect(N.anfrage({ ...e, anschluss_kva: '1250' }).anschluss_kva).toBe('1250');
    expect(
      N.bindungPruefen(ahrenbergNetzanschluesse(), ahrenbergNetzanschluesse()[0], I.an1, '2026-02-31', '2026-10-20')
        .feld,
    ).toBe('ab');
  });
  it('Picker nennt vorhandene Bindung, ohne andere Anlagen zu erfinden', () => {
    const options = N.anlagenOptionen(werkAhrenberg().anlagen, ahrenbergNetzanschluesse(), '2026-10-20');
    expect(options).toHaveLength(2);
    expect(options[0].sub).toContain('NA-1 seit 12.03.2024');
  });
  it('Reiter und Lesezeichen nur für einen Standort, der misst; O18 bleibt Bestand', () => {
    const ort = { art: 'standort' as const, standortId: I.st1 },
      lm = { standorte: [werkAhrenberg()], funktionen: ahrenbergFunktionen(), kennzahlen: [] };
    const route = standortBereichRoute(I.st1, 'netzanschluesse');
    expect(parseRoute(hashForRoute(route))).toMatchObject(route);
    expect(ebenenReiter(ort, lm).map((x) => x.key)).toContain('netzanschluesse');
    expect(ebenenReiter(ort, { ...lm, funktionen: null }).map((x) => x.key)).not.toContain('netzanschluesse');
    expect(standortBereichFuer(route, { ...lm, funktionen: null })).toBeUndefined();
  });
});

it('rät beim Anlegevorschlag keine Messung und verlangt ihre Ergänzung', () => {
  const e = {
    ...N.neuerEntwurf('NA-0001'),
    name: 'Netzanschluss Halle 1',
    messung: '' as const,
  };
  expect(N.pruefen(e, 'st').messung).toBeTruthy();
  expect(() => N.anfrage(e)).toThrow('Bitte die Messung wählen.');
});
