import { describe, expect, it } from 'vitest';
import type { MessstelleRegisterZeile, MessstellenRegister } from './api';
import { UEMS_FUEHREND, UEMS_MESSSTELLE, UEMS_QUELLE, UEMS_VERGLEICH } from './glossar';
import {
  BERECHNET_AUS,
  KEIN_ORT,
  KEINE_DATENQUELLE,
  OHNE_FILTER,
  SPALTEN,
  TITEL,
  VERGLEICHSQUELLE,
  filterOptionen,
  kopfZeile,
  leerzustand,
  registerAnfrage,
  registerEintraege,
  wertText,
  zeileWoerter,
  type MessstellenEbene,
} from './messstellen';
import { quellenJeGeraet } from './boxAnQuelle';
import { ahrenbergDatenquellen, ahrenbergUemsGeraete, BOX_NAMEN, BOX_TAUSCH } from './test/datenquellenFixtures';
import { ahrenbergRegister, leeresRegister, REGISTER_ZEITPUNKT } from './test/messstellenRegisterFixtures';
import { FIXTURE_IDS } from './test/standorteFixtures';

/**
 * Das Messstellen-Register im Portal (UEMS AP-04 IP-5) gegen das Referenzunternehmen
 * Ahrenberg (Fassung 1.3, heute = 20.10.2026 10:15): Prüfnachweis 1 (Zeile → Wörter)
 * und 3 (Leerzustände, „Stand am …“) als reine Ableitung.
 */

const UNTERNEHMEN: MessstellenEbene = { art: 'unternehmen', name: 'Kunststoffwerk Ahrenberg GmbH' };
const WERK: MessstellenEbene = { art: 'standort', id: FIXTURE_IDS.st1, name: 'Werk Ahrenberg' };
const LINDACH: MessstellenEbene = { art: 'standort', id: FIXTURE_IDS.st2, name: 'Werk Lindach' };
const ZONE = 'Europe/Berlin';

const kontext = (a: MessstellenRegister, ebene: MessstellenEbene = UNTERNEHMEN) => ({ ebene, zone: ZONE, zeitpunkt: a.zeitpunkt });
const zeile = (a: MessstellenRegister, kz: string): MessstelleRegisterZeile => {
  const z = a.register.find((r) => r.kennzeichen === kz);
  if (!z) throw new Error(`keine Zeile ${kz}`);
  return z;
};
const woerter = (kz: string, a = ahrenbergRegister(), ebene: MessstellenEbene = UNTERNEHMEN) =>
  zeileWoerter(zeile(a, kz), kontext(a, ebene));

/** Ein Register ohne die angegebenen Messstellen (beide Listen, wie der Server sie nennt). */
function ohne(a: MessstellenRegister, ...kz: string[]): MessstellenRegister {
  const b = structuredClone(a);
  b.register = b.register.filter((z) => !kz.includes(z.kennzeichen));
  b.messstellen = b.messstellen.filter((m) => !kz.includes(m.kennzeichen));
  return b;
}

describe('Prüfnachweis 1 · aus einer Registerzeile werden die Kundenwörter', () => {
  it('MS-01: Hauptzähler am Standort, führend seit Beginn, die Wirkleistung als letzter Wert', () => {
    expect(woerter('MS-01')).toEqual({
      id: '3e000000-0000-4000-8000-000000000001',
      kennzeichen: 'MS-01',
      name: 'Netzbezug Halle 1',
      ort: { text: 'Werk Ahrenberg', standort: null },
      stellung: 'Werk Ahrenberg – Halle 1 · Hauptzähler',
      quelle: {
        art: 'gebunden',
        geraet: 'Netzzähler Halle 1 · GR-2',
        messwert: 'Wirkenergie Bezug',
        seit: 'führend seit 12.03.2024',
        davor: null,
        vergleich: null,
        // AP-13 IP-12 (L6): ohne gelesene Zuständigkeit steht KEIN Box-Satz — nie eine geratene Box.
        box: null,
        // AP-13 IP-11 (D1): der Weg zur Komponente auf der Geräte-Seite der Anlage aus der Stellung.
        sprung: {
          route: { page: 'anlagen', siteId: FIXTURE_IDS.an1, sub: 'modell' },
          hash: `#/anlage/${FIXTURE_IDS.an1}/modell?komponente=c0000000-0000-4000-8000-000000000003`,
        },
      },
      zustand: 'aktiv',
      beobachtung: { text: 'Liefert Daten', ton: 'gut' },
      // Der Zählerstand der Hauptgröße steht nicht in der Referenzdatei — „—“, nie eine 0.
      wert: null,
      nebenwerte: [{ groesse: 'Wirkleistung', text: '312,4 kW', zeit: '10:15 Uhr' }],
      fakten: [],
    });
  });

  it('A4: die Einstellungsänderung steht an beiden gespeisten Messstellen als wirksamer Fakt', () => {
    const antwort = ahrenbergRegister();
    for (const kz of ['MS-01', 'MS-02']) {
      zeile(antwort, kz).fakten = [{ art: 'einstellung_geaendert', gilt_ab: '2027-01-15T09:00:00+01:00' }];
      expect(zeileWoerter(zeile(antwort, kz), { ...kontext(antwort), zeitpunkt: '2027-01-15T10:00:00+01:00' }).fakten)
        .toEqual(['Einstellung geändert ab 15.01.2027 09:00']);
    }
  });

  it('MS-06 im Unternehmen: Bereich mit seinem Standort, „Unterzähler von MS-01“, Gerät mit Einbau Z-5a', () => {
    const w = woerter('MS-06');
    expect(w.ort).toEqual({ text: 'Halle 1 Nord', standort: 'Werk Ahrenberg' });
    expect(w.stellung).toBe('Werk Ahrenberg – Halle 1 · Unterzähler von MS-01');
    expect(w.quelle).toMatchObject({ geraet: 'Unterzähler Spritzguss SG01–SG06 · GR-4 Z-5a', seit: 'führend seit 12.03.2024' });
    // Am Standort steht der Standort nicht noch einmal unter dem Ort.
    expect(woerter('MS-06', ahrenbergRegister({ standort: FIXTURE_IDS.st1 }), WERK).ort).toEqual({
      text: 'Halle 1 Nord',
      standort: null,
    });
  });

  it('A17: MS-06 am 15.11. mit Z-5a, am 20.11. mit Z-5b „seit 18.11.2026 10:40 · davor Z-5a“ — Ort und Stellung gleich', () => {
    const vorher = woerter('MS-06', ahrenbergRegister({ stichtag: '2026-11-15' }));
    const nachher = woerter('MS-06', ahrenbergRegister({ stichtag: '2026-11-20' }));
    expect(vorher.quelle).toMatchObject({
      art: 'gebunden',
      geraet: 'Unterzähler Spritzguss SG01–SG06 · GR-4 Z-5a',
      messwert: 'Wirkenergie Bezug',
      seit: 'führend seit 12.03.2024',
      davor: null,
      vergleich: null,
    });
    expect(nachher.quelle).toMatchObject({
      art: 'gebunden',
      geraet: 'Unterzähler Spritzguss SG01–SG06 · GR-4 Z-5b',
      messwert: 'Wirkenergie Bezug',
      seit: 'führend seit 18.11.2026 10:40',
      davor: 'davor Z-5a',
      vergleich: null,
    });
    // AP-13 IP-11 (D1): der Einbau wechselt (Z-5a → Z-5b), die KOMPONENTE bleibt — also derselbe Weg.
    // Ein Gerätetausch an derselben Komponente ist kein neues Ziel (AGENTS.md: ein Port beweist kein Gerät).
    const weg = (w: typeof vorher) => (w.quelle.art === 'gebunden' ? w.quelle.sprung?.hash : null);
    expect(weg(nachher)).toBe(weg(vorher));
    expect(weg(vorher)).toBe(`#/anlage/${FIXTURE_IDS.an1}/modell?komponente=c0000000-0000-4000-8000-000000000005`);
    expect(nachher.ort).toEqual(vorher.ort);
    expect(nachher.stellung).toBe(vorher.stellung);
  });

  it('berechnet (MS-09), am Unternehmen (MS-19), ohne Ort (MS-20): eigene Wörter statt einer Quelle', () => {
    expect(woerter('MS-09')).toMatchObject({
      ort: { text: 'Halle 1', standort: 'Werk Ahrenberg' },
      stellung: 'Werk Ahrenberg – Halle 1 · keine Stellung',
      quelle: { art: 'berechnet', text: BERECHNET_AUS },
      beobachtung: { text: 'Vollständig', ton: 'gut' },
      nebenwerte: [],
    });
    expect(woerter('MS-19')).toMatchObject({ ort: { text: 'Unternehmen', standort: null }, stellung: null });
    expect(woerter('MS-20').ort).toEqual({ text: KEIN_ORT, standort: null });
    const unvollstaendig = structuredClone(zeile(ahrenbergRegister(), 'MS-09'));
    unvollstaendig.berechnung = { zustand: 'unvollstaendig', fehlend: ['MS-06'], seit: null, text: 'Unvollständig (fehlt: MS-06)' };
    expect(zeileWoerter(unvollstaendig, kontext(ahrenbergRegister())).beobachtung).toEqual({
      text: 'Unvollständig (fehlt: MS-06)',
      ton: 'hinweis',
    });
  });

  it('MS-21 ohne Quelle (E8): „Keine Datenquelle“, still — kein Wert, nie eine 0', () => {
    expect(woerter('MS-21')).toMatchObject({
      quelle: { art: 'keine_datenquelle', text: KEINE_DATENQUELLE },
      zustand: 'eingerichtet',
      beobachtung: { text: 'Keine Datenquelle', ton: 'still' },
      wert: null,
      nebenwerte: [],
    });
  });

  it('der Zustand: Entwurf mit dem, was fehlt · angehalten seit · Archiviert am — und „liefert nicht seit“ ist ein Hinweis, kein Fehler', () => {
    const a = ahrenbergRegister();
    const basis = zeile(a, 'MS-21');
    const mit = (teil: Partial<MessstelleRegisterZeile>) => zeileWoerter({ ...structuredClone(basis), ...teil }, kontext(a)).zustand;
    expect(mit({ lebenszyklus: 'entwurf', fehlt: ['ort', 'name'] })).toBe('Entwurf · es fehlt: Ort, Name');
    expect(mit({ lebenszyklus: 'entwurf', fehlt: [] })).toBe('Entwurf');
    expect(mit({ lebenszyklus: 'angehalten', angehalten_ab: '2026-11-03T14:00:00+01:00' })).toBe('angehalten seit 03.11.2026 14:00');
    expect(mit({ lebenszyklus: 'archiviert', archiviert_am: '2027-06-30T16:30:00+02:00' })).toBe('Archiviert am 30.06.2027');
    const schweigt = structuredClone(zeile(a, 'MS-11'));
    schweigt.beobachtung = { ...schweigt.beobachtung!, zustand: 'liefert_nicht_seit', text: 'Liefert keine Daten seit 03.11.2026 14:05 Uhr', seit: '2026-11-03T14:05:00+01:00' };
    expect(zeileWoerter(schweigt, kontext(a)).beobachtung).toEqual({ text: 'Liefert keine Daten seit 03.11.2026 14:05 Uhr', ton: 'hinweis' });
  });

  it('Werte kommen an, gehören aber zu keiner Messreihe: der Satz des Servers als Hinweis, nie „gut“ — der letzte Wert bleibt', () => {
    const a = ahrenbergRegister();
    const ohneReihe = structuredClone(zeile(a, 'MS-01'));
    ohneReihe.beobachtung = {
      ...ohneReihe.beobachtung!,
      zustand: 'wartet_auf_erste_daten',
      text: 'Daten kommen an – noch keiner Messreihe zugeordnet',
      zuordnung: 'nicht_zugeordnet',
    };
    ohneReihe.letzter_wert = { wert: 501, text: null, einheit: 'kWh', zeitpunkt: '2026-11-03T14:05:00+01:00' };
    const w = zeileWoerter(ohneReihe, kontext(a));
    expect(w.beobachtung).toEqual({ text: 'Daten kommen an – noch keiner Messreihe zugeordnet', ton: 'hinweis' });
    expect(w.wert?.text).toContain('501');
  });

  it('Vergleichsquellen werden gezählt und beim Namen genannt', () => {
    const a = ahrenbergRegister();
    const eine = structuredClone(zeile(a, 'MS-01'));
    eine.quelle.vergleichsquellen = 1;
    expect(zeileWoerter(eine, kontext(a)).quelle).toMatchObject({ vergleich: '1 Vergleichsquelle' });
    eine.quelle.vergleichsquellen = 2;
    expect(zeileWoerter(eine, kontext(a)).quelle).toMatchObject({ vergleich: '2 Vergleichsquellen' });
  });

  it('AP-13 IP-12 (L6): die Spalte „Quelle“ nennt die Box aus der Zuständigkeit der Datenquelle', () => {
    const a = ahrenbergRegister();
    const boxen = quellenJeGeraet(
      ahrenbergUemsGeraete(FIXTURE_IDS.an2).geraete,
      ahrenbergDatenquellen(FIXTURE_IDS.an2, a.zeitpunkt).datenquellen,
    );
    // MS-10 liest über GR-7 „C-1“; am 20.10.2026 ist noch Box Halle 2 zuständig, seit dem 01.10.2026.
    const ohne = zeileWoerter(zeile(a, 'MS-10'), kontext(a));
    const mit = zeileWoerter(zeile(a, 'MS-10'), { ...kontext(a), boxen });
    expect(ohne.quelle).toMatchObject({ art: 'gebunden', box: null });
    expect(mit.quelle).toMatchObject({ art: 'gebunden', box: `zuständig: ${BOX_NAMEN['E-2']} seit 01.10.2026` });
  });

  it('AP-13 IP-12: nach dem Box-Tausch am 04.11.2026 09:38 nennt dieselbe Zeile die Nachfolgerin', () => {
    const a = ahrenbergRegister();
    const nachher = new Date(Date.parse(BOX_TAUSCH) + 60_000).toISOString();
    const boxen = quellenJeGeraet(
      ahrenbergUemsGeraete(FIXTURE_IDS.an2).geraete,
      ahrenbergDatenquellen(FIXTURE_IDS.an2, nachher).datenquellen,
    );
    const w = zeileWoerter(zeile(a, 'MS-10'), { ...kontext(a), zeitpunkt: nachher, boxen });
    expect(w.quelle).toMatchObject({ box: `zuständig: ${BOX_NAMEN['E-2′']} seit 04.11.2026 09:38` });
  });

  it('AP-13 IP-12: eine Anlage ohne gelesene Zuständigkeit bekommt KEINEN Satz — nie eine geratene Box', () => {
    const a = ahrenbergRegister();
    // Die Karte kennt nur Halle 2; MS-01 (Halle 1, GR-2) bleibt deshalb ohne Box-Zeile.
    const boxen = quellenJeGeraet(
      ahrenbergUemsGeraete(FIXTURE_IDS.an2).geraete,
      ahrenbergDatenquellen(FIXTURE_IDS.an2, a.zeitpunkt).datenquellen,
    );
    expect(zeileWoerter(zeile(a, 'MS-01'), { ...kontext(a), boxen }).quelle).toMatchObject({ box: null });
  });

  it('Werte: Stellen je Einheit, Tausenderpunkt, U+2212, geschütztes Leerzeichen, Text-Wert, ein anderer Tag mit Datum', () => {
    const w = (wert: number | null, einheit: string | null, text: string | null = null) =>
      wertText({ wert, text, einheit, zeitpunkt: REGISTER_ZEITPUNKT });
    expect(w(-40, 'kW')).toBe('−40,0 kW');
    expect(w(0, 'kW')).toBe('0,0 kW');
    expect(w(1482300, 'kWh')).toBe('1.482.300,0 kWh');
    expect(w(62, '%')).toBe('62 %');
    expect(w(1240, 'm³')).toBe('1.240,0 m³');
    expect(w(null, null, 'belegt')).toBe('belegt');
    const a = ahrenbergRegister();
    const gestern = structuredClone(zeile(a, 'MS-04'));
    gestern.letzter_wert = { wert: 88400, text: null, einheit: 'kWh', zeitpunkt: '2026-10-19T21:45:00Z' };
    expect(zeileWoerter(gestern, kontext(a))).toMatchObject({
      wert: { text: '88.400,0 kWh', zeit: '19.10.2026 23:45 Uhr' },
      nebenwerte: [
        { groesse: 'Wirkleistung', text: '−40,0 kW', zeit: '10:15 Uhr' },
        { groesse: 'Ladestand', text: '62 %', zeit: '10:15 Uhr' },
      ],
    });
  });

  it('die Fläche spricht die vier Kundenwörter Messstelle · Quelle · führend · Vergleich (Glossar-Konstanten)', () => {
    expect(TITEL.startsWith(UEMS_MESSSTELLE)).toBe(true);
    expect(SPALTEN.quelle).toBe(`${UEMS_QUELLE} (${UEMS_FUEHREND})`);
    expect(VERGLEICHSQUELLE).toBe('Vergleichsquelle');
    expect(VERGLEICHSQUELLE.startsWith(UEMS_VERGLEICH)).toBe(true);
    expect(woerter('MS-01').quelle).toMatchObject({ seit: expect.stringMatching(/^führend seit /) });
  });
});

describe('Prüfnachweis 3 · „Stand am …“: wer an dem Tag noch nicht da war, wird benannt — nicht weggelassen', () => {
  it('am 10.10.2026 gab es die Messstellen in Lindach noch nicht (erst ab 15.10.2026) — an ihrem Platz, mit Satz', () => {
    const a = ahrenbergRegister({ stichtag: '2026-10-10' });
    const eintraege = registerEintraege(a, '2026-10-10', kontext(a));
    expect(eintraege).toHaveLength(22);
    expect(eintraege.map((e) => (e.art === 'messstelle' ? e.woerter.kennzeichen : e.kennzeichen))).toEqual(
      a.register.map((z) => z.kennzeichen),
    );
    const nicht = eintraege.flatMap((e) => (e.art === 'gab_es_noch_nicht' ? [e] : []));
    expect(nicht.map((e) => e.kennzeichen)).toEqual(['MS-16', 'MS-17', 'MS-18', 'MS-22']);
    expect(nicht[0]).toEqual({
      art: 'gab_es_noch_nicht',
      id: '3e000000-0000-4000-8000-000000000016',
      kennzeichen: 'MS-16',
      name: 'Netzbezug Lindach',
      satz: 'Am 10.10.2026 gab es MS-16 „Netzbezug Lindach“ im Portal noch nicht.',
    });
  });

  it('der erste Tag ist der früheste von Ort, Stellung und Quelle — die rückwirkende Quelle seit 2024 zählt', () => {
    const a = ahrenbergRegister({ stichtag: '2025-06-01' });
    const eintraege = registerEintraege(a, '2025-06-01', kontext(a));
    const nicht = eintraege.flatMap((e) => (e.art === 'gab_es_noch_nicht' ? [e.kennzeichen] : []));
    expect(nicht).toEqual(['MS-09', 'MS-10', 'MS-11', 'MS-12', 'MS-13', 'MS-14', 'MS-15', 'MS-16', 'MS-17', 'MS-18', 'MS-19', 'MS-21', 'MS-22']);
    const ms01 = eintraege.find((e) => e.art === 'messstelle' && e.woerter.kennzeichen === 'MS-01');
    expect(ms01).toMatchObject({ woerter: { ort: { text: KEIN_ORT }, quelle: { art: 'gebunden', seit: 'führend seit 12.03.2024' } } });
  });

  it('ohne Stichtag (heute) und ohne jede zeitgültige Tatsache (MS-20) nie „noch nicht“', () => {
    const a = ahrenbergRegister({ stichtag: '2026-10-10' });
    expect(registerEintraege(a, null, kontext(a)).every((e) => e.art === 'messstelle')).toBe(true);
    const frueh = ahrenbergRegister({ stichtag: '2020-01-01' });
    const ms20 = registerEintraege(frueh, '2020-01-01', kontext(frueh)).find(
      (e) => (e.art === 'messstelle' ? e.woerter.kennzeichen : e.kennzeichen) === 'MS-20',
    );
    expect(ms20?.art).toBe('messstelle');
  });

  it('„x von y Messstellen liefern Daten“ steht nur heute im Kopf — mit Stichtag spricht das Banner', () => {
    expect(kopfZeile(ahrenbergRegister(), null)).toBe('21 von 22 Messstellen liefern Daten');
    expect(kopfZeile(ahrenbergRegister({ stichtag: '2026-10-10' }), '2026-10-10')).toBeNull();
    expect(kopfZeile(leeresRegister(), null)).toBeNull();
  });
});

describe('Prüfnachweis 3 · Leerzustände (§5.11)', () => {
  const leer = leeresRegister();

  it('Standort eingerichtet, noch keine Messstelle — ohne Knopf, solange es Dialog und Vorschlagsliste nicht gibt', () => {
    expect(leerzustand({ antwort: leer, basis: leer, filter: OHNE_FILTER, ebene: LINDACH, bereichDa: true })).toEqual({
      art: 'keine_messstelle',
      satz: 'Noch keine Messstelle in Werk Lindach.',
    });
  });

  it('ohne „Messen & Auswerten“ gibt es den Bereich nicht — der Weg führt über die Übersicht', () => {
    expect(leerzustand({ antwort: leer, basis: leer, filter: OHNE_FILTER, ebene: UNTERNEHMEN, bereichDa: false })).toEqual({
      art: 'bereich_fehlt',
      satz: 'Messstellen gibt es, sobald ein Standort „Messen & Auswerten“ eingerichtet hat.',
    });
    expect(leerzustand({ antwort: leer, basis: leer, filter: OHNE_FILTER, ebene: LINDACH, bereichDa: false })).toEqual({
      art: 'bereich_fehlt',
      satz: 'Messstellen gibt es in Werk Lindach, sobald dort „Messen & Auswerten“ eingerichtet ist.',
    });
  });

  it('unbekannt ist nie „gibt es nicht“', () => {
    expect(leerzustand({ antwort: leer, basis: leer, filter: OHNE_FILTER, ebene: UNTERNEHMEN, bereichDa: null })?.art).toBe(
      'keine_messstelle',
    );
  });

  it('„ohne Quelle“ ohne Treffer: „Alle 16 gemessenen Messstellen haben eine Quelle.“ — ohne berechnete ohne das Beiwort', () => {
    const filter = { ...OHNE_FILTER, ohneQuelle: true };
    const basis = ohne(ahrenbergRegister(), 'MS-21');
    expect(leerzustand({ antwort: leer, basis, filter, ebene: UNTERNEHMEN, bereichDa: true })).toEqual({
      art: 'alle_mit_quelle',
      satz: 'Alle 16 gemessenen Messstellen haben eine Quelle.',
    });
    const lindach = ahrenbergRegister({ standort: FIXTURE_IDS.st2 });
    expect(leerzustand({ antwort: leer, basis: lindach, filter, ebene: LINDACH, bereichDa: true })?.satz).toBe(
      'Alle 3 Messstellen haben eine Quelle.',
    );
    const eine = ohne(lindach, 'MS-17', 'MS-18');
    expect(leerzustand({ antwort: leer, basis: eine, filter, ebene: LINDACH, bereichDa: true })?.satz).toBe(
      'Die Messstelle hat eine Quelle.',
    );
  });

  it('jeder andere Filter ohne Treffer — und mit Zeilen gibt es keinen Leerzustand', () => {
    const basis = ahrenbergRegister();
    const filter = { ...OHNE_FILTER, ohneQuelle: true, anlage: FIXTURE_IDS.an3 };
    expect(leerzustand({ antwort: leer, basis, filter, ebene: UNTERNEHMEN, bereichDa: true })).toEqual({
      art: 'filter_ohne_treffer',
      satz: 'Keine Messstelle passt zu diesen Filtern.',
    });
    expect(leerzustand({ antwort: basis, basis, filter: OHNE_FILTER, ebene: UNTERNEHMEN, bereichDa: false })).toBeNull();
  });
});

describe('Filter: EINE Abfrage mit Parametern, Optionen aus der ungefilterten Antwort', () => {
  it('„Standort › Messstellen“ fragt immer mit seinem Standort; ein leerer Filter wird nicht gesendet', () => {
    expect(registerAnfrage(UNTERNEHMEN, OHNE_FILTER, null)).toEqual({});
    expect(
      registerAnfrage(WERK, { ...OHNE_FILTER, standort: FIXTURE_IDS.st2, zustand: 'aktiv', ohneQuelle: true }, '2026-11-20'),
    ).toEqual({ standort: FIXTURE_IDS.st1, zustand: 'aktiv', ohneQuelle: true, stichtag: '2026-11-20' });
  });

  it('Standorte nur im Unternehmen, Gebäude vor ihren Bereichen, nur vorkommende Zustände, die Zahl „ohne Quelle“', () => {
    const o = filterOptionen(ahrenbergRegister(), UNTERNEHMEN);
    expect(o.standorte.map((s) => s.label)).toEqual(['Werk Ahrenberg', 'Werk Lindach']);
    expect(o.orte.map((s) => s.label)).toEqual([
      'Halle 1 · Werk Ahrenberg',
      'Halle 1 Nord · Werk Ahrenberg',
      'Halle 1 Süd · Werk Ahrenberg',
      'Halle 2 · Werk Ahrenberg',
      'Halle 2 Montage · Werk Ahrenberg',
      'Halle 2 Spritzguss · Werk Ahrenberg',
      'Halle 2 Lager · Werk Ahrenberg',
      'Verwaltung · Werk Ahrenberg',
      'Lagerhalle Lindach · Werk Lindach',
      'Montagehalle Lindach · Werk Lindach',
    ]);
    expect(o.anlagen.map((s) => s.label)).toEqual(['Werk Ahrenberg – Halle 1', 'Werk Ahrenberg – Halle 2', 'Werk Lindach']);
    expect(o.zustaende).toEqual([
      { value: 'eingerichtet', label: 'eingerichtet' },
      { value: 'aktiv', label: 'aktiv' },
    ]);
    expect({ ohneQuelle: o.ohneQuelle, gemessen: o.gemessen, berechnet: o.berechnet }).toEqual({ ohneQuelle: 1, gemessen: 17, berechnet: 5 });
    const werk = filterOptionen(ahrenbergRegister({ standort: FIXTURE_IDS.st1 }), WERK);
    expect(werk.standorte).toEqual([]);
    expect(werk.orte[0]).toEqual({ value: '0e000000-0000-4000-8000-000000000101', label: 'Halle 1' });
  });
});
