import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { ortsbaumSicht, SATZ_BEREICH_ZIEL } from '../ortsbaum';
import { ORT_IDS, ortNachSchreiben, ortsbaumAhrenberg, verwaltung } from '../test/ortsbaumFixtures';
import { FLAECHE_SATZ } from '../uemsOrtsbaum';
import { OrtDialog } from './OrtDialog';

/** Geschütztes Leerzeichen (U+00A0). */
const NB = String.fromCharCode(160);

/**
 * Die Dialoge „Gebäude“ (T4) und „Bereich“ (T5) — UEMS AP-02 IP-7: Pflicht, die
 * Sätze des Servers am richtigen Feld, die Zielliste ohne Bereiche und die Anfragen.
 */

function zeige(over: Partial<Parameters<typeof OrtDialog>[0]> = {}) {
  const props = {
    open: true,
    art: 'gebaeude' as const,
    antwort: ortsbaumAhrenberg(),
    knoten: null,
    onClose: vi.fn(),
    onGespeichert: vi.fn(),
    onOeffnen: vi.fn(),
    ...over,
  };
  render(<OrtDialog {...props} />);
  return props;
}

const feld = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const tippe = (label: string, wert: string) => fireEvent.change(feld(label), { target: { value: wert } });
const vorspann = () => [...document.querySelectorAll('.vp-sd-vorspann')].map((p) => p.textContent);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OrtDialog — Gebäude anlegen (T4)', () => {
  it('nennt den Standort, erbt die Zeitzone und zeigt das überschreibbare Kurzzeichen', () => {
    vi.spyOn(api, 'ortKurzzeichenVorschlag').mockResolvedValue({ kurzzeichen: 'G-4' });
    zeige();
    expect(screen.getByRole('dialog', { name: 'Gebäude anlegen' })).toBeInTheDocument();
    expect(vorspann()).toEqual([
      'Am Standort Werk Ahrenberg (ST-1). Nur der Name ist Pflicht.',
      'Zeitzone: Europe/Berlin — vom Standort geerbt, kein eigenes Feld.',
    ]);
    expect(screen.getByLabelText('Kurzzeichen')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Hängt an *' })).toBeNull();
  });

  it('leer gesendet: der Satz am Namen, der Fokus dort, nichts gesendet', async () => {
    const anlegen = vi.spyOn(api, 'ortAnlegen');
    zeige();
    fireEvent.click(screen.getByRole('button', { name: 'Gebäude anlegen' }));
    expect(await screen.findByText('Bitte geben Sie einen Namen an.')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(feld('Name *')));
    expect(anlegen).not.toHaveBeenCalled();
  });

  it('Fläche und Baujahr mit den Sätzen des Servers, der Fokus auf dem ersten Fehler', async () => {
    zeige();
    tippe('Name *', 'Halle 4');
    tippe('Bezugsfläche (m²)', '3100,5');
    tippe('Baujahr', '1799');
    fireEvent.click(screen.getByRole('button', { name: 'Gebäude anlegen' }));
    // Der Satz trägt ein geschütztes Leerzeichen („3 100“) — `getByText` würde es wegnormalisieren.
    await waitFor(() => expect(document.body.textContent).toContain(FLAECHE_SATZ));
    expect(screen.getByText('Das Baujahr liegt zwischen 1800 und 2026.')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(feld('Bezugsfläche (m²)')));
  });

  it('sendet POST mit vorgeschlagenem Kurzzeichen und der ersten Fläche ab „Gültig ab“', async () => {
    vi.spyOn(api, 'ortKurzzeichenVorschlag').mockResolvedValue({ kurzzeichen: 'G-4' });
    const anlegen = vi.spyOn(api, 'ortAnlegen').mockResolvedValue(ortNachSchreiben());
    const p = zeige();
    await waitFor(() => expect(feld('Kurzzeichen').value).toBe('G-4'));
    tippe('Name *', 'Halle 4');
    tippe('Bezugsfläche (m²)', `2${NB}000`);
    tippe('Baujahr', '2019');
    fireEvent.click(screen.getByRole('button', { name: 'Gebäude anlegen' }));
    await waitFor(() => expect(p.onGespeichert).toHaveBeenCalled());
    expect(anlegen).toHaveBeenCalledWith(p.antwort.standort.id, {
      art: 'gebaeude',
      name: 'Halle 4',
      kurzzeichen: 'G-4',
      gueltigAb: '2026-10-20',
      nutzung: null,
      notiz: null,
      flaecheM2: 2000,
      baujahr: 2019,
    });
  });

  it('eine Ablehnung zum Datum landet am Feld „Gültig ab“', async () => {
    vi.spyOn(api, 'ortAnlegen').mockRejectedValue(
      new ApiError(422, 'Werk Ahrenberg gibt es im Portal erst seit 12.03.2024. Wählen Sie ein Datum ab dem 12.03.2024.', {
        code: 'ziel_gab_es_noch_nicht',
        message: 'Werk Ahrenberg gibt es im Portal erst seit 12.03.2024. Wählen Sie ein Datum ab dem 12.03.2024.',
        feld: 'elternId',
      }),
    );
    const p = zeige();
    tippe('Name *', 'Halle 4');
    fireEvent.click(screen.getByRole('button', { name: 'Gebäude anlegen' }));
    const satz = await screen.findByText(/gibt es im Portal erst seit 12\.03\.2024/);
    expect(satz.closest('.vp-od-ab')).not.toBeNull();
    expect(p.onGespeichert).not.toHaveBeenCalled();
  });

  it('belegter Name (§5.10) mit dem Weg zum vorhandenen Gebäude', async () => {
    const p = zeige();
    tippe('Name *', 'Verwaltung');
    fireEvent.click(screen.getByRole('button', { name: 'Gebäude anlegen' }));
    expect(
      await screen.findByText(
        'Diesen Namen gibt es hier schon: Verwaltung (G-3). Wählen Sie einen anderen Namen — oder öffnen Sie Verwaltung.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verwaltung öffnen' }));
    expect(p.onOeffnen).toHaveBeenCalledWith(ORT_IDS.g3);
  });
});

describe('OrtDialog — Bereich anlegen (T5)', () => {
  it('die Zielliste „Hängt an“: drei Gebäude und der Standort, nie ein Bereich', () => {
    zeige({ art: 'bereich' });
    expect(vorspann()[0]).toBe('Ein räumlicher Teil eines Gebäudes oder des Standorts — nicht verschachtelt.');
    fireEvent.click(screen.getByRole('combobox', { name: 'Hängt an *' }));
    const optionen = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(optionen.map((t) => t.replace(/Bereich innerhalb des Gebäudes|z\. B\. Außenfläche oder Zählerplatz/, ''))).toEqual([
      'Gebäude Halle 1',
      'Gebäude Halle 2',
      'Gebäude Verwaltung',
      'Direkt am Standort Werk Ahrenberg',
    ]);
    expect(optionen.some((t) => /Halle 2 Montage|Halle 1 Nord/.test(t))).toBe(false);
  });

  it('ohne Ziel: der Satz des Vertrags am Feld; mit Halle 2 geht elternId mit', async () => {
    const anlegen = vi.spyOn(api, 'ortAnlegen').mockResolvedValue(ortNachSchreiben({ art: 'bereich' }));
    const p = zeige({ art: 'bereich' });
    tippe('Name *', 'Halle 2 Prüffeld');
    fireEvent.click(screen.getByRole('button', { name: 'Bereich anlegen' }));
    expect(await screen.findByText(SATZ_BEREICH_ZIEL)).toBeInTheDocument();
    expect(anlegen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('combobox', { name: 'Hängt an *' }));
    fireEvent.click(screen.getByRole('option', { name: /Gebäude Halle 2/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Bereich anlegen' }));
    await waitFor(() => expect(p.onGespeichert).toHaveBeenCalled());
    expect(anlegen.mock.calls[0][1]).toMatchObject({ art: 'bereich', name: 'Halle 2 Prüffeld', elternId: ORT_IDS.g2 });
  });

  it('L1 „Bereich direkt am Standort anlegen“: der Standort ist vorgewählt, gesendet ohne elternId', async () => {
    const anlegen = vi.spyOn(api, 'ortAnlegen').mockResolvedValue(ortNachSchreiben({ art: 'bereich' }));
    const antwort = ortsbaumAhrenberg();
    zeige({ art: 'bereich', antwort, vorwahl: antwort.standort.id });
    expect(screen.getByRole('combobox', { name: 'Hängt an *' }).textContent).toContain('Direkt am Standort Werk Ahrenberg');
    tippe('Name *', 'Parkplatz Halle 2');
    fireEvent.click(screen.getByRole('button', { name: 'Bereich anlegen' }));
    await waitFor(() => expect(anlegen).toHaveBeenCalled());
    expect(anlegen.mock.calls[0][1]).toMatchObject({ elternId: null, name: 'Parkplatz Halle 2' });
  });
});

describe('OrtDialog — bearbeiten', () => {
  const sicht = ortsbaumSicht(ortsbaumAhrenberg());
  const halle2 = sicht.knoten[1];

  it('Gebäude mit Fläche: Kurzzeichen Pflicht, die Fläche lesend, PUT die ganze Menge', async () => {
    const bearbeiten = vi.spyOn(api, 'ortBearbeiten').mockResolvedValue(ortNachSchreiben());
    const flaeche = vi.spyOn(api, 'ortFlaeche');
    const p = zeige({ knoten: halle2 });
    expect(screen.getByRole('dialog', { name: 'Gebäude bearbeiten' })).toBeInTheDocument();
    expect(feld('Kurzzeichen *').value).toBe('G-2');
    expect(screen.queryByLabelText('Bezugsfläche (m²)')).toBeNull();
    expect(document.querySelector('.vp-sd-flaeche')?.textContent).toBe(`Bezugsfläche3${NB}100${NB}m²`);
    tippe('Notiz', 'Anbau 2027');
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(p.onGespeichert).toHaveBeenCalled());
    expect(bearbeiten).toHaveBeenCalledWith(ORT_IDS.g2, {
      name: 'Halle 2',
      kurzzeichen: 'G-2',
      nutzung: ['produktion', 'montage', 'lager'],
      notiz: 'Anbau 2027',
      baujahr: 2019,
    });
    expect(flaeche).not.toHaveBeenCalled();
  });

  it('Gebäude ohne Fläche: „Fläche eintragen“ schreibt nach den Stammdaten die erste Fläche', async () => {
    const antwort = ortsbaumAhrenberg({ gebaeude: [verwaltung({ flaecheM2: null, flaecheQuelle: null })] });
    const knoten = ortsbaumSicht(antwort).knoten[0];
    const reihenfolge: string[] = [];
    vi.spyOn(api, 'ortBearbeiten').mockImplementation(async () => (reihenfolge.push('stammdaten'), ortNachSchreiben()));
    vi.spyOn(api, 'ortFlaeche').mockImplementation(async () => (reihenfolge.push('flaeche'), ortNachSchreiben()));
    const p = zeige({ antwort, knoten, startFeld: 'flaeche' });
    await waitFor(() => expect(document.activeElement).toBe(feld('Bezugsfläche (m²)')));
    tippe('Bezugsfläche (m²)', '1150');
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(p.onGespeichert).toHaveBeenCalled());
    expect(reihenfolge).toEqual(['stammdaten', 'flaeche']);
    expect(api.ortFlaeche).toHaveBeenCalledWith(ORT_IDS.g3, { m2: 1150, gueltigAb: '2026-10-20' });
  });

  it('Bereich: „Hängt an“ nur lesend (Verschieben ist ein eigener Weg), kein Baujahr', async () => {
    const bearbeiten = vi.spyOn(api, 'ortBearbeiten').mockResolvedValue(ortNachSchreiben({ art: 'bereich' }));
    const b3 = halle2.kinder[0];
    zeige({ art: 'bereich', knoten: b3 });
    expect(screen.getByRole('dialog', { name: 'Bereich bearbeiten' })).toBeInTheDocument();
    expect(within(screen.getByTestId('haengt-an')).getByText('Gebäude Halle 2')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Hängt an *' })).toBeNull();
    expect(screen.queryByLabelText('Baujahr')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(bearbeiten).toHaveBeenCalled());
    expect(bearbeiten.mock.calls[0]).toEqual([
      ORT_IDS.b3,
      { name: 'Halle 2 Montage', kurzzeichen: 'B-3', nutzung: ['montage'], notiz: 'Montagelinie M1' },
    ]);
  });
});

describe('OrtDialog — „Fläche ändern“ (AP-02 IP-8, T7)', () => {
  it('öffnet den Flächen-Dialog darüber; danach steht die neue Fläche hier, und Schließen lädt den Baum neu', async () => {
    const antwort = ortsbaumAhrenberg({ stichtag: '2027-01-15' });
    const halle2 = ortsbaumSicht(antwort).knoten.find((k) => k.name === 'Halle 2')!;
    const put = vi.spyOn(api, 'ortFlaeche').mockResolvedValue(
      ortNachSchreiben({
        flaechen: [
          { m2: 3100, gueltigAb: '2026-10-01', gueltigBis: '2027-01-14', zustand: 'beendet' },
          { m2: 3400, gueltigAb: '2027-01-15', gueltigBis: null, zustand: 'gueltig' },
        ],
        rueckwirkung: { art: 'ab_heute', tage: 0, abzeichen: null },
      }),
    );
    const p = zeige({ antwort, knoten: halle2 });

    fireEvent.click(screen.getByRole('button', { name: 'Fläche ändern: Halle 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Fläche ändern' });
    fireEvent.change(within(dialog).getByLabelText('Neue Fläche (m²) *'), { target: { value: '3400' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fläche speichern' }));
    expect(await screen.findByRole('heading', { name: 'Verlauf der Fläche' })).toBeInTheDocument();
    expect(put).toHaveBeenCalledWith(ORT_IDS.g2, { m2: 3400, gueltigAb: '2027-01-15' });

    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Fläche gespeichert' })).toBeNull());
    expect(document.querySelector('.vp-sd-flaeche')?.textContent).toBe(`Bezugsfläche3${NB}400${NB}m²`);
    // Gespeichert ist schon — auch „Abbrechen“ lässt den Baum neu laden, sonst stünde dort die alte Fläche.
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(p.onGespeichert).toHaveBeenCalled();
    expect(p.onClose).not.toHaveBeenCalled();
  });
});
