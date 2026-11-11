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
 * Seite mehr, sondern eine Sektion hier - dieselbe Betreiber-Frage („was
 * dürfen wir steuern?"), nur für die andere Geräteklasse.
 *
 * Konzept `vp-adminview-konzept-k1`, Scheibe S3: der Abschnitt „Anlagen"
 * (Scharfschalten je Box) ist in den Reiter „Anlage" der Geräteakte umgezogen
 * (`GeraeteAktePage.test.tsx` deckt ihn dort ab); diese Seite bleibt das
 * Register plus die read-only Gerätetypen-Sektion.
 */
describe('SteuerungsFreigabePage - Register und Gerätetypen', () => {
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

  it('trägt Register und Gerätetypen, aber keine Anlagen-Sektion mehr', async () => {
    render(<SteuerungsFreigabePage />);
    expect(await screen.findByRole('heading', { name: 'Freigegebene Modelle' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Anlagen' })).toBeNull();
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
    await screen.findByRole('heading', { name: 'Freigegebene Modelle' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reißt den Register-Abschnitt NICHT mit, wenn der Gerätetypen-Katalog ausfällt', async () => {
    consumerDeviceTypes.mockRejectedValue(new Error('boom'));
    render(<SteuerungsFreigabePage />);
    // Die eigene, fail-soft Meldung der Sektion …
    expect(
      await screen.findByText(/Gerätetypen konnten nicht geladen werden/i),
    ).toBeInTheDocument();
    // … und die Seite steht trotzdem.
    expect(screen.getByRole('heading', { name: 'Freigegebene Modelle' })).toBeInTheDocument();
  });

  it('nennt die aktivierten Anlagen als EIN Aggregat über dem Register', async () => {
    controlCertifications.mockResolvedValue([
      { brand: 'deye', model: 'SUN-30K', family: 'hybrid_3p', controlPath: null, invertControlSign: null, firmwareNote: null, note: null, certifiedAt: '2026-01-01T00:00:00Z' },
    ]);
    controlCandidates.mockResolvedValue([
      { deviceId: '1', tenantId: 't', siteId: 's-1', siteName: 'Anlage 1', tenantName: 'Mandant', externalRef: 'VP-1', activated: true, platformCertVerdict: null, platformCertModel: null, certSource: 'platform', activatedAt: null, activatedBy: null },
    ]);
    render(<SteuerungsFreigabePage />);
    expect(await screen.findByText(/1 Modell freigegeben · 1 Anlage aktiviert/)).toBeInTheDocument();
  });
});
