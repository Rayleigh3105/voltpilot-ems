import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { benutzerApi } from './benutzer';
import { fazit, nachherMonate } from './components/WirkungsGrafik';
import { standKopie } from './components/MassnahmeWirkung';
import { UEMS_VERBESSERUNG_SAETZE } from './glossar';
import * as W from './massnahmeWirkung';
import { MassnahmeSeite } from './pages/MassnahmeSeite';
import { setSelbstauskunft } from './rollen';
import { bezugsbasisBuehne } from './test/bezugsbasisFixtures';
import { energiezielBuehne } from './test/energiezielFixtures';
import {
  ANSTOSS_R12,
  BEGRUENDUNG_R12,
  BEGRUENDUNG_R6,
  kontenAhrenberg,
  m1Umgesetzt,
  M_IDS,
  massnahmeBuehne,
  SATZ_MAERZ_R5,
  SATZ_WIRKUNG_R5,
  wirkungR5,
} from './test/massnahmeFixtures';
import { rechteSeed } from './test/rollenFixtures';

/**
 * UEMS AP-18 IP-20 (§5.5–§5.7, WK1–WK6, M4, M5) im Bild des Verbessern-Konzepts v1 (§6.6): Wirkung als Kacheln und
 * Grafik, „Kommt der Unterschied von der Maßnahme?“ und die Anstöße an der Maßnahmen-Seite gegen R5, R6, R7, R12. Das
 * Bild rechnet nichts: Monate, „x von 12“, Σ ÷ Σ, Urteil und Sätze kommen aus der Route; ohne Stand steht „beobachtet —
 * nicht belegt“; ohne Messung schließt eine Person mit einem Satz ab (Entscheid 6).
 */
function buehne(lage: 'r5' | 'r6' | 'r12' | 'antrag', vieraugen = false) {
  Object.assign(api, bezugsbasisBuehne('modell'), energiezielBuehne('juli'), massnahmeBuehne(lage, '2028-11-15', 'Ines Kaltenbach', { vieraugen }));
}
beforeEach(() => {
  setSelbstauskunft(rechteSeed('IK').me);
  Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
  buehne('r5');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Das Bild der Wirkung (WK1–WK5)', () => {
  it('die Grafik beginnt im Monat nach der Umsetzung; das Fazit zählt Urteile, gerechnet wird nichts', () => {
    const w = wirkungR5(m1Umgesetzt());
    const monate = nachherMonate(w);
    expect(monate[0].periode).toBe('2028-02');
    expect(monate).toHaveLength(12);
    expect(fazit(monate)).toEqual({ kopf: '6 von 8 Monaten', rest: ' lagen unter der Erwartung, 1 im Rahmen, 1 darüber.' });
    expect(fazit(monate.filter((m) => !m.gezaehlt))).toBeNull();
  });
  it('der festgehaltene Stand nennt Monate und Zahl von damals — aus der Kopie, nie aus dem Live-Stand', () => {
    const kopie = JSON.stringify({ nachher: '2028-02/2029-01', wirkung: { delta_prozent: '-2.4', monate_bewertbar: 8 } });
    expect(standKopie({ kopie })).toEqual({ monate: '8 von 12', prozent: '2,4 % weniger' });
    expect(standKopie({ kopie: null })).toBeNull();
    expect(standKopie({ kopie: '{kaputt' })).toBeNull();
  });
  it('Bewertung: ohne Messgrundlage nur „nicht messbar“; Antworten je Art', () => {
    expect(W.ergebnisOptionen({ messgrundlage: null }).map((o) => o.value)).toEqual(['nicht_messbar']);
    expect(W.ergebnisOptionen(m1Umgesetzt()).map((o) => o.label)).toEqual(['belegt', 'nicht belegt', 'nicht messbar']);
    expect(W.bewertungOffenSatz()).toBe(UEMS_VERBESSERUNG_SAETZE.bewertungOffen());
    expect(W.antworten('massnahme', 'ausgangslage_korrigiert')).toEqual(['bleibt', 'neu_kopiert']);
    expect(W.antworten('massnahme', 'bewertung_korrigiert')).toEqual(['bleibt', 'neu_bewertet']);
    expect(W.antworten('energieziel', 'bewertung_korrigiert')).toEqual(['bleibt']);
    expect(W.antworten('energieziel', 'messgrundlage_beendet')).toEqual(['bleibt', 'neu_bewertet']);
  });
  it('kein Wort des Moduls sagt, die Maßnahme habe gewirkt, oder nennt eine Ursache (WK5)', () => {
    const texte = Object.values(W).filter((v): v is string => typeof v === 'string');
    expect(texte.filter((t) => /gewirkt|Einsparung durch|Ursache/.test(t))).toEqual([]);
  });
});

describe('Maßnahmen-Seite: Wirkung, Urteil, Anstoß (R5, R6, R7, R12)', () => {
  it('R5: der Satz der Route unter der Grafik, das Fazit mit dem Grund des März und ohne Stand „beobachtet — nicht belegt“', async () => {
    render(<MassnahmeSeite id={M_IDS.m1} onListe={() => undefined} />);
    expect(await screen.findByTestId('massnahme-wirkung-satz')).toHaveTextContent(SATZ_WIRKUNG_R5);
    const fazitText = screen.getByTestId('massnahme-wirkung-fazit').textContent;
    expect(fazitText).toContain('6 von 8 Monaten lagen unter der Erwartung, 1 im Rahmen, 1 darüber.');
    expect(fazitText).toContain(SATZ_MAERZ_R5);
    expect(screen.getByTestId('massnahme-beobachtet')).toHaveTextContent('Beobachtet — nicht belegt.');
    expect(screen.queryByTestId('massnahme-stand')).toBeNull();
    // Die Infozeile zeigt den letzten gezählten Monat; ein laufender Monat nennt seinen Grund (Befund 1).
    expect(screen.getByTestId('massnahme-wirkung-info').textContent).toContain('Oktober 2028');
    fireEvent.click(screen.getByTestId('wirkung-monat-2028-03'));
    expect(screen.getByTestId('massnahme-wirkung-info').textContent).toContain('Produktionsmenge Spritzguss 390 000 kg außerhalb der Bezugsbasis');
    // Dieselben Werte als Liste, mit der rohen Kennzahl ohne Wort (WK5).
    expect(within(screen.getByTestId('massnahme-wirkung-monate')).getByTestId('wirkung-2028-02').textContent).toContain('im Rahmen');
  });

  it('R6: „belegt“ mit Begründung, Person und Datum als Zitat; „Alle Stände“ aufklappbar', async () => {
    buehne('r6');
    render(<MassnahmeSeite id={M_IDS.m1} onListe={() => undefined} />);
    const stand = await screen.findByTestId('massnahme-stand');
    expect(stand.textContent).toContain(`‚${BEGRUENDUNG_R6}‘`);
    expect(stand.textContent).toContain('Ines Kaltenbach · 15.11.2028');
    expect(within(screen.getByTestId('massnahme-bewertung')).getByTestId('massnahme-marke').textContent).toBe('belegt');
    expect(screen.queryByTestId('massnahme-beobachtet')).toBeNull();
    expect(screen.getByTestId('massnahme-staende')).toBeTruthy();
  });

  it('„Wirkung prüfen“: die beobachtete Zahl oben, Antwort-Karten, ein Satz — Stand Nr. 1 an der Route', async () => {
    const bewerten = vi.spyOn(api, 'massnahmeBewertung');
    render(<MassnahmeSeite id={M_IDS.m1} onListe={() => undefined} />);
    fireEvent.click(await screen.findByTestId('massnahme-bewerten'));
    const blatt = await screen.findByTestId('massnahme-bewerten-dialog');
    expect(within(blatt).getByTestId('massnahme-bewerten-beobachtet').textContent?.replace(/ /g, ' ')).toContain(
      '2,4 % weniger als erwartet · 8 von 12 Monaten · erwartet waren 3 %',
    );
    expect(blatt.textContent).toContain('Wird als Stand Nr. 1 festgehalten.');
    await act(async () => fireEvent.submit(blatt));
    expect(bewerten).not.toHaveBeenCalled();
    fireEvent.click(within(blatt).getByTestId('massnahme-bewerten-wahl-belegt').querySelector('input')!);
    fireEvent.change(within(blatt).getByTestId('massnahme-bewerten-text'), { target: { value: BEGRUENDUNG_R6 } });
    await act(async () => fireEvent.submit(blatt));
    expect(bewerten).toHaveBeenCalledWith(M_IDS.m1, 'bewerten', { ergebnis: 'belegt', begruendung: BEGRUENDUNG_R6 });
    expect(await screen.findByTestId('massnahme-stand')).toBeTruthy();
  });

  it('R7 / Entscheid 6: ohne Messung keine Grafik — „Abschließen“ mit einem Satz, als Ergebnis „nicht messbar“', async () => {
    const bewerten = vi.spyOn(api, 'massnahmeBewertung');
    render(<MassnahmeSeite id={M_IDS.m2} onListe={() => undefined} />);
    const knopf = await screen.findByTestId('massnahme-bewerten');
    expect(knopf.textContent).toBe('Abschließen');
    expect(screen.queryByTestId('massnahme-wirkung')).toBeNull();
    expect(screen.queryByTestId('massnahme-kacheln')).toBeNull();
    fireEvent.click(knopf);
    const blatt = await screen.findByTestId('massnahme-bewerten-dialog');
    expect(within(blatt).queryByTestId('massnahme-bewerten-wahl')).toBeNull();
    fireEvent.change(within(blatt).getByTestId('massnahme-bewerten-text'), { target: { value: 'Die Leckagen sind behoben und bleiben klein.' } });
    await act(async () => fireEvent.submit(blatt));
    expect(bewerten).toHaveBeenCalledWith(M_IDS.m2, 'bewerten', { ergebnis: 'nicht_messbar', begruendung: 'Die Leckagen sind behoben und bleiben klein.' });
  });

  it('Vier-Augen: „Wirkung prüfen“ wird ein Antrag; die Seite nennt, dass eine zweite Person bestätigt', async () => {
    buehne('r5', true);
    const bewerten = vi.spyOn(api, 'massnahmeBewertung');
    render(<MassnahmeSeite id={M_IDS.m1} onListe={() => undefined} />);
    fireEvent.click(await screen.findByTestId('massnahme-bewerten'));
    const blatt = await screen.findByTestId('massnahme-bewerten-dialog');
    fireEvent.click(within(blatt).getByTestId('massnahme-bewerten-wahl-belegt').querySelector('input')!);
    fireEvent.change(within(blatt).getByTestId('massnahme-bewerten-text'), { target: { value: BEGRUENDUNG_R6 } });
    await act(async () => fireEvent.submit(blatt));
    await waitFor(() => expect(bewerten).toHaveBeenCalledWith(M_IDS.m1, 'beantragen', { ergebnis: 'belegt', begruendung: BEGRUENDUNG_R6 }));
    expect((await screen.findByTestId('massnahme-antrag')).textContent).toContain('Bestätigen oder ablehnen kann eine zweite Person.');
    expect(screen.queryByTestId('massnahme-freigeben')).toBeNull();
  });

  it('R12: „beibehalten“ verlangt eine Begründung und geht an die Antwort-Route; die Kopie bleibt', async () => {
    buehne('r12');
    const antwort = vi.spyOn(api, 'massnahmeAnstossAntwort');
    render(<MassnahmeSeite id={M_IDS.m1} onListe={() => undefined} />);
    const anstoss = await screen.findByTestId('anstoss-ausgangslage_korrigiert');
    const pruefsumme = screen.getByTestId('massnahme-pruefsumme').textContent;
    fireEvent.click(within(anstoss).getByTestId('anstoss-bleibt'));
    fireEvent.click(within(anstoss).getByTestId('anstoss-beibehalten-senden'));
    expect(antwort).not.toHaveBeenCalled();
    fireEvent.change(within(anstoss).getByLabelText('Begründung'), { target: { value: BEGRUENDUNG_R12 } });
    fireEvent.click(within(anstoss).getByTestId('anstoss-beibehalten-senden'));
    await waitFor(() => expect(antwort).toHaveBeenCalledWith(M_IDS.m1, ANSTOSS_R12.id, { antwort: 'bleibt', begruendung: BEGRUENDUNG_R12 }));
    await waitFor(() => expect(screen.getByTestId('anstoss-ausgangslage_korrigiert')).toHaveAttribute('data-zustand', 'beantwortet'));
    expect(screen.getByTestId('anstoss-ausgangslage_korrigiert')).toHaveTextContent(`‚${BEGRUENDUNG_R12}‘`);
    expect(screen.getByTestId('massnahme-pruefsumme').textContent).toBe(pruefsumme);
  });

  it('die Wirkung lädt nicht: der Satz mit „Erneut versuchen“, danach die Grafik', async () => {
    const echt = api.massnahmeWirkung;
    const lesen = vi.spyOn(api, 'massnahmeWirkung').mockRejectedValueOnce(new Error('offline')).mockImplementation(echt);
    render(<MassnahmeSeite id={M_IDS.m1} onListe={() => undefined} />);
    const fehler = await screen.findByRole('alert');
    expect(fehler.textContent).toContain(W.WIRKUNG_LADEFEHLER);
    fireEvent.click(within(fehler).getByText('Erneut versuchen'));
    await waitFor(() => expect(lesen).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('massnahme-wirkung-grafik')).toBeTruthy();
  });
});
