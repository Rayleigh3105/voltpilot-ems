import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listComponentTemplates = vi.fn();
const controlCertifications = vi.fn();
const controlCandidates = vi.fn();
const consumerDeviceTypes = vi.fn();
const forecastModels = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    listComponentTemplates: (...a: unknown[]) => listComponentTemplates(...a),
    controlCertifications: (...a: unknown[]) => controlCertifications(...a),
    controlCandidates: (...a: unknown[]) => controlCandidates(...a),
    consumerDeviceTypes: (...a: unknown[]) => consumerDeviceTypes(...a),
    forecastModels: (...a: unknown[]) => forecastModels(...a),
  },
}));

const { KatalogBereich } = await import('./KatalogBereich');

/**
 * Plattform › Katalog (Scheibe S3): „Komponenten" ist entfallen (die Fassung
 * Soll/Ist wohnt jetzt in der Akte › Anlage), „Prognosemodelle" ist neu (N8).
 */
describe('KatalogBereich', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listComponentTemplates.mockResolvedValue([]);
    controlCertifications.mockResolvedValue([]);
    controlCandidates.mockResolvedValue([]);
    consumerDeviceTypes.mockResolvedValue([]);
    forecastModels.mockResolvedValue({ kinds: [], history: [] });
  });

  it('trägt drei Unter-Reiter: Gerätevorlagen, Steuerungs-Freigabe, Prognosemodelle', () => {
    window.location.hash = '#/plattform/katalog';
    render(<KatalogBereich />);
    const tabs = screen.getByRole('tablist', { name: 'Katalog' });
    expect(tabs).toHaveTextContent('Gerätevorlagen');
    expect(tabs).toHaveTextContent('Steuerungs-Freigabe');
    expect(tabs).toHaveTextContent('Prognosemodelle');
    expect(tabs).not.toHaveTextContent('Komponenten');
  });

  it('zeigt die Prognosemodelle-Sektion unter `?sektion=prognose`', async () => {
    window.location.hash = '#/plattform/katalog?sektion=prognose';
    render(<KatalogBereich />);
    expect(await screen.findByRole('heading', { name: 'Prognosemodelle' })).toBeInTheDocument();
    window.location.hash = '';
  });
});
