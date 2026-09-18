import { describe, expect, it } from 'vitest';
import {
  bereichZiele,
  DIREKT_AM_STANDORT,
  flaecheZahl,
  KNOPF_BEREICH_DIREKT,
  KNOPF_GEBAEUDE_ANLEGEN,
  LEER_SATZ,
  leeresOrtFormular,
  ortAnlegenAnfrage,
  ortBearbeitenAnfrage,
  ortDialogVorspann,
  ortFeldAusServer,
  ortFlaecheAnfrage,
  ortFormularAus,
  ortPruefen,
  ortsbaumSicht,
  SATZ_BEREICH_ZIEL,
  SATZ_GEBAEUDE_ZIEL,
  vertragsbaum,
  zielPruefen,
  type OrtFormular,
} from './ortsbaum';
import { eintrag, FLAECHE_SATZ } from './uemsOrtsbaum';
import {
  halle2,
  ORT_IDS,
  ortsbaumAhrenberg,
  ortsbaumLindach,
  ortsbaumLindachOhneGebaeude,
} from './test/ortsbaumFixtures';

/** Geschütztes Leerzeichen (U+00A0) — Zahl und Wort brechen nie auseinander. */
const NB = String.fromCharCode(160);

/** Der Ortsbaum „Standort › Gebäude“ (UEMS AP-02 IP-7) gegen das Referenzunternehmen Ahrenberg. */

describe('ortsbaumSicht — aus flachen Orten wird der Baum (T3)', () => {
  it('Werk Ahrenberg: Gebäude nach Kurzzeichen mit ihren Bereichen, zuletzt „Direkt am Standort“', () => {
    const sicht = ortsbaumSicht(ortsbaumAhrenberg());
    expect(sicht.leer).toBe(false);
    expect(sicht.knoten.map((k) => [k.art, k.kurzzeichen, k.name, k.kinder.map((b) => b.kurzzeichen)])).toEqual([
      ['gebaeude', 'G-1', 'Halle 1', ['B-1', 'B-2']],
      ['gebaeude', 'G-2', 'Halle 2', ['B-3', 'B-4', 'B-5']],
      ['gebaeude', 'G-3', 'Verwaltung', []],
      ['direkt', null, DIREKT_AM_STANDORT, []],
    ]);
  });

  it('jede Zeile trägt Nutzung, Fläche und Baujahr — und die Messstellen als Platzhalter der Datenlage', () => {
    const [halle1, halle2Knoten, verwaltung, direkt] = ortsbaumSicht(ortsbaumAhrenberg()).knoten;
    expect(halle2Knoten.zeile).toBe(`Produktion · Montage · Lager · 3${NB}100${NB}m² · 2019`);
    // Das Gebäude zählt die Messstellen seiner Bereiche mit: 2 + 1 + 1 + 1.
    expect(halle2Knoten.datenlage).toBe(`5${NB}Messstellen`);
    expect(halle1.datenlage).toBe(`6${NB}Messstellen`);
    expect(halle1.kinder.map((b) => [b.zeile, b.datenlage])).toEqual([
      ['Produktion', `1${NB}Messstelle`],
      ['Technik', `3${NB}Messstellen`],
    ]);
    expect(verwaltung.zeile).toBe(`Büro · 1${NB}150${NB}m² · 2004`);
    expect(direkt).toMatchObject({
      id: null,
      zeile: '',
      datenlage: `3${NB}Messstellen`,
    });
    expect(sichtFlaecheFehlt(ortsbaumAhrenberg())).toEqual([]);
  });

  it('ersetzt den alten Messstellen-Platzhalter durch die Datenlage des Servers', () => {
    const antwort = ortsbaumAhrenberg({
      gebaeude: [halle2({ datenlage: { erfuellt: 4, gesamt: 5, text: '4 von 5 Messstellen liefern Daten' } })],
      direktAmStandort: null,
    });
    expect(ortsbaumSicht(antwort).knoten[0].datenlage).toBe('4 von 5 Messstellen liefern Daten');
  });

  it('unbekannt ist keine Null: fehlt eine Zahl, fehlt die Datenlage; fehlt die Fläche, sagt es der Hinweis', () => {
    const antwort = ortsbaumAhrenberg({
      gebaeude: [
        halle2({
          flaecheM2: null,
          flaecheQuelle: null,
          bereiche: [...halle2().bereiche.slice(0, 2), { ...halle2().bereiche[2], messstellenZahl: null }],
        }),
      ],
    });
    const [g] = ortsbaumSicht(antwort).knoten;
    expect(g.zeile).toBe('Produktion · Montage · Lager · 2019');
    expect(g.datenlage).toBeNull();
    expect(g.kinder[2].datenlage).toBeNull();
    expect(sichtFlaecheFehlt(antwort)).toEqual(['Halle 2']);
  });

  it('Bereiche direkt am Standort hängen im Zweig „Direkt am Standort“, nicht unter einem Gebäude', () => {
    const b = {
      ...halle2().bereiche[0],
      id: 'aussen',
      kurzzeichen: 'B-8',
      name: 'Parkplatz Halle 2',
      nutzung: ['aussenflaeche' as const],
      messstellenZahl: 1,
    };
    const sicht = ortsbaumSicht(
      ortsbaumAhrenberg({
        direktAmStandort: { bereiche: [b], messstellenZahl: 3 },
      }),
    );
    const direkt = sicht.knoten.at(-1)!;
    expect(direkt.kinder.map((k) => [k.name, k.eltern])).toEqual([
      ['Parkplatz Halle 2', { art: 'standort', name: 'Werk Ahrenberg' }],
    ]);
    expect(direkt.datenlage).toBe(`4${NB}Messstellen`);
    expect(sicht.knoten[0].kinder[0].eltern).toEqual({
      art: 'gebaeude',
      name: 'Halle 1',
    });
  });

  it('„Direkt am Standort“ gibt es nur, wenn dort etwas hängt', () => {
    const ohne = ortsbaumSicht(
      ortsbaumLindach({
        direktAmStandort: { bereiche: [], messstellenZahl: 0 },
      }),
    );
    expect(ohne.knoten.map((k) => k.name)).toEqual(['Lagerhalle Lindach', 'Montagehalle Lindach']);
    const unbekannt = ortsbaumSicht(
      ortsbaumLindach({
        direktAmStandort: { bereiche: [], messstellenZahl: null },
      }),
    );
    expect(unbekannt.knoten.some((k) => k.art === 'direkt')).toBe(false);
  });
});

function sichtFlaecheFehlt(antwort: ReturnType<typeof ortsbaumAhrenberg>) {
  return ortsbaumSicht(antwort)
    .knoten.filter((k) => k.flaecheFehlt)
    .map((k) => k.name);
}

describe('Leerzustand L1 (§5.9)', () => {
  it('Wortlaut Zeichen für Zeichen, beide Wege', () => {
    expect(LEER_SATZ).toBe('Gebäude sind optional — Messstellen dürfen direkt am Standort hängen.');
    expect(KNOPF_GEBAEUDE_ANLEGEN).toBe('Gebäude anlegen');
    expect(KNOPF_BEREICH_DIREKT).toBe('Bereich direkt am Standort anlegen');
  });

  it('nur ohne Gebäude UND ohne Bereiche — Messstellen direkt am Standort ändern daran nichts', () => {
    const sicht = ortsbaumSicht(ortsbaumLindachOhneGebaeude());
    expect(sicht.leer).toBe(true);
    expect(sicht.knoten.map((k) => k.name)).toEqual([DIREKT_AM_STANDORT]);
    expect(ortsbaumSicht(ortsbaumLindach()).leer).toBe(false);
    const nurBereich = ortsbaumLindachOhneGebaeude();
    nurBereich.direktAmStandort = {
      bereiche: [halle2().bereiche[0]],
      messstellenZahl: 1,
    };
    expect(ortsbaumSicht(nurBereich).leer).toBe(false);
  });

  it('„Bereich direkt am Standort anlegen“ wählt den Standort vor', () => {
    const antwort = ortsbaumLindachOhneGebaeude();
    expect(leeresOrtFormular('bereich', antwort, antwort.standort.id).elternId).toBe(antwort.standort.id);
  });
});

describe('Ein Bereich hängt nur an einem Gebäude oder am Standort (AP-00 E4)', () => {
  it('die Sätze sind die des Vertrags (`eintrag` → `ziel_art_unzulaessig`)', () => {
    const baum = vertragsbaum(ortsbaumAhrenberg());
    const neu = (art: 'gebaeude' | 'bereich') => ({
      ...baum,
      orte: [...baum.orte, { kennzeichen: 'neu', art, name: '', intervalle: [] }],
    });
    const antrag = {
      objekt: 'neu',
      vorgang: 'verschieben' as const,
      ab: '2026-10-20',
      eltern: ORT_IDS.b3,
      heute: '2026-10-20',
    };
    expect(eintrag(neu('bereich'), antrag).text).toBe(SATZ_BEREICH_ZIEL);
    expect(eintrag(neu('gebaeude'), { ...antrag, eltern: ORT_IDS.g2 }).text).toBe(SATZ_GEBAEUDE_ZIEL);
  });

  it('Gebäude und Standort sind erlaubt', () => {
    const antwort = ortsbaumAhrenberg();
    expect(zielPruefen(antwort, 'bereich', ORT_IDS.g2)).toEqual({
      erlaubt: true,
      grund: null,
      text: null,
    });
    expect(zielPruefen(antwort, 'bereich', antwort.standort.id).erlaubt).toBe(true);
  });

  it('der falsche Fall wird abgelehnt: ein Bereich unter einem Bereich', () => {
    expect(zielPruefen(ortsbaumAhrenberg(), 'bereich', ORT_IDS.b3)).toEqual({
      erlaubt: false,
      grund: 'ziel_art_unzulaessig',
      text: SATZ_BEREICH_ZIEL,
    });
  });

  it('ein Gebäude hängt nur am Standort — nie an einem Gebäude', () => {
    const antwort = ortsbaumAhrenberg();
    expect(zielPruefen(antwort, 'gebaeude', antwort.standort.id).erlaubt).toBe(true);
    expect(zielPruefen(antwort, 'gebaeude', ORT_IDS.g1)).toMatchObject({
      erlaubt: false,
      grund: 'ziel_art_unzulaessig',
      text: SATZ_GEBAEUDE_ZIEL,
    });
  });

  it('fehlend, unbekannt oder archiviert ist nie ein Ziel', () => {
    const antwort = ortsbaumAhrenberg({
      gebaeude: [halle2({ zustand: 'archiviert' }), ...ortsbaumAhrenberg().gebaeude.slice(1)],
    });
    for (const id of [null, 'gibt-es-nicht', ORT_IDS.g2]) {
      expect(zielPruefen(antwort, 'bereich', id)).toMatchObject({
        erlaubt: false,
        text: SATZ_BEREICH_ZIEL,
      });
    }
  });

  it('die Zielliste „Hängt an“ (T5) enthält nie einen Bereich: Gebäude nach Kurzzeichen, zuletzt der Standort', () => {
    const ziele = bereichZiele(ortsbaumAhrenberg());
    expect(ziele.map((z) => [z.art, z.label])).toEqual([
      ['gebaeude', 'Gebäude Halle 1'],
      ['gebaeude', 'Gebäude Halle 2'],
      ['gebaeude', 'Gebäude Verwaltung'],
      ['standort', 'Direkt am Standort Werk Ahrenberg'],
    ]);
    const bereiche = Object.entries(ORT_IDS)
      .filter(([k]) => k.startsWith('b'))
      .map(([, v]) => v);
    expect(ziele.some((z) => (bereiche as string[]).includes(z.id))).toBe(false);
  });

  it('Prüfung vor dem Senden: ohne Ziel steht der Satz am Feld „Hängt an“', () => {
    const antwort = ortsbaumAhrenberg();
    const f = {
      ...leeresOrtFormular('bereich', antwort),
      name: 'Halle 2 Montage 2',
    };
    expect(f.elternId).toBeNull();
    expect(ortPruefen('bereich', 'anlegen', f, antwort, null).fehler).toEqual({
      elternId: SATZ_BEREICH_ZIEL,
    });
    expect(ortPruefen('bereich', 'anlegen', { ...f, elternId: ORT_IDS.b3 }, antwort, null).fehler.elternId).toBe(
      SATZ_BEREICH_ZIEL,
    );
    expect(ortPruefen('bereich', 'anlegen', { ...f, elternId: ORT_IDS.g2 }, antwort, null).fehler).toEqual({});
  });
});

describe('Dialoge Gebäude und Bereich (T4, T5)', () => {
  const antwort = ortsbaumAhrenberg();
  const leer = (art: 'gebaeude' | 'bereich'): OrtFormular => leeresOrtFormular(art, antwort);

  it('Vorspann: T4 mit dem Standort, T5 mit dem Satz des Bereichs', () => {
    expect(ortDialogVorspann('gebaeude', antwort.standort)).toBe(
      'Am Standort Werk Ahrenberg (ST-1). Nur der Name ist Pflicht.',
    );
    expect(ortDialogVorspann('bereich', antwort.standort)).toBe(
      'Ein räumlicher Teil eines Gebäudes oder des Standorts — nicht verschachtelt.',
    );
  });

  it('Pflicht, Länge, Fläche, Baujahr und Notiz mit den Sätzen des Servers', () => {
    expect(ortPruefen('gebaeude', 'anlegen', leer('gebaeude'), antwort, null).fehler).toEqual({
      name: 'Bitte geben Sie einen Namen an.',
    });
    const f = {
      ...leer('gebaeude'),
      name: 'x'.repeat(121),
      flaeche: '3100,5',
      baujahr: '2027',
      notiz: 'n'.repeat(501),
    };
    expect(ortPruefen('gebaeude', 'anlegen', f, antwort, null).fehler).toEqual({
      name: 'Der Name hat höchstens 120 Zeichen.',
      flaeche: FLAECHE_SATZ,
      baujahr: 'Das Baujahr liegt zwischen 1800 und 2026.',
      notiz: 'Die Notiz hat höchstens 500 Zeichen.',
    });
    expect(
      ortPruefen('gebaeude', 'anlegen', { ...leer('gebaeude'), name: 'Halle 4', flaeche: '0' }, antwort, null).fehler,
    ).toEqual({ flaeche: FLAECHE_SATZ });
  });

  it('Name belegt unter den Geschwistern (§5.10) — ein gleichnamiger Bereich an einem anderen Gebäude ist frei', () => {
    const p = ortPruefen('gebaeude', 'anlegen', { ...leer('gebaeude'), name: ' halle 1 ' }, antwort, null);
    expect(p.fehler.name).toBe(
      'Diesen Namen gibt es hier schon: Halle 1 (G-1). Wählen Sie einen anderen Namen — oder öffnen Sie Halle 1.',
    );
    expect(p.belegtVon).toEqual({
      id: ORT_IDS.g1,
      name: 'Halle 1',
      kurzzeichen: 'G-1',
    });
    const b = { ...leer('bereich'), name: 'Halle 2 Lager' };
    expect(ortPruefen('bereich', 'anlegen', { ...b, elternId: ORT_IDS.g2 }, antwort, null).fehler.name).toContain(
      '(B-5)',
    );
    expect(ortPruefen('bereich', 'anlegen', { ...b, elternId: ORT_IDS.g1 }, antwort, null).fehler).toEqual({});
  });

  it('Bearbeiten: Kurzzeichen Pflicht, der eigene Name ist nicht belegt', () => {
    const [, halle2Knoten] = ortsbaumSicht(antwort).knoten;
    const f = ortFormularAus(halle2Knoten, antwort);
    expect(f).toMatchObject({
      name: 'Halle 2',
      kurzzeichen: 'G-2',
      baujahr: '2019',
      nutzung: ['produktion', 'montage', 'lager'],
    });
    expect(ortPruefen('gebaeude', 'bearbeiten', f, antwort, halle2Knoten).fehler).toEqual({});
    expect(ortPruefen('gebaeude', 'bearbeiten', { ...f, kurzzeichen: ' ' }, antwort, halle2Knoten).fehler).toEqual({
      kurzzeichen: 'Das Kurzzeichen fehlt.',
    });
    const b3 = halle2Knoten.kinder[0];
    expect(
      ortPruefen('bereich', 'bearbeiten', { ...ortFormularAus(b3, antwort), name: 'Halle 2 Lager' }, antwort, b3).fehler
        .name,
    ).toContain('(B-5)');
  });

  it('Anfragen: POST mit überschreibbarem Kurzzeichen, direkt am Standort ohne elternId; PUT die ganze Menge', () => {
    const g = {
      ...leer('gebaeude'),
      name: ' Halle 4 ',
      flaeche: `3${NB}100`,
      gueltigAb: '2026-10-01',
      baujahr: '2019',
      nutzung: ['lager' as const],
    };
    expect(ortAnlegenAnfrage('gebaeude', g, antwort)).toEqual({
      art: 'gebaeude',
      name: 'Halle 4',
      kurzzeichen: null,
      gueltigAb: '2026-10-01',
      nutzung: ['lager'],
      notiz: null,
      flaecheM2: 3100,
      baujahr: 2019,
    });
    const b = {
      ...leer('bereich'),
      name: 'Parkplatz',
      elternId: antwort.standort.id,
    };
    expect(ortAnlegenAnfrage('bereich', b, antwort)).toEqual({
      art: 'bereich',
      name: 'Parkplatz',
      kurzzeichen: null,
      gueltigAb: '2026-10-20',
      nutzung: null,
      notiz: null,
      flaecheM2: null,
      elternId: null,
    });
    expect(ortAnlegenAnfrage('bereich', { ...b, elternId: ORT_IDS.g2 }, antwort).elternId).toBe(ORT_IDS.g2);
    expect(
      ortBearbeitenAnfrage('bereich', {
        ...b,
        kurzzeichen: 'B-8',
        baujahr: '1999',
      }),
    ).toEqual({
      name: 'Parkplatz',
      kurzzeichen: 'B-8',
      nutzung: null,
      notiz: null,
    });
    expect(ortFlaecheAnfrage({ ...b, flaeche: '' })).toBeNull();
    expect(ortFlaecheAnfrage({ ...b, flaeche: '250', gueltigAb: '2026-10-01' })).toEqual({
      m2: 250,
      gueltigAb: '2026-10-01',
    });
  });

  it('ganze Zahlen streng: „3 100“ ja, „3.100“, „3100,5“, „-5“ nein', () => {
    expect([`3${NB}100`, '3 100', '3100'].map(flaecheZahl)).toEqual([3100, 3100, 3100]);
    expect(['3.100', '3100,5', '-5', '0', 'abc'].map(flaecheZahl)).toEqual([null, null, null, null, null]);
  });

  it('Ablehnungen des Servers landen am richtigen Feld', () => {
    expect(ortFeldAusServer({ code: 'name_belegt', message: '…' })).toBe('name');
    expect(
      ortFeldAusServer({
        code: 'ziel_gab_es_noch_nicht',
        message: '…',
        feld: 'elternId',
      }),
    ).toBe('gueltigAb');
    expect(
      ortFeldAusServer({
        code: 'ziel_art_unzulaessig',
        message: '…',
        feld: 'elternId',
      }),
    ).toBe('elternId');
    expect(
      ortFeldAusServer({
        code: 'flaeche_ungueltig',
        message: '…',
        feld: 'flaecheM2',
      }),
    ).toBe('flaeche');
    expect(
      ortFeldAusServer({
        code: 'anfrage_ungueltig',
        message: '…',
        feld: 'nutzung[1]',
      }),
    ).toBe('nutzung');
    expect(ortFeldAusServer({ code: 'archiviert', message: '…' })).toBeNull();
  });
});
