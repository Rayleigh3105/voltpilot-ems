import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PauschalJahr, PauschalStand } from '../../mispelPauschal';
import { PauschalJahrKarte, PauschalJahrZeile } from './PauschalJahrKarte';

/** Haus Kröger (fiktiv, BK-27): (P1) 5.000, (P3) 500, (P4) 5.500 kWh — Pinst 10 kWp, SKinst 10 kWh. */
function jahr(jahreswerte: Record<string, number | null>, teil: Partial<PauschalStand> = {}): PauschalJahr {
  return {
    site_id: 's-kroeger',
    jahr: 2028,
    anwendbar_ab: '2027-07-01',
    schaetzung: null,
    staende: [
      {
        tag_von: '2028-01-01',
        tag_bis: '2028-12-31',
        rumpfjahr: false,
        fassung: 3,
        formelsatz: 'P1',
        basisfall: 'P1',
        stand: 'vorlaeufig',
        stand_gruende: ['zeitraum_offen'],
        wertequelle: 'geraet',
        viertelstunden_erwartet: 35136,
        viertelstunden_gerechnet: 23424,
        gerechnet_am: '2028-08-31T22:00:00Z',
        stammdaten: { Pinst: 10, SKinst: 10 },
        jahreswerte: { '(P1)': 5000, '(P2)P1': 0.1, '(P3)': 500, '(P4)': 5500, ...jahreswerte },
        ...teil,
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MiSpeL · Jahresstand nach Anlage 2 (MP-27, BK-27 Variante A)', () => {
  it('förderfähig: „Sie stehen bei 3.900 von 5.000 kWh“, die nächste kWh, jede Zahl mit Begriff und Formelnummer', () => {
    render(
      <PauschalJahrKarte
        daten={jahr({ '(P14)': 3900, '(P15)': 3900, '(P7)': 4030, '(P8)': 0, '(P9)': 1480, '(P10)': 0, '(P11)': 1480 })}
        heute="2028-09-01"
      />,
    );
    const karte = screen.getByRole('region', { name: 'MiSpeL · Jahresstand nach Anlage 2' });
    expect(karte).toHaveTextContent('MiSpeL · Jahresstand nach Anlage 2 · 2028');
    expect(karte).toHaveTextContent(`Noch 1.100 kWh mit Marktprämie`);
    expect(karte).toHaveTextContent('Sie stehen bei 3.900 von 5.000 kWh förderfähiger Einspeisung (P14) von (P1).');
    expect(screen.getByTestId('pj-band')).toHaveAttribute('aria-label', expect.stringContaining('förderfähig bis 5.000 kWh (P1)'));
    expect(screen.getByTestId('pj-naechste')).toHaveTextContent('Die nächste eingespeiste kWh bekommt die Marktprämie');
    expect(karte).toHaveTextContent('(P15) Förderfähige Netzeinspeisung im Kalenderjahr');
    expect(karte).toHaveTextContent('(P9)');
    expect(karte).toHaveTextContent('(P11)');
    expect(screen.getByTestId('pj-stand')).toHaveTextContent('vorläufig · das Jahr läuft noch');
    // Marktprämie bleibt offen bis zum Jahresmarktwert — nie 0 €; keine Schätzung bis Silvester ohne Jahresprofil.
    expect(karte).toHaveTextContent('offen');
    expect(karte).not.toHaveTextContent('0 €');
    expect(karte).not.toHaveTextContent(/voraussichtlich|Schätzung/);
    expect(screen.queryByTestId('pj-rumpfjahr')).toBeNull();
  });

  it('indifferent: Grenze erreicht, die nächsten kWh bringen nur den Marktwert', () => {
    render(<PauschalJahrKarte daten={jahr({ '(P14)': 5120, '(P15)': 5000, '(P7)': 5120, '(P9)': 1890, '(P10)': 0, '(P11)': 1890 })} heute="2028-11-01" />);
    expect(screen.getByTestId('pauschal-jahr')).toHaveAttribute('data-bereich', 'indifferent');
    expect(screen.getByRole('region')).toHaveTextContent(`Grenze erreicht: 5.000 kWh mit Marktprämie`);
    expect(screen.getByTestId('pj-naechste')).toHaveTextContent(`Die nächsten 380 kWh bringen nur den Marktwert`);
  });

  it('saldierungsfähig: über (P4), (P10) mit Netzbezug (P9) als Obergrenze', () => {
    render(<PauschalJahrKarte daten={jahr({ '(P14)': 6600, '(P15)': 5000, '(P7)': 6800, '(P8)': 1300, '(P9)': 1900, '(P10)': 1300, '(P11)': 600 })} heute="2028-12-01" />);
    expect(screen.getByTestId('pauschal-jahr')).toHaveAttribute('data-bereich', 'saldierungsfaehig');
    expect(screen.getByRole('region')).toHaveTextContent(`Über der Saldierungsgrenze: 1.300 kWh saldierungsfähig`);
    expect(screen.getByTestId('pj-naechste')).toHaveTextContent('Jede weitere kWh senkt die Umlagen auf Ihren Netzbezug');
  });

  it('Rumpfjahr: (P1)R/(P4)R mit Fundstelle A2 S. 54–55', () => {
    render(
      <PauschalJahrKarte
        daten={jahr(
          { '(P1)R': 2513.661, '(P3)R': 252.055, '(P4)R': 2765.716, '(P14)': 1200, '(P15)': 1200, '(P7)': 1200 },
          { tag_von: '2027-07-01', tag_bis: '2027-12-31', rumpfjahr: true },
        )}
        heute="2027-09-15"
      />,
    );
    expect(screen.getByTestId('pj-rumpfjahr')).toHaveTextContent('Rumpfjahr 01.07.2027 bis 31.12.2027');
    expect(screen.getByRole('region')).toHaveTextContent('Sie stehen bei 1.200 von 2.514 kWh förderfähiger Einspeisung (P14) von (P1)R.');
  });

  it('unbekannt ist keine Null: ohne (P14) kein Strich, keine Zahl als Stand', () => {
    render(<PauschalJahrKarte daten={jahr({ '(P14)': null })} heute="2028-09-01" />);
    expect(screen.getByTestId('pauschal-jahr')).toHaveAttribute('data-bereich', 'offen');
    expect(screen.queryByTestId('pj-naechste')).toBeNull();
    expect(screen.getByRole('region')).toHaveTextContent('Jahresstand offen');
  });

  it('im Monat eine Zeile mit Sprung ins Jahr', () => {
    const onJahr = vi.fn();
    render(<PauschalJahrZeile daten={jahr({ '(P14)': 3900, '(P7)': 3900 })} heute="2028-09-01" onJahr={onJahr} />);
    const zeile = screen.getByTestId('pj-zeile');
    expect(within(zeile).getByText(/3\.900 von 5\.000 kWh förderfähig/)).toBeTruthy();
    fireEvent.click(zeile);
    expect(onJahr).toHaveBeenCalled();
  });
});
