/**
 * Die Berichtsseite nach Konzept Nachweisen n1, PR 0: am freigegebenen Stand kein Rechte-Satz, dafür PDF (und mit
 * `export.*` CSV); am Entwurf ohne Freigabe-Recht statt des Knopfs, wer freigibt - Grund im Erklär-Blatt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    bericht: vi.fn(),
    berichtStand: vi.fn(),
    berichtEntwurf: vi.fn(),
    berichtDatei: vi.fn(),
  },
}));

vi.mock('../api', async (importOriginal) => {
  const echt = await importOriginal<typeof import('../api')>();
  const api = new Proxy(echt.api as Record<string, unknown>, {
    get: (_ziel, name) => (name in mocks ? mocks[name as keyof typeof mocks] : () => Promise.reject(new Error('nicht im Test'))),
  });
  return { ...echt, api };
});

import type { Selbstauskunft } from '../api';
import { setSelbstauskunft } from '../rollen';
import { detailAm, entwurfAm, standAm } from '../test/berichtFixtures';
import { FIXTURE_IDS } from '../test/standorteFixtures';
import { BerichtSeite } from './BerichtSeite';

const JETZT = Date.parse('2026-11-13T08:00:00Z');

const selbst = (rechte: string[]): Selbstauskunft => ({
  kennung: 'claudia',
  name: 'Claudia Berger',
  konto: 'benutzer',
  zustand: 'aktiv',
  kundenbereich: null,
  zugang: 'konto',
  rollen: ['leser'],
  unternehmensweit: false,
  standorte: [{ id: FIXTURE_IDS.st1, rechte } as unknown as Selbstauskunft['standorte'][number]],
  unternehmen_rechte: [],
  kuenftig: [],
  text: null,
  teilansicht: null,
  unterstuetzungen: { eigene: [], gewaehrte: [] } as unknown as Selbstauskunft['unterstuetzungen'],
  kundenadministratoren: [{ kennung: 'jonas', name: 'Jonas Wendlinger' }] as Selbstauskunft['kundenadministratoren'],
});

describe('Berichtsseite: Rechte-Satz und Dateien (Konzept Nachweisen n1, Befund 1 und 2)', () => {
  beforeEach(() => {
    mocks.bericht.mockResolvedValue(detailAm(JETZT));
    mocks.berichtStand.mockImplementation((_k: string, nr: number) => Promise.resolve(standAm(nr, JETZT)));
    mocks.berichtEntwurf.mockResolvedValue(entwurfAm(JETZT));
    mocks.berichtDatei.mockResolvedValue(new Blob(['%PDF']));
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    vi.clearAllMocks();
  });

  it('am Stand: kein „Dafür fehlt Ihnen das Recht“, PDF lädt den Stand; ohne `export.standort` kein CSV', async () => {
    setSelbstauskunft(selbst(['bericht.standort_abrufen']));
    render(<BerichtSeite kennung="BR-2026-0001" onListe={() => {}} />);
    const dateien = await screen.findByTestId('bericht-dateien');
    expect(within(dateien).getAllByRole('button').map((k) => k.textContent)).toEqual(['PDF']);
    expect(document.body.textContent).not.toContain('Dafür fehlt Ihnen das Recht');
    expect(screen.queryByTestId('bericht-freigeben-ohne-recht')).toBeNull();
    fireEvent.click(within(dateien).getByRole('button', { name: 'PDF' }));
    await waitFor(() => expect(mocks.berichtDatei).toHaveBeenCalledWith('BR-2026-0001', 1, 'pdf'));
    expect(await screen.findByTestId('bericht-abruf')).toHaveTextContent('PDF von Stand Nr. 1 abgerufen');
  });

  it('mit `export.standort` auch CSV', async () => {
    setSelbstauskunft(selbst(['bericht.standort_abrufen', 'export.standort']));
    render(<BerichtSeite kennung="BR-2026-0001" onListe={() => {}} />);
    const dateien = await screen.findByTestId('bericht-dateien');
    expect(within(dateien).getAllByRole('button').map((k) => k.textContent)).toEqual(['PDF', 'CSV']);
  });

  it('am Entwurf ohne Recht: „Freigeben: Jonas Wendlinger“ mit i-Knopf, das Blatt nennt Grund und Weg', async () => {
    setSelbstauskunft(selbst(['bericht.standort_abrufen']));
    render(<BerichtSeite kennung="BR-2026-0001" onListe={() => {}} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Entwurf' }));
    const zeile = await screen.findByTestId('bericht-freigeben-ohne-recht');
    expect(zeile).toHaveTextContent('Freigeben: Jonas Wendlinger');
    expect(screen.queryByTestId('bericht-dateien')).toBeNull();
    fireEvent.click(within(zeile).getByTestId('bericht-freigeben-warum-knopf'));
    const blatt = await screen.findByTestId('erklaer-blatt');
    expect(blatt).toHaveTextContent('Freigeben darf, wer bei Ihnen das Recht dazu hat.');
    expect(blatt).toHaveTextContent('Jonas Wendlinger gibt frei oder vergibt das Recht.');
  });
});
