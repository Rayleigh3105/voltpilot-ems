import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import type { SiteEarnings } from '../api';
import { KERNSATZ, RUNDUNG_HINWEIS, soVerdient } from '../soVerdient';
import { SoVerdientCard } from './SoVerdient';

/**
 * Der DÜNNE Renderer über `soVerdient()` — die Zustands-Vollständigkeit liegt
 * in `soVerdient.test.ts`; hier wird geprüft, dass jeder Zustand die richtige
 * FORM auf den Schirm bringt (Balken als lesbare Liste, Rechnung im
 * Aufklapper) und dass der Captain-Override (S4) auch sichtbar ein anderes
 * Kleid trägt.
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
    gesamtertragEur: null,
    expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null,
    expectedMarketValueTo: null,
    expectedMarketValueSlots: null,
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
  it('führt mit Titel + Monat, dann Verdikt, dann Balken, dann Kernsatz, dann Prämie', () => {
    // Der Prämien-Monat des Konzepts: Ø 5,8 amtlich · erzielt 7,4 · Satz 1,1.
    zeige({
      marketValueSolarCtKwh: 5.8,
      marketValueProvisional: false,
      realizedExportCtKwh: 7.4,
      marktpraemieEur: 105.31,
      einspeiseErloesEur: 813.77,
    });

    expect(
      screen.getByRole('heading', { level: 2, name: 'So verdient Ihre Anlage · August 2026' }),
    ).toBeInTheDocument();
    expect(screen.getByText('+ 1,6 ct über dem Monatsdurchschnitt')).toBeInTheDocument();
    const liste = screen.getByRole('list', { name: 'Erlös je eingespeister Kilowattstunde' });
    expect(within(liste).getAllByRole('listitem').map((li) => li.getAttribute('data-zeile'))).toEqual([
      'markt',
      'anlage',
      'erloes',
    ]);
    expect(screen.getByText(KERNSATZ)).toBeInTheDocument();
    expect(screen.getByText('Marktprämie · August 2026')).toBeInTheDocument();
  });

  it('liest sich ohne Bild: jede Zeile trägt Namen, Wert und Unterzeile als Text', () => {
    zeige({
      marketValueSolarCtKwh: 5.8,
      marketValueProvisional: false,
      realizedExportCtKwh: 7.4,
      marktpraemieEur: 105.31,
      einspeiseErloesEur: 813.77,
    });
    const liste = screen.getByRole('list', { name: 'Erlös je eingespeister Kilowattstunde' });
    const [markt, anlage, erloes] = within(liste).getAllByRole('listitem');
    expect(markt).toHaveTextContent('Ø aller Solaranlagen');
    expect(markt).toHaveTextContent('5,8 ct');
    expect(anlage).toHaveTextContent('Ihre Anlage');
    expect(anlage).toHaveTextContent('7,4 ct');
    expect(erloes).toHaveTextContent('Ihr Erlös je kWh');
    expect(erloes).toHaveTextContent('8,5 ct');
    expect(erloes).toHaveTextContent('+ 1,1 ct Marktprämie · Garantiewert 6,9 − Ø 5,8');
  });

  it('legt die Prämien-Rechnung in den Aufklapper — einmal, nicht als Kleingedrucktes', () => {
    zeige({
      marketValueSolarCtKwh: 5.8,
      marketValueProvisional: false,
      realizedExportCtKwh: 7.4,
      marktpraemieEur: 105.31,
      einspeiseErloesEur: 813.77,
    });
    const aufklapper = screen.getByText('So wird die Prämie gerechnet').closest('details') as HTMLElement;
    expect(aufklapper).not.toHaveAttribute('open');
    expect(within(aufklapper).getByText(/6,9 − 5,8 = 1,1/)).toBeInTheDocument();
    expect(screen.getAllByText(/6,9 − 5,8 = 1,1/)).toHaveLength(1);
    // Die kurzen Stände stehen in EINER Zeile.
    expect(screen.getByText('amtlich · bereits im Einspeise-Erlös enthalten')).toBeInTheDocument();
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

describe('SoVerdientCard · S5 vergleicht weiter, nur ohne Prämie', () => {
  it('zeigt die Balken samt Vergleich, „—" und den Weg in die Einstellungen', () => {
    zeige({ anzulegenderWertCtKwh: null });
    expect(screen.getByRole('list', { name: 'Erlös je eingespeister Kilowattstunde' })).toBeInTheDocument();
    expect(screen.getByText('+ 2,9 ct über dem Monatsdurchschnitt')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/Kein anzulegender Wert hinterlegt/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zu den Einstellungen' })).toBeInTheDocument();
  });

  it('nennt am Erlös den Grund, statt einen Prämien-Block zu erfinden', () => {
    zeige({ anzulegenderWertCtKwh: null });
    expect(screen.getByText('ohne Marktprämie — kein Garantiewert hinterlegt')).toBeInTheDocument();
    expect(document.querySelector('.vp-bl-seg[data-rolle="praemie"]')).toBeNull();
  });
});

describe('SoVerdientCard · die Formen ohne Prämien-Bild', () => {
  it('S7 — nichts eingespeist: ein Satz statt eines erfundenen Balkens', () => {
    zeige({
      realizedExportCtKwh: null,
      eingespeistKwh: null,
      einspeiseErloesEur: null,
      marktpraemieEur: null,
    });
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByText(/wurde nichts eingespeist/)).toBeInTheDocument();
    expect(screen.queryByText(KERNSATZ)).not.toBeInTheDocument();
  });

  it('S8 — mehrere Monate: Börse gegen Ø plus die Bitte um EINEN Monat', () => {
    zeige({
      range: 'year',
      from: '2025-12-31T23:00:00Z',
      to: '2026-12-31T23:00:00Z',
      marktpraemieEur: 512.4,
      marketValueSolarCtKwh: 6.8,
      realizedExportCtKwh: 8.2,
    });
    expect(
      screen.getByRole('heading', { level: 2, name: 'So verdient Ihre Anlage' }),
    ).toBeInTheDocument();
    const liste = screen.getByRole('list', { name: 'Erlös je eingespeister Kilowattstunde' });
    expect(within(liste).getAllByRole('listitem')).toHaveLength(2);
    expect(within(liste).getByText('Ø aller Solaranlagen')).toBeInTheDocument();
    expect(within(liste).getByText('Ihre Anlage')).toBeInTheDocument();
    expect(screen.getByText(/wählen Sie einen Monat/)).toBeInTheDocument();
    // Die Prämie steht GENAU EINMAL auf der Karte — in ihrer Fußzeile.
    expect(screen.getAllByText(/512,40/)).toHaveLength(1);
  });
});

describe('SoVerdientCard · Rundung', () => {
  it('sagt es, wenn die gerundeten Teile nicht aufgehen', () => {
    zeige({
      marketValueSolarCtKwh: 5.8,
      realizedExportCtKwh: 7.46,
      marktpraemieEur: 18.6,
      einspeiseErloesEur: 93.2,
      eingespeistKwh: 1000,
    });
    expect(screen.getByText(RUNDUNG_HINWEIS)).toBeInTheDocument();
  });
});
