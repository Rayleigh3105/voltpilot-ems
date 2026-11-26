import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DirektvermarktungSection } from './DirektvermarktungSection';
import type { DirektvermarktungStatus } from '../direktvermarktung';
import type { Site } from '../api';

const direktvermarktung = vi.fn();
const netzVermarktung = vi.fn(() => Promise.resolve(null));

vi.mock('../apiVoll', () => ({
  api: {
    direktvermarktung: (...a: unknown[]) => direktvermarktung(...a),
    netzVermarktung: (...a: unknown[]) => netzVermarktung(...a),
  },
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
  netzVermarktung.mockReset();
  netzVermarktung.mockResolvedValue(null);
});

/** Relativ zur wirklichen Uhr des Testlaufs - ein fester Zeitstempel wäre flaky (Muster `e2e/direktvermarktung.spec.ts`). */
function vorSekunden(s: number): string {
  return new Date(Date.now() - s * 1000).toISOString();
}

describe('DirektvermarktungSection (Konzept vp-direktvermarktung-konzept d2 §7)', () => {
  it('ohne Anschluss: Startseite mit "Direktvermarkter wählen"', async () => {
    direktvermarktung.mockResolvedValue(status({}));
    render(<DirektvermarktungSection site={SITE} />);
    expect(await screen.findByRole('button', { name: 'Direktvermarkter wählen' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Direktvermarktung' })).toBeInTheDocument();
  });

  it('EZ-8-Abgleich: traegt die Anlage einen Direktvermarkter über die Anlagensteuerung, steht im Wählen-Schritt eine ruhige Zeile', async () => {
    direktvermarktung.mockResolvedValue(status({}));
    netzVermarktung.mockResolvedValue({
      site_id: SITE.id, netzbetreiber: null, direktvermarkter: 'Stadtwerke Nord',
      direktvermarkter_kanal: 'relais_ma', einspeisemanagement: null, einspeisemanagement_prozent: null,
      namen_aus_bild: null, hinweise: [], revision: 1,
    });
    render(<DirektvermarktungSection site={SITE} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Direktvermarkter wählen' }));
    expect(await screen.findByText(/Stadtwerke Nord/)).toBeInTheDocument();
    expect(screen.getByText(/über die Anlagensteuerung/)).toBeInTheDocument();
  });

  it('EZ-8-Abgleich: ohne ein solches Feld (oder Kanal "keiner") steht im Wählen-Schritt keine Zeile dazu', async () => {
    direktvermarktung.mockResolvedValue(status({}));
    netzVermarktung.mockResolvedValue({
      site_id: SITE.id, netzbetreiber: null, direktvermarkter: null, direktvermarkter_kanal: 'keiner',
      einspeisemanagement: null, einspeisemanagement_prozent: null, namen_aus_bild: null, hinweise: [], revision: 1,
    });
    render(<DirektvermarktungSection site={SITE} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Direktvermarkter wählen' }));
    await screen.findByText('Wer vermarktet Ihren Strom?');
    expect(screen.queryByText(/über die Anlagensteuerung/)).not.toBeInTheDocument();
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
        tunnelObenSeit: vorSekunden(300), handshakeAm: vorSekunden(10), gegenstelle: '10.44.0.1',
        letzteAbfrageAm: vorSekunden(12), abfragenJeMinute: 4, letzteSchreibungAm: vorSekunden(240),
        vorgabePct: 100, lebenszeichenAm: vorSekunden(12), einspeisungW: 12345, erzeugungW: 14100,
        netzbetreiberPct: 100, referenzW: 85000,
      },
    }));
    render(<DirektvermarktungSection site={SITE} />);
    expect(await screen.findByText('100')).toBeInTheDocument();
    expect(screen.getByText('%')).toBeInTheDocument();
    expect(screen.getByText('Haus', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/nicht geladen/i)).not.toBeInTheDocument();
  });

  it('bei einem Fehler zeigt sie eine Fehlermeldung statt zu verschwinden', async () => {
    direktvermarktung.mockRejectedValue(new Error('500'));
    render(<DirektvermarktungSection site={SITE} />);
    await waitFor(() => expect(screen.getByText(/konnte nicht geladen werden/)).toBeInTheDocument());
  });
});
