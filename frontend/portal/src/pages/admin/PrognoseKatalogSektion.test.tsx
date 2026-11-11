import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const forecastModels = vi.fn();
const promoteForecastModel = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    forecastModels: (...a: unknown[]) => forecastModels(...a),
    promoteForecastModel: (...a: unknown[]) => promoteForecastModel(...a),
  },
}));

const { PrognoseKatalogSektion } = await import('./PrognoseKatalogSektion');

/**
 * Katalog › Prognosemodelle (N8, Konzept `vp-adminview-konzept-k1` §9, Scheibe
 * S3): Server und Portal-Funktion (`AdminForecastModelController`,
 * `adminApi.forecastModels`/`promoteForecastModel`) hatten keine Fläche -
 * diese Sektion ist sie, keine neue Schnittstelle.
 */
describe('PrognoseKatalogSektion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forecastModels.mockResolvedValue({
      kinds: [
        { kind: 'load', activeModel: 'load-persistence', source: 'env', envDefault: 'load-persistence', setByName: null, setAt: null, selectable: ['load-persistence', 'load-xgb'] },
        { kind: 'pv', activeModel: 'pv-physical', source: 'env', envDefault: 'pv-physical', setByName: null, setAt: null, selectable: ['pv-physical', 'pv-residual-xgb'] },
      ],
      history: [],
    });
  });

  it('zeigt die Vorgabe je Prognoseart mit Herkunft', async () => {
    render(<PrognoseKatalogSektion />);
    expect(await screen.findByRole('heading', { name: 'Prognosemodelle' })).toBeInTheDocument();
    expect(screen.getByText(/Verbrauchsprognose/)).toBeInTheDocument();
    expect(screen.getByText(/PV-Prognose/)).toBeInTheDocument();
    expect(screen.getAllByText('Ausgeliefertes Modell')).toHaveLength(2);
  });

  it('setzt die Plattform-Vorgabe über denselben Aufruf wie die frühere Funktion ohne Fläche', async () => {
    render(<PrognoseKatalogSektion />);
    await screen.findByRole('heading', { name: 'Prognosemodelle' });
    const nachAenderung = {
      kinds: [
        { kind: 'load', activeModel: 'load-xgb', source: 'portal', envDefault: 'load-persistence', setByName: 'alex', setAt: new Date().toISOString(), selectable: ['load-persistence', 'load-xgb'] },
        { kind: 'pv', activeModel: 'pv-physical', source: 'env', envDefault: 'pv-physical', setByName: null, setAt: null, selectable: ['pv-physical', 'pv-residual-xgb'] },
      ],
      history: [],
    };
    promoteForecastModel.mockResolvedValue(nachAenderung);
    forecastModels.mockResolvedValue(nachAenderung);
    fireEvent.click(screen.getByRole('combobox', { name: /Vorgabe Verbrauchsprognose/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Lernendes Verbrauchsmodell' }));
    await waitFor(() => expect(promoteForecastModel).toHaveBeenCalledWith('load', 'load-xgb'));
    expect(await screen.findByText('Im Portal gesetzt')).toBeInTheDocument();
  });

  it('reißt die Seite nicht mit, wenn der Abruf fehlschlägt', async () => {
    forecastModels.mockRejectedValue(new Error('boom'));
    render(<PrognoseKatalogSektion />);
    expect(await screen.findByText(/Prognosemodelle konnten nicht geladen werden/)).toBeInTheDocument();
  });
});
