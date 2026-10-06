import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MessstelleRegisterZeile, MessstellenRegister } from './api';
import { registerEintraege, type MessstellenEbene } from './messstellen';
import {
  gruppenZahl,
  liste,
  marken,
  messstelleBeispiel,
  mitSuche,
  monatKurz,
  monatLang,
  monatWert,
  NOCH_KEINE_QUELLE,
  ohneParameter,
  passtZurSuche,
  standWann,
  standZahl,
  status,
  sucheAus,
  suchTerme,
  trefferSatz,
  WEG_WORT,
} from './messstellenListe';
import { listeZurueck, merkeListe } from './messstellenRueckweg';
import { ahrenbergRegister, REGISTER_ZEITPUNKT } from './test/messstellenRegisterFixtures';

/**
 * Die reine Liste „Messstellen“ (Konzept Messen m1, §6.2/§6.3) gegen das Referenzunternehmen (heute 20.10.2026):
 * Suche, Gruppen je Ort, Marken, Statuszeile, „Woher die Werte kommen“ und die Zahlen der Reihen.
 */

const UNTERNEHMEN: MessstellenEbene = { art: 'unternehmen', name: 'Kunststoffwerk Ahrenberg GmbH' };
const ZONE = 'Europe/Berlin';

function aus(antwort: MessstellenRegister, suche = '', marke: Parameters<typeof liste>[1]['marke'] = null) {
  const eintraege = registerEintraege(antwort, null, { ebene: UNTERNEHMEN, zone: ZONE, zeitpunkt: antwort.zeitpunkt });
  return liste(eintraege, { ebene: UNTERNEHMEN, zone: ZONE, zeitpunkt: antwort.zeitpunkt, suche, marke });
}

/** MS-21 als Ablesestelle, deren Ablesung überfällig ist. */
function mitUeberfaelligerAblesung(): MessstellenRegister {
  const r = ahrenbergRegister();
  const z = r.register.find((x) => x.kennzeichen === 'MS-21')!;
  z.quelle = {
    stand: 'ablesung',
    fuehrend: null,
    davor: null,
    vergleichsquellen: 0,
    ablesung: { seit: '2024-10-01T00:00:00+02:00', zuletzt: '2026-08-01T00:00:00+02:00' },
  };
  z.lebenszyklus = 'aktiv';
  z.beobachtung = { ...z.beobachtung!, zustand: 'liefert_nicht_seit', seit: '2026-10-01T00:00:00+02:00', text: 'Ablesung überfällig seit 01.10.2026' };
  return r;
}

describe('Suche (Konzept §6.3)', () => {
  it('jedes Wort muss passen; eine Ziffer am Wortanfang gehört zum Wort davor', () => {
    expect(suchTerme('  Halle 1 ')).toEqual(['halle1']);
    expect(suchTerme('az 3')).toEqual(['az3']);
    expect(suchTerme('druck luft')).toEqual(['druck', 'luft']);
    expect(suchTerme('')).toEqual([]);
  });

  it('gesucht wird in Name, Kennzeichen, Ort und dem Gerät der führenden Quelle - nie in der Anlage', () => {
    const r = ahrenbergRegister().register;
    const ms06 = r.find((z) => z.kennzeichen === 'MS-06')!;
    expect(passtZurSuche(ms06, suchTerme('spritzguss'))).toBe(true);
    expect(passtZurSuche(ms06, suchTerme('ms06'))).toBe(true);
    expect(passtZurSuche(ms06, suchTerme('halle 1 nord'))).toBe(true);
    expect(passtZurSuche(ms06, suchTerme('Z-5a'))).toBe(true);
    expect(passtZurSuche(ms06, suchTerme('lindach'))).toBe(false);
    // MS-20 liegt an keinem Ort, hängt aber an der Anlage Halle 1: „halle 1“ findet ihn nicht.
    const ms20 = r.find((z) => z.kennzeichen === 'MS-20')!;
    expect(passtZurSuche(ms20, suchTerme('halle 1'))).toBe(false);
  });

  it('die Suche steht in der Adresse; andere Parameter bleiben', () => {
    expect(sucheAus('#/portfolio/messstellen?ort=G-1&suche=druck')).toBe('druck');
    expect(sucheAus('#/portfolio/messstellen')).toBe('');
    expect(mitSuche('#/portfolio/messstellen?ort=G-1', 'druck')).toBe('#/portfolio/messstellen?ort=G-1&suche=druck');
    expect(mitSuche('#/portfolio/messstellen?suche=druck', ' ')).toBe('#/portfolio/messstellen');
    expect(ohneParameter('#/portfolio/messstellen?ort=G-1&suche=druck', 'ort')).toBe('#/portfolio/messstellen?suche=druck');
  });

  it('der Rückweg führt in dieselbe Trefferliste - nur, wenn die gemerkte Liste zur selben Ebene gehört', () => {
    merkeListe('#/portfolio/messstellen?suche=druck');
    expect(listeZurueck('#/portfolio/messstellen')).toBe('#/portfolio/messstellen?suche=druck');
    expect(listeZurueck('#/standort/st-1/messstellen')).toBeNull();
  });
});

describe('Liste, Gruppen und Reihen', () => {
  it('Gruppen je Ort in der Reihenfolge des Ortsbaums; im Ort der Hauptzähler zuerst', () => {
    const l = aus(ahrenbergRegister());
    expect(l.gesamt).toBe(22);
    expect(l.treffer).toBe(22);
    expect(l.orte).toBe(14);
    expect(l.gruppen[0].titel).toBe('Unternehmen');
    expect(l.gruppen.at(-1)?.titel).toBe('Kein Ort zugeordnet');
    const werk = l.gruppen.find((g) => g.titel === 'Werk Ahrenberg')!;
    expect(werk.reihen.map((r) => r.kennzeichen)).toEqual(['MS-01', 'MS-02', 'MS-14']);
    expect(trefferSatz(l, false)).toBe('22 Messstellen an 14 Orten');
  });

  it('rechts der Verbrauch des letzten Monats (Messen PR5): „88.200 kWh · Sep 2026“ - aus der Antwort, nie gerechnet', () => {
    // Die echte Antwort der API mit `letzterMonat=true` (Kopie der Demo-Datenbank, Stichtag 05.10.2026).
    const echt = JSON.parse(readFileSync(resolve(process.cwd(), 'src/test/fixtures/register-letzter-monat-2026-09.json'), 'utf8')) as {
      register: MessstelleRegisterZeile[];
    };
    const z = (kz: string) => echt.register.find((x) => x.kennzeichen === kz)!;
    expect(monatWert(z('MS-20'))).toEqual({ zahl: '88.200', einheit: 'kWh', wann: 'Sep 2026' });
    expect(monatWert(z('HZ-1'))).toEqual({ zahl: '199.500', einheit: 'kWh', wann: 'Sep 2026' });
    // Ohne Zahl der Strich mit dem Monat - nie 0.
    expect(monatWert(z('MS-03'))).toEqual({ zahl: '—', einheit: null, wann: 'Sep 2026' });
    // Eine Hauptgröße ohne Menge (Leistung) und eine Antwort ohne Monat: kein Monat, dann steht der letzte Stand.
    expect(monatWert({ ...z('HZ-1'), hauptgroesse: { ...z('HZ-1').hauptgroesse!, wertart: 'Momentanwert' } })).toBeNull();
    expect(monatWert({ ...z('HZ-1'), letzter_monat: undefined })).toBeNull();
    // In der Reihe: der Monat ersetzt den Stand.
    const r = ahrenbergRegister();
    const ms06 = r.register.find((x) => x.kennzeichen === 'MS-06')!;
    ms06.letzter_monat = z('HZ-1').letzter_monat;
    expect(aus(r).reihen.find((x) => x.kennzeichen === 'MS-06')!.wert).toEqual({ zahl: '199.500', einheit: 'kWh', wann: 'Sep 2026' });
    expect(monatKurz('2026-09')).toBe('Sep 2026');
    expect(monatKurz('2027-03')).toBe('Mär 2027');
    expect(monatLang('2026-09')).toBe('September 2026');
  });

  it('woher die Werte kommen: Gerät mit Komponente und Messwert, berechnet, noch keine Quelle', () => {
    const l = aus(ahrenbergRegister());
    const r = (kz: string) => l.reihen.find((x) => x.kennzeichen === kz)!;
    expect(r('MS-06').woher).toEqual({ zeile: WEG_WORT.geraet, neben: 'Unterzähler Spritzguss SG01–SG06 · Wirkenergie Bezug' });
    expect(r('MS-06').wegKurz).toBe('vom Gerät');
    expect(r('MS-19').woher.zeile).toBe('berechnet aus anderen Messstellen');
    expect(r('MS-21').woher.zeile).toBe('noch keine Quelle');
    // Eingerichtet ohne Quelle: der Satz sagt, was fehlt - nicht „eingerichtet · Keine Datenquelle“.
    expect(r('MS-21').satz).toBe(NOCH_KEINE_QUELLE);
    expect(r('MS-21').ton).toBe('still');
    expect(r('MS-21').wert).toBeNull();
  });

  it('eine Ablesestelle: „von Hand abgelesen, monatlich“, Warnton und Ziel der Wiedervorlage, wenn die Ablesung fehlt', () => {
    const l = aus(mitUeberfaelligerAblesung());
    const ms21 = l.reihen.find((x) => x.kennzeichen === 'MS-21')!;
    expect(ms21.woher.zeile).toBe('von Hand abgelesen, monatlich');
    expect(ms21.wegKurz).toBeNull();
    expect(ms21.satz).toBe('Ablesung überfällig seit 01.10.2026');
    expect(ms21.lage.ablesungFehlt).toBe(true);
    expect(ms21.ablesungsZiel).toBe(true);
  });

  it('Suche und Marke filtern; jede Gruppe zählt ihre Treffer gegen ihren Bestand', () => {
    const l = aus(ahrenbergRegister(), 'spritzguss');
    expect(l.reihen).toHaveLength(22);
    expect(l.treffer).toBe(3);
    expect(trefferSatz(l, true)).toBe('3 von 22 Messstellen');
    const nord = l.gruppen.find((g) => g.titel === 'Halle 1 Nord')!;
    expect(gruppenZahl(nord, true)).toBe('Werk Ahrenberg · 1 von 1');
    const ohne = aus(ahrenbergRegister(), '', 'ohneQuelle');
    expect(ohne.treffer).toBe(1);
    expect(ohne.gruppen[0].reihen[0].kennzeichen).toBe('MS-21');
  });
});

describe('Marken und Statuszeile', () => {
  it('Marken nur, was es gibt - nie „0 ohne Quelle“', () => {
    expect(marken(aus(ahrenbergRegister()).reihen).map((m) => m.text)).toEqual(['1 ohne Quelle']);
    expect(marken(aus(mitUeberfaelligerAblesung()).reihen)).toEqual([
      { schluessel: 'ablesungFehlt', text: '1 Ablesung überfällig', ton: 'warn', anzahl: 1 },
    ]);
  });

  it('liefert alles: die ruhige Zeile mit dem Satz des Servers', () => {
    const r = ahrenbergRegister();
    r.register = r.register.filter((z) => z.kennzeichen !== 'MS-21');
    r.aggregat = { ...r.aggregat!, unternehmen: { erfuellt: 21, gesamt: 21, text: '21 von 21 Messstellen liefern Daten' } };
    expect(status(r, aus(r).reihen, { ebene: UNTERNEHMEN, zone: ZONE, stichtag: null })).toEqual({
      zeile: { text: '21 von 21 Messstellen liefern Daten', ton: 'ok' },
      hinweise: [],
    });
  });

  it('nicht alles liefert, aber nichts ist überfällig: ein ruhiger Hinweis ohne Schritt', () => {
    const r = ahrenbergRegister();
    expect(status(r, aus(r).reihen, { ebene: UNTERNEHMEN, zone: ZONE, stichtag: null })).toEqual({
      zeile: null,
      hinweise: [{ titel: '21 von 22 Messstellen liefern Daten', satz: '', ton: 'off', marke: null, schritt: null }],
    });
  });

  it('eine Ablesung überfällig: die Hinweiskarte mit „Ablesen“ - am Stichtag in der Vergangenheit und ohne Schritt', () => {
    const r = mitUeberfaelligerAblesung();
    const heute = status(r, aus(r).reihen, { ebene: UNTERNEHMEN, zone: ZONE, stichtag: null });
    expect(heute.hinweise).toEqual([
      {
        titel: 'Bei Gas Heizung Verwaltung (MS-21) ist die Ablesung überfällig',
        satz: 'Seit 01.10.2026 · Verwaltung',
        ton: 'warn',
        marke: 'ablesungFehlt',
        schritt: 'Ablesen',
      },
    ]);
    const damals = status(r, aus(r).reihen, { ebene: UNTERNEHMEN, zone: ZONE, stichtag: '2026-10-19' });
    expect(damals.hinweise[0].titel).toBe('Bei Gas Heizung Verwaltung (MS-21) war die Ablesung überfällig');
    expect(damals.hinweise[0].satz).toBe('Seit 01.10.2026 · Verwaltung · am Stichtag lässt sich nichts eintragen');
    expect(damals.hinweise[0].schritt).toBeNull();
  });

  it('das Beispiel aus der eigenen Firma: ein Hauptzähler und eine zweite Messstelle', () => {
    expect(messstelleBeispiel(aus(ahrenbergRegister()).reihen).map((r) => r.kennzeichen)).toEqual(['MS-01', 'MS-03']);
    expect(messstelleBeispiel([])).toEqual([]);
  });
});

describe('Zahlen der Reihen (E11)', () => {
  it('Tausenderpunkt, echtes Minus, keine unnötige „,0“', () => {
    expect(standZahl(970680, 'kWh')).toBe('970.680');
    expect(standZahl(312.44, 'kW')).toBe('312,4');
    expect(standZahl(-40, 'kW')).toBe('−40');
  });

  it('„Stand 08:55“ am selben Tag, sonst der Tag, ein anderes Jahr mit Jahr', () => {
    expect(standWann('2026-10-20T06:55:00Z', ZONE, REGISTER_ZEITPUNKT)).toBe('Stand 08:55');
    expect(standWann('2026-10-01T05:15:00Z', ZONE, REGISTER_ZEITPUNKT)).toBe('Stand 01.10.');
    expect(standWann('2025-12-01T07:00:00Z', ZONE, REGISTER_ZEITPUNKT)).toBe('Stand 01.12.2025');
  });
});
