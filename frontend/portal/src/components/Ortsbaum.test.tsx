import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { LEER_SATZ } from '../ortsbaum';
import {
  ortNachSchreiben,
  ortsbaumAhrenberg,
  ortsbaumLindachOhneGebaeude,
  verwaltung,
} from '../test/ortsbaumFixtures';
import { werkAhrenberg, werkLindach } from '../test/standorteFixtures';
import { Ortsbaum } from './Ortsbaum';

/** Geschütztes Leerzeichen (U+00A0). */
const NB = String.fromCharCode(160);

/** Der Ortsbaum „Standort › Gebäude“ (UEMS AP-02 IP-7, T3/L1) mit den Antworten des Referenzunternehmens. */

afterEach(() => {
  vi.restoreAllMocks();
});

const namen = () =>
  [...document.querySelectorAll('.vp-ob-knoten')].map((li) => li.querySelector('.vp-ob-name')?.textContent);

describe('Ortsbaum', () => {
  it('Werk Ahrenberg: Gebäude mit Bereichen, „Direkt am Standort“ zuletzt, Zeilen mit Fläche und Messstellen', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ortsbaumAhrenberg());
    render(<Ortsbaum standort={werkAhrenberg()} />);
    await screen.findByRole('button', { name: 'Halle 1 bearbeiten' });
    expect(api.standortOrte).toHaveBeenCalledWith(werkAhrenberg().id);
    expect(namen()).toEqual([
      'Halle 1G-1',
      'Halle 1 NordB-1',
      'Halle 1 SüdB-2',
      'Halle 2G-2',
      'Halle 2 MontageB-3',
      'Halle 2 SpritzgussB-4',
      'Halle 2 LagerB-5',
      'VerwaltungG-3',
      'Direkt am Standort',
    ]);
    expect(screen.getAllByTestId('datenlage').map((d) => d.textContent)).toEqual([
      `6${NB}Messstellen`,
      `1${NB}Messstelle`,
      `3${NB}Messstellen`,
      `5${NB}Messstellen`,
      `1${NB}Messstelle`,
      `1${NB}Messstelle`,
      `1${NB}Messstelle`,
      `2${NB}Messstellen`,
      `3${NB}Messstellen`,
    ]);
    expect(document.body.textContent).toContain(`Produktion · Montage · Lager · 3${NB}100${NB}m² · 2019`);
    // Der Zweig „Direkt am Standort“ ist kein Objekt: kein Stift.
    expect(screen.getAllByRole('button', { name: /bearbeiten$/ })).toHaveLength(8);
    expect(screen.queryByTestId('ortsbaum-leer')).toBeNull();
    expect(screen.getByRole('button', { name: 'Gebäude anlegen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bereich anlegen' })).toBeInTheDocument();
  });

  it('L1: der Hinweis Zeichen für Zeichen mit beiden Wegen; „Bereich direkt am Standort anlegen“ wählt den Standort vor', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ortsbaumLindachOhneGebaeude());
    render(<Ortsbaum standort={werkLindach()} />);
    const leer = await screen.findByTestId('ortsbaum-leer');
    expect(leer.querySelector('.vp-ob-leer-satz')?.textContent).toBe(LEER_SATZ);
    expect(within(leer).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Gebäude anlegen',
      'Bereich direkt am Standort anlegen',
    ]);
    // Oben keine zweiten „anlegen“-Knöpfe neben dem Leerzustand.
    expect(screen.getAllByRole('button', { name: 'Gebäude anlegen' })).toHaveLength(1);
    fireEvent.click(within(leer).getByRole('button', { name: 'Bereich direkt am Standort anlegen' }));
    const dialog = screen.getByRole('dialog', { name: 'Bereich anlegen' });
    expect(within(dialog).getByRole('combobox', { name: 'Hängt an *' }).textContent).toContain(
      'Direkt am Standort Werk Lindach',
    );
  });

  it('Gebäude ohne Fläche: „für kWh/m² fehlt die Fläche — Fläche eintragen“ öffnet den Dialog an der Fläche', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(
      ortsbaumAhrenberg({ gebaeude: [verwaltung({ flaecheM2: null, flaecheQuelle: null })] }),
    );
    render(<Ortsbaum standort={werkAhrenberg()} />);
    const knopf = await screen.findByRole('button', { name: 'Fläche eintragen: Verwaltung' });
    expect(knopf.closest('p')?.textContent).toBe('für kWh/m² fehlt die Fläche — Fläche eintragen');
    fireEvent.click(knopf);
    expect(screen.getByRole('dialog', { name: 'Gebäude bearbeiten' })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Bezugsfläche (m²)')));
  });

  it('ein archivierter Standort bietet nichts zum Anlegen oder Bearbeiten an', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ortsbaumAhrenberg());
    render(<Ortsbaum standort={werkAhrenberg({ zustand: 'archiviert' })} />);
    await screen.findByText('Halle 1');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('nach dem Speichern wird der Baum neu gelesen und die Seite benachrichtigt; Abbrechen gibt den Fokus zurück', async () => {
    const lesen = vi.spyOn(api, 'standortOrte').mockResolvedValue(ortsbaumAhrenberg());
    vi.spyOn(api, 'ortBearbeiten').mockResolvedValue(ortNachSchreiben());
    const geaendert = vi.fn();
    render(<Ortsbaum standort={werkAhrenberg()} onGeaendert={geaendert} />);
    const stift = await screen.findByRole('button', { name: 'Halle 2 bearbeiten' });
    stift.focus();
    fireEvent.click(stift);
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(stift));
    fireEvent.click(stift);
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(geaendert).toHaveBeenCalled());
    expect(lesen).toHaveBeenCalledTimes(2);
  });

  it('ein Ladefehler bietet „Erneut versuchen“ an', async () => {
    const lesen = vi.spyOn(api, 'standortOrte').mockRejectedValueOnce(new Error('Nicht gefunden'));
    lesen.mockResolvedValueOnce(ortsbaumAhrenberg());
    render(<Ortsbaum standort={werkAhrenberg()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByText('Halle 1')).toBeInTheDocument();
  });
});

describe('Ortsbaum · AP-13 IP-2: die Hülle der Karte je Gebäude', () => {
  it('ohne Inhalt kein Aufklapper — so steht der Baum heute auf „Standort › Gebäude“', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ortsbaumAhrenberg());
    render(<Ortsbaum standort={werkAhrenberg()} titelVersteckt gebaeudeKarte={() => null} />);
    await screen.findByRole('button', { name: 'Halle 1 bearbeiten' });
    expect(screen.queryByRole('button', { name: /Karte aufklappen$/ })).toBeNull();
    expect(screen.queryByTestId('gebaeude-karte')).toBeNull();
    // Die Seite nennt „Gebäude“ schon — der Baum behält die Überschrift nur für Screenreader.
    expect(screen.getByRole('heading', { name: 'Gebäude' })).toHaveClass('vp-sr-only');
  });

  it('mit Inhalt klappt jedes Gebäude seine Karte auf — Bereiche und „Direkt am Standort“ bekommen keine', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ortsbaumAhrenberg());
    render(<Ortsbaum standort={werkAhrenberg()} gebaeudeKarte={(g) => <p>Blöcke von {g.name}</p>} />);
    await screen.findByRole('button', { name: 'Halle 1 bearbeiten' });
    expect(screen.getByRole('heading', { name: 'Gebäude' })).not.toHaveClass('vp-sr-only');
    expect(screen.getAllByRole('button', { name: /: Karte aufklappen$/ }).map((k) => k.getAttribute('aria-label'))).toEqual([
      'Halle 1: Karte aufklappen',
      'Halle 2: Karte aufklappen',
      'Verwaltung: Karte aufklappen',
    ]);
    expect(screen.queryByTestId('gebaeude-karte')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Halle 2: Karte aufklappen' }));
    expect(screen.getByTestId('gebaeude-karte')).toHaveTextContent('Blöcke von Halle 2');
    expect(screen.getByRole('button', { name: 'Halle 2: Karte zuklappen' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Halle 2: Karte zuklappen' }));
    expect(screen.queryByTestId('gebaeude-karte')).toBeNull();
  });
});

it('IP-12: Peter pflegt den sichtbaren Ortsbaum auch ohne Standort in der übergeordneten Schale', async () => {
  setSelbstauskunft(rechteSeed('PH').me);
  vi.spyOn(api, 'standortOrte').mockResolvedValue(ortsbaumLindachOhneGebaeude());
  render(<Ortsbaum standort={werkLindach()} />);
  expect(await screen.findByRole('button', { name: 'Gebäude anlegen' })).toBeInTheDocument();
});
