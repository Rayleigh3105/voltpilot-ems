import { describe, expect, it } from 'vitest';
import {
  abschnitte,
  aendernAblehnung,
  aendernPruefen,
  anteileSumme,
  bestandAus,
  bisherAm,
  elektrischKarte,
  folgen,
  formularAus,
  gespeichertSatz,
  kostenstelleEndeSatz,
  kostenstelleOptionen,
  MARKE_GEPLANT,
  MARKE_HEUTE,
  MESSSTELLE_PROTOKOLL_ACHSE,
  namenAus,
  organisationKarte,
  ortAbTagAnfrage,
  ortKarte,
  prozesseAbTagAnfrage,
  restAnteil,
  SATZ,
  stellungAbTagAnfrage,
  summeSatz,
  unveraendertFehler,
  verteilungAbTagAnfrage,
  verteilungSpeicherbar,
  verteilungSummeSatz,
  zeitformAm,
  type AendernFormular,
  type Kataloge,
} from './messstelleZuordnung';
import { PFLICHT } from './messstelleDialog';
import {
  EINFUEHRUNG_TAG,
  KOSTENSTELLE_IDS,
  kostenstellenAhrenberg,
  ms06,
  ms08Angelegt,
  ms08OrtGeplant,
  ms08UmzugGeplant,
  ms08Vorher,
  PROZESS_IDS,
  prozesseAhrenberg,
  prozesseVon,
  SEITE_HEUTE,
  verteilungVon,
} from './test/messstelleSeiteFixtures';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from './test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from './test/standorteFixtures';

/**
 * Die Messstellen-Seite (UEMS AP-04 IP-8) — die reine Hälfte, NUR mit dem Referenzunternehmen
 * Ahrenberg (heute = 20.10.2026). Prüfnachweis des Reports: die Ableitung der Historie je Karte
 * und das Kennzeichen „rückwirkend“ — „geplant“ gleich mit.
 */

const ZONE = 'Europe/Berlin';
const NBSP = String.fromCharCode(160);

function namen() {
  const s = ahrenbergHeute();
  return namenAus(s, { [FIXTURE_IDS.st1]: ortsbaumAhrenberg(), [FIXTURE_IDS.st2]: ortsbaumLindach() }, ahrenbergRegister().register);
}

function kataloge(): Kataloge {
  return { namen: namen(), prozesse: prozesseAhrenberg(), kostenstellen: kostenstellenAhrenberg() };
}

describe('Historie je Karte — der Zeitstrahl aus den Intervallen', () => {
  it('MS-06 heute: Ort Halle 1 Nord in Halle 1 · Werk Ahrenberg seit 12.03.2024, eine Zeile „gilt heute“', () => {
    const karte = ortKarte(ms06(), SEITE_HEUTE, namen());
    expect(karte.titel).toBe('Ort');
    const [z] = karte.zeilen;
    expect(z.heute).toEqual({ wert: 'Halle 1 Nord', neben: 'Halle 1 · Werk Ahrenberg', zeitraum: 'seit 12.03.2024' });
    expect(z.leer).toBeNull();
    expect(z.danach).toBeNull();
    expect(z.historie).toEqual([
      {
        schluessel: '2024-03-12',
        wert: 'Halle 1 Nord',
        neben: 'Halle 1 · Werk Ahrenberg',
        zeitraum: 'seit 12.03.2024',
        zustand: 'gueltig',
        marke: MARKE_HEUTE,
      },
    ]);
  });

  it('MS-08 nach dem eingetragenen Umzug: Halle 1 Süd endet am 28.02.2027, Halle 2 Montage ab 01.03.2027 „geplant“ steht oben', () => {
    const [z] = ortKarte(ms08OrtGeplant(), SEITE_HEUTE, namen()).zeilen;
    expect(z.heute).toEqual({
      wert: 'Halle 1 Süd',
      neben: 'Halle 1 · Werk Ahrenberg',
      zeitraum: 'seit 12.03.2024 · endet 28.02.2027',
    });
    expect(z.danach).toEqual({ text: 'ab 01.03.2027: Halle 2 Montage', marke: MARKE_GEPLANT });
    expect(z.historie.map((h) => [h.wert, h.zeitraum, h.zustand, h.marke])).toEqual([
      ['Halle 2 Montage', 'ab 01.03.2027', 'geplant', 'geplant'],
      ['Halle 1 Süd', '12.03.2024 bis 28.02.2027', 'gueltig', 'gilt heute'],
    ]);
  });

  it('MS-08 Elektrisch: „Unterzähler von MS-01“ in Halle 1, danach „Unterzähler von MS-10“ in Halle 2 — die Anlage ist Nebenzeile', () => {
    const [z] = elektrischKarte(ms08UmzugGeplant(), SEITE_HEUTE, namen()).zeilen;
    expect(z.heute).toEqual({
      wert: 'Unterzähler von MS-01',
      neben: 'Werk Ahrenberg – Halle 1',
      zeitraum: 'seit 12.03.2024 · endet 28.02.2027',
    });
    expect(z.historie.map((h) => [h.wert, h.neben, h.zeitraum, h.marke])).toEqual([
      ['Unterzähler von MS-10', 'Werk Ahrenberg – Halle 2', 'ab 01.03.2027', 'geplant'],
      ['Unterzähler von MS-01', 'Werk Ahrenberg – Halle 1', '12.03.2024 bis 28.02.2027', 'gilt heute'],
    ]);
  });

  it('Organisation: Prozess und Kostenstelle je mit eigener Zeile; ein Satz aus zwei Anteilen ist EIN Abschnitt', () => {
    const m = ms06();
    const karte = organisationKarte(prozesseVon(m).prozesse, verteilungVon(m).anteile, SEITE_HEUTE);
    expect(karte.zeilen.map((z) => [z.titel, z.heute?.wert, z.heute?.zeitraum])).toEqual([
      ['Prozess', 'Spritzguss', 'seit 01.10.2026'],
      ['Kostenstelle', `4100 Spritzguss · 100${NBSP}%`, 'seit 01.10.2026'],
    ]);

    // Referenz MS-07: 70 % 4100 und 30 % 4200 ab 01.10.2026 — eine Zeile, beide Anteile.
    const zwei = [
      { ...verteilungVon(m).anteile[0], anteil_prozent: '70' },
      {
        ...verteilungVon(m).anteile[0],
        id: 'a-2',
        kostenstelle: { id: KOSTENSTELLE_IDS.k4200, kennzeichen: '4200' },
        name: 'Montage',
        anteil_prozent: '30',
      },
    ];
    const [, kosten] = organisationKarte([], zwei, SEITE_HEUTE).zeilen;
    expect(kosten.historie).toHaveLength(1);
    expect(kosten.heute?.wert).toBe(`4100 Spritzguss · 70${NBSP}%, 4200 Montage · 30${NBSP}%`);
  });

  it('eine Lücke zwischen zwei Intervallen bleibt stehen, nach dem letzten Ende gibt es keinen Abschnitt', () => {
    const xs = [
      { gueltig_ab: '2024-03-12', gueltig_bis: '2026-09-30', k: 'B-2' },
      { gueltig_ab: '2026-10-15', gueltig_bis: '2027-02-28', k: 'B-3' },
    ];
    expect(abschnitte(xs, (x) => x.k).map((a) => [a.ab, a.bis, a.teile.map((t) => t.k)])).toEqual([
      ['2024-03-12', '2026-09-30', ['B-2']],
      ['2026-10-01', '2026-10-14', []],
      ['2026-10-15', '2027-02-28', ['B-3']],
    ]);
  });

  it('nicht geladen ist keine leere Zuordnung: „Gerade nicht abrufbar.“ und kein Ändern', () => {
    const [prozess, kosten] = organisationKarte(null, null, SEITE_HEUTE).zeilen;
    expect([prozess.leer, prozess.geladen, kosten.leer, kosten.geladen]).toEqual([
      'Gerade nicht abrufbar.',
      false,
      'Gerade nicht abrufbar.',
      false,
    ]);
  });

  it('ohne Zuordnung heißt es so — nie eine erfundene', () => {
    const leer = { ...ms08Vorher(), orte: [], elektrische_stellung: [] };
    expect(ortKarte(leer, SEITE_HEUTE, namen()).zeilen[0].leer).toBe('Kein Ort zugeordnet');
    expect(elektrischKarte(leer, SEITE_HEUTE, namen()).zeilen[0].leer).toBe('Keine elektrische Stellung');
    expect(organisationKarte([], [], SEITE_HEUTE).zeilen.map((z) => z.leer)).toEqual(['Keinem Prozess zugeordnet', 'nicht verteilt']);
  });
});

describe('„rückwirkend“ und „geplant“ — der gewählte Tag gegen heute', () => {
  it('der Vertrag (A3): eingetragen am 01.10.2026, gilt ab 12.03.2024 → „rückwirkend (933 Tage)“ — das Abzeichen der Referenzdatei', () => {
    const z = zeitformAm('2024-03-12', '2026-10-01', ZONE)!;
    expect(z.art).toBe('rueckwirkend');
    expect(z.marke).toBe('rückwirkend (933 Tage)');
    expect(z.hinweis).toBe('rückwirkend ab 12.03.2024');
  });

  it('heute 20.10.2026: ein Tag davor ist rückwirkend, heute trägt kein Kennzeichen, der 01.03.2027 ist „geplant“', () => {
    expect(zeitformAm('2026-10-01', SEITE_HEUTE, ZONE)).toMatchObject({
      art: 'rueckwirkend',
      marke: 'rückwirkend (19 Tage)',
      betroffen: { von: '2026-10-01', bis: '2026-10-19' },
    });
    expect(zeitformAm(SEITE_HEUTE, SEITE_HEUTE, ZONE)).toMatchObject({ art: 'ab_heute', marke: null, hinweis: 'ab heute' });
    expect(zeitformAm('2027-03-01', SEITE_HEUTE, ZONE)).toMatchObject({
      art: 'geplant',
      marke: 'geplant',
      hinweis: 'geplant ab 01.03.2027',
      betroffen: null,
    });
    expect(zeitformAm('', SEITE_HEUTE, ZONE)).toBeNull();
  });

  it('der Satz an der Karte nach dem Speichern trägt dasselbe Kennzeichen', () => {
    expect(gespeichertSatz('ort', '2027-03-01', SEITE_HEUTE, ZONE)).toBe('Ort ab 01.03.2027 eingetragen · geplant.');
    expect(gespeichertSatz('prozesse', '2026-10-01', SEITE_HEUTE, ZONE)).toBe(
      'Prozesse ab 01.10.2026 eingetragen · rückwirkend (19 Tage).',
    );
    expect(gespeichertSatz('stellung', SEITE_HEUTE, SEITE_HEUTE, ZONE)).toBe('Elektrische Stellung ab 20.10.2026 eingetragen.');
  });
});

describe('Ändern ab <Tag> — Z4 „Ort ändern“ für MS-08', () => {
  const b = bestandAus(ms08Vorher(), prozesseVon(ms08Vorher()).prozesse, verteilungVon(ms08Vorher()).anteile);
  const f = (over: Partial<AendernFormular>): AendernFormular => ({ ...formularAus(b, SEITE_HEUTE), ...over });

  it('vorbelegt: Gilt ab = heute, der Ort leer („Neuer Ort“), Stellung, Prozess und Verteilung wie heute', () => {
    expect(formularAus(b, SEITE_HEUTE)).toEqual({
      tag: SEITE_HEUTE,
      ort: '',
      anlage: FIXTURE_IDS.an1,
      stellung: 'Unterzähler',
      unterzaehlerVon: 'MS-01',
      prozesse: [PROZESS_IDS.p4],
      anteile: [{ kostenstelle: KOSTENSTELLE_IDS.k4100, anteil: '100' }],
    });
  });

  it('„Bisher“ und „Was geschieht“: ab 01.03.2027 gehört MS-08 zu Halle 2 Montage, bis 28.02.2027 bleibt Halle 1 Süd — geplant', () => {
    const form = f({ ort: 'B-3', tag: '2027-03-01' });
    expect(bisherAm('ort', b, form.tag, namen())).toEqual({
      wert: 'Halle 1 Süd (B-2)',
      neben: 'Halle 1 · Werk Ahrenberg · seit 12.03.2024 — endet 28.02.2027',
    });
    expect(folgen({ art: 'ort', kennzeichen: 'MS-08', f: form, b, k: kataloge(), heute: SEITE_HEUTE, zone: ZONE })).toEqual({
      titel: 'Was geschieht',
      marke: 'geplant',
      saetze: [
        'Ab 01.03.2027 gehört MS-08 zu Halle 2 Montage (B-3); bis 28.02.2027 bleibt es bei Halle 1 Süd (B-2).',
        'Die elektrische Stellung und die Quelle ändern Sie in eigenen Schritten — nichts zieht still mit.',
      ],
    });
    expect(ortAbTagAnfrage(form, b)).toEqual({ kennzeichen: 'B-3', gueltig_ab: '2027-03-01' });
    expect(aendernPruefen('ort', form, b, kataloge())).toEqual({});
  });

  it('rückwirkend: die Tage, die nachträglich anders gelten, stehen da — und das Kennzeichen mit der Dauer', () => {
    const form = f({ ort: 'B-3', tag: '2026-10-01' });
    const r = folgen({ art: 'ort', kennzeichen: 'MS-08', f: form, b, k: kataloge(), heute: SEITE_HEUTE, zone: ZONE })!;
    expect(r.marke).toBe('rückwirkend (19 Tage)');
    expect(r.saetze[1]).toBe('Für die Tage vom 01.10.2026 bis 19.10.2026 gilt das nachträglich.');
  });

  it('derselbe Tag wie der Beginn des laufenden Intervalls ist eine Berichtigung (`korrektur`), kein zweites', () => {
    const form = f({ ort: 'B-3', tag: '2024-03-12' });
    expect(ortAbTagAnfrage(form, b)).toEqual({ kennzeichen: 'B-3', gueltig_ab: '2024-03-12', korrektur: true });
    expect(bisherAm('ort', b, form.tag, namen())?.neben).toBe('Halle 1 · Werk Ahrenberg · seit 12.03.2024 — wird ab 12.03.2024 berichtigt');
    expect(folgen({ art: 'ort', kennzeichen: 'MS-08', f: form, b, k: kataloge(), heute: SEITE_HEUTE, zone: ZONE })!.saetze[0]).toBe(
      'Der Eintrag ab 12.03.2024 (Halle 1 Süd (B-2)) wird berichtigt.',
    );
  });

  it('am 01.10.2026 (Einführung) den Ort ab 12.03.2024 eintragen: „rückwirkend (933 Tage)“ — das Abzeichen aus `zuordnungen`', () => {
    const neu = bestandAus(ms08Angelegt(), [], []);
    const form: AendernFormular = { ...formularAus(neu, EINFUEHRUNG_TAG), ort: 'B-2', tag: '2024-03-12' };
    expect(bisherAm('ort', neu, form.tag, namen())).toBeNull();
    expect(folgen({ art: 'ort', kennzeichen: 'MS-08', f: form, b: neu, k: kataloge(), heute: EINFUEHRUNG_TAG, zone: ZONE })).toEqual({
      titel: 'Was geschieht',
      marke: 'rückwirkend (933 Tage)',
      saetze: [
        'Ab 12.03.2024 gehört MS-08 zu Halle 1 Süd (B-2).',
        'Für die Tage vom 12.03.2024 bis 30.09.2026 gilt das nachträglich.',
        'Die elektrische Stellung und die Quelle ändern Sie in eigenen Schritten — nichts zieht still mit.',
      ],
    });
    expect(ortAbTagAnfrage(form, neu)).toEqual({ kennzeichen: 'B-2', gueltig_ab: '2024-03-12' });
  });

  it('„nichts zu ändern“ zeigt sich sofort und hat keine Folgen — kein „wird berichtigt“ für denselben Wert', () => {
    const form = f({ tag: '2026-10-01' });
    expect(unveraendertFehler('prozesse', form, b, kataloge())).toEqual({
      prozesse: 'Am 01.10.2026 gilt schon: Kühlung. Es gibt nichts zu ändern.',
    });
    expect(folgen({ art: 'prozesse', kennzeichen: 'MS-08', f: form, b, k: kataloge(), heute: SEITE_HEUTE, zone: ZONE })).toBeNull();
    expect(unveraendertFehler('ort', form, b, kataloge())).toEqual({});
  });

  it('Pflicht und „nichts zu ändern“', () => {
    expect(aendernPruefen('ort', f({ ort: '', tag: '' }), b, kataloge())).toEqual({ tag: PFLICHT.tag, ort: SATZ.ortFehlt });
    expect(aendernPruefen('ort', f({ ort: 'B-2' }), b, kataloge())).toEqual({
      ort: 'Am 20.10.2026 gilt schon: Halle 1 Süd. Es gibt nichts zu ändern.',
    });
    expect(aendernPruefen('stellung', f({}), b, kataloge())).toEqual({
      stellung: 'Am 20.10.2026 gilt schon: Unterzähler von MS-01. Es gibt nichts zu ändern.',
    });
    expect(aendernPruefen('stellung', f({ stellung: 'Unterzähler', unterzaehlerVon: '' }), b, kataloge())).toEqual({
      unterzaehlerVon: PFLICHT.unterzaehler,
    });
    expect(aendernPruefen('prozesse', f({}), b, kataloge())).toEqual({
      prozesse: 'Am 20.10.2026 gilt schon: Kühlung. Es gibt nichts zu ändern.',
    });
  });

  it('Elektrisch ab 01.03.2027: AN-2, „Unterzähler von MS-10“ — der Satz nennt die Anlage', () => {
    const form = f({ tag: '2027-03-01', anlage: FIXTURE_IDS.an2, unterzaehlerVon: 'MS-10' });
    expect(stellungAbTagAnfrage(form, b)).toEqual({
      anlage: FIXTURE_IDS.an2,
      stellung: 'Unterzähler',
      unterzaehler_von: 'MS-10',
      gueltig_ab: '2027-03-01',
    });
    expect(folgen({ art: 'stellung', kennzeichen: 'MS-08', f: form, b, k: kataloge(), heute: SEITE_HEUTE, zone: ZONE })!.saetze).toEqual([
      'Ab 01.03.2027 ist MS-08 Unterzähler von MS-10 in Werk Ahrenberg – Halle 2; bis 28.02.2027 bleibt es bei Unterzähler von MS-01.',
      'Den Ort und die Quelle ändern Sie in eigenen Schritten — nichts zieht still mit.',
    ]);
    expect(stellungAbTagAnfrage(f({ stellung: 'Hauptzähler', unterzaehlerVon: 'MS-01' }), b).unterzaehler_von).toBeNull();
  });

  it('Prozesse: der ganze Satz ab dem Tag (leer = zu keinem)', () => {
    expect(prozesseAbTagAnfrage(f({ tag: '2027-03-01', prozesse: [PROZESS_IDS.p4, PROZESS_IDS.p1] }))).toEqual({
      gueltig_ab: '2027-03-01',
      prozesse: [PROZESS_IDS.p4, PROZESS_IDS.p1],
    });
    const r = folgen({ art: 'prozesse', kennzeichen: 'MS-08', f: f({ prozesse: [] }), b, k: kataloge(), heute: SEITE_HEUTE, zone: ZONE })!;
    expect(r.saetze[0]).toBe('Ab 20.10.2026 gehört MS-08 zu keinem Prozess; bis 19.10.2026 bleibt es bei Kühlung.');
  });
});

describe('Kostenstellen ändern — die 100 % ruft den Vertrag (`uemsVerteilung.satz`)', () => {
  const b = bestandAus(ms06(), prozesseVon(ms06()).prozesse, verteilungVon(ms06()).anteile);
  const f = (anteile: AendernFormular['anteile'], tag = '2027-01-01'): AendernFormular => ({ ...formularAus(b, SEITE_HEUTE), tag, anteile });

  it('FEHLER-Tabelle §5.12: „Die Anteile ergeben 90 %. Sie müssen 100 % ergeben.“ — Rest vorgeschlagen', () => {
    const form = f([
      { kostenstelle: KOSTENSTELLE_IDS.k4100, anteil: '60' },
      { kostenstelle: KOSTENSTELLE_IDS.k4200, anteil: '30' },
    ]);
    expect(aendernPruefen('verteilung', form, b, kataloge())).toEqual({ anteile: summeSatz('90') });
    expect(summeSatz('90')).toBe(`Die Anteile ergeben 90${NBSP}%. Sie müssen 100${NBSP}% ergeben.`);
    expect(anteileSumme(form.anteile)).toBe('90');
    expect(restAnteil(form.anteile)).toBe('10');
    expect(verteilungSpeicherbar(form.anteile)).toBe(false);
    expect(verteilungSummeSatz(form.anteile)).toBe(
      `Summe: 90${NBSP}% · 10${NBSP}% fehlen — eine Verteilung ist vollständig oder existiert nicht.`,
    );
  });

  it('100 % ist speicherbar und leer bleibt der ausdrückliche Zustand „nicht verteilt“', () => {
    const ganz = [{ kostenstelle: KOSTENSTELLE_IDS.k4100, anteil: '100' }];
    expect(verteilungSpeicherbar(ganz)).toBe(true);
    expect(verteilungSummeSatz(ganz)).toBe(`Summe: 100${NBSP}% ✔`);
    expect(verteilungSpeicherbar([])).toBe(true);
  });

  it('eine Kostenstelle, die es am Tag nicht gibt: 9000 endet am 31.12.2026', () => {
    const form = f([{ kostenstelle: KOSTENSTELLE_IDS.k9000, anteil: '100' }]);
    expect(aendernPruefen('verteilung', form, b, kataloge())).toEqual({
      anteile: 'Die Kostenstelle 9000 besteht am 01.01.2027 nicht. Wählen Sie eine andere.',
    });
    expect(kostenstelleOptionen(kostenstellenAhrenberg(), '2027-01-01').map((o) => o.label)).toEqual([
      '4100 Spritzguss',
      '4200 Montage',
      '4300 Logistik',
      '9010 Druckluft',
      '9020 Kühlung',
      '9100 Verwaltung',
    ]);
    expect(kostenstelleEndeSatz(kostenstellenAhrenberg(), KOSTENSTELLE_IDS.k9000, '2026-10-01')).toBe(
      'endet mit Kostenstelle 9000 am 31.12.2026',
    );
    expect(kostenstelleEndeSatz(kostenstellenAhrenberg(), KOSTENSTELLE_IDS.k9000, '2027-01-01')).toBeNull();
  });

  it('Form, Doppelt, Kommazahl; leer ist „nicht verteilt“ und kein Fehler', () => {
    expect(aendernPruefen('verteilung', f([{ kostenstelle: KOSTENSTELLE_IDS.k4100, anteil: '1,25' }]), b, kataloge())).toEqual({
      anteile: SATZ.anteilFormat,
    });
    expect(
      aendernPruefen(
        'verteilung',
        f([
          { kostenstelle: KOSTENSTELLE_IDS.k4100, anteil: '50' },
          { kostenstelle: KOSTENSTELLE_IDS.k4100, anteil: '50' },
        ]),
        b,
        kataloge(),
      ),
    ).toEqual({ anteile: SATZ.kostenstelleDoppelt });
    const ok = f([
      { kostenstelle: KOSTENSTELLE_IDS.k4100, anteil: '66,5' },
      { kostenstelle: KOSTENSTELLE_IDS.k4200, anteil: '33,5' },
    ]);
    expect(aendernPruefen('verteilung', ok, b, kataloge())).toEqual({});
    expect(verteilungAbTagAnfrage(ok, b)).toEqual({
      gueltig_ab: '2027-01-01',
      zeilen: [
        { kostenstelle_id: KOSTENSTELLE_IDS.k4100, anteil_prozent: '66.5' },
        { kostenstelle_id: KOSTENSTELLE_IDS.k4200, anteil_prozent: '33.5' },
      ],
    });
    expect(aendernPruefen('verteilung', f([]), b, kataloge())).toEqual({});
    expect(folgen({ art: 'verteilung', kennzeichen: 'MS-06', f: f([]), b, k: kataloge(), heute: SEITE_HEUTE, zone: ZONE })!.saetze[0]).toBe(
      'Ab 01.01.2027 ist MS-06 nicht verteilt; bis 31.12.2026 bleibt es bei 4100 Spritzguss · 100 %.'.replace(' %', `${NBSP}%`),
    );
  });

  it('am Beginn des laufenden Satzes ist es eine Berichtigung, und derselbe Satz ist „nichts zu ändern“', () => {
    const same = f([{ kostenstelle: KOSTENSTELLE_IDS.k4100, anteil: '100' }], '2026-10-01');
    expect(aendernPruefen('verteilung', same, b, kataloge())).toEqual({
      anteile: `Am 01.10.2026 gilt schon: 4100 Spritzguss · 100${NBSP}%. Es gibt nichts zu ändern.`,
    });
    const neu = f([{ kostenstelle: KOSTENSTELLE_IDS.k4200, anteil: '100' }], '2026-10-01');
    expect(verteilungAbTagAnfrage(neu, b).korrektur).toBe(true);
  });
});

describe('Ablehnungen der Schnittstelle', () => {
  const anlage = (id: string) => (id === FIXTURE_IDS.an1 ? 'Werk Ahrenberg – Halle 1' : null);

  it('Ort/Stellung sprechen die FEHLER-Tabelle des Dialogs — der Hauptzähler-Satz mit dem Anlagen-Namen', () => {
    const err = {
      status: 409,
      body: { code: 'hauptzaehler_vorhanden', message: 'x', bestehend: { kennzeichen: 'MS-01', name: 'Netzbezug Halle 1', anlage: FIXTURE_IDS.an1 } },
    };
    expect(aendernAblehnung('stellung', err, anlage)).toEqual({
      feld: 'stellung',
      satz: 'Werk Ahrenberg – Halle 1 hat bereits einen Hauptzähler: MS-01 Netzbezug Halle 1. Wählen Sie „Unterzähler von MS-01“ oder ändern Sie MS-01.',
    });
    expect(aendernAblehnung('ort', { status: 409, body: { code: 'zuordnung_ueberlappt', message: 'Am Tag gilt schon etwas.' } }, anlage)).toEqual({
      feld: 'tag',
      satz: 'Am Tag gilt schon etwas.',
    });
  });

  it('Prozesse/Verteilung: der Satz der Schnittstelle am Feld', () => {
    expect(aendernAblehnung('verteilung', { status: 422, body: { code: 'verteilung_summe', message: 'Die Anteile ergeben 90 %.' } }, anlage)).toEqual({
      feld: 'anteile',
      satz: 'Die Anteile ergeben 90 %.',
    });
    expect(aendernAblehnung('prozesse', { status: 500, message: 'Server' }, anlage)).toEqual({ feld: null, satz: 'Server' });
  });
});

it('das Protokoll der Seite steht nach der EINTRAGUNG (Captain-Entscheid 15.09.2026)', () => {
  expect(MESSSTELLE_PROTOKOLL_ACHSE).toBe('eintrag');
});
