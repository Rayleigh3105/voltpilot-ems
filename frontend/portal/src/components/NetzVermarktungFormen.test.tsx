import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { buettner, buettnerNv, GERAET_BUETTNER, gore, GERAET_GORE, goreNv, SITE_BUETTNER, SITE_GORE } from '../test/anlagensteuerungFixtures';
import { DirektvermarkterForm, EinheitForm, EinspeisemanagementForm, NetzbetreiberBlatt } from './NetzVermarktungFormen';

/**
 * Anlage › Einstellungen › „Strom & Geld“ (UEMS EZ-10 (3)): Direktvermarkter, Einspeisemanagement und je Einheit
 * Bezeichnung und MaStR-Nummer. Die Routen ersetzen alles - jedes Formular schickt das Übrige unverändert mit.
 */
afterEach(() => vi.restoreAllMocks());

describe('NetzVermarktungFormen', () => {
  it('Netzbetreiber: nur gelesen, mit dem Hinweis aus der Steuerung', () => {
    render(<NetzbetreiberBlatt nv={buettnerNv()} />);
    expect(screen.getByText('nicht eingetragen')).toBeInTheDocument();
    expect(screen.getByText(/am Netzanschluss ist keiner eingetragen/)).toBeInTheDocument();
  });

  it('Direktvermarkter: Freitext und Kanal; das Einspeisemanagement reist unverändert mit', async () => {
    const put = vi.spyOn(api, 'netzVermarktungAendern').mockResolvedValue({ ...buettnerNv(), direktvermarkter: 'WVV Würzburg', revision: 2 });
    const onSaved = vi.fn();
    render(<DirektvermarkterForm siteId={SITE_BUETTNER} nv={buettnerNv()} onCancel={() => {}} onSaved={onSaved} />);
    expect(screen.getByText('Die Steuerung nennt „WVV (Stadtwerke Würzburg)“. Ihr Name ändert nur die Anzeige.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Direktvermarkter'), { target: { value: ' WVV Würzburg ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(put).toHaveBeenCalledWith(SITE_BUETTNER, {
      expected_revision: 1,
      direktvermarkter: 'WVV Würzburg',
      direktvermarkter_kanal: 'relais_ma',
      einspeisemanagement: 'stufen',
      einspeisemanagement_prozent: null,
    });
  });

  it('Direktvermarkter: ein Konflikt (409) sagt, was zu tun ist', async () => {
    vi.spyOn(api, 'netzVermarktungAendern').mockRejectedValue(new ApiError(409, 'Konflikt'));
    render(<DirektvermarkterForm siteId={SITE_GORE} nv={goreNv()} onCancel={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('inzwischen geändert');
  });

  it('Einspeisemanagement: statisch mit deutscher Prozentangabe; falsche Zahl zeigt den Fehler am Feld', async () => {
    const put = vi.spyOn(api, 'netzVermarktungAendern').mockResolvedValue(goreNv());
    render(<EinspeisemanagementForm siteId={SITE_GORE} nv={{ ...goreNv(), einspeisemanagement: 'statisch', einspeisemanagement_prozent: 70 }} onCancel={() => {}} onSaved={() => {}} />);
    const feld = screen.getByLabelText('Grenze (%)');
    expect(feld).toHaveValue('70');
    fireEvent.change(feld, { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('zwischen 0 und 100');
    expect(feld).toHaveFocus();
    expect(put).not.toHaveBeenCalled();
    fireEvent.change(feld, { target: { value: '60,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1]).toEqual({
      expected_revision: 3,
      direktvermarkter: null,
      direktvermarkter_kanal: null,
      einspeisemanagement: 'statisch',
      einspeisemanagement_prozent: 60.5,
    });
  });

  it('Einheit: Umbenennen und MaStR-Nummer; Art, Typ und Nennleistung bleiben, eine falsche Nummer wird nie geschickt', async () => {
    const put = vi.spyOn(api, 'erzeugungseinheitAendern').mockResolvedValue(buettner().einheiten[0]);
    const onSaved = vi.fn();
    render(<EinheitForm geraetId={GERAET_BUETTNER} einheit={buettner().einheiten[0]} onCancel={() => {}} onSaved={onSaved} />);
    expect(screen.getByText(/Umbenennen ändert nur die Anzeige/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Bezeichnung'), { target: { value: 'Motor groß' } });
    const see = screen.getByLabelText('MaStR-Nummer der Einheit');
    fireEvent.change(see, { target: { value: 'SEE123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('SEE und hat danach zwölf Ziffern');
    expect(see).toHaveFocus();
    expect(put).not.toHaveBeenCalled();
    fireEvent.change(see, { target: { value: 'see 912345678901' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(put).toHaveBeenCalledWith(GERAET_BUETTNER, 1, {
      einheit_art: 'bhkw_motor',
      bezeichnung: 'Motor groß',
      typ: 'MAN E0836LE',
      nennleistung_kw: 66,
      registry_unit_id: 'SEE912345678901',
    });
  });

  it('Einheit: weicht der Typ vom Namen im Bild ab, steht der Hinweis im Blatt', () => {
    const wr2 = gore().einheiten.find((e) => e.te_nr === 2)!;
    render(<EinheitForm geraetId={GERAET_GORE} einheit={wr2} onCancel={() => {}} onSaved={() => {}} />);
    expect(screen.getByText('Die Steuerung nennt „Growatt MAX 125KTL3 X“.')).toBeInTheDocument();
  });
});
