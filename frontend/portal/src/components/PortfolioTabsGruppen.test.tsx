import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ebenenAktiv, telefonReiterBereiche, UNTERNEHMEN_GRUPPEN, type EbenenLeistenKachel } from '../ebenenNav';
import { energiemanagementRoute, pageRoute, type EnergiemanagementReiter, type PageId } from '../nav';
import { PortfolioTabs } from './PortfolioTabs';

/**
 * K1 (Konzept „Energiemanagement ohne Fachsprache“, D1/D2): am Unternehmen stehen die Gruppen auch am Rechner über der
 * Seite, darunter ihre Frage und nur die Reiter der offenen Gruppe; „Nachweisen“ trägt die Reiter des
 * Energiemanagements, die Wiedervorlage steht in der Übersicht. Adressen bleiben.
 */
const ZIEL: Record<string, PageId> = {
  uebersicht: 'portfolio',
  messen: 'portfolio-messstellen',
  auswerten: 'portfolio-kennzahlen',
  verbessern: 'portfolio-verbesserung',
  nachweisen: 'portfolio-energiemanagement',
};
const GRUPPEN: EbenenLeistenKachel[] = UNTERNEHMEN_GRUPPEN.map((g) => ({ ...g, ziel: pageRoute(ZIEL[g.key]) }));

function zeige(page: PageId, reiter: EnergiemanagementReiter | null = null, gruppen = GRUPPEN) {
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
      leiste={GRUPPEN.flatMap((g) => g.bereiche)}
      telefonReiter={telefonReiterBereiche(GRUPPEN, ebenenAktiv(page, undefined, reiter ?? undefined))}
      fleetLabel="Kunststoffwerk Ahrenberg GmbH"
      onNavigate={onNavigate}
      onOpenBereich={onOpenBereich}
      gruppen={gruppen}
      energiemanagementReiter={reiter}
    />,
  );
  return { onOpenBereich, onNavigate };
}

const reihe = (name: string) =>
  within(screen.getByRole('tablist', { name })).getAllByRole('tab').map((t) => [t.textContent, t.getAttribute('aria-selected')]);

describe('K1 · Gruppen am Rechner wie am Telefon', () => {
  it('fünf Gruppen oben, die Frage der offenen Gruppe und nur ihre Reiter', () => {
    zeige('portfolio-kennzahlen');
    expect(reihe('Gruppen der Ebene Kunststoffwerk Ahrenberg GmbH')).toEqual([
      ['Übersicht', 'false'],
      ['Messen', 'false'],
      ['Auswerten', 'true'],
      ['Verbessern', 'false'],
      ['Nachweisen', 'false'],
    ]);
    expect(screen.getByTestId('gruppen-frage').textContent).toBe('Wo geht die Energie hin, wird es besser?');
    expect(reihe('Reiter der Gruppe Auswerten')).toEqual([
      ['Kennzahlen', 'true'],
      ['Bewertung', 'false'],
    ]);
    // Die Gruppen-Reihe und die Frage stehen nur am Rechner — am Telefon trägt die Leiste die Gruppen.
    expect(screen.getByRole('tablist', { name: 'Gruppen der Ebene Kunststoffwerk Ahrenberg GmbH' }).className).toContain('vp-nur-rechner');
    expect(screen.getByTestId('gruppen-frage').className).toContain('vp-nur-rechner');
  });

  it('„Nachweisen“: das Verzeichnis zuerst, dann die Berichte und die übrigen Reiter des Energiemanagements — ohne zweite Reihe', () => {
    const { onOpenBereich } = zeige('portfolio-energiemanagement', 'dokumente');
    expect(reihe('Reiter der Gruppe Nachweisen')).toEqual([
      ['Verzeichnis', 'false'],
      ['Berichte', 'false'],
      ['Dokumente', 'true'],
      ['Aufgaben', 'false'],
      ['Audits', 'false'],
      ['Feststellungen', 'false'],
      ['Managementbewertung', 'false'],
    ]);
    expect(screen.queryByRole('tab', { name: 'Energiemanagement' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Wiedervorlage' })).toBeNull();
    fireEvent.click(screen.getByTestId('energiemanagement-reiter-audits'));
    expect(onOpenBereich).toHaveBeenCalledWith(energiemanagementRoute('audits'));
    fireEvent.click(screen.getByTestId('gruppe-verbessern'));
    expect(onOpenBereich).toHaveBeenLastCalledWith(pageRoute('portfolio-verbesserung'));
  });

  it('Detailseiten markieren ihren Reiter; „Wer ist wofür verantwortlich“ gehört zu den Aufgaben', () => {
    zeige('portfolio-energiemanagement', 'verantwortung');
    expect(screen.getByTestId('energiemanagement-reiter-aufgaben').getAttribute('aria-selected')).toBe('true');
  });

  it('die Wiedervorlage steht in der Übersicht — ihre Adresse bleibt', () => {
    const { onOpenBereich } = zeige('portfolio-energiemanagement', 'wiedervorlage');
    expect(screen.getByTestId('gruppe-uebersicht').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('gruppen-frage').textContent).toBe('Läuft alles? Was steht an?');
    expect(reihe('Reiter der Gruppe Übersicht')).toEqual([
      ['Übersicht', 'false'],
      ['Standorte', 'false'],
      ['Energie', 'false'],
      ['Wiedervorlage', 'true'],
    ]);
    fireEvent.click(screen.getByTestId('energiemanagement-reiter-wiedervorlage'));
    expect(onOpenBereich).toHaveBeenCalledWith(energiemanagementRoute('wiedervorlage'));
  });

  it('eine Gruppe mit nur einem Reiter zeigt keine zweite Reihe — die Frage bleibt', () => {
    zeige('portfolio-verbesserung');
    expect(screen.queryByRole('tablist', { name: 'Reiter der Gruppe Verbessern' })).toBeNull();
    expect(screen.getByTestId('gruppen-frage').textContent).toBe('Was tun wir dagegen?');
  });

  it('ohne Gruppen bleibt die flache Reihe von vorher', () => {
    zeige('portfolio-kennzahlen', null, []);
    expect(screen.queryByTestId('gruppen-navigation')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Energiemanagement' })).toBeTruthy();
  });
});
