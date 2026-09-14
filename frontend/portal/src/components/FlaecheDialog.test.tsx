import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { FlaecheDialog } from './FlaecheDialog';
import { api, ApiError } from '../api';
import { FLAECHE_SATZ } from '../uemsOrtsbaum';
import { ORT_IDS, ortNachSchreiben } from '../test/ortsbaumFixtures';

/**
 * UEMS AP-02 IP-8 · T7 „Fläche ändern“ — Halle 2 des Referenzunternehmens
 * Ahrenberg (Fassung 1.1): heute 15.01.2027 gelten 3 100 m², eingetragen werden
 * 3 400 m² ab 01.01.2027 — „rückwirkend (14 Tage)“.
 */
const NB = String.fromCharCode(160);
/** Testing Library glättet NBSP im DOM-Text zu Leerzeichen, den gesuchten Text aber nicht. */
const sp = (t: string) => t.replace(new RegExp(NB, 'g'), ' ');

function phone(an: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (q: string) => ({
      matches: q.includes('max-width') ? an : !an,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => phone(false));
afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error - der Stub gehört dem einzelnen Test
  delete window.matchMedia;
});

function oeffne() {
  const onClose = vi.fn();
  const onGespeichert = vi.fn();
  render(
    <FlaecheDialog
      open
      ortId={ORT_IDS.g2}
      name="Halle 2"
      kurzzeichen="G-2"
      flaecheHeute={3100}
      heute="2027-01-15"
      zeitzone="Europe/Berlin"
      onClose={onClose}
      onGespeichert={onGespeichert}
    />,
  );
  return { onClose, onGespeichert };
}

const anbau = () =>
  ortNachSchreiben({
    flaechen: [
      { m2: 3100, gueltigAb: '2026-10-01', gueltigBis: '2026-12-31', zustand: 'beendet' },
      { m2: 3400, gueltigAb: '2027-01-01', gueltigBis: null, zustand: 'gueltig' },
    ],
    rueckwirkung: { art: 'rueckwirkend', tage: 14, abzeichen: 'rückwirkend (14 Tage)' },
  });

describe('FlaecheDialog — „Fläche ändern“ mit Verlauf (AP-02 IP-8, T7)', () => {
  it('T7: die rückwirkende Änderung sagt ihre Folgen vorher und zeigt danach den Verlauf mit Kennzeichen', async () => {
    const antwort = anbau();
    const put = vi.spyOn(api, 'ortFlaeche').mockResolvedValue(antwort);
    const { onGespeichert } = oeffne();

    expect(screen.getByText('Bezugsfläche Halle 2 (G-2)')).toBeInTheDocument();
    expect(screen.getByText('Kennzahlen je Monat rechnen mit der damals gültigen Fläche.')).toBeInTheDocument();
    expect(screen.getByText(sp(`Heute gilt: 3${NB}100${NB}m²`))).toBeInTheDocument();
    // Ohne Zahl sagt die Karte nichts — geraten wird nicht.
    expect(screen.queryByTestId('flaeche-folgen')).toBeNull();

    fireEvent.change(screen.getByLabelText('Neue Fläche (m²) *'), { target: { value: '3400' } });
    // „Gültig ab“ ist heute vorbelegt …
    expect(within(screen.getByTestId('flaeche-folgen')).getByText('Ab heute')).toBeInTheDocument();
    // … der Anbau gilt aber seit Neujahr.
    fireEvent.click(screen.getByRole('combobox', { name: 'Gültig ab *' }));
    fireEvent.click(screen.getAllByRole('gridcell', { name: '1' })[0]);
    const vorher = screen.getByTestId('flaeche-folgen');
    expect(within(vorher).getByText('Rückwirkend um 14 Tage')).toBeInTheDocument();
    expect(vorher).toHaveTextContent('Heute ist der 15.01.2027.');
    expect(vorher).toHaveTextContent(
      sp(`Ab dem 01.01.2027 rechnen Kennzahlen in kWh/m² mit 3${NB}400${NB}m² — auch für Tage, die schon vorbei sind.`),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fläche speichern' }));
    expect(await screen.findByRole('heading', { name: 'Verlauf der Fläche' })).toBeInTheDocument();
    expect(put).toHaveBeenCalledWith(ORT_IDS.g2, { m2: 3400, gueltigAb: '2027-01-01' });
    expect(screen.getByText('Fläche gespeichert')).toBeInTheDocument();

    const zeilen = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(zeilen).toEqual([
      `3${NB}100${NB}m²gültig 01.10.2026 bis 31.12.2026`,
      `3${NB}400${NB}m²gültig ab 01.01.2027 (neu)rückwirkend (14 Tage)`,
    ]);
    const nachher = screen.getByTestId('flaeche-folgen');
    expect(nachher).toHaveTextContent(
      sp(`Kennzahlen in kWh/m² rechnen ab dem 01.01.2027 mit 3${NB}400${NB}m²; bis zum 31.12.2026 bleibt es bei 3${NB}100${NB}m².`),
    );
    expect(nachher).toHaveTextContent('Für die 14 Tage vom 01.01.2027 bis 14.01.2027 gilt die neue Fläche nachträglich.');
    // Kein Satz über Berichte: freigegebene Berichte gibt es noch nicht (AP-12).
    expect(nachher).not.toHaveTextContent('Bericht');

    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(onGespeichert).toHaveBeenCalledWith(antwort);
  });

  it('leer gesendet: der Satz des Servers an der Zahl, nichts gesendet', () => {
    const put = vi.spyOn(api, 'ortFlaeche');
    oeffne();
    fireEvent.click(screen.getByRole('button', { name: 'Fläche speichern' }));
    expect(screen.getByText(sp(FLAECHE_SATZ))).toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
  });

  it('eine Ablehnung des Servers steht am Feld, der Dialog bleibt bei der Eingabe', async () => {
    const satz = `Halle 2 hat am 15.01.2027 bereits 3${NB}100${NB}m².`;
    vi.spyOn(api, 'ortFlaeche').mockRejectedValue(
      new ApiError(409, satz, { code: 'gleiche_flaeche', message: satz }),
    );
    const { onGespeichert } = oeffne();
    fireEvent.change(screen.getByLabelText('Neue Fläche (m²) *'), { target: { value: '3100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fläche speichern' }));
    expect(await screen.findByText(sp(satz))).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Verlauf der Fläche' })).toBeNull();
    expect(onGespeichert).not.toHaveBeenCalled();
  });

  it('Abbrechen vor dem Speichern schreibt nichts', () => {
    const put = vi.spyOn(api, 'ortFlaeche');
    const { onClose } = oeffne();
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(onClose).toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
