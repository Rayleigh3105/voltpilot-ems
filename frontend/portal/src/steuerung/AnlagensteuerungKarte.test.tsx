import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  buettner,
  buettnerNv,
  buettnerWerte,
  gore,
  goreNv,
  goreWerte,
  JETZT,
  SITE_GORE,
} from '../test/anlagensteuerungFixtures';
import { AnlagensteuerungKarte, AnlagensteuerungKarten } from './AnlagensteuerungKarte';

/**
 * Steuerung › Geräte, Ansicht „nur messen“ an einer Erzeugeranlage (UEMS EZ-10 (1)): der Satz nennt, wer steuert,
 * je Einheit stehen Soll, Ist, „folgt“ und die Bereitschaft für den Direktvermarkter mit Grund.
 */
afterEach(() => vi.restoreAllMocks());

const now = new Date(JETZT);

describe('AnlagensteuerungKarte', () => {
  it('Büttner: Netzbetreiber und Direktvermarkter im Satz; je Motor Soll, Ist, folgt / folgt nicht, Grund für „nicht bereit“', () => {
    render(<AnlagensteuerungKarte steuerung={buettner()} werte={buettnerWerte()} nv={buettnerNv()} now={now} />);
    expect(
      screen.getByText(
        'VoltPilot liest diese Anlage nur. Gesteuert wird sie vom Netzbetreiber N-ERGIE Netz GmbH und vom Direktvermarkter WVV.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Die Anlage folgt der wirksamen Grenze gerade nicht.')).toBeInTheDocument();
    const [m1, m2] = screen.getAllByTestId('erz-einheit');
    expect(within(m1).getByText('Motor 1')).toBeInTheDocument();
    expect(m1.textContent).toContain('Soll 66,0');
    expect(m1.textContent).toContain('Ist 64,0');
    expect(within(m1).getByText('folgt')).toBeInTheDocument();
    expect(within(m1).getByText('vom Direktvermarkter abgerufen')).toBeInTheDocument();
    expect(within(m2).getByText('folgt nicht')).toBeInTheDocument();
    expect(within(m2).getByText('nicht bereit für den Direktvermarkter: Wartung, Gasspeicher leer')).toBeInTheDocument();
    expect(m2.textContent).toMatch(/zuletzt vor 5.Min\./);
  });

  it('Gore: ohne Direktvermarkter keine Bereitschaft; ein ungültiger Ist steht als „—“, nie als 0', () => {
    render(<AnlagensteuerungKarte steuerung={gore()} werte={goreWerte()} nv={goreNv()} now={now} />);
    expect(screen.getByText('VoltPilot liest diese Anlage nur. Gesteuert wird sie vom Netzbetreiber N-ERGIE Netz GmbH.')).toBeInTheDocument();
    expect(screen.queryByText(/Direktvermarkter/)).not.toBeInTheDocument();
    const wr3 = screen.getAllByTestId('erz-einheit')[2];
    expect(wr3.textContent).toContain('Ist —');
    expect(wr3.textContent).not.toMatch(/Ist 0/);
  });

  it('noch keine Daten: ein Satz statt Zahlen', () => {
    render(
      <AnlagensteuerungKarte
        steuerung={gore()}
        werte={{ geraet_id: gore().geraet_id, entity_id: gore().entity_id, stand: 'noch_keine_daten', abgerufen_am: JETZT, werte: [] }}
        nv={goreNv()}
        now={now}
      />,
    );
    expect(screen.getByText('Von dieser Steuerung liegen noch keine Daten vor.')).toBeInTheDocument();
    for (const z of screen.getAllByTestId('erz-einheit')) expect(within(z).getByText('noch keine Daten')).toBeInTheDocument();
  });

  it('ohne Anlagensteuerung (oder an einem älteren Backend) rendert die Fläche nichts', async () => {
    const liste = vi.spyOn(api, 'anlagensteuerungen').mockResolvedValue(null);
    vi.spyOn(api, 'netzVermarktung').mockResolvedValue(null);
    const { container } = render(<AnlagensteuerungKarten siteId={SITE_GORE} />);
    await waitFor(() => expect(liste).toHaveBeenCalledWith(SITE_GORE));
    expect(container).toBeEmptyDOMElement();
  });

  it('mit Anlagensteuerung: Liste, Stammdaten und Werte über die Routen von EZ-6', async () => {
    vi.spyOn(api, 'anlagensteuerungen').mockResolvedValue({
      einrichtung: { moeglich: true, grund: null, boxen: [] },
      steuerungen: [gore()],
    });
    vi.spyOn(api, 'netzVermarktung').mockResolvedValue(goreNv());
    const werte = vi.spyOn(api, 'anlagensteuerungWerte').mockResolvedValue(goreWerte());
    render(<AnlagensteuerungKarten siteId={SITE_GORE} now={now} />);
    expect(await screen.findByText('Anlagensteuerung Gore')).toBeInTheDocument();
    await waitFor(() => expect(werte).toHaveBeenCalledWith(SITE_GORE, gore().geraet_id));
    expect(await screen.findByText('Die Anlage folgt der wirksamen Grenze.')).toBeInTheDocument();
  });
});

describe('AnlagensteuerungKarte — je Einheit auf ihre Seite (GE-3)', () => {
  it('der Name jeder Einheit ist ein Weg auf ihre Seite; ohne Weg bleibt er Text', () => {
    const { unmount } = render(
      <AnlagensteuerungKarte
        steuerung={gore()}
        werte={goreWerte()}
        nv={goreNv()}
        now={now}
        einheitHref={(teNr) => (teNr === 3 ? null : `#/einheit/${teNr}`)}
      />,
    );
    const links = screen.getAllByTestId('erz-einheit-link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['WR Dach Nord', '#/einheit/1'],
      ['Wechselrichter 2', '#/einheit/2'],
    ]);
    expect(within(screen.getAllByTestId('erz-einheit')[2]).getByText('Wechselrichter 3').closest('a')).toBeNull();
    unmount();
    render(<AnlagensteuerungKarte steuerung={gore()} werte={goreWerte()} nv={goreNv()} now={now} />);
    expect(screen.queryByTestId('erz-einheit-link')).not.toBeInTheDocument();
  });
});
