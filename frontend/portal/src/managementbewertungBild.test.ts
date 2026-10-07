import { describe, expect, it } from 'vitest';
import type { Bericht, Managementbewertung, ManagementbewertungBeschluss, ManagementbewertungFolge } from './api';
import * as B from './managementbewertungBild';

const folge = (f: Partial<ManagementbewertungFolge> & Pick<ManagementbewertungFolge, 'art' | 'objekt' | 'zustand'>): ManagementbewertungFolge => ({
  wie: 'von_hand',
  ...f,
});
const beschluss = (nr: number, art: ManagementbewertungBeschluss['art'], wortlaut: string, folgen: ManagementbewertungFolge[] = []): ManagementbewertungBeschluss => ({
  nr,
  kennung: `BR-2029-0001/B${nr}`,
  art,
  wortlaut,
  entschieden_von: { id: 'rf', name: 'Robert Falk' },
  folgen,
});

/** Die sechs Beschlüsse der Managementbewertung 2028 wie im Demo-Bestand (Referenzwelt `managementbewertungen`). */
const DEMO: ManagementbewertungBeschluss[] = [
  beschluss(1, 'energieziel', 'Energieziel 2029 für den Spritzguss: 4 % weniger Strom, als die Bezugsbasis erwarten lässt; die Arbeit geht weiter.', [
    folge({ art: 'energieziel', objekt: 'EZ-2029-0001', zustand: 'offen', angabe: '2029-03/2029-12', verknuepft_am: '2029-02-15' }),
  ]),
  beschluss(2, 'massnahme', 'Druckluft: Leckagen jährlich orten, 2029 im zweiten Quartal.', [
    folge({ art: 'massnahme', objekt: 'M-2029-0003', wie: 'herkunft', zustand: 'geplant', tag: '2029-02-14' }),
  ]),
  beschluss(3, 'dokument', 'Energiepolitik um Einkauf und Planung ergänzen; neue Fassung bis 31.03.2029.', [
    folge({ art: 'dokument', objekt: 'D-0001/2', wie: 'fassung', zustand: 'freigegeben', tag: '2029-03-20' }),
  ]),
  beschluss(4, 'aufgabe', 'Die Aufgabe „Bezugsbasen pflegen und freigeben“ übernimmt Ines Kaltenbach.', [
    folge({ art: 'aufgabe', objekt: 'bezugsbasen', wie: 'zuordnung', zustand: 'laufend', angabe: 'Ines Kaltenbach', tag: '2029-02-26' }),
  ]),
  beschluss(5, 'ressourcen', 'Für 2029 stehen 25 000 € für Maßnahmen an der Druckluft bereit.'),
  beschluss(6, 'keine_aenderung', 'Der Anwendungsbereich (D-0002, Fassung 1) bleibt unverändert.', [
    folge({ art: 'dokument', objekt: 'D-0002', wie: 'geprueft_bleibt', zustand: 'geprueft_bleibt', tag: '2029-02-13' }),
  ]),
];
const TITEL = { dokumente: { 'D-0001': 'Energiepolitik', 'D-0002': 'Anwendungsbereich' }, massnahmen: { 'M-2029-0003': 'Druckluft: Leckagen orten' } };

describe('Folgen eines Beschlusses (MG6)', () => {
  it('ordnet jede Folge einem Zeichen zu: erledigt, läuft, ohne Wirkung', () => {
    expect(B.folgeZustand({ art: 'dokument', wie: 'fassung', zustand: 'freigegeben' })).toBe('done');
    expect(B.folgeZustand({ art: 'dokument', wie: 'fassung', zustand: 'entwurf' })).toBe('laeuft');
    expect(B.folgeZustand({ art: 'dokument', wie: 'fassung', zustand: 'abgelehnt' })).toBe('ohne');
    expect(B.folgeZustand({ art: 'dokument', wie: 'geprueft_bleibt', zustand: 'egal' })).toBe('done');
    expect(B.folgeZustand({ art: 'massnahme', wie: 'herkunft', zustand: 'umgesetzt' })).toBe('done');
    expect(B.folgeZustand({ art: 'massnahme', wie: 'herkunft', zustand: 'geplant' })).toBe('laeuft');
    expect(B.folgeZustand({ art: 'massnahme', wie: 'herkunft', zustand: 'verworfen' })).toBe('ohne');
    expect(B.folgeZustand({ art: 'aufgabe', wie: 'zuordnung', zustand: 'laufend' })).toBe('done');
    expect(B.folgeZustand({ art: 'energieziel', wie: 'von_hand', zustand: 'offen' })).toBe('laeuft');
    expect(B.folgeZustand({ art: 'energieziel', wie: 'von_hand', zustand: 'bewertet' })).toBe('done');
    expect(B.folgeZustand({ art: 'audit', wie: 'von_hand', zustand: 'abgesagt' })).toBe('ohne');
  });

  it('der Beschluss: ohne Folge, läuft, oder erledigt mit dem Tag der letzten Folge', () => {
    expect(DEMO.map((b) => B.beschlussZustand(b))).toEqual([
      { art: 'laeuft', wort: 'läuft' },
      { art: 'laeuft', wort: 'läuft' },
      { art: 'done', wort: '20.03.' },
      { art: 'done', wort: '26.02.' },
      { art: 'ohne', wort: 'ohne Folge' },
      { art: 'done', wort: '13.02.' },
    ]);
    // Eine verworfene Maßnahme zählt wie keine Folge.
    expect(B.beschlussZustand(beschluss(7, 'massnahme', 'x', [folge({ art: 'massnahme', objekt: 'M-1', zustand: 'verworfen' })]))).toEqual({ art: 'ohne', wort: 'ohne Folge' });
  });

  it('der Folgen-Balken zählt Beschlüsse in ihrer Reihenfolge (G4: kein Urteil über das Ganze)', () => {
    expect(B.folgenZustaende({ beschluesse: [...DEMO].reverse() })).toEqual(['laeuft', 'laeuft', 'done', 'done', 'ohne', 'done']);
  });
});

describe('Kurztitel (Konzept §6.7, Entscheid 25: nie ein Kennzeichen)', () => {
  it('aus der Folge: Energieziel mit Jahr, Maßnahme, Aufgabe mit Kurzwort, Dokument mit Fassung oder „bleibt“', () => {
    expect(DEMO.map((b) => B.beschlussKurz(b, TITEL))).toEqual([
      'Energieziel 2029',
      'Druckluft: Leckagen orten',
      'Energiepolitik, Fassung 2',
      'Aufgabe Bezugsbasen',
      'Geld: 25 000 €',
      'Anwendungsbereich bleibt',
    ]);
  });

  it('ohne bekannten Namen der Wortlaut bis zum ersten Komma außerhalb einer Klammer, nie das Kennzeichen', () => {
    const ohne = { dokumente: {}, massnahmen: {} };
    expect(DEMO.map((b) => B.beschlussKurz(b, ohne))).toEqual([
      'Energieziel 2029',
      'Druckluft: Leckagen jährlich orten',
      'Energiepolitik um Einkauf und Planung ergänzen',
      'Aufgabe Bezugsbasen',
      'Geld: 25 000 €',
      'Der Anwendungsbereich (D-0002, Fassung 1) bleibt unverändert',
    ]);
    expect(B.beschlussKurz(beschluss(1, 'ressourcen', 'Eine halbe Stelle für das Energieteam.'), ohne)).toBe('Eine halbe Stelle für das Energieteam');
  });

  it('eine Zielperiode über zwei Jahre nennt beide', () => {
    const b = beschluss(1, 'energieziel', 'x', [folge({ art: 'energieziel', objekt: 'EZ-1', zustand: 'offen', angabe: '2029-07/2030-06' })]);
    expect(B.beschlussKurz(b, TITEL)).toBe('Energieziel 2029–2030');
  });

  it('die Folge als Zeile beim Namen', () => {
    expect(DEMO.flatMap((b) => b.folgen).map((f) => B.folgeKurz(f, TITEL))).toEqual([
      'Energieziel 2029',
      'Druckluft: Leckagen orten',
      'Energiepolitik, Fassung 2',
      'Bezugsbasen: Ines Kaltenbach',
      'Anwendungsbereich bleibt',
    ]);
  });

  it('bisKomma schneidet nicht in einer Klammer und streicht den Schlusspunkt', () => {
    expect(B.bisKomma('A (b, c) d, e')).toBe('A (b, c) d');
    expect(B.bisKomma('A; b')).toBe('A');
    expect(B.bisKomma('Nur ein Satz.')).toBe('Nur ein Satz');
  });
});

describe('Reiter: der eine nächste Schritt', () => {
  const mb = (zeitraum: string, nr: number | null) => ({ kennung: `BR-${zeitraum}`, zeitraum, neueste_nr: nr }) as Pick<Bericht, 'kennung' | 'zeitraum' | 'neueste_nr'>;
  const naechste = { faellig_am: '2030-02-12', kennzeichen: 'BR-2029-0001', sitzung_am: '2029-02-12', rhythmus_monate: 12 };

  it('am 30.04.2029 mit freigegebener 2028: „Kann noch nicht beginnen“, bis 12.02.2030, ab Januar 2030, ohne Knopf', () => {
    expect(B.mbNaechstes([mb('2028', 1)], naechste, '2029-04-30')).toEqual({
      art: 'kann_nicht',
      frist: { wort: 'bis', tag: '2030-02-12', ton: 'plan' },
      titel: 'Managementbewertung 2029',
      warum: 'ab Januar 2030',
      knopf: null,
      kennung: null,
    });
  });

  it('gibt es schon eine spätere als das Vorjahr (zwei Uhren der Demo), kann die nach ihr noch nicht beginnen', () => {
    expect(B.mbNaechstes([mb('2028', 1)], naechste, '2026-10-07')).toMatchObject({ art: 'kann_nicht', titel: 'Managementbewertung 2029', warum: 'ab Januar 2030' });
    expect(B.mbNaechstes([mb('2028', 1)], null, '2030-03-01')).toMatchObject({ art: 'als_naechstes', knopf: 'anlegen', titel: 'Managementbewertung 2029' });
  });

  it('ein Entwurf ist zu öffnen, eine fehlende des Vorjahrs anzulegen', () => {
    expect(B.mbNaechstes([mb('2028', null)], null, '2029-02-12')).toMatchObject({ art: 'als_naechstes', knopf: 'oeffnen', kennung: 'BR-2028', frist: null });
    expect(B.mbNaechstes([], null, '2029-02-12')).toMatchObject({ art: 'als_naechstes', knopf: 'anlegen', titel: 'Managementbewertung 2028' });
    expect(B.mbNaechstes([mb('2027', 1)], { ...naechste, faellig_am: '2029-01-10' }, '2029-02-12')).toMatchObject({
      knopf: 'anlegen',
      frist: { wort: 'seit', tag: '2029-01-10', ton: 'ueber' },
    });
  });
});

describe('Seite eines Jahres', () => {
  const sitzung: NonNullable<Managementbewertung['sitzung']> = {
    tag: '2029-02-12',
    leitung: { id: 'rf', name: 'Robert Falk' },
    leitung_gilt: true,
    teilnehmende: [
      { id: 'ik', name: 'Ines Kaltenbach' },
      { id: 'rf', name: 'Robert Falk' },
      { id: 'jw', name: 'Jonas Wendlinger' },
    ],
  };

  it('Kurzzeile und Status: freigegeben mit Sitzung und Leitung, im Entwurf „Entwurf · Sitzung …“', () => {
    expect(B.mbKurzzeile({ sitzung, freigegeben: true })).toBe('Sitzung 12.02.2029 · Robert Falk');
    expect(B.mbKurzzeile({ sitzung, freigegeben: false })).toBe('Entwurf · Sitzung 12.02.2029');
    expect(B.mbKurzzeile({ sitzung: null, freigegeben: false })).toBe('Entwurf');
    expect(B.mbStatus({ freigegeben: true, stand_nr: 1 })).toMatchObject({ zeichen: 'festgehalten', text: 'Stand 1 gilt' });
  });

  it('Stufen des Entwurfs: der nächste offene Schritt steht auf „jetzt“', () => {
    expect(B.mbStufen({ sitzung: null, beschluesse: [], freigegeben: false }, '2029-02-12').map((s) => [s.titel, s.datum, s.zustand])).toEqual([
      ['Eingaben', '12.02.', 'done'],
      ['Sitzung', 'jetzt', 'an'],
      ['Beschlüsse', null, 'offen'],
      ['Freigeben', null, 'offen'],
    ]);
    expect(B.mbStufen({ sitzung, beschluesse: DEMO, freigegeben: false }, '2029-02-12').map((s) => s.zustand)).toEqual(['done', 'done', 'done', 'an']);
  });

  it('wer in der Sitzung war: ohne doppelte; das Blatt „Vorbereiten“ beginnt beim ersten offenen Schritt', () => {
    expect(B.sitzungPersonen(sitzung).map((p) => p.name)).toEqual(['Robert Falk', 'Ines Kaltenbach', 'Jonas Wendlinger']);
    expect(B.personenZahl(3)).toBe('3 Personen');
    expect(B.vorbereitenStart({ sitzung: null, beschluesse: [] })).toBe('eingaben');
    expect(B.vorbereitenStart({ sitzung, beschluesse: [] })).toBe('beschluss');
    expect(B.vorbereitenStart({ sitzung, beschluesse: DEMO })).toBe('pruefen');
  });

  it('„Was die Leitung sah“: zehn Teile mit kurzen Namen; was der Abzug nicht trägt, ist unbekannt, nicht null', () => {
    const z = B.eingabenZeilen({ energieziele: [], massnahmen: [{} as never, {} as never] });
    expect(z.map((x) => x.titel)).toEqual([
      'Vorige Beschlüsse',
      'Grundlagen',
      'Energieziele',
      'Energieleistung',
      'Maßnahmen',
      'Abweichungen',
      'Audits und Feststellungen',
      'Energetische Bewertung',
      'Wiedervorlage',
      'Quellen',
    ]);
    expect(z.find((x) => x.key === 'energieziele')?.zahl).toBe(0);
    expect(z.find((x) => x.key === 'massnahmen')?.zahl).toBe(2);
    expect(z.find((x) => x.key === 'grundlagen')?.zahl).toBeNull();
    expect(B.teileZahl(z.length)).toBe('10 Teile');
  });

  it('die Erklärung nimmt das Beispiel aus den eigenen Daten', () => {
    expect(B.erklaerungManagementbewertung({ sitzung, beschluesse: DEMO })).toMatchObject({
      frage: 'Was ist eine Managementbewertung?',
      beiIhnen: 'Am 12.02.2029: 6 Beschlüsse.',
    });
    expect(B.erklaerungManagementbewertung(null).beiIhnen).toBeNull();
  });
});
