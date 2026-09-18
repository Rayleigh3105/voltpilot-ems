import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as B from './bezugsgroesseListe';
import { ahrenbergBezugsgroessen, ahrenbergProzesse, ahrenbergKostenstellen } from './test/kennzahlAnlegenFixtures';
import { ahrenbergUnternehmen, ahrenbergHeute, FIXTURE_IDS } from './test/standorteFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from './test/ortsbaumFixtures';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import { rechenstellen } from './test/oberflaechenArithmetik';

const daten: B.OrtsDaten = { unternehmen: ahrenbergUnternehmen(), standorte: ahrenbergHeute().standorte, baeume: [ortsbaumAhrenberg(), ortsbaumLindach()], prozesse: ahrenbergProzesse(), kostenstellen: ahrenbergKostenstellen(), messstellen: ahrenbergRegister().register };
const orte = B.geltungsOrte(daten, '2026-10-20');
const liste = ahrenbergBezugsgroessen();
const alle = B.zeilen(liste, orte);
const darf = () => true;

describe('Bezugsgrößen-Liste und Anlegen (AP-09 IP-9)', () => {
  it('führt alle neun Arten und Einheiten zeilengleich zum Vertrag, ohne Referenzdaten im Produkt', () => {
    const v = JSON.parse(readFileSync('../../docs/contracts/v2/bezugsdaten-vectors.json', 'utf8'));
    expect(B.ARTEN).toEqual(Object.fromEntries(Object.entries(v.arten.je_art).map(([key, a]) => [key, Object.fromEntries(Object.entries(a as object).filter(([feld]) => feld !== 'konzept'))])));
    expect(B.VOKABULAR).toEqual({ ...Object.fromEntries(['wertart', 'geltung_art', 'periode_art', 'herkunft_art'].map(k => [k, v.vokabulare[k]])), einheiten: v.einheiten });
  });
  it('bietet sieben Anlegearten, keine zweite Fläche und keine Ablesung', () => {
    expect(B.anlegeArten()).toHaveLength(7);
    expect(B.anlegeArten().map(a => a.value)).not.toContain('bezugsflaeche');
    expect(B.anlegeArten().map(a => a.value)).not.toContain('zaehlerstand');
    expect(B.einheiten('sonstige_menge')).not.toContain('m²');
  });
  it('behält Flächen als eigenständige Zeilen ohne BZ-ID oder Schreibweg', () => {
    expect(alle.filter(z => z.flaeche)).toHaveLength(liste.bezugsflaechen.length);
    expect(alle.filter(z => z.flaeche).every(z => z.original === null && z.status === 'Aus der Struktur')).toBe(true);
    expect(new Set(alle.map(z => z.key)).size).toBe(alle.length);
    expect(liste.bezugsgroessen.some(b => b.einheit === 'm²')).toBe(false);
  });
  it('filtert Standort über echte Ortszuordnung; unternehmensweite Prozesse werden keinem Standort zugerechnet', () => {
    const gefiltert = B.filtern(alle, { standort: FIXTURE_IDS.st2, prozess: null, archiviert: false });
    expect(gefiltert.map(z => z.kennzeichen)).toEqual(['BZ-7', 'G-4', 'G-5']);
    expect(B.filtern(alle, { standort: null, prozess: daten.prozesse[0].id, archiviert: false }).map(z => z.kennzeichen)).toEqual(['BZ-1', 'BZ-3']);
  });
  it('trennt archivierte Zeilen, während Werte wahrheitsgemäß bestehen bleiben', () => {
    const b = { ...liste.bezugsgroessen[0], archiviert_am: '2026-10-20T10:00:00Z' };
    const zeilen = B.zeilen({ bezugsgroessen: [b], bezugsflaechen: [] }, orte);
    expect(B.filtern(zeilen, { standort: null, prozess: null, archiviert: false })).toEqual([]);
    expect(B.filtern(zeilen, { standort: null, prozess: null, archiviert: true })[0]).toMatchObject({ status: 'Archiviert', original: b });
  });
  it('macht aus fehlenden Werten keine Null und aus fehlenden Orten kein Unternehmensrecht', () => {
    const b = { ...liste.bezugsgroessen[0], hat_werte: false, geltung_art: 'gebaeude' as const, geltung_id: 'fehlt' };
    expect(B.zeilen({ bezugsgroessen: [b], bezugsflaechen: [] }, orte)[0]).toMatchObject({ status: 'Noch keine Werte', standort: undefined });
  });
  it('zeigt die gespeicherte Art und rät bei identischen Vertragsfeldern nicht', () => {
    const bestand = liste.bezugsgroessen[0];
    const lesen = (art: string | null) => B.zeilen({ bezugsgroessen: [{ ...bestand, art }], bezugsflaechen: [] }, orte)[0];
    expect(lesen('produktionsmenge').art).toBe('Produktionsmenge');
    expect(lesen('sonstige_menge').art).toBe('Sonstige Menge');
    expect(lesen(null).art).toBe('Art nicht angegeben');
    expect(lesen(null).einheit).toBe(lesen('produktionsmenge').einheit);
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
  it('übernimmt Vertragsablehnungen und rechnet keine Menge', () => {
    expect(B.fehlerSatz({ body: { code: 'kennzeichen_belegt' } })).toContain('schon eine andere');
    expect(rechenstellen(readFileSync('src/bezugsgroesseListe.ts', 'utf8')).operationen).toEqual([]);
  });
});
