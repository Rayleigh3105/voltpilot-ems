import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { SiteEarnings } from '../api';
import { KERNSATZ, soVerdient } from '../soVerdient';
import { SoVerdientCard } from './SoVerdient';

/**
 * Der DÜNNE Renderer über `soVerdient()` — die Zustands-Vollständigkeit liegt
 * in `soVerdient.test.ts`; hier wird geprüft, dass jeder Zustand die richtige
 * FORM auf den Schirm bringt und dass der Captain-Override (S4) auch sichtbar
 * ein anderes Kleid trägt.
 */
function anlage(over: Partial<SiteEarnings> = {}): SiteEarnings {
  return {
    siteId: 's1',
    name: 'Solarpark Dachau',
    range: 'month',
    from: '2026-07-31T22:00:00Z',
    to: '2026-08-31T22:00:00Z',
    plantKind: 'direktvermarktung',
    tarifArt: 'dynamisch',
    tarifParamCtKwh: 18,
    tarifPriced: true,
    anzulegenderWertCtKwh: 6.9,
    coveredSlots: 2880,
    firstCoveredDate: '2026-08-01',
    reason: null,
    einspeiseErloesEur: 947.8,
    eigenverbrauchsWertEur: 120,
    stromkostenEur: 80,
    nettoErgebnisEur: 987.8,
    savedEur: 210,
    arbitrageEur: null,
    pvShiftEur: null,
    baselineEur: null,
    actualEur: null,
    marktpraemieEur: 0,
    bezugspreisCtKwh: 30.2,
    realizedExportCtKwh: 9.9,
    marketValueSolarCtKwh: 7.0,
    marketValueProvisional: true,
    bezogenKwh: 265,
    eingespeistKwh: 9573.8,
    selbstverbrauchKwh: 400,
    batterieBewegtKwh: 900,
    series: [],
    ...over,
  };
}

function zeige(over: Partial<SiteEarnings> = {}) {
  const view = soVerdient({ money: anlage(over), siteId: 's1' })!;
  render(<SoVerdientCard view={view} />);
  return view;
}

describe('SoVerdientCard · die Blick-Reihenfolge steht', () => {
  it('führt mit Titel + Monat, dann Verdikt, dann Bild, dann Kernsatz, dann Prämie', () => {
    // Der Prämien-Monat des Konzepts: Ø 5,8 amtlich · erzielt 7,4 · Satz 1,1.
    zeige({
      marketValueSolarCtKwh: 5.8,
      marketValueProvisional: false,
      realizedExportCtKwh: 7.4,
      marktpraemieEur: 105.31,
    });

    expect(
      screen.getByRole('heading', { level: 2, name: 'So verdient Ihre Anlage · August 2026' }),
    ).toBeInTheDocument();
    expect(screen.getByText('+ 1,6 ct über dem Monatsdurchschnitt')).toBeInTheDocument();
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.getByText(KERNSATZ)).toBeInTheDocument();
    expect(screen.getByText('Marktprämie · August 2026')).toBeInTheDocument();
  });

  it('gibt dem Bild einen zugänglichen Namen, der den Zustand ERZÄHLT', () => {
    const view = zeige();
    const bild = screen.getByRole('img');
    expect(bild).toHaveAttribute('aria-label', view.chart!.ariaLabel);
    expect(bild.getAttribute('aria-label')).toContain('Ihre Anlage erzielte 9,9 ct');
    expect(bild.getAttribute('aria-label')).toContain('Marktprämie ruht');
  });
});

describe('SoVerdientCard · S4 trägt sichtbar ein anderes Kleid', () => {
  it('rendert den Aufmerksamkeits-Ton statt des neutralen Chips', () => {
    zeige({ realizedExportCtKwh: 6.1 });
    const chip = screen.getByText(/unter dem Monatsdurchschnitt/);
    expect(chip).toHaveClass('vp-sv-aufmerksam');
    expect(chip).not.toHaveClass('vp-sv-neutral');
    expect(chip).not.toHaveClass('vp-sv-vorteil');
    expect(chip.textContent).toContain('prüfenswert');
  });

  it('bleibt in der Über-Lage der ruhige Vorteils-Chip', () => {
    zeige();
    expect(screen.getByText('+ 2,9 ct über dem Monatsdurchschnitt')).toHaveClass('vp-sv-vorteil');
  });
});

describe('SoVerdientCard · S5 ist dieselbe Bild-Familie, nur ohne Garantie', () => {
  it('zeigt das Bild samt Vergleich, „—" und den Weg in die Einstellungen', () => {
    zeige({ anzulegenderWertCtKwh: null });
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.getByText('+ 2,9 ct über dem Monatsdurchschnitt')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/Kein anzulegender Wert hinterlegt/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zu den Einstellungen' })).toBeInTheDocument();
  });

  it('nennt im Bild den Grund, statt eine Garantie-Linie zu erfinden', () => {
    zeige({ anzulegenderWertCtKwh: null });
    const bild = screen.getByRole('img');
    expect(bild).toHaveTextContent('Garantiewert');
    expect(bild).toHaveTextContent('nicht hinterlegt');
  });
});

describe('SoVerdientCard · die Formen ohne Bild', () => {
  it('S7 — nichts eingespeist: ein Satz statt einer erfundenen Säule', () => {
    zeige({
      realizedExportCtKwh: null,
      eingespeistKwh: null,
      einspeiseErloesEur: null,
      marktpraemieEur: null,
    });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/wurde nichts eingespeist/)).toBeInTheDocument();
    expect(screen.queryByText(KERNSATZ)).not.toBeInTheDocument();
  });

  it('S8 — mehrere Monate: die Zeilen-Form plus die Bitte um EINEN Monat', () => {
    zeige({
      range: 'year',
      from: '2025-12-31T23:00:00Z',
      to: '2026-12-31T23:00:00Z',
      marktpraemieEur: 512.4,
      marketValueSolarCtKwh: 6.8,
      realizedExportCtKwh: 8.2,
    });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'So verdient Ihre Anlage' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Ihr erzielter Marktwert')).toBeInTheDocument();
    expect(screen.getByText('Monatsmarktwert Solar')).toBeInTheDocument();
    expect(screen.getByText(/wählen Sie einen Monat/)).toBeInTheDocument();
    // Die Prämie steht GENAU EINMAL auf der Karte — in ihrer Fußzeile.
    expect(screen.getAllByText(/512,40/)).toHaveLength(1);
  });
});
