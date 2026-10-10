import { describe, expect, it } from 'vitest';
import type { Protokoll, ProtokollEintrag, UemsGeraet } from './api';
import {
  achseSatz,
  bezugText,
  geraetZuKomponenten,
  protokollListe,
  tagText,
  urheberText,
  zeile,
  zeitpunktText,
} from './uemsProtokoll';

/**
 * Die PROTOKOLL-ZEILE (UEMS AP-04 IP-21) — der Vitest-Beleg der Abnahme.
 *
 * ⚠ Der Kern: eine Zeile nennt IMMER BEIDE Zeitpunkte. Der rückwirkende
 * Zählerwechsel des Referenzunternehmens gilt am 18.11.2026 um 10:40 und wurde
 * um 11:05 eingetragen — eine Fläche, die nur einen der beiden zeigt, verliert
 * genau die Auskunft, um die es geht.
 */

const WECHSEL = '2026-11-18T10:40:00+01:00';
const EINGETRAGEN = '2026-11-18T11:05:00+01:00';
/** Der 18.11.2026 um 18:00 Berliner Zeit — die Bezugszeit „heute" der Tests. */
const JETZT = Date.parse('2026-11-18T18:00:00+01:00');

function eintrag(over: Partial<ProtokollEintrag> = {}): ProtokollEintrag {
  return {
    id: 'messstelle:42',
    quelle: 'messstelle',
    art: 'zaehler_gewechselt',
    text: 'Zähler gewechselt: Z-5a → Z-5b',
    bezug: { art: 'messstelle', id: 'ms-1', kennzeichen: 'MS-06', name: 'Hauptzähler Werk' },
    gilt_ab: WECHSEL,
    gilt_bis: null,
    eingetragen_am: EINGETRAGEN,
    zeitform: 'rueckwirkend',
    grund: 'Zähler defekt',
    urheber: { name: 'Ines Kaltenbach', rolle: 'kundenadministrator', art: 'kunde' },
    alt: null,
    neu: null,
    ...over,
  };
}

function seite(eintraege: ProtokollEintrag[], over: Partial<Protokoll> = {}): Protokoll {
  return { eintraege, achse: 'wirkung', von: null, bis: null, weiter: null, ...over };
}

describe('die Protokoll-Zeile', () => {
  it('nennt was, wann es gilt, wann es eingetragen wurde, wer und ob rückwirkend', () => {
    const z = zeile(eintrag(), 'wirkung', false);
    expect(z.satz).toBe('Zähler gewechselt: Z-5a → Z-5b');
    expect(z.giltAb).toBe('gilt ab 18.11.2026, 10:40 Uhr');
    expect(z.eingetragen).toBe('eingetragen am 18.11.2026, 11:05 Uhr');
    expect(z.marke).toBe('rückwirkend');
    expect(z.urheber).toBe('Ines Kaltenbach · Kundenadministrator');
    expect(z.grund).toBe('Zähler defekt');
    // Im Protokoll genau dieses Objekts steht der Bezug nicht an jeder Zeile.
    expect(z.bezug).toBeNull();
  });

  it('führt eine angekündigte Änderung mit ihrem eigenen Wort', () => {
    const z = zeile(
      eintrag({ zeitform: 'angekuendigt', eingetragen_am: '2026-11-17T09:00:00+01:00' }),
      'wirkung',
      false,
    );
    expect(z.marke).toBe('angekündigt');
    expect(z.giltAb).toBe('gilt ab 18.11.2026, 10:40 Uhr');
    expect(z.eingetragen).toBe('eingetragen am 17.11.2026, 09:00 Uhr');
  });

  it('gibt dem Normalfall KEIN Abzeichen — sonst wäre keins mehr eins', () => {
    expect(zeile(eintrag({ zeitform: 'sofort' }), 'wirkung', false).marke).toBeNull();
  });

  it('erfindet keine Rolle, wo das Journal keine festhält', () => {
    expect(urheberText(eintrag({ urheber: { name: 'Ines Kaltenbach', rolle: null, art: null } })))
      .toBe('Ines Kaltenbach');
    expect(urheberText(eintrag({ urheber: { name: 'VoltPilot (Bestandsübernahme)', rolle: null, art: 'voltpilot' } })))
      .toBe('VoltPilot (Bestandsübernahme)');
    expect(urheberText(eintrag({ urheber: { name: '', rolle: null, art: null } })))
      .toBe('Urheber nicht festgehalten');
  });

  it('nennt den Bezug nur im gemischten Protokoll — und nur, was da ist', () => {
    expect(zeile(eintrag(), 'wirkung', true).bezug).toBe('MS-06 · Hauptzähler Werk');
    expect(bezugText(eintrag({ bezug: { art: 'anlage', id: 'a', kennzeichen: null, name: 'Werk Lindach' } })))
      .toBe('Werk Lindach');
    expect(bezugText(eintrag({ bezug: { art: 'anlage', id: 'a', kennzeichen: null, name: null } })))
      .toBeNull();
  });

  it('sagt bei einem unlesbaren Zeitpunkt, dass er unbekannt ist', () => {
    expect(zeitpunktText('kein Zeitpunkt')).toBe('Zeitpunkt unbekannt');
    expect(zeile(eintrag({ gilt_ab: 'kaputt' }), 'wirkung', false).tag).toBeNull();
  });
});

describe('die Liste', () => {
  it('gruppiert nach der Achse, die der SERVER genannt hat — nicht nach einer geratenen', () => {
    // Derselbe Eintrag: auf der Wirkungs-Achse zählt 10:40, auf der Eintrags-Achse 11:05.
    const nachWirkung = protokollListe([seite([eintrag()])], JETZT);
    expect(nachWirkung.achse).toBe('wirkung');
    expect(nachWirkung.achseSatz).toBe('Sortiert danach, ab wann die Änderung gilt.');
    expect(zeilenVon(nachWirkung)[0].zeit).toBe('10:40');

    const nachEintrag = protokollListe([seite([eintrag()], { achse: 'eintrag' })], JETZT);
    expect(nachEintrag.achse).toBe('eintrag');
    expect(nachEintrag.achseSatz).toBe('Sortiert danach, wann die Änderung eingetragen wurde.');
    expect(zeilenVon(nachEintrag)[0].zeit).toBe('11:05');
  });

  it('setzt bei jedem Tageswechsel eine Datumszeile — Heute, Gestern, sonst das Datum', () => {
    const view = protokollListe(
      [
        seite([
          eintrag({ id: 'messstelle:3', gilt_ab: '2026-11-18T09:00:00+01:00' }),
          eintrag({ id: 'messstelle:2', gilt_ab: '2026-11-17T09:00:00+01:00' }),
          eintrag({ id: 'messstelle:1', gilt_ab: '2026-10-01T09:12:00+02:00' }),
        ]),
      ],
      JETZT,
    );
    expect(view.eintraege.filter((e) => e.art === 'tag').map((e) => (e as { text: string }).text))
      .toEqual(['Heute', 'Gestern', 'Donnerstag, 1. Oktober 2026']);
    expect(view.zeilen).toBe(3);
  });

  it('zeigt eine doppelt gelieferte Grenzzeile genau einmal', () => {
    const view = protokollListe(
      [seite([eintrag({ id: 'messstelle:9' })], { weiter: 'x' }), seite([eintrag({ id: 'messstelle:9' })])],
      JETZT,
    );
    expect(view.zeilen).toBe(1);
  });

  it('bietet „Ältere laden" nur mit Fortsetzungszeiger an', () => {
    expect(protokollListe([seite([eintrag()])], JETZT).mehrMoeglich).toBe(false);
    const mehr = protokollListe([seite([eintrag()], { weiter: '1763458800000:messstelle:42' })], JETZT);
    expect(mehr.mehrMoeglich).toBe(true);
    expect(mehr.weiter).toBe('1763458800000:messstelle:42');
  });

  it('sagt „noch nichts geändert" erst, wenn wirklich geladen wurde', () => {
    expect(protokollListe([null], JETZT).leer).toBeNull();
    expect(protokollListe([seite([])], JETZT).leer).toBe('Hier wurde noch nichts geändert.');
  });

  it('mischt im Unternehmens-Weg die Herkünfte und nennt je Zeile ihr Objekt', () => {
    const view = protokollListe(
      [
        seite([
          eintrag(),
          eintrag({
            id: 'ort:7',
            quelle: 'ort',
            art: 'angelegt',
            text: 'Anlage angelegt: Werk Lindach',
            bezug: { art: 'anlage', id: 'a', kennzeichen: null, name: 'Werk Lindach' },
            urheber: { name: 'VoltPilot (Bestandsübernahme)', rolle: null, art: 'voltpilot' },
            zeitform: 'sofort',
            grund: null,
          }),
        ]),
      ],
      JETZT,
      { mitBezug: true },
    );
    expect(zeilenVon(view).map((z) => z.bezug)).toEqual(['MS-06 · Hauptzähler Werk', 'Werk Lindach']);
    expect(zeilenVon(view)[1].urheber).toBe('VoltPilot (Bestandsübernahme)');
  });
});

describe('der Tag einer Gruppe', () => {
  it('nennt einen Zeitpunkt ohne lesbaren Tag ehrlich', () => {
    expect(tagText(null, JETZT)).toBe('Zeitpunkt unbekannt');
  });

  it('rechnet auf dem BERLINER Kalendertag', () => {
    // 23:30 UTC am 17.11. ist in Berlin schon der 18.11. — also „Heute".
    expect(tagText('2026-11-18', JETZT)).toBe('Heute');
    expect(zeile(eintrag({ gilt_ab: '2026-11-17T23:30:00Z' }), 'wirkung', false).tag).toBe('2026-11-18');
  });
});

describe('der Weg von der Komponente zum Gerät', () => {
  const geraet = (over: Partial<UemsGeraet> = {}): UemsGeraet => ({
    id: 'g-1',
    kennzeichen: 'GR-4',
    einbau_kennzeichen: 'Z-5b',
    ausgebaut_am: null,
    komponenten: [{ entity_id: 'k-5', gueltig_ab: WECHSEL, gueltig_bis: null }],
    ...over,
  });

  it('findet den eingebauten Einbau mit laufender Speisung', () => {
    expect(geraetZuKomponenten([geraet()], ['k-5'])?.id).toBe('g-1');
  });

  it('nimmt weder ein ausgebautes Gerät noch eine beendete Speisung', () => {
    expect(geraetZuKomponenten([geraet({ ausgebaut_am: WECHSEL })], ['k-5'])).toBeNull();
    expect(
      geraetZuKomponenten(
        [geraet({ komponenten: [{ entity_id: 'k-5', gueltig_ab: WECHSEL, gueltig_bis: WECHSEL }] })],
        ['k-5'],
      ),
    ).toBeNull();
  });

  it('antwortet mit null statt mit einem fremden Gerät', () => {
    expect(geraetZuKomponenten([geraet()], ['k-9'])).toBeNull();
    expect(geraetZuKomponenten([], ['k-5'])).toBeNull();
    expect(geraetZuKomponenten(null, ['k-5'])).toBeNull();
    expect(geraetZuKomponenten([geraet()], [])).toBeNull();
  });
});

describe('der Achsen-Satz', () => {
  it('sagt in beiden Fällen, welche Zeit die Reihenfolge macht', () => {
    expect(achseSatz('wirkung')).toContain('ab wann die Änderung gilt');
    expect(achseSatz('eintrag')).toContain('wann die Änderung eingetragen wurde');
  });
});

function zeilenVon(view: ReturnType<typeof protokollListe>) {
  return view.eintraege.flatMap((e) => (e.art === 'zeile' ? [e.zeile] : []));
}
