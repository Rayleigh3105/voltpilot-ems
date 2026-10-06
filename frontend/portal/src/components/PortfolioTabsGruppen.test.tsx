import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ebenenAktiv, telefonReiterBereiche, UNTERNEHMEN_GRUPPEN, type EbenenLeistenKachel } from '../ebenenNav';
import { flaecheMelden, organisationVergessen } from '../messstellenOrganisation';
import { energiemanagementRoute, pageRoute, verbesserungRoute, type EnergiemanagementReiter, type PageId, type VerbesserungReiter } from '../nav';
import { PortfolioTabs } from './PortfolioTabs';

/**
 * Konzept „Navigation aus einem Guss“ (N1/N4/N5, R3/R4): die Gruppen des Unternehmens stehen in der Seitenleiste und in
 * der Telefon-Leiste — über der Seite steht HÖCHSTENS EINE Reihe, die Reiter der offenen Gruppe. „Messen“ trägt
 * Kostenstellen und Prozesse, „Verbessern“ die Reiter von „Ziele und Maßnahmen“, „Nachweisen“ die Reiter des
 * Energiemanagements; die Wiedervorlage steht in der Übersicht. Eine Detailseite zeigt ihren Rückweg statt der Reihe.
 * Adressen bleiben.
 */
const ZIEL: Record<string, PageId> = {
  uebersicht: 'portfolio',
  messen: 'portfolio-messstellen',
  auswerten: 'portfolio-kennzahlen',
  verbessern: 'portfolio-verbesserung',
  nachweisen: 'portfolio-energiemanagement',
};
const GRUPPEN: EbenenLeistenKachel[] = UNTERNEHMEN_GRUPPEN.map((g) => ({ ...g, ziel: pageRoute(ZIEL[g.key]) }));

function zeige(
  page: PageId,
  reiter: EnergiemanagementReiter | null = null,
  o: { gruppen?: EbenenLeistenKachel[]; verbesserungReiter?: VerbesserungReiter | null; detail?: boolean } = {},
) {
  const gruppen = o.gruppen ?? GRUPPEN;
  const onOpenBereich = vi.fn();
  const onNavigate = vi.fn();
  render(
    <PortfolioTabs
      page={page}
      showErloese={false}
      showMessstellen
      showBezugsgroessen
      showKennzahlen
      showBerichte
      showBewertung
      showVerbesserung
      showEnergiemanagement
      leiste={gruppen.flatMap((g) => g.bereiche)}
      telefonReiter={gruppen.length > 0 ? telefonReiterBereiche(gruppen, ebenenAktiv(page, undefined, reiter ?? undefined)) : null}
      fleetLabel="Kunststoffwerk Ahrenberg GmbH"
      onNavigate={onNavigate}
      onOpenBereich={onOpenBereich}
      gruppen={gruppen}
      energiemanagementReiter={reiter}
      verbesserungReiter={o.verbesserungReiter ?? null}
      detail={o.detail ?? false}
    />,
  );
  return { onOpenBereich, onNavigate };
}

const reihe = (name: string) =>
  within(screen.getByRole('tablist', { name })).getAllByRole('tab').map((t) => [t.textContent, t.getAttribute('aria-selected')]);

beforeEach(() => {
  organisationVergessen();
  vi.spyOn(api, 'kostenstellen').mockResolvedValue({ kostenstellen: [] } as never);
  vi.spyOn(api, 'prozesse').mockResolvedValue({ prozesse: [] } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('N1 · über der Seite nur die Reiter der offenen Gruppe', () => {
  it('keine Gruppenreihe und keine Fragezeile über der Seite — nur die Reiter von „Auswerten“', () => {
    zeige('portfolio-kennzahlen');
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    expect(screen.queryByRole('tablist', { name: /Gruppen der Ebene/ })).toBeNull();
    expect(screen.queryByText('Wo geht die Energie hin, wird es besser?')).toBeNull();
    expect(reihe('Reiter der Gruppe Auswerten')).toEqual([
      ['Kennzahlen', 'true'],
      ['Bewertung', 'false'],
    ]);
  });

  it('„Nachweisen“: der Überblick zuerst, dann die Berichte und die übrigen Reiter des Energiemanagements - eine Reihe (Nachweisen n1 §6.2)', () => {
    const { onOpenBereich } = zeige('portfolio-energiemanagement', 'dokumente');
    expect(reihe('Reiter der Gruppe Nachweisen')).toEqual([
      ['Überblick', 'false'],
      ['Berichte', 'false'],
      ['Dokumente', 'true'],
      ['Audits', 'false'],
      ['Feststellungen', 'false'],
      ['Managementbewertung', 'false'],
      ['Aufgaben', 'false'],
    ]);
    expect(screen.queryByRole('tab', { name: 'Energiemanagement' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Wiedervorlage' })).toBeNull();
    fireEvent.click(screen.getByTestId('energiemanagement-reiter-audits'));
    expect(onOpenBereich).toHaveBeenCalledWith(energiemanagementRoute('audits'));
  });

  it('„Wer ist wofür verantwortlich“ gehört zu den Aufgaben', () => {
    zeige('portfolio-energiemanagement', 'verantwortung');
    expect(screen.getByTestId('energiemanagement-reiter-aufgaben').getAttribute('aria-selected')).toBe('true');
  });

  it('das Verzeichnis und die Zuschnitt-Hilfe liegen eine Ebene unter dem Überblick (Entscheid 2)', () => {
    for (const reiter of ['verzeichnis', 'zuschnitt', null] as const) {
      cleanup();
      zeige('portfolio-energiemanagement', reiter);
      expect(screen.getByTestId('energiemanagement-reiter-ueberblick').getAttribute('aria-selected')).toBe('true');
      expect(screen.queryByRole('tab', { name: 'Verzeichnis' })).toBeNull();
    }
  });

  it('die Wiedervorlage steht in der Übersicht — ihre Adresse bleibt', () => {
    const { onOpenBereich } = zeige('portfolio-energiemanagement', 'wiedervorlage');
    expect(reihe('Reiter der Gruppe Übersicht')).toEqual([
      ['Übersicht', 'false'],
      ['Standorte', 'false'],
      ['Energie', 'false'],
      ['Wiedervorlage', 'true'],
    ]);
    fireEvent.click(screen.getByTestId('energiemanagement-reiter-wiedervorlage'));
    expect(onOpenBereich).toHaveBeenCalledWith(energiemanagementRoute('wiedervorlage'));
  });

  it('„Verbessern“ trägt die Reiter von „Ziele und Maßnahmen“ — an derselben Stelle wie jede Reihe', () => {
    const { onOpenBereich } = zeige('portfolio-verbesserung', null, { verbesserungReiter: 'massnahmen' });
    expect(reihe('Reiter der Gruppe Verbessern')).toEqual([
      ['Energieziele', 'false'],
      ['Maßnahmen', 'true'],
      ['Abweichungen', 'false'],
    ]);
    fireEvent.click(screen.getByTestId('verbesserung-reiter-abweichungen'));
    expect(onOpenBereich).toHaveBeenCalledWith(verbesserungRoute('abweichungen'));
  });

  it('R4 · eine Detailseite zeigt ihren Rückweg statt der Reihe', () => {
    zeige('portfolio-kennzahlen', null, { detail: true });
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('ohne Gruppen (und ohne Leiste) bleibt die flache Reihe', () => {
    zeige('portfolio-kennzahlen', null, { gruppen: [] });
    expect(screen.getByRole('tab', { name: 'Energiemanagement' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Kennzahlen' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('N5 · Kostenstellen und Prozesse in der Reihe von „Messen“', () => {
  it('mit Kostenstellen und Prozessen: Messstellen · Kostenstellen · Prozesse · Bezugsgrößen — der Reiter der Adresse leuchtet', async () => {
    vi.spyOn(api, 'kostenstellen').mockResolvedValue({ kostenstellen: [{}] } as never);
    vi.spyOn(api, 'prozesse').mockResolvedValue({ prozesse: [{}] } as never);
    window.location.hash = '#/portfolio/messstellen?reiter=kostenstellen&periode=monat&am=2026-10-01';
    zeige('portfolio-messstellen');
    await screen.findByTestId('messstellen-reiter-prozesse');
    expect(reihe('Reiter der Gruppe Messen')).toEqual([
      ['Messstellen', 'false'],
      ['Kostenstellen', 'true'],
      ['Prozesse', 'false'],
      ['Bezugsgrößen', 'false'],
    ]);
    // Ohne gemeldete Fläche ändert ein Wechsel die Adresse und nimmt den Zeitraum mit.
    act(() => fireEvent.click(screen.getByTestId('messstellen-reiter-prozesse')));
    expect(window.location.hash).toBe('#/portfolio/messstellen?reiter=prozesse&periode=monat&am=2026-10-01');
  });

  it('auf der Fläche zeigt die Reihe deren offenen Reiter und wählt über sie — wie früher ihre eigene Reihe', async () => {
    vi.spyOn(api, 'kostenstellen').mockResolvedValue({ kostenstellen: [{}] } as never);
    vi.spyOn(api, 'prozesse').mockResolvedValue({ prozesse: [{}] } as never);
    window.location.hash = '#/portfolio/messstellen';
    const waehlen = vi.fn();
    let abmelden = () => {};
    act(() => {
      abmelden = flaecheMelden({ offen: 'prozesse', waehlen });
    });
    zeige('portfolio-messstellen');
    await screen.findByTestId('messstellen-reiter-prozesse');
    expect(reihe('Reiter der Gruppe Messen')).toEqual([
      ['Messstellen', 'false'],
      ['Kostenstellen', 'false'],
      ['Prozesse', 'true'],
      ['Bezugsgrößen', 'false'],
    ]);
    // Die Fläche wählt mit ihrem Zeitraum und ersetzt die Adresse — die Reihe selbst legt keinen Eintrag an.
    fireEvent.click(screen.getByTestId('messstellen-reiter-kostenstellen'));
    expect(waehlen).toHaveBeenCalledWith('kostenstellen');
    expect(window.location.hash).toBe('#/portfolio/messstellen');
    act(() => abmelden());
  });

  it('ohne Kostenstelle und ohne Prozess: Messstellen · Bezugsgrößen wie bisher', async () => {
    zeige('portfolio-bezugsgroessen');
    await act(async () => {
      await Promise.resolve();
    });
    expect(reihe('Reiter der Gruppe Messen')).toEqual([
      ['Messstellen', 'false'],
      ['Bezugsgrößen', 'true'],
    ]);
  });
});
