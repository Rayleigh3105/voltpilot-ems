import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { KNOPF_AENDERUNGEN, KNOPF_VERSCHIEBEN } from '../ortArchiv';
import { bereichNurAngelegt, halle2Protokoll, werkAhrenbergProtokoll } from '../test/ortAenderungenFixtures';
import { ORT_IDS } from '../test/ortsbaumFixtures';
import { ahrenbergV1 } from '../test/ortVerschiebenFixtures';
import { werkAhrenberg } from '../test/standorteFixtures';
import { OrtAenderungen } from './OrtAenderungen';
import { Ortsbaum } from './Ortsbaum';
import { PROTOKOLL_LABEL } from './ProtokollDialog';

/**
 * Das Änderungsprotokoll am Ort (UEMS AP-02 IP-14, Mockup H2): der Weg über das Menü des
 * Ortsbaums, die Liste nach dem Eintrag mit „rückwirkend (n Tage)“, das Protokoll des Standorts
 * mit dem Objekt je Zeile und der Leerzustand. Antworten aus `test/ortAenderungenFixtures.ts`.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Änderungsprotokoll am Ort (AP-02 IP-14)', () => {
  it('EINE Beschriftung: das Menü sagt, was Messstelle und Gerät sagen', () => {
    expect(KNOPF_AENDERUNGEN).toBe(PROTOKOLL_LABEL);
  });

  it('Halle 2: Menü → „Änderungsprotokoll“ öffnet die Liste nach dem Eintrag, mit „rückwirkend (37 Tage)“', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ahrenbergV1());
    const laden = vi.spyOn(api, 'ortAenderungen').mockResolvedValue(halle2Protokoll());
    render(<Ortsbaum standort={werkAhrenberg()} />);

    const knopf = await screen.findByRole('button', { name: 'Aktionen: Halle 2' });
    fireEvent.click(knopf);
    const gruppe = screen.getByRole('group', { name: 'Aktionen: Halle 2' });
    const texte = within(gruppe).getAllByRole('button').map((b) => b.textContent);
    expect(texte.indexOf(KNOPF_VERSCHIEBEN)).toBeLessThan(texte.indexOf(KNOPF_AENDERUNGEN));
    // Halle 2 trägt Messstellen: dort steht „Archivieren nicht möglich …“ mit Grund — dahinter kommt es trotzdem.
    expect(texte.indexOf(KNOPF_AENDERUNGEN)).toBeLessThan(texte.findIndex((t) => t?.startsWith('Archivieren')));
    expect(texte.findIndex((t) => t?.startsWith('Archivieren'))).toBeGreaterThan(-1);

    fireEvent.click(within(gruppe).getByRole('button', { name: KNOPF_AENDERUNGEN }));
    expect(await screen.findByText('Änderungsprotokoll: Halle 2')).toBeInTheDocument();
    expect(laden).toHaveBeenCalledWith(ORT_IDS.g2, { limit: 25, achse: 'eintrag' });
    expect(await screen.findByText('rückwirkend (37 Tage)')).toBeInTheDocument();
    expect(screen.getByText('rückwirkend (14 Tage)')).toBeInTheDocument();
    expect(screen.getByText('gilt ab 01.02.2027')).toBeInTheDocument();
    expect(screen.getByText('Bezugsfläche geändert: 3.100 m² → 3.400 m²')).toBeInTheDocument();
    expect(screen.getByText('Begründung: Umzug der Spritzgussfertigung nachgetragen')).toBeInTheDocument();
    expect(screen.getByText('Sortiert danach, wann die Änderung eingetragen wurde.')).toBeInTheDocument();
    // Das Protokoll EINES Gebäudes nennt das Gebäude nicht an jeder Zeile.
    expect(document.querySelectorAll('.vp-befehl-strom')).toHaveLength(0);
    // „Ältere laden“ steht nur da, wenn der Server eine weitere Seite nennt.
    expect(screen.queryByRole('button', { name: 'Ältere laden' })).toBeNull();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Änderungsprotokoll: Halle 2')).toBeNull());
  });

  it('Werk Ahrenberg: Kinder und Anlage stehen mit ihrem Objekt da, der Standort selbst ohne', async () => {
    const laden = vi.spyOn(api, 'standortAenderungen').mockResolvedValue(werkAhrenbergProtokoll());
    render(
      <OrtAenderungen
        open
        objekt={{ art: 'standort', id: werkAhrenberg().id, name: 'Werk Ahrenberg' }}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText('Standort angelegt: Werk Ahrenberg')).toBeInTheDocument();
    expect(laden).toHaveBeenCalledWith(werkAhrenberg().id, { limit: 25, achse: 'eintrag' });
    expect([...document.querySelectorAll('.vp-befehl-strom')].map((x) => x.textContent)).toEqual([
      'G-2 · Halle 2',
      'G-2 · Halle 2',
      'G-2 · Halle 2',
      'B-3 · Halle 2 Montage',
      'G-2 · Halle 2',
      'G-1 · Halle 1',
      'Werk Ahrenberg – Halle 2',
    ]);
    expect(screen.getByText('Anlage zieht um: Werk Ahrenberg – Halle 2 → Werk Ahrenberg Nord')).toBeInTheDocument();
    expect(screen.queryByText(/Seit dem Anlegen/)).toBeNull();
  });

  it('nur der Anlege-Eintrag: „Seit dem Anlegen am 01.10.2026 keine Änderung.“', async () => {
    vi.spyOn(api, 'ortAenderungen').mockResolvedValue(bereichNurAngelegt());
    render(
      <OrtAenderungen
        open
        objekt={{ art: 'bereich', id: ORT_IDS.b4, name: 'Halle 2 Spritzguss' }}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText('Seit dem Anlegen am 01.10.2026 keine Änderung.')).toBeInTheDocument();
    expect(screen.getByText('Bereich angelegt: Halle 2 Spritzguss')).toBeInTheDocument();
  });
});
