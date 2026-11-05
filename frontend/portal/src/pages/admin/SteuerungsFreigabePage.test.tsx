import { render, screen, waitFor, within } from '@testing-library/react';
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

const { SteuerungsFreigabePage, gemeinsameHinweise } = await import('./SteuerungsFreigabePage');

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

const anlage = (id: string, verdict: 'covered_not_activated' | null) => ({
  deviceId: id, tenantId: 't', siteId: `s-${id}`, siteName: `Anlage ${id}`, tenantName: 'Mandant', externalRef: `VP-${id}`,
  activated: false, platformCertVerdict: verdict, platformCertModel: null, certSource: null, activatedAt: null, activatedBy: null,
});

/** UI-Runde Admin: derselbe Grund an vielen Anlagen steht einmal, der Knopf ist nur bei „bereit“ laut. */
describe('SteuerungsFreigabePage - Anlagen ohne Wiederholung', () => {
  beforeEach(() => {
    window.location.hash = '';
    controlCertifications.mockResolvedValue([]);
    controlCandidates.mockResolvedValue([anlage('1', null), anlage('2', null), anlage('3', 'covered_not_activated')]);
    consumerDeviceTypes.mockResolvedValue([
      { type: 'wallbox', label: 'Wallbox', certificationStatus: 'simulator_only', certifiedAt: null, certificationNotes: 'Nur am Simulator (Runbook §5).', connectedCount: 0 },
    ]);
  });

  it('nennt den gemeinsamen Grund einmal über der Tabelle, nicht an jeder Zeile', async () => {
    render(<SteuerungsFreigabePage />);
    await screen.findByText('Anlage 1');
    expect(screen.getAllByText(/hat noch nicht gemeldet, ob sein Modell im Register steht/)).toHaveLength(1);
    expect(screen.getByText('(2)', { exact: false })).toBeInTheDocument();
    // Ein einmaliger Grund bleibt an seiner Zeile.
    expect(screen.getByText(/Es fehlt nur die Aktivierung für diese Anlage/)).toBeInTheDocument();
  });

  it('macht nur den Knopf der freigegebenen Anlage zur Hauptaktion', async () => {
    render(<SteuerungsFreigabePage />);
    const zeile = (await screen.findByText('Anlage 3')).closest('tr')!;
    expect(within(zeile).getByRole('button', { name: 'Steuerung aktivieren' }).className).toMatch(/primary/);
    const leise = screen.getByText('Anlage 1').closest('tr')!;
    expect(within(leise).getByRole('button', { name: 'Steuerung aktivieren' }).className).not.toMatch(/primary/);
  });

  it('klappt den Prüfstandsbeleg eines Gerätetyps erst auf Wunsch auf', async () => {
    render(<SteuerungsFreigabePage />);
    const beleg = await screen.findByText('Nur am Simulator (Runbook §5).');
    expect(beleg.closest('details')).not.toHaveAttribute('open');
  });
});

describe('gemeinsameHinweise', () => {
  it('zählt nur Gründe, die mindestens zweimal vorkommen', () => {
    expect(gemeinsameHinweise([
      { label: 'A', hint: 'x' }, { label: 'A', hint: 'x' }, { label: 'B', hint: 'y' }, { label: 'C', hint: '' }, { label: 'C', hint: '' },
    ])).toEqual([{ label: 'A', hint: 'x', anzahl: 2 }]);
  });
});
