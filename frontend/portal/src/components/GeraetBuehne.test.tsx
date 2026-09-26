import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GeraetBuehne, grafikZeigt, grosseZahl, nebenKacheln } from './GeraetBuehne';
import { KEINE_WERTE, type HeldKachel } from '../geraetGesicht';
import { NBSP } from '../format';
import { NO_DATA } from '../nodata';

/**
 * Die BÜHNE: die eine große Zahl, ein Satz, eine Grafik - und darunter nur,
 * was die Grafik NICHT schon zeigt.
 */
const kacheln: HeldKachel[] = [
  { key: 'pv', label: 'Solarstrom', wert: `6,2${NBSP}kW`, wort: null },
  { key: 'speicher', label: 'Ladestand', wert: `64,0${NBSP}%`, wort: 'geladen', gross: true },
  { key: 'batterie', label: 'Batterieleistung', wert: `2,2${NBSP}kW`, wort: 'lädt' },
  { key: 'netz', label: 'Netz', wert: `1,3${NBSP}kW`, wort: 'Einspeisung' },
  { key: 'haus', label: 'Haus', wert: `4,0${NBSP}kW`, wort: 'abgeleitet' },
  { key: 'reserve', label: 'Reserve', wert: '10 %', wort: 'nicht unterschritten' },
];
const werte = { ...KEINE_WERTE, pvKw: 6.2, netzKw: -1.3, hausKw: 4, batterieKw: 2.2, ladestandPct: 64, reservePct: 10 };

describe('grosseZahl - aus der führenden Kachel', () => {
  it('trennt Zahl und Einheit', () => {
    expect(grosseZahl({ kacheln })).toMatchObject({ zahl: '64,0', einheit: '%', wort: 'geladen', key: 'speicher' });
  });

  it('lässt ein Wort ein Wort sein - und zeigt ohne Wert keine große Zahl', () => {
    expect(grosseZahl({ kacheln: [{ key: 'relais', label: 'Zustand', wert: 'Ein', wort: null, gross: true }] }))
      .toMatchObject({ zahl: 'Ein', einheit: null });
    expect(grosseZahl({ kacheln: [{ key: 'pv', label: 'Solarstrom', wert: NO_DATA, wort: null, gross: true }] }))
      .toBeNull();
  });
});

describe('nebenKacheln - dieselbe Zahl nie zweimal auf einer Bühne', () => {
  it('lässt weg, was die Speicher-Grafik selbst beschriftet', () => {
    const grafik = { art: 'speicher' as const, werte };
    expect(grafikZeigt(grafik)).toEqual(new Set(['pv', 'netz', 'haus']));
    expect(nebenKacheln({ kacheln }, grosseZahl({ kacheln }), grafik).map((k) => k.key))
      .toEqual(['batterie', 'reserve']);
  });

  it('behält Haus und Netz, wo die Grafik sie nicht zeichnet', () => {
    const grafik = { art: 'speicher' as const, werte: { ...werte, netzKw: null, hausKw: null } };
    expect(nebenKacheln({ kacheln }, grosseZahl({ kacheln }), grafik).map((k) => k.key))
      .toEqual(['batterie', 'netz', 'haus', 'reserve']);
  });

  it('lässt die Nennleistung nur weg, wenn der Sonnenbogen sie als Maßstab trägt', () => {
    const pv: HeldKachel[] = [
      { key: 'pv', label: 'Erzeugung jetzt', wert: `3,4${NBSP}kW`, wort: null, gross: true },
      { key: 'kwp', label: 'Nennleistung', wert: `8,2${NBSP}kWp`, wort: 'gepflegt' },
    ];
    const mit = { art: 'sonne' as const, werte: { ...KEINE_WERTE, pvKw: 3.4, kwp: 8.2 } };
    const ohne = { art: 'sonne' as const, werte: { ...KEINE_WERTE, pvKw: 3.4 } };
    expect(nebenKacheln({ kacheln: pv }, grosseZahl({ kacheln: pv }), mit)).toEqual([]);
    expect(nebenKacheln({ kacheln: pv }, grosseZahl({ kacheln: pv }), ohne).map((k) => k.key)).toEqual(['kwp']);
  });

  it('zeigt keinen leeren Chip', () => {
    const mitLeer = [...kacheln, { key: 'bms-laden', label: 'Laden (BMS)', wert: NO_DATA, wort: null }];
    expect(nebenKacheln({ kacheln: mitLeer }, grosseZahl({ kacheln: mitLeer })).map((k) => k.key))
      .not.toContain('bms-laden');
  });
});

describe('GeraetBuehne - die Speicher-Grafik', () => {
  it('schreibt „abgeleitet" direkt an das Haus - es ist eine Rechnung, keine Messung', () => {
    render(
      <GeraetBuehne
        zahl={grosseZahl({ kacheln })}
        satz="Der Speicher lädt gerade mit 2,2 kW."
        grafik={{ art: 'speicher', werte }}
        chips={nebenKacheln({ kacheln }, grosseZahl({ kacheln }), { art: 'speicher', werte })}
      />,
    );
    expect(screen.getByTestId('geraet-heldsatz')).toHaveTextContent('Der Speicher lädt gerade mit 2,2 kW.');
    expect(screen.getByText('abgeleitet')).toBeInTheDocument();
    // Die Richtung am Netz ist ein WORT.
    expect(screen.getByText('Einspeisung')).toBeInTheDocument();
    const chips = screen.getByRole('list', { name: 'Weitere Werte' });
    expect(chips).toHaveTextContent('Batterieleistung');
    expect(chips).not.toHaveTextContent('Solarstrom');
  });
});
