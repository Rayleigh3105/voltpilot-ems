import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { folgenKarte } from '../ortVerschieben';
import { ORT_IDS } from '../test/ortsbaumFixtures';
import {
  ahrenbergV1,
  ahrenbergV4,
  HALLE2_LOESCHEN,
  halle2NachNord,
  halle2Rueckwirkend,
  halle2Verschoben,
  NORD_ID,
} from '../test/ortVerschiebenFixtures';
import { werkAhrenberg } from '../test/standorteFixtures';
import { Ortsbaum } from './Ortsbaum';

/**
 * UEMS AP-02 IP-12 — Verschieben im Ortsbaum, Ende zu Ende gegen die gemockte Cloud: V1 das Menü an
 * Halle 2 („Löschen“ fehlt, der Grund steht dabei), V2 Ziel und Tag (der bisherige Standort steht nicht
 * zur Wahl, ein Tag vor dem Beginn kommt als Satz des Servers ans Feld), V3 die Folgen-Karte vor dem
 * Speichern, V4 das Ergebnis mit Zeitstrahl und Protokolleintrag und das Abzeichen im Baum.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

async function menue(name: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: `Aktionen: ${name}` }));
  return screen.getByRole('group', { name: `Aktionen: ${name}` });
}

async function oeffneVerschieben(name: string): Promise<HTMLElement> {
  fireEvent.click(within(await menue(name)).getByRole('button', { name: 'Verschieben …' }));
  return screen.findByRole('dialog', { name: `${name} verschieben` });
}

function waehleNord(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('combobox', { name: 'Neuer Standort *' }));
  fireEvent.click(screen.getByRole('option', { name: /Werk Ahrenberg Nord \(ST-3\)/ }));
}

describe('Ortsbaum — Verschieben (AP-02 IP-12)', () => {
  it('V1: an Halle 2 steht „Verschieben …“ vorn — „Löschen“ wird nicht angeboten, und der Grund steht dabei', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ahrenbergV1());
    render(<Ortsbaum standort={werkAhrenberg()} />);
    const gruppe = await menue('Halle 2');
    const knoepfe = within(gruppe).getAllByRole('button');
    expect(knoepfe[0].textContent).toBe('Verschieben …');
    expect(within(gruppe).getByRole('button', { name: /Archivieren nicht möglich/ })).toBeInTheDocument();
    expect(within(gruppe).queryByRole('button', { name: /Löschen/ })).toBeNull();
    expect(within(gruppe).getByTestId('hinweis-loeschen_gesperrt').textContent).toBe(HALLE2_LOESCHEN);
    expect(HALLE2_LOESCHEN).toMatch(/^Löschen geht nicht: Halle 2 hat Historie \(Messstellen, Fläche und Bereiche\)\./);
  });

  it('V2: der bisherige Standort steht nicht zur Wahl; ein Tag vor dem Beginn kommt als Satz des Servers ans Feld', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ahrenbergV1());
    const satz = 'Halle 2 gibt es im Portal erst seit 01.10.2026. Wählen Sie ein Datum ab dem 01.10.2026.';
    const vorschau = vi
      .spyOn(api, 'ortVerschiebenVorschau')
      .mockRejectedValue(new ApiError(422, satz, { code: 'vor_dem_ersten_intervall', message: satz, feld: 'gueltigAb' }));
    const post = vi.spyOn(api, 'ortVerschieben');
    render(<Ortsbaum standort={werkAhrenberg()} />);
    const dialog = await oeffneVerschieben('Halle 2');
    expect(within(dialog).getByText(/heute an Werk Ahrenberg/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Neuer Standort *' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Werk Lindach \(ST-2\)/), expect.stringMatching(/Werk Ahrenberg Nord \(ST-3\)/)]),
    );
    expect(screen.queryByRole('option', { name: /^Werk Ahrenberg \(ST-1\)/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /Werk Ahrenberg Nord \(ST-3\)/ }));
    await waitFor(() => expect(vorschau).toHaveBeenCalledWith(ORT_IDS.g2, NORD_ID, '2027-02-20'));
    expect(await within(dialog).findByText(satz)).toBeInTheDocument();
    expect(within(dialog).queryByTestId('verschieben-folgen')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('V2: rückwirkend ist erlaubt und steht gekennzeichnet unter dem Datum', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ahrenbergV1());
    vi.spyOn(api, 'ortVerschiebenVorschau').mockResolvedValue(halle2Rueckwirkend());
    render(<Ortsbaum standort={werkAhrenberg()} />);
    const dialog = await oeffneVerschieben('Halle 2');
    waehleNord(dialog);
    expect(await within(dialog).findByText('Rückwirkend (18 Tage): wird im Änderungsprotokoll so gekennzeichnet.')).toBeInTheDocument();
  });

  it('V3: die Folgen-Karte vor dem Speichern — jeder Satz, und „Nichts ändert sich …“', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ahrenbergV1());
    vi.spyOn(api, 'ortVerschiebenVorschau').mockResolvedValue(halle2NachNord());
    render(<Ortsbaum standort={werkAhrenberg()} />);
    const dialog = await oeffneVerschieben('Halle 2');
    waehleNord(dialog);
    const karte = await within(dialog).findByTestId('verschieben-folgen');
    const k = folgenKarte(halle2NachNord());
    for (const satz of [...k.ziehtMit, ...k.bleibt.map((b) => b.satz), ...k.auswertungen]) {
      expect(within(karte).getByText(satz)).toBeInTheDocument();
    }
    expect(within(karte).getAllByText(/eigener Schritt/)).toHaveLength(1);
    expect(within(karte).getByText(/^Nichts ändert sich an Anlagen, Netzanschlüssen und VoltPilot-Boxen/)).toBeInTheDocument();
    expect(karte.textContent).not.toMatch(/Steuer|Befehl|Betriebsmodell|Freigabe/);
    expect(within(dialog).getByText('Geplant: bis 28.02.2027 bleibt alles, wie es ist.')).toBeInTheDocument();
  });

  it('V4: speichern → Zeitstrahl und Protokolleintrag; „Fertig“ lädt den Baum neu', async () => {
    const orte = vi.spyOn(api, 'standortOrte').mockResolvedValueOnce(ahrenbergV1()).mockResolvedValue(ahrenbergV4());
    vi.spyOn(api, 'ortVerschiebenVorschau').mockResolvedValue(halle2NachNord());
    const post = vi.spyOn(api, 'ortVerschieben').mockResolvedValue(halle2Verschoben());
    render(<Ortsbaum standort={werkAhrenberg()} />);
    const dialog = await oeffneVerschieben('Halle 2');
    waehleNord(dialog);
    await within(dialog).findByTestId('verschieben-folgen');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verschieben' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(ORT_IDS.g2, { zielId: NORD_ID, gueltigAb: '2027-02-20' }));

    const ergebnis = await screen.findByRole('dialog', { name: 'Verschiebung gespeichert' });
    expect(within(ergebnis).getByText('Halle 2 gehört ab 01.03.2027 zu Werk Ahrenberg Nord (ST-3).')).toBeInTheDocument();
    const strahl = within(ergebnis).getByTestId('zeitstrahl');
    expect(within(strahl).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Werk Ahrenberg (ST-1)01.10.2026 – 28.02.2027gilt',
      'Werk Ahrenberg Nord (ST-3)ab 01.03.2027geplant',
    ]);
    const protokoll = within(ergebnis).getByTestId('verschieben-protokoll');
    expect(protokoll.textContent).toContain('20.02.2027, 10:04 Uhr');
    expect(protokoll.textContent).toContain('Gebäude verschoben: Werk Ahrenberg → Werk Ahrenberg Nord (ST-3)');
    expect(protokoll.textContent).toContain('gilt ab 01.03.2027');
    expect(protokoll.textContent).toContain('Ines Kaltenbach');

    fireEvent.click(within(ergebnis).getByRole('button', { name: 'Fertig' }));
    await waitFor(() => expect(orte).toHaveBeenCalledTimes(2));
    // Bis zum Stichtag steht Halle 2 noch bei Werk Ahrenberg — mit dem Abzeichen.
    expect(await screen.findByTestId('danach')).toHaveTextContent('ab 01.03.2027 → Werk Ahrenberg Nord');
  });

  it('ein Bereich wählt ein anderes Gebäude oder einen Standort — nie sein bisheriges Gebäude, nie einen Bereich', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ahrenbergV1());
    render(<Ortsbaum standort={werkAhrenberg()} />);
    const dialog = await oeffneVerschieben('Halle 2 Lager');
    expect(within(dialog).getByText(/heute an Halle 2/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Hängt künftig an *' }));
    const namen = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(namen.some((n) => n.startsWith('Halle 1 (G-1)'))).toBe(true);
    expect(namen.some((n) => n.startsWith('Werk Ahrenberg (ST-1)'))).toBe(true);
    expect(namen.some((n) => n.startsWith('Halle 2 (G-2)'))).toBe(false);
    expect(namen.some((n) => /\(B-\d\)/.test(n))).toBe(false);
  });
});
