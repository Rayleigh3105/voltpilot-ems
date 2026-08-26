import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type MeasurementComparisonOption, type MeasurementHistory } from '../api';
import { SiteMeasurementComparison } from './SiteMeasurementComparison';

vi.mock('../useEChart', () => ({ useEChart: () => () => undefined }));

const option = (deviceId: string, label: string, unit: string, compatibilityKey: string): MeasurementComparisonOption => ({
  deviceId, deviceLabel: `Gerät ${deviceId}`, pointKey: `point.${deviceId}`,
  label, unit, aggregationKind: 'gauge', compatibilityKey, lastReadAt: '2026-08-26T00:00:00Z',
});

const history: MeasurementHistory = {
  meta: {
    pointKey: 'point.a', label: 'Netzleistung', sourceLabel: 'Grid Power', unit: 'W',
    aggregationKind: 'gauge', semanticStatus: 'known', catalogVersion: '2026.08.26.1',
    representation: 'decoded', rawAvailable: true, from: '2026-08-25T00:00:00Z',
    to: '2026-08-26T00:00:00Z', bucketSeconds: 300,
    aggregationExplanation: 'Mittelwert; Minimum und Maximum.',
  },
  data: [{ time: '2026-08-26T00:00:00Z', value: 42, minimum: 40, maximum: 44, text: null, sampleCount: 3, gap: false }],
  markers: [],
};

describe('SiteMeasurementComparison', () => {
  afterEach(() => vi.restoreAllMocks());

  it('limits the picker to semantically compatible points after the first selection', async () => {
    vi.spyOn(api, 'measurementComparisonOptions').mockResolvedValue([
      option('a', 'Netzleistung', 'W', 'gauge|netzleistung'),
      option('b', 'Netzleistung', 'kW', 'gauge|netzleistung'),
      option('c', 'Temperatur', '°C', 'gauge|temperatur'),
    ]);
    vi.spyOn(api, 'measurementHistory').mockResolvedValue(history);

    render(<SiteMeasurementComparison siteId="site" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Gerät a · Netzleistung (W)' }));

    expect(screen.getByRole('button', { name: 'Gerät b · Netzleistung (kW)' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Gerät c · Temperatur (°C)' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('img', { name: 'Vergleich ausgewählter Messwerte' })).toBeVisible());
    expect(screen.getByText('Bis zu drei semantisch gleiche Punkte. Einheiten erhalten getrennte Achsen.')).toBeVisible();
  });
});
