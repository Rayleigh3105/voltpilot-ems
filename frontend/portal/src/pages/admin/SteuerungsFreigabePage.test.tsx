import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const controlCertifications = vi.fn();
const controlCandidates = vi.fn();
const consumerDeviceTypes = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    controlCertifications: () => controlCertifications(),
    controlCandidates: () => controlCandidates(),
    consumerDeviceTypes: () => consumerDeviceTypes(),
    certifyControlModel: vi.fn(),
    revokeControlModel: vi.fn(),
    activateControl: vi.fn(),
    deactivateControl: vi.fn(),
  },
}));

const { SteuerungsFreigabePage } = await import('./SteuerungsFreigabePage');

/**
 * Admin-Umbau Stufe 3 (Captain-Entscheid F4): „Gerätetypen" ist keine eigene
 * Seite mehr, sondern die dritte Sektion hier - dieselbe Betreiber-Frage
 * („was dürfen wir steuern?"), nur für die andere Geräteklasse.
 */
describe('SteuerungsFreigabePage - die drei Sektionen', () => {
  beforeEach(() => {
    window.location.hash = '';
    controlCertifications.mockResolvedValue([]);
    controlCandidates.mockResolvedValue([]);
    consumerDeviceTypes.mockResolvedValue([
      {
        type: 'wallbox',
        label: 'Wallbox',
        certificationStatus: 'simulator_only',
        certifiedAt: null,
        certificationNotes: null,
        connectedCount: 2,
      },
    ]);
  });

  it('trägt die Gerätetypen als dritte Sektion', async () => {
    render(<SteuerungsFreigabePage />);
    expect(await screen.findByRole('heading', { name: 'Freigegebene Modelle' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Anlagen' })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Steuerbare Gerätetypen' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Wallbox')).toBeInTheDocument();
    // Read-only: auf dieser Geräteklasse gibt es nichts umzuschalten.
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('springt zur Sektion, wenn ein altes Gerätetypen-Lesezeichen sie nennt', async () => {
    // `#/geraetetypen` wird auf `?sektion=geraetetypen` umgeschrieben. Ohne den
    // Sprung stünde der Betreiber oben auf einer Seite, deren Inhalt er nicht
    // sucht - und die Faltung wäre für ihn ein Verlust.
    const jumped: string[] = [];
    const spy = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(function (this: Element) {
        jumped.push(this.id);
      });
    window.location.hash = '#/steuerungs-freigabe?sektion=geraetetypen';
    render(<SteuerungsFreigabePage />);
    await waitFor(() => expect(jumped).toContain('sektion-geraetetypen'));
    spy.mockRestore();
  });

  it('springt NICHT, wenn kein Anker in der Adresse steht', async () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    render(<SteuerungsFreigabePage />);
    await screen.findByRole('heading', { name: 'Anlagen' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reißt die Wechselrichter-Abschnitte NICHT mit, wenn der Katalog ausfällt', async () => {
    consumerDeviceTypes.mockRejectedValue(new Error('boom'));
    render(<SteuerungsFreigabePage />);
    // Die eigene, fail-soft Meldung der Sektion …
    expect(
      await screen.findByText(/Gerätetypen konnten nicht geladen werden/i),
    ).toBeInTheDocument();
    // … und die Seite steht trotzdem.
    expect(screen.getByRole('heading', { name: 'Freigegebene Modelle' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Anlagen' })).toBeInTheDocument();
  });
});
