import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Energieziel, type EnergiezielStand, type Kennzahl } from './api';
import { EnergiezielSetzenFuehrung, fruehesterBeginn, zeitraumWahl } from './components/EnergiezielSetzenFuehrung';
import * as B from './energiezielBild';
import * as Z from './energieziele';
import { EnergiezielSeite } from './pages/EnergiezielSeite';
import { setSelbstauskunft } from './rollen';
import { merkeAbruf, vergissAbruf } from './routenUhr';
import { kz4 } from './test/bezugsbasisFixtures';
import { energiezielBuehne, ez2028, EZ_IDS, standJuli, standLeer } from './test/energiezielFixtures';
import { m1, m1Umgesetzt, wirkungR5 } from './test/massnahmeFixtures';
import { rechteSeed, STANDORT_IDS } from './test/rollenFixtures';

/**
 * Konzept Verbessern v1, PR 1 (Energieziele): das reine Bild - Antwort zuerst, Skala, Kacheln in kWh, „Was noch nötig
 * ist“, Monate mit Grund, festgehaltener Stand -, die Maßnahmen am Energieziel und „Energieziel setzen“ geführt. Die
 * Zahlen sind die der Mocks des Konzepts (§14) und des Vektors „K1 März 2029“.
 */
beforeEach(() => vergissAbruf());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NB = ' ';
type Vergleich = EnergiezielStand['monate'][number]['vergleich'];

/** Ein Monat des Lesers: mit Wert und Urteil, oder ohne Wert mit Grund. */
function monat(periode: string, w: { g?: string; e?: string; d?: string; urteil?: string; grund?: string; satz?: string } = {}): Vergleich {
  return {
    periode,
    beschriftung: B.monatLang(periode),
    roh: { gemessen: null, vorher: null, delta_prozent: null, richtung: null, variable_delta_prozent: null, urteil: 'ohne_urteil' },
    bereinigt: {
      fassung: null,
      gemessen: { wert: w.g ?? null, einheit: 'kWh', version: w.g ? 1 : null, zustand: w.g ? 'vollstaendig' : null },
      bedingung: [],
      erwartet: w.e ?? null,
      delta_prozent: w.d ?? null,
      band_prozent: w.d ? '2.0' : null,
      richtung: w.d ? (w.d.startsWith('-') ? 'weniger' : 'mehr') : null,
      urteil: (w.urteil ?? 'nicht_anwendbar') as Vergleich['bereinigt']['urteil'],
      grund: (w.grund ?? null) as Vergleich['bereinigt']['grund'],
      kennzeichen: [],
    },
    satz: w.satz ?? `${B.monatLang(periode)}: nicht bewertbar — der Monat ist noch nicht zu Ende.`,
  } as Vergleich;
}

const ez2029 = (over: Partial<Energieziel> = {}): Energieziel =>
  ez2028({ id: 'ez-2029', kennzeichen: 'EZ-2029-0001', zielwert_prozent: '-4.0', zielperiode: '2029-03/2029-12', angelegt_am: '2029-02-15', ...over });

/** März 2029 wie die Mocks des Konzepts: 88 740 kWh gegen 86 812,2 kWh, April läuft, Mai bis Dezember kommen. */
function standMaerz(): EnergiezielStand {
  const ez = ez2029();
  const spaeter = ['2029-05', '2029-06', '2029-07', '2029-08', '2029-09', '2029-10', '2029-11', '2029-12'];
  return {
    energieziel: ez,
    abruf: '2029-04-30',
    zielperiode: ez.zielperiode,
    zielwert_prozent: '-4.0',
    monate: [
      { periode: '2029-03', endgueltig: true, vergleich: monat('2029-03', { g: '88740', e: '86812.2', d: '2.2', urteil: 'schlechter' }) },
      { periode: '2029-04', endgueltig: false, vergleich: monat('2029-04', { grund: 'periode_nicht_zu_ende' }) },
      ...spaeter.map((p) => ({ periode: p, endgueltig: false, vergleich: monat(p, { grund: 'periode_nicht_zu_ende' }) })),
    ],
    monate_bewertbar: 1,
    monate_endgueltig: 1,
    monate_soll: 10,
    monate_text: '1 von 10',
    vollstaendig: false,
    nicht_gezaehlt: [],
    summe: { gemessen: '88740', erwartet: '86812.2', delta_prozent: '2.2', band_prozent: '2.0', richtung: 'mehr', urteil: 'schlechter', kennzeichen: [] },
    vorschlag: null,
    satz: null,
    vorschlag_satz: null,
    // Der Vektor „K1 März 2029“ (verbesserung-vectors.json).
    kurs: { lage: 'nicht_auf_kurs', monate_bewertbar: 1, monate_offen: 9, hoechstens: '83339.712', luecke: '5400.288', noetig_prozent: '-4.7', noetig_richtung: 'weniger' },
  };
}

describe('Antwort zuerst (§6.3, §6.4, V1–V7)', () => {
  it('März 2029: nicht auf Kurs, mit Monat, Zahl und dem, was vorgenommen ist', () => {
    const s = standMaerz();
    expect(B.zielSatz(s, s.energieziel)).toBe(
      `Das Energieziel 2029 ist bisher nicht auf Kurs: Im März wurde 2,2${NB}% mehr Energie gebraucht als erwartet, vorgenommen sind 4${NB}% weniger.`,
    );
    const a = B.seitenAntwort(s, s.energieziel);
    expect(a.satz).toBe(`Bisher nicht auf Kurs: Im März wurde 2,2${NB}% mehr Energie gebraucht als erwartet - vorgenommen sind 4${NB}% weniger.`);
    expect(a.formal).toBe('Stand nach 1 von 10 Monaten · März bis Dezember 2029 · gegen die Bezugsbasis BB-0001');
    expect(B.lueckeMarke(s)).toBe(`März: 5.400${NB}kWh über dem Energieziel`);
    expect(B.wenigeMonateHinweis(s)).toBe(
      'Erst ein Monat der Zielperiode ist abgeschlossen; der Stand ändert sich mit jedem Monat. Der April ist etwa ab 07.05.2029 endgültig.',
    );
  });
  it('auf Kurs und knapp dahinter sagen es zuerst; mehrere Energieziele zählen je Lage', () => {
    const s = standJuli();
    const auf = { ...s, kurs: { ...s.kurs!, lage: 'auf_kurs' as const } };
    const knapp = { ...s, kurs: { ...s.kurs!, lage: 'knapp_dahinter' as const } };
    expect(B.seitenAntwort(auf, s.energieziel).satz).toMatch(/^Auf Kurs: Von Januar bis Juni wurde 2,9/);
    expect(B.seitenAntwort(knapp, s.energieziel).satz).toMatch(/^Knapp dahinter: /);
    expect(B.registerSatz([{ ez: ez2028(), stand: auf }, { ez: ez2029(), stand: standMaerz() }], [])).toBe(
      '2 laufende Energieziele: 1 auf Kurs, 1 nicht auf Kurs.',
    );
    expect(B.registerSatz([], [ez2028({ zustand: 'bewertet', ergebnis: 'verfehlt' })])).toBe(
      'Gerade läuft kein Energieziel. Zuletzt abgeschlossen: Energieziel 2028, verfehlt.',
    );
  });
  it('noch keine Aussage nennt Grund und Tag statt „0 von 10“', () => {
    const leer = { ...standMaerz(), monate_bewertbar: 0, monate_endgueltig: 0, monate_text: '0 von 10', summe: standLeer(ez2029()).summe };
    leer.kurs = { ...leer.kurs!, lage: 'noch_keine_aussage', hoechstens: null, luecke: null, noetig_prozent: null, noetig_richtung: null };
    leer.monate = leer.monate.map((m) => ({ ...m, endgueltig: false }));
    // Am 20.03.2029 läuft der März noch.
    expect(B.seitenAntwort({ ...leer, abruf: '2029-03-20' }, leer.energieziel).satz).toBe('Noch keine Aussage: Der März ist etwa ab 07.04.2029 endgültig.');
    // Am 30.04.2029 ohne Wert für März: es fehlt eine Ablesung (Befund 1).
    leer.monate[0] = { periode: '2029-03', endgueltig: false, vergleich: monat('2029-03', { grund: 'keine_werte', satz: 'März 2029: nicht bewertbar — kein gemessener Wert.' }) };
    expect(B.zielSatz(leer, leer.energieziel)).toBe('Zum Energieziel 2029 gibt es noch keine Aussage: Für März 2029 fehlt ein gemessener Wert.');
    expect(B.seitenAntwort({ ...leer, abruf: '2029-02-16' }, leer.energieziel).satz).toBe('Noch keine Aussage: Die Zielperiode beginnt im März 2029.');
  });
});

describe('Skala, Kacheln und was noch nötig ist (§6.4, V4)', () => {
  it('die Skala aus Auswerten: Bezugsbasis in der Mitte, Energieziel −4 % rechts, „bisher +2,2 %“ links in Warnfarbe', () => {
    const k = B.skalaBild({ delta: '2.2', urteil: 'schlechter', zielwert: '-4.0', punktWort: 'bisher' });
    expect([k.basis, k.ziel, k.punkt]).toEqual([160, 260, 105]);
    expect(k.bereich).toEqual([160, 260]);
    expect(k.punktTon).toBe('warn');
    expect(k.punktText).toBe(`bisher +2,2${NB}%`);
    expect(k.zielText).toBe(`Energieziel −4${NB}%`);
  });
  it('Gemessen 88.740 kWh statt 86.812 erwartet · Höchstens laut Energieziel 83.340 kWh · 5.400 kWh darüber', () => {
    const s = standMaerz();
    expect(B.standKacheln(s)).toEqual([
      { name: 'Gemessen', wert: '88.740', einheit: 'kWh', sub: 'statt 86.812 erwartet' },
      { name: 'Höchstens laut Energieziel', wert: '83.340', einheit: 'kWh', subFett: `5.400${NB}kWh`, sub: ' darüber' },
    ]);
    expect(B.noetigSatz(s.kurs)).toBe(`In den übrigen neun Monaten im Schnitt rund 4,7${NB}% weniger als erwartet.`);
    expect(B.noetigSatz({ ...s.kurs!, noetig_prozent: '1.2', noetig_richtung: 'mehr' })).toBe(
      `In den übrigen neun Monaten im Schnitt bis zu 1,2${NB}% mehr als erwartet.`,
    );
    expect(B.noetigSatz({ ...s.kurs!, monate_offen: 0, noetig_prozent: null })).toBeNull();
    expect(B.noetigSatz({ ...s.kurs!, noetig_prozent: '-130.0' })).toMatch(/nicht mehr erreichen/);
  });
});

describe('Monate: Grafik und Liste mit Grund (§6.4, Befund 1)', () => {
  it('gezählt mit Δ und Urteil, laufend mit Tag, kommende ohne Zahl', () => {
    const p = B.monatsPunkte(standMaerz());
    expect(p[0]).toMatchObject({ art: 'gezaehlt', delta: 2.2, deltaText: `+2,2${NB}%`, urteilWort: 'über der Bezugsbasis', ton: 'warn', hoechstens: `83.340${NB}kWh` });
    expect(p[1]).toMatchObject({ art: 'vorlaeufig', grund: 'läuft noch - endgültig etwa ab 07.05.2029' });
    expect(p.slice(2).every((x) => x.art === 'kommt')).toBe(true);
    const { zeilen, spaeter } = B.monatsZeilen(p);
    expect(zeilen.map((z) => z.titel)).toEqual(['April 2029', 'März 2029']);
    expect(spaeter).toBe('Mai bis Dezember 2029 haben noch nicht begonnen.');
  });
  it('ein beendeter, noch nicht endgültiger Monat nennt den Grund der Route - nie geraten (Review r1 S-1.1)', () => {
    const s = { ...standMaerz(), abruf: '2029-04-02' };
    // Kurz nach Monatsende, die Produktionsmenge fehlt noch: der Satz der Route, kein „läuft noch“.
    s.monate[0] = {
      periode: '2029-03',
      endgueltig: false,
      vergleich: monat('2029-03', { g: '88740', grund: 'variable_fehlt', satz: 'März 2029: nicht bewertbar — die Produktionsmenge fehlt.' }),
    };
    expect(B.monatsPunkte(s)[0]).toMatchObject({ art: 'vorlaeufig', grund: 'die Produktionsmenge fehlt' });
    // Ohne gemessenen Wert, mit Grund der Route: „kein Wert“, der Grund wie die Route ihn sagt.
    s.monate[0] = { periode: '2029-03', endgueltig: false, vergleich: monat('2029-03', { grund: 'keine_werte', satz: 'März 2029: nicht bewertbar — kein gemessener Wert.' }) };
    expect(B.monatsPunkte(s)[0]).toMatchObject({ art: 'fehlt', grund: 'kein gemessener Wert' });
    // Wert da, die Route nennt keinen Grund: nur dann „noch nicht endgültig“, ohne erfundenen Tag.
    s.monate[0] = { periode: '2029-03', endgueltig: false, vergleich: monat('2029-03', { g: '88740', e: '86812.2', d: '2.2', urteil: 'schlechter' }) };
    expect(B.monatsPunkte(s)[0]).toMatchObject({ art: 'vorlaeufig', grund: Z.NOCH_NICHT_ENDGUELTIG });
    // Ein Grund ohne Satz der Route (`basis_fehlt` ohne Bezugsbasis) lässt die Zelle nicht leer.
    s.monate[0] = { periode: '2029-03', endgueltig: false, vergleich: monat('2029-03', { g: '88740', grund: 'basis_fehlt', satz: '' }) };
    expect(B.monatsPunkte(s)[0]).toMatchObject({ art: 'vorlaeufig', grund: 'nicht bewertbar' });
  });
  it('zwölf Monate ohne Wert stehen in einer Zeile - nicht zwölfmal derselbe Satz', () => {
    const s = { ...standLeer(ez2028()), abruf: '2029-04-30' };
    s.monate = s.monate.map((m) => ({ ...m, vergleich: monat(m.periode, { grund: 'keine_werte' }) }));
    const { zeilen } = B.monatsZeilen(B.monatsPunkte(s));
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]).toMatchObject({ titel: 'Januar bis Dezember 2028', text: 'kein gemessener Wert', marke: 'kein Wert' });
  });
});

describe('bewertet: der festgehaltene Stand oben (Entscheid 11)', () => {
  const bewertet = () => energiezielBuehne('bewertet');
  it('Ergebnis, Zahl und Zeitraum aus der Kopie; die Kacheln und was das Energieziel zugelassen hätte', async () => {
    const ez = await bewertet().energieziel!(EZ_IDS.ez1);
    const a = B.festAntwort(ez)!;
    expect(a.satz).toBe(`Verfehlt: Im Jahr 2028 wurde 2,7${NB}% weniger Energie gebraucht als erwartet - vorgenommen waren 5${NB}% weniger.`);
    expect(a.formal).toBe('Bewertet am 15.01.2029 von Ines Kaltenbach · 11 von 12 Monaten · März 2028 nicht bewertbar');
    const k = B.festKacheln(ez)!;
    expect(k.kacheln[1]).toMatchObject({ name: 'Erwartet', wert: '947.700', subFett: `25.600${NB}kWh`, sub: ' weniger gebraucht' });
    expect(k.fuss).toBe(`Für 5${NB}% weniger wären es höchstens 900.315${NB}kWh gewesen - gebraucht wurden 21.785${NB}kWh mehr.`);
  });
  it('„Heute gelesen“ nur, wenn der Live-Stand abweicht', async () => {
    const ez = await bewertet().energieziel!(EZ_IDS.ez1);
    expect(B.heuteGelesen(ez.bewertung!.stand, standLeer(ez))).toBe(
      'Heute gelesen: kein Monat der Zielperiode ist bewertbar. Festgehalten bleibt der Stand vom 15.01.2029.',
    );
    const gleich = { ...standJuli(ez), monate_bewertbar: 11, summe: { ...standJuli(ez).summe, delta_prozent: '-2.7' } };
    expect(B.heuteGelesen(ez.bewertung!.stand, gleich)).toBeNull();
  });
  it('die Seite zeigt den festgehaltenen Stand, das Ergebnis ohne Warnfarbe und die Kopie eine Ebene tiefer', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, bewertet());
    render(<EnergiezielSeite id={EZ_IDS.ez1} onListe={() => undefined} />);
    expect((await screen.findByTestId('energieziel-antwort')).textContent).toContain('Verfehlt: Im Jahr 2028');
    const fest = screen.getByTestId('energieziel-fest');
    expect(within(fest).getByText('922.100')).toBeTruthy();
    expect(within(fest).getByText('15.01.2029')).toBeTruthy();
    expect(screen.getByText('Kopie und Prüfsumme')).toBeTruthy();
    expect(screen.queryByText('nicht auf Kurs')).toBeNull();
  });
});

describe('Maßnahmen am Energieziel (Entscheid 5)', () => {
  it('die Maßnahmen für das Energieziel und, getrennt, was schon im Stand enthalten ist - mit beobachteter Wirkung', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    const geplant = m1('2028-07-10', { id: 'm-neu', kennzeichen: 'M-2028-0009', titel: 'Kühlwasserpumpen drehzahlgeregelt betreiben', termin: '2028-09-30', messgrundlage: null, energieziel: { id: EZ_IDS.ez1, kennzeichen: 'EZ-2028-0001', name: null } });
    const umgesetzt = { ...m1Umgesetzt('2028-07-10'), zustand: 'bewertet' as const, energieziel: null, wirkung_kurz: wirkungR5(m1Umgesetzt()).massnahme.wirkung_kurz };
    umgesetzt.bewertung = { stand_nr: 1, status: 'bewertet', ergebnis: 'belegt', begruendung: 'Laufzeit 18 % niedriger.', vieraugen: false, person: { sub: 'IK', name: 'Ines Kaltenbach' }, am: '2028-11-15T10:00:00+01:00', entscheidung: null, entschieden_am: null, entscheidungs_begruendung: null, kopie: null, pruefsumme: null, satz: null };
    Object.assign(api, energiezielBuehne('juli'), {
      massnahmenZumEnergieziel: async () => ({ abruf: '2028-07-10', massnahmen: [umgesetzt, geplant], im_stand_enthalten: [umgesetzt.id] }),
    });
    // Was beobachtet ist, steht in der Liste (`wirkung_kurz`) - kein Abruf je Maßnahme (Review r1 S-1.6).
    const einzeln = vi.spyOn(api, 'massnahmeWirkung');
    render(<EnergiezielSeite id={EZ_IDS.ez1} onListe={() => undefined} onMassnahme={() => undefined} />);
    const karte = await screen.findByTestId('energieziel-massnahmen');
    expect(within(karte).getByTestId('massnahme-M-2028-0009').textContent).toContain('geplant bis 30.09.2028 · Murat Demirci');
    expect(within(karte).getByText('Schon umgesetzt, im Stand enthalten')).toBeTruthy();
    expect(await within(karte).findByText(`seit 22.01.2028 · 2,4${NB}% weniger beobachtet · belegt`.replace(NB, ' '))).toBeTruthy();
    expect(within(karte).getByTestId('energieziel-planen').textContent).toBe('Weitere Maßnahme planen');
    expect(einzeln).not.toHaveBeenCalled();
  });
  it('der Fuß der Karte im Reiter zählt nur die Maßnahmen für das Energieziel', () => {
    expect(B.massnahmenFuss([])).toBe('Noch keine Maßnahme geplant');
    expect(B.massnahmenFuss([m1()])).toBe('1 Maßnahme geplant');
    expect(B.massnahmenFuss([m1(), m1Umgesetzt()])).toBe('2 Maßnahmen: 1 geplant, 1 umgesetzt');
  });
});

describe('„Energieziel setzen“ geführt (§6.9)', () => {
  const montage = (over: Partial<Kennzahl> = {}): Kennzahl =>
    kz4({ ...over, id: 'kz-21', kennzeichen: 'KZ-0021', name: 'Stromeinsatz Montage je Stück', geltung_name: 'Halle 1', bezugsbasis: { kennzeichen: 'BB-0006', fassung: 1, freigabe_status: 'freigegeben', vorlaeufig: false } });
  const spritzguss = (): Kennzahl =>
    kz4({ name: 'Stromeinsatz Spritzguss je kg', bezugsbasis: { kennzeichen: 'BB-0001', fassung: 2, freigabe_status: 'freigegeben', vorlaeufig: true } });

  it('früheste Beginne und die Schnellwahl des Zeitraums folgen der Uhr der Route', () => {
    expect(fruehesterBeginn('2029-04-30', [])).toBe('2029-05');
    expect(fruehesterBeginn('2029-04-30', [{ zielperiode: '2029-03/2029-12' }])).toBe('2030-01');
    expect(zeitraumWahl('2029-05')).toEqual([
      { wert: '2029-05/2029-12', label: 'Mai bis Dezember 2029' },
      { wert: '2030-01/2030-12', label: '2030' },
    ]);
    expect(zeitraumWahl('2030-01').map((w) => w.label)).toEqual(['2030', '2031']);
  });

  it('nur Kennzahlen, an deren Geltung die Person Energieziele setzen darf (Review r1 S-1.5)', async () => {
    // Peter Hollerbach verwaltet nur an ST-2: KZ-0021 dort ja, KZ-0004 am Unternehmen nicht.
    setSelbstauskunft(rechteSeed('PH').me);
    merkeAbruf('2029-04-30');
    Object.assign(api, {
      kennzahlen: async () => ({ kennzahlen: [spritzguss(), montage({ standort_id: STANDORT_IDS['ST-2'] })] }),
      energieziele: async () => ({ energieziele: [] }),
    });
    render(<EnergiezielSetzenFuehrung onClose={() => undefined} onGesetzt={vi.fn()} />);
    expect(await screen.findByTestId('energieziel-setzen-kennzahl-KZ-0021')).toBeTruthy();
    expect(screen.queryByTestId('energieziel-setzen-kennzahl-KZ-0004')).toBeNull();
    cleanup();

    Object.assign(api, { kennzahlen: async () => ({ kennzahlen: [spritzguss()] }) });
    render(<EnergiezielSetzenFuehrung onClose={() => undefined} onGesetzt={vi.fn()} />);
    expect((await screen.findByTestId('energieziel-setzen-keine-kennzahl')).textContent).toMatch(/^An Ihren Standorten hat noch keine Kennzahl/);
  });

  it('Kennzahl wählen, Wert und Zeitraum, prüfen - gesendet wird, was dasteht', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    merkeAbruf('2029-04-30');
    const anlegen = vi.fn(async (body: Parameters<typeof api.energiezielAnlegen>[0]) => ez2029({ id: 'neu', zielperiode: body.zielperiode }));
    Object.assign(api, {
      kennzahlen: async () => ({ kennzahlen: [spritzguss(), montage()] }),
      energieziele: async () => ({ energieziele: [ez2029({ kennzahl: { id: spritzguss().id, kennzeichen: 'KZ-0004', name: 'Stromeinsatz Spritzguss je kg' } })] }),
      bezugsbasisVergleich: async () => ({ von: '2028-04', bis: '2029-03', zeitraum: { delta_prozent: '-0.8', richtung: 'weniger', urteil: 'im_rahmen', monate: '12 von 12' } }),
      energiezielAnlegen: anlegen,
    });
    const gesetzt = vi.fn();
    render(<EnergiezielSetzenFuehrung onClose={() => undefined} onGesetzt={gesetzt} />);
    const belegt = await screen.findByTestId('energieziel-setzen-kennzahl-KZ-0004');
    expect(belegt.textContent).toContain('Für März bis Dezember 2029 läuft schon das Energieziel 2029. Ein weiteres geht ab Januar 2030.');
    await act(async () => fireEvent.click(screen.getByTestId('energieziel-setzen-weiter')));
    expect(screen.getByText('Bitte wählen Sie eine Kennzahl.')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('energieziel-setzen-kennzahl-KZ-0021')).getByRole('radio'));
    await act(async () => fireEvent.click(screen.getByTestId('energieziel-setzen-weiter')));

    expect(await screen.findByText(/Zur Einordnung: Von April 2028 bis März 2029 lag die Kennzahl 0,8/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByTestId('energieziel-setzen-weiter')));
    expect(anlegen).not.toHaveBeenCalled();
    expect(screen.getByText(/Eine Zahl zwischen 0 und 100/)).toBeTruthy();
    // Unter „Wie viel weniger?“ wird ein eingetipptes Minus nicht still zu „mehr“ (Review r1 S-1.4).
    fireEvent.change(screen.getByTestId('energieziel-setzen-betrag'), { target: { value: '-4' } });
    await act(async () => fireEvent.click(screen.getByTestId('energieziel-setzen-weiter')));
    expect(screen.getByText('Bitte ohne Vorzeichen. Für mehr wählen Sie „Mehr zulassen“.').getAttribute('role')).toBe('alert');
    expect(screen.queryByTestId('energieziel-setzen-pruefen')).toBeNull();
    fireEvent.change(screen.getByTestId('energieziel-setzen-betrag'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('energieziel-setzen-begruendung'), { target: { value: 'Neue Druckluftleitung in der Montage.' } });
    expect(screen.getByRole('button', { name: 'Mai bis Dezember 2029' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('energieziel-setzen-so').textContent).toContain(
      'Stromeinsatz Montage je Stück: 3 % weniger, als die Bezugsbasis erwarten lässt. · Mai bis Dezember 2029 · verantwortlich Ines Kaltenbach',
    );
    await act(async () => fireEvent.click(screen.getByTestId('energieziel-setzen-weiter')));
    expect(screen.getByTestId('energieziel-setzen-pruefen').textContent).toContain('‚Neue Druckluftleitung in der Montage.‘');
    await act(async () => fireEvent.click(screen.getByTestId('energieziel-setzen-senden')));
    expect(anlegen).toHaveBeenCalledWith({
      kennzahl: 'kz-21',
      zielwert_prozent: -3,
      zielperiode: '2029-05/2029-12',
      wortlaut: 'Stromeinsatz Montage je Stück: 3 % weniger, als die Bezugsbasis erwarten lässt.',
      begruendung: 'Neue Druckluftleitung in der Montage.',
    });
    expect(gesetzt).toHaveBeenCalled();
  });
});

describe('Kundenwörter', () => {
  it('kein Text des Moduls sagt „Ziel“ allein oder benutzt einen Geviertstrich', () => {
    const texte = Object.values(B).filter((v): v is string => typeof v === 'string');
    for (const t of texte) {
      expect(/(?<![\p{L}])Ziel(?![\p{L}])/u.test(t), t).toBe(false);
      expect(t.includes('—'), t).toBe(false);
    }
  });
});
