import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { ebenenBereiche, EBENEN_SEITEN } from './ebenenNav';
import * as E from './energiemanagementPortal';
import { dokumentRoute, energiemanagementRoute, hashForRoute, pageRoute, parseRoute, personRoute } from './nav';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import { rechteSeed } from './test/rollenFixtures';
import { werkAhrenberg, werkLindach } from './test/standorteFixtures';

const SHA = 'b045'.padEnd(60, '0') + '42bd';
const verweis = (teil: Partial<E.VerweisEntwurf> = {}): E.VerweisEntwurf => ({ ...E.LEERER_VERWEIS, ...teil });

describe('UEMS AP-19 IP-9 · Energiemanagement im Portal', () => {
  it('der Bereich steht mit `energiemanagement.ansehen` neben den anderen Unternehmens-Seiten (§6.3)', () => {
    const lm = { standorte: [werkAhrenberg(), werkLindach()], funktionen: ahrenbergFunktionen(), kennzahlen: [] };
    expect(ebenenBereiche({ art: 'unternehmen' }, lm).map((b) => b.key)).not.toContain('energiemanagement');
    const mit = ebenenBereiche({ art: 'unternehmen' }, { ...lm, energiemanagement: true }).map((b) => b.key);
    expect(mit[mit.length - 1]).toBe('energiemanagement');
    expect(EBENEN_SEITEN({ art: 'unternehmen' }).energiemanagement).toEqual(pageRoute('portfolio-energiemanagement'));
    expect(E.darfAnsehen(rechteSeed('IK').me)).toBe(true);
    expect(E.REITER.map((r) => r.label)).toEqual(['Verzeichnis', 'Dokumente', 'Aufgaben']);
  });

  it('Routen: Verzeichnis ohne Zusatz, Dokumente, Zuschnitt-Hilfe und ein Dokument hin und zurück', () => {
    expect(hashForRoute(energiemanagementRoute())).toBe('#/portfolio/energiemanagement');
    for (const r of [energiemanagementRoute('dokumente'), energiemanagementRoute('zuschnitt'), dokumentRoute('d-1')]) {
      expect(parseRoute(hashForRoute(r))).toEqual(r);
    }
    expect(hashForRoute(dokumentRoute('d-1'))).toBe('#/portfolio/energiemanagement/dokumente/d-1');
  });

  it('Anlegen: der Beleg ist ein Verweis — ohne Ablage keiner seiner Teile, nie eine Datei (G3)', () => {
    const basis = { art: 'energiepolitik', titel: 'Energiepolitik', bezug: 'unternehmen' as const, standortId: '' };
    expect(E.anlegenKoerper({ ...basis, original: verweis() })).toEqual({
      koerper: { art: 'energiepolitik', titel: 'Energiepolitik', bezug: { art: 'unternehmen' } },
    });
    expect(E.anlegenKoerper({ ...basis, original: verweis({ sha256: SHA }) })).toEqual({ fehler: { original: 'Bitte nennen Sie, wo das Original bei Ihnen liegt.' } });
    const r = E.anlegenKoerper({ ...basis, original: verweis({ ablage: ' QM-Laufwerk ', sha256: SHA, fassungsangabe: 'Rev. 1' }) });
    expect(r).toEqual({
      koerper: { art: 'energiepolitik', titel: 'Energiepolitik', bezug: { art: 'unternehmen' }, beleg: { bezeichnung: null, ablage: 'QM-Laufwerk', kennung: null, adresse: null, sha256: SHA } },
    });
    expect(E.anlegenKoerper({ ...basis, bezug: 'standort', original: verweis() })).toEqual({ fehler: { bezug: 'Bitte wählen Sie den Standort.' } });
  });

  it('Fassung: Wortlaut ODER Verweis mit den sieben Teilen; Begründung ab Fassung 2; der Anwendungsbereich nennt Standorte und Träger', () => {
    const e: E.FassungEntwurf = { form: 'wortlaut', wortlaut: 'Text', verweis: verweis({ ablage: 'bleibt draußen' }), standortIds: [], traeger: [], begruendung: '' };
    expect(E.fassungKoerper(e, 'energiepolitik', 1)).toEqual({ koerper: { form: 'wortlaut', wortlaut: 'Text' } });
    expect(E.fassungKoerper(e, 'energiepolitik', 2)).toEqual({ fehler: { begruendung: 'Bitte begründen Sie in 10 bis 500 Zeichen.' } });
    const v = E.fassungKoerper({ ...e, form: 'verweis', verweis: verweis({ ablage: 'Instandhaltungssystem', kennung: 'IH-SG-01', fassungsangabe: 'Rev. 4', sha256: SHA }) }, 'betrieb', 1);
    expect('koerper' in v && Object.keys(v.koerper.verweis!).sort()).toEqual(['ablage', 'adresse', 'bezeichnung', 'datum', 'fassungsangabe', 'kennung', 'sha256']);
    expect('koerper' in v && v.koerper).not.toHaveProperty('wortlaut');
    expect(E.fassungKoerper({ ...e, form: 'verweis', verweis: verweis() }, 'betrieb', 1)).toEqual({ fehler: { verweis: 'Bitte nennen Sie, wo das Original bei Ihnen liegt.' } });
    expect(E.fassungKoerper(e, 'anwendungsbereich', 1)).toEqual({
      fehler: { standorte: 'Bitte wählen Sie mindestens einen Standort.', traeger: 'Bitte wählen Sie mindestens einen Energieträger.' },
    });
    expect(E.fassungKoerper({ ...e, standortIds: ['st-1'], traeger: ['Strom', 'Gas'] }, 'anwendungsbereich', 1)).toEqual({
      koerper: { form: 'wortlaut', wortlaut: 'Text', anwendungsbereich: { standort_ids: ['st-1'], traeger: ['Strom', 'Gas'], ausschluesse: [] } },
    });
  });

  it('Freigabe: „entschieden von“ und Begründung Pflicht; die zweite Person schickt höchstens eine Begründung (DK3)', () => {
    expect(E.freigabeKoerper({ entschiedenVon: '', entschiedenAm: '2026-12-15', begruendung: 'kurz' }, false)).toEqual({
      fehler: { entschiedenVon: 'Bitte wählen Sie, wer entschieden hat.', begruendung: 'Bitte begründen Sie in 10 bis 500 Zeichen.' },
    });
    expect(E.freigabeKoerper({ entschiedenVon: 'rf', entschiedenAm: '2026-12-15', begruendung: 'Erste Fassung zum Start.' }, false)).toEqual({
      koerper: { entschieden_von: 'rf', entschieden_am: '2026-12-15', begruendung: 'Erste Fassung zum Start.' },
    });
    expect(E.freigabeKoerper({ entschiedenVon: 'rf', entschiedenAm: '2026-12-15', begruendung: '' }, true)).toEqual({ koerper: {} });
  });

  it('Person anlegen mit der Leitung: zwei Körper, die Aufgabe `unternehmensleitung` ohne „entschieden von“ (PA1, PA3)', () => {
    const e: E.PersonEntwurf = { name: 'Robert Falk', funktion: 'Geschäftsführer', kuerzel: 'RF', organisation: '', leitung: true, leitungAb: '2026-10-01', begruendung: 'Geschäftsführer seit Oktober.' };
    expect(E.personKoerper(e)).toEqual({
      person: { name: 'Robert Falk', funktion: 'Geschäftsführer', kuerzel: 'RF', organisation: null },
      leitung: { aufgabe: 'unternehmensleitung', gilt_ab: '2026-10-01', begruendung: 'Geschäftsführer seit Oktober.' },
    });
    expect(E.personKoerper({ ...e, leitung: false, begruendung: '' })).toMatchObject({ leitung: null });
  });

  it('Ort-Satz (§5.8) und Ablehnungen in Kundenworten', () => {
    expect(E.ortSatz({ beleg: { ablage: 'QM-Laufwerk, Ordner Energiemanagement/Politik' } }, { form: 'wortlaut', verweis: null })).toBe(
      'Wortlaut in VoltPilot, Original bei Ihnen: QM-Laufwerk, Ordner Energiemanagement/Politik.',
    );
    expect(
      E.ortSatz({ beleg: null }, { form: 'verweis', verweis: { ablage: 'Instandhaltungssystem, Arbeitspläne', kennung: 'IH-SG-01', fassungsangabe: 'Rev. 4', datum: '2028-11-03' } }),
    ).toBe('Geführt in Ihrem System: Instandhaltungssystem, Arbeitspläne (IH-SG-01, Rev. 4 vom 03.11.2028).');
    expect(E.ortSatz({ beleg: null }, { form: 'wortlaut', verweis: null })).toBeNull();
    expect(E.ablehnungSatz(new ApiError(422, 'x', { code: 'leitung_fehlt', message: 'x' }))).toBe(
      'Diese Fassung braucht eine Entscheidung der Leitung. Für die Aufgabe ‚Leitung des Unternehmens‘ ist keine Person festgelegt.',
    );
    expect(E.ablehnungSatz(new ApiError(422, 'x', { code: 'unbekannt', message: 'Satz der Route.' }))).toBe('Satz der Route.');
    expect(E.kurz(`sha256:${SHA}`)).toBe('b045…42bd');
    expect(E.bezugWort({ art: 'unternehmen', standort: null })).toBe('Unternehmen');
    expect(E.bezugWort({ art: 'energieeinsatz', standort: { id: 's', kurzzeichen: 'ST-1', name: 'Werk Ahrenberg' }, energieeinsatz: { id: 'e', kennzeichen: 'EE-1', name: 'Spritzguss' } })).toBe('EE-1 Spritzguss');
  });
});

describe('UEMS AP-19 IP-13 · Aufgaben, Wer ist wofür verantwortlich, Einsicht', () => {
  const RF = { id: 'rf', name: 'Robert Falk', funktion: 'Geschäftsführer', kuerzel: 'RF', mit_konto: false };
  const JW = { id: 'jw', name: 'Jonas Wendlinger', funktion: 'IT-Leitung', kuerzel: 'JW', mit_konto: true };
  const entwurf = (teil: Partial<E.ZuordnenEntwurf> = {}): E.ZuordnenEntwurf => ({
    aufgabe: 'bezugsbasen', wortlaut: '', personId: 'ik', giltAb: '2029-03-01', vertretungId: 'jw', entschiedenVon: 'rf',
    begruendung: 'Beschluss B4 der Managementbewertung 2028.', beleg: E.LEERER_VERWEIS, beschluss: 'BR-2029-0001/B4', ...teil,
  });

  it('Reiter „Aufgaben“ nach Dokumente (§6.3); Routen für Aufgaben, Verantwortung und Person', () => {
    expect(E.REITER.map((r) => r.key)).toEqual(['verzeichnis', 'dokumente', 'aufgaben']);
    for (const r of ['aufgaben', 'verantwortung'] as const) {
      expect(hashForRoute(energiemanagementRoute(r))).toBe(`#/portfolio/energiemanagement/${r}`);
      expect(parseRoute(`#/portfolio/energiemanagement/${r}`)).toEqual(energiemanagementRoute(r));
    }
    expect(hashForRoute(personRoute('a1'))).toBe('#/portfolio/energiemanagement/personen/a1');
    expect(parseRoute('#/portfolio/energiemanagement/personen/a1')).toEqual(personRoute('a1'));
  });

  it('Zuordnen: „entschieden von“ Pflicht außer bei der Leitung, Vertretung ist eine andere Person, Beschluss im Muster (PA2)', () => {
    expect(E.zuordnenKoerper(entwurf())).toEqual({
      koerper: {
        aufgabe: 'bezugsbasen', person_id: 'ik', gilt_ab: '2029-03-01', vertretung_person_id: 'jw', entschieden_von: 'rf',
        begruendung: 'Beschluss B4 der Managementbewertung 2028.', beleg: null, beschluss_kennung: 'BR-2029-0001/B4',
      },
    });
    expect(E.zuordnenKoerper(entwurf({ entschiedenVon: '' }))).toEqual({ fehler: { entschiedenVon: 'Bitte wählen Sie, wer entschieden hat.' } });
    const leitung = E.zuordnenKoerper(entwurf({ aufgabe: 'unternehmensleitung', entschiedenVon: '', vertretungId: '' }));
    expect('koerper' in leitung && leitung.koerper.entschieden_von).toBeNull();
    expect(E.zuordnenKoerper(entwurf({ vertretungId: 'ik' })).fehler?.vertretungId).toBeTruthy();
    expect(E.zuordnenKoerper(entwurf({ beschluss: 'B4' })).fehler?.beschluss).toBeTruthy();
    expect(E.zuordnenKoerper(entwurf({ aufgabe: 'weitere' })).fehler?.wortlaut).toBeTruthy();
    expect(E.zuordnenKoerper(entwurf({ begruendung: 'kurz' })).fehler?.begruendung).toBeTruthy();
  });

  it('Beenden: letzter Tag nicht vor „gilt ab“, Begründung Pflicht', () => {
    expect(E.beendenKoerper({ giltBis: '2029-02-28', begruendung: 'Übergabe an Ines Kaltenbach.' }, '2026-10-01')).toEqual({
      koerper: { gilt_bis: '2029-02-28', begruendung: 'Übergabe an Ines Kaltenbach.' },
    });
    expect(E.beendenKoerper({ giltBis: '2026-09-30', begruendung: 'Übergabe an Ines Kaltenbach.' }, '2026-10-01').fehler?.giltBis).toContain('01.10.2026');
  });

  it('Person ändern: ein anderes Konto und „bis“ verlangen eine Begründung; der ganze Stand geht mit (PUT)', () => {
    const e = { name: 'Robert Falk', funktion: 'Geschäftsführer', kuerzel: 'RF', organisation: '', kontoSub: '', seit: '2026-10-01', bis: '', begruendung: '' };
    expect(E.personAendernKoerper(e, null)).toEqual({
      koerper: { name: 'Robert Falk', funktion: 'Geschäftsführer', kuerzel: 'RF', organisation: null, konto_sub: null, seit: '2026-10-01', bis: null, begruendung: null },
    });
    expect(E.personAendernKoerper({ ...e, kontoSub: 'RF' }, null).fehler?.begruendung).toBeTruthy();
    expect(E.personAendernKoerper({ ...e, kontoSub: 'RF', begruendung: 'Konto seit 01.02.2029 für die Einsicht.' }, null)).toMatchObject({ koerper: { konto_sub: 'RF' } });
    expect(E.personAendernKoerper({ ...e, bis: '2026-09-01', begruendung: 'Ausgeschieden zum Monatsende.' }, null).fehler?.bis).toBeTruthy();
  });

  it('Sätze: Zuordnung wie R5/R11, Person ohne Konto, Freigaben der Bezugsbasen (R5) — ohne Urteil', () => {
    const z = { gilt_ab: '2029-03-01', gilt_bis: null, vertretung: JW, entschieden_von: RF };
    expect(E.zuordnungRest(z, '2029-03-01')).toBe(' seit 01.03.2029, Vertretung Jonas Wendlinger, entschieden von Robert Falk.');
    expect(E.zuordnungRest(z, '2029-02-12')).toBe(' ab 01.03.2029, Vertretung Jonas Wendlinger, entschieden von Robert Falk.');
    expect(E.zuordnungRest({ ...z, vertretung: null, entschieden_von: null, gilt_ab: '2026-10-01' }, '2029-01-22')).toBe(' seit 01.10.2026.');
    expect(E.personOhneKontoSatz(RF)).toBe('Robert Falk · Geschäftsführer · ohne Konto — erscheint als ‚entschieden von‘.');
    const f = (b: string, von: string) => ({ bezugsbasis: b, freigegeben_von: von });
    expect(E.freigabenSatz([f('BB-0001', 'Ines Kaltenbach'), f('BB-0001', 'Ines Kaltenbach'), f('BB-0002', 'Ines Kaltenbach')])).toBe('Alle 2 Bezugsbasen hat Ines Kaltenbach freigegeben.');
    expect(E.freigabenSatz([f('BB-0001', 'Ines Kaltenbach'), f('BB-0002', 'Jonas Wendlinger')])).toBeNull();
    expect(E.objekteNachArt([{ art: 'energieeinsatz' }, { art: 'bezugsbasis' }, { art: 'energieeinsatz' }]).map((g) => [g.wort, g.objekte.length]))
      .toEqual([['Energieeinsätze', 2], ['Bezugsbasen', 1]]);
  });

  it('„Einsicht“ erkennt die Rolle aus /me — Robert Falk (R6) ja, Ines Kaltenbach und Claudia Berger (Leser) nein', () => {
    const rf = rechteSeed('RF').me;
    expect(E.mitEinsicht(rf)).toBe(true);
    expect(E.darfAnsehen(rf)).toBe(true);
    expect(rf.unternehmen_rechte).not.toContain(E.RECHT_VERWALTEN);
    expect(rf.unternehmen_rechte).not.toContain(E.RECHT_FREIGEBEN);
    expect(E.mitEinsicht(rechteSeed('IK').me)).toBe(false);
    expect(E.mitEinsicht(rechteSeed('CB').me)).toBe(false);
  });
});

describe('UEMS AP-19 IP-15 · Nachweise am Einsatz und an der Person (§5.3, R7, R8)', () => {
  const EE1 = 'ee000000-0000-4000-8000-000000000001';
  const MD = 'a1900000-0000-4000-8000-0000000000a4';
  const ort = (teil: Partial<NonNullable<Parameters<typeof E.nachweisOrt>[0]['ort']>> = {}) => ({
    ort: 'verweis' as const, ort_satz: 'Geführt in Ihrem System: Instandhaltungssystem, Arbeitspläne',
    satz: 'Geführt in Ihrem System: Instandhaltungssystem, Arbeitspläne (IH-SG-01, Rev. 4 vom 03.11.2028).', inhalt_in_voltpilot: false,
    fassung: 1, festgehalten_am: '2028-11-10', ablage: 'Instandhaltungssystem, Arbeitspläne', kennung: 'IH-SG-01',
    adresse: 'https://instandhaltung.ahrenberg.example/plan/IH-SG-01', adresse_als_verweis: true, fassungsangabe: 'Rev. 4 vom 03.11.2028',
    datum: null, sha256: 'f0570ce5f1d332e648fe404bfe958841213b08b91c17667c3b0cd28c6acd49f9', ...teil,
  });
  const frist = (teil: Record<string, unknown> = {}) => ({
    abruf: '2028-11-10', faellig_am: '2029-11-10', basis: '2028-11-10', fassung: 1, tage: -365, satz: 'fällig in 365 Tagen', grund: null, ...teil,
  }) as NonNullable<Parameters<typeof E.nachweisUeberpruefung>[0]['ueberpruefung']>;

  it('„Nachweis festhalten“: der Bezug steht fest und geht mit genau seiner Kennung hinaus; die Arten sind die des Bezugs', () => {
    const basis = { art: 'betrieb', titel: 'Kriterien für Betrieb und Instandhaltung — Spritzguss', bezug: 'unternehmen' as const, standortId: '', original: verweis() };
    const einsatz: E.NachweisBezug = { art: 'energieeinsatz', id: EE1, wort: 'EE-1 Spritzguss' };
    expect(E.anlegenKoerper(basis, einsatz)).toEqual({
      koerper: { art: 'betrieb', titel: 'Kriterien für Betrieb und Instandhaltung — Spritzguss', bezug: { art: 'energieeinsatz', energieeinsatz_id: EE1 } },
    });
    // Ein Standort-Rest aus dem Entwurf zählt nicht, wenn der Bezug feststeht.
    expect(E.anlegenKoerper({ ...basis, bezug: 'standort' }, einsatz)).toMatchObject({ koerper: { bezug: { art: 'energieeinsatz' } } });
    expect(E.anlegenKoerper({ ...basis, art: 'kompetenz' }, { art: 'person', id: MD, wort: 'Murat Demirci' })).toMatchObject({
      koerper: { bezug: { art: 'person', person_id: MD } },
    });
    expect(E.nachweisBezugWort(einsatz)).toBe('Energieeinsatz EE-1 Spritzguss');
    expect(E.nachweisArtOptionen('energieeinsatz').map((o) => o.label)).toEqual(['Betrieb und Instandhaltung', 'Auslegung (Nachweis)', 'Beschaffung']);
    expect(E.nachweisArtOptionen('person').map((o) => o.value)).toEqual(['kompetenz']);
  });

  it('die Zeile sagt, wo das Original liegt — wörtlich von der Route, die Prüfsumme als Tag, nie der Inhalt (R7, G1)', () => {
    expect(E.nachweisOrt({ ort: ort(), zustand: 'gueltig' })).toBe('Geführt in Ihrem System: Instandhaltungssystem, Arbeitspläne (IH-SG-01, Rev. 4 vom 03.11.2028).');
    expect(E.nachweisOrt({ ort: ort({ satz: null, ort: 'in_voltpilot', ort_satz: 'In VoltPilot geführt' }), zustand: 'gueltig' })).toBe('In VoltPilot geführt.');
    expect(E.nachweisOrt({ ort: null, zustand: 'entwurf' })).toBe('Entwurf — noch keine Fassung freigegeben.');
    expect(E.nachweisPruefsumme({ ort: ort() })).toBe('Prüfsumme der Datei festgehalten am 10.11.2028.');
    expect(E.nachweisPruefsumme({ ort: ort({ sha256: null }) })).toBeNull();
    expect(E.nachweisPruefsumme({ ort: null })).toBeNull();
  });

  it('Überprüfung wie auf der Dokument-Seite; ein Nachweis wird aufbewahrt, nicht überprüft (DK5, R8)', () => {
    expect(E.nachweisUeberpruefung({ klasse: 'vorgabe', ueberpruefung: frist() })).toBe('Überprüfung fällig am 10.11.2029.');
    expect(E.nachweisUeberpruefung({ klasse: 'vorgabe', ueberpruefung: frist({ tage: 64, satz: 'seit 64 Tagen fällig' }) })).toBe('Überprüfung fällig seit 64 Tagen.');
    expect(E.nachweisUeberpruefung({ klasse: 'vorgabe', ueberpruefung: frist({ faellig_am: null, tage: null, satz: null, grund: 'keine_fassung' }) })).toBeNull();
    expect(E.nachweisUeberpruefung({ klasse: 'vorgabe', ueberpruefung: null })).toBeNull();
    expect(E.nachweisUeberpruefung({ klasse: 'nachweis', ueberpruefung: frist({ faellig_am: null, tage: null, satz: null, grund: 'nachweis' }) })).toBe('Ein Nachweis — ohne Überprüfung.');
  });
});
