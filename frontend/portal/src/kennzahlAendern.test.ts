import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Kennzahl, KennzahlEingang, KennzahlFassung } from './api';
import * as E from './kennzahlAendern';
import * as A from './kennzahlAnlegen';
import { berechnung } from './kennzahlKarte';
import { fassungenK17, K17_BEGRUENDUNG, k17VorschauAntwort, kz0004 } from './test/kennzahlAendernFixtures';
import { fassungenVon, kennzahlenDerWelt, ZONE } from './test/kennzahlWerteFixtures';
import * as KZ from './uemsKennzahl';

/**
 * „Berechnung ändern ab …“, Stammdaten, Archivieren und Löschen (UEMS AP-11 IP-15, §5.4, §5.7) — die Ableitungen, gemessen
 * an der Vektor-Datei (K17 Regel `fassung`, `schnittstelle.ablehnungen`, das Kennzeichen „Eingang archiviert“) und an
 * den Zahlen des Referenzunternehmens Ahrenberg.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const lies = (datei: string): Json => JSON.parse(readFileSync(resolve(V2, datei), 'utf8'));
const vektoren: Json = lies('kennzahl-vectors.json');

const AM_20_MAERZ = Date.parse('2027-03-20T11:00:00+01:00');
const AM_1_APRIL = Date.parse('2027-04-01T09:31:00+02:00');
const MS24: KennzahlEingang[] = [
  { rolle: 'zaehler', art: 'messstelle', kennzeichen: 'MS-24' },
  { rolle: 'nenner', art: 'bezugsgroesse', kennzeichen: 'BZ-1' },
];
const kz = (kennzeichen: string): Kennzahl => kennzahlenDerWelt().find((k) => k.kennzeichen === kennzeichen)!;

describe('Gilt ab (V1) — vorab, Wort für Wort die Route', () => {
  const pruefungen = (vektoren.cases as Json[]).flatMap((c) =>
    (c.pruefungen as Json[]).filter((p) => p.regel === 'fassung').map((p) => ({ fall: c.id as string, ...p })),
  );

  it('liest wirklich die K17-Prüfungen der Regel „fassung“', () => {
    expect(pruefungen.map((p) => p.fall)).toEqual(['K17', 'K17']);
  });

  for (const p of pruefungen) {
    it(`${p.fall} · ${p.name}`, () => {
      expect(E.fassungEintrag(p.eingang.wirksam, p.eingang.ab, p.eingang.eingetragen_um, p.eingang.zeitzone)).toEqual(p.ergebnis);
    });
  }

  it('ein Tag VOR der jüngsten Fassung spricht den zweiten Satz von `fassungEintrag`', () => {
    const wirksam = E.wirksame(fassungenK17('nachher'));
    expect(E.fassungEintrag(wirksam, '2027-02-15', '2027-03-20T09:40:00+01:00', ZONE).kundensatz).toBe(
      'Ab dem 01.03.2027 gilt schon Fassung 2 — eine neue Fassung beginnt nach diesem Tag.',
    );
    expect(E.fassungEintrag(wirksam, '2027-03-02', '2027-03-20T09:40:00+01:00', ZONE)).toMatchObject({
      fehler: null,
      beenden: 2,
      beenden_am: '2027-03-01',
      abzeichen: 'rückwirkend (18 Tage)',
    });
  });

  it('rückwirkend nur VOR dem Eintragstag: heute und später tragen kein Abzeichen', () => {
    const wirksam = E.wirksame(fassungenK17('vorher'));
    const heute = E.fassungEintrag(wirksam, '2027-03-20', '2027-03-20T09:31:00+01:00', ZONE);
    expect([heute.rueckwirkend, heute.tage, heute.abzeichen]).toEqual([false, 0, null]);
    const morgen = E.fassungEintrag(wirksam, '2027-03-21', '2027-03-20T23:30:00+01:00', ZONE);
    expect([morgen.rueckwirkend, morgen.abzeichen]).toEqual([false, null]);
    // Kurz nach Mitternacht MEZ ist der Eintragstag schon der 21. — die Zeitzone des Standorts zählt, nicht UTC.
    expect(E.fassungEintrag(wirksam, '2027-03-20', '2027-03-20T23:30:00Z', ZONE).abzeichen).toBe('rückwirkend (1 Tag)');
  });

  it('der Satz unter dem Tag nennt die neue Fassung und das Ende der heutigen', () => {
    const wirksam = E.wirksame(fassungenK17('vorher'));
    const k17 = E.fassungEintrag(wirksam, '2027-03-01', '2027-03-20T09:31:00+01:00', ZONE);
    expect(E.abSatz(k17, '2027-03-01', '2027-03-20', 2)).toBe('Fassung 2 gilt ab 01.03.2027 — Fassung 1 endet am 28.02.2027.');
    const heute = E.fassungEintrag(wirksam, '2027-03-20', '2027-03-20T09:31:00+01:00', ZONE);
    expect(E.abSatz(heute, '2027-03-20', '2027-03-20', 2)).toBe('Fassung 2 gilt ab heute — Fassung 1 endet am 19.03.2027.');
    const nein = E.fassungEintrag(E.wirksame(fassungenK17('nachher')), '2027-03-01', '2027-03-20T09:40:00+01:00', ZONE);
    expect(E.abSatz(nein, '2027-03-01', '2027-03-20', 3)).toBeNull();
  });

  it('die neue Nummer zählt auch eine aufgehobene Fassung mit — nie wiederverwendet', () => {
    const [f1, f2] = fassungenK17('nachher');
    expect(E.naechsteNummer([f1, f2])).toBe(3);
    expect(E.naechsteNummer([f1, { ...f2, nummer: 3, aufgehoben_am: '2027-03-21T08:00:00+01:00' }])).toBe(4);
    expect(E.wirksame([f1, { ...f2, aufgehoben_am: '2027-03-21T08:00:00+01:00' }]).map((f) => f.nummer)).toEqual([1]);
  });
});

describe('Begründung: Pflicht, mindestens 10 Zeichen', () => {
  it('zählt ohne Rand-Leerzeichen und spricht erst, wenn das Feld berührt ist', () => {
    expect(E.begruendungOk('Kühlung')).toBe(false);
    expect(E.begruendungOk('  123456789  ')).toBe(false);
    expect(E.begruendungOk('1234567890')).toBe(true);
    expect(E.begruendungOk(K17_BEGRUENDUNG)).toBe(true);
    expect(E.begruendungFehler('Kühlung', false)).toBeNull();
    expect(E.begruendungFehler('Kühlung', true)).toBe('Noch 3 Zeichen — warum rechnet die Kennzahl ab diesem Tag anders?');
    expect(E.begruendungFehler(K17_BEGRUENDUNG, true)).toBeNull();
  });
});

describe('Schritte 2 und 3 mit den heutigen Eingängen vorbelegt', () => {
  it('KZ-0001: MS-12 je BZ-6 — unverändert, bis eine Seite anders ist', () => {
    const k = kz('KZ-0001');
    const f = E.aktuelleFassung(k, fassungenVon(k.id))!;
    const e = E.aenderEntwurf(k, f);
    expect([e.wahl, e.rechenform, e.menge, e.bezug, e.paare, e.periode]).toEqual([E.AENDERN, 'quotient', ['MS-12'], 'BZ-6', [], null]);
    expect(A.berechnungText(e)).toBe('Menge je Bezugsgröße · MS-12 je BZ-6');
    expect(E.unveraendert(e, f)).toBe(true);
    expect(E.unveraendert({ ...e, bezug: 'BZ-2' }, f)).toBe(false);
  });

  it('KZ-0003: die Paare KZ-0001 und KZ-0002; der Geltungsbereich bleibt der der Kennzahl', () => {
    const k = kz('KZ-0003');
    const e = E.aenderEntwurf(k, E.aktuelleFassung(k, fassungenVon(k.id))!);
    expect([e.rechenform, e.paare, e.menge, e.bezug]).toEqual(['zusammenfassung', ['KZ-0001', 'KZ-0002'], [], null]);
    expect(e.geltung).toBe(A.geltungWert('unternehmen', k.geltung_id));
  });

  it('der Körper von `POST …/fassungen`: Tag, getrimmte Begründung, die neuen Eingänge — kein Komplement beim Quotienten', () => {
    const k = kz0004('vorher');
    const e = { ...E.aenderEntwurf(k, fassungenK17('vorher')[0]), menge: ['MS-24'] };
    expect(E.fassungAnfrage(e, '2027-03-01', `  ${K17_BEGRUENDUNG} `)).toEqual({
      gueltig_ab: '2027-03-01',
      begruendung: K17_BEGRUENDUNG,
      periode_art: null,
      komplement: null,
      eingaenge: MS24,
    });
  });
});

describe('Vorschau: neu und bisher nebeneinander (§5.4)', () => {
  const k = kz0004('vorher');
  const bisherAnfrage = E.vorschauAnfrage(k, E.eingaengeAus(fassungenK17('vorher')[0]), null, false);
  const neuAnfrage = E.vorschauAnfrage(k, MS24, null, false);

  it('K17 am 01.04.2027: „März 2027: 0,30 statt 0,29“ — beide gerechnet von der Route, nicht vom Portal', () => {
    const v = E.vergleich(k17VorschauAntwort(neuAnfrage, AM_1_APRIL)!, k17VorschauAntwort(bisherAnfrage, AM_1_APRIL)!, 2, 1)!;
    expect(v.satz).toBe('März 2027: 0,30 statt 0,29');
    expect(v.einheit).toBe('kWh je kg');
    expect([v.neu.titel, v.neu.zahl, v.neu.zustand, v.bisher.titel, v.bisher.zahl]).toEqual([
      'Fassung 2 · neu',
      '0,30',
      'vollständig',
      'Fassung 1 · bisher',
      '0,29',
    ]);
  });

  it('am 20.03.2027 ist die letzte abgeschlossene Periode der Februar — MS-24 hat dort keinen Wert, das steht da', () => {
    const v = E.vergleich(k17VorschauAntwort(neuAnfrage, AM_20_MAERZ)!, k17VorschauAntwort(bisherAnfrage, AM_20_MAERZ)!, 2, 1)!;
    expect(v.satz).toBe('Februar 2027: — statt 0,28');
    expect(v.neu.satz).toBe('Für Februar 2027 fehlt die Menge MS-24 Spritzguss inkl. Kühlung.');
    expect(v.bisher.satz).toBeNull();
  });

  it('dieselbe Zahl heißt „wie bisher“; Befunde der neuen Fassung zeigen keinen Vergleich; ohne bisher steht „—“', () => {
    const bisher = k17VorschauAntwort(bisherAnfrage, AM_1_APRIL)!;
    expect(E.vergleich(bisher, bisher, 2, 1)!.satz).toBe('März 2027: 0,29 — wie bisher');
    const befund = { ...bisher, befunde: [{ code: 'periode_passt_nicht' as const, message: 'x', fakten: {} }] };
    expect(E.vergleich(befund, bisher, 2, 1)).toBeNull();
    expect(E.vergleich(bisher, null, 2, 1)!.satz).toBe('März 2027: 0,29 statt —');
  });

  it('eine andere Einheit der neuen Fassung: jede Zahl trägt ihre eigene', () => {
    const neu = k17VorschauAntwort(neuAnfrage, AM_1_APRIL)!;
    const bisher = k17VorschauAntwort(bisherAnfrage, AM_1_APRIL)!;
    const v = E.vergleich(neu, { ...bisher, einheit: 'kWh/Stück' }, 2, 1)!;
    expect(v.einheit).toBeNull();
    expect(v.neu.zahl).toBe(`0,30${String.fromCharCode(160)}kWh je kg`);
  });

  it('V2: eine Periode liest die Fassung ihres letzten Tags', () => {
    expect(E.wirkungSatz('2027-03-01', 'monat', 2, 1)).toBe('Ab März 2027 gilt Fassung 2 — Februar 2027 und früher bleiben bei Fassung 1.');
    expect(E.wirkungSatz('2027-03-15', 'monat', 2, 1)).toBe('Ab März 2027 gilt Fassung 2 — Februar 2027 und früher bleiben bei Fassung 1.');
    expect(E.wirkungSatz('2027-03-01', 'jahr', 3, 2)).toBe('Ab 2027 gilt Fassung 3 — 2026 und früher bleiben bei Fassung 2.');
    expect(E.wirkungSatz('2027-03-01', null, 2, 1)).toBeNull();
  });
});

describe('die Karte nach dem Speichern (K17)', () => {
  it('„Fassung 2 gilt seit 01.03.2027“ mit „rückwirkend (19 Tage)“; Fassung 1 bleibt lesbar mit Ende', () => {
    const b = berechnung(kz0004('nachher'), fassungenK17('nachher'), ZONE)!;
    expect(b.satz).toBe('Menge je Bezugsgröße · MS-24 je BZ-1 · Fassung 2 gilt seit 01.03.2027');
    expect(b.abzeichen).toBe('rückwirkend (19 Tage)');
    expect(b.fassungen.map((f) => [f.titel, f.zeitraum, f.abzeichen, f.warum])).toEqual([
      ['Fassung 2', 'seit 01.03.2027', 'rückwirkend (19 Tage)', `„${K17_BEGRUENDUNG}“`],
      ['Fassung 1', 'seit Beginn bis 28.02.2027', null, null],
    ]);
    expect(E.fertigSatz(E.neuesteFassung(fassungenK17('nachher'))!)).toBe('Fassung 2 gilt seit 01.03.2027');
  });

  it('der Fassungs-Verlauf steht nach der EINTRAGUNG, jüngste zuerst — gleich eingetragen: höhere Nummer zuerst', () => {
    const [f1, f2] = fassungenK17('nachher');
    const f3: KennzahlFassung = { ...f2, nummer: 3, gueltig_ab: '2027-03-15', eingetragen_am: '2027-03-22T08:00:00+01:00' };
    const k = { ...kz0004('nachher'), fassung: 3 };
    expect(berechnung(k, [f3, f1, f2], ZONE)!.fassungen.map((f) => f.titel)).toEqual(['Fassung 3', 'Fassung 2', 'Fassung 1']);
    const gleich = { ...f3, eingetragen_am: f2.eingetragen_am };
    expect(berechnung(k, [f1, gleich, f2], ZONE)!.fassungen.map((f) => f.titel)).toEqual(['Fassung 3', 'Fassung 2', 'Fassung 1']);
  });
});

describe('Stammdaten ändern — ohne Fassung (V4)', () => {
  const k = kz('KZ-0001');

  it('schickt die GANZEN Stammdaten mit unverändertem Kennzeichen; ein leerer Zweck ist `null`', () => {
    const e = { ...E.stammdatenEntwurf(k), zweck: '  ' };
    expect(E.stammdatenAnfrage(k, e)).toEqual({ kennzeichen: 'KZ-0001', name: k.name, verantwortlich_name: 'Ines Kaltenbach', zweck: null });
  });

  it('„Speichern“ erst mit einer Änderung und nie ohne Name oder Verantwortlich', () => {
    expect(E.stammdatenSpeicherbar(k, E.stammdatenEntwurf(k))).toBe(false);
    expect(E.stammdatenSpeicherbar(k, { ...E.stammdatenEntwurf(k), verantwortlich: 'Peter Hollerbach' })).toBe(true);
    expect(E.stammdatenSpeicherbar(k, { ...E.stammdatenEntwurf(k), name: ' ' })).toBe(false);
    expect(E.stammdatenSpeicherbar(k, { ...E.stammdatenEntwurf(k), name: `${k.name} ` })).toBe(false);
  });
});

describe('Archivieren und Löschen (V5, §5.7)', () => {
  const liste = kennzahlenDerWelt();
  const kz1 = kz('KZ-0001');
  const fassungenJe = Object.fromEntries(E.moeglicheLeser(kz1, liste).map((x) => [x.id, fassungenVon(x.id)]));

  it('die Sätze der Lösch-Sperre sind die von `schnittstelle.ablehnungen`', () => {
    const satz = (code: string) => (vektoren.schnittstelle.ablehnungen as Json[]).find((a) => a.code === code).satz;
    expect(E.ABLEHNUNG_SATZ.hat_werte).toBe(satz('hat_werte'));
    expect(E.ABLEHNUNG_SATZ.wird_gelesen).toBe(satz('wird_gelesen'));
  });

  it('nur Zusammenfassungen lesen Kennzahlen: KZ-0001 wird von KZ-0003 gelesen', () => {
    expect(E.moeglicheLeser(kz1, liste).map((k) => k.kennzeichen)).toEqual(['KZ-0003']);
    expect(E.leserVon(kz1, liste, fassungenJe).map((k) => k.kennzeichen)).toEqual(['KZ-0003']);
    expect(E.heutigeLeser(kz1, liste, fassungenJe).map((k) => k.kennzeichen)).toEqual(['KZ-0003']);
    const archiviert = liste.map((k) => (k.kennzeichen === 'KZ-0003' ? { ...k, archiviert_am: '2027-03-20T10:00:00+01:00' } : k));
    expect(E.heutigeLeser(kz1, archiviert, fassungenJe)).toEqual([]);
    expect(E.leserVon(kz1, archiviert, fassungenJe).map((k) => k.kennzeichen)).toEqual(['KZ-0003']);
  });

  it('„KZ-0001 hat Werte — archivieren Sie sie.“; ohne Wert, aber gelesen: der Satz von `wird_gelesen`; sonst frei', () => {
    const leser = E.leserVon(kz1, liste, fassungenJe);
    expect(E.loeschenSperre(kz1, leser)).toBe('KZ-0001 hat Werte — archivieren Sie sie.');
    expect(E.loeschenSperre({ ...kz1, hat_werte: false }, leser)).toBe('KZ-0001 wird von KZ-0003 gelesen — archivieren Sie sie stattdessen.');
    expect(E.loeschenSperre({ ...kz1, hat_werte: false }, [])).toBeNull();
    // Kennt die Seite die Leser nicht, entscheidet die Route.
    expect(E.loeschenSperre({ ...kz1, hat_werte: false }, null)).toBeNull();
    expect(E.loeschenSperre({ ...kz1, archiviert_am: '2027-03-20T10:00:00+01:00' }, leser)).toBe('KZ-0001 hat Werte und bleibt archiviert.');
  });

  it('„Eingang archiviert (KZ-0001)“ ist das Kennzeichen des Vertrags — an KZ-0003, sobald KZ-0001 archiviert ist', () => {
    const zustand = lies('ergebnis-zustand-vectors.json');
    const beispiel = JSON.stringify(zustand).match(/Eingang archiviert \(KZ-[0-9]{4}\)/)![0];
    expect(E.eingangArchiviert(beispiel.slice(-8, -1))).toBe(beispiel);
    expect(KZ.erkenne(E.eingangArchiviert('KZ-0001'))?.schluessel).toBe('eingang_archiviert');
    const kz3 = kz('KZ-0003');
    const f = E.aktuelleFassung(kz3, fassungenVon(kz3.id));
    expect(E.archivierteEingaenge(f, liste)).toEqual([]);
    const archiviert = liste.map((k) => (k.kennzeichen === 'KZ-0001' ? { ...k, archiviert_am: '2027-03-20T10:00:00+01:00' } : k));
    expect(E.archivierteEingaenge(f, archiviert)).toEqual(['Eingang archiviert (KZ-0001)']);
  });

  it('die Folgen des Archivierens nennen den Leser und das Kennzeichen, das er danach zeigt', () => {
    const folgen = E.archivierenFolgen(kz1, E.heutigeLeser(kz1, liste, fassungenJe));
    expect(folgen).toContain('KZ-0003 Stromeinsatz Montage je Stück — Unternehmen liest KZ-0001 und zeigt danach „Eingang archiviert (KZ-0001)“.');
    expect(folgen[0]).toBe('Alle Werte und Versionen bleiben lesbar.');
    expect(E.archiviertSatz({ archiviert_am: '2027-03-20T10:00:00+01:00' })).toBe(
      'Archiviert am 20.03.2027 — die Werte bleiben lesbar, VoltPilot rechnet sie nicht mehr.',
    );
  });
});

describe('der Assistent im Modus „ändern“', () => {
  it('vier Schritte: Gilt ab · Menge · Bezugsgröße · Vorschau — der Geltungsbereich entfällt', () => {
    expect(A.schrittWoerter('quotient', 'aendern')).toEqual(['Gilt ab', 'Menge', 'Bezugsgröße', 'Vorschau']);
    expect(A.schrittWoerter('zusammenfassung', 'aendern')).toEqual(['Gilt ab', 'Kennzahlen', 'entfällt', 'Vorschau']);
    expect(A.schrittWoerter('quotient')).toHaveLength(5);
    expect([1, 2, 3].map((s) => A.naechster(s as A.Schritt, 'quotient', 'aendern'))).toEqual([2, 3, 5]);
    expect(A.naechster(2, 'zusammenfassung', 'aendern')).toBe(5);
    expect([A.voriger(5, 'quotient', 'aendern'), A.voriger(5, 'zusammenfassung', 'aendern'), A.voriger(3, 'quotient', 'aendern')]).toEqual([3, 2, 2]);
    expect([A.naechster(3, 'quotient'), A.voriger(5, 'quotient'), A.naechster(2, 'zusammenfassung')]).toEqual([4, 4, 4]);
    expect([A.anzeigeNummer(5, 'aendern'), A.anzeigeNummer(6, 'aendern'), A.anzeigeNummer(5)]).toEqual([4, 5, 5]);
    expect(A.eyebrow(4, 'Vorschau', 4)).toBe('Schritt 4 von 4 · Vorschau');
  });

  it('ein Befund führt in einen Schritt, den es beim Ändern gibt', () => {
    expect(A.befundSchritt('eingang_ausserhalb_geltung', 'aendern', 'quotient')).toBe(3);
    expect(A.befundSchritt('rechenform_unbekannt', 'aendern', 'quotient')).toBe(2);
    expect(A.befundSchritt('periode_passt_nicht', 'aendern', 'zusammenfassung')).toBe(2);
    expect(A.befundSchritt('eingang_ausserhalb_geltung')).toBe(4);
  });
});
