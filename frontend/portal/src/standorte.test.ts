import { describe, expect, it } from 'vitest';
import type { Nutzung } from './api';
import {
  anfrage,
  archiviertText,
  dialogFassung,
  dialogVorspann,
  ersterFehler,
  feldAusServer,
  flaecheText,
  formularAus,
  leeresFormular,
  NUTZUNGEN,
  plzSatz,
  pruefen,
  SATZ_ADRESSE,
  SATZ_NAME_FEHLT,
  SATZ_NAME_ZU_LANG,
  sichtbareFehler,
  standortListe,
  standortZeile,
  vorbelegteZeitzone,
} from './standorte';
import {
  ahrenbergHeute,
  ahrenbergUnternehmen,
  bestandZweiAnlagen,
  halle1Entwurf,
  werkAhrenberg,
  werkLindach,
} from './test/standorteFixtures';

const HEUTE = '2026-10-20';
const STANDORTE = ahrenbergHeute().standorte;

/** Geschütztes Leerzeichen (U+00A0) — Zahl und Wort brechen nie auseinander. */
const NB = String.fromCharCode(160);

/** T2: Werk Lindach, wie Ines ihn am 15.10.2026 anlegt (vor dem Anlegen gibt es nur ST-1). */
function lindachFormular() {
  return {
    ...leeresFormular(ahrenbergUnternehmen()),
    name: 'Werk Lindach',
    strasse: 'Am Bahndamm 12',
    ort: 'Lindach',
    nutzung: ['lager', 'logistik', 'montage'] as Nutzung[],
  };
}

describe('Dialog-Fassung', () => {
  it('anlegen ohne Standort, vervollständigen für den Entwurf (E10), sonst bearbeiten', () => {
    expect(dialogFassung(null)).toBe('anlegen');
    expect(dialogFassung(halle1Entwurf())).toBe('vervollstaendigen');
    expect(dialogFassung(werkAhrenberg())).toBe('bearbeiten');
  });

  it('spricht den Vorspann aus T2 mit dem vorgeschlagenen Kurzzeichen', () => {
    expect(dialogVorspann('anlegen', null, 'ST-2')).toBe(
      'Name und Adresse sind Pflicht; Kurzzeichen ST-2 wird vergeben.',
    );
    expect(dialogVorspann('vervollstaendigen', halle1Entwurf(), null)).toBe(
      'Noch nicht eingerichtet — es fehlt: Adresse. Name und Adresse sind Pflicht.',
    );
  });
});

describe('Vorbelegung', () => {
  it('belegt die Zeitzone aus dem Unternehmen vor, sonst Europe/Berlin', () => {
    expect(leeresFormular(ahrenbergUnternehmen({ zeitzone: 'Europe/Vienna' })).zeitzone).toBe('Europe/Vienna');
    expect(leeresFormular(ahrenbergUnternehmen()).zeitzone).toBe('Europe/Berlin');
    expect(vorbelegteZeitzone(null)).toBe('Europe/Berlin');
    expect(vorbelegteZeitzone(ahrenbergUnternehmen({ zeitzone: null, zustand: 'nicht_angelegt' }))).toBe(
      'Europe/Berlin',
    );
  });

  it('übernimmt beim Bearbeiten, was gespeichert ist — Nutzung in ihrer Reihenfolge', () => {
    const f = formularAus(werkLindach());
    expect(f).toMatchObject({ name: 'Werk Lindach', kurzzeichen: 'ST-2', strasse: 'Am Bahndamm 12', plz: '' });
    expect(f.nutzung).toEqual(['lager', 'logistik', 'montage']);
  });

  it('kennt das geschlossene Vokabular E4 in seiner Reihenfolge', () => {
    expect(NUTZUNGEN.map((n) => n.wort)).toEqual([
      'Produktion', 'Montage', 'Lager', 'Logistik', 'Büro', 'Technik', 'Außenfläche',
      'Werkstatt', 'Labor', 'Verkauf', 'Sozialräume', 'Sonstiges',
    ]);
  });
});

describe('Pflichtfelder und Fehlertexte', () => {
  it('ein leeres Formular nennt Name und Adresse, und der Fokus geht zum Namen', () => {
    const { fehler } = pruefen(leeresFormular(ahrenbergUnternehmen({ sitz: null })), 'anlegen', STANDORTE, HEUTE, null);
    expect(fehler).toEqual({ name: SATZ_NAME_FEHLT, strasse: SATZ_ADRESSE, ort: SATZ_ADRESSE, land: SATZ_ADRESSE });
    expect(ersterFehler(fehler)).toBe('name');
    // Angezeigt wird der Adress-Satz nur am ersten fehlenden Adressfeld.
    expect(sichtbareFehler(fehler)).toEqual({ name: SATZ_NAME_FEHLT, strasse: SATZ_ADRESSE, ort: true, land: true });
    expect(sichtbareFehler({ ort: SATZ_ADRESSE, plz: 'Die PLZ 1 passt nicht zu Deutschland (fünfstellig).' })).toEqual({
      plz: 'Die PLZ 1 passt nicht zu Deutschland (fünfstellig).',
      ort: SATZ_ADRESSE,
    });
  });

  it('die PLZ ist optional (Referenzunternehmen: plz null) — Werk Lindach ist gültig', () => {
    const { fehler } = pruefen({ ...lindachFormular(), nutzung: ['lager'] }, 'anlegen', [werkAhrenberg()], HEUTE, null);
    expect(fehler).toEqual({});
  });

  it('§5.10 doppelter Name: der Satz nennt den vorhandenen Standort, ohne Groß-/Kleinschreibung', () => {
    const r = pruefen({ ...lindachFormular(), name: '  werk ahrenberg ', nutzung: [] }, 'anlegen', STANDORTE, HEUTE, null);
    expect(r.fehler.name).toBe(
      'Diesen Namen gibt es hier schon: Werk Ahrenberg (ST-1). Wählen Sie einen anderen Namen — oder öffnen Sie Werk Ahrenberg.',
    );
    expect(r.belegtVon?.kurzzeichen).toBe('ST-1');
  });

  it('beim Bearbeiten trägt der Standort seinen eigenen Namen weiter', () => {
    const r = pruefen(formularAus(werkAhrenberg()), 'bearbeiten', STANDORTE, HEUTE, werkAhrenberg());
    expect(r.fehler).toEqual({});
  });

  it('ein archivierter Standort gibt seinen Namen frei', () => {
    const archiviert = werkLindach({ zustand: 'archiviert', bestand: 'archiviert' });
    const r = pruefen({ ...lindachFormular(), nutzung: [] }, 'anlegen', [werkAhrenberg(), archiviert], HEUTE, null);
    expect(r.fehler.name).toBeUndefined();
  });

  it('§5.10 PLZ passt nicht zum Land', () => {
    expect(plzSatz('84xxx', 'AT')).toBe('Die PLZ 84xxx passt nicht zu Österreich (vierstellig).');
    const { fehler } = pruefen({ ...lindachFormular(), plz: '8440', land: 'DE', nutzung: [] }, 'anlegen', [], HEUTE, null);
    expect(fehler.plz).toBe('Die PLZ 8440 passt nicht zu Deutschland (fünfstellig).');
  });

  it('der Name hat höchstens 120 Zeichen, gezählt nach Zeichen', () => {
    const { fehler } = pruefen({ ...lindachFormular(), name: 'ä'.repeat(121), nutzung: [] }, 'anlegen', [], HEUTE, null);
    expect(fehler.name).toBe(SATZ_NAME_ZU_LANG);
  });

  it('vervollständigen verlangt die Adresse, bearbeiten das Kurzzeichen', () => {
    const entwurf = pruefen(formularAus(halle1Entwurf()), 'vervollstaendigen', [halle1Entwurf()], HEUTE, halle1Entwurf());
    expect(Object.keys(entwurf.fehler)).toEqual(['strasse', 'ort', 'land']);
    const ohneKz = pruefen({ ...formularAus(werkLindach()), kurzzeichen: ' ' }, 'bearbeiten', STANDORTE, HEUTE, werkLindach());
    expect(ohneKz.fehler).toEqual({ kurzzeichen: 'Das Kurzzeichen fehlt.' });
  });
});

describe('Anfrage', () => {
  it('POST ohne Kurzzeichen; leere Felder sind null, Nutzung in der Reihenfolge der Auswahl', () => {
    const body = anfrage({ ...lindachFormular(), nutzung: ['montage', 'lager'], notiz: ' ' }, 'anlegen', null);
    expect(body).toEqual({
      name: 'Werk Lindach',
      adresse: { strasse: 'Am Bahndamm 12', plz: null, ort: 'Lindach', land: 'DE' },
      zeitzone: 'Europe/Berlin',
      nutzung: ['montage', 'lager'],
      notiz: null,
    });
  });

  it('PUT ist die ganze Menge — die Lage auf der Karte reist unverändert mit', () => {
    const body = anfrage(formularAus(werkAhrenberg()), 'bearbeiten', werkAhrenberg());
    expect(body.kurzzeichen).toBe('ST-1');
    expect(body.lage).toEqual({ breitengrad: 48.25, laengengrad: 11.43 });
    expect(body.notiz).toBe('Zwei Netzanschlüsse (NA-1, NA-2)');
  });

  it('ordnet `feld` einer Ablehnung dem Eintrag des Dialogs zu', () => {
    expect(feldAusServer('adresse.plz')).toBe('plz');
    expect(feldAusServer('adresse')).toBe('strasse');
    expect(feldAusServer('nutzung[1]')).toBe('nutzung');
    expect(feldAusServer('lage.breitengrad')).toBeNull();
    expect(feldAusServer(undefined)).toBeNull();
  });
});

describe('Liste (T1)', () => {
  it('Zeile mit Adresse, Gebäuden, Anlagen und Fläche in de-DE', () => {
    // Zahl und Wort, Tausender und Einheit mit geschütztem Leerzeichen (kein Umbruch „2 / Anlagen“).
    expect(standortZeile(werkAhrenberg())).toBe(`Gewerbering 7, Ahrenberg · 3${NB}Gebäude · 2${NB}Anlagen · 8${NB}450${NB}m²`);
    expect(standortZeile(werkLindach())).toBe(`Am Bahndamm 12, Lindach · 2${NB}Gebäude · 1${NB}Anlage · 2${NB}600${NB}m²`);
  });

  it('eine unbekannte Fläche bleibt weg, statt 0 zu zeigen', () => {
    expect(standortZeile(halle1Entwurf())).toBe(`0${NB}Gebäude · 1${NB}Anlage`);
    expect(flaecheText(halle1Entwurf())).toBeNull();
    expect(flaecheText(werkLindach())).toBe('2 600 m² · aus Gebäuden summiert');
  });

  it('die Gruppe „Noch nicht zugeordnet“ gibt es nur, solange sie etwas enthält (A15)', () => {
    expect(standortListe(ahrenbergHeute()).nochNichtZugeordnet).toBeNull();
    expect(standortListe(bestandZweiAnlagen()).nochNichtZugeordnet?.map((a) => a.name)).toEqual([
      'Werk Ahrenberg – Halle 1',
      'Werk Ahrenberg – Halle 2',
    ]);
  });

  it('sortiert nach Kurzzeichen numerisch und nennt den Archiv-Tag in der Zone des Standorts', () => {
    const zehn = werkLindach({ id: 'x', kurzzeichen: 'ST-10', name: 'Außenlager' });
    const liste = standortListe({ ...ahrenbergHeute(), standorte: [zehn, werkLindach(), werkAhrenberg()] });
    expect(liste.standorte.map((s) => s.kurzzeichen)).toEqual(['ST-1', 'ST-2', 'ST-10']);
    // 30.09.2026 23:30 UTC ist in Berlin schon der 01.10.2026.
    expect(archiviertText(werkLindach({ archiviertAm: '2026-09-30T23:30:00Z' }))).toBe('Archiviert am 01.10.2026');
  });
});
