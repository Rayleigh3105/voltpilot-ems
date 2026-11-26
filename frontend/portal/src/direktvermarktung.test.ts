import { describe, expect, it } from 'vitest';
import {
  anzeige,
  einstellungszeileDetail,
  fortschrittIndex,
  lageFor,
  partnerFragtNichtAb,
  verbindungsbild,
  wohinDerStromGeht,
  type DirektvermarktungEintrag,
  type DirektvermarktungStandDaten,
} from './direktvermarktung';

const JETZT = new Date('2026-11-25T12:00:00Z');

function stand(partial: Partial<DirektvermarktungStandDaten>): DirektvermarktungStandDaten {
  return {
    tunnelObenSeit: null,
    handshakeAm: null,
    gegenstelle: null,
    letzteAbfrageAm: null,
    abfragenJeMinute: null,
    letzteSchreibungAm: null,
    vorgabePct: null,
    lebenszeichenAm: null,
    einspeisungW: null,
    erzeugungW: null,
    netzbetreiberPct: null,
    referenzW: null,
    ...partial,
  };
}

function vorMinuten(minuten: number): string {
  return new Date(JETZT.getTime() - minuten * 60000).toISOString();
}

function eintrag(partial: Partial<DirektvermarktungEintrag>): DirektvermarktungEintrag {
  return {
    id: 'e1',
    partner: 'luox',
    zustand: 'verbunden',
    zustimmungAm: null,
    zustimmungVon: null,
    startdatum: null,
    ende: null,
    revision: 1,
    ...partial,
  };
}

describe('lageFor (Konzept §5.4 "Lagen des Anschlusses")', () => {
  it('ohne jede Meldung ist die Lage unbekannt, nie getrennt', () => {
    expect(lageFor(null, JETZT)).toBe('unbekannt');
  });

  it('ohne Handshake baut der Tunnel noch auf', () => {
    expect(lageFor(stand({ handshakeAm: null }), JETZT)).toBe('baut_auf');
  });

  it('ein alter Handshake heißt tunnel_unten, auch mit alter Abfrage', () => {
    expect(lageFor(stand({ handshakeAm: vorMinuten(10), letzteAbfrageAm: vorMinuten(1) }), JETZT))
        .toBe('tunnel_unten');
  });

  it('frischer Handshake ohne jede Abfrage: luox fragt noch nicht ab', () => {
    expect(lageFor(stand({ handshakeAm: vorMinuten(1), letzteAbfrageAm: null }), JETZT)).toBe('tunnel_oben');
  });

  it('frisches Lebenszeichen mit Vorgabe unter 100% ist vorgabe_aktiv', () => {
    expect(lageFor(stand({
      handshakeAm: vorMinuten(1), letzteAbfrageAm: vorMinuten(1), lebenszeichenAm: vorMinuten(1), vorgabePct: 30,
    }), JETZT)).toBe('vorgabe_aktiv');
  });

  it('abgelaufenes Lebenszeichen (über 15 Min.) ist abgelaufen, die Grenze fällt', () => {
    expect(lageFor(stand({
      handshakeAm: vorMinuten(1), letzteAbfrageAm: vorMinuten(1), lebenszeichenAm: vorMinuten(20), vorgabePct: 30,
    }), JETZT)).toBe('abgelaufen');
  });

  it('frisches Lebenszeichen mit 100% ist schlicht verbunden (frei)', () => {
    expect(lageFor(stand({
      handshakeAm: vorMinuten(1), letzteAbfrageAm: vorMinuten(1), lebenszeichenAm: vorMinuten(1), vorgabePct: 100,
    }), JETZT)).toBe('verbunden');
  });

  it('luox fragt seit 60 Minuten nicht ab, unabhängig von der Lage', () => {
    expect(partnerFragtNichtAb(stand({ letzteAbfrageAm: vorMinuten(61) }), JETZT)).toBe(true);
    expect(partnerFragtNichtAb(stand({ letzteAbfrageAm: vorMinuten(59) }), JETZT)).toBe(false);
    expect(partnerFragtNichtAb(null, JETZT)).toBe(false);
  });
});

describe('anzeige (§7.6 "Texte und Zustände")', () => {
  it('ohne Eintrag: Nicht verbunden, grau', () => {
    expect(anzeige(null, null, null, JETZT)).toEqual({ statuszeile: 'Nicht verbunden', farbe: 'grau' });
  });

  it('ein beendeter Eintrag zählt wie kein Eintrag', () => {
    expect(anzeige(eintrag({ zustand: 'beendet' }), 'luox energy', null, JETZT))
        .toEqual({ statuszeile: 'Nicht verbunden', farbe: 'grau' });
  });

  it('im Entwurf: Einrichtung mit dem Partnernamen, grau', () => {
    expect(anzeige(eintrag({ zustand: 'entwurf' }), 'luox energy', null, JETZT))
        .toEqual({ statuszeile: 'Einrichtung mit luox energy', farbe: 'grau' });
  });

  it('verbunden und frei: grün, mit Alter der letzten Abfrage', () => {
    const a = anzeige(eintrag({ zustand: 'verbunden' }), 'luox energy', stand({
      handshakeAm: vorMinuten(1), letzteAbfrageAm: vorMinuten(2), lebenszeichenAm: vorMinuten(1), vorgabePct: 100,
    }), JETZT);
    expect(a.farbe).toBe('gruen');
    expect(a.statuszeile).toContain('Verbunden mit luox energy');
    expect(a.statuszeile).toContain('vor 2 Min.');
  });

  it('luox begrenzt: Bernstein, nie Rot (§7.2 Regel 5 - Begrenzen ist kein Fehler)', () => {
    const a = anzeige(eintrag({ zustand: 'verbunden' }), 'luox energy', stand({
      handshakeAm: vorMinuten(1), letzteAbfrageAm: vorMinuten(1), lebenszeichenAm: vorMinuten(1), vorgabePct: 0,
    }), JETZT);
    expect(a.farbe).toBe('bernstein');
    expect(a.statuszeile).toContain('begrenzt auf 0 %');
  });

  it('endet am Stichtag', () => {
    expect(anzeige(eintrag({ zustand: 'endet', ende: '2026-11-30' }), 'luox energy', null, JETZT))
        .toEqual({ statuszeile: 'Endet am 30.11.2026', farbe: 'grau' });
  });
});

describe('fortschrittIndex (§7.5 "Fortschritt")', () => {
  it('ohne Eintrag: vor der Wahl', () => {
    expect(fortschrittIndex(null)).toBe(-1);
  });

  it('Entwurf ohne Zustimmung: Station 0 (Gewählt)', () => {
    expect(fortschrittIndex(eintrag({ zustand: 'entwurf', zustimmungAm: null }))).toBe(0);
  });

  it('Entwurf mit Zustimmung: Station 1 (Zugestimmt)', () => {
    expect(fortschrittIndex(eintrag({ zustand: 'entwurf', zustimmungAm: '2026-11-25T10:00:00Z' }))).toBe(1);
  });

  it('wartet_auf_zugang: Station 2 (Zugang)', () => {
    expect(fortschrittIndex(eintrag({ zustand: 'wartet_auf_zugang' }))).toBe(2);
  });

  it('verbunden: Station 4 (luox prüft)', () => {
    expect(fortschrittIndex(eintrag({ zustand: 'verbunden' }))).toBe(4);
  });
});

describe('verbindungsbild (§7.5 "Verbindungsbild")', () => {
  it('vor der Einrichtung: beide Strecken offen, kein Haken', () => {
    expect(verbindungsbild(null, null, JETZT)).toEqual({
      zeigen: true, anlageBox: 'offen', boxPartner: 'offen', partnerWarnung: false,
    });
  });

  it('im Entwurf: ebenfalls beide Strecken offen', () => {
    expect(verbindungsbild(eintrag({ zustand: 'entwurf' }), null, JETZT).boxPartner).toBe('offen');
  });

  it('Tunnel baut auf: Anlage-Box fest, Box-Partner läuft', () => {
    const s = verbindungsbild(eintrag({ zustand: 'verbindet' }), stand({ handshakeAm: null }), JETZT);
    expect(s).toEqual({ zeigen: true, anlageBox: 'fest', boxPartner: 'laufend', partnerWarnung: false });
  });

  it('getrennt (tunnel_unten): Box-Partner-Strecke bricht, Warnzeichen am Partner', () => {
    const s = verbindungsbild(eintrag({ zustand: 'gestoert' }), stand({ handshakeAm: vorMinuten(10) }), JETZT);
    expect(s).toEqual({ zeigen: true, anlageBox: 'fest', boxPartner: 'bruch', partnerWarnung: true });
  });

  it('ruhiger Alltag (verbunden, frei): das Bild tritt zurück, die große Zahl übernimmt', () => {
    const s = verbindungsbild(eintrag({ zustand: 'verbunden' }), stand({
      handshakeAm: vorMinuten(1), letzteAbfrageAm: vorMinuten(1), lebenszeichenAm: vorMinuten(1), vorgabePct: 100,
    }), JETZT);
    expect(s.zeigen).toBe(false);
  });

  it('luox begrenzt: ebenfalls zurück - die Zahl und der Bernstein-Chip tragen die Aussage', () => {
    const s = verbindungsbild(eintrag({ zustand: 'verbunden' }), stand({
      handshakeAm: vorMinuten(1), letzteAbfrageAm: vorMinuten(1), lebenszeichenAm: vorMinuten(1), vorgabePct: 0,
    }), JETZT);
    expect(s.zeigen).toBe(false);
  });
});

describe('wohinDerStromGeht', () => {
  it('ohne beide Werte: null, nie eine erfundene Null', () => {
    expect(wohinDerStromGeht(null)).toBeNull();
    expect(wohinDerStromGeht(stand({ einspeisungW: null, erzeugungW: 1000 }))).toBeNull();
  });

  it('Haus ist Erzeugung minus Einspeisung, Netz ist die Einspeisung', () => {
    expect(wohinDerStromGeht(stand({ einspeisungW: 12345, erzeugungW: 14100 }))).toEqual({
      hausW: 1755, netzW: 12345,
    });
  });

  it('beide 0: null statt einer leeren Leiste', () => {
    expect(wohinDerStromGeht(stand({ einspeisungW: 0, erzeugungW: 0 }))).toBeNull();
  });
});

describe('einstellungszeileDetail (§7.3 "Einstieg", zweite Zeile)', () => {
  it('ohne Stand: null', () => {
    expect(einstellungszeileDetail(null, JETZT)).toBeNull();
  });

  it('mit Abfrage und Vorgabe: beide Teile, durch · getrennt', () => {
    expect(einstellungszeileDetail(stand({ letzteAbfrageAm: vorMinuten(2), vorgabePct: 100 }), JETZT))
        .toBe('Letzte Abfrage vor 2 Min. · Vorgabe 100 %');
  });

  it('nur Vorgabe bekannt: nur dieser Teil', () => {
    expect(einstellungszeileDetail(stand({ letzteAbfrageAm: null, vorgabePct: 30 }), JETZT))
        .toBe('Vorgabe 30 %');
  });

  it('nichts davon bekannt: null, keine leere Zeile', () => {
    expect(einstellungszeileDetail(stand({ letzteAbfrageAm: null, vorgabePct: null }), JETZT)).toBeNull();
  });
});
