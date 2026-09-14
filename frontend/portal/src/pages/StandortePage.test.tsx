import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  ahrenbergHeute,
  ahrenbergUnternehmen,
  bestandEineAnlage,
  bestandZweiAnlagen,
  werkLindach,
} from '../test/standorteFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../test/ortsbaumFixtures';
import { StandortePage } from './StandortePage';

/** Geschütztes Leerzeichen (U+00A0) — Zahl und Wort brechen nie auseinander. */
const NB = String.fromCharCode(160);

/** „Unternehmen › Standorte“ (UEMS AP-02 IP-6, T1) mit den Antworten des Referenzunternehmens. */

function verdrahte(liste = ahrenbergHeute(), unternehmen = ahrenbergUnternehmen()) {
  vi.spyOn(api, 'standorte').mockResolvedValue(liste);
  vi.spyOn(api, 'unternehmen').mockResolvedValue(unternehmen);
  vi.spyOn(api, 'standortKurzzeichenVorschlag').mockResolvedValue({ kurzzeichen: 'ST-3' });
  // AP-02 IP-7: jede Karte liest ihren Ortsbaum.
  vi.spyOn(api, 'standortOrte').mockImplementation(async (id) =>
    id === werkLindach().id ? ortsbaumLindach() : ortsbaumAhrenberg(),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StandortePage', () => {
  it('zeigt die Standorte mit Kurzzeichen und Zeile — ohne Gruppe „Noch nicht zugeordnet“, wenn alles zugeordnet ist', async () => {
    verdrahte();
    render(<StandortePage />);
    const koepfe = await screen.findAllByTestId('standort-kopf');
    expect(koepfe.map((k) => within(k).getByRole('heading').textContent)).toEqual([
      'Werk AhrenbergST-1',
      'Werk LindachST-2',
    ]);
    expect(koepfe[1].textContent).toContain(`Am Bahndamm 12, Lindach · 2${NB}Gebäude · 1${NB}Anlage · 2${NB}600${NB}m²`);
    expect(screen.queryByTestId('noch-nicht-zugeordnet')).toBeNull();
    expect(screen.queryByText('Archiviert')).toBeNull();
  });

  it('AP-02 IP-7: jede Karte trägt unter dem Kopf ihren Ortsbaum', async () => {
    verdrahte();
    render(<StandortePage />);
    await screen.findByRole('button', { name: 'Lagerhalle Lindach bearbeiten' });
    const karten = screen.getAllByTestId('ortsbaum');
    expect(karten).toHaveLength(2);
    expect(within(karten[0]).getByText('Halle 1')).toBeInTheDocument();
    expect(within(karten[1]).getByText('Montagehalle Lindach')).toBeInTheDocument();
    expect(api.standortOrte).toHaveBeenCalledTimes(2);
  });

  it('„Bearbeiten“ im Standort-Kopf öffnet den Dialog, Abbrechen gibt den Fokus zurück', async () => {
    verdrahte();
    render(<StandortePage />);
    const knopf = await screen.findByRole('button', { name: 'Werk Lindach bearbeiten' });
    knopf.focus();
    fireEvent.click(knopf);
    const dialog = screen.getByRole('dialog', { name: 'Standort bearbeiten' });
    expect((within(dialog).getByLabelText('Name *') as HTMLInputElement).value).toBe('Werk Lindach');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(knopf));
  });

  it('nach dem Speichern wird die Liste neu gelesen', async () => {
    verdrahte();
    vi.spyOn(api, 'standortBearbeiten').mockResolvedValue(werkLindach({ name: 'Werk Lindach Nord' }));
    render(<StandortePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Werk Lindach bearbeiten' }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.standorte).toHaveBeenCalledTimes(2);
  });

  it('E10: der Entwurf sagt, was fehlt, und „Adresse nachtragen“ öffnet „Standort vervollständigen“', async () => {
    verdrahte(bestandEineAnlage(), ahrenbergUnternehmen({ standortZahl: 1, anlagenZahl: 1, sitz: null }));
    render(<StandortePage />);
    expect(await screen.findByText('Noch nicht eingerichtet — es fehlt: Adresse')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Adresse nachtragen: Werk Ahrenberg – Halle 1' }));
    expect(screen.getByRole('dialog', { name: 'Standort vervollständigen' })).toBeInTheDocument();
  });

  it('A6: ohne Standort steht die Gruppe „Noch nicht zugeordnet“ mit den Anlagen da', async () => {
    verdrahte(bestandZweiAnlagen(), ahrenbergUnternehmen({ standortZahl: 0, nochNichtZugeordnetZahl: 2 }));
    render(<StandortePage />);
    const gruppe = await screen.findByTestId('noch-nicht-zugeordnet');
    expect(within(gruppe).getByRole('heading').textContent).toBe('Noch nicht zugeordnet');
    expect(within(gruppe).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Werk Ahrenberg – Halle 1',
      'Werk Ahrenberg – Halle 2',
    ]);
    expect(screen.getByText('Noch kein Standort angelegt.')).toBeInTheDocument();
  });

  it('ohne Unternehmen gibt es „Standort anlegen“ nicht — der Knopf könnte nichts bewirken', async () => {
    verdrahte(bestandZweiAnlagen(), ahrenbergUnternehmen({ zustand: 'nicht_angelegt', id: null, name: null, zeitzone: null }));
    render(<StandortePage />);
    await screen.findByTestId('noch-nicht-zugeordnet');
    expect(screen.queryByRole('button', { name: 'Standort anlegen' })).toBeNull();
  });

  it('archivierte Standorte stehen in einer eigenen Gruppe mit ihrem Tag', async () => {
    const liste = ahrenbergHeute();
    liste.nichtGezeigt = [
      werkLindach({ zustand: 'archiviert', bestand: 'archiviert', archiviertAm: '2026-10-19T08:00:00Z' }),
    ];
    liste.standorte = liste.standorte.slice(0, 1);
    verdrahte(liste);
    render(<StandortePage />);
    expect(await screen.findByText('Archiviert am 19.10.2026')).toBeInTheDocument();
  });

  it('ein Ladefehler nennt den Grund und bietet „Erneut versuchen“', async () => {
    vi.spyOn(api, 'standorte').mockRejectedValueOnce(new Error('Der Server ist zurzeit nicht erreichbar. Bitte versuchen Sie es erneut.'));
    vi.spyOn(api, 'unternehmen').mockResolvedValue(ahrenbergUnternehmen());
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ortsbaumAhrenberg());
    render(<StandortePage />);
    expect((await screen.findByRole('alert')).textContent).toContain('nicht erreichbar');
    vi.mocked(api.standorte).mockResolvedValue(ahrenbergHeute());
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findAllByTestId('standort-kopf')).toHaveLength(2);
  });
});
