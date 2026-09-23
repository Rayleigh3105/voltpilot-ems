import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  ablehnung,
  bewertungZeitraum,
  darfAnsehen,
  darfEinstufen,
  darfKriterienAendern,
  darfVerwalten,
  einflussText,
  einsatzAnfrage,
  einsatzOk,
  einsatzPruefen,
  einsatzZeile,
  LEER,
  leererEntwurf,
  messstelleOrt,
  protokollZeile,
  prozessOptionen,
  umfangAnfrage,
  umfangEntwurf,
  umfangKarte,
  umfangOk,
  umfangPruefen,
  verantwortlichText,
  verantwortlichOptionen,
  VORSCHLAG_GRUPPE,
  WEITERE_GRUPPE,
  zustandText,
  prozentText,
  zahlMitEinheit,
  vorschlagText,
} from './bewertung';
import { ebenenBereiche, ebenenLeiste, EBENEN_SEITEN, ebenenAktiv, type EbenenLesemodell } from './ebenenNav';
import { UEMS_BEWERTUNG_SAETZE } from './glossar';
import { energieeinsatzRoute, hashForRoute, pageRoute, parseRoute } from './nav';
import { benutzerFixture } from './test/benutzerFixtures';
import { ahrenbergEinsaetze, ahrenbergRangliste, ahrenbergUmfang, ahrenbergUmfangVorgabe, bewertungBuehne } from './test/bewertungFixtures';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import { ahrenbergProzesse } from './test/kennzahlAnlegenFixtures';
import { ahrenbergKennzahlen } from './test/kennzahlenFixtures';
import { rechteSeed } from './test/rollenFixtures';
import { werkAhrenberg, werkLindach } from './test/standorteFixtures';

/**
 * UEMS AP-16 IP-6 — die Welt „Bewertung“: Rechte (R14), Erscheinen nach der Berichte-Regel (§5.1), Umfang ohne
 * erfundenes x von y, Liste, Anlegen mit Vorschlägen und der Satz zur Ablehnung „zweiter laufender Einsatz“ (B1).
 */

const UNTERNEHMEN = { art: 'unternehmen' } as const;
const lm = (bewertung: boolean | null | undefined, messen?: 'bestand'): EbenenLesemodell => ({
  standorte: [werkAhrenberg(), werkLindach()],
  funktionen: ahrenbergFunktionen(messen ? { messen } : undefined),
  kennzahlen: ahrenbergKennzahlen(),
  ...(bewertung === undefined ? {} : { bewertung }),
});

describe('Rechte aus /me (R14)', () => {
  it('Ines (Energiemanager) sieht und verwaltet; Peter (Bearbeiter Lindach) sieht nur; Jonas (Kundenadministrator) verwaltet', () => {
    const ik = rechteSeed('IK').me;
    const ph = rechteSeed('PH').me;
    const jw = rechteSeed('JW').me;
    expect([darfAnsehen(ik), darfVerwalten(ik)]).toEqual([true, true]);
    expect([darfAnsehen(ph), darfVerwalten(ph)]).toEqual([true, false]);
    expect([darfAnsehen(jw), darfVerwalten(jw)]).toEqual([true, true]);
    expect([darfEinstufen(ik), darfKriterienAendern(ik)]).toEqual([true, true]);
    expect([darfEinstufen(ph), darfKriterienAendern(ph)]).toEqual([false, false]);
  });

  it('unbekannt ist nie ein Recht', () => {
    expect(darfAnsehen(null)).toBe(false);
    expect(darfVerwalten(undefined)).toBe(false);
  });
});

describe('Rangliste, Einstufung und Kriterien (IP-12)', () => {
  it('nimmt den letzten vollen Monat und zeigt UEMS-Zahlen nur gerundet an', () => {
    expect(bewertungZeitraum(new Date('2026-11-20T12:00:00Z'))).toEqual({ von: '2026-10-01', bis: '2026-10-31', label: 'Oktober 2026' });
    expect(zahlMitEinheit('185380', 'kWh')).toBe('185.380 kWh');
    expect(prozentText('67.8')).toBe('67,8 %');
    expect(vorschlagText('ueber_schwelle')).toBe('über Schwelle');
  });

  it('bildet R2 mit sechs Stromzeilen, Rest je Anlage und Gas unter „Weitere Träger“ ab', () => {
    const r = ahrenbergRangliste();
    expect(r.einsaetze.map((e) => [e.rang, e.kennzeichen, e.anteil_prozent, e.vorschlag])).toEqual([
      [1, 'EE-1', '41.8', 'ueber_schwelle'], [2, 'EE-3', '8.6', 'unter_schwelle'], [3, 'EE-2', '5.2', 'unter_schwelle'],
      [4, 'EE-6', '4.7', 'unter_schwelle'], [5, 'EE-5', '4.2', 'unter_schwelle'], [6, 'EE-4', '3.3', 'unter_schwelle'],
    ]);
    expect(r).toMatchObject({ rest: '59640', abdeckung_prozent: '67.8', urteil: { K7: 'vorlaeufig', K8: 'unter_schwelle' } });
    expect(r.anlagen.map((a) => a.rest)).toEqual(['54580', '3860', '1200']);
    expect(r.weitere_traeger[0]).toMatchObject({ kennzeichen: 'EE-7', menge: '1240', einheit: 'm³', anteil_prozent: null });
  });

  it('erzwingt Begründungen, hält Fassungen und bildet Vier-Augen als wartenden Vorschlag ab', async () => {
    const b = bewertungBuehne('voll', 'IK', '2026-11-20', true);
    const e = (await b.bewertungRangliste()).einsaetze.find((x) => x.kennzeichen === 'EE-3')!;
    await expect(b.energieeinsatzEinstufen(e.id, { einstufung: 'wesentlich', begruendung: ' ', grund: ['K4'], herkunft: e.herkunft })).rejects.toMatchObject({ status: 422 });
    const f = await b.energieeinsatzEinstufen(e.id, { einstufung: 'wesentlich', begruendung: 'Querschnitt mit Leckagepotenzial.', grund: ['K4'], herkunft: e.herkunft });
    expect(f).toMatchObject({ fassung: 2, gueltig_ab: null, freigabe_status: 'beantragt', vieraugen: true });
    expect((await b.energieeinsatzEinstufungen(e.id)).fassungen.map((x) => x.fassung)).toEqual([2, 1]);
  });

  it('ändert Kriterien nur begründet und berechnet den Vorschlag mit der neuen Fassung', async () => {
    const b = bewertungBuehne('voll');
    const k = await b.bewertungKriterien();
    await expect(b.bewertungKriterienSpeichern({ werte: k.werte, begruendung: '' })).rejects.toMatchObject({ status: 422 });
    await b.bewertungKriterienSpeichern({ werte: { ...k.werte, K1: '5' }, begruendung: 'Ab fünf Prozent prüfen.' });
    const ee2 = (await b.bewertungRangliste()).einsaetze.find((x) => x.kennzeichen === 'EE-2');
    expect(ee2).toMatchObject({ vorschlag: 'ueber_schwelle', herkunft: { kriterien_fassung: 2 } });
  });
});

describe('der Bereich „Bewertung“ erscheint nach der Berichte-Regel und nur mit dem Recht (§5.1, §6.3)', () => {
  it('ein Standort misst UND die Person darf sehen → siebter Bereich hinter „Berichte“ mit Seite', () => {
    const keys = ebenenBereiche(UNTERNEHMEN, lm(true)).map((b) => b.key);
    expect(keys.slice(-2)).toEqual(['berichte', 'bewertung']);
    const leiste = ebenenLeiste(UNTERNEHMEN, lm(true));
    expect(leiste.at(-1)).toMatchObject({ key: 'bewertung', label: 'Bewertung', ziel: pageRoute('portfolio-bewertung') });
    expect(EBENEN_SEITEN(UNTERNEHMEN).bewertung).toEqual(pageRoute('portfolio-bewertung'));
  });

  it('ohne Recht, mit unbekanntem Recht oder ohne messenden Standort gibt es den Bereich nicht', () => {
    for (const m of [lm(false), lm(null), lm(undefined), lm(true, 'bestand')])
      expect(ebenenBereiche(UNTERNEHMEN, m).map((b) => b.key)).not.toContain('bewertung');
  });

  it('am Standort gibt es keinen Bereich „Bewertung“ (Unternehmens-Geltung)', () => {
    const werk = { art: 'standort', standortId: werkAhrenberg().id } as const;
    expect(ebenenBereiche(werk, lm(true)).map((b) => b.key)).not.toContain('bewertung');
  });

  it('die Adresse: `#/portfolio/bewertung` ist Umfang und Liste, `…/{id}` die Seite eines Einsatzes', () => {
    const id = ahrenbergEinsaetze()[0].id;
    expect(hashForRoute(pageRoute('portfolio-bewertung'))).toBe('#/portfolio/bewertung');
    expect(hashForRoute(energieeinsatzRoute(id))).toBe(`#/portfolio/bewertung/${id}`);
    expect(parseRoute(`#/portfolio/bewertung/${id}`)).toEqual(energieeinsatzRoute(id));
    expect(parseRoute('#/portfolio/bewertung')).toEqual(pageRoute('portfolio-bewertung'));
    expect(ebenenAktiv('portfolio-bewertung')).toBe('bewertung');
  });
});

describe('Umfang (U1/U2) — nur die Zahl der Route, kein Nenner', () => {
  it('ohne Fassung: Vorschlag alle Standorte, Strom; die Anlagenzahl ist y', () => {
    const k = umfangKarte(ahrenbergUmfangVorgabe('2026-11-04'));
    expect(k.gespeichert).toBe(false);
    expect(k.kopf).toBe('Noch nicht festgelegt — Vorschlag: alle Standorte, Träger Strom.');
    expect(k.standorte.map((s) => `${s.name}: ${s.anlagen}`)).toEqual(['Werk Ahrenberg: 2 Anlagen', 'Werk Lindach: 1 Anlage']);
    expect(k.anlagen).toBe('am 04.11.2026 im Umfang: 3 Anlagen');
    expect(k.traeger).toEqual(['Strom (mit Anteil)']);
  });

  it('Fassung 1 (R1): beide Werke, Strom mit Anteil, Gas im Umfang ohne Anteil — kein kWh, kein „x von y“', () => {
    const k = umfangKarte(ahrenbergUmfang('2026-11-20'));
    expect(k.kopf).toBe('Fassung 1 · gültig ab 04.11.2026');
    expect(k.traeger).toEqual(['Strom (mit Anteil)', 'Gas (im Umfang, ohne Anteil)']);
    expect(k.akteur).toMatch(/^Ines Kaltenbach · 04\.11\.2026/);
    expect(JSON.stringify(k)).not.toMatch(/kWh| von \d/);
  });

  it('ein Ausschluss braucht eine Begründung; ein leerer Träger- oder Standortsatz wird nicht gesendet', () => {
    const e = umfangEntwurf(ahrenbergUmfangVorgabe('2026-11-04'), '2026-11-04');
    expect(e).toMatchObject({ gueltigAb: '2026-11-04', traeger: ['Strom'] });
    expect(umfangOk(umfangPruefen(e))).toBe(true);
    const ohne = { ...e, ausschluesse: [{ art: 'anlage' as const, verweis: 'x', begruendung: '  ' }] };
    expect(umfangPruefen(ohne).ausschluesse).toEqual({ 0: 'Ein Ausschluss braucht eine Begründung.' });
    expect(umfangPruefen({ ...e, traeger: [], standortIds: [] })).toMatchObject({
      traeger: 'Bitte wählen Sie mindestens einen Träger.',
      standorte: 'Bitte wählen Sie mindestens einen Standort.',
    });
    expect(umfangAnfrage({ ...e, begruendung: ' ' })).toEqual({
      gueltig_ab: '2026-11-04',
      standort_ids: e.standortIds,
      traeger: ['Strom'],
      ausschluesse: [],
      begruendung: null,
    });
  });
});

describe('Liste und Seite der Einsätze', () => {
  const [ee1, ee2, , ee4, , , ee7] = ahrenbergEinsaetze();

  it('die Karte nennt Prozess, Träger, Messstellen, Verantwortlichen und Zustand — ohne Zahl', () => {
    expect(einsatzZeile(ee1)).toMatchObject({
      kennzeichen: 'EE-1',
      prozess: 'P-1 Spritzguss',
      traeger: 'Strom',
      verantwortlich: 'Verantwortlich: Murat Demirci',
      zustand: 'läuft seit 04.11.2026',
      messstellen: '3 Messstellen',
      keineWerte: false,
    });
    expect(einsatzZeile(ee2).verantwortlich).toBe('Verantwortlich: Peter Hollerbach');
    // R12: Gas trägt „keine Werte“ statt einer Null.
    expect(einsatzZeile(ee7)).toMatchObject({ traeger: 'Gas', messstellen: '1 Messstelle', keineWerte: true });
  });

  it('der Leerzustand ist der Satz aus §5.7', () => {
    expect(LEER).toBe(UEMS_BEWERTUNG_SAETZE.leer());
    expect(LEER.startsWith('Noch keine Energieeinsätze.')).toBe(true);
  });

  it('Messstellen tragen ihren Ort; Einflussgrößen ihre Bezugsgröße oder den Wortlaut', () => {
    const ms06 = ee1.messstellen.find((m) => m.kennzeichen === 'MS-06')!;
    expect(messstelleOrt(ms06)).toBe('B-1');
    expect(ee1.einflussgroessen.map((e) => einflussText(e))).toEqual([
      'Produktion: Produktionsmenge Spritzguss (BZ-1)',
      'Betriebszeit: Betriebsstunden Spritzguss (BZ-3)',
    ]);
    expect(ee4.einflussgroessen.map((e) => einflussText(e))).toEqual(['Wetter: Außentemperatur']);
  });

  it('ein Verantwortlicher ohne Konto bleibt mit Vermerk (R14); beendet nennt den letzten Tag', () => {
    expect(verantwortlichText({ sub: 'x', name: 'Peter Hollerbach', ohne_konto_seit: '2027-02-01T08:00:00Z' })).toBe(
      'Peter Hollerbach (ohne Konto seit 01.02.2027)',
    );
    expect(verantwortlichText({ sub: null, name: null })).toBe('noch niemand');
    expect(zustandText({ gueltig_ab: '2026-11-04', gueltig_bis: '2026-11-30', beendet_am: '2026-11-30T10:00:00Z', beendet_grund: 'Linie stillgelegt' })).toBe(
      'beendet, letzter Tag 30.11.2026 — Linie stillgelegt',
    );
  });

  it('das Protokoll nennt jede Änderung mit Akteur und Zeit', () => {
    expect(
      protokollZeile({ id: 1, art: 'verantwortlicher', alt: null, neu: null, akteur: { sub: 's', name: 'Ines Kaltenbach', rolle: null, art: 'kunde' }, zeit: '2026-11-04T09:12:00Z' }),
    ).toBe('Verantwortlichen geändert · Ines Kaltenbach · 04.11.2026, 10:12');
  });
});

describe('Anlegen: Prozess-Picker mit Vorschlägen, Verantwortliche aus den Benutzern (§5.1 Schritt 3)', () => {
  it('ohne Einsatz: jeder Prozess ist ein Vorschlag', () => {
    const b = bewertungBuehne('leer');
    return b.energieeinsatzVorschlaege().then(({ vorschlaege }) => {
      const o = prozessOptionen(ahrenbergProzesse(), vorschlaege, [], 'Strom');
      expect(o.map((x) => x.group)).toEqual(Array(6).fill(VORSCHLAG_GRUPPE));
      expect(o.every((x) => !x.disabled)).toBe(true);
    });
  });

  it('ein Prozess mit laufendem Einsatz desselben Trägers bleibt sichtbar, gesperrt, mit Grund', () => {
    const ee = ahrenbergEinsaetze();
    const o = prozessOptionen(ahrenbergProzesse(), [], ee, 'Strom');
    const p1 = o.find((x) => x.label === 'Spritzguss')!;
    expect(p1).toMatchObject({ group: WEITERE_GRUPPE, disabled: true, disabledHint: 'läuft bereits: EE-1 Spritzguss' });
    // Mit Gas ist Spritzguss wählbar (anderer Träger); Verwaltung hat schon Gas (EE-7).
    const gas = prozessOptionen(ahrenbergProzesse(), [], ee, 'Gas');
    expect(gas.find((x) => x.label === 'Spritzguss')!.disabled).toBe(false);
    expect(gas.find((x) => x.label === 'Verwaltung')!.disabledHint).toBe('läuft bereits: EE-7 Heizung Verwaltung (Gas)');
  });

  it('Verantwortliche kommen aus den Benutzern, alphabetisch', () => {
    const o = verantwortlichOptionen(benutzerFixture());
    expect(o.map((x) => x.label)).toContain('Peter Hollerbach');
    expect(o.map((x) => x.label)).toEqual([...o.map((x) => x.label)].sort((a, b) => a.localeCompare(b, 'de')));
  });

  it('Pflicht: Prozess und Name; eine Einflussgröße ist Bezugsgröße ODER Wortlaut', () => {
    const e = leererEntwurf();
    expect(einsatzPruefen(e)).toMatchObject({ prozess: 'Bitte wählen Sie einen Prozess.', name: 'Bitte geben Sie einen Namen an.' });
    const voll = {
      ...e,
      prozessId: ahrenbergProzesse()[0].id,
      name: ' Spritzguss ',
      einfluesse: [{ art: 'wetter' as const, quelle: 'wortlaut' as const, bezugsgroesseId: 'nie-gesendet', wortlaut: ' Außentemperatur ' }],
    };
    expect(einsatzOk(einsatzPruefen(voll))).toBe(true);
    expect(einsatzAnfrage(voll)).toEqual({
      prozess_id: ahrenbergProzesse()[0].id,
      traeger: 'Strom',
      name: 'Spritzguss',
      verbraucher_wortlaut: null,
      verantwortlich_sub: null,
      einflussgroessen: [{ art: 'wetter', bezugsgroesse_id: null, wortlaut: 'Außentemperatur' }],
    });
  });

  it('B1: ein zweiter laufender Einsatz je (Prozess, Träger) wird abgelehnt — als verständlicher Satz', async () => {
    const b = bewertungBuehne('voll');
    const p1 = ahrenbergProzesse()[0];
    const err = await b.energieeinsatzAnlegen({ prozess_id: p1.id, traeger: 'Strom', name: 'Spritzguss 2' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    const { energieeinsaetze } = await b.energieeinsaetze();
    expect(ablehnung(err, { prozess: p1, traeger: 'Strom', einsaetze: energieeinsaetze })).toBe(
      'Für „Spritzguss“ mit Strom läuft schon EE-1 Spritzguss. Ein Prozess hat je Träger nur einen laufenden Energieeinsatz — beenden Sie ihn zuerst oder wählen Sie einen anderen Träger.',
    );
    expect(ablehnung(err)).toBe('Für diesen Prozess und Träger läuft schon ein Energieeinsatz. Beenden Sie ihn zuerst oder wählen Sie einen anderen Träger.');
    expect(ablehnung(new ApiError(403, 'x', { code: 'recht_fehlt' }))).toBe('Das dürfen Kundenadministratoren und Energiemanager.');
  });
});
