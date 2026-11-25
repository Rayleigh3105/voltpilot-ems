import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DirektvermarktungSection } from './DirektvermarktungSection';
import type { DirektvermarktungStatus } from '../direktvermarktung';
import type { Site } from '../api';

const direktvermarktung = vi.fn();

vi.mock('../apiVoll', () => ({
  api: { direktvermarktung: (...a: unknown[]) => direktvermarktung(...a) },
}));

const SITE = { id: 'site-1', name: 'Haus Dachau' } as Site;

function status(partial: Partial<DirektvermarktungStatus>): DirektvermarktungStatus {
  return {
    aktuell: null,
    geplant: null,
    partner: null,
    geplanterPartner: null,
    stand: null,
    verlaufKurz: [],
    katalog: [{ partner: 'luox', name: 'luox energy', vertragLink: 'https://example.invalid/erloes' }],
    darf: true,
    ...partial,
  };
}

beforeEach(() => {
  direktvermarktung.mockReset();
});

describe('DirektvermarktungSection (Konzept vp-direktvermarktung-konzept d2 §7)', () => {
  it('ohne Anschluss: Startseite mit "Direktvermarkter wählen"', async () => {
    direktvermarktung.mockResolvedValue(status({}));
    render(<DirektvermarktungSection site={SITE} />);
    expect(await screen.findByRole('button', { name: 'Direktvermarkter wählen' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Direktvermarktung' })).toBeInTheDocument();
  });

  it('im Entwurf: Fortschritt zeigt Station 1 (Gewählt) aktiv, Knopf "Zustimmen"', async () => {
    direktvermarktung.mockResolvedValue(status({
      aktuell: {
        id: 'e1', partner: 'luox', zustand: 'entwurf', zustimmungAm: null, zustimmungVon: null,
        startdatum: null, ende: null, revision: 1,
      },
      partner: { partner: 'luox', name: 'luox energy', vertragLink: null },
    }));
    render(<DirektvermarktungSection site={SITE} />);
    expect(await screen.findByRole('button', { name: 'Zustimmen' })).toBeInTheDocument();
    expect(screen.getByText('Einrichtung mit luox energy')).toBeInTheDocument();
  });

  it('verbunden: zeigt die Freigabe in Prozent und keinen Fehler', async () => {
    direktvermarktung.mockResolvedValue(status({
      aktuell: {
        id: 'e1', partner: 'luox', zustand: 'verbunden', zustimmungAm: '2026-11-20T10:00:00Z',
        zustimmungVon: 'kunde', startdatum: '2026-11-21', ende: null, revision: 1,
      },
      partner: { partner: 'luox', name: 'luox energy', vertragLink: null },
      stand: {
        tunnelObenSeit: '2026-11-25T11:55:00Z', handshakeAm: '2026-11-25T11:59:50Z', gegenstelle: '10.44.0.1',
        letzteAbfrageAm: '2026-11-25T11:59:40Z', abfragenJeMinute: 4, letzteSchreibungAm: '2026-11-25T11:58:00Z',
        vorgabePct: 100, lebenszeichenAm: '2026-11-25T11:59:40Z', einspeisungW: 12345, erzeugungW: 14100,
        netzbetreiberPct: 100, referenzW: 85000,
      },
    }));
    render(<DirektvermarktungSection site={SITE} />);
    expect(await screen.findByText('100 %')).toBeInTheDocument();
    expect(screen.queryByText(/nicht geladen/i)).not.toBeInTheDocument();
  });

  it('bei einem Fehler zeigt sie eine Fehlermeldung statt zu verschwinden', async () => {
    direktvermarktung.mockRejectedValue(new Error('500'));
    render(<DirektvermarktungSection site={SITE} />);
    await waitFor(() => expect(screen.getByText(/konnte nicht geladen werden/)).toBeInTheDocument());
  });
});
