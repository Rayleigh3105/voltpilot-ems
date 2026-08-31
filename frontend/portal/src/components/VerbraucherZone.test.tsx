import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { VerbraucherZone } from './VerbraucherZone';
import { GRENZE_FEHLT } from '../ladepunkte';
import type { SiteVerbraucher } from '../verbraucherZone';

function daten(over: Partial<SiteVerbraucher> = {}): SiteVerbraucher {
  return {
    verbraucher: [
      {
        entityId: 'lp-1',
        name: 'Wallbox Garage',
        typ: 'ev-charger',
        typLabel: 'Ladepunkt',
        ladepunkt: true,
        chargePointId: 'CP1',
        steuerart: {
          quelle: 'ueberschuss',
          herkunft: 'standard',
          ueberschussModus: 'mindestleistung',
          ziel: 'bis_uhrzeit',
          zielFenster: { tage: 'daily', von: '00:00', bis: '06:00' },
          zielEnergieKwh: 20,
        },
        regeln: 2,
      },
      {
        entityId: 'lp-2',
        name: 'Stellplatz 2',
        typ: 'ev-charger',
        typLabel: 'Ladepunkt',
        ladepunkt: true,
        chargePointId: 'CP2',
        steuerart: { quelle: 'sofort', herkunft: 'policy' },
        regeln: 0,
      },
      {
        entityId: 'hz',
        name: 'Heizstab',
        typ: 'heating-rod',
        typLabel: 'Heizstab',
        ladepunkt: false,
        steuerart: {
          quelle: 'feste_zeiten',
          herkunft: 'policy',
          fenster: { tage: 'weekdays', von: '13:00', bis: '15:00' },
        },
        regeln: 0,
      },
    ],
    ladepunkte: {
      standard: {
        quelle: 'ueberschuss', herkunft: 'standard', ueberschussModus: 'mindestleistung',
      },
      standardFolger: 1,
      gesamt: 2,
      rahmen: {
        netzanschlussKw: 32, hoechsteHausLastKw: 5, verteiltKw: 22,
        hinweis: 'Ihr Anschluss ist geschützt.', steckerAnzahl: 2,
      },
    },
    rangliste: [
      { position: 1, art: 'speicher', entityId: null, name: 'Speicher' },
      { position: 2, art: 'ladepunkt', entityId: 'lp-1', name: 'Wallbox Garage' },
    ],
    ...over,
  };
}

describe('Zone ② Verbraucher (Verbrauchsmanagement v1, P1)', () => {
  it('rendert die Zone mit Rahmen, Standard-Zeile und beiden Abschnitten', () => {
    render(<VerbraucherZone daten={daten()} onRegeln={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Verbraucher' })).toBeInTheDocument();
    expect(screen.getByText('Ladepark-Rahmen')).toBeInTheDocument();
    expect(screen.getByText('Netzanschluss 32 kW')).toBeInTheDocument();
    expect(screen.getByText('Reserve Haus 5 kW')).toBeInTheDocument();
    expect(screen.getByText('gerade 22 kW verteilt')).toBeInTheDocument();
    // Der Satz der Box wird DURCHGEREICHT, nie neu formuliert.
    expect(screen.getByText('Ihr Anschluss ist geschützt.')).toBeInTheDocument();
    expect(screen.getByText('Anlagen-Standard für Ladepunkte')).toBeInTheDocument();
    expect(screen.getByText('Gilt für 1 von 2 Ladepunkten')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ladepunkte' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Weitere Verbraucher' })).toBeInTheDocument();
  });

  it('trägt je Ladepunkt „Standard" oder „abweichend" und die Steuerart', () => {
    render(<VerbraucherZone daten={daten()} onRegeln={() => {}} />);
    const zeilen = screen.getAllByRole('listitem');
    const garage = zeilen.find((li) => li.textContent?.includes('Wallbox Garage'))!;
    expect(within(garage).getByText('Standard')).toBeInTheDocument();
    expect(within(garage).getByText('Überschuss')).toBeInTheDocument();
    expect(within(garage).getByText('bis 06:00 · 20 kWh')).toBeInTheDocument();
    const stellplatz = zeilen.find((li) => li.textContent?.includes('Stellplatz 2'))!;
    expect(within(stellplatz).getByText('abweichend')).toBeInTheDocument();
    expect(within(stellplatz).getByText('Sofort')).toBeInTheDocument();
    // Ohne Regel steht ein ruhiger Text, KEIN Link (§6.2).
    expect(within(stellplatz).getByText('Ohne Regel')).toBeInTheDocument();
    expect(within(stellplatz).queryByRole('button')).toBeNull();
  });

  it('„N Regeln →" ist ein echter Sprung', () => {
    const onRegeln = vi.fn();
    render(<VerbraucherZone daten={daten()} onRegeln={onRegeln} />);
    fireEvent.click(screen.getByRole('button', { name: '2 Regeln →' }));
    expect(onRegeln).toHaveBeenCalledWith('lp-1');
  });

  it('sagt ohne hinterlegte Anschlussgrenze den BESTEHENDEN Satz', () => {
    const d = daten();
    d.ladepunkte.rahmen = { verteiltKw: 0, steckerAnzahl: 0 };
    render(<VerbraucherZone daten={d} onRegeln={() => {}} />);
    expect(screen.getByText(GRENZE_FEHLT)).toBeInTheDocument();
  });

  it('nennt bei GAR NICHTS Steuerbarem den Weg statt einer leeren Liste', () => {
    render(<VerbraucherZone
      daten={{
        verbraucher: [],
        ladepunkte: { standard: null, standardFolger: 0, gesamt: 0, rahmen: null },
        rangliste: [],
      }}
      onRegeln={() => {}}
    />);
    expect(screen.getByText(/Noch kein steuerbares Gerät/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Ladepunkte' })).toBeNull();
  });

  it('überlebt eine fehlende Antwort (älteres Backend)', () => {
    render(<VerbraucherZone daten={null} onRegeln={() => {}} />);
    expect(screen.getByText(/Noch kein steuerbares Gerät/)).toBeInTheDocument();
  });

  it('die Rangliste ist eingeklappt und nennt ihre Zusammenfassung', () => {
    render(<VerbraucherZone daten={daten()} onRegeln={() => {}} />);
    const fold = screen.getByRole('button', { name: /Reihenfolge bei knapper Leistung/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Speicher zuerst · 2 Einträge')).toBeInTheDocument();
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Speicher')).toBeInTheDocument();
  });

  it('zeigt das Suchfeld erst ab 12 Ladepunkten (§6.4)', () => {
    const viele = daten({
      verbraucher: Array.from({ length: 12 }, (_, i) => ({
        entityId: `lp-${i}`,
        name: `Stellplatz ${i}`,
        typ: 'ev-charger',
        typLabel: 'Ladepunkt',
        ladepunkt: true,
        chargePointId: `CP${i}`,
        steuerart: { quelle: 'ueberschuss', herkunft: 'standard' },
        regeln: 0,
      })),
    });
    render(<VerbraucherZone daten={viele} onRegeln={() => {}} />);
    const suche = screen.getByRole('textbox', { name: 'Ladepunkt suchen' });
    fireEvent.change(suche, { target: { value: 'platz 7' } });
    const zeilen = screen.getAllByRole('listitem').filter((li) =>
      li.textContent?.includes('Stellplatz'));
    expect(zeilen).toHaveLength(1);
  });

  it('klappt ab 25 Ladepunkten die Standard-Folger zusammen — und ZÄHLT sie', () => {
    const viele = daten({
      verbraucher: Array.from({ length: 25 }, (_, i) => ({
        entityId: `lp-${i}`,
        name: `Stellplatz ${i}`,
        typ: 'ev-charger',
        typLabel: 'Ladepunkt',
        ladepunkt: true,
        chargePointId: `CP${i}`,
        // Genau EINER weicht ab - nur er steht offen (§6.4 „Aktive zuerst").
        steuerart: { quelle: 'ueberschuss', herkunft: i === 0 ? 'policy' : 'standard' },
        regeln: 0,
      })),
    });
    render(<VerbraucherZone daten={viele} onRegeln={() => {}} />);
    const fold = screen.getByRole('button', { name: /24 Ladepunkte folgen dem Standard/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('listitem').filter((li) =>
      li.textContent?.includes('Stellplatz'))).toHaveLength(1);
    fireEvent.click(fold);
    expect(screen.getAllByRole('listitem').filter((li) =>
      li.textContent?.includes('Stellplatz'))).toHaveLength(25);
  });

  it('nennt den Weg, wo die Steuerart HEUTE eingestellt wird — statt eines toten Klicks', () => {
    const onEinstellungen = vi.fn();
    render(<VerbraucherZone daten={daten()} onRegeln={() => {}} onEinstellungen={onEinstellungen} />);
    expect(screen.getByText(/im Ladepark unter „Einstellungen"/)).toBeInTheDocument();
    expect(screen.getByText(/unter „Regeln" auf dieser Seite/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Einstellungen' }));
    expect(onEinstellungen).toHaveBeenCalled();
  });
});
