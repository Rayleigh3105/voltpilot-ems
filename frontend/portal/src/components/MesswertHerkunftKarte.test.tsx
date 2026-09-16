import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MeasurementHistory } from '../api';
import { MesswertHerkunftKarte, nachlieferungMarker, rohwerteHinweis } from './MesswertHerkunftKarte';

const history = (): MeasurementHistory => ({
  meta: {
    pointKey: 'energy-import', label: 'Wirkenergie Bezug', sourceLabel: 'Energy import', unit: 'kWh',
    aggregationKind: 'counter', semanticStatus: 'known', catalogVersion: '2026.08.26.3',
    representation: 'decoded', rawAvailable: false, from: '2026-11-03T13:00:00Z', to: '2026-11-03T17:00:00Z',
    bucketSeconds: 900, aggregationExplanation: 'Viertelstundenwerte.', siteId: 'site', entityId: 'entity',
    quelle: 'viertelstunde', quelleErklaerung: 'Viertelstundenwerte.', rohGrenze: '2026-10-20T00:00:00Z',
  },
  data: [{
    time: '2026-11-03T13:00:00Z', value: 22.4, minimum: 22.4, maximum: 22.4, text: null, sampleCount: 15, gap: false,
    herkunft: {
      quelle: 'viertelstunde', wertart: 'counter', abdeckungProzent: 100, erhalten: 15, erwartet: 15,
      nGood: 15, nUncertain: 0, nInvalid: 0, nStale: 0, nDeviceError: 0,
      zustand: 'endgueltig', endgueltigAb: '2026-11-10T14:15:00Z', version: 1,
      nachgeliefert: 15, zustellart: 'nachgeliefert', letzteEingangszeit: '2026-11-03T16:31:00Z',
      geraetEinbau: 'z5', geraetEinbauZwei: null, box: 'box2', boxZwei: null,
      fassung: 1, katalogVersion: '2026.08.26.3', rolle: 'fuehrend', standAnfang: 1, standEnde: 2,
    },
  }],
  markers: [{ time: '2026-11-03T13:00:00Z', until: '2026-11-03T16:30:00Z', kind: 'data_gap', label: 'Datenlücke', count: 1 }],
});

describe('Messwert-Herkunft im Verlauf (AP-07 IP-15)', () => {
  it('spricht Rohdatenfrist und Nachlieferung nur aus exportierten Feldern', () => {
    const h = history();
    expect(rohwerteHinweis(h)).toBe('Rohwerte (60 s) bis 20.10.2026 verfügbar — ab hier Viertelstundenwerte.');
    expect(nachlieferungMarker(h, h.markers[0])).toBe('nachgeliefert um 17:31 (14:00–17:30)');
  });

  it('zeigt Herkunft mit Kundenwörtern und aufgelösten Namen', () => {
    render(<MesswertHerkunftKarte history={history()} index={0} namen={{
      geraete: { z5: 'Z-5a · Seriennummer 4471023' }, boxen: { box2: 'Box Halle 2' },
    }} />);
    const karte = screen.getByTestId('herkunfts-karte');
    expect(karte).toHaveTextContent('Herkunft');
    expect(karte).toHaveTextContent('03.11.2026, 14:00:00');
    expect(karte).toHaveTextContent('03.11.2026, 17:31:00 (nachgeliefert)');
    expect(karte).toHaveTextContent('15 × gut');
    expect(karte).toHaveTextContent('15 von 15');
    expect(karte).toHaveTextContent('Z-5a · Seriennummer 4471023');
    expect(karte).toHaveTextContent('Box Halle 2');
    expect(karte).toHaveTextContent('endgültig seit 10.11.2026, 15:15:00');
  });
});
