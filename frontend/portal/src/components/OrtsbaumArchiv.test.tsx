import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { KNOPF_LOESCHEN } from '../ortArchiv';
import {
  A7_SATZ,
  ahrenbergA8Archiviert,
  ahrenbergA8Archivieren,
  ahrenbergA9,
  B8_HALLE_2_TEST,
  HALLE1_LOESCHEN,
  lindachA7,
} from '../test/ortArchivFixtures';
import { ORT_IDS, ortNachSchreiben } from '../test/ortsbaumFixtures';
import { werkAhrenberg, werkLindach } from '../test/standorteFixtures';
import { Ortsbaum } from './Ortsbaum';
import { StandortKopf } from './StandortKopf';

/**
 * Archivieren, Wiederherstellen und Löschen im Ortsbaum (UEMS AP-02 IP-15): die Menü-Sichtbarkeit
 * („Löschen“ nur ohne Historie), Z1 (Grund und Weg statt eines toten Knopfs), Z2 (Folgenliste),
 * Z3 (der archivierte Knoten bleibt ausgegraut mit Datum — heute UND in „Stand am …“) und die
 * Rückfrage vor dem Löschen. Antworten aus `test/ortArchivFixtures.ts`.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const namen = () =>
  [...document.querySelectorAll('.vp-ob-knoten')].map((li) => li.querySelector('.vp-ob-name')?.textContent);

function zeile(name: string): HTMLElement {
  const z = [...document.querySelectorAll<HTMLElement>('.vp-ob-zeile')].find(
    (x) => x.querySelector('.vp-st-name-text')?.textContent === name,
  );
  if (!z) throw new Error(`Zeile ${name} fehlt`);
  return z;
}

async function menue(name: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: `Aktionen: ${name}` }));
  return screen.getByRole('group', { name: `Aktionen: ${name}` });
}

describe('Ortsbaum — Archivieren, Wiederherstellen, Löschen (AP-02 IP-15)', () => {
  it('Menü-Sichtbarkeit: „Löschen …“ steht nur an Knoten ohne Historie — an Halle 1 steht der Grund, kein Knopf', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ahrenbergA9());
    render(<Ortsbaum standort={werkAhrenberg()} />);
    // Jeder Knoten hat sein Menü, der Zweig „Direkt am Standort“ nicht (er ist kein Objekt).
    await screen.findByRole('button', { name: 'Aktionen: Halle 1' });
    expect(screen.getAllByRole('button', { name: /^Aktionen: / })).toHaveLength(9);
    expect(screen.queryByRole('button', { name: 'Aktionen: Direkt am Standort' })).toBeNull();

    const irrtum = await menue('Halle 2 Test');
    expect(within(irrtum).getByRole('button', { name: KNOPF_LOESCHEN })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('group')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Aktionen: Halle 2 Test' }));

    for (const name of ['Halle 1', 'Halle 2', 'Halle 2 Lager', 'Verwaltung']) {
      const gruppe = await menue(name);
      expect(within(gruppe).queryByRole('button', { name: /Löschen/ }), name).toBeNull();
      expect(within(gruppe).getByTestId('hinweis-loeschen_gesperrt').textContent, name).toMatch(
        new RegExp(`^Löschen geht nicht: ${name} hat Historie`),
      );
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('group')).toBeNull());
    }
    const halle1 = await menue('Halle 1');
    expect(within(halle1).getByTestId('hinweis-loeschen_gesperrt').textContent).toBe(HALLE1_LOESCHEN);
  });

  it('Z1/A7: „Archivieren nicht möglich …“ sagt den Grund schon im Menü und öffnet Grund und Weg — nichts wird gesendet', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(lindachA7());
    const archivieren = vi.spyOn(api, 'ortArchivieren');
    render(<Ortsbaum standort={werkLindach()} />);
    const gruppe = await menue('Montagehalle Lindach');
    expect(within(gruppe).queryByRole('button', { name: 'Archivieren …' })).toBeNull();
    const eintrag = within(gruppe).getByRole('button', { name: /Archivieren nicht möglich/ });
    expect(eintrag.textContent).toContain('1 Messstelle ist hier aktiv');
    fireEvent.click(eintrag);

    const dialog = screen.getByRole('dialog', { name: 'Archivieren nicht möglich' });
    expect(within(dialog).getByTestId('sperre-satz').textContent).toBe(A7_SATZ);
    expect(dialog.textContent).toContain('MS-18 Montagehalle Lindach gesamt');
    expect(dialog.textContent).toContain('Messstelle umziehen oder stilllegen');
    expect(within(dialog).queryByRole('button', { name: 'Archivieren' })).toBeNull();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Schließen' }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(archivieren).not.toHaveBeenCalled();
  });

  it('Z2/A8: „Halle 2 Lager archivieren?“ trägt die Folgenliste; danach wird der Baum neu gelesen', async () => {
    const lesen = vi.spyOn(api, 'standortOrte').mockResolvedValue(ahrenbergA8Archivieren());
    const archivieren = vi.spyOn(api, 'ortArchivieren').mockResolvedValue(ortNachSchreiben());
    const geaendert = vi.fn();
    render(<Ortsbaum standort={werkAhrenberg()} onGeaendert={geaendert} />);
    fireEvent.click(within(await menue('Halle 2 Lager')).getByRole('button', { name: 'Archivieren …' }));

    const dialog = screen.getByRole('dialog', { name: 'Halle 2 Lager archivieren?' });
    for (const text of [
      'Halle 2 Lager bleibt lesbar und in alten Berichten unverändert.',
      'Zuordnung endet am 29.06.2027',
      'Berichte bis dahin bleiben, wie sie sind.',
      'Ausgegraut mit „Archiviert am 30.06.2027“',
      'Wiederherstellen jederzeit möglich',
    ]) {
      expect(dialog.textContent).toContain(text);
    }
    expect(archivieren).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivieren' }));
    await waitFor(() => expect(geaendert).toHaveBeenCalled());
    expect(archivieren).toHaveBeenCalledWith(ORT_IDS.b5);
    expect(lesen).toHaveBeenCalledTimes(2);
  });

  it('Z3: der archivierte Bereich bleibt unter Halle 2 — ausgegraut mit „Archiviert am 30.06.2027“, mit „Wiederherstellen …“', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ahrenbergA8Archiviert());
    render(<Ortsbaum standort={werkAhrenberg()} />);
    await screen.findByText('Halle 2 Lager');
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
    const z = zeile('Halle 2 Lager');
    expect(z.classList.contains('vp-ob-zeile-still')).toBe(true);
    expect(within(z).getByTestId('archiviert-am').textContent).toBe('Archiviert am 30.06.2027');
    expect(within(z).queryByTestId('datenlage')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Halle 2 Lager bearbeiten' })).toBeNull();

    const gruppe = await menue('Halle 2 Lager');
    expect(within(gruppe).getByRole('button', { name: 'Wiederherstellen …' })).toBeInTheDocument();
    expect(within(gruppe).queryByRole('button', { name: /Löschen/ })).toBeNull();
    expect(within(gruppe).queryByRole('button', { name: /Archivieren/ })).toBeNull();
  });

  it('Z3 in „Stand am 15.07.2027“: derselbe archivierte Bereich ist zu sehen, ausgegraut, mit Datum — und kein einziger Knopf', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ahrenbergA8Archiviert({ stichtag: '2027-07-15' }));
    render(<Ortsbaum standort={werkAhrenberg()} stichtag="2027-07-15" />);
    await screen.findByText('Halle 2 Lager');
    expect(api.standortOrte).toHaveBeenCalledWith(werkAhrenberg().id, '2027-07-15');
    const z = zeile('Halle 2 Lager');
    expect(z.classList.contains('vp-ob-zeile-still')).toBe(true);
    expect(within(z).getByTestId('archiviert-am').textContent).toBe('Archiviert am 30.06.2027');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('Wiederherstellen mit inzwischen vergebenem Namen: der Satz steht am Feld, umbenannt geht es im selben Dialog', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ahrenbergA8Archiviert({ nameBelegt: true }));
    const zurueck = vi.spyOn(api, 'ortWiederherstellen').mockResolvedValue(ortNachSchreiben());
    render(<Ortsbaum standort={werkAhrenberg()} />);
    fireEvent.click(within(await menue('Halle 2 Lager')).getByRole('button', { name: 'Wiederherstellen …' }));

    const dialog = screen.getByRole('dialog', { name: 'Halle 2 Lager wiederherstellen' });
    expect(dialog.textContent).toContain('Diesen Namen gibt es hier schon: Halle 2 Lager (B-8).');
    expect(dialog.textContent).toContain('Gilt wieder ab 01.02.2028');
    expect(dialog.textContent).toContain('Die Zeit vom 30.06.2027 bis dahin bleibt sichtbar');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Halle 2 Altlager' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Wiederherstellen' }));
    await waitFor(() => expect(zurueck).toHaveBeenCalledWith(ORT_IDS.b5, 'Halle 2 Altlager'));
  });

  it('A9: „Löschen …“ fragt zurück und löscht erst mit „Endgültig löschen“', async () => {
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ahrenbergA9());
    const loeschen = vi.spyOn(api, 'ortLoeschen').mockResolvedValue(undefined);
    render(<Ortsbaum standort={werkAhrenberg()} />);
    fireEvent.click(within(await menue('Halle 2 Test')).getByRole('button', { name: KNOPF_LOESCHEN }));

    const dialog = screen.getByRole('dialog', { name: 'Halle 2 Test löschen?' });
    expect(loeschen).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('Kurzzeichen B-8 wird nicht wieder vergeben');
    expect(dialog.textContent).toContain('Bei Halle 2 steht: „Bereich Halle 2 Test gelöscht“.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Endgültig löschen' }));
    await waitFor(() => expect(loeschen).toHaveBeenCalledWith(B8_HALLE_2_TEST));
  });

  it('der Standort-Kopf trägt das Menü des Standorts: „Archivieren nicht möglich …“ mit Grund', () => {
    const onAktion = vi.fn();
    render(
      <StandortKopf
        standort={werkLindach()}
        onBearbeiten={() => {}}
        aktionen={{
          archivieren: {
            erlaubt: false,
            text: 'Werk Lindach kann nicht archiviert werden: die Anlage Werk Lindach ist aktiv. Ordnen Sie die Anlage einem anderen Standort zu oder archivieren Sie sie zuerst.',
            gruende: [
              { art: 'anlage_aktiv', objekt: 'anlage', id: 'an-3', kennzeichen: null, name: 'Werk Lindach', weg: 'anlage_zuordnen' },
            ],
            letzterTag: null,
            mitarchiviert: [],
          },
          wiederherstellen: null,
          loeschen: null,
        }}
        onAktion={onAktion}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Aktionen: Werk Lindach' }));
    const gruppe = screen.getByRole('group', { name: 'Aktionen: Werk Lindach' });
    const eintrag = within(gruppe).getByRole('button', { name: /Archivieren nicht möglich/ });
    expect(eintrag.textContent).toContain('Die Anlage Werk Lindach ist aktiv');
    // Ein Standort wird archiviert, nie gelöscht (§4.1) — kein Löschen im Menü.
    expect(within(gruppe).queryByText(/Löschen/)).toBeNull();
    fireEvent.click(eintrag);
    expect(onAktion).toHaveBeenCalledWith(expect.objectContaining({ art: 'archivieren_gesperrt' }), expect.any(HTMLElement));
  });
});
