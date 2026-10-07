import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MessstelleRegisterZeile, MessstellenRegister } from './api';
import { registerEintraege, type MessstellenEbene } from './messstellen';
import {
  ableseortVon,
  gruppenZahl,
  liste,
  marken,
  markeAus,
  markiert,
  mitParameter,
  messstelleBeispiel,
  mitSuche,
  monatKurz,
  monatLang,
  monatWert,
  NOCH_KEINE_QUELLE,
  ohneParameter,
  passtZurSuche,
  standAus,
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
  it('jedes Wort muss passen; eine Zahl ist ein eigener Begriff, gleich wie geschrieben', () => {
    expect(suchTerme('  Halle 1 ')).toEqual(['halle', '1']);
    expect(suchTerme('Halle-1')).toEqual(['halle', '1']);
    expect(suchTerme('az 3')).toEqual(['az', '3']);
    expect(suchTerme('MS-06')).toEqual(['ms', '6']);
    expect(suchTerme('druck luft')).toEqual(['druck', 'luft']);
    expect(suchTerme('')).toEqual([]);
  });

  it('eine Zahl trifft nur als ganze Zahl und gehört zum Wort davor (Review r4 S1)', () => {
    const z = ahrenbergRegister().register[0];
    const mit = (name: string, kennzeichen: string, ortName: string, standort = 'ST-9') => ({
      ...z,
      name,
      kennzeichen,
      quelle: { ...z.quelle, fuehrend: null },
      ort: { ...z.ort, name: ortName, kennzeichen: 'G-9', pfad: [standort, 'G-9'], standort, standort_name: 'Werk X' },
    });
    const passt = (zeile: ReturnType<typeof mit>, suche: string) => passtZurSuche(zeile, suchTerme(suche));
    expect(passt(mit('Lüftung', 'MS-90', 'Halle 1'), 'halle 1')).toBe(true);
    expect(passt(mit('Lüftung', 'MS-90', 'Halle 10'), 'halle 1')).toBe(false);
    expect(passt(mit('Lüftung', 'MS-90', 'Halle 10'), 'halle 10')).toBe(true);
    expect(passt(mit('Kompressor', 'AZ-3', 'Halle 3'), 'az 3')).toBe(true);
    expect(passt(mit('Kompressor', 'AZ-30', 'Halle 3'), 'az 3')).toBe(false);
    // Die Zahl darf im selben Feld weiter hinten stehen …
    expect(passt(mit('Spritzguss Halle 2', 'MS-91', 'Halle 2'), 'spritzguss 2')).toBe(true);
    // … oder in einem anderen Feld, wenn das Wort dort keine eigene Zahl trägt.
    expect(passt(mit('Lüftung', 'MS-92', 'Halle 2'), 'lüftung 2')).toBe(true);
    expect(passt(mit('Druckluft', 'MS-93', 'Halle 3'), 'druck 3')).toBe(true);
    // „Halle 2“ am Standort ST-1 ist nicht „halle 1“ - die 1 von ST-1 hilft nicht.
    expect(passt(mit('Lüftung', 'MS-94', 'Halle 2', 'ST-1'), 'halle 1')).toBe(false);
    // Führende Nullen zählen nicht, eine andere Zahl schon.
    expect(passt(mit('Lüftung', 'MS-06', 'Halle 2'), 'ms 6')).toBe(true);
    expect(passt(mit('Lüftung', 'MS-06', 'Halle 2'), 'ms6')).toBe(true);
    expect(passt(mit('Lüftung', 'MS-16', 'Halle 2'), 'ms 6')).toBe(false);
    expect(passt(mit('Lüftung', 'MS-60', 'Halle 2'), 'ms 6')).toBe(false);
  });

  it('die Markierung folgt derselben Zahlgrenze: „Halle 1“ ganz, an „Halle 10“ nichts von der 10', () => {
    const teile = (text: string, suche: string) =>
      markiert(text, suchTerme(suche))
        .filter((t) => t.treffer)
        .map((t) => t.text);
    expect(teile('Halle 1', 'halle 1')).toEqual(['Halle 1']);
    expect(teile('Halle 10', 'halle 1')).toEqual(['Halle']);
    expect(teile('AZ-30', 'az 3')).toEqual(['AZ']);
    expect(teile('MS-06', 'ms 6')).toEqual(['MS-06']);
    // Die Zahl gehört zu ihrem Wort: ohne das Wort im Text bleibt sie unmarkiert.
    expect(teile('HZ-1', 'halle 1')).toEqual([]);
    expect(teile('Hauptzähler Halle 1', 'halle 1')).toEqual(['Halle 1']);
    expect(teile('AZ-3', '3')).toEqual(['3']);
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

  it('Marke und Stichtag stehen in der Adresse; Unbekanntes gilt nicht', () => {
    expect(markeAus('#/portfolio/messstellen?marke=ohneQuelle')).toBe('ohneQuelle');
    expect(markeAus('#/portfolio/messstellen?marke=alles')).toBeNull();
    expect(standAus('#/portfolio/messstellen?stand=2029-04-30')).toBe('2029-04-30');
    expect(standAus('#/portfolio/messstellen?stand=morgen')).toBeNull();
    expect(mitParameter('#/portfolio/messstellen?suche=druck', 'marke', 'ohneQuelle')).toBe(
      '#/portfolio/messstellen?suche=druck&marke=ohneQuelle',
    );
    expect(mitParameter('#/portfolio/messstellen?stand=2029-04-30', 'stand', null)).toBe('#/portfolio/messstellen');
  });

  it('der Rückweg führt in dieselbe Trefferliste - nur, wenn die gemerkte Liste zur selben Ebene gehört', () => {
    merkeListe('#/portfolio/messstellen?suche=druck');
    expect(listeZurueck('#/portfolio/messstellen')).toBe('#/portfolio/messstellen?suche=druck');
    expect(listeZurueck('#/standort/st-1/messstellen')).toBeNull();
    // Der Sprung der Wiedervorlage gilt einmal; Ort, Marke und Stichtag bleiben.
    merkeListe('#/portfolio/messstellen?ort=G-1&entscheid=zaehlerablesung&marke=ablesungFehlt&stand=2029-04-30');
    expect(listeZurueck('#/portfolio/messstellen')).toBe('#/portfolio/messstellen?ort=G-1&marke=ablesungFehlt&stand=2029-04-30');
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
    expect(monatWert(z('MS-20'))).toEqual({ zahl: '88.200', einheit: 'kWh', wann: 'Sep 2026', monat: true });
    expect(monatWert(z('HZ-1'))).toEqual({ zahl: '199.500', einheit: 'kWh', wann: 'Sep 2026', monat: true });
    // Ohne Zahl der Strich mit dem Monat - nie 0.
    expect(monatWert(z('MS-03'))).toEqual({ zahl: '—', einheit: null, wann: 'Sep 2026', monat: true });
    // Eine Hauptgröße ohne Menge (Leistung) und eine Antwort ohne Monat: kein Monat, dann steht der letzte Stand.
    expect(monatWert({ ...z('HZ-1'), hauptgroesse: { ...z('HZ-1').hauptgroesse!, wertart: 'Momentanwert' } })).toBeNull();
    expect(monatWert({ ...z('HZ-1'), letzter_monat: undefined })).toBeNull();
    // In der Reihe: der Monat ersetzt den Stand.
    const r = ahrenbergRegister();
    const ms06 = r.register.find((x) => x.kennzeichen === 'MS-06')!;
    ms06.letzter_monat = z('HZ-1').letzter_monat;
    expect(aus(r).reihen.find((x) => x.kennzeichen === 'MS-06')!.wert).toEqual({ zahl: '199.500', einheit: 'kWh', wann: 'Sep 2026', monat: true });
    // Ein unvollständiger Monat mit Zahl sieht nicht wie ein ganzer aus: die Reihe sagt „unvollständig“ (Review r4 S3).
    const hz1 = z('HZ-1');
    const teil = {
      ...hz1,
      letzter_monat: {
        ...hz1.letzter_monat!,
        wert: { ...hz1.letzter_monat!.wert!, zustand: 'unvollständig', abdeckung_prozent: 72, erhalten: 72, erwartet: 100, kennzeichen: ['Anfang nicht gemessen (kein Stand an der Periodengrenze)'] },
      },
    };
    expect(monatWert(teil)).toMatchObject({ zahl: '199.500', einheit: 'kWh', hinweis: 'unvollständig' });
    expect(monatWert(z('MS-20'))?.hinweis).toBeUndefined();
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

describe('Ableseort einer Reihe (Review r4 S11)', () => {
  it('die Karte eines Bereichs öffnet die Runde seines Gebäudes, die des Standorts nur die Zähler ohne Gebäude', () => {
    const r = mitUeberfaelligerAblesung();
    // MS-06 hängt in B-1 (Halle 1 Nord, in G-1) und wird von Hand abgelesen.
    const ms06 = r.register.find((x) => x.kennzeichen === 'MS-06')!;
    const ms21 = r.register.find((x) => x.kennzeichen === 'MS-21')!;
    ms06.quelle = structuredClone(ms21.quelle);
    ms06.lebenszyklus = 'aktiv';
    expect(ableseortVon(ms06)).toBe('G-1');
    expect(ableseortVon(ms21)).toBe(ms21.ort.kennzeichen);
    const l = aus(r);
    expect(l.gruppen.find((g) => g.titel === 'Halle 1 Nord')!.ablesen).toBe('G-1');
    // Der Name des Verweises sagt dann nicht „Halle 1 Nord ablesen“; an der Verwaltung ist es ihre eigene Runde.
    expect(l.gruppen.find((g) => g.titel === 'Halle 1 Nord')!.ablesenHier).toBe(false);
    expect(l.gruppen.find((g) => g.titel === 'Verwaltung')!.ablesenHier).toBe(true);
    const amStandort = r.register.find((x) => x.ort.kennzeichen === 'ST-1')!;
    expect(ableseortVon(amStandort)).toBe('ST-1');
  });
});

describe('Marken und Statuszeile', () => {
  it('überfällige Ablesungen zählen im Plural richtig', () => {
    const r = mitUeberfaelligerAblesung();
    const ms22 = r.register.find((x) => x.kennzeichen === 'MS-22')!;
    const ms21 = r.register.find((x) => x.kennzeichen === 'MS-21')!;
    ms22.quelle = structuredClone(ms21.quelle);
    ms22.lebenszyklus = 'aktiv';
    ms22.beobachtung = structuredClone(ms21.beobachtung);
    expect(marken(aus(r).reihen).map((m) => m.text)).toContain('2 Ablesungen überfällig');
  });

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
