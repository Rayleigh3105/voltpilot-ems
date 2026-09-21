import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, ApiError, type Device } from '../api';
import { GemeinsameSteuerungAbschnitt } from '../pages/AnlageTechnik';
import { setSelbstauskunft } from '../rollen';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { GS_IDS, gsBoxen, gsDatenquellen, gsEingerichtet, gsVorschlag, gsZustand, type GsLage } from '../test/gemeinsameSteuerungFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { FIXTURE_IDS } from '../test/standorteFixtures';
import { useGemeinsameSteuerung } from './GemeinsameSteuerungKarte';

const JETZT = new Date('2027-06-15T11:40:00Z');

function Karte({ siteId = FIXTURE_IDS.an1, boxen }: { siteId?: string; boxen: Device[] }) {
  const daten = useGemeinsameSteuerung(siteId, boxen);
  return <GemeinsameSteuerungAbschnitt siteId={siteId} siteDevices={boxen} daten={daten} jetzt={JETZT} />;
}

function stelle(lage: GsLage, opts: { verlust?: { kwh: number; gebunden_s: number; tage: number } } = {}) {
  vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
  vi.spyOn(api, 'gemeinsameSteuerung').mockResolvedValue(gsZustand(lage, opts.verlust ?? null));
  vi.spyOn(api, 'gemeinsameSteuerungEinrichten').mockResolvedValue(lage === 'nicht_eingerichtet' ? gsVorschlag() : gsEingerichtet());
  vi.spyOn(api, 'datenquellen').mockResolvedValue({ datenquellen: gsDatenquellen() });
}

beforeEach(() => setSelbstauskunft(rechteSeed('JW').me));
afterEach(() => {
  vi.restoreAllMocks();
  setSelbstauskunft(null);
});

describe('AP-15 IP-23 · Karte „Gemeinsame Steuerung“', () => {
  it('erscheint nicht an einer Anlage, die nur misst — auch mit zwei Boxen', async () => {
    stelle('nicht_eingerichtet');
    const boxen = gsBoxen(JETZT).map((b) => ({ ...b, siteId: FIXTURE_IDS.an2 }));
    render(<Karte siteId={FIXTURE_IDS.an2} boxen={boxen} />);
    await waitFor(() => expect(api.gemeinsameSteuerung).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Gemeinsame Steuerung')).toBeNull();
  });

  it('erscheint nicht an einer steuernden Anlage mit einer Box', async () => {
    stelle('nicht_eingerichtet');
    render(<Karte boxen={gsBoxen(JETZT).slice(0, 1)} />);
    await waitFor(() => expect(api.gemeinsameSteuerung).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Gemeinsame Steuerung')).toBeNull();
  });

  it('erscheint an einer steuernden Anlage mit zwei Boxen: Satz und Knopf „einrichten“', async () => {
    stelle('nicht_eingerichtet');
    render(<Karte boxen={gsBoxen(JETZT)} />);
    const karte = await screen.findByTestId('gemeinsame-steuerung');
    expect(karte).toHaveTextContent('Diese Anlage hat 2 Boxen. Mit der Gemeinsamen Steuerung hält jede Box ihren Teil der Grenze am Netzanschluss selbst ein.');
    expect(within(karte).getByRole('button', { name: 'Gemeinsame Steuerung einrichten' })).toBeInTheDocument();
    expect(within(karte).queryByRole('button', { name: /scharf/i })).toBeNull();
  });

  it('ohne Recht: Grund und Weg statt Knopf', async () => {
    const me = rechteSeed('JW').me;
    setSelbstauskunft({ ...me, standorte: me.standorte.map((s) => ({ ...s, rechte: s.rechte.filter((r) => r !== 'funktion.steuern_einrichten') })) });
    stelle('nicht_eingerichtet');
    render(<Karte boxen={gsBoxen(JETZT)} />);
    const karte = await screen.findByTestId('gemeinsame-steuerung');
    expect(within(karte).queryByRole('button', { name: 'Gemeinsame Steuerung einrichten' })).toBeNull();
    expect(within(karte).getByRole('note')).toBeInTheDocument();
  });

  it('aktiv: Zustandszeile, Box-Zeilen, Erklärung; ändern erst nach dem Anhalten', async () => {
    stelle('anteile_aktiv');
    render(<Karte boxen={gsBoxen(JETZT)} />);
    expect(await screen.findByTestId('gs-zustand')).toHaveTextContent('Gemeinsame Steuerung aktiv · 2 Boxen · Einspeisung höchstens 100 kW · Bezug höchstens 550 kW');
    await waitFor(() => expect(screen.getAllByTestId('gs-box')[1]).toHaveTextContent('hält ihren Anteil: Einspeisung 60 kW · Bezug 77 kW'));
    expect(screen.getByText(/Jede Box hält ihren Teil der Grenze selbst ein/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Gemeinsame Steuerung ändern' })).toBeNull();
    expect(screen.getByTestId('gs-erst-anhalten')).toHaveTextContent('halten Sie sie zuerst an');
  });

  it('Anhalten: nach Bestätigung POST …/anhalten', async () => {
    stelle('anteile_aktiv');
    const schritt = vi.spyOn(api, 'gemeinsameSteuerungSchritt').mockResolvedValue(gsZustand('angehalten'));
    render(<Karte boxen={gsBoxen(JETZT)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Anhalten' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Box Halle 1 steuert allein; alle Boxen halten weiter ihren Anteil.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Anhalten' }));
    await waitFor(() => expect(schritt).toHaveBeenCalledWith(FIXTURE_IDS.an1, 'anhalten'));
  });

  it('vom Betreiber angehalten: Grund und Weg, kein Knopf „Fortsetzen“', async () => {
    stelle('angehalten_betreiber');
    render(<Karte boxen={gsBoxen(JETZT)} />);
    expect(await screen.findByTestId('gs-betreiber')).toHaveTextContent('Fortsetzen kann nur VoltPilot');
    expect(screen.queryByRole('button', { name: 'Fortsetzen' })).toBeNull();
  });

  it('Ausfall-Satz A1 an der Box Verwaltung', async () => {
    stelle('anteile_aktiv');
    render(<Karte boxen={gsBoxen(JETZT, { verwaltungSeit: 30 * 60 })} />);
    expect(await screen.findByTestId('gs-ausfall')).toHaveTextContent('Box Verwaltung antwortet seit 13:10 nicht.');
  });

  it('Verlust-Zeile: kWh 0 zeigt die Stunden, kWh > 0 nur mit „mindestens“', async () => {
    stelle('anteile_aktiv', { verlust: { kwh: 0, gebunden_s: 32760, tage: 1 } });
    const { unmount } = render(<Karte boxen={gsBoxen(JETZT)} />);
    expect(await screen.findByTestId('gs-verlust')).toHaveTextContent('Heute 9,1 Stunden begrenzt, weil diese Box den Netzanschluss nicht sieht.');
    unmount();
    vi.restoreAllMocks();
    stelle('anteile_aktiv', { verlust: { kwh: 160.8, gebunden_s: 32760, tage: 1 } });
    render(<Karte boxen={gsBoxen(JETZT)} />);
    expect(await screen.findByTestId('gs-verlust')).toHaveTextContent('mindestens 160 kWh nicht erzeugt');
  });
});

describe('AP-15 IP-23 · Einrichten: die Lücke des Servers an ihrer Stelle', () => {
  it('422 erklaerung_unvollstaendig springt zu Frage 5 und markiert das Gerät', async () => {
    stelle('nicht_eingerichtet');
    vi.spyOn(api, 'gemeinsameSteuerungSetzen').mockRejectedValue(new ApiError(422, 'Erklärung unvollständig', {
      code: 'erklaerung_unvollstaendig', message: 'Erklärung unvollständig',
      fehlt: [{ wort: 'komponente', box_id: GS_IDS.e4, komponente_id: GS_IDS.k12 }],
    }));
    render(<Karte boxen={gsBoxen(JETZT)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Gemeinsame Steuerung einrichten' }));
    const folge = await screen.findByTestId('gs-folge');
    await within(folge).findByText('Frage 1 von 6 · Welche Boxen steuern mit?');
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    // Frage 2: ohne Datenquelle des Netzzählers geht es nicht weiter — die Lücke steht am Feld.
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await within(folge).findByText('Bitte die Datenquelle des Netzzählers wählen.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: /Datenquelle des Netzzählers/ }));
    fireEvent.click(screen.getByRole('option', { name: /DQ-2/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await within(folge).findByText('Frage 3 von 6 · Grenzen am Netzanschluss');
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await within(folge).findByText(/Frage 4 von 6/);
    fireEvent.click(screen.getByRole('combobox', { name: /Gibt es solche Erzeuger/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Keine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await within(folge).findByText(/Frage 5 von 6/);
    fireEvent.click(screen.getByRole('button', { name: 'Einrichten' }));
    // Der Speicher hat im Bestand keine Nennleistung: die Lücke steht an SEINEM Feld, nichts wird geschrieben.
    expect(await within(folge).findByText('Bitte die Nennleistung in kW angeben.')).toBeInTheDocument();
    expect(api.gemeinsameSteuerungSetzen).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Batteriespeicher 200 kWh · Bezug/), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Einrichten' }));
    await waitFor(() => expect(api.gemeinsameSteuerungSetzen).toHaveBeenCalledTimes(1));
    const feld = screen.getByLabelText(/PV-Wechselrichter Verwaltung 60 kW · Einspeisung/);
    await waitFor(() => expect(feld.closest('.vp-gs-geraet')).toHaveTextContent('Dieses Gerät fehlt noch in der Liste dieser Box.'));
  });
});
