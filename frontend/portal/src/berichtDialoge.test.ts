import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, type Selbstauskunft } from './api';
import {
  anlegenAnfrage,
  anlegenFehler,
  anlegenPruefen,
  begruendungFehler,
  BEGRUENDUNG_FEHLT,
  BEGRUENDUNG_ZU_KURZ,
  BEGRUENDUNG_ZU_LANG,
  darf,
  freigabeAntrag,
  freigabeFehler,
  freigabeVorschau,
  geltungen,
  kennzahlenDerGeltung,
  rechteAus,
  revisionBanner,
  seitenHebel,
  unveraendert,
  vergleichZeilen,
  vorlageKarten,
  zeitraumVorgabe,
  zeitraumVorschau,
  zeitraumWahlen,
  type BerichtRechte,
} from './berichtDialoge';
import { abzugAus } from './berichtSeite';
import { ABZUG_NR1, ABZUG_NR2, berichtAm, BR, detailAm, entwurfAm, ZONE } from './test/berichtFixtures';
import { kennzahlenDerWelt } from './test/kennzahlWerteFixtures';
import { FIXTURE_IDS } from './test/standorteFixtures';
import * as B from './uemsBericht';
import { zahlMitStellen } from './uemsErgebnis';
import { einheitWort, VERGLEICH_NACHKOMMASTELLEN } from './uemsKennzahl';

/**
 * Die Dialoge der Welt „Berichte“ (UEMS AP-12 IP-14) gegen die EINE Vektor-Datei `bericht-vectors.json`: jeder Satz, den
 * „Berichtsstand freigeben“ unter seine Voraussetzungen schreibt, ist der Kundensatz der Vektoren (B4 — und jede andere
 * `freigabe`-Prüfung der Datei); der Vergleich Entwurf gegen Berichtsstand zeigt genau die Abweichungen von B2. Die
 * Zeitachse der Fixtures ist die der Referenzdatei (10.11. Nr. 1 · 12.11. K-2026-0007 · 16.11. Nr. 2).
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
type Json = any;
const vektoren: Json = JSON.parse(readFileSync(resolve(V2, 'bericht-vectors.json'), 'utf8'));
const fall = (id: string): Json => vektoren.cases.find((c: Json) => c.id === id);
const pruefungen = (regel: string): Array<{ fall: string; p: Json }> =>
  (vektoren.cases as Json[]).flatMap((c) => (c.pruefungen as Json[]).filter((p) => p.regel === regel).map((p) => ({ fall: c.id, p })));

const am = (zeit: string): number => Date.parse(zeit);
const ST1 = FIXTURE_IDS.st1;
const ST2 = FIXTURE_IDS.st2;

const selbst = (standorte: Record<string, string[]>, unternehmen: string[]): BerichtRechte =>
  rechteAus({
    standorte: Object.entries(standorte).map(([id, rechte]) => ({ id, rechte })) as Selbstauskunft['standorte'],
    unternehmen_rechte: unternehmen,
  });
const STANDORT_ALLES = ['bericht.standort_abrufen', 'bericht.standort_freigeben', 'export.standort'];
/** B13: Ines (Energiemanager, beide Werke, Unternehmen), Peter (Bearbeiter Lindach), Claudia (Leser). */
const INES = selbst({ [ST1]: STANDORT_ALLES, [ST2]: STANDORT_ALLES }, ['bericht.unternehmen', 'export.unternehmen']);
const PETER = selbst({ [ST2]: STANDORT_ALLES }, []);
const CLAUDIA = selbst({ [ST1]: ['bericht.standort_abrufen'], [ST2]: ['bericht.standort_abrufen'] }, []);

describe('Berichtsstand freigeben — die Voraussetzungen sprechen die Sätze der Vektoren (B4, F1)', () => {
  const faelle = pruefungen('freigabe');

  it('liest wirklich die Vektoren (B4 a, b, c und die Randfälle)', () => {
    expect(faelle.filter((f) => f.fall === 'B4').length).toBeGreaterThanOrEqual(7);
    expect(faelle.map((f) => f.p.ergebnis.code)).toEqual(expect.arrayContaining(['zeitraum_nicht_zu_ende', 'werte_vorlaeufig', 'entwurf_veraltet', null]));
  });

  it.each(faelle.map((f) => [`${f.fall}: ${f.p.name}`, f.p] as const))('%s', (_name, p) => {
    const v = freigabeVorschau(p.eingang, null, 'de-DE');
    expect(v.satz).toBe(p.ergebnis.kundensatz);
    expect(v.erlaubt).toBe(p.ergebnis.erlaubt);
    expect(v.nr).toBe(p.eingang.letzte_nr + 1);
    if (p.ergebnis.erlaubt) expect(v.nr).toBe(p.ergebnis.nr);
    const erfuellt = Object.fromEntries(v.punkte.map((x) => [x.schluessel, x.erfuellt]));
    // Die erste nicht erfüllte Voraussetzung ist die, deren Code die Regel nennt; alle davor sind erfüllt.
    const reihenfolge = ['zeitraum_nicht_zu_ende', 'werte_vorlaeufig', 'entwurf_veraltet'];
    const erste = p.ergebnis.code === null ? 3 : reihenfolge.indexOf(p.ergebnis.code);
    ['zeitraum', 'werte', 'entwurf'].forEach((s, i) => {
      if (i < erste) expect(erfuellt[s], s).toBe(true);
      if (i === erste) expect(erfuellt[s], s).toBe(false);
    });
  });

  it('am Entwurf der Referenzdatei (10.11.2026 09:00): drei Häkchen, Nr. 1, der Datenstand im Text', () => {
    const jetzt = am('2026-11-10T08:00:00Z');
    const v = freigabeVorschau(freigabeAntrag(berichtAm(jetzt), entwurfAm(jetzt), detailAm(jetzt).staende, jetzt), null, 'de-DE');
    expect(v.punkte).toEqual([
      { schluessel: 'zeitraum', text: 'Zeitraum zu Ende', erfuellt: true },
      { schluessel: 'werte', text: 'Alle 18 Werte endgültig', erfuellt: true },
      { schluessel: 'entwurf', text: 'Entwurf aktuell (Datenstand 10.11.2026 08:55)', erfuellt: true },
    ]);
    expect(v).toMatchObject({ satz: null, erlaubt: true, nr: 1, ersetzt: null, knopf: 'Berichtsstand Nr. 1 freigeben' });
    expect(v.festgehalten).toBe('genau diesen Entwurf — Datenstand, Zeitzone Europe/Berlin, Zahlenformat de-DE werden festgehalten');
  });

  it('derselbe Entwurf am 20.10.2026: der Oktober läuft — der Satz ist wörtlich B4 a)', () => {
    const jetzt = am('2026-10-20T08:30:00Z');
    const v = freigabeVorschau(freigabeAntrag(berichtAm(jetzt), entwurfAm(jetzt), [], jetzt), null, 'de-DE');
    const b4a = fall('B4').pruefungen.find((p: Json) => p.ergebnis.code === 'zeitraum_nicht_zu_ende' && p.eingang.schluessel === '2026-10');
    expect(v.erlaubt).toBe(false);
    expect(v.satz).toBe(b4a.ergebnis.kundensatz);
    expect(v.punkte[0].erfuellt).toBe(false);
  });

  it('Revision (13.11.2026): Nr. 2, „ersetzt Berichtsstand Nr. 1“, Datenstand der Kaskade', () => {
    const jetzt = am('2026-11-13T08:00:00Z');
    const d = detailAm(jetzt);
    const v = freigabeVorschau(freigabeAntrag(d.bericht, entwurfAm(jetzt), d.staende, jetzt), 1, 'de-DE');
    expect(v).toMatchObject({ erlaubt: true, nr: 2, ersetzt: 'ersetzt Berichtsstand Nr. 1', knopf: 'Berichtsstand Nr. 2 freigeben' });
    expect(v.punkte[2].text).toBe('Entwurf aktuell (Datenstand 12.11.2026 10:05)');
  });

  it('eine abgelehnte Freigabe spricht den Satz der Route; nur `entwurf_veraltet` bietet „Entwurf neu laden“', () => {
    const b4c = fall('B4').pruefungen.find((p: Json) => p.ergebnis.code === 'entwurf_veraltet' && p.ergebnis.kundensatz.includes('K-2026-0007'));
    const satz = b4c.ergebnis.kundensatz;
    expect(freigabeFehler(new ApiError(409, satz, { code: 'entwurf_veraltet', message: satz }))).toEqual({ satz, neuLaden: true });
    const b4a = fall('B4').pruefungen.find((p: Json) => p.ergebnis.code === 'zeitraum_nicht_zu_ende').ergebnis.kundensatz;
    expect(freigabeFehler(new ApiError(422, b4a, { code: 'zeitraum_nicht_zu_ende', message: b4a }))).toEqual({ satz: b4a, neuLaden: false });
    expect(freigabeFehler(new Error('Netz'))).toEqual({ satz: 'Die Freigabe hat nicht geklappt.', neuLaden: false });
  });
});

describe('Vergleich Entwurf gegen Berichtsstand — die Abweichungen von B2 (R1)', () => {
  const b2 = fall('B2').pruefungen.filter((p: Json) => p.regel === 'abweichungen');
  const NR1 = abzugAus(ABZUG_NR1);
  const NR2 = abzugAus(ABZUG_NR2);

  it('Entwurf (= Nr. 2) gegen Nr. 1: MS-12, MS-15, KZ-0001 — Zahl, Version und Anlass in Kundensprache', () => {
    const vektor = b2.find((p: Json) => p.eingang.neu === 'BR-2026-0001/2').ergebnis.abweichungen;
    const route = B.abweichungen(vektoren.abzuege['BR-2026-0001/1'], vektoren.abzuege['BR-2026-0001/2']);
    expect(route).toEqual(vektor);
    const zeilen = vergleichZeilen(route, NR2, NR1);
    expect(zeilen.map((z) => [z.quelle, z.name, z.version, z.anlass])).toEqual([
      ['MS-12', 'Montage Linie M1', '1 → 2', 'Korrektur K-2026-0007'],
      ['MS-15', NR2.werte.find((w) => w.quelle === 'MS-15')?.name_zum_datenstand, '1 → 2', 'Korrektur K-2026-0007 (über die Formel)'],
      ['KZ-0001', NR2.kennzahlen.find((k) => k.quelle === 'KZ-0001')?.name_zum_datenstand, '1 → 2', 'Korrektur K-2026-0007 (über die Kennzahl)'],
    ]);
    for (const [i, v] of (vektor as Json[]).entries()) {
      if (v.quelle.startsWith('MS-')) {
        expect(zeilen[i].vorher).toBe(B.anzeige('menge', v.vorher, 'kWh', 'monat'));
        expect(zeilen[i].nachher).toBe(B.anzeige('menge', v.nachher, 'kWh', 'monat'));
      } else {
        const einheit = NR2.kennzahlen[0].einheit;
        expect(zeilen[i].vorher).toBe(zahlMitStellen(v.vorher, VERGLEICH_NACHKOMMASTELLEN, einheitWort(einheit)));
        expect(zeilen[i].nachher).toBe(zahlMitStellen(v.nachher, VERGLEICH_NACHKOMMASTELLEN, einheitWort(einheit)));
      }
    }
    expect(zeilen[0].vorher).toMatch(/^6\.100\skWh$/u);
    expect(zeilen[0].nachher).toMatch(/^6\.040\skWh$/u);
    // Vier Stellen: die zwei der Karte hießen beide „0,15“.
    expect(zeilen[2].vorher).toMatch(/^0,1488\s/u);
    expect(zeilen[2].nachher).toMatch(/^0,1473\s/u);
  });

  it('„15 Werte unverändert“ — 16 Werte und 2 Kennzahlen des Entwurfs, 3 Abweichungen', () => {
    expect(NR2.werte.length + NR2.kennzahlen.length).toBe(18);
    expect(unveraendert(NR2, 3)).toBe('15 Werte unverändert');
    expect(unveraendert(NR2, 17)).toBe('1 Wert unverändert');
  });

  it('Nr. 1 gegen sich selbst: keine Zeile', () => {
    const vektor = b2.find((p: Json) => p.eingang.neu === 'BR-2026-0001/1').ergebnis.abweichungen;
    expect(vektor).toEqual([]);
    expect(vergleichZeilen(B.abweichungen(vektoren.abzuege['BR-2026-0001/1'], vektoren.abzuege['BR-2026-0001/1']), NR1)).toEqual([]);
  });
});

describe('Revision nötig und Anstoß verwerfen (R1, R4, R5)', () => {
  it('13.11.2026: das Banner nennt den Anlass wie das Kennzeichen, erkannt, und dass Nr. 1 bleibt', () => {
    const jetzt = am('2026-11-13T08:00:00Z');
    const banner = revisionBanner(detailAm(jetzt));
    expect(banner).toEqual({
      titel: 'Revision nötig — Korrektur K-2026-0007',
      anstoesse: [{ id: detailAm(jetzt).anstoesse[0].id, zeile: 'Erkannt am 12.11.2026 10:05.', text: 'Korrektur K-2026-0007 · erkannt 12.11.2026 10:05' }],
      satz: 'Der Berichtsstand Nr. 1 bleibt unverändert.',
      nr: 1,
    });
    expect(banner?.titel).toBe(berichtAm(jetzt).stand_text);
  });

  it('ohne offenen Anstoß kein Banner: vor der Korrektur, nach Nr. 2, am verworfenen Anstoß', () => {
    expect(revisionBanner(detailAm(am('2026-11-10T09:00:00Z')))).toBeNull();
    expect(revisionBanner(detailAm(am('2026-11-20T09:00:00Z')))).toBeNull();
    const d = detailAm(am('2026-11-13T08:00:00Z'));
    expect(revisionBanner({ ...d, anstoesse: d.anstoesse.map((a) => ({ ...a, zustand: 'verworfen' as const })) })).toBeNull();
  });

  it('die Begründung ist Pflicht: 10 bis 500 Zeichen, Leerraum zählt nicht', () => {
    expect(begruendungFehler('   ')).toBe(BEGRUENDUNG_FEHLT);
    expect(begruendungFehler('zu kurz  ')).toBe(BEGRUENDUNG_ZU_KURZ);
    expect(begruendungFehler('Korrektur betrifft nur den 31.10. nach Betriebsschluss, Bericht bleibt')).toBeNull();
    expect(begruendungFehler('x'.repeat(501))).toBe(BEGRUENDUNG_ZU_LANG);
    expect(begruendungFehler('x'.repeat(500))).toBeNull();
  });
});

describe('Hebel der Berichtsseite und Rechte (G1, §5.4, §5.5)', () => {
  it('Ines am Entwurf (10.11.): „Als Berichtsstand freigeben“, noch nichts zu vergleichen', () => {
    const jetzt = am('2026-11-10T08:00:00Z');
    const h = seitenHebel(detailAm(jetzt), entwurfAm(jetzt), INES, jetzt);
    expect(h.freigeben?.knopf).toBe('Als Berichtsstand freigeben');
    expect(h.freigeben?.vorschau.erlaubt).toBe(true);
    expect(h.vergleichen).toBeNull();
  });

  it('Ines am neu gebildeten Entwurf (13.11.): Nr. 2 freigeben, mit Nr. 1 vergleichen, Anstoß verwerfen', () => {
    const jetzt = am('2026-11-13T08:00:00Z');
    const h = seitenHebel(detailAm(jetzt), entwurfAm(jetzt), INES, jetzt);
    expect(h.freigeben?.knopf).toBe('Als Berichtsstand Nr. 2 freigeben');
    expect(h.vergleichen).toEqual({ knopf: 'Mit Berichtsstand Nr. 1 vergleichen', gegen: 1 });
    expect(h.verwerfen).toBe(true);
  });

  it('Claudia (Leser) sieht weder Freigeben noch Verwerfen, darf aber vergleichen; Peter nicht an Werk Ahrenberg', () => {
    const jetzt = am('2026-11-13T08:00:00Z');
    const claudia = seitenHebel(detailAm(jetzt), entwurfAm(jetzt), CLAUDIA, jetzt);
    expect(claudia).toMatchObject({ freigeben: null, verwerfen: false });
    expect(claudia.vergleichen?.gegen).toBe(1);
    expect(seitenHebel(detailAm(jetzt), entwurfAm(jetzt), PETER, jetzt)).toMatchObject({ freigeben: null, verwerfen: false });
  });

  it('am Stand (ohne Entwurf) kein Freigeben; unbekannte Rechte zeigen keinen schreibenden Hebel', () => {
    const jetzt = am('2026-11-13T08:00:00Z');
    expect(seitenHebel(detailAm(jetzt), null, INES, jetzt)).toMatchObject({ freigeben: null, vergleichen: null });
    expect(seitenHebel(detailAm(jetzt), entwurfAm(jetzt), null, jetzt).freigeben).toBeNull();
    expect(darf(null, 'anlegen', 'unternehmen', null)).toBe(false);
  });

  it('ein archivierter Bericht hat keinen schreibenden Hebel', () => {
    const jetzt = am('2026-11-13T08:00:00Z');
    const d = detailAm(jetzt);
    const archiviert = { ...d, bericht: { ...d.bericht, archiviert_am: '2026-11-13T07:00:00Z' } };
    expect(seitenHebel(archiviert, entwurfAm(jetzt), INES, jetzt)).toMatchObject({ freigeben: null, verwerfen: false });
  });

  it('die Rechte-Kennungen kommen aus `uemsBericht.kennung` (G1)', () => {
    expect(B.kennung('anlegen', 'standort')).toBe('bericht.standort_freigeben');
    expect(B.kennung('verwerfen', 'unternehmen')).toBe('bericht.unternehmen');
    expect(darf(PETER, 'anlegen', 'standort', ST2)).toBe(true);
    expect(darf(PETER, 'anlegen', 'standort', ST1)).toBe(false);
    expect(darf(PETER, 'anlegen', 'standort', null)).toBe(true);
    expect(darf(CLAUDIA, 'anlegen', 'standort', null)).toBe(false);
  });
});

describe('Bericht anlegen (§5.1, V1–V5, Q4)', () => {
  const STANDORTE = [
    { id: ST1, name: 'Werk Ahrenberg', zeitzone: ZONE, zustand: 'aktiv' as const },
    { id: ST2, name: 'Werk Lindach', zeitzone: ZONE, zustand: 'aktiv' as const },
    { id: 'st-alt', name: 'Altes Lager', zeitzone: ZONE, zustand: 'archiviert' as const },
  ];
  const UNTERNEHMEN = { id: FIXTURE_IDS.u, name: 'Kunststoffwerk Ahrenberg GmbH', zeitzone: ZONE };

  it('Vorlage-Karten: vier für Ines; Peter nur die zwei des Standorts — die des Unternehmens sind gar nicht da (§5.5)', () => {
    const ids = STANDORTE.map((s) => s.id);
    const ines = vorlageKarten(INES, ids);
    expect(ines.map((k) => k.schluessel)).toEqual(['monatsbericht_standort', 'jahresbericht_standort', 'monatsbericht_unternehmen', 'jahresbericht_unternehmen']);
    expect(ines[0]).toMatchObject({ name: 'Monatsbericht Standort', fassung: 'Fassung 1', geltungArt: 'standort', zeitraumArt: 'monat' });
    expect(ines[0].abschnitte).not.toContain('Kopf');
    expect(ines[0].abschnitte).toContain('Quellenverzeichnis');
    expect(vorlageKarten(PETER, ids).map((k) => k.geltungArt)).toEqual(['standort', 'standort']);
    expect(vorlageKarten(CLAUDIA, ids)).toEqual([]);
    expect(vorlageKarten(null, ids)).toEqual([]);
  });

  it('Geltung: Peter nur Werk Lindach, Ines beide aktiven Werke, das Unternehmen nur mit `bericht.unternehmen`', () => {
    expect(geltungen('standort', STANDORTE, UNTERNEHMEN, PETER).map((g) => g.name)).toEqual(['Werk Lindach']);
    expect(geltungen('standort', STANDORTE, UNTERNEHMEN, INES).map((g) => g.name)).toEqual(['Werk Ahrenberg', 'Werk Lindach']);
    expect(geltungen('unternehmen', STANDORTE, UNTERNEHMEN, INES)).toEqual([{ id: FIXTURE_IDS.u, name: 'Kunststoffwerk Ahrenberg GmbH', zone: ZONE }]);
    expect(geltungen('unternehmen', STANDORTE, UNTERNEHMEN, PETER)).toEqual([]);
  });

  it('Zeitraum: am 10.11.2026 läuft der November, vorbelegt ist der Oktober; das Jahr 2025', () => {
    const jetzt = am('2026-11-10T08:00:00Z');
    const monate = zeitraumWahlen('monat', jetzt, ZONE);
    expect(monate.slice(0, 3)).toEqual([
      { id: '2026-11', label: 'November 2026 · läuft' },
      { id: '2026-10', label: 'Oktober 2026' },
      { id: '2026-09', label: 'September 2026' },
    ]);
    expect(monate).toHaveLength(24);
    expect(monate.at(-1)?.id).toBe('2024-12');
    expect(zeitraumVorgabe('monat', jetzt, ZONE)).toBe('2026-10');
    expect(zeitraumVorgabe('jahr', jetzt, ZONE)).toBe('2025');
    expect(zeitraumWahlen('jahr', jetzt, ZONE)[0]).toEqual({ id: '2026', label: '2026 · läuft' });
  });

  it('Zeitraum in der Zone: Silvester 23:30 UTC ist in Berlin schon Januar', () => {
    const jetzt = am('2026-12-31T23:30:00Z');
    expect(zeitraumWahlen('monat', jetzt, ZONE)[0].id).toBe('2027-01');
    expect(zeitraumVorgabe('monat', jetzt, ZONE)).toBe('2026-12');
  });

  it('Voraussetzungs-Vorschau: läuft · zu Ende, endgültig ab · endgültig seit (Frist aus V1)', () => {
    expect(zeitraumVorschau('monat', '2026-10', ZONE, am('2026-10-20T08:30:00Z'))).toEqual({
      laeuft: true,
      text: 'Zeitraum läuft — ein Berichtsstand ist ab 08.11.2026 möglich',
    });
    expect(zeitraumVorschau('monat', '2026-10', ZONE, am('2026-11-05T08:00:00Z')).text).toBe('Der Oktober 2026 ist zu Ende · endgültig ab 08.11.2026');
    expect(zeitraumVorschau('monat', '2026-10', ZONE, am('2026-11-10T08:00:00Z')).text).toBe('Der Oktober 2026 ist zu Ende · endgültig seit 08.11.2026');
    expect(zeitraumVorschau('jahr', '2026', ZONE, am('2027-01-03T09:00:00Z')).text).toBe('Das Jahr 2026 ist zu Ende · endgültig ab 08.01.2027');
    // Dieselbe Frist wie der Satz der Freigabe (B4 Randfall Jahr): „ab dem 08.01.2027 möglich“.
    const randfall = fall('B4').pruefungen.find((p: Json) => p.eingang.zeitraum_art === 'jahr');
    expect(randfall.ergebnis.kundensatz).toContain('08.01.2027');
  });

  it('Kennzahlen der Geltung (Q4): am Werk Ahrenberg die des Standorts und seiner Messstellen, am Unternehmen die der Unternehmens-Ebene', () => {
    const alle = kennzahlenDerWelt();
    const werk = kennzahlenDerGeltung(alle, 'standort', ST1);
    expect(werk.length).toBeGreaterThan(0);
    expect(werk.every((k) => k.standort_id === ST1 && !['unternehmen', 'prozess', 'kostenstelle'].includes(k.geltung_art))).toBe(true);
    expect(werk.map((k) => k.kennzeichen)).toContain('KZ-0008');
    const unternehmen = kennzahlenDerGeltung(alle, 'unternehmen', FIXTURE_IDS.u);
    expect(unternehmen.map((k) => k.kennzeichen)).toContain('KZ-0007');
    expect(unternehmen.some((k) => k.standort_id !== null && k.geltung_art === 'messstelle')).toBe(false);
    expect([...werk.map((k) => k.kennzeichen)]).toEqual([...werk.map((k) => k.kennzeichen)].sort((a, b) => a.localeCompare(b, 'de')));
  });

  it('der Körper: ohne Abwahl ohne Feld (das Anlegen bleibt, wie es war), mit Abwahl nur Kennzahlen der Geltung', () => {
    const wahl = { vorlage: 'monatsbericht_standort', geltungId: ST1, zeitraum: '2026-10', abgewaehlt: [] };
    expect(anlegenAnfrage(wahl, ['kz-a', 'kz-b'])).toEqual({ vorlage: 'monatsbericht_standort', geltung_id: ST1, zeitraum: '2026-10' });
    expect(anlegenAnfrage({ ...wahl, abgewaehlt: ['kz-b', 'fremd', 'kz-a'] }, ['kz-a', 'kz-b'])).toEqual({
      vorlage: 'monatsbericht_standort',
      geltung_id: ST1,
      zeitraum: '2026-10',
      kennzahlen_abgewaehlt: ['kz-a', 'kz-b'],
    });
    expect(anlegenPruefen({ vorlage: null, geltungId: null, zeitraum: null, abgewaehlt: [] })).toEqual({
      vorlage: 'Wählen Sie eine Berichtsvorlage.',
      geltung: 'Wählen Sie, wofür der Bericht gilt.',
      zeitraum: 'Wählen Sie den Zeitraum.',
    });
    expect(anlegenPruefen(wahl)).toEqual({});
  });

  it('„Diesen Bericht gibt es schon“ (§5.8) spricht den Satz des Zwillings und bietet den Bericht an', () => {
    const satz = B.berichtGibtEsSchon(BR, 'Werk Ahrenberg', { art: 'monat', schluessel: '2026-10' });
    expect(satz).toBe('Diesen Bericht gibt es schon: BR-2026-0001 (Monatsbericht Werk Ahrenberg, Oktober 2026).');
    expect(anlegenFehler(new ApiError(409, satz, { code: 'bericht_gibt_es_schon', message: satz, kennung: BR }))).toEqual({ satz, kennung: BR });
    const leer = B.keineQuellen('Werk Lindach', { art: 'monat', schluessel: '2026-09' }, '2026-10-15');
    expect(anlegenFehler(new ApiError(422, leer, { code: 'keine_quellen', message: leer }))).toEqual({ satz: leer, kennung: null });
    expect(anlegenFehler(new TypeError('Netz'))).toEqual({ satz: 'Der Bericht konnte nicht angelegt werden.', kennung: null });
  });
});
