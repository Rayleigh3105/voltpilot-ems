import { describe, expect, it } from 'vitest';
import {
  anlagenAmStandort,
  entwurfLesen,
  entwurfSchreiben,
  entwurfVerwerfen,
  ENTWURF_SCHLUESSEL,
  GEBAUTE_SCHRITTE,
  istBereitsAngelegt,
  keineAnlageSatz,
  keineAnlageWeg,
  MESSANLAGE_ANLEGEN,
  MESSANLAGE_RUECKKEHR,
  komponentenSatz,
  MESSEN_SCHRITTE,
  messenEinstieg,
  messenEinstiegeDerKarte,
  mussEinrichten,
  schrittZaehler,
  standortMessenSatz,
  startSchritt,
  vor,
  weitesterSchritt,
  zurueck,
  type EntwurfSpeicher,
  type MessenSchritt,
} from './messenAssistent';
import {
  ahrenbergFunktionen,
  funktionMessenEntwurf,
  funktionWerkAhrenberg,
  funktionWerkLindach,
} from './test/funktionenFixtures';
import { FIXTURE_IDS, werkAhrenberg, werkLindach } from './test/standorteFixtures';
import { steuerGeldWoerter } from './anlegeNurMessen';

/**
 * Der Rahmen des Assistenten „Messen & Auswerten" (UEMS AP-01 IP-9a) als reine
 * Regel: Schrittfolge und Zähler, der Entwurf im Browser, Start und
 * Wiedereinstieg. Die Fläche prüft `components/MessenAssistent.test.tsx`.
 */

const ALLE: MessenSchritt[] = [1, 2, 3, 4, 5];
/** Der Rahmen, wie IP-9a ihn trug — eine Bühne kann weniger Schritte tragen als das Portal. */
const IP9A: MessenSchritt[] = [1, 2];

function speicher(): EntwurfSpeicher & { daten: Map<string, string> } {
  const daten = new Map<string, string>();
  return {
    daten,
    getItem: (k) => daten.get(k) ?? null,
    setItem: (k, v) => void daten.set(k, v),
    removeItem: (k) => void daten.delete(k),
  };
}

const LINDACH = FIXTURE_IDS.st2;
const lindachOhne = () => funktionWerkLindach('bestand');
const lindachEntwurf = () => funktionMessenEntwurf(funktionWerkLindach('bestand'));
const mitLindach = (lindach = lindachEntwurf()) =>
  ahrenbergFunktionen({ standorte: [funktionWerkAhrenberg(), lindach] });

describe('messenAssistent — Schrittfolge', () => {
  it('nennt die fünf Schritte des Konzepts und zählt „Schritt n von 5"', () => {
    expect(MESSEN_SCHRITTE).toEqual(['Standort', 'Datenquelle', 'Messstellen', 'Prüfen', 'Fertig']);
    expect(ALLE.map(schrittZaehler)).toEqual([
      'Schritt 1 von 5',
      'Schritt 2 von 5',
      'Schritt 3 von 5',
      'Schritt 4 von 5',
      'Schritt 5 von 5',
    ]);
  });

  it('geht vorwärts nur in gebaute Schritte und rückwärts bis Schritt 1', () => {
    expect(vor(1, IP9A)).toBe(2);
    expect(vor(2, IP9A)).toBeNull();
    expect(zurueck(2)).toBe(1);
    expect(zurueck(1)).toBeNull();
    expect(weitesterSchritt(IP9A)).toBe(2);
  });

  it('seit IP-9b trägt das Portal alle fünf Schritte', () => {
    expect(GEBAUTE_SCHRITTE).toEqual(ALLE);
    expect(vor(2)).toBe(3);
    expect(vor(4)).toBe(5);
    expect(vor(5)).toBeNull();
    expect(weitesterSchritt()).toBe(5);
  });

  it('trägt eine Fläche die Schritte 3 bis 5, läuft derselbe Rahmen vorwärts bis „Fertig" und zurück', () => {
    const hin: MessenSchritt[] = [];
    for (let s: MessenSchritt | null = 1; s !== null; s = vor(s, ALLE)) hin.push(s);
    expect(hin).toEqual(ALLE);
    const her: MessenSchritt[] = [];
    for (let s: MessenSchritt | null = 5; s !== null; s = zurueck(s)) her.push(s);
    expect(her).toEqual([5, 4, 3, 2, 1]);
    expect(weitesterSchritt(ALLE)).toBe(5);
    // Nie über eine Lücke: fehlt Schritt 3, endet der Weg auf 2.
    expect(vor(2, [1, 2, 4, 5])).toBeNull();
    expect(weitesterSchritt([1, 2, 4, 5])).toBe(2);
  });
});

describe('messenAssistent — Entwurf im Browser', () => {
  it('bewahrt Standort und Schritt über einen Abbruch hinweg', () => {
    const s = speicher();
    entwurfSchreiben(s, { standortId: LINDACH, schritt: 2 });
    expect(entwurfLesen(s)).toEqual({ standortId: LINDACH, schritt: 2 });
    entwurfVerwerfen(s);
    expect(entwurfLesen(s)).toBeNull();
  });

  it('liest einen kaputten oder fremden Eintrag als „kein Entwurf", nie als Fehler', () => {
    const s = speicher();
    for (const roh of ['{', 'null', '{"schritt":7,"standortId":null}', '{"schritt":2,"standortId":4}', '{"schritt":1.5}']) {
      s.daten.set(ENTWURF_SCHLUESSEL, roh);
      expect(entwurfLesen(s)).toBeNull();
    }
    expect(entwurfLesen(null)).toBeNull();
  });

  it('ein gesperrter Speicher wirft nie bis in die Fläche', () => {
    const gesperrt: EntwurfSpeicher = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(entwurfLesen(gesperrt)).toBeNull();
    expect(() => entwurfSchreiben(gesperrt, { standortId: null, schritt: 1 })).not.toThrow();
    expect(() => entwurfVerwerfen(gesperrt)).not.toThrow();
  });
});

describe('messenAssistent — Start und Wiedereinstieg', () => {
  it('die Regel `messen()` nennt den Standort nach Schritt 1 „Entwurf"', () => {
    expect(lindachEntwurf().messen.zustand).toBe('entwurf');
  });

  it('ohne Standort beginnt Schritt 1 ohne Vorwahl; ohne Objekt Schritt 1 mit Vorwahl', () => {
    expect(startSchritt({ funktionen: mitLindach(), entwurf: null })).toEqual({ standortId: null, schritt: 1 });
    expect(startSchritt({ standortId: LINDACH, funktionen: mitLindach(lindachOhne()), entwurf: null })).toEqual({
      standortId: LINDACH,
      schritt: 1,
    });
    // Der Entwurf kennt den Standort, der Server noch keine Funktion: zurück auf Schritt 1, vorgewählt.
    expect(
      startSchritt({ funktionen: mitLindach(lindachOhne()), entwurf: { standortId: LINDACH, schritt: 2 } }),
    ).toEqual({ standortId: LINDACH, schritt: 1 });
  });

  it('kennt der Server die Funktion, landet der Wiedereinstieg auf Schritt 2 — auch ohne Entwurf im Browser', () => {
    expect(startSchritt({ standortId: LINDACH, funktionen: mitLindach(), entwurf: null })).toEqual({
      standortId: LINDACH,
      schritt: 2,
    });
    expect(startSchritt({ funktionen: mitLindach(), entwurf: { standortId: LINDACH, schritt: 1 } })).toEqual({
      standortId: LINDACH,
      schritt: 2,
    });
  });

  it('der gemerkte Schritt gilt nur für seinen Standort und nie über den weitesten gebauten hinaus', () => {
    const entwurf = { standortId: LINDACH, schritt: 4 as MessenSchritt };
    expect(startSchritt({ standortId: LINDACH, funktionen: mitLindach(), entwurf, gebaut: IP9A })).toEqual({
      standortId: LINDACH,
      schritt: 2,
    });
    expect(startSchritt({ standortId: LINDACH, funktionen: mitLindach(), entwurf, gebaut: ALLE })).toEqual({
      standortId: LINDACH,
      schritt: 4,
    });
    const ahrenberg = funktionMessenEntwurf(funktionWerkAhrenberg('bestand'));
    const zwei = ahrenbergFunktionen({ standorte: [ahrenberg, lindachEntwurf()] });
    expect(startSchritt({ standortId: ahrenberg.id, funktionen: zwei, entwurf, gebaut: ALLE })).toEqual({
      standortId: ahrenberg.id,
      schritt: 2,
    });
  });

  it('einen Standort, den der Server nicht mehr nennt, wählt der Kunde neu; ohne Funktionen bleibt die Vorwahl', () => {
    const ohneLindach = ahrenbergFunktionen({ standorte: [funktionWerkAhrenberg()] });
    expect(startSchritt({ standortId: LINDACH, funktionen: ohneLindach, entwurf: null })).toEqual({
      standortId: null,
      schritt: 1,
    });
    expect(startSchritt({ standortId: LINDACH, funktionen: null, entwurf: null })).toEqual({
      standortId: LINDACH,
      schritt: 1,
    });
  });

  it('der Einstieg aus der Karte heißt „einrichten" ohne Objekt und „Einrichtung fortsetzen (Schritt 2 von 5)" im Entwurf', () => {
    expect(messenEinstieg(lindachOhne(), null)).toEqual({
      text: 'Messen & Auswerten für Werk Lindach einrichten',
      start: { standortId: LINDACH, schritt: 1 },
    });
    expect(messenEinstieg(lindachEntwurf(), { standortId: LINDACH, schritt: 2 })).toEqual({
      text: 'Einrichtung fortsetzen (Schritt 2 von 5)',
      start: { standortId: LINDACH, schritt: 2 },
    });
    expect(messenEinstieg(lindachEntwurf(), { standortId: LINDACH, schritt: 3 }, ALLE)?.text).toBe(
      'Einrichtung fortsetzen (Schritt 3 von 5)',
    );
    expect(messenEinstieg(funktionWerkLindach('eingerichtet'), null)).toBeNull();
  });

  it('die Karte bekommt je Standort den Einstieg — nur mit Anlage, nie bei „aktiv“ (AP-01 E5 = A)', () => {
    const ohneAnlage = { ...lindachOhne(), steuern: { ...lindachOhne().steuern, anlagen: [] } };
    const f = ahrenbergFunktionen({ standorte: [funktionWerkAhrenberg('eingerichtet'), lindachEntwurf()] });
    const karte = messenEinstiegeDerKarte(f, { standortId: LINDACH, schritt: 3 });
    expect([...karte.keys()]).toEqual([LINDACH]);
    expect(karte.get(LINDACH)).toEqual({
      text: 'Einrichtung fortsetzen (Schritt 3 von 5)',
      start: { standortId: LINDACH, schritt: 3 },
    });
    expect(messenEinstiegeDerKarte(ahrenbergFunktionen({ standorte: [ohneAnlage] }), null).size).toBe(0);
    expect(messenEinstiegeDerKarte(null, null).size).toBe(0);
  });

  it('ein Einstieg mit Ziel-Schritt („Daten kommen an“ → 2) gilt nur, wo die Funktion besteht', () => {
    const f = ahrenbergFunktionen({ standorte: [lindachEntwurf()] });
    const entwurf = { standortId: LINDACH, schritt: 4 as MessenSchritt };
    expect(startSchritt({ standortId: LINDACH, funktionen: f, entwurf, wunsch: 2 })).toEqual({ standortId: LINDACH, schritt: 2 });
    expect(startSchritt({ standortId: LINDACH, funktionen: f, entwurf })).toEqual({ standortId: LINDACH, schritt: 4 });
    const ohne = ahrenbergFunktionen({ standorte: [lindachOhne()] });
    expect(startSchritt({ standortId: LINDACH, funktionen: ohne, entwurf: null, wunsch: 2 })).toEqual({ standortId: LINDACH, schritt: 1 });
    expect(startSchritt({ standortId: LINDACH, funktionen: null, entwurf: null, wunsch: 2 })).toEqual({ standortId: LINDACH, schritt: 1 });
  });
});

describe('messenAssistent — Schritt 1 und Schritt 2', () => {
  it('Schritt 1 legt die Funktion nur ohne Objekt an — unbekannt heißt: den Server fragen', () => {
    expect(mussEinrichten(lindachOhne())).toBe(true);
    expect(mussEinrichten(null)).toBe(true);
    expect(mussEinrichten(lindachEntwurf())).toBe(false);
    expect(mussEinrichten(funktionWerkLindach('eingerichtet'))).toBe(false);
  });

  it('„bereits angelegt" ist ein 409 mit genau diesem Code — jede andere Ablehnung bleibt ein Fehler', () => {
    expect(istBereitsAngelegt({ status: 409, body: { code: 'bereits_angelegt' } })).toBe(true);
    expect(istBereitsAngelegt({ status: 409, body: { code: 'standort_archiviert' } })).toBe(false);
    expect(istBereitsAngelegt({ status: 404, body: { code: 'nicht_gefunden' } })).toBe(false);
    expect(istBereitsAngelegt(new Error('Netz'))).toBe(false);
    expect(istBereitsAngelegt(null)).toBe(false);
  });

  it('der Satz unter der Wahl ist der des Servers, mit dem Namen der Funktion', () => {
    expect(standortMessenSatz(lindachOhne())).toBe('Messen & Auswerten — noch nicht eingerichtet');
    expect(standortMessenSatz(funktionWerkLindach('eingerichtet'))).toBe(
      'Messen & Auswerten: Eingerichtet am 15.10.2026',
    );
    expect(standortMessenSatz(null)).toBeNull();
  });

  it('Schritt 2 bindet an den Anlagen des Standorts an und zählt Komponenten nie als 0, solange sie unbekannt sind', () => {
    expect(anlagenAmStandort(werkAhrenberg())).toEqual([
      { id: FIXTURE_IDS.an1, name: 'Werk Ahrenberg – Halle 1' },
      { id: FIXTURE_IDS.an2, name: 'Werk Ahrenberg – Halle 2' },
    ]);
    expect(anlagenAmStandort(werkLindach({ anlagen: [], anlagenZahl: 0 }))).toEqual([]);
    expect(komponentenSatz(null)).toBeNull();
    expect(komponentenSatz(0)).toBe('Noch keine Komponente angebunden');
    expect(komponentenSatz(1)).toBe('1 Komponente angebunden');
    expect(komponentenSatz(4)).toBe('4 Komponenten angebunden');
  });

  it('ohne Anlage nennt Schritt 2 den Zustand UND den Knopf, der die Messanlage hier anlegt — nie nur, was fehlt', () => {
    expect(keineAnlageSatz('Werk Lindach')).toBe('An Werk Lindach hängt noch keine Anlage.');
    expect(keineAnlageWeg('Werk Lindach')).toBe(
      'Legen Sie hier eine Messanlage an. Sie gehört dann zu Werk Lindach, und die Einrichtung geht hier weiter.',
    );
    expect(MESSANLAGE_ANLEGEN).toBe('Messanlage anlegen');
    // Das Ende des Anlage-Assistenten führt hierher zurück — Satz und Knopf schweigen über Steuern und Geld.
    expect(MESSANLAGE_RUECKKEHR).toEqual({
      satz: 'So geht es weiter: In „Messen & Auswerten“ wählen Sie, womit an dieser Anlage gemessen wird.',
      knopf: 'Weiter mit „Messen & Auswerten“',
    });
    for (const text of [keineAnlageWeg('Werk Lindach'), MESSANLAGE_ANLEGEN, MESSANLAGE_RUECKKEHR.satz, MESSANLAGE_RUECKKEHR.knopf]) {
      expect(steuerGeldWoerter(text), text).toEqual([]);
    }
  });
});
