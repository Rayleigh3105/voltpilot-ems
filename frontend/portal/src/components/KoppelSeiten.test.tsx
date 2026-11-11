import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Device, type Site } from '../api';
import { KOPPEL_VORMERKER, merkeKoppelRef, offeneKoppelRef } from '../koppelLink';
import { AnlageFlow } from './AnlageFlow';
import { BoxFremdKonto } from './BoxVerbunden';
import { BoxWeg, WEG_TAKT_MS } from '../boxweg/BoxWeg';
import { AddDeviceDrawer } from './DeviceDrawers';
import { KoppelEmpfang } from './KoppelEmpfang';
import { KoppelSeite } from './KoppelSeite';

/**
 * Die Seiten nach dem Scan des Gehäuse-QR (Konzept vp-qr-einstieg, entschieden 04.11.2026: QE-1 A,
 * QE-2 A, QE-3 B, QE-4 A, QE-5 A). Fiktive Kennung edge-k7m2xq3, fiktive Anlage „Zuhause“.
 */
const REF = 'edge-k7m2xq3';

const site: Site = { id: 's-1', name: 'Zuhause', biddingZone: 'DE-LU', latitude: null, longitude: null } as unknown as Site;
const zweite: Site = { ...site, id: 's-2', name: 'Ferienhaus' };

function box(teil: Partial<Device> = {}): Device {
  return {
    id: 'd-1',
    siteId: 's-1',
    externalRef: REF,
    kind: 'edge',
    name: null,
    status: 'claimed',
    lastSeenAt: null,
    createdAt: new Date().toISOString(),
    ...teil,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('M1/M2 · Empfang ohne Sitzung (QE-1 A)', () => {
  it('zeigt die Kennung wie gedruckt, drei Schritte, was bereitliegt - und fragt keinen Server', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const konto = vi.fn();
    const anmelden = vi.fn();
    render(<KoppelEmpfang kennung={REF} onKontoErstellen={konto} onAnmelden={anmelden} />);
    expect(screen.getByRole('heading', { name: 'Ihre VoltPilot-Box ist da' })).toBeInTheDocument();
    expect(screen.getByText('EDGE-K7M2XQ3')).toBeInTheDocument();
    expect(screen.getByText('Steht auch unten auf Ihrer Box.')).toBeInTheDocument();
    for (const s of ['Konto erstellen oder anmelden', 'Adresse Ihrer Anlage eintragen', 'Box verbinden']) {
      expect(screen.getByText(s)).toBeInTheDocument();
    }
    expect(screen.getByText(/Passwort mit mindestens 12 Zeichen/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Konto erstellen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ich habe schon ein Konto' }));
    expect(konto).toHaveBeenCalledTimes(1);
    expect(anmelden).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('M2: ein unlesbarer Code fragt nach der Kennung vom Aufdruck, rechnet nur das Prüfzeichen und merkt sie sich', () => {
    render(<KoppelEmpfang kennung={null} onKontoErstellen={() => {}} onAnmelden={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Dieser Code ist nicht vollständig lesbar' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Kennung'), { target: { value: 'EDGE-K7M2XQ1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(screen.getByText(/Diese Kennung stimmt nicht/)).toBeInTheDocument();
    expect(offeneKoppelRef()).toBeNull();
    fireEvent.change(screen.getByLabelText('Kennung'), { target: { value: 'EDGE-K7M2XQ3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(screen.getByRole('heading', { name: 'Ihre VoltPilot-Box ist da' })).toBeInTheDocument();
    expect(offeneKoppelRef()).toBe(REF);
  });
});

describe('Der Weg (E1 = B, vp-box-verbinden-konzept) · fünf Stationen statt online/wartet', () => {
  it('startet, meldet die Anmeldung, und geht von selbst auf „Ihre Box ist online“ über', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const liste = vi.spyOn(api, 'listDevices').mockResolvedValue({ eintraege: [box()], teilansicht: null } as never);
    const weiter = vi.fn();
    render(<BoxWeg box={box()} anlageName="Zuhause" onWeiter={weiter} onSpaeter={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Ihre Box startet' })).toBeInTheDocument();
    expect(screen.getByText('Meist ist sie 2½ Minuten nach dem Einstecken online.')).toBeInTheDocument();
    expect(screen.getByText('Letzter Kontakt: noch keiner')).toBeInTheDocument();
    expect(screen.queryByText(/meldet sich\./)).toBeNull();
    expect(screen.queryByText(/Seit 15 Minuten/)).toBeNull();

    liste.mockResolvedValue({
      eintraege: [box({ anmeldung: { zuletztAngefragtAm: new Date().toISOString(), schluesselAbgeholtAm: new Date().toISOString() }, lastSeenAt: new Date().toISOString() })],
      teilansicht: null,
    } as never);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WEG_TAKT_MS);
    });
    expect(await screen.findByRole('heading', { name: 'Ihre Box ist online' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter: Ihre Anlage' }));
    expect(weiter).toHaveBeenCalled();
  });

  it('ab 5:00 ohne Signal: Bitte prüfen mit den drei Fragen, Station Box startet wird zum Problem', () => {
    vi.spyOn(api, 'listDevices').mockResolvedValue({ eintraege: [], teilansicht: null } as never);
    const alt = box({ createdAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() });
    render(<BoxWeg box={alt} anlageName="Zuhause" onSpaeter={() => {}} />);
    expect(screen.getByText('Das Netzteil steckt in der Buchse „5V“ und in der Steckdose.')).toBeInTheDocument();
    expect(screen.getByText('Steht unten auf Ihrer Box dieselbe Kennung?')).toBeInTheDocument();
    expect(screen.queryByText(/Seit 15 Minuten/)).toBeNull();
  });

  it('nach 15 Minuten ohne Lebenszeichen der Weg zum Support, mit der Kennung', () => {
    vi.spyOn(api, 'listDevices').mockResolvedValue({ eintraege: [], teilansicht: null } as never);
    const alt = box({ createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() });
    render(<BoxWeg box={alt} anlageName="Zuhause" onSpaeter={() => {}} />);
    expect(
      screen.getByText('Seit 15 Minuten kein Lebenszeichen von der Box, die jetzt zur Anlage „Zuhause“ gehört. Schreiben Sie uns mit der Kennung EDGE-K7M2XQ3, wir sehen nach.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Support kontaktieren/ })).toHaveAttribute('href', expect.stringContaining('kontakt'));
  });

  it('Anmeldung da, aber 75 s später noch kein Herzschlag: "Die Datenverbindung kommt nicht durch"', () => {
    vi.spyOn(api, 'listDevices').mockResolvedValue({ eintraege: [], teilansicht: null } as never);
    const gesperrt = box({ anmeldung: { zuletztAngefragtAm: new Date(Date.now() - 80 * 1000).toISOString(), schluesselAbgeholtAm: new Date(Date.now() - 80 * 1000).toISOString() } });
    render(<BoxWeg box={gesperrt} anlageName="Zuhause" onSpaeter={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Die Datenverbindung kommt nicht durch' })).toBeInTheDocument();
  });
});

describe('M11 · Box mit anderem Konto verbunden (QE-5 A)', () => {
  it('nennt kein Konto, aber Gründe, die Kennung zum Kopieren und den Weg weiter', () => {
    const andere = vi.fn();
    render(<BoxFremdKonto kennung={REF} onAndere={andere} />);
    expect(screen.getByRole('heading', { name: 'Diese Box ist schon mit einem anderen Konto verbunden' })).toBeInTheDocument();
    expect(screen.getByText('Mit welchem, zeigen wir aus Datenschutzgründen nicht.')).toBeInTheDocument();
    expect(screen.getByText('Ihr Installateur hat die Box in seinem Konto eingerichtet.')).toBeInTheDocument();
    expect(screen.getByText('EDGE-K7M2XQ3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kopieren' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Andere Kennung eingeben' }));
    expect(andere).toHaveBeenCalled();
  });
});

describe('M10/M12 und Wahl der Anlage (QE-2 A)', () => {
  const wege = { onAnlage: vi.fn(), onBoxAnsehen: vi.fn(), onCockpit: vi.fn(), onSchliessen: vi.fn() };

  it('Wahl: jede Anlage ist ein Knopf, verbunden wird erst im Aufbau', () => {
    render(<KoppelSeite seite={{ art: 'wahl' }} kennung={REF} sites={[site, zweite]} devices={[]} kundenadministratoren={[]} {...wege} />);
    expect(screen.getByRole('heading', { name: 'An welcher Anlage steht die Box?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ferienhaus' }));
    expect(wege.onAnlage).toHaveBeenCalledWith('s-2');
  });

  it('M10: die Box steht schon in der eigenen Liste - Anlage und letzter Kontakt, nichts mehr zu tun', () => {
    const eigene = box({ lastSeenAt: new Date(Date.now() - 2 * 60 * 1000).toISOString() });
    render(
      <KoppelSeite seite={{ art: 'schonDeins', deviceId: 'd-1', siteId: 's-1' }} kennung={REF} sites={[site]} devices={[eigene]} kundenadministratoren={[]} {...wege} />,
    );
    expect(screen.getByRole('heading', { name: 'Diese Box gehört schon zu Ihnen' })).toBeInTheDocument();
    expect(screen.getByText('EDGE-K7M2XQ3 ist mit Ihrer Anlage „Zuhause“ verbunden. Es ist nichts mehr zu tun.')).toBeInTheDocument();
    expect(screen.getByText(/Verbunden · Letzter Kontakt/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Box ansehen' }));
    expect(wege.onBoxAnsehen).toHaveBeenCalledWith('s-1');
  });

  it('M12: ohne Recht nennt die Seite die Kundenadministratoren aus der Selbstauskunft', () => {
    render(
      <KoppelSeite seite={{ art: 'ohneRecht' }} kennung={REF} sites={[site]} devices={[]} kundenadministratoren={[{ name: 'Erika Kaiser' }]} {...wege} />,
    );
    expect(screen.getByRole('heading', { name: 'Für das Verbinden fehlt Ihnen das Recht' })).toBeInTheDocument();
    expect(screen.getByText('Bitten Sie eine dieser Personen, die Box EDGE-K7M2XQ3 zu verbinden:')).toBeInTheDocument();
    expect(screen.getByText('Erika Kaiser')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zur Übersicht' }));
    expect(wege.onSchliessen).toHaveBeenCalled();
  });
});

describe('M6 · Assistent, Schritt „Box“ mit der Kennung aus dem QR-Code', () => {
  beforeEach(() => {
    vi.spyOn(api, 'funktionen').mockResolvedValue({ unternehmen: { messen: { laeuft_an: 0, standorte: 0, text: null }, steuern: { laeuft_an: 0, standorte: 0, text: null } }, standorte: [] } as never);
    vi.spyOn(api, 'tenantContext').mockRejectedValue(new Error('aus'));
    vi.spyOn(api, 'listDevices').mockResolvedValue({ eintraege: [], teilansicht: null } as never);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    vi.spyOn(api, 'siteEntities').mockResolvedValue({ registry: null, entities: [], localSetup: [], staleOnDevice: [] } as never);
  });

  it('sagt, woher die Kennung kommt, verbindet erst auf Knopfdruck und vergisst sie danach', async () => {
    merkeKoppelRef(REF);
    const claim = vi.spyOn(api, 'claimDevice').mockResolvedValue(box());
    render(<AnlageFlow sites={[site]} wirt="assistent" vorschlagKennung={REF} onDone={() => {}} />);
    expect(await screen.findByText(/Die Kennung ist schon eingetragen, aus dem QR-Code/)).toBeInTheDocument();
    expect(screen.getByText('Kennung stimmt · aus dem QR-Code')).toBeInTheDocument();
    expect(screen.getByText('Wir merken uns die Kennung bis morgen in diesem Browser.')).toBeInTheDocument();
    expect(claim).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Box verbinden' }));
    expect(await screen.findByRole('heading', { name: 'Ihre Box startet' })).toBeInTheDocument();
    expect(claim).toHaveBeenCalledWith('s-1', REF, expect.any(String));
    expect(offeneKoppelRef()).toBeNull();
    expect(localStorage.getItem(KOPPEL_VORMERKER)).toBeNull();
  });

  it('„später verbinden“ behält die Kennung bis morgen (QE-3 B)', async () => {
    merkeKoppelRef(REF);
    render(<AnlageFlow sites={[site]} wirt="assistent" vorschlagKennung={REF} onDone={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Box ist noch nicht da – später verbinden' }));
    expect(offeneKoppelRef()).toBe(REF);
  });

  it('409: eine eigene Seite statt einer roten Zeile; „Andere Kennung eingeben“ leert das Feld', async () => {
    merkeKoppelRef(REF);
    vi.spyOn(api, 'claimDevice').mockRejectedValue(new ApiError(409, 'taken'));
    render(<AnlageFlow sites={[site]} wirt="assistent" vorschlagKennung={REF} onDone={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Box verbinden' }));
    expect(await screen.findByRole('heading', { name: 'Diese Box ist schon mit einem anderen Konto verbunden' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Andere Kennung eingeben' }));
    expect(screen.getByLabelText('Kennung')).toHaveValue('');
    expect(offeneKoppelRef()).toBeNull();
  });
});

describe('M7 · Aufbau-Blatt „VoltPilot-Box hinzufügen“ mit QR-Band', () => {
  it('nennt die Herkunft der Kennung, hilft bei mehreren Anlagen und vergisst sie beim Abbrechen', () => {
    merkeKoppelRef(REF);
    const zu = vi.fn();
    render(<AddDeviceDrawer open onClose={zu} sites={[site, zweite]} onClaimed={() => {}} vorschlag={REF} />);
    const blatt = screen.getByRole('dialog');
    expect(within(blatt).getByText('Aus dem QR-Code: EDGE-K7M2XQ3')).toBeInTheDocument();
    expect(within(blatt).getByText('Hier stehen zwei Anlagen zur Wahl. Wählen Sie die, an der die Box steht.')).toBeInTheDocument();
    fireEvent.click(within(blatt).getByRole('button', { name: 'Abbrechen' }));
    expect(zu).toHaveBeenCalled();
    expect(offeneKoppelRef()).toBeNull();
  });

  it('nach dem Verbinden das ehrliche Ergebnis; die Kennung ist vergessen', async () => {
    merkeKoppelRef(REF);
    vi.spyOn(api, 'claimDevice').mockResolvedValue(box());
    vi.spyOn(api, 'listDevices').mockResolvedValue({ eintraege: [], teilansicht: null } as never);
    render(<AddDeviceDrawer open onClose={() => {}} sites={[site]} onClaimed={() => {}} vorschlag={REF} />);
    fireEvent.click(screen.getByRole('button', { name: 'VoltPilot-Box hinzufügen' }));
    expect(await screen.findByRole('heading', { name: 'Ihre Box startet' })).toBeInTheDocument();
    await waitFor(() => expect(offeneKoppelRef()).toBeNull());
  });
});
