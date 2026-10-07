import { describe, expect, it } from 'vitest';
import type { Bericht } from './api';
import { vergleichZeilen } from './berichtDialoge';
import { abzugAus } from './berichtSeite';
import * as N from './nachweisBerichte';
import { ABZUG_NR1, ABZUG_NR2, berichtAm, detailAm, entwurfAm, vergleichAm, ZEIT } from './test/berichtFixtures';

const t = (iso: string) => Date.parse(iso);
const nach = (iso: string) => t(iso) + 60_000;

/** Ein Bericht der Liste wie in der Demo (`rundgang`, 30.04.2029): Vorlage, Geltung, Stand und Tage. */
function bericht(b: Partial<Bericht> & Pick<Bericht, 'kennung' | 'vorlage'>): Bericht {
  return {
    vorlage_fassung: 1,
    geltung_art: 'unternehmen',
    geltung_id: 'u-1',
    geltung_name: 'Kunststoffwerk Ahrenberg GmbH',
    zeitraum_art: 'monat',
    zeitraum: '2026-10',
    zeitraum_text: 'Oktober 2026',
    zeitzone: 'Europe/Berlin',
    angelegt_von: { name: 'Ines Kaltenbach', rolle: null },
    angelegt_am: '2026-11-09T09:00:00Z',
    archiviert_am: null,
    stand_zeichen: 'berichtsstand',
    stand_text: 'Berichtsstand Nr. 1',
    neueste_nr: 1,
    entwurf_datenstand: null,
    freigegeben_am: '2026-11-10T08:02:00Z',
    anstoss_seit: null,
    ...b,
  };
}

const ueberpruefung = (abgeloest: string | null) => ({
  stand_nr: 1, stand_vom: '2027-11-24', wiedervorlage_monate: 12, faellig_am: null, ueberpruefung_faellig: false, faellig_seit_tagen: null,
  abgeloest_durch: abgeloest, wesentliche_einsaetze: 0, offene_bedarfe: 0, verantwortliche: [], ohne_verantwortliche: [],
});

const DEMO: Bericht[] = [
  bericht({ kennung: 'BR-2029-0002', vorlage: 'energetische_bewertung', zeitraum_art: 'datengrundlage', zeitraum_text: 'April 2028 bis März 2029', freigegeben_am: '2029-04-30T08:02:00Z', ueberpruefung: ueberpruefung(null) }),
  bericht({ kennung: 'BR-2029-0001', vorlage: 'managementbewertung', zeitraum_art: 'jahr', zeitraum_text: '2028', freigegeben_am: '2029-02-12T13:10:00Z' }),
  bericht({ kennung: 'BR-2028-0001', vorlage: 'leistungsvergleich', zeitraum_text: 'Dezember 2027', freigegeben_am: '2028-01-20T09:02:00Z' }),
  bericht({ kennung: 'BR-2027-0001', vorlage: 'energetische_bewertung', zeitraum_art: 'datengrundlage', zeitraum_text: 'November 2026 bis Oktober 2027', freigegeben_am: '2027-11-24T09:00:00Z', ueberpruefung: ueberpruefung('BR-2029-0002') }),
  bericht({
    kennung: 'BR-2026-0001', vorlage: 'monatsbericht_standort', geltung_art: 'standort', geltung_name: 'Werk Ahrenberg', stand_zeichen: 'revision_noetig',
    neueste_nr: 2, freigegeben_am: '2026-11-16T13:20:00Z', anstoss_seit: '2028-04-02T22:30:00Z',
  }),
  bericht({ kennung: 'BR-2029-0003', vorlage: 'monatsbericht_unternehmen', zeitraum_text: 'März 2029', neueste_nr: null, stand_zeichen: 'entwurf', freigegeben_am: null, angelegt_am: '2029-04-29T08:00:00Z' }),
  bericht({ kennung: 'BR-2026-0003', vorlage: 'monatsbericht_unternehmen', archiviert_am: '2027-01-05T10:00:00Z' }),
];

describe('Berichte in Nachweisen (Konzept n1, Runde 2, §6.4)', () => {
  it('nennt jeden Bericht nach seiner Vorlage, den Ort oder Zeitraum darunter (Entscheid 15)', () => {
    expect(DEMO.map((b) => N.berichtName(b))).toEqual([
      { titel: 'Energetische Bewertung', unter: 'April 2028 bis März 2029' },
      { titel: 'Managementbewertung 2028', unter: null },
      { titel: 'Leistungsvergleich Dezember 2027', unter: null },
      { titel: 'Energetische Bewertung', unter: 'November 2026 bis Oktober 2027' },
      { titel: 'Monatsbericht Oktober 2026', unter: 'Werk Ahrenberg' },
      { titel: 'Monatsbericht März 2029', unter: null },
      { titel: 'Monatsbericht Oktober 2026', unter: null },
    ]);
  });

  it('die Liste: erst was wartet (am längsten zuerst), dann was gilt (zuletzt frei zuerst), Abgelöstes und Archiviertes für sich', () => {
    const bild = N.berichteBild(DEMO);
    expect(bild.wartet.map((z) => [z.kennung, z.unter, z.datum, z.verb])).toEqual([
      ['BR-2026-0001', 'Daten geändert', { wort: 'seit', tag: '2028-04-03', ton: 'ueber' }, 'Entscheiden'],
      ['BR-2029-0003', 'Entwurf', { wort: 'seit', tag: '2029-04-29', ton: 'bald' }, 'Freigeben'],
    ]);
    expect(bild.gelten.map((z) => [z.kennung, z.datum?.tag, z.ziel, z.pdfNr])).toEqual([
      ['BR-2029-0002', '2029-04-30', 'bewertung', 1],
      ['BR-2029-0001', '2029-02-12', 'managementbewertung', 1],
      ['BR-2028-0001', '2028-01-20', 'bericht', 1],
    ]);
    expect(bild.abgeloest.map((z) => [z.kennung, z.ziel])).toEqual([['BR-2027-0001', 'bericht']]);
    expect(bild.archiviert.map((z) => z.kennung)).toEqual(['BR-2026-0003']);
    // Gezählt wird, was gilt (auch der wartende Monatsbericht: sein Stand 2 gilt noch), und was wartet - nie das Ganze.
    expect(bild.zaehler).toEqual({ gelten: 4, wartet: 2 });
    expect([N.geltenWort(1), N.geltenWort(4), N.wartetWort(1, true), N.wartetWort(2, false)]).toEqual(['gilt', 'gelten', 'wartet auf Sie', 'warten']);
  });

  it('der Tag des Datumsblocks ist der Tag in der Zone des Berichts, nicht der UTC-Tag', () => {
    expect(N.tagIn('2028-04-02T22:30:00Z', 'Europe/Berlin')).toBe('2028-04-03');
    expect(N.tagText('2026-11-10T08:02:00Z', 'Europe/Berlin')).toBe('10.11.2026');
    expect(N.zeitText('2026-11-12T09:05:33Z', 'Europe/Berlin')).toBe('12.11.2026, 10:05');
    expect(N.tagIn(null, 'Europe/Berlin')).toBeNull();
  });

  it('Status-Zeile und Stufen über die Zeit: Entwurf, Stand 1 gilt, Daten geändert, Stand 2 gilt', () => {
    const vor = detailAm(nach(ZEIT.angelegt));
    expect(N.seitenStatus(vor, null)).toMatchObject({ text: 'Entwurf', sub: null });
    expect(N.stufen(vor)).toEqual([
      { titel: 'Entwurf', datum: '10.11.2026', zustand: 'an' },
      { titel: 'Stand 1', datum: null, zustand: 'offen' },
    ]);

    const eins = detailAm(nach(ZEIT.nr1));
    expect(N.seitenStatus(eins, null)).toEqual({ zeichen: 'festgehalten', text: 'Stand 1 gilt', sub: '· Daten unverändert', warn: false });

    const korrektur = detailAm(nach(ZEIT.korrektur));
    expect(N.seitenStatus(korrektur, null)).toEqual({ zeichen: 'ueber', text: 'Daten geändert', sub: '· Stand 1 gilt noch', warn: true });
    expect(N.offeneAnstoesse(korrektur).map((a) => a.anlass_kennung)).toEqual(['K-2026-0007']);
    expect(N.stufen(korrektur).map((s) => [s.titel, s.zustand])).toEqual([['Entwurf', 'done'], ['Stand 1', 'done'], ['Stand 2', 'an']]);

    const zwei = detailAm(nach(ZEIT.nr2));
    expect(N.seitenStatus(zwei, null).text).toBe('Stand 2 gilt');
    expect(N.seitenStatus(zwei, 1)).toEqual({ zeichen: 'offen', text: 'Stand 1', sub: '· überholt', warn: false });
    expect(N.stufen(zwei)).toEqual([
      { titel: 'Entwurf', datum: '10.11.2026', zustand: 'done' },
      { titel: 'Stand 1', datum: '10.11.2026', zustand: 'done' },
      { titel: 'Stand 2', datum: '16.11.2026', zustand: 'done' },
    ]);
    expect(N.vorigerStand(zwei, 2)?.nr).toBe(1);
  });

  it('Geändert ggü. Stand 1: Werte alt → neu mit der Einheit einmal (Entscheid 16: nur Zahlen)', () => {
    const zeilen = N.standVergleich(ABZUG_NR1 as Record<string, unknown>, ABZUG_NR2 as Record<string, unknown>);
    expect(zeilen.length).toBeGreaterThan(0);
    const werte = N.werteAltNeu(zeilen);
    for (const w of werte) {
      expect(w.name).toBeTruthy();
      expect(`${w.alt} ${w.neu}`).not.toMatch(/kWh/);
    }
    expect(werte.some((w) => w.einheit === 'kWh')).toBe(true);
    // Derselbe Vergleich wie die Route für Entwurf gegen Stand 1 (R1-Zwilling).
    const route = vergleichAm(1, nach(ZEIT.korrektur));
    const ausRoute = vergleichZeilen(route.abweichungen, abzugAus(entwurfAm(nach(ZEIT.korrektur)).abzug), abzugAus(ABZUG_NR1));
    expect(N.werteAltNeu(ausRoute).map((w) => w.name)).toEqual(werte.map((w) => w.name));
  });

  it('der Grund einer Änderung: kurz für die Fußnote, ganz im Blatt, mit wer und wann', () => {
    const korrektur = detailAm(nach(ZEIT.korrektur));
    const anstoss = N.offeneAnstoesse(korrektur)[0];
    const g = N.aenderungsGrund(anstoss, ABZUG_NR2 as Record<string, unknown>, 'Europe/Berlin');
    expect(g).not.toBeNull();
    expect(g!.kurz.split(' ').length).toBeLessThanOrEqual(5);
    expect(g!.ganz.startsWith('Korrektur K-2026-0007')).toBe(true);
    expect(N.aenderungsGrund(null, null, 'Europe/Berlin')).toBeNull();
    expect([N.jaAntwort(2), N.neinAntwort(1)]).toEqual(['Ja, Stand 2 freigeben', 'Nein, Stand 1 behalten']);
    // Gebündelt (Entscheid 16): eine Korrektur mit ihrem Warum, mehrere als Zahl - im Blatt je Korrektur eine Zeile.
    const eine = N.aenderungsGruende([anstoss], ABZUG_NR2 as Record<string, unknown>, 'Europe/Berlin')!;
    expect(eine.kurz).toBe(g!.kurz);
    const zwei = N.aenderungsGruende([anstoss, { ...anstoss, anlass_kennung: 'K-2026-0008', anlass_text: 'Korrektur K-2026-0008' }], null, 'Europe/Berlin')!;
    expect([zwei.kurz, zwei.titel]).toEqual(['2 Korrekturen', '2 Korrekturen']);
    expect(zwei.zeilen.map((z) => z.etikett)).toEqual(['K-2026-0007', 'K-2026-0008']);
    expect(zwei.zeilen[1].wert).toBe('12.11.2026');
    expect(eine.titel).toBe('Grund');
    expect(eine.zeilen[0].etikett).toBe('Korrektur K-2026-0007');
    expect(N.aenderungsGruende([], null, 'Europe/Berlin')).toBeNull();
  });

  it('was die Freigabe hält, in höchstens vier Wörtern - der Satz der Route steht hinter dem i-Knopf', () => {
    const p = (z: boolean, w: boolean, e: boolean) => [
      { schluessel: 'zeitraum' as const, erfuellt: z },
      { schluessel: 'werte' as const, erfuellt: w },
      { schluessel: 'entwurf' as const, erfuellt: e },
    ];
    expect([N.freigabeKurz(p(true, true, true)), N.freigabeKurz(p(false, false, true)), N.freigabeKurz(p(true, false, true)), N.freigabeKurz(p(true, true, false))]).toEqual([
      'endgültig',
      'Zeitraum läuft noch',
      'Werte noch vorläufig',
      'Entwurf nicht aktuell',
    ]);
  });

  it('die Korrekturen eines Stands: offen seit, nicht übernommen mit Grund, in Stand n - und die Prüfsumme kurz', () => {
    const offen = detailAm(nach(ZEIT.korrektur)).anstoesse[0];
    expect(N.korrekturZeilen([offen], 'Europe/Berlin')).toEqual([{ etikett: 'K-2026-0007', wert: 'offen seit 12.11.2026' }]);
    expect(N.korrekturZeilen([{ ...offen, zustand: 'verworfen', verworfen_begruendung: 'Betrifft nur den 31.10.' }], 'Europe/Berlin')[0].wert).toBe('nicht übernommen: Betrifft nur den 31.10.');
    expect(N.korrekturZeilen([{ ...offen, zustand: 'erledigt', erledigt_durch_nr: 2 }], 'Europe/Berlin')[0].wert).toBe('in Stand 2');
    expect(N.pruefsummeKurz('sha256:0f0feda03d1979477a2596db5b9723399f227af0226a5397251704384de10d0d')).toBe('0f0feda03d19…0d0d');
  });

  it('Bewertung und Managementbewertung öffnen ihre Seite, eine abgelöste Bewertung die Berichtsseite', () => {
    expect(DEMO.map((b) => N.eigeneSeite(b))).toEqual(['bewertung', 'managementbewertung', 'bericht', 'bericht', 'bericht', 'bericht', 'bericht']);
    expect(N.berichteErklaerung(DEMO).beiIhnen).toBe('Leistungsvergleich Dezember 2027: Stand 1.');
    expect(N.berichteErklaerung([]).beiIhnen).toBeNull();
    expect(berichtAm(nach(ZEIT.nr2)).freigegeben_am).toBe(ZEIT.nr2);
  });
});
