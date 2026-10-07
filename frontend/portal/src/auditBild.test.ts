import { describe, expect, it } from 'vitest';
import type { Feststellung, FeststellungStand, InternesAudit, InternesAuditprogramm, Massnahme } from './api';
import * as B from './auditBild';
import { erklaerWoerter, ERKLAER_WOERTER_HOECHSTENS } from './components/nachweisen/erklaerung';

/**
 * Nachweisen n1 Runde 2, PR 4 (§6.6, Entscheid 17): das Bild des Reiters „Audits“ mit den Feststellungen, der Seite eines
 * Audits und der Seite einer Feststellung - Ahrenberg am 30.04.2029 nach der Referenzwelt (AU-2029-0001, F-2029-0001).
 */
const CB = { id: 'cb', name: 'Claudia Berger', funktion: 'Controlling', kuerzel: 'CB', mit_konto: true };
const eingetragen = { akteur: { sub: 'IK', name: 'Ines Kaltenbach', rolle: 'energiemanager', art: 'kunde' as const }, am: '2029-01-10T09:00:00+01:00' };

const audit = (over: Partial<InternesAudit> = {}): InternesAudit => ({
  id: 'au', kennzeichen: 'AU-2029-0001', titel: 'Internes Audit 2029: Bezugsbasen, Energieziele, Maßnahmen und Grundlagen', termin: '2029-01-22',
  auditoren: [CB], unabhaengigkeit: 'gehört nicht zum Energieteam', was: 'Bezugsbasen, Energieziel, Maßnahmen und Grundlagen', woran: 'Energiepolitik',
  verantwortlich: { sub: 'IK', name: 'Ines Kaltenbach' }, standort_ids: [], zustand: 'abgeschlossen', durchgefuehrt_am: '2029-01-22', abgesagt_begruendung: null,
  hinweise: 1, feststellungen: ['F-2029-0001'],
  abschluss: {
    am: '2029-01-31', entschieden_von: { ...CB, id: 'ik', name: 'Ines Kaltenbach' }, zusammenfassung: null,
    bericht: { bezeichnung: 'Bericht', ablage: 'QM-Laufwerk, Ordner Energiemanagement/Audits', kennung: 'IA-2029', adresse: null, sha256: null },
    kopie: { hinweise: [{ nr: 1, massnahme: 'M-2029-0002' }] }, pruefsumme: 'sha256:00', eingetragen,
  },
  eingetragen, ...over,
});
const feststellung = (over: Partial<Feststellung> = {}): Feststellung => ({
  id: 'f1', kennzeichen: 'F-2029-0001', quelle: { art: 'internes_audit', audit_id: 'au', kennung: 'AU-2029-0001', wortlaut: null },
  wortlaut: 'Wer die Bezugsbasen pflegt und freigibt und wer vertritt, ist nicht festgelegt.', vorgabe: { dokument_id: null, dokument: null, fassung: null, wortlaut: '„Wir legen fest …“' },
  bezug: { standort_id: null, aufgabe: null, dokument_id: null, dokument: null, objekte: [] }, festgestellt_von: CB, festgestellt_am: '2029-01-22',
  verantwortlich: { sub: 'JW', name: 'Jonas Wendlinger' }, frist: '2029-04-22', zustand: 'abgeschlossen',
  lage: { abruf: '2029-04-30', faellig_am: null, tage: null, satz: null, grund: 'abgeschlossen' }, ergebnis: 'wirksam', abgeschlossen_am: '2029-04-15',
  eintraege: 3, massnahmen: ['M-2029-0001'], eingetragen, ...over,
});
const programm = (audits: InternesAudit[], naechstes: Partial<InternesAuditprogramm['naechstes']> = {}): InternesAuditprogramm => ({
  tag: '2029-04-30', audits,
  naechstes: { rhythmus_monate: 12, faellig_am: '2030-01-22', basis: '2029-01-22', tage: -267, satz: 'fällig in 267 Tagen', grund: null, ...naechstes },
});
const massnahme = (over: Partial<Massnahme>): Massnahme =>
  ({ id: 'm2', kennzeichen: 'M-2029-0002', zustand: 'geplant', frist: { abruf: '2029-04-30', termin: '2029-03-31', faellig: 'ueberfaellig', seit_tagen: 30, satz: null }, ...over }) as Massnahme;

describe('Reiter „Audits“: Status zuerst, Als Nächstes, Zeilen', () => {
  it('Kurzzeile aus dem Rhythmus', () => {
    expect(B.auditsKurzzeile(12)).toBe('Selbstprüfung, jährlich');
    expect(B.auditsKurzzeile(6)).toBe('Selbstprüfung, halbjährlich');
    expect(B.rhythmusWort(18)).toBe('alle 18 Monate');
  });

  it('die Status-Zeile zählt nur Offenes (G4): keine, offen, überfällig', () => {
    expect(B.auditsStatus([feststellung()])).toEqual({ zeichen: 'done', text: 'keine Feststellung offen', sub: null, warn: false });
    const offen = feststellung({ zustand: 'offen', ergebnis: null, abgeschlossen_am: null, lage: { abruf: '2029-03-01', faellig_am: '2029-04-22', tage: -52, satz: null, grund: null } });
    expect(B.auditsStatus([offen, feststellung()])).toEqual({ zeichen: 'laeuft', text: '1 Feststellung offen', sub: null, warn: false });
    const ueber = { ...offen, lage: { ...offen.lage, tage: 8 } };
    expect(B.auditsStatus([ueber, offen])).toEqual({ zeichen: 'ueber', text: '2 Feststellungen offen', sub: '· 1 überfällig', warn: true });
  });

  it('Als Nächstes: das fällige Audit mit Frist und Person der Aufgabe; ohne Durchführung keine Frist', () => {
    expect(B.auditNaechstes(programm([audit()]), 'Claudia Berger')).toEqual({
      frist: { wort: 'bis', tag: '2030-01-22', ton: 'bald' }, titel: 'Internes Audit 2030', warum: 'Claudia Berger', knopf: 'planen', auditId: null,
    });
    expect(B.auditNaechstes(programm([audit()], { tage: 3 }), null).frist).toEqual({ wort: 'seit', tag: '2030-01-22', ton: 'ueber' });
    expect(B.auditNaechstes(programm([], { faellig_am: null, tage: null, grund: 'kein_audit' }), 'Claudia Berger')).toEqual({
      frist: null, titel: 'Erstes internes Audit', warum: 'Claudia Berger', knopf: 'planen', auditId: null,
    });
  });

  it('Als Nächstes: erst das durchgeführte, dann das geplante Audit', () => {
    const geplant = audit({ id: 'g', zustand: 'geplant', termin: '2030-01-15', durchgefuehrt_am: null, abschluss: null, titel: 'Internes Audit 2030' });
    expect(B.auditNaechstes(programm([audit(), geplant]), null)).toMatchObject({ titel: 'Internes Audit 2030', knopf: 'oeffnen', auditId: 'g', frist: { wort: 'am', ton: 'bald' } });
    const durch = audit({ id: 'd', zustand: 'durchgefuehrt', abschluss: null });
    expect(B.auditNaechstes(programm([geplant, durch]), null)).toMatchObject({ titel: 'Internes Audit 2029 abschließen', auditId: 'd' });
    const vorbei = { ...geplant, termin: '2029-04-01' };
    expect(B.auditNaechstes(programm([vorbei]), null).frist).toEqual({ wort: 'seit', tag: '2029-04-01', ton: 'ueber' });
  });

  it('Name bis zum Doppelpunkt, sonst der ganze Titel', () => {
    expect(B.auditName(audit())).toBe('Internes Audit 2029');
    expect(B.auditName({ titel: 'Audit Druckluft' })).toBe('Audit Druckluft');
    expect(B.auditName({ titel: 'Audit:' })).toBe('Audit:');
  });

  it('Zeile eines Audits: Datumsblock und ein Fakt je Zustand', () => {
    expect(B.auditZeile(audit())).toEqual({ datum: { wort: '', tag: '2029-01-22', ton: 'erledigt' }, titel: 'Internes Audit 2029', unter: '1 Hinweis · 1 Feststellung' });
    expect(B.auditZeile(audit({ hinweise: 2, feststellungen: [] })).unter).toBe('2 Hinweise · 0 Feststellungen');
    expect(B.auditZeile(audit({ zustand: 'geplant', durchgefuehrt_am: null }))).toMatchObject({ datum: { wort: 'am', ton: 'plan' }, unter: 'geplant' });
    expect(B.auditZeile(audit({ zustand: 'abgesagt' })).unter).toBe('abgesagt');
  });

  it('Zeile einer Feststellung: offen mit Frist, abgeschlossen mit dem Tag des Stands', () => {
    expect(B.feststellungZeile(feststellung())).toEqual({ datum: null, erledigt: true, titel: feststellung().wortlaut, unter: 'wirksam seit 15.04.2029' });
    expect(B.feststellungZeile(feststellung({ abgeschlossen_am: null })).unter).toBe('wirksam');
    const offen = feststellung({ zustand: 'offen', ergebnis: null, abgeschlossen_am: null, lage: { abruf: '2029-04-30', faellig_am: '2029-04-22', tage: 8, satz: null, grund: null } });
    expect(B.feststellungZeile(offen)).toMatchObject({ datum: { wort: 'seit', tag: '2029-04-22', ton: 'ueber' }, erledigt: false, unter: 'Jonas Wendlinger' });
  });
});

describe('Seite eines Audits', () => {
  it('Status und Stufen mit Tag', () => {
    const verlauf = [{ art: 'audit_geplant' as const, zeit: '2029-01-10T09:00:00+01:00' }];
    expect(B.auditStatus(audit())).toMatchObject({ zeichen: 'done', text: 'abgeschlossen' });
    expect(B.auditStufen(audit(), verlauf)).toEqual([
      { titel: 'Geplant', datum: '10.01.2029', zustand: 'done' },
      { titel: 'Durchgeführt', datum: '22.01.2029', zustand: 'done' },
      { titel: 'Abgeschlossen', datum: '31.01.2029', zustand: 'done' },
    ]);
    const geplant = audit({ zustand: 'geplant', durchgefuehrt_am: null, abschluss: null, termin: '2030-01-22' });
    expect(B.auditStufen(geplant, verlauf).map((s) => [s.zustand, s.datum])).toEqual([['done', '10.01.2029'], ['an', 'am 22.01.2030'], ['offen', null]]);
    expect(B.auditStatus(geplant)).toMatchObject({ text: 'geplant', sub: '· am 22.01.2030' });
    expect(B.auditStufen(audit({ zustand: 'abgesagt' }), verlauf).map((s) => s.titel)).toEqual(['Geplant', 'Abgesagt']);
  });

  it('Was daraus wurde: Hinweis mit dem Zustand seiner Maßnahme, Feststellung mit ihrem', () => {
    const z = B.wasDarausWurde(audit(), [massnahme({})], [feststellung()]);
    expect(z.map((x) => [x.titel, x.zeichen, x.zustand, x.warn])).toEqual([
      ['Hinweis', 'ueber', 'Maßnahme überfällig', true],
      ['Feststellung', 'done', 'wirksam', false],
    ]);
    expect(B.wasDarausWurde(audit(), [massnahme({ zustand: 'umgesetzt' })], [])[0]).toMatchObject({ zeichen: 'done', zustand: 'Maßnahme umgesetzt' });
    // Ohne Maßnahme aus diesem Audit: „ohne Maßnahme“; unbekannte Feststellung bleibt ohne Zustand.
    const ohne = B.wasDarausWurde(audit({ abschluss: null, zustand: 'durchgefuehrt' }), [], null);
    expect(ohne.map((x) => x.zustand)).toEqual(['ohne Maßnahme', '']);
    expect(B.wasDarausWurde(audit({ zustand: 'geplant' }), [], [])).toEqual([]);
  });

  it('Themen und Ort als ein Fakt', () => {
    expect(B.themenZahl('Bezugsbasen, Energieziel, Maßnahmen und Grundlagen')).toBe(4);
    expect(B.ortKurz('QM-Laufwerk, Ordner Energiemanagement/Audits')).toBe('QM-Laufwerk');
    expect(B.auditorenZeile(audit())).toBe('Claudia Berger · Controlling');
  });
});

describe('Seite einer Feststellung', () => {
  const stand = (over: Partial<FeststellungStand> = {}) => ({ status: 'freigegeben' as const, ergebnis: 'wirksam' as const, am: '2029-04-15', ...over });

  it('Herkunft und Status', () => {
    expect(B.feststellungHerkunft(feststellung(), audit())).toBe('Feststellung · Audit 2029');
    expect(B.feststellungHerkunft(feststellung({ quelle: { art: 'extern', audit_id: null, kennung: null, wortlaut: 'Kunde' } }), null)).toBe('Feststellung · von außen');
    expect(B.feststellungStatus(feststellung(), [stand()])).toMatchObject({ zeichen: 'done', text: 'behoben und wirksam' });
    const offen = feststellung({ zustand: 'offen', ergebnis: null, abgeschlossen_am: null, lage: { abruf: '2029-04-30', faellig_am: '2029-04-22', tage: 8, satz: null, grund: null } });
    expect(B.feststellungStatus(offen, [])).toEqual({ zeichen: 'ueber', text: 'überfällig', sub: '· seit 22.04.2029', warn: true });
    expect(B.feststellungStatus(offen, [stand({ status: 'beantragt' })]).text).toBe('Wirksamkeit beantragt');
  });

  it('Stufen bis zur Wirksamkeit, jede mit ihrem Tag', () => {
    const m = [{ zustand: 'bewertet' as const, umgesetzt_am: '2029-03-01' }];
    expect(B.feststellungStufen(feststellung(), m, ['2029-01-26T10:00:00Z'], [stand()])).toEqual([
      { titel: 'Festgestellt', datum: '22.01.2029', zustand: 'done' },
      { titel: 'Maßnahme', datum: '26.01.2029', zustand: 'done' },
      { titel: 'Umgesetzt', datum: '01.03.2029', zustand: 'done' },
      { titel: 'Wirksam', datum: '15.04.2029', zustand: 'done' },
    ]);
    const offen = feststellung({ zustand: 'offen', ergebnis: null, abgeschlossen_am: null });
    expect(B.feststellungStufen(offen, m, [null], []).slice(1).map((s) => [s.titel, s.zustand, s.datum])).toEqual([
      ['Maßnahme', 'done', null],
      ['Umgesetzt', 'done', '01.03.2029'],
      ['Wirksam?', 'an', 'jetzt'],
    ]);
    expect(B.feststellungStufen(offen, [], [], []).slice(1).map((s) => s.zustand)).toEqual(['an', 'offen', 'offen']);
    const ohne = feststellung({ ergebnis: 'ohne_massnahme' });
    expect(B.feststellungStufen(ohne, [], [], []).map((s) => s.titel)).toEqual(['Festgestellt', 'Abgeschlossen']);
  });

  it('Einträge und Vorgabe in einem Wort', () => {
    expect(B.EINTRAG_KURZ.behebung).toBe('Sofort behoben');
    expect(B.vorgabeKurz(feststellung().vorgabe, null)).toBe('Wortlaut');
    expect(B.vorgabeKurz({ dokument_id: 'd1', dokument: 'D-0001', fassung: 1, wortlaut: null }, 'Energiepolitik')).toBe('Energiepolitik');
  });
});

describe('Erklär-Blätter (Entscheid 24): höchstens 45 Wörter, Beispiel nur aus Daten', () => {
  it('Audit mit dem letzten durchgeführten, ohne Daten ohne Beispiel', () => {
    expect(B.erklaerungAudit([audit()]).beiIhnen).toBe('Claudia Berger (Controlling) am 22.01.2029.');
    expect(B.erklaerungAudit([]).beiIhnen).toBeNull();
    for (const e of [B.erklaerungAudit([audit()]), B.erklaerungFeststellung(feststellung()), B.ERKLAERUNG_WIRKSAMKEIT]) {
      expect(erklaerWoerter(e), e.frage).toBeLessThanOrEqual(ERKLAER_WOERTER_HOECHSTENS);
    }
  });
});
