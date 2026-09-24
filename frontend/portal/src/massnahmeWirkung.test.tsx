import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { benutzerApi } from './benutzer';
import { UEMS_VERBESSERUNG_SAETZE } from './glossar';
import * as W from './massnahmeWirkung';
import { MassnahmeSeite } from './pages/MassnahmeSeite';
import { setSelbstauskunft } from './rollen';
import { bezugsbasisBuehne } from './test/bezugsbasisFixtures';
import { energiezielBuehne } from './test/energiezielFixtures';
import {
  ANSTOSS_R12,
  BEGRUENDUNG_R12,
  kontenAhrenberg,
  m1Umgesetzt,
  M_IDS,
  massnahmeBuehne,
  SATZ_BELEGT_R6,
  SATZ_JANUAR_R6,
  SATZ_MAERZ_R5,
  SATZ_WIRKUNG_R5,
  wirkungR5,
} from './test/massnahmeFixtures';
import { rechteSeed } from './test/rollenFixtures';

/**
 * UEMS AP-18 IP-20 (§5.5–§5.7, WK1–WK6, M4, M5): Abschnitt „Wirkung“, Spalte „Bewertung“ und Anstöße an der
 * Maßnahmen-Seite gegen R5, R6, R7, R12. Das reine Bild rechnet nichts: Monate, „x von 12“, Σ ÷ Σ, Urteil und Sätze
 * kommen aus der Route; ohne Stand steht „beobachtet — nicht belegt“; ohne Messgrundlage nur „nicht messbar“.
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

describe('Das reine Bild der Wirkung (WK1–WK5)', () => {
  it('Zeilen: Umsetzungsmonat und März mit dem Satz des Lesers, gezählte Monate mit Urteil, Band und roher Kennzahl', () => {
    const z = W.wirkungZeilen(wirkungR5(m1Umgesetzt()));
    expect(z).toHaveLength(13);
    expect(z[0]).toMatchObject({ art: 'nicht_gezaehlt', satz: SATZ_JANUAR_R6 });
    expect(z[1]).toMatchObject({ art: 'gezaehlt', gemessen: '81 500 kWh', erwartet: '81 985 kWh', delta: '0,6 % weniger', urteil: 'im Rahmen', band: '± 2 %', roh: '0,2672', version: 1 });
    expect(z[2]).toMatchObject({ art: 'nicht_gezaehlt', satz: SATZ_MAERZ_R5 });
    expect(z[6]).toMatchObject({ art: 'gezaehlt', urteil: 'schlechter', delta: '2,5 % mehr' });
    expect(z[10]).toMatchObject({ art: 'offen' });
    expect(W.wirkungSumme(wirkungR5(m1Umgesetzt()))).toMatchObject({ gemessen: '647 000 kWh', erwartet: '663 139 kWh', delta: '2,4 % weniger', urteil: 'besser', monate: '8 von 12 Monaten' });
    expect(W.vorlaeufigText({ vorlaeufig: true, monate_text: '8 von 12' })).toBe('vorläufig (8 von 12 Monaten)');
    expect(W.vorlaeufigText({ vorlaeufig: false, monate_text: '11 von 12' })).toBeNull();
  });

  it('Bewertung: ohne Messgrundlage nur „nicht messbar“; Prüfsumme kurz wie die Route; Antworten je Art', () => {
    expect(W.ergebnisOptionen({ messgrundlage: null }).map((o) => o.value)).toEqual(['nicht_messbar']);
    expect(W.ergebnisOptionen(m1Umgesetzt()).map((o) => o.label)).toEqual(['belegt', 'nicht belegt', 'nicht messbar']);
    expect(W.pruefsummeKurz('sha256:4635f20a')).toBe('4635…');
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

describe('Maßnahmen-Seite: Wirkung, Bewertung, Anstoß (R5, R6, R7, R12)', () => {
  it('R5: der Satz der Route, die Summenzeile „8 von 12“ und ohne Stand „beobachtet — nicht belegt“', async () => {
    render(<MassnahmeSeite id={M_IDS.m1} onListe={() => undefined} />);
    expect(await screen.findByTestId('massnahme-wirkung-satz')).toHaveTextContent(SATZ_WIRKUNG_R5);
    expect(screen.getByTestId('massnahme-wirkung-summe')).toHaveTextContent('8 von 12 Monaten');
    expect(screen.getByTestId('massnahme-beobachtet')).toHaveTextContent('Beobachtet — nicht belegt.');
    expect(screen.queryByTestId('massnahme-stand')).toBeNull();
  });

  it('R6: „belegt“ mit Begründung → Stand Nr. 1 mit dem Satz der Route', async () => {
    buehne('r6');
    render(<MassnahmeSeite id={M_IDS.m1} onListe={() => undefined} />);
    const stand = await screen.findByTestId('massnahme-stand');
    expect(stand).toHaveTextContent(SATZ_BELEGT_R6);
    expect(stand).toHaveTextContent('Stand Nr. 1 · Prüfsumme sha256:4635');
    expect(screen.queryByTestId('massnahme-beobachtet')).toBeNull();
  });

  it('R7: ohne Messgrundlage keine Tabelle, nur der Satz; bewerten bietet nur „nicht messbar“', async () => {
    render(<MassnahmeSeite id={M_IDS.m2} onListe={() => undefined} />);
    expect(await screen.findByTestId('massnahme-wirkung-satz')).toHaveTextContent('ohne Messgrundlage — Wirkung nicht messbar');
    expect(screen.queryByTestId('massnahme-wirkung-monate')).toBeNull();
    fireEvent.click(screen.getByTestId('massnahme-bewerten'));
    expect(await screen.findByTestId('massnahme-bewerten-hinweis')).toHaveTextContent(W.NUR_NICHT_MESSBAR);
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
});
