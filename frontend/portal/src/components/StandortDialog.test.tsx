import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { SATZ_ADRESSE, SATZ_NAME_FEHLT } from '../standorte';
import {
  ahrenbergHeute,
  ahrenbergUnternehmen,
  halle1Entwurf,
  werkAhrenberg,
  werkLindach,
} from '../test/standorteFixtures';
import { StandortDialog } from './StandortDialog';

/**
 * Der Standort-Dialog (UEMS AP-02 IP-6): Pflichtfelder, die Sätze der
 * Fehlertabelle §5.10, die vorbelegte Zeitzone und die drei Fassungen.
 */

function zeige(over: Partial<Parameters<typeof StandortDialog>[0]> = {}) {
  const props = {
    open: true,
    standort: null,
    unternehmen: ahrenbergUnternehmen(),
    standorte: ahrenbergHeute().standorte,
    heute: '2026-10-20',
    onClose: vi.fn(),
    onGespeichert: vi.fn(),
    onOeffnen: vi.fn(),
    ...over,
  };
  render(<StandortDialog {...props} />);
  return props;
}

const feld = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const tippe = (label: string, wert: string) => fireEvent.change(feld(label), { target: { value: wert } });

beforeEach(() => {
  vi.spyOn(api, 'standortKurzzeichenVorschlag').mockResolvedValue({ kurzzeichen: 'ST-3' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StandortDialog — anlegen', () => {
  it('belegt die Zeitzone vom Unternehmen vor und nennt das Kurzzeichen, das vergeben wird', async () => {
    zeige({ unternehmen: ahrenbergUnternehmen({ zeitzone: 'Europe/Vienna' }) });
    expect(screen.getByRole('dialog', { name: 'Standort anlegen' })).toBeInTheDocument();
    const zeitzone = screen.getByRole('combobox', { name: 'Zeitzone *' });
    expect(zeitzone.textContent).toContain('Europe/Vienna');
    expect(screen.getByText('vom Unternehmen')).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('.vp-sd-vorspann')?.textContent).toBe(
        'Name und Adresse sind Pflicht; Kurzzeichen ST-3 wird vergeben.',
      ),
    );
    expect(document.querySelector('.vp-sd-vorspann .vp-sd-kz')?.textContent).toBe('ST-3');
    // Kein Kurzzeichen-Feld beim Anlegen — der Server vergibt es.
    expect(screen.queryByLabelText('Kurzzeichen *')).toBeNull();
  });

  it('ohne Unternehmens-Zeitzone steht Europe/Berlin da', () => {
    zeige({ unternehmen: null });
    expect(screen.getByRole('combobox', { name: 'Zeitzone *' }).textContent).toContain('Europe/Berlin');
  });

  it('Pflichtfelder: leeres Senden zeigt die Sätze, fokussiert den Namen und sendet nichts', async () => {
    const anlegen = vi.spyOn(api, 'standortAnlegen');
    zeige({ unternehmen: ahrenbergUnternehmen({ sitz: null }) });
    expect(screen.queryByText(SATZ_NAME_FEHLT)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Standort anlegen' }));
    expect(await screen.findByText(SATZ_NAME_FEHLT)).toBeInTheDocument();
    // Der Adress-Satz steht EINMAL (am ersten fehlenden Feld), Ort und Land sind nur markiert.
    expect(screen.getAllByText(SATZ_ADRESSE)).toHaveLength(1);
    expect(screen.getByText(SATZ_ADRESSE).closest('div')?.querySelector('input')).toBe(
      feld('Straße und Hausnummer *'),
    );
    expect(feld('Ort *').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('combobox', { name: 'Land *' }).getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(feld('Name *')));
    expect(anlegen).not.toHaveBeenCalled();
    // Der Satz verschwindet, sobald das Feld stimmt.
    tippe('Name *', 'Werk Lindach');
    expect(screen.queryByText(SATZ_NAME_FEHLT)).toBeNull();
  });

  it('§5.10 doppelter Name: Satz mit dem vorhandenen Standort und „öffnen“', async () => {
    const p = zeige();
    tippe('Name *', 'Werk Ahrenberg');
    fireEvent.click(screen.getByRole('button', { name: 'Standort anlegen' }));
    expect(
      await screen.findByText(
        'Diesen Namen gibt es hier schon: Werk Ahrenberg (ST-1). Wählen Sie einen anderen Namen — oder öffnen Sie Werk Ahrenberg.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Werk Ahrenberg öffnen' }));
    expect(p.onOeffnen).toHaveBeenCalledWith(expect.objectContaining({ kurzzeichen: 'ST-1' }));
  });

  it('§5.10 PLZ passt nicht zum Land — vor dem Senden, am Feld PLZ', async () => {
    zeige({ standorte: [werkAhrenberg()] });
    tippe('Name *', 'Werk Lindach');
    tippe('Straße und Hausnummer *', 'Am Bahndamm 12');
    tippe('PLZ', '84xxx');
    tippe('Ort *', 'Lindach');
    fireEvent.click(screen.getByRole('button', { name: 'Standort anlegen' }));
    expect(await screen.findByText('Die PLZ 84xxx passt nicht zu Deutschland (fünfstellig).')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(feld('PLZ')));
  });

  it('legt Werk Lindach an (T2) und meldet den gespeicherten Standort', async () => {
    const gespeichert = werkLindach();
    const anlegen = vi.spyOn(api, 'standortAnlegen').mockResolvedValue(gespeichert);
    const p = zeige({ standorte: [werkAhrenberg()] });
    tippe('Name *', 'Werk Lindach');
    tippe('Straße und Hausnummer *', 'Am Bahndamm 12');
    tippe('Ort *', 'Lindach');
    fireEvent.click(screen.getByRole('button', { name: 'Standort anlegen' }));
    await waitFor(() => expect(p.onGespeichert).toHaveBeenCalledWith(gespeichert));
    expect(anlegen).toHaveBeenCalledWith({
      name: 'Werk Lindach',
      adresse: { strasse: 'Am Bahndamm 12', plz: null, ort: 'Lindach', land: 'DE' },
      zeitzone: 'Europe/Berlin',
      nutzung: null,
      notiz: null,
    });
  });

  it('eine Ablehnung des Servers landet mit ihrem Satz am Feld aus `feld`', async () => {
    vi.spyOn(api, 'standortAnlegen').mockRejectedValue(
      new ApiError(400, 'Die PLZ 1234 passt nicht zu Deutschland (fünfstellig).', {
        code: 'anfrage_ungueltig',
        message: 'Die PLZ 1234 passt nicht zu Deutschland (fünfstellig).',
        feld: 'adresse.plz',
      }),
    );
    zeige({ standorte: [] });
    tippe('Name *', 'Werk Lindach');
    tippe('Straße und Hausnummer *', 'Am Bahndamm 12');
    tippe('Ort *', 'Lindach');
    fireEvent.click(screen.getByRole('button', { name: 'Standort anlegen' }));
    const satz = await screen.findByText('Die PLZ 1234 passt nicht zu Deutschland (fünfstellig).');
    expect(feld('PLZ').getAttribute('aria-invalid')).toBe('true');
    expect(satz.closest('.vp-sd-plz')).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(feld('PLZ')));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ohne zuordenbares Feld steht der Satz über dem Fuß', async () => {
    vi.spyOn(api, 'standortAnlegen').mockRejectedValue(
      new ApiError(404, 'Für diesen Kundenbereich ist noch kein Unternehmen angelegt.', {
        code: 'nicht_gefunden',
        message: 'Für diesen Kundenbereich ist noch kein Unternehmen angelegt.',
      }),
    );
    zeige({ standorte: [] });
    tippe('Name *', 'Werk Lindach');
    tippe('Straße und Hausnummer *', 'Am Bahndamm 12');
    tippe('Ort *', 'Lindach');
    fireEvent.click(screen.getByRole('button', { name: 'Standort anlegen' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Für diesen Kundenbereich ist noch kein Unternehmen angelegt.',
    );
  });
});

describe('StandortDialog — bearbeiten und vervollständigen', () => {
  it('bearbeiten: Kurzzeichen änderbar, Fläche nur lesend, PUT trägt die Lage mit', async () => {
    const bearbeiten = vi.spyOn(api, 'standortBearbeiten').mockResolvedValue(werkAhrenberg());
    const p = zeige({ standort: werkLindach() });
    expect(screen.getByRole('dialog', { name: 'Standort bearbeiten' })).toBeInTheDocument();
    expect(feld('Kurzzeichen *').value).toBe('ST-2');
    expect(document.querySelector('.vp-sd-flaeche-wert')?.textContent).toBe('2\u00a0600\u00a0m² · aus Gebäuden summiert');
    expect(screen.getByRole('combobox', { name: 'Nutzung' }).textContent).toContain('Lager');
    tippe('Notiz', 'Tore an der Nordseite');
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(p.onGespeichert).toHaveBeenCalled());
    expect(bearbeiten).toHaveBeenCalledWith(werkLindach().id, expect.objectContaining({
      kurzzeichen: 'ST-2',
      nutzung: ['lager', 'logistik', 'montage'],
      notiz: 'Tore an der Nordseite',
      lage: null,
    }));
    expect(api.standortKurzzeichenVorschlag).not.toHaveBeenCalled();
  });

  it('vervollständigen: der Entwurf sagt, was fehlt, und verlangt die Adresse', async () => {
    const bearbeiten = vi.spyOn(api, 'standortBearbeiten');
    zeige({ standort: halle1Entwurf(), standorte: [halle1Entwurf()], unternehmen: ahrenbergUnternehmen({ sitz: null }) });
    expect(screen.getByRole('dialog', { name: 'Standort vervollständigen' })).toBeInTheDocument();
    expect(
      screen.getByText('Noch nicht eingerichtet — es fehlt: Adresse. Name und Adresse sind Pflicht.'),
    ).toBeInTheDocument();
    expect(feld('Name *').value).toBe('Werk Ahrenberg – Halle 1');
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(document.activeElement).toBe(feld('Straße und Hausnummer *')));
    expect(bearbeiten).not.toHaveBeenCalled();
  });
});
