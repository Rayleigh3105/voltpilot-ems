import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ErzeugerSourcesPanel, sourceSummary } from './ErzeugerSourcesPanel';
import { api, type MeasurementPoint } from '../api';

const point = (over: Partial<MeasurementPoint> = {}): MeasurementPoint => ({
  id: 'src-1',
  role: 'pv-generation',
  label: 'PV Dach Süd',
  brand: null,
  model: null,
  capacityKwp: 70,
  registryUnitId: 'SEE900000000001',
  control: false,
  createdAt: null,
  ...over,
});

const NBSP = ' ';

describe('sourceSummary', () => {
  it('lists kWp + SEE + read-only', () => {
    expect(sourceSummary(point())).toBe(`70,0${NBSP}kWp · SEE900000000001 · nur Lesen`);
  });
  it('omits absent kWp / SEE', () => {
    expect(sourceSummary(point({ capacityKwp: null, registryUnitId: null }))).toBe('nur Lesen');
  });
});

describe('ErzeugerSourcesPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists recorded sources', async () => {
    vi.spyOn(api, 'measurementPoints').mockResolvedValue([point()]);
    render(<ErzeugerSourcesPanel siteId="site-1" />);
    expect(await screen.findByText('PV Dach Süd')).toBeInTheDocument();
    expect(screen.getByText(/kWp · SEE900000000001/)).toBeInTheDocument();
  });

  it('adds an Erzeuger source (role forced to pv-generation, kWp + SEE captured)', async () => {
    vi.spyOn(api, 'measurementPoints').mockResolvedValue([]);
    const add = vi
      .spyOn(api, 'addMeasurementPoint')
      .mockResolvedValue([point({ label: 'AC-PV', capacityKwp: 30, registryUnitId: '' })]);
    render(<ErzeugerSourcesPanel siteId="site-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /Erzeuger hinzufügen/ }));
    fireEvent.change(screen.getByLabelText(/Bezeichnung/), { target: { value: 'AC-PV' } });
    fireEvent.change(screen.getByLabelText(/Anlagenleistung/), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /Quelle hinzufügen/ }));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith('site-1', {
        role: 'pv-generation',
        label: 'AC-PV',
        capacityKwp: 30,
        registryUnitId: undefined,
      }),
    );
  });

  it('renders nothing when the endpoint fails (never blocks the page)', async () => {
    vi.spyOn(api, 'measurementPoints').mockRejectedValue(new Error('boom'));
    const { container } = render(<ErzeugerSourcesPanel siteId="site-1" />);
    await waitFor(() => expect(container.querySelector('.vp-erzeuger')).toBeNull());
  });
});
