import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DirektvermarktungSection } from './DirektvermarktungSection';
import type { DirektvermarktungStatus } from '../direktvermarktung';
import { ApiError, type Site } from '../api';

const direktvermarktung = vi.fn();
const netzVermarktung = vi.fn(() => Promise.resolve(null));
const direktvermarktungZugangHochladen = vi.fn();

vi.mock('../apiVoll', () => ({
  api: {
    direktvermarktung: (...a: unknown[]) => direktvermarktung(...a),
    netzVermarktung: (...a: unknown[]) => netzVermarktung(...a),
    direktvermarktungZugangHochladen: (...a: unknown[]) => direktvermarktungZugangHochladen(...a),
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
  direktvermarktungZugangHochladen.mockReset();
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

  it('wartet_auf_zugang: Zugangsdatei hochladen ruft die API mit Datei und Passwort, Erfolg lädt den Stand neu', async () => {
    direktvermarktung.mockResolvedValueOnce(status({
      aktuell: {
        id: 'e1', partner: 'luox', zustand: 'wartet_auf_zugang', zustimmungAm: vorSekunden(500),
        zustimmungVon: 'kunde', startdatum: null, ende: null, revision: 1,
      },
      partner: { partner: 'luox', name: 'luox energy', vertragLink: null },
    }));
    const nachDemUpload = status({
      aktuell: {
        id: 'e1', partner: 'luox', zustand: 'verbindet', zustimmungAm: vorSekunden(500),
        zustimmungVon: 'kunde', startdatum: null, ende: null, revision: 1,
      },
      partner: { partner: 'luox', name: 'luox energy', vertragLink: null },
    });
    direktvermarktung.mockResolvedValueOnce(nachDemUpload);
    direktvermarktungZugangHochladen.mockResolvedValue({
      name: 'ABC_1234567', gueltigBis: '2027-11-26T00:00:00Z', fingerabdruck: 'ab:cd:ef',
    });
    render(<DirektvermarktungSection site={SITE} />);

    const datei = new File(['zip-inhalt'], 'ABC_1234567.zip', { type: 'application/zip' });
    const dateiInput = (await screen.findByLabelText('Zugangsdatei (.zip)')) as HTMLInputElement;
    fireEvent.change(dateiInput, { target: { files: [datei] } });
    const passwortInput = screen.getByLabelText('Passwort') as HTMLInputElement;
    fireEvent.change(passwortInput, { target: { value: 'geheim123' } });
    fireEvent.click(screen.getByRole('button', { name: /Datei hochladen/ }));

    await waitFor(() => expect(direktvermarktungZugangHochladen).toHaveBeenCalledWith(SITE.id, datei, 'geheim123'));
    await waitFor(() => expect(direktvermarktung).toHaveBeenCalledTimes(2));
  });

  it('wartet_auf_zugang: ohne Datei oder Passwort ruft sie die API nicht, sondern zeigt einen Hinweis', async () => {
    direktvermarktung.mockResolvedValue(status({
      aktuell: {
        id: 'e1', partner: 'luox', zustand: 'wartet_auf_zugang', zustimmungAm: vorSekunden(500),
        zustimmungVon: 'kunde', startdatum: null, ende: null, revision: 1,
      },
      partner: { partner: 'luox', name: 'luox energy', vertragLink: null },
    }));
    render(<DirektvermarktungSection site={SITE} />);
    fireEvent.click(await screen.findByRole('button', { name: /Datei hochladen/ }));
    expect(await screen.findByText('Bitte die .zip aus der E-Mail wählen.')).toBeInTheDocument();
    expect(direktvermarktungZugangHochladen).not.toHaveBeenCalled();
  });

  it('wartet_auf_zugang: falsches Passwort zeigt den Satz aus ZUGANG_FEHLER_SATZ, nicht die rohe Fehlermeldung', async () => {
    direktvermarktung.mockResolvedValue(status({
      aktuell: {
        id: 'e1', partner: 'luox', zustand: 'wartet_auf_zugang', zustimmungAm: vorSekunden(500),
        zustimmungVon: 'kunde', startdatum: null, ende: null, revision: 1,
      },
      partner: { partner: 'luox', name: 'luox energy', vertragLink: null },
    }));
    direktvermarktungZugangHochladen.mockRejectedValue(
      new ApiError(409, 'Das Passwort passt nicht.', { grund: 'passwort_falsch' }));
    render(<DirektvermarktungSection site={SITE} />);

    const datei = new File(['zip-inhalt'], 'ABC.zip', { type: 'application/zip' });
    fireEvent.change(await screen.findByLabelText('Zugangsdatei (.zip)'), { target: { files: [datei] } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'falsch' } });
    fireEvent.click(screen.getByRole('button', { name: /Datei hochladen/ }));

    expect(await screen.findByText('Das Passwort passt nicht. Bitte noch einmal.')).toBeInTheDocument();
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
