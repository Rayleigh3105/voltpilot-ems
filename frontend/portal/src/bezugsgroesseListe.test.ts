import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as B from './bezugsgroesseListe';
import * as U from './bezugsgroessenUebersicht';
import { ahrenbergBezugsgroessen, ahrenbergProzesse, ahrenbergKostenstellen } from './test/kennzahlAnlegenFixtures';
import { ahrenbergUnternehmen, ahrenbergHeute, FIXTURE_IDS } from './test/standorteFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from './test/ortsbaumFixtures';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import { bezugswert } from './test/werteEingabeFixtures';
import type { BezugsgroesseWert, BezugsgroesseWerte, Bezugsgroesse, BezugsgroesseStammdatum } from './api';
import { rechenstellen } from './test/oberflaechenArithmetik';

const daten: B.OrtsDaten = { unternehmen: ahrenbergUnternehmen(), standorte: ahrenbergHeute().standorte, baeume: [ortsbaumAhrenberg(), ortsbaumLindach()], prozesse: ahrenbergProzesse(), kostenstellen: ahrenbergKostenstellen(), messstellen: ahrenbergRegister().register };
const orte = B.geltungsOrte(daten, '2026-10-20');
const liste = ahrenbergBezugsgroessen();
const darf = () => true;

describe('Bezugsgrößen-Liste und Anlegen (AP-09 IP-9)', () => {
  it('führt alle Vertragsarten und Einheiten zeilengleich zum Vertrag, ohne Referenzdaten im Produkt', () => {
    const v = JSON.parse(readFileSync('../../docs/contracts/v2/bezugsdaten-vectors.json', 'utf8'));
    expect(B.ARTEN).toEqual(Object.fromEntries(Object.entries(v.arten.je_art).map(([key, a]) => [key, Object.fromEntries(Object.entries(a as object).filter(([feld]) => feld !== 'konzept'))])));
    expect(B.VOKABULAR).toEqual({ ...Object.fromEntries(['wertart', 'geltung_art', 'periode_art', 'herkunft_art'].map(k => [k, v.vokabulare[k]])), einheiten: v.einheiten });
  });
  it('bietet sieben Anlegearten, keine zweite Fläche und keine Ablesung', () => {
    expect(B.anlegeArten()).toHaveLength(7);
    expect(B.anlegeArten().map(a => a.value)).not.toContain('bezugsflaeche');
    expect(B.anlegeArten().map(a => a.value)).not.toContain('zaehlerstand');
    expect(B.anlegeArten().map(a => a.value)).not.toContain('betriebszeit_aus_leistung');
    expect(B.einheiten('sonstige_menge')).not.toContain('m²');
  });
  it('Flächen aus dem Gebäudeplan: je Standort und Gebäude eine Kachel mit dem Wert von heute - fehlend ist „nicht angegeben“, nie 0', () => {
    const f = {
      periode_art: 'tag' as const, von: '2026-10-20', bis: '2026-10-20',
      bezugsflaechen: liste.bezugsflaechen.map((b) => ({ bezugsflaeche: b, perioden: [{ periode: '2026-10-20', von: '2026-10-20', stichtag: '2026-10-20', betrag: b.geltung_kennzeichen === 'G-1' ? '4200' : null, quelle: null, gilt_ab: null, eingetragen_am: null, abzeichen: null, kennzeichen: [] }] })),
    };
    const k = U.flaechenKacheln(f, orte);
    expect(k).toHaveLength(liste.bezugsflaechen.length);
    expect(k.find((x) => x.kennzeichen === 'G-1')).toMatchObject({ name: 'Halle 1', wert: '4.200', einheit: 'm²', standort: FIXTURE_IDS.st1 });
    expect(k.filter((x) => x.kennzeichen !== 'G-1').every((x) => x.wert === null)).toBe(true);
    // Je Standort zusammen: Ahrenberg-Gebäude vor Lindach.
    expect(k.map((x) => x.standort)).toEqual([...k.map((x) => x.standort)].sort((a, b) => Number(a !== FIXTURE_IDS.st1) - Number(b !== FIXTURE_IDS.st1)));
    expect(U.flaechenKacheln(null, orte)).toEqual([]);
  });
  it('eine Reihe: was sie zählt, der letzte Wert mit Tausenderpunkt, der fällige Monat - nie geraten, nie gerechnet', () => {
    // Angelegt vor dem fälligen Monat (die Fixture legt am 01.10.2026 an - dann wäre September noch nicht fällig).
    const b = { ...liste.bezugsgroessen[0], angelegt_am: '2024-01-01T00:00:00Z' };
    const werte = (...w: [string, string][]): BezugsgroesseWerte => ({ bezugsgroesse_id: b.id, kennzeichen: b.kennzeichen, wertart: 'periodenwert', einheit: b.einheit, periode_art: 'monat', von: null, bis: null, fassungen: 'wirksam', werte: w.map(([m, betrag]) => ({ ...bezugswert(betrag), periode_von: `${m}-01`, periode_bis: `${m}-28` })) });
    const r = U.bzReihe(b, werte(['2026-08', '298400'], ['2026-09', '305200.5']), null, '2026-10-20');
    expect(r).toMatchObject({ unter: 'Spritzguss · kg je Monat', ton: 'gut', zustand: 'eingetragen bis Sep 2026', woher: 'von Hand eingetragen', wert: { zahl: '305.200,5', einheit: 'kg' }, wann: 'Sep 2026', fehlt: false, faellig: '2026-09' });
    const alt = U.bzReihe(b, werte(['2026-08', '298400']), null, '2026-10-20');
    expect(alt).toMatchObject({ ton: 'hinweis', zustand: 'für Sep 2026 fehlt der Wert', fehlt: true, wann: 'Aug 2026' });
    // Angelegt NACH dem fälligen Monat: dann fehlt nichts - noch kein Wert ist kein Versäumnis.
    const neu = U.bzReihe({ ...b, angelegt_am: '2026-10-05T10:00:00Z' }, werte(), null, '2026-10-20');
    expect(neu).toMatchObject({ ton: 'still', zustand: 'noch kein Wert', wert: null, eintragen: true, fehlt: false });
    // Unterwegs (null) und nicht abrufbar ('fehler') behaupten nichts.
    expect(U.bzReihe(b, null, null, '2026-10-20')).toMatchObject({ fehlt: false, wert: null });
    expect(U.bzReihe(b, 'fehler', null, '2026-10-20')).toMatchObject({ fehlt: false, wert: null });
    expect(U.bzReihe({ ...b, archiviert_am: '2026-10-20T10:00:00Z' }, werte(), null, '2026-10-20')).toMatchObject({ archiviert: true, zustand: 'archiviert', fehlt: false, eintragen: false });
    expect(JSON.stringify(U.bzReihe(b, werte(), null, '2026-10-20'))).not.toMatch(/Art nicht angegeben/);
  });
  it('woher ein Wert kommt: eingetragen, importiert, Messkanal oder Wetter-Archiv (Kennzeichen des Vertrags)', () => {
    const w = (art: 'eingabe' | 'import' | 'messkanal', kennzeichen: string[] = []): BezugsgroesseWert => {
      const x = bezugswert('90');
      x.fassungen[0] = { ...x.fassungen[0], herkunft: { ...x.fassungen[0].herkunft, art }, kennzeichen };
      return x;
    };
    expect(U.woherDesWerts(w('eingabe'))).toBe('von Hand eingetragen');
    expect(U.woherDesWerts(w('import'))).toBe('importiert');
    expect(U.woherDesWerts(w('messkanal'))).toBe('aus einem Messkanal');
    expect(U.woherDesWerts(w('messkanal', ['Temperatur von VoltPilot bezogen (Wetter-Archiv), nicht am Standort gemessen.']))).toBe('aus dem Wetter-Archiv');
  });
  it('eine Bezugsfläche aus dem Gebäude ist nicht schreibbar - „aus dem Gebäudeplan“, kein „Eintragen“', () => {
    const f: Bezugsgroesse = { ...liste.bezugsgroessen[0], wertart: 'stammdatum', einheit: 'm²', periode_art: null, art: 'bezugsflaeche' };
    const stamm = (schreibbar: boolean, mit: boolean): BezugsgroesseStammdatum => ({ bezugsgroesse_id: f.id, kennzeichen: f.kennzeichen, name: f.name, einheit: 'm²', zeitzone: 'Europe/Berlin', schreibbar, intervalle: mit ? [{ wert: '4200', gueltig_ab: '2024-03-12', gueltig_bis: null, aufgehoben_am: null, eingetragen_am: '2026-10-05T00:00:00+02:00', abzeichen: null }] : [], periode_art: null, von: null, bis: null, perioden: [] });
    expect(U.bzReihe(f, null, stamm(false, true), '2026-10-20')).toMatchObject({ woher: 'aus dem Gebäudeplan', zustand: 'gilt seit 12.03.2024', wert: { zahl: '4.200', einheit: 'm²' }, eintragen: false });
    expect(U.bzReihe(f, null, stamm(true, false), '2026-10-20')).toMatchObject({ woher: 'eigene Angabe', zustand: 'noch kein Wert', wert: null, eintragen: true });
  });
  it('die Statuszeile: ruhig „Werte bis September 2026 eingetragen“ - oder was fehlt, mit dem Schritt zur ersten', () => {
    const r = (kz: string, fehlt: boolean) => ({ ...U.bzReihe({ ...liste.bezugsgroessen[0], kennzeichen: kz, name: `Name ${kz}` }, null, null, '2026-10-20'), fehlt });
    expect(U.bzStatus([r('BZ-1', false), r('BZ-2', false)])).toMatchObject({ ton: 'ok', text: 'Werte bis September 2026 eingetragen', ziel: null });
    expect(U.bzStatus([r('BZ-1', true), r('BZ-2', false)])).toMatchObject({ ton: 'hinweis', text: 'Für September 2026 fehlt der Wert von Name BZ-1' });
    expect(U.bzStatus([r('BZ-1', true), r('BZ-2', true)])).toMatchObject({ ton: 'hinweis', text: 'Für September 2026 fehlen 2 Werte', satz: 'Name BZ-1, Name BZ-2 · Der Vergleich mit Ihrem Verbrauch braucht sie.' });
    expect(U.bzStatus([])).toBeNull();
  });
  it('Gruppen je Periode und zwölf Balken mit Lücken - ein fehlender Monat ist eine Lücke, nie 0', () => {
    const reihen = liste.bezugsgroessen.map((b) => U.bzReihe(b, null, null, '2026-10-20'));
    expect(U.bzGruppen(reihen).map((g) => [g.titel, g.reihen.map((x) => x.kennzeichen)])).toEqual([
      ['Werte je Monat', ['BZ-1', 'BZ-2', 'BZ-3', 'BZ-6', 'BZ-7']],
      ['Werte je Tag', ['BZ-5']],
    ]);
    const w = [{ ...bezugswert('10'), periode_von: '2026-09-01' }, { ...bezugswert('8'), periode_von: '2026-07-01' }];
    const zwoelf = U.zwoelfPerioden(w, 'monat', '2026-09');
    expect(zwoelf).toHaveLength(12);
    expect(zwoelf.slice(-3)).toEqual([{ schluessel: '2026-07', betrag: '8' }, { schluessel: '2026-08', betrag: null }, { schluessel: '2026-09', betrag: '10' }]);
    expect(U.balkenMarke('2026-09', 'monat')).toBe('S');
    expect(U.vorjahr('2026-09', 'monat')).toBe('2025-09');
    expect(U.zahlDe('1250000')).toBe('1.250.000');
    expect(U.zahlDe('-1130.25')).toBe('−1.130,25');
  });
  it('Artwechsel erneuert abhängige Felder und verwirft unpassende Geltung', () => {
    const e = { ...B.neuerEntwurf(), ort: orte.find(o => o.art === 'prozess')!.key };
    expect(B.artWechsel(e, 'mitarbeitende', orte)).toMatchObject({ einheit: 'Personen', periode: null, ort: null });
    expect(B.artWechsel(e, 'gutteile', orte)).toMatchObject({ einheit: 'Stück', periode: 'monat', ort: e.ort });
  });
  it('trägt genau einen Geltungsbereich und nur Felder des strengen Schreibvertrags', () => {
    const o = orte.find(o => o.art === 'prozess')!;
    const e = { ...B.neuerEntwurf(), name: ' Produktionsmenge Spritzguss ', ort: o.key };
    expect(B.pruefen(e, orte, darf)).toEqual({});
    expect(B.anfrage(e, o)).toEqual({ art: 'produktionsmenge', name: 'Produktionsmenge Spritzguss', wertart: 'periodenwert', einheit: 'kg', periode_art: 'monat', geltung_art: 'prozess', geltung_id: o.id });
    expect(B.pruefen({ ...e, kennzeichen: 'b', einheit: 'h', periode: 'jahr' }, orte, darf)).toHaveProperty('kennzeichen');
    expect(B.pruefen({ ...e, kennzeichen: 'b', einheit: 'h', periode: 'jahr' }, orte, darf)).toHaveProperty('einheit');
  });
  it('macht Peter nur passende Ziele seines Standorts wählbar', () => {
    const peter = (s: string | null) => s === FIXTURE_IDS.st2;
    const optionen = B.ortOptionen('produktionsmenge', orte, peter);
    expect(optionen.filter(o => !o.disabled).every(o => orte.find(x => x.key === o.value)?.standort === FIXTURE_IDS.st2)).toBe(true);
    const prozess = orte.find(o => o.art === 'prozess')!;
    expect(B.pruefen({ ...B.neuerEntwurf(), name: 'Produktion', ort: prozess.key }, orte, peter)).toHaveProperty('ort');
  });
  it('erhält den letzten Gültigkeitstag und sperrt Zukunft und Vergangenheit mit Grund', () => {
    const k = daten.kostenstellen[0];
    const q = { ...daten, kostenstellen: [{ ...k, gueltig_ab: '2026-10-01', gueltig_bis: '2026-10-20' }] };
    expect(B.geltungsOrte(q, '2026-10-20').find(o => o.id === k.id)?.waehlbar).toBe(true);
    expect(B.geltungsOrte(q, '2026-10-21').find(o => o.id === k.id)).toMatchObject({ waehlbar: false, hinweis: 'Heute nicht gültig' });
    expect(B.geltungsOrte(q, '2026-09-30').find(o => o.id === k.id)?.waehlbar).toBe(false);
  });
  it('die neue Liste rechnet nur mit Kalendern und Reihenfolgen - nie mit einem Betrag', () => {
    const { operationen } = rechenstellen(readFileSync('src/bezugsgroessenUebersicht.ts', 'utf8'));
    // Jede Stelle gehört zu Monatsnamen, Kalenderschritten oder der Reihenfolge der Kacheln - keine an `betrag`/`wert`.
    expect(operationen.filter((o) => /betrag|wirksamer|\.wert\b/.test(o))).toEqual([]);
    expect([...new Set(operationen.map((o) => o.split(':')[0]))].sort()).toEqual(
      ['balkenMarke', 'faelligePeriode', 'flaechenKacheln', 'periodeText', 'vorjahr', 'woherDesWerts', 'zwoelfPerioden'],
    );
  });
  it('übernimmt Vertragsablehnungen und rechnet keine Menge', () => {
    expect(B.fehlerSatz({ body: { code: 'kennzeichen_belegt' } })).toContain('schon eine andere');
    expect(rechenstellen(readFileSync('src/bezugsgroesseListe.ts', 'utf8')).operationen).toEqual([]);
  });
});
