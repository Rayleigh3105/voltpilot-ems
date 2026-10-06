import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { EnergiezielBewertenDialog, EnergiezielSetzen } from './components/EnergiezielDialoge';
import { ebenenAktiv, ebenenBereiche, EBENEN_SEITEN, type EbenenLesemodell } from './ebenenNav';
import * as B from './energiezielBild';
import * as Z from './energieziele';
import { UEMS_NORMGRENZE, UEMS_VERBESSERUNG_SAETZE, UEMS_ZIELE_UND_MASSNAHMEN } from './glossar';
import { energiezielRoute, hashForRoute, pageRoute, parseRoute, verbesserungRoute } from './nav';
import { EnergiezielSeite } from './pages/EnergiezielSeite';
import { VerbesserungBereich } from './pages/VerbesserungBereich';
import { setSelbstauskunft } from './rollen';
import { bb1, bb1Fassung, kz4 } from './test/bezugsbasisFixtures';
import { abweichungBuehne } from './test/abweichungFixtures';
import { energiezielBuehne, EZ_IDS, ez2028, STAND_SATZ_JULI, standEnde, standJuli, standLeer } from './test/energiezielFixtures';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import { ahrenbergKennzahlen } from './test/kennzahlenFixtures';
import { rechteSeed } from './test/rollenFixtures';
import { werkAhrenberg, werkLindach } from './test/standorteFixtures';

/**
 * UEMS AP-18 IP-8: Bereich „Ziele und Maßnahmen“, Register „Energieziele“, „Energieziel setzen“ und die
 * Energieziel-Seite — Kundenwörter (SP1: „Energieziel“, nie „Ziel“ allein), das reine Bild (das Portal rechnet
 * nichts: Stand, Summe und Vorschlag kommen vom Leser) und die Flächen gegen R4/R10.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ZIEL_ALLEIN = /(?<![\p{L}])Ziel(?![\p{L}])/u;
const texteDes = (modul: Record<string, unknown>) =>
  Object.values(modul).flatMap((v) =>
    typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).filter((x): x is string => typeof x === 'string') : [],
  );

describe('Kundenwörter (SP1, W6)', () => {
  it('der Bereich heißt „Ziele und Maßnahmen“ mit drei Reitern; der Knopf heißt „Energieziel setzen“', () => {
    expect(Z.REITER.map((r) => r.label)).toEqual(['Energieziele', 'Maßnahmen', 'Abweichungen']);
    expect(Z.KNOPF_SETZEN).toBe('Energieziel setzen');
    expect(UEMS_ZIELE_UND_MASSNAHMEN).toBe('Ziele und Maßnahmen');
    expect(Z.ERGEBNIS_WORT).toEqual({ erreicht: 'erreicht', verfehlt: 'verfehlt', nicht_bewertbar: 'nicht bewertbar' });
  });
  it('kein Text des Moduls sagt „Ziel“ allein', () => {
    const texte = texteDes(Z as unknown as Record<string, unknown>);
    expect(texte.length).toBeGreaterThan(20);
    expect(texte.filter((t) => ZIEL_ALLEIN.test(t))).toEqual([]);
  });
});

describe('das reine Bild — Anzeige, keine Rechnung', () => {
  it('Zielperiode und Zielwert so, wie die Person sie gesetzt hat (SP4)', () => {
    expect(Z.zielperiodeText('2028-01/2028-12')).toBe('Januar bis Dezember 2028');
    expect(Z.zielperiodeText('2027-11/2028-10')).toBe('November 2027 bis Oktober 2028');
    expect(Z.zielwertText('-5.0')).toBe('5 % weniger');
    expect(Z.zielwertText('-2.5')).toBe('2,5 % weniger');
    expect(Z.zielwertText('3.0')).toBe('3 % mehr');
  });
  it('Vorgabe der Zielperiode ist das nächste volle Kalenderjahr; gewählt wird ab dem nächsten Monat (Z2)', () => {
    expect(Z.zielperiodeVorgabe('2027-12-20')).toBe('2028-01/2028-12');
    expect(Z.monatsWahl('2027-12-20', 2)).toEqual([
      { value: '2028-01', label: 'Januar 2028' },
      { value: '2028-02', label: 'Februar 2028' },
    ]);
    expect(Z.monatsWahl('2026-09-24', 1)[0].value).toBe('2026-10');
    expect(Z.zielperiodeOk('2028-01', '2028-12')).toBe(true);
    expect(Z.zielperiodeOk('2028-12', '2028-01')).toBe(false);
  });
  it('der Zielwert im Dialog: „5“ wird −5 (weniger Energie negativ), eine Stelle, nie 0', () => {
    expect(Z.zielwertAusEingabe('5')).toBe(-5);
    expect(Z.zielwertAusEingabe('2,5')).toBe(-2.5);
    expect(Z.zielwertAusEingabe('-3')).toBe(3);
    for (const falsch of ['', '0', '2,55', '100', 'fünf']) expect(Z.zielwertAusEingabe(falsch), falsch).toBeNull();
  });
  it('R4: Stand-Spalte „2,9 % weniger nach 5 von 12 Monaten“, März nicht gezählt mit dem Satz des Lesers', () => {
    const s = standJuli();
    expect(Z.standSpalte(s)).toBe('2,9 % weniger nach 5 von 12 Monaten');
    const zeilen = Z.monatZeilen(s);
    expect(zeilen).toHaveLength(12);
    expect(zeilen[0]).toMatchObject({ art: 'gezaehlt', beschriftung: 'Januar 2028', gemessen: '78 000 kWh', erwartet: '80 813 kWh', delta: '3,5 % weniger', urteil: 'besser', band: '± 2 %' });
    expect(zeilen[2]).toMatchObject({ art: 'ausgeschlossen', beschriftung: 'März 2028' });
    expect(zeilen[2].art === 'ausgeschlossen' && zeilen[2].satz).toContain('außerhalb der Bezugsbasis');
    expect(zeilen.slice(6).every((z) => z.art === 'offen')).toBe(true);
    expect(Z.summenZeile(s)).toMatchObject({ gemessen: '410 400 kWh', erwartet: '422 809 kWh', delta: '2,9 % weniger', monate: '5 von 12 Monaten' });
    expect(Z.vorschlagSatz(s)).toBeNull();
  });
  it('ohne bewertbaren Monat keine Zahl — ein Satz statt einer Null (Invariante 5)', () => {
    const s = standLeer(ez2028({ id: EZ_IDS.neu, zielperiode: '2027-01/2027-12' }));
    expect(Z.standSpalte(s)).toBe('noch kein bewertbarer Monat (0 von 12)');
    expect(Z.summenZeile(s)).toBeNull();
  });
  it('R10: 11 von 12 — kein Vorschlag; bei vollständiger Periode steht der Satz des Lesers', () => {
    expect(Z.vorschlagSatz(standEnde())).toBeNull();
    const satz = 'Zielwert nicht erreicht: 2,7 % weniger gegenüber 5 % weniger (12 von 12 Monaten) — Vorschlag; bestätigen oder mit Begründung abweichen.';
    expect(Z.vorschlagSatz({ vollstaendig: true, vorschlag: 'nicht_erreicht', vorschlag_satz: satz })).toBe(satz);
    expect(Z.weichtAb('nicht_erreicht', 'verfehlt')).toBe(false);
    expect(Z.weichtAb('nicht_erreicht', 'erreicht')).toBe(true);
    expect(Z.weichtAb(null, 'erreicht')).toBe(false);
  });
  it('die Frist kommt von der Route (F1) — ohne Feld kein Satz', () => {
    expect(Z.fristText(ez2028())).toBeNull();
    expect(Z.fristText(ez2028({ frist: { faellig: 'bewertung_faellig', seit_tagen: 15 } }))).toBe('Bewertung fällig seit 15 Tagen');
    expect(Z.fristText(ez2028({ frist: { faellig: 'bewertung_faellig', seit_tagen: 1 } }))).toBe('Bewertung fällig seit 1 Tag');
  });
});

describe('Navigation: Bereich neben Kennzahlen, Berichte, Bewertung — nur mit `verbesserung.ansehen`', () => {
  const lm = (verbesserung: boolean | null): EbenenLesemodell => ({
    standorte: [werkAhrenberg(), werkLindach()],
    funktionen: ahrenbergFunktionen(),
    kennzahlen: ahrenbergKennzahlen(),
    verbesserung,
  });
  const UNTERNEHMEN = { art: 'unternehmen' } as const;
  it('der Bereich steht nur mit dem Recht; unbekannt ist nie „ja“', () => {
    expect(ebenenBereiche(UNTERNEHMEN, lm(true)).map((b) => b.key)).toContain('verbesserung');
    expect(ebenenBereiche(UNTERNEHMEN, lm(false)).map((b) => b.key)).not.toContain('verbesserung');
    expect(ebenenBereiche(UNTERNEHMEN, lm(null)).map((b) => b.key)).not.toContain('verbesserung');
    expect(ebenenBereiche(UNTERNEHMEN, lm(true)).find((b) => b.key === 'verbesserung')?.label).toBe('Ziele und Maßnahmen');
    expect(EBENEN_SEITEN(UNTERNEHMEN, lm(true)).verbesserung).toEqual(pageRoute('portfolio-verbesserung'));
    expect(ebenenAktiv('portfolio-verbesserung')).toBe('verbesserung');
  });
  it('Leser (CB) sieht den Bereich, Energiemanager (IK) auch; Bedienberechtigte ohne Standort-Recht nicht überall', () => {
    expect(Z.darfAnsehen(rechteSeed('IK').me)).toBe(true);
    expect(Z.darfAnsehen(rechteSeed('CB').me)).toBe(true);
    expect(Z.darfAnsehen(null)).toBe(false);
  });
  it('stabile Adressen: Reiter und Seite eines Energieziels', () => {
    expect(hashForRoute(verbesserungRoute())).toBe('#/portfolio/verbesserung');
    expect(hashForRoute(verbesserungRoute('massnahmen'))).toBe('#/portfolio/verbesserung/massnahmen');
    expect(hashForRoute(energiezielRoute(EZ_IDS.ez1))).toBe(`#/portfolio/verbesserung/energieziele/${EZ_IDS.ez1}`);
    expect(parseRoute('#/portfolio/verbesserung')).toEqual(verbesserungRoute());
    expect(parseRoute('#/portfolio/verbesserung/abweichungen')).toEqual(verbesserungRoute('abweichungen'));
    expect(parseRoute(`#/portfolio/verbesserung/energieziele/${EZ_IDS.ez1}`)).toEqual(energiezielRoute(EZ_IDS.ez1));
  });
});

describe('die Flächen gegen R4/R10', () => {
  const bereich = (reiter: 'energieziele' | 'massnahmen' | 'abweichungen' = 'energieziele') =>
    render(<VerbesserungBereich reiter={reiter} energiezielId={null} onReiter={() => undefined} onOeffnen={() => undefined} onListe={() => undefined} />);

  it('leer: ein Satz mit Beispiel, „Energieziel setzen“ und der Grenz-Satz (R13, Konzept Verbessern §6.12)', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, energiezielBuehne('leer'));
    bereich();
    expect(await screen.findByText(B.LEER)).toBeTruthy();
    expect(screen.getByTestId('energieziel-setzen-leer').textContent).toBe('Energieziel setzen');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Energieziele');
    expect(screen.getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });
  it('Abweichungen (IP-18): das Register — leer mit Satz und Grenz-Satz, ohne Knopf', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, abweichungBuehne('leer', '2028-01-15'));
    bereich('abweichungen');
    const register = await screen.findByTestId('abweichungen-register');
    expect(within(register).getByTestId('abweichungen-leer')).toBeTruthy();
    expect(within(register).queryByRole('button')).toBeNull();
    expect(screen.getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });
  it('Reiter R4: die Antwort zuerst, die Karte mit Skala, Lage, Monaten, Lücke in kWh und dem nächsten Schritt (§6.3)', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, energiezielBuehne('juli'));
    bereich();
    expect((await screen.findByTestId('energieziele-antwort')).textContent).toContain(
      'Das Energieziel 2028 ist bisher nicht auf Kurs: Von Januar bis Juni wurde 2,9\u00a0% weniger Energie gebraucht als erwartet, vorgenommen sind 5\u00a0% weniger.',
    );
    expect(screen.getByTestId('energieziele-antwort').textContent).toContain('1 laufendes Energieziel · Stand 10.07.2028 · gemessen gegen die Bezugsbasis');
    const karte = screen.getByTestId('energieziel-karte-EZ-2028-0001');
    expect(within(karte).getByText('Energieziel 2028')).toBeTruthy();
    expect(within(karte).getByTestId('energieziel-lage').textContent).toBe('nicht auf Kurs');
    expect(within(karte).getByText('5 von 12 Monaten')).toBeTruthy();
    expect(within(karte).getByText('Bisher 8.731 kWh über dem Energieziel')).toBeTruthy();
    expect(within(karte).getByRole('img').getAttribute('aria-label')).toContain('nicht auf Kurs');
    expect(within(karte).getByTestId('energieziel-massnahmen').textContent).toBe('Noch keine Maßnahme geplant');
    expect(within(karte).getByTestId('energieziel-planen').textContent).toBe('Maßnahme planen');
  });
  it('Seite R4: Antwort mit Bedingung, Stand in kWh, was noch nötig ist, März mit Grund - noch kein „bewerten“ (§6.4)', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, energiezielBuehne('juli'));
    render(<EnergiezielSeite id={EZ_IDS.ez1} onListe={() => undefined} />);
    const antwort = await screen.findByTestId('energieziel-antwort');
    expect(antwort.textContent).toContain(
      'Bisher nicht auf Kurs: Von Januar bis Juni wurde 2,9\u00a0% weniger Energie gebraucht als erwartet - vorgenommen sind 5\u00a0% weniger.',
    );
    expect(antwort.textContent).toContain('Stand nach 5 von 12 Monaten · Januar bis Dezember 2028 · gegen die Bezugsbasis BB-0001');
    const stand = screen.getByTestId('energieziel-stand');
    expect(within(stand).getByText('410.400')).toBeTruthy();
    expect(within(stand).getByText('statt 422.809 erwartet')).toBeTruthy();
    expect(within(stand).getByText('401.669')).toBeTruthy();
    expect(within(stand).getByText('8.731 kWh')).toBeTruthy();
    expect(screen.getByTestId('energieziel-noetig').textContent).toBe(
      'Was noch nötig ist: In den übrigen sechs Monaten im Schnitt rund 6,7\u00a0% weniger als erwartet. Näherung bei gleich großen Monaten.',
    );
    const werte = screen.getByTestId('energieziel-werte');
    expect(within(werte).getAllByTestId('monat-2028-03')[0].textContent).toContain('außerhalb der Bezugsbasis');
    expect(within(werte).getAllByTestId('monat-2028-06')[0].textContent).toContain('−3,4\u00a0%unter der Bezugsbasis');
    expect(screen.getByTestId('monatsgrafik-info').textContent).toContain('Juni 2028');
    expect(screen.queryByTestId('energieziel-bewerten')).toBeNull();
    expect(screen.getByTestId('energieziel-menue')).toBeTruthy();
    expect(screen.getAllByText(UEMS_NORMGRENZE).length).toBeGreaterThan(0);
  });
  it('Seite R10: „Bewertung fällig seit 15 Tagen“, „bewerten“ ohne Vorschlag; der Leser (CB) bekommt keinen Knopf', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, energiezielBuehne('faellig'));
    render(<EnergiezielSeite id={EZ_IDS.ez1} onListe={() => undefined} />);
    expect((await screen.findByTestId('energieziel-frist')).textContent).toBe('Bewertung fällig seit 15 Tagen');
    await act(async () => fireEvent.click(screen.getByTestId('energieziel-bewerten')));
    expect(screen.getByTestId('bewerten-ohne-vorschlag')).toBeTruthy();
    const senden = vi.spyOn(api, 'energiezielBewertung');
    await act(async () => fireEvent.click(screen.getByTestId('energieziel-bewerten-senden')));
    expect(senden).not.toHaveBeenCalled();
    expect(screen.getByText('Bitte wählen Sie ein Ergebnis.')).toBeTruthy();
    cleanup();

    setSelbstauskunft(rechteSeed('CB').me);
    render(<EnergiezielSeite id={EZ_IDS.ez1} onListe={() => undefined} />);
    expect(await screen.findByTestId('energieziel-frist')).toBeTruthy();
    expect(screen.queryByTestId('energieziel-bewerten')).toBeNull();
    expect(screen.queryByTestId('energieziel-beenden')).toBeNull();
  });
  it('Vier-Augen: IK sieht ihren eigenen Antrag ohne Knopf, JW bestätigt ihn', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, energiezielBuehne('beantragt'));
    render(<EnergiezielSeite id={EZ_IDS.ez1} onListe={() => undefined} />);
    expect((await screen.findByTestId('energieziel-beantragt')).textContent).toContain('beantragt von Ines Kaltenbach am 15.01.2029');
    expect(screen.getByText(Z.EIGENER_ANTRAG)).toBeTruthy();
    expect(screen.queryByTestId('energieziel-freigeben')).toBeNull();
    cleanup();

    setSelbstauskunft(rechteSeed('JW').me);
    render(<EnergiezielSeite id={EZ_IDS.ez1} onListe={() => undefined} />);
    expect(await screen.findByTestId('energieziel-freigeben')).toBeTruthy();
    expect(screen.getByTestId('energieziel-ablehnen')).toBeTruthy();
  });
  it('„bewerten“ folgt der Route: 409 `vieraugen_beantragen` → derselbe Inhalt als Antrag über `beantragen` (IP-7)', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, energiezielBuehne('faellig', true));
    const aufrufe = vi.spyOn(api, 'energiezielBewertung');
    const onFertig = vi.fn();
    const ez = await api.energieziel(EZ_IDS.ez1);
    // Vollständige Periode mit Vorschlag „nicht erreicht“ → das Ergebnis „verfehlt“ ist vorbelegt (Z4).
    const stand = { ...standEnde(ez), vollstaendig: true, vorschlag: 'nicht_erreicht' as const, vorschlag_satz: 'Zielwert nicht erreicht — Vorschlag.' };
    render(<EnergiezielBewertenDialog ez={ez} stand={stand} schritt="bewerten" onClose={() => undefined} onFertig={onFertig} />);
    expect(screen.getByTestId('bewerten-vorschlag').textContent).toBe('Zielwert nicht erreicht — Vorschlag.');
    const b = 'Zwei Maßnahmen wirken erst ab dem zweiten Halbjahr.';
    fireEvent.change(screen.getByLabelText('Begründung'), { target: { value: b } });
    await act(async () => fireEvent.click(screen.getByTestId('energieziel-bewerten-senden')));
    expect(aufrufe.mock.calls.map((c) => c[1])).toEqual(['bewerten', 'beantragen']);
    expect(aufrufe).toHaveBeenLastCalledWith(EZ_IDS.ez1, 'beantragen', { ergebnis: 'verfehlt', begruendung: b });
    expect(onFertig.mock.calls[0][0].bewertung).toMatchObject({ status: 'beantragt', vieraugen: true, person: { name: 'Ines Kaltenbach' } });
  });
  it('bestätigt: Ergebnis der antragstellenden Person, daneben wer bestätigt hat; Anstöße am Ziel stehen mit Antwort', async () => {
    setSelbstauskunft(rechteSeed('JW').me);
    Object.assign(api, energiezielBuehne('beantragt', true, 'JW', 'Jonas Wendlinger'));
    const ez = await api.energiezielBewertung(EZ_IDS.ez1, 'freigeben', {});
    Object.assign(api, {
      energieziel: async () => ({
        ...ez,
        anstoesse: [{ id: 'a1', art: 'messgrundlage_neu_gefasst' as const, anlass_kennung: 'BB-0001/3', angestossen_am: '2028-11-02T08:00:00+01:00', zustand: 'offen' as const, antwort: null, antwort_begruendung: null, beantwortet_am: null, beantwortet_von: null }],
      }),
    });
    render(<EnergiezielSeite id={EZ_IDS.ez1} onListe={() => undefined} />);
    expect((await screen.findByTestId('energieziel-bewertet')).textContent).toBe('Ines Kaltenbach · 15.01.2029 · ohne Vorschlag, weil März 2028 nicht bewertbar war');
    expect(screen.getByTestId('energieziel-bestaetigt').textContent).toBe('Bestätigt von Jonas Wendlinger am 15.01.2029.');
    expect(screen.getByTestId('energieziel-anstoesse').textContent).toContain('Bezugsbasis neu gefasst · BB-0001/3 · 02.11.2028 · offen');
  });
  it('bewertet: Ergebnis, Begründung und Prüfsumme; kein Knopf mehr', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(api, energiezielBuehne('bewertet'));
    render(<EnergiezielSeite id={EZ_IDS.ez1} onListe={() => undefined} />);
    expect((await screen.findByTestId('energieziel-bewertet')).textContent).toBe('Ines Kaltenbach · 15.01.2029 · ohne Vorschlag, weil März 2028 nicht bewertbar war');
    expect(screen.getByText(/^Prüfsumme sha256:/)).toBeTruthy();
    expect(screen.queryByTestId('energieziel-bewerten')).toBeNull();
    expect(screen.queryByTestId('energieziel-beenden')).toBeNull();
  });
});

describe('„Energieziel setzen“ an der Kennzahl (§5.1)', () => {
  const k = kz4();
  it('nur bei freigegebener Bezugsbasis und mit `verbesserung.verwalten`; der Dialog zeigt die Basis-Zeile und die Vorgabe', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    render(<EnergiezielSetzen kennzahl={k} lage={{ art: 'da', basis: bb1('freigegeben'), fassung: bb1Fassung('freigegeben') }} />);
    fireEvent.click(screen.getByTestId('energieziel-setzen-knopf'));
    const dialog = await screen.findByTestId('energieziel-setzen');
    expect(within(dialog).getByTestId('energieziel-basis-zeile').textContent).toContain('Bezugsbasis BB-0001');
    expect(within(dialog).getByText(UEMS_NORMGRENZE)).toBeTruthy();
    const senden = vi.spyOn(api, 'energiezielAnlegen');
    await act(async () => fireEvent.click(screen.getByTestId('energieziel-setzen-senden')));
    expect(senden).not.toHaveBeenCalled();
    cleanup();

    render(<EnergiezielSetzen kennzahl={k} lage={{ art: 'da', basis: bb1(null), fassung: bb1Fassung('entwurf') }} />);
    expect(screen.queryByTestId('energieziel-setzen-knopf')).toBeNull();
    cleanup();
    render(<EnergiezielSetzen kennzahl={k} lage={{ art: 'keine' }} />);
    expect(screen.queryByTestId('energieziel-setzen-einstieg')).toBeNull();
    cleanup();

    setSelbstauskunft(rechteSeed('CB').me);
    render(<EnergiezielSetzen kennzahl={k} lage={{ art: 'da', basis: bb1('freigegeben'), fassung: bb1Fassung('freigegeben') }} />);
    expect(screen.queryByTestId('energieziel-setzen-knopf')).toBeNull();
  });
});
