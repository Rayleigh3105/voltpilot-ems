import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Massnahme } from './api';
import { benutzerApi } from './benutzer';
import { MassnahmeAendernDialog, MassnahmeAnlegenDialog, MassnahmeUmgesetztDialog } from './components/MassnahmeDialoge';
import { UEMS_NORMGRENZE } from './glossar';
import * as M from './massnahmen';
import * as B from './massnahmenBild';
import * as P from './massnahmePlanen';
import { hashForRoute, massnahmeRoute, parseRoute } from './nav';
import { MassnahmeSeite } from './pages/MassnahmeSeite';
import { VerbesserungBereich } from './pages/VerbesserungBereich';
import { setSelbstauskunft } from './rollen';
import { merkeAbruf, vergissAbruf } from './routenUhr';
import { bezugsbasisBuehne } from './test/bezugsbasisFixtures';
import { energiezielBuehne } from './test/energiezielFixtures';
import { KURZ_R5, kontenAhrenberg, m1, m1Umgesetzt, m2, M_IDS, massnahmeBuehne, PRUEFSUMME_R3 } from './test/massnahmeFixtures';
import { rechteSeed, STANDORT_IDS } from './test/rollenFixtures';

/**
 * Verbessern-Konzept v1, PR 2: der Reiter „Maßnahmen“ nach Stufen, die Seite einer Maßnahme und die Blätter „Maßnahme
 * planen“, „Umsetzung melden“ und „Ändern“. Das reine Bild rechnet nichts: Frist, Wirkung in Kurzform, Ausgangslage und
 * Sätze kommen von der Route; das Portal ordnet, zählt Kalendertage gegen den Tag der Route und wählt Wörter.
 */
beforeEach(() => {
  vergissAbruf();
  setSelbstauskunft(rechteSeed('IK').me);
  Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
  Object.assign(api, bezugsbasisBuehne('modell'), energiezielBuehne('juli'), massnahmeBuehne('r9', '2028-03-15'), {
    standorte: async () => ({ stichtag: '2028-03-15', standorte: [] }),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ZIEL_ALLEIN = /(?<![\p{L}])Ziel(?![\p{L}])/u;
/** Geschützte Leerzeichen vor Einheiten (AP-08 E11) als normale - die Erwartungen bleiben lesbar. */
const n = (t: string | null | undefined) => (t ?? '').replace(/\u00a0/g, ' ');
const nn = <T,>(o: T): T => JSON.parse(n(JSON.stringify(o))) as T;
/** Eine Maßnahme der Liste mit den Feldern, die das Bild liest. */
const mit = (m: Massnahme, over: Partial<Massnahme>): Massnahme => ({ ...m, ...over });

describe('Wörter (V1–V7)', () => {
  it('Kundenwörter, nie „Ziel“ allein, die Richtung als Wort', () => {
    expect(M.ZUSTAND_WORT).toEqual({ geplant: 'geplant', umgesetzt: 'umgesetzt', bewertet: 'bewertet', verworfen: 'verworfen' });
    expect(B.KNOPF_PLANEN).toBe('Maßnahme planen');
    const texte = [...Object.values(M), ...Object.values(B), ...Object.values(P)].filter((v): v is string => typeof v === 'string');
    expect(texte.filter((t) => ZIEL_ALLEIN.test(t))).toEqual([]);
    expect(B.richtungWort('-2.7')).toBe('weniger');
    expect(B.richtungWort('2.5')).toBe('mehr');
    expect(n(B.prozentBetrag('-2.69'))).toBe('2,7 %');
    expect(n(B.personProzent('-3.0'))).toBe('3 %');
    expect(n(B.personProzent('-2.5'))).toBe('2,5 %');
    // AP-08 E11: Tausenderpunkt, auf Hundert gerundet nur zur Anzeige.
    expect(B.rund('-24192')).toBe('24.200');
    expect(B.rund('512')).toBe('510');
    expect(B.ganz('88740')).toBe('88.740');
  });
});

describe('Liste nach Stufen (§6.5, Richtungsfrage 9.2 A)', () => {
  it('zu tun (überfällige zuerst, dann Termin) · umgesetzt (wer am längsten wartet) · abgeschlossen (neueste zuerst)', () => {
    const geplantSpaet = mit(m1('2028-03-15'), { id: 'a', kennzeichen: 'M-2028-0003', termin: '2028-06-30' });
    const verworfen = mit(m2('2028-03-15'), { id: 'b', kennzeichen: 'M-2028-0004', zustand: 'verworfen', verworfen_am: '2028-03-01T10:00:00+01:00' });
    const g = B.gruppen([m1Umgesetzt(), geplantSpaet, verworfen, m2('2028-03-15')]);
    expect(g.zu_tun.map((m) => m.kennzeichen)).toEqual(['M-2028-0002', 'M-2028-0003']);
    expect(g.umgesetzt.map((m) => m.kennzeichen)).toEqual(['M-2028-0001']);
    expect(g.abgeschlossen.map((m) => m.kennzeichen)).toEqual(['M-2028-0004']);
    expect(B.chips([m1Umgesetzt(), geplantSpaet, verworfen, m2('2028-03-15')]).map((c) => c.label)).toEqual([
      'Alle 4',
      'Zu tun 2',
      'Umgesetzt 1',
      'Abgeschlossen 1',
    ]);
  });
  it('V1: der Antwortsatz sagt, wie weit - überfällig zuerst, dann geplant, dann was abzuschließen ist', () => {
    const geplant = mit(m1('2029-04-30'), { termin: '2029-06-30', frist: { abruf: '2029-04-30', termin: '2029-06-30', faellig: null, seit_tagen: null, satz: null } });
    const zweite = mit(geplant, { id: 'x', kennzeichen: 'M-2029-0003', termin: '2029-06-15' });
    const umgesetzt = mit(m1Umgesetzt('2029-04-30'), { id: 'y', kennzeichen: 'M-2029-0001' });
    expect(B.antwortSatz([geplant, zweite, umgesetzt])).toBe('2 Maßnahmen sind bis 30.06.2029 geplant; 1 ist umgesetzt und noch abzuschließen.');
    expect(B.antwortSatz([m2('2028-03-15'), geplant])).toBe('1 Maßnahme ist seit 15 Tagen überfällig; 1 ist bis 30.06.2029 geplant.');
    expect(B.antwortSatz([mit(m1Umgesetzt(), { zustand: 'bewertet' })])).toBe('Die Maßnahme ist abgeschlossen.');
    expect(B.formalZeile([geplant, umgesetzt], '2029-04-30')).toBe('2 Maßnahmen · Stand 30.04.2029');
  });
  it('Datumsblock wie Wiedervorlage: bis · seit (Warnton) · umgesetzt · geprüft', () => {
    expect(B.datumBild(m1('2028-01-20'))).toMatchObject({ wort: 'bis', tag: '31.01.', jahr: '2028', ton: 'bald' });
    expect(B.datumBild(m2('2028-03-15'))).toMatchObject({ wort: 'seit', tag: '29.02.', ton: 'ueber' });
    expect(B.datumBild(m1Umgesetzt())).toMatchObject({ wort: 'umgesetzt', tag: '22.01.', ton: 'erledigt' });
    const bewertet = mit(m1Umgesetzt(), { zustand: 'bewertet', bewertung: { ...m1Umgesetzt().bewertung!, am: '2028-11-15T10:00:00+01:00' } as Massnahme['bewertung'] });
    expect(B.datumBild(bewertet)).toMatchObject({ wort: 'geprüft', tag: '15.11.', ton: 'erledigt' });
  });
  it('„Was es bringt“: beobachtet aus der Kurzform der Route, geplant die Schätzung, ohne Messung die Art als Marke', () => {
    expect(nn(B.bringtBild(mit(m1Umgesetzt(), { wirkung_kurz: KURZ_R5 })))).toEqual({
      zahl: '2,4 % weniger',
      text: 'als erwartet · rund 16.100 kWh in 8 Monaten',
      marke: { wort: 'vorläufig · 8 von 12', ton: 'ohne' },
    });
    expect(nn(B.bringtBild(mit(m1('2028-01-20'), { erwartete_einsparung: { kwh_jahr: '30512', grundlage_kwh: '1017050', grundlage_monate: '2027-01/2027-12' } }))))
      .toMatchObject({ zahl: null, text: 'Soll bringen: 3 % weniger, rund 30.500 kWh im Jahr', marke: null });
    expect(B.bringtBild(m2('2028-03-15'))).toMatchObject({ marke: { wort: 'nicht gemessen', ton: 'ohne' } });
    expect(n(B.bringtBild(mit(m2('2028-03-15'), { erwartete_einsparung: { kwh_jahr: '12000', grundlage_kwh: null, grundlage_monate: null } })).text))
      .toBe('Soll bringen: rund 12.000 kWh im Jahr, geschätzt');
    expect(B.bringtBild(mit(m2('2028-03-15'), { art: 'organisatorisch' }))).toEqual({ zahl: null, text: null, marke: { wort: 'organisatorisch', ton: 'ohne' } });
    // Bewertet, aber ohne Live-Kurzform (keine Werte im Zeitraum): die Zahl des festgehaltenen Stands und das Urteil.
    const stand: NonNullable<Massnahme['bewertung']> = {
      stand_nr: 1, status: 'bewertet', ergebnis: 'belegt', begruendung: 'Zeitschaltung aktiv, Laufzeit 18 % niedriger.', vieraugen: false,
      person: { sub: 'IK', name: 'Ines Kaltenbach' }, am: '2028-11-15T10:00:00+01:00', entscheidung: null, entschieden_am: null,
      entscheidungs_begruendung: null, kopie: '{"wirkung":{"delta_prozent":"-2.4","monate_bewertbar":8},"nachher":"2028-02/2029-01"}', pruefsumme: null, satz: null,
    };
    expect(nn(B.bringtBild(mit(m1Umgesetzt(), { zustand: 'bewertet', bewertung: stand, wirkung_kurz: null })))).toEqual({
      zahl: '2,4 % weniger',
      text: 'als erwartet · Stand nach 8 von 12 Monaten',
      marke: { wort: 'belegt', ton: 'ok' },
    });
    // Ohne das Recht zum Abschließen sagt die Antwort, wer abschließt, statt die Person dazu aufzufordern.
    const umgesetzt = mit(m2(), { zustand: 'umgesetzt', umgesetzt_am: '2028-03-10' });
    expect(B.antwortBild(umgesetzt, null).satz).toBe('Umgesetzt am 10.03.2028 - jetzt mit einem Satz abschließen.');
    expect(B.antwortBild(umgesetzt, null, false).satz).toBe(
      'Umgesetzt am 10.03.2028 - abschließen kann, wer im Energiemanagement Maßnahmen bewertet.',
    );
    // Die Seite: ohne Live-Monate ist die Antwort das Urteil mit dem Stand, nie „noch kein Monat bewertbar“.
    expect(nn(B.antwortBild(mit(m1Umgesetzt(), { zustand: 'bewertet', bewertung: stand }), null))).toEqual({
      satz: 'Wirkung geprüft am 15.11.2028 von Ines Kaltenbach: belegt - damals 2,4 % weniger als erwartet nach 8 von 12 Monaten.',
      formal: 'Heute ist kein Monat nach der Umsetzung bewertbar; Stand Nr. 1 bleibt, wie er festgehalten wurde.',
    });
  });
  it('ohne Messung ein ganzer Satz aus dem Hinweis der Route - mit Energieeinsatz und Beispiel, sonst ohne', () => {
    expect(B.nichtGemessenSatz(m2())).toBe(
      'Druckluft hat noch keine Kennzahl mit Bezugsbasis, zum Beispiel Stromeinsatz je Betriebsstunde. Mit ihr misst VoltPilot die Wirkung.',
    );
    expect(B.nichtGemessenSatz({ einsatz: null, ohne_messgrundlage: { ...m2().ohne_messgrundlage!, hinweis: 'mit einer freigegebenen Bezugsbasis' } })).toBe(
      'Diese Maßnahme hat keine Kennzahl mit Bezugsbasis. Mit ihr misst VoltPilot die Wirkung.',
    );
  });
  it('die Methode ohne Klammer - Bezugsbasis und Fassung stehen schon in der Zeile', () => {
    expect(B.methodeKurz(m1().messgrundlage!.bewertungsmethode)).toBe('bereinigt um Produktionsmenge');
    expect(B.methodeKurz('bereinigt um Gradtage (G20/15, Bezugsbasis BB-0002, Fassung 1)')).toBe('bereinigt um Gradtage');
  });
  it('V5: je Karte genau ein Verb; ohne Recht „Ansehen“', () => {
    const darf = { melden: true, abschliessen: true };
    expect(B.naechsterSchritt(m1(), darf).wort).toBe('Umsetzung melden');
    expect(B.naechsterSchritt(m1Umgesetzt(), darf).wort).toBe('Wirkung prüfen');
    expect(B.naechsterSchritt(mit(m2(), { zustand: 'umgesetzt' }), darf).wort).toBe('Abschließen');
    expect(B.naechsterSchritt(m1(), { melden: false, abschliessen: false })).toEqual({ wort: 'Ansehen', leise: true });
  });
  it('Herkunft als Zeile: Bereich · woher · für welches Energieziel', () => {
    expect(B.woherZeile(m1())).toBe('Spritzguss · aus der Abweichung AW-2028-0001 · für das Energieziel 2028');
    expect(B.woherZeile({ ...m2(), art: 'organisatorisch', einsatz: null, herkunft: { art: 'audit', kennung: 'AU-2029-0001' } }))
      .toBe('organisatorisch · Hinweis aus dem internen Audit AU-2029-0001');
    expect(B.herkunftText({ herkunft: { art: 'managementbewertung', kennung: 'BR-2029-0001/B2' } })).toBe('aus der Managementbewertung BR-2029-0001, Beschluss 2');
    // Beginnt der Wortlaut schon mit dem Namen, steht der Name nicht doppelt.
    expect(B.energiezielText('EZ-2029-0001', 'Energieziel 2029 für den Spritzguss: 4 % weniger')).toBe('Energieziel 2029 für den Spritzguss: 4 % weniger');
    expect(B.energiezielText('EZ-2028-0001', 'Spritzguss: 5 % weniger')).toBe('Energieziel 2028 · Spritzguss: 5 % weniger');
    expect(B.energiezielRest('EZ-2029-0001', 'Energieziel 2029 für den Spritzguss: 4 % weniger')).toBe('Für den Spritzguss: 4 % weniger');
    expect(B.energiezielRest('EZ-2029-0001', 'Energieziel 2029')).toBeNull();
  });

  it('der Reiter: Titel mit Klartext, Antwort, Gruppen mit Karten - jede Karte behält die Marke der Wiedervorlage', async () => {
    render(<VerbesserungBereich reiter="massnahmen" energiezielId={null} onReiter={() => {}} onOeffnen={() => {}} onListe={() => {}} />);
    const register = await screen.findByTestId('massnahmen-register');
    expect(within(register).getByRole('heading', { level: 1 }).textContent).toBe('Maßnahmen');
    expect(n(screen.getByTestId('massnahmen-antwort').textContent)).toContain('1 Maßnahme ist seit 15 Tagen überfällig; 1 ist umgesetzt und noch abzuschließen.');
    const zuTun = screen.getByTestId('massnahmen-gruppe-zu_tun');
    const karte = within(zuTun).getByTestId('massnahme-eintrag-M-2028-0002');
    expect(karte.getAttribute('data-entscheid')).toBe('massnahme_termin');
    expect(within(karte).getByTestId('massnahme-marke').textContent).toBe('nicht gemessen');
    expect(within(karte).getByTestId('massnahme-schritt').textContent).toBe('Umsetzung melden');
    const umgesetzt = within(screen.getByTestId('massnahmen-gruppe-umgesetzt')).getByTestId('massnahme-eintrag-M-2028-0001');
    expect(n(within(umgesetzt).getByTestId('massnahme-bringt').textContent)).toContain('2,4 % weniger');
    expect(within(umgesetzt).getByTestId('massnahme-schritt').textContent).toBe('Wirkung prüfen');
    // Die alte Tabelle und der pauschale Satz „ohne Messgrundlage — Wirkung nicht messbar“ sind fort (Art statt Mangel).
    expect(screen.queryByTestId('massnahmen-tafel')).toBeNull();
    expect(register.textContent).not.toContain('ohne Messgrundlage — Wirkung nicht messbar');
  });
  it('Chips filtern nach Stufe; ein Klick auf die Karte öffnet die Seite', async () => {
    const oeffnen = vi.fn();
    render(<VerbesserungBereich reiter="massnahmen" energiezielId={null} onReiter={() => {}} onOeffnen={() => {}} onListe={() => {}} onMassnahme={oeffnen} />);
    await screen.findByTestId('massnahmen-gruppe-zu_tun');
    fireEvent.click(screen.getByTestId('massnahmen-chip-umgesetzt'));
    expect(screen.queryByTestId('massnahmen-gruppe-zu_tun')).toBeNull();
    expect(screen.getByTestId('massnahmen-chip-umgesetzt').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('massnahme-oeffnen-M-2028-0001'));
    expect(oeffnen).toHaveBeenCalledWith(M_IDS.m1);
  });
  it('leer: der Satz mit dem Weg und „Maßnahme planen“; der Fehler mit „Erneut versuchen“', async () => {
    Object.assign(api, massnahmeBuehne('leer', '2028-03-15'));
    render(<VerbesserungBereich reiter="massnahmen" energiezielId={null} onReiter={() => {}} onOeffnen={() => {}} onListe={() => {}} />);
    expect((await screen.findByTestId('massnahmen-leer')).textContent).toContain(B.LEER);
    cleanup();
    const echt = api.massnahmen;
    const lesen = vi.spyOn(api, 'massnahmen').mockRejectedValueOnce(new Error('offline')).mockImplementation(echt);
    render(<VerbesserungBereich reiter="massnahmen" energiezielId={null} onReiter={() => {}} onOeffnen={() => {}} onListe={() => {}} />);
    const fehler = await screen.findByTestId('massnahmen-fehler');
    expect(fehler.textContent).toContain(B.LADEFEHLER);
    fireEvent.click(within(fehler).getByText('Erneut versuchen'));
    await waitFor(() => expect(lesen).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('massnahmen-leer')).toBeTruthy();
  });
});

describe('Maßnahme planen (§6.9, Entscheide 6, 12, 13)', () => {
  const fertig = (over: Partial<P.Entwurf> = {}): P.Entwurf => ({
    ...P.entwurfAus({ herkunft: 'energieziel', kennzahl: 'kz', energieziel: 'ez' }, '2029-04-30'),
    titel: 'Kühlwasserpumpen drehzahlgeregelt betreiben',
    prozent: '3',
    wortlaut: 'Die Pumpen laufen heute immer mit voller Drehzahl.',
    verantwortlich: 'MD',
    termin: '2029-06-30',
    ...over,
  });
  it('die Art aus der Vorbelegung: mit Kennzahl gemessen, aus Feststellung oder Audit organisatorisch, am Einsatz nicht gemessen', () => {
    expect(P.entwurfAus({ herkunft: 'energieziel', kennzahl: 'kz' }, '2029-04-30')).toMatchObject({ art: 'gemessen', von: '2029-03', bis: '2029-03' });
    expect(P.entwurfAus({ herkunft: 'nichtkonformitaet', herkunftKennung: 'F-2029-0001' }, '2029-04-30').art).toBe('organisatorisch');
    expect(P.entwurfAus({ herkunft: 'einsatz', einsatz: 'ee3' }, '2029-04-30').art).toBe('nicht_gemessen');
    expect(P.entwurfAus({ herkunft: 'von_hand' }, '2029-04-30', false).art).toBe('nicht_gemessen');
  });
  it('Prüfen je Schritt - vor dem Senden statt danach; Vorher höchstens zwölf abgeschlossene Monate', () => {
    expect(P.pruefen(fertig({ titel: ' ' }), 1, '2029-04-30')).toHaveProperty('titel');
    expect(P.pruefen(fertig({ prozent: '' }), 2, '2029-04-30')).toHaveProperty('prozent');
    expect(P.pruefen(fertig({ prozent: '', weissNicht: true }), 2, '2029-04-30')).toEqual({});
    expect(P.pruefen(fertig({ prozent: 'drei' }), 2, '2029-04-30').prozent).toContain('zum Beispiel 3 oder 2,5');
    expect(P.pruefen(fertig({ von: '2028-01', bis: '2028-12' }), 2, '2029-04-30').monate).toBe('Vorher sind abgeschlossene Monate, höchstens 12.');
    expect(P.pruefen(fertig({ von: '2029-04', bis: '2029-04' }), 2, '2029-04-30')).toHaveProperty('monate');
    expect(P.pruefen(fertig({ von: '2028-04', bis: '2029-03' }), 2, '2029-04-30')).toEqual({});
    expect(P.pruefen(fertig({ verantwortlich: '', termin: '' }), 3, '2029-04-30')).toEqual({
      verantwortlich: 'Bitte wählen Sie, wer sich kümmert.',
      termin: 'Bitte wählen Sie, bis wann.',
    });
    expect(P.pruefen(fertig(), 4, '2029-04-30')).toEqual({});
    expect(P.vorherMonate('2029-04-30').map((m) => m.value)).toEqual([
      '2029-03', '2029-02', '2029-01', '2028-12', '2028-11', '2028-10', '2028-09', '2028-08', '2028-07', '2028-06', '2028-05', '2028-04',
    ]);
  });
  it('die Anfrage: gemessen mit Prozent (weniger negativ) und Monaten; „Weiß ich noch nicht“ ohne Zahl; ohne Kennzahl kWh, nie Prozent', () => {
    const v = { herkunft: 'energieziel' as const, kennzahl: 'kz', energieziel: 'ez' };
    expect(P.anfrage(fertig(), v)).toEqual({
      titel: 'Kühlwasserpumpen drehzahlgeregelt betreiben',
      verantwortlich: 'MD',
      termin: '2029-06-30',
      herkunft: 'energieziel',
      art: 'gemessen',
      kennzahl: 'kz',
      monate: '2029-03',
      energieziel: 'ez',
      erwartete_wirkung_prozent: -3,
      erwartete_wirkung_wortlaut: 'Die Pumpen laufen heute immer mit voller Drehzahl.',
    });
    expect(P.anfrage(fertig({ weissNicht: true }), v)).not.toHaveProperty('erwartete_wirkung_prozent');
    const ohne = P.anfrage(fertig({ art: 'nicht_gemessen', kwh: '12.000', standort: 'st' }), { herkunft: 'von_hand' });
    expect(ohne).toMatchObject({ art: 'nicht_gemessen', erwartete_einsparung_kwh_jahr: 12000, standort: 'st' });
    expect(ohne).not.toHaveProperty('erwartete_wirkung_prozent');
    expect(ohne).not.toHaveProperty('kennzahl');
    const org = P.anfrage(fertig({ art: 'organisatorisch', kwh: '500' }), { herkunft: 'audit', herkunftKennung: 'AU-2029-0001' });
    expect(org).toMatchObject({ art: 'organisatorisch', herkunft_kennung: 'AU-2029-0001' });
    expect(org).not.toHaveProperty('erwartete_einsparung_kwh_jahr');
  });
  it('Termin per Schnellwahl vom Tag der Route aus: Ende des nächsten, übernächsten Monats und des Quartals', () => {
    expect(P.terminVorschlaege('2029-04-30')).toEqual([
      { wert: '2029-05-31', wort: 'Ende Mai' },
      { wert: '2029-06-30', wort: 'Ende Juni' },
      { wert: '2029-09-30', wort: 'Ende September' },
    ]);
    expect(P.terminSatz('2029-06-30', '2029-04-30')).toBe('Termin 30.06.2029 - noch 61 Tage. Danach steht die Maßnahme als überfällig in der Wiedervorlage.');
  });

  it('am Rechner ein Dialog: ohne Wortlaut geht nichts an die Route, mit allem die Anfrage der Form', async () => {
    const anlegen = vi.spyOn(api, 'massnahmeAnlegen');
    render(<MassnahmeAnlegenDialog vorbelegung={{ herkunft: 'von_hand' }} onClose={() => {}} onAngelegt={() => {}} tagHeute="2028-03-15" />);
    const dialog = await screen.findByTestId('massnahme-anlegen');
    await waitFor(() => expect((screen.getAllByTestId('massnahme-anlegen-senden')[0] as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(screen.getByTestId('planen-art')).getByTestId('planen-art-organisatorisch').querySelector('input')!);
    fireEvent.change(screen.getByTestId('planen-titel'), { target: { value: 'Bekanntmachung der Energiepolitik wiederholen' } });
    await act(async () => fireEvent.submit(dialog));
    expect(anlegen).not.toHaveBeenCalled();
    expect(screen.getByText('Bitte sagen Sie in einem Satz, was sich ändern soll.')).toBeTruthy();
    fireEvent.change(screen.getByTestId('planen-wortlaut'), { target: { value: 'Alle Beschäftigten kennen die Energiepolitik.' } });
    expect(screen.queryByTestId('planen-prozent')).toBeNull();
    expect(screen.queryByTestId('planen-kwh')).toBeNull();
    expect(dialog.textContent).toContain(UEMS_NORMGRENZE);
  });
  it('mit Kennzahl rechnet die Route die Prozent in kWh im Jahr um; fehlen Monate, steht der Grund da', async () => {
    const schaetzung = vi.spyOn(api, 'massnahmeSchaetzung').mockResolvedValue({
      kennzahl: m1().messgrundlage!.kennzahl.id, prozent: '-3.0', kwh_jahr: '30512', grundlage_kwh: '1017050', grundlage_monate: '2028-04/2029-03', monate_mit_wert: 12, grund: null,
    });
    render(<MassnahmeAnlegenDialog vorbelegung={{ herkunft: 'energieziel', kennzahl: m1().messgrundlage!.kennzahl.id, energieziel: 'ez' }} onClose={() => {}} onAngelegt={() => {}} tagHeute="2029-04-30" />);
    fireEvent.change(await screen.findByTestId('planen-prozent'), { target: { value: '3' } });
    await waitFor(() => expect(n(screen.getByTestId('planen-umrechnung').textContent)).toBe(
      'Entspricht rund 30.500 kWh im Jahr - gerechnet mit 1.017.050 kWh in April 2028 bis März 2029.',
    ));
    expect(schaetzung).toHaveBeenCalledWith(m1().messgrundlage!.kennzahl.id, -3);
    schaetzung.mockResolvedValue({ kennzahl: 'kz', prozent: '-2.5', kwh_jahr: null, grundlage_kwh: null, grundlage_monate: '2028-04/2029-03', monate_mit_wert: 3, grund: 'monate_fehlen' });
    fireEvent.change(screen.getByTestId('planen-prozent'), { target: { value: '2,5' } });
    await waitFor(() => expect(screen.getByTestId('planen-umrechnung').textContent).toContain('erst mit zwölf gemessenen Monaten (bisher 3)'));
    // Gilt heute keine Fassung (M2), sagt das Blatt es schon hier - nicht erst die Ablehnung beim Anlegen.
    schaetzung.mockResolvedValue({ kennzahl: 'kz', prozent: '-2.0', kwh_jahr: null, grundlage_kwh: null, grundlage_monate: '2028-04/2029-03', monate_mit_wert: 0, grund: 'kennzahl_ohne_bezugsbasis' });
    fireEvent.change(screen.getByTestId('planen-prozent'), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByTestId('planen-umrechnung').textContent).toBe(M.ABLEHNUNG.kennzahl_ohne_bezugsbasis));
    fireEvent.click(screen.getByText(P.WEISS_NICHT));
    expect((screen.getByTestId('planen-prozent') as HTMLInputElement).disabled).toBe(true);
  });
  it('am Telefon vier Schritte: „Weiter“ prüft nur den Schritt, die Überschrift ist seine Frage', async () => {
    const mm = vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    render(<MassnahmeAnlegenDialog vorbelegung={{ herkunft: 'von_hand' }} onClose={() => {}} onAngelegt={() => {}} tagHeute="2028-03-15" />);
    await screen.findByTestId('massnahme-anlegen');
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Maßnahme planen');
    fireEvent.click(screen.getByTestId('planen-weiter'));
    expect(screen.getByText('Bitte sagen Sie in einem Satz, was zu tun ist.')).toBeTruthy();
    fireEvent.change(screen.getByTestId('planen-titel'), { target: { value: 'Druckluft-Leckagen orten' } });
    fireEvent.click(screen.getByTestId('planen-art-nicht_gemessen').querySelector('input')!);
    fireEvent.click(screen.getByTestId('planen-weiter'));
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Was soll es bringen?');
    mm.mockRestore();
  });
});

describe('Umsetzung melden und Ändern (§6.9, Befund 2, V7)', () => {
  it('„Umsetzung melden“: Schnellwahl vom Tag der Route, „Gestern“, ein Satz, was gemacht wurde', async () => {
    const melden = vi.spyOn(api, 'massnahmeUmgesetzt');
    render(<MassnahmeUmgesetztDialog massnahme={m1('2028-01-22')} onClose={() => {}} onFertig={() => {}} />);
    expect(screen.getByText('Heute, 22.01.').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByText('Gestern'));
    fireEvent.change(screen.getByTestId('massnahme-umgesetzt-text'), { target: { value: 'kurz' } });
    await act(async () => fireEvent.click(screen.getByTestId('massnahme-umgesetzt-senden')));
    expect(melden).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('massnahme-umgesetzt-text'), { target: { value: 'Zeitschaltung aktiv, Probelauf ohne Befund.' } });
    await act(async () => fireEvent.click(screen.getByTestId('massnahme-umgesetzt-senden')));
    expect(melden).toHaveBeenCalledWith(M_IDS.m1, { am: '2028-01-21', begruendung: 'Zeitschaltung aktiv, Probelauf ohne Befund.' });
  });
  it('V7: „Ändern“ zeigt die Richtung als Wort und dreht kein Vorzeichen - „3 % mehr“ bleibt „mehr“', async () => {
    const aendern = vi.spyOn(api, 'massnahmeAendern');
    render(<MassnahmeAendernDialog massnahme={mit(m1(), { erwartete_wirkung_prozent: '3.0' })} onClose={() => {}} onFertig={() => {}} />);
    expect((screen.getByTestId('massnahme-aendern-zahl') as HTMLInputElement).value).toBe('3');
    expect(screen.getByText('mehr').getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByLabelText('Was ist zu tun?'), { target: { value: 'Werkzeugheizungen nur nachts abschalten' } });
    fireEvent.change(screen.getByLabelText('Warum ändern Sie?'), { target: { value: 'Nur der Titel wird genauer gefasst.' } });
    await act(async () => fireEvent.click(screen.getByTestId('massnahme-aendern-senden')));
    expect(aendern).toHaveBeenCalledWith(M_IDS.m1, { titel: 'Werkzeugheizungen nur nachts abschalten', begruendung: 'Nur der Titel wird genauer gefasst.' });
  });
  it('eine Ablehnung der Route steht als Satz im Blatt', async () => {
    vi.spyOn(api, 'massnahmeUmgesetzt').mockRejectedValue(new ApiError(422, 'x', { code: 'umgesetzt_in_der_zukunft' }));
    render(<MassnahmeUmgesetztDialog massnahme={m1('2028-01-22')} onClose={() => {}} onFertig={() => {}} />);
    fireEvent.change(screen.getByTestId('massnahme-umgesetzt-text'), { target: { value: 'Zeitschaltung aktiv, Probelauf ohne Befund.' } });
    await act(async () => fireEvent.click(screen.getByTestId('massnahme-umgesetzt-senden')));
    expect(await screen.findByText(M.ABLEHNUNG.umgesetzt_in_der_zukunft)).toBeTruthy();
  });
});

describe('Seite einer Maßnahme (§6.6)', () => {
  it('überfällig und geplant: Stufen, die Antwort mit Tagen, der große Knopf und Seltenes im Menü', async () => {
    render(<MassnahmeSeite id={M_IDS.m2} onListe={() => {}} />);
    expect((await screen.findByTestId('massnahme-titel')).textContent).toBe('Druckluft-Leckagen orten und beseitigenM-2028-0002');
    expect(screen.getByTestId('massnahme-antwort').textContent).toContain('Seit 15 Tagen überfällig - Termin war 29.02.2028.');
    const stufen = within(screen.getByTestId('massnahme-stufen')).getAllByRole('listitem');
    expect(stufen.map((s) => s.className)).toEqual(['is-done', 'is-an', 'is-aus']);
    expect(stufen[2].textContent).toContain('Abschließen');
    expect(screen.getByTestId('massnahme-umgesetzt-knopf').textContent).toBe('Umsetzung melden');
    expect(screen.getByTestId('massnahme-zustand').getAttribute('data-entscheid')).toBe('massnahme_termin');
    expect(screen.getByTestId('massnahme-erwartete-wirkung').textContent).toContain('Nicht gemessen:');
    // Ines (Energiemanagerin) darf Kennzahlen anlegen: der Sprung steht da; ohne das Recht nur der Satz.
    expect(within(screen.getByTestId('massnahme-erwartete-wirkung')).getByText('Kennzahl anlegen')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('massnahme-menue')).getByRole('button'));
    for (const w of ['Ändern', 'Kommentar schreiben', 'Verwerfen']) expect(screen.getByText(w)).toBeTruthy();
  });
  it('umgesetzt mit Kennzahl: Antwort aus der Wirkung, Kacheln, Herkunft, Wofür und woran mit Prüfsumme, Verlauf', async () => {
    render(<MassnahmeSeite id={M_IDS.m1} onListe={() => {}} />);
    await screen.findByTestId('massnahme-kacheln');
    expect(n(screen.getByTestId('massnahme-antwort').textContent)).toContain(
      'Seit der Umsetzung 2,4 % weniger Strom, als die Bezugsbasis erwarten lässt - erwartet waren 3 % weniger.',
    );
    expect(screen.getByTestId('massnahme-kachel-Weniger als erwartet').textContent).toContain('16.100kWh');
    expect(screen.getByTestId('massnahme-kachel-Erwartet waren').textContent).toContain('19.900kWh');
    expect(n(screen.getByTestId('massnahme-kachel-Vorher').textContent)).toContain('+12,9%');
    expect(screen.getByTestId('massnahme-herkunft').textContent).toContain('Aus der Abweichung AW-2028-0001.');
    expect(screen.getByTestId('massnahme-pruefsumme').textContent).toBe(`Prüfsumme ${PRUEFSUMME_R3}`);
    expect(screen.getByTestId('verlauf-kommentar').textContent).toContain('Zeitschaltung für die Maschinen 3 bis 6 ist bestellt');
    expect(screen.getByTestId('massnahme-bewerten').textContent).toBe('Wirkung prüfen');
    expect(screen.queryByTestId('massnahme-umgesetzt-knopf')).toBeNull();
  });
  it('vergessen wird keine Uhr: die Seite merkt sich den Tag der Route', async () => {
    render(<MassnahmeSeite id={M_IDS.m1} onListe={() => {}} />);
    await screen.findByTestId('massnahme-titel');
    merkeAbruf(null);
    const { routenHeute } = await import('./routenUhr');
    expect(routenHeute()).toBe('2028-03-15');
  });
});

describe('Verantwortliche melden die eigene Maßnahme (Entscheid 8, eng gefasst)', () => {
  it('die Regel: verwalten - oder eigene_massnahme nur an der eigenen Maßnahme', () => {
    const st = 'st-1';
    const nurEigene = (aktion: string, standort: string | null) => aktion === 'verbesserung.eigene_massnahme' && standort === st;
    const eigene = { standort_id: st, verantwortlich: { sub: 'MD', name: 'Murat Demirci' } };
    expect(M.darfMeldenUndKommentieren(nurEigene, eigene, 'MD')).toBe(true);
    expect(M.darfMeldenUndKommentieren(nurEigene, eigene, 'IK')).toBe(false);
    expect(M.darfMeldenUndKommentieren(nurEigene, eigene, null)).toBe(false);
    expect(M.darfMeldenUndKommentieren(nurEigene, { ...eigene, standort_id: null }, 'MD')).toBe(false);
    expect(M.darfMeldenUndKommentieren((a) => a === 'verbesserung.verwalten', { ...eigene, verantwortlich: { sub: 'IK', name: 'Ines Kaltenbach' } }, 'MD')).toBe(true);
  });
  it('Murat (bedienberechtigt): an der eigenen Maßnahme „Umsetzung melden“ und nur „Kommentar schreiben“ im Menü; an einer fremden nichts', async () => {
    setSelbstauskunft(rechteSeed('MD').me);
    const st1 = STANDORT_IDS['ST-1'];
    Object.assign(api, massnahmeBuehne('geplant', '2028-01-20'));
    const lesen = vi.spyOn(api, 'massnahme').mockResolvedValue({ ...m1('2028-01-20'), standort_id: st1 });
    render(<MassnahmeSeite id={M_IDS.m1} onListe={() => {}} />);
    expect((await screen.findByTestId('massnahme-umgesetzt-knopf')).textContent).toBe('Umsetzung melden');
    fireEvent.click(within(screen.getByTestId('massnahme-menue')).getByRole('button'));
    expect(screen.getByText('Kommentar schreiben')).toBeTruthy();
    expect(screen.queryByText('Ändern')).toBeNull();
    expect(screen.queryByText('Verwerfen')).toBeNull();
    cleanup();
    lesen.mockResolvedValue({ ...m1('2028-01-20'), standort_id: st1, verantwortlich: { sub: 'IK', name: 'Ines Kaltenbach' } });
    render(<MassnahmeSeite id={M_IDS.m1} onListe={() => {}} />);
    await screen.findByTestId('massnahme-titel');
    expect(screen.queryByTestId('massnahme-umgesetzt-knopf')).toBeNull();
    // Das Menü bleibt und nennt den Grund - kein Eintrag ist für Murat frei.
    fireEvent.click(within(screen.getByTestId('massnahme-menue')).getByRole('button'));
    expect(screen.queryByText('Kommentar schreiben')).toBeNull();
    expect(screen.getByText(/Dafür fehlt Ihnen das Recht/)).toBeTruthy();
  });
});

describe('Route der Seite', () => {
  it('#/portfolio/verbesserung/massnahmen/{id} hin und zurück', () => {
    const hash = hashForRoute(massnahmeRoute(M_IDS.m1));
    expect(hash).toBe(`#/portfolio/verbesserung/massnahmen/${M_IDS.m1}`);
    expect(parseRoute(hash)).toMatchObject({ page: 'portfolio-verbesserung', massnahmeId: M_IDS.m1, verbesserungReiter: 'massnahmen' });
  });
});
