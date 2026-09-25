import { describe, expect, it } from 'vitest';
import type { Feststellung, FeststellungEintrag, FeststellungStand, InternesAudit, InternesAuditHinweis } from './api';
import * as A from './auditFeststellung';
import { LEERER_VERWEIS } from './energiemanagementPortal';

/** UEMS AP-19 IP-20: das reine Bild der Reiter „Audits“ und „Feststellungen“ — Sätze aus §5.8 und die Körper der Routen. */
const CB = { id: 'cb', name: 'Claudia Berger', funktion: 'Controlling', kuerzel: 'CB', mit_konto: true };
const IK = { id: 'ik', name: 'Ines Kaltenbach', funktion: 'Energiemanagement', kuerzel: 'IK', mit_konto: true };
const eingetragen = { akteur: { sub: 'IK', name: 'Ines Kaltenbach', rolle: 'energiemanager', art: 'kunde' as const }, am: '2029-01-22T16:00:00+01:00' };

const audit = (over: Partial<InternesAudit> = {}): InternesAudit => ({
  id: 'au', kennzeichen: 'AU-2029-0001', titel: 'Internes Audit 2029', termin: '2029-01-22', auditoren: [CB], unabhaengigkeit: 'gehört nicht zum Energieteam',
  was: 'Bezugsbasen', woran: 'Energiepolitik D-0001', verantwortlich: { sub: 'IK', name: 'Ines Kaltenbach' }, standort_ids: [], zustand: 'durchgefuehrt',
  durchgefuehrt_am: '2029-01-22', abgesagt_begruendung: null, hinweise: 1, feststellungen: [], abschluss: null, eingetragen, ...over,
});
const feststellung = (over: Partial<Feststellung> = {}): Feststellung => ({
  id: 'f', kennzeichen: 'F-2029-0001', quelle: { art: 'internes_audit', audit_id: 'au', kennung: 'AU-2029-0001', wortlaut: null }, wortlaut: 'Nicht festgelegt.',
  vorgabe: { dokument_id: 'd1', dokument: 'D-0001', fassung: 1, wortlaut: '„Wir legen fest, wer wofür zuständig ist.“' },
  bezug: { standort_id: null, aufgabe: 'bezugsbasen', dokument_id: null, dokument: null, objekte: ['BB-0001', 'BB-0002'] },
  festgestellt_von: CB, festgestellt_am: '2029-01-22', verantwortlich: { sub: 'JW', name: 'Jonas Wendlinger' }, frist: '2029-04-22', zustand: 'offen',
  lage: { abruf: '2029-01-23', faellig_am: '2029-04-22', tage: -89, satz: 'fällig in 89 Tagen', grund: null }, ergebnis: null, eintraege: 0, massnahmen: [], eingetragen, ...over,
});

describe('UEMS AP-19 IP-20 · Audits und Feststellungen: Sätze aus §5.8', () => {
  it('Kopf des Audits: durchgeführt mit Funktion der Prüfenden, vorher der Plan', () => {
    expect(A.auditKopf(audit())).toBe('Internes Audit AU-2029-0001 · durchgeführt am 22.01.2029 von Claudia Berger (Controlling).');
    expect(A.auditKopf(audit({ zustand: 'geplant', durchgefuehrt_am: null }))).toBe('Internes Audit AU-2029-0001 · geplant am 22.01.2029 · Claudia Berger.');
  });

  it('Hinweis: festgestellt von der Person, die prüft, eingetragen von dem Konto (IA5, G2)', () => {
    const h: InternesAuditHinweis = { nr: 1, am: '2029-01-22', festgestellt_von: CB, wortlaut: 'x', eingetragen };
    expect(A.hinweisSatz(h)).toBe('Hinweis — festgestellt von Claudia Berger, eingetragen von Ines Kaltenbach am 22.01.2029.');
  });

  it('Kopf der Feststellung wörtlich aus §5.8, Vorgabe und Bezug in Kundenwörtern', () => {
    expect(A.feststellungKopf(feststellung())).toBe(
      'Feststellung F-2029-0001 · aus dem internen Audit AU-2029-0001 · festgestellt von Claudia Berger am 22.01.2029 · Verantwortlich Jonas Wendlinger · Frist 22.04.2029 · offen.',
    );
    expect(A.quelleWort({ art: 'eigene', audit_id: null, kennung: null, wortlaut: null })).toBe('eigene Feststellung');
    expect(A.quelleWort({ art: 'extern', audit_id: null, kennung: null, wortlaut: 'Kunde Nordmann' })).toBe('von außen: Kunde Nordmann');
    expect(A.vorgabeWort(feststellung().vorgabe)).toBe('D-0001, Fassung 1: „Wir legen fest, wer wofür zuständig ist.“');
    expect(A.bezugWort(feststellung().bezug, () => 'Bezugsbasen pflegen und freigeben')).toBe('Aufgabe „Bezugsbasen pflegen und freigeben“ · BB-0001, BB-0002');
    expect(A.bezugWort({ standort_id: null, aufgabe: null, dokument_id: null, dokument: null, objekte: [] }, (a) => a)).toBe('das Unternehmen');
  });

  it('Einträge sind Aussagen einer Person (FS2) — Behebung und Ursache mit den Schablonen', () => {
    const e = (art: FeststellungEintrag['art']): FeststellungEintrag => ({ id: 1, art, am: '2029-01-25', person: IK, wortlaut: 'Text.', eingetragen });
    expect(A.eintragSatz(e('behebung'))).toBe('Sofortige Behebung — Ines Kaltenbach, 25.01.2029: Text.');
    expect(A.eintragSatz(e('ursache_aussage'))).toBe('Ursache — Aussage von Ines Kaltenbach, 25.01.2029: Text.');
    expect(A.eintragSatz(e('aehnliche_faelle'))).toBe('Ähnliche Fälle geprüft — Ines Kaltenbach, 25.01.2029: Text.');
  });

  it('Stand: „Wirksamkeit geprüft am … — Stand Nr. 1 mit Prüfsumme.“ (FS4), ohne Maßnahme als Abschluss (FS5)', () => {
    const s = (ergebnis: FeststellungStand['ergebnis']): FeststellungStand => ({
      nr: 1, ergebnis, begruendung: 'Begründung genug.', am: '2029-04-15', entschieden_von: IK, kopie: {}, pruefsumme: `sha256:${'0'.repeat(64)}`, vieraugen: false,
      status: 'freigegeben', eingetragen, zweite_person: null, ablehnung_begruendung: null,
    });
    expect(A.standSatz(s('wirksam'))).toBe('Wirksamkeit geprüft am 15.04.2029 von Ines Kaltenbach: wirksam — Stand Nr. 1 mit Prüfsumme.');
    expect(A.standSatz(s('ohne_massnahme'))).toBe('Abgeschlossen am 15.04.2029 von Ines Kaltenbach: ohne Maßnahme abgeschlossen — Stand Nr. 1 mit Prüfsumme.');
  });

  it('Wirksamkeit prüfbar wie FS4 — jede umgesetzt, bewertet oder verworfen, mindestens eine umgesetzt oder bewertet', () => {
    expect(A.wirksamkeitPruefbar([])).toBe(false);
    expect(A.wirksamkeitPruefbar([{ zustand: 'geplant' }])).toBe(false);
    expect(A.wirksamkeitPruefbar([{ zustand: 'verworfen' }])).toBe(false);
    expect(A.wirksamkeitPruefbar([{ zustand: 'umgesetzt' }, { zustand: 'verworfen' }])).toBe(true);
    expect(A.wirksamkeitPruefbar([{ zustand: 'bewertet' }, { zustand: 'geplant' }])).toBe(false);
  });

  it('Herkunft der Maßnahme (SP5): das Kundenwort des Objekts, nie das Vertragswort', () => {
    expect(A.herkunftSatz('nichtkonformitaet', 'F-2029-0001')).toBe('Herkunft: Feststellung F-2029-0001.');
    expect(A.herkunftSatz('audit', 'AU-2029-0001')).toBe('Herkunft: internes Audit AU-2029-0001.');
    expect(A.herkunftSatz('managementbewertung', 'BR-2029-0001/B2')).toBe('Herkunft: Managementbewertung BR-2029-0001 (Beschluss 2).');
    expect(A.herkunftSatz('abweichung', 'AW-2028-0001')).toBeNull();
    expect(A.herkunftSatz('nichtkonformitaet', null)).toBeNull();
    expect(A.istKennzeichen('F-2029-0001')).toBe(true);
    expect(A.istKennzeichen('AU-2029-0001')).toBe(true);
    expect(A.istKennzeichen('f0190000-0000-4000-8000-00000000f001')).toBe(false);
  });
});

describe('UEMS AP-19 IP-20 · Audits und Feststellungen: Körper der Routen', () => {
  it('Audit planen verlangt alles aus IA1 und schickt genau den Stand', () => {
    expect(A.auditKoerper(A.LEERES_AUDIT)).toEqual({
      fehler: expect.objectContaining({ titel: expect.any(String), termin: expect.any(String), auditorIds: expect.any(String), unabhaengigkeit: expect.any(String), was: expect.any(String), woran: expect.any(String), verantwortlich: expect.any(String) }),
    });
    expect(A.auditKoerper({ titel: ' T ', termin: '2029-01-22', auditorIds: ['cb'], unabhaengigkeit: 'U', was: 'W', woran: 'V', verantwortlich: 'IK' })).toEqual({
      koerper: { titel: 'T', termin: '2029-01-22', auditor_ids: ['cb'], unabhaengigkeit: 'U', was: 'W', woran: 'V', verantwortlich: 'IK' },
    });
  });

  it('Abschließen: Bericht als Verweis ODER Zusammenfassung; nur die Prüfsumme, nie die Datei (G3)', () => {
    const leer = { entschiedenVon: 'ik', am: '2029-01-31', zusammenfassung: '', bericht: LEERER_VERWEIS, massnahmen: {} };
    expect('fehler' in A.auditAbschlussKoerper(leer) && A.auditAbschlussKoerper(leer)).toBeTruthy();
    const mitBericht = A.auditAbschlussKoerper({ ...leer, bericht: { ...LEERER_VERWEIS, ablage: 'QM-Laufwerk', sha256: 'a'.repeat(64) }, massnahmen: { 1: 'M-2029-0002', 2: '' } });
    expect(mitBericht).toEqual({
      koerper: {
        entschieden_von: 'ik', am: '2029-01-31', zusammenfassung: null, bericht: { bezeichnung: null, ablage: 'QM-Laufwerk', kennung: null, adresse: null, sha256: 'a'.repeat(64) },
        massnahmen: [{ hinweis: 1, massnahme: 'M-2029-0002' }],
      },
    });
  });

  it('Feststellung erfassen: Quelle mit genau ihrem Verweis, Vorgabe Pflicht, Frist nicht vor dem Tag', () => {
    const e = { ...A.leereFeststellung({ id: 'au', auditorId: 'cb', am: '2029-01-22' }), wortlaut: 'W', vorgabeWortlaut: 'V', verantwortlich: 'JW', aufgabe: 'bezugsbasen', objekte: 'BB-0001, BB-0002' };
    expect(A.feststellungKoerper(e)).toEqual({
      koerper: {
        quelle: { art: 'internes_audit', audit_id: 'au' }, wortlaut: 'W', vorgabe: { wortlaut: 'V' }, bezug: { aufgabe: 'bezugsbasen', objekte: ['BB-0001', 'BB-0002'] },
        festgestellt_von: 'cb', festgestellt_am: '2029-01-22', verantwortlich: 'JW', frist: null,
      },
    });
    expect(A.feststellungKoerper({ ...e, vorgabeWortlaut: '' })).toEqual({ fehler: { vorgabe: expect.any(String) } });
    expect(A.feststellungKoerper({ ...e, frist: '2029-01-01' })).toEqual({ fehler: { frist: expect.any(String) } });
    expect(A.feststellungKoerper({ ...A.leereFeststellung(null), quelle: 'extern', wortlaut: 'W', vorgabeWortlaut: 'V', festgestelltVon: 'ik', verantwortlich: 'IK' })).toEqual({
      fehler: { extern: expect.any(String) },
    });
  });

  it('Stand: Begründung 10 bis 500 Zeichen und die Person, die geprüft hat', () => {
    expect(A.standKoerper({ ergebnis: 'wirksam', begruendung: 'kurz', entschiedenVon: '', am: '' })).toEqual({
      fehler: { begruendung: expect.any(String), entschiedenVon: expect.any(String) },
    });
    expect(A.standKoerper({ ergebnis: 'wirksam', begruendung: 'Aufgabe festgelegt.', entschiedenVon: 'ik', am: '2029-04-15' })).toEqual({
      koerper: { ergebnis: 'wirksam', begruendung: 'Aufgabe festgelegt.', entschieden_von: 'ik', am: '2029-04-15' },
    });
  });
});
