import { describe, expect, it } from 'vitest';
import {
  entfernenFolgen,
  fahrzeugName,
  fahrzeugZeilen,
  folgen,
  kartenKurz,
  KEINE_KARTEN,
  OHNE_STEUERART,
  sichtungText,
  steuerartChip,
  verlaufFahrzeug,
  VERLAUF_AENDERN,
  VERLAUF_BENENNEN,
  wunschAus,
  type Fahrzeug,
} from './fahrzeugProfile';

const CARD = 'tagref_1f2e3d4c5b6a798877665544';

function f(over: Partial<Fahrzeug> = {}): Fahrzeug {
  return { tagRef: CARD, ...over };
}

describe('die Karte hat einen Namen, den ein Mensch wiedererkennt', () => {
  it('nennt den Kundennamen, wo es einen gibt', () => {
    expect(fahrzeugName(f({ name: 'Dienstwagen' }))).toBe('Dienstwagen');
  });

  // ⚠ Der Klartext der Karte verlässt die Box nie - das Portal kennt nur das
  // Pseudonym. Die vier Zeichen sind das, woran ein Kunde die Zeile
  // wiedererkennt; der ganze Bezug hülfe niemandem.
  it('faellt sonst auf die KURZFORM des Pseudonyms zurueck, nie auf etwas Erfundenes', () => {
    expect(fahrzeugName(f())).toBe('Karte 1f2e…');
    expect(kartenKurz(CARD)).toBe('1f2e');
    expect(CARD).toContain(kartenKurz(CARD));
  });

  it('behauptet ohne brauchbare Kennung gar nichts', () => {
    expect(fahrzeugName({ tagRef: 'kaputt' })).toBe('Unbekannte Karte');
    expect(kartenKurz(undefined)).toBe('');
  });
});

describe('die Steuerart einer Karte', () => {
  it('nennt die Quelle, und den Boden nur wo er gilt', () => {
    expect(steuerartChip(f({ steuerart: { quelle: 'sofort', herkunft: 'policy' } })))
      .toBe('Sofort laden');
    expect(steuerartChip(f({
      steuerart: { quelle: 'ueberschuss', herkunft: 'policy', ueberschussModus: 'pausieren' },
    }))).toBe('Solar-Überschuss');
    expect(steuerartChip(f({
      steuerart: {
        quelle: 'ueberschuss', herkunft: 'policy',
        ueberschussModus: 'mindestleistung', mindestleistungKw: 4.2,
      },
    }))).toBe('Solar-Überschuss (mind. 4,2 kW)');
  });

  // ⚠ Ohne Profil wird KEINE Steuerart behauptet: die Karte faehrt die Bahn
  // ihres Ladepunkts, und genau das sagt die Zeile.
  it('sagt ohne Profil, dass der Ladepunkt entscheidet', () => {
    expect(steuerartChip(f())).toBe(OHNE_STEUERART);
  });
});

describe('die Sichtung', () => {
  const now = Date.parse('2026-08-31T12:00:00Z');

  it('sagt heute, gestern und danach das Datum', () => {
    expect(sichtungText(f({ letzteSichtungAm: '2026-08-31T09:15:00Z' }), now))
      .toMatch(/^zuletzt heute, /);
    expect(sichtungText(f({ letzteSichtungAm: '2026-08-30T18:42:00Z' }), now))
      .toMatch(/^zuletzt gestern, /);
    expect(sichtungText(f({ letzteSichtungAm: '2026-08-28T18:42:00Z' }), now))
      .toBe('zuletzt vor 3 Tagen');
    expect(sichtungText(f({ letzteSichtungAm: '2026-08-01T18:42:00Z' }), now))
      .toMatch(/^zuletzt am /);
  });

  // ⚠ „Laedt gerade" kommt aus dem HERZSCHLAG, nie aus einer frischen
  // Sichtungszeit: „vor zwei Minuten gesehen" ist keine laufende Ladung.
  it('nennt eine laufende Ladung nur, wenn die Box sie meldet', () => {
    expect(sichtungText(f({ letzteSichtungAm: '2026-08-31T11:59:00Z' }), now))
      .toMatch(/^zuletzt heute, /);
    expect(sichtungText(f({ letzteSichtungAm: '2026-08-31T11:59:00Z', laedt: true }), now))
      .toBe('lädt gerade');
  });

  it('behauptet ohne Zeitstempel nichts', () => {
    expect(sichtungText(f(), now)).toBeNull();
    expect(sichtungText(f({ letzteSichtungAm: 'kaputt' }), now)).toBeNull();
  });
});

describe('die Zeilen', () => {
  it('stellt das, was gerade laedt, nach oben - sonst bleibt die Server-Reihenfolge', () => {
    const zeilen = fahrzeugZeilen({
      fahrzeuge: [
        f({ tagRef: 'tagref_aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Erster' }),
        f({ tagRef: 'tagref_bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Zweiter', laedt: true }),
        f({ tagRef: 'tagref_cccccccccccccccccccccccc', name: 'Dritter' }),
      ],
    });
    expect(zeilen.map((z) => z.name)).toEqual(['Zweiter', 'Erster', 'Dritter']);
  });

  it('nennt den Ladepunkt beim NAMEN, wo einer bekannt ist', () => {
    const [z] = fahrzeugZeilen({ fahrzeuge: [f({ letzterLadepunkt: 'saeule-1' })] },
      (id) => (id === 'saeule-1' ? 'Hof Nord' : null));
    expect(z.ort).toBe('an Hof Nord');
    const [ohne] = fahrzeugZeilen({ fahrzeuge: [f({ letzterLadepunkt: 'saeule-9' })] });
    expect(ohne.ort).toBe('an saeule-9');
  });

  it('behauptet ohne gemeldeten Ladepunkt keinen Ort', () => {
    expect(fahrzeugZeilen({ fahrzeuge: [f()] })[0].ort).toBeNull();
  });

  it('ist ohne Daten leer und die Flaeche hat dafuer einen Satz', () => {
    expect(fahrzeugZeilen(null)).toEqual([]);
    expect(KEINE_KARTEN).toContain('Sobald jemand hier lädt');
  });
});

describe('der PUT-Rumpf', () => {
  it('traegt nur, was die Wahl wirklich fragt', () => {
    expect(wunschAus({ name: '  Dienstwagen ' })).toEqual({ name: 'Dienstwagen' });
    expect(wunschAus({ quelle: 'sofort' })).toEqual({ quelle: 'sofort' });
  });

  // ⚠ Der Boden reist NUR mit, wenn er auch gemeint ist: bei „pausieren" waere
  // er ein verborgener Wert, den der Server als „sonne_zuerst" missverstehen
  // koennte.
  it('schickt die Mindestleistung nur bei „Mindestleistung halten"', () => {
    expect(wunschAus({ quelle: 'ueberschuss', mindestleistungKw: 4.2 }))
      .toEqual({ quelle: 'ueberschuss', ueberschussModus: 'pausieren' });
    expect(wunschAus({
      quelle: 'ueberschuss', ueberschussModus: 'mindestleistung', mindestleistungKw: 4.2,
    })).toEqual({
      quelle: 'ueberschuss', ueberschussModus: 'mindestleistung', mindestleistungKw: 4.2,
    });
  });

  it('laesst ein nicht genanntes Feld weg - benennen und steuern sind zwei Schritte', () => {
    expect(wunschAus({ name: 'Nur ein Name' }).quelle).toBeUndefined();
    expect(wunschAus({ quelle: 'sofort' }).name).toBeUndefined();
  });
});

describe('die Folgen-Karte', () => {
  it('sagt ohne Quelle nur, dass der Ladepunkt weiter entscheidet', () => {
    const s = folgen({ name: 'Dienstwagen' }, 'Dienstwagen');
    expect(s[0]).toContain('heißt ab jetzt');
    expect(s.join(' ')).toContain('wie der Ladepunkt es vorgibt');
    expect(s.join(' ')).not.toContain('Sonnenüberschuss');
  });

  // ⚠ Kein „Netzstrom erlaubt" an einer reinen Ueberschuss-Quelle - die
  // Folgen-Karte sagt nur, was der Entwurf HERGIBT.
  it('nennt an der Ueberschuss-Quelle keine Netzstrom-Freigabe', () => {
    const s = folgen({ quelle: 'ueberschuss' }, 'Privatwagen').join(' ');
    expect(s).toContain('pausiert');
    expect(s).not.toMatch(/Netzstrom|Netz laden/);
  });

  it('nennt beim Sofort-Laden die Folge fuer den Ladepunkt', () => {
    expect(folgen({ quelle: 'sofort' }, 'Dienstwagen').join(' '))
      .toContain('auch wenn der Ladepunkt gerade auf die Sonne wartet');
  });

  it('sagt immer, dass Grenzen und Eingriff vorgehen', () => {
    const s = folgen({ quelle: 'sofort' }, 'X').join(' ');
    expect(s).toContain('Anschlussgrenze');
    expect(s).toContain('Jetzt voll laden');
  });

  // ⚠ Eine Ruecknahme ist keine Beweisvernichtung - die Karte bleibt sichtbar.
  it('sagt bei der Ruecknahme, was BLEIBT', () => {
    const s = entfernenFolgen('Dienstwagen').join(' ');
    expect(s).toContain('wie der Ladepunkt es vorgibt');
    expect(s).toContain('bleibt sichtbar');
  });
});

// ---------------------------------------------------------------------------
// Das BENENNEN im Ladevorgangs-Verlauf (§4.5)
// ---------------------------------------------------------------------------

describe('verlaufFahrzeug', () => {
  // ⚠ Der Kernfall: ein Ladevorgang wird zum Weg auf sein Profil.
  it('nennt die benannte Karte samt ihrer Steuerart und bietet das AENDERN an', () => {
    const v = verlaufFahrzeug(CARD, {
      fahrzeuge: [f({ name: 'Dienstwagen', steuerart: { quelle: 'sofort' } })],
    });
    expect(v?.text).toBe('Dienstwagen · Sofort laden');
    expect(v?.aktion).toBe(VERLAUF_AENDERN);
    expect(v?.zeile.tagRef).toBe(CARD);
    expect(v?.fahrzeug?.name).toBe('Dienstwagen');
  });

  // ⚠ Eine unbenannte Karte ist der ganze Anlass: hier faellt der Name.
  it('bietet der unbenannten Karte das BENENNEN an und nennt sie bei ihrer Kurzform', () => {
    const v = verlaufFahrzeug(CARD, { fahrzeuge: [f()] });
    expect(v?.text).toBe(`Karte 1f2e… · ${OHNE_STEUERART}`);
    expect(v?.aktion).toBe(VERLAUF_BENENNEN);
    expect(v?.zeile.benannt).toBe(false);
  });

  // ⚠ Ohne Pseudonym wird NICHTS behauptet - kein Text, kein Knopf.
  it('sagt ohne gemeldete Karte gar nichts', () => {
    expect(verlaufFahrzeug(null, { fahrzeuge: [f()] })).toBeNull();
    expect(verlaufFahrzeug('   ', { fahrzeuge: [f()] })).toBeNull();
    expect(verlaufFahrzeug('', null)).toBeNull();
  });

  // ⚠ Der Rueckfall haengt den Weg nicht an ein Rennen zweier Abrufe.
  it('synthetisiert die Zeile, solange die Liste die Karte noch nicht fuehrt', () => {
    const v = verlaufFahrzeug(CARD, { fahrzeuge: [] });
    expect(v?.zeile.name).toBe('Karte 1f2e…');
    expect(v?.fahrzeug).toBeNull();
    expect(v?.zeile.laedt).toBe(true);
    expect(v?.zeile.sichtung).toBe('lädt gerade');
  });

  // ⚠ Auch eine noch nicht geladene Liste darf den Weg nicht verstellen.
  it('traegt auch ohne geladene Liste', () => {
    expect(verlaufFahrzeug(CARD, null)?.aktion).toBe(VERLAUF_BENENNEN);
  });

  // ⚠ Es laeuft gerade - die Sichtung sagt das, nie eine Uhrzeit von gestern.
  it('sagt bei einer laufenden Ladung „laedt gerade", nicht die letzte Sichtung', () => {
    const v = verlaufFahrzeug(CARD, {
      fahrzeuge: [f({ letzteSichtungAm: '2020-01-01T10:00:00Z', laedt: true })],
    });
    expect(v?.zeile.sichtung).toBe('lädt gerade');
  });
});

// ---------------------------------------------------------------------------
// Der WEG ZURÜCK: „Lädt wie der Ladepunkt" nimmt das Profil wirklich zurück
// ---------------------------------------------------------------------------

describe('wunschAus und die drei Zustände der Quelle', () => {
  // ⚠ Der Dialog nennt diese Karte den Weg zurück UND verspricht ihn in seiner
  // Folgen-Liste. Ein Wunsch, der die Quelle weglässt, liesse das gespeicherte
  // Profil stehen - das Versprechen wäre gebrochen (im Review gefunden).
  it('sendet fuer die ausdrueckliche Wahl „ohne Steuerart" die LEERE Quelle', () => {
    expect(wunschAus({ name: 'Dienstwagen', quelle: null }))
      .toEqual({ name: 'Dienstwagen', quelle: '' });
  });

  it('laesst die Quelle unberuehrt, wenn niemand nach ihr gefragt hat', () => {
    expect(wunschAus({ name: 'Dienstwagen' })).toEqual({ name: 'Dienstwagen' });
  });

  it('setzt sie, wo eine gewaehlt wurde - samt Modus', () => {
    expect(wunschAus({ quelle: 'ueberschuss', ueberschussModus: 'mindestleistung',
      mindestleistungKw: 4.2 }))
      .toEqual({ quelle: 'ueberschuss', ueberschussModus: 'mindestleistung',
        mindestleistungKw: 4.2 });
  });

  // ⚠ Und die Folgen-Karte sagt dasselbe wie der Wunsch - sonst verspraeche
  // die Flaeche etwas, das der Server nicht tut.
  it('die Folgen sagen den Weg zurueck, den der Wunsch wirklich geht', () => {
    expect(folgen({ quelle: null }, 'Dienstwagen').join(' '))
      .toContain('lädt weiterhin so, wie der Ladepunkt es vorgibt');
  });
});
