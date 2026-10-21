import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const anlegen = vi.fn();
const probelauf = vi.fn();
vi.mock('../ueberwachungApi', () => ({
  ueberwachungApi: {
    anlegen: (...a: unknown[]) => anlegen(...a),
    probelauf: (...a: unknown[]) => probelauf(...a),
  },
}));

import { UeberwachenBlatt } from './UeberwachenBlatt';

/**
 * Die Erzeuger-Vorlagen im Blatt „Überwachen“ (UEMS EZ-11, EW-9 A): unter Glocke › Meldungen › Überwachungen
 * angelegt wie jede andere Überwachung, vorbelegt aus dem Katalog, mit den Schwellen der Vorlage als Felder - und
 * ohne Probelauf-Vorschau, weil es für diese Werte keine Rückschau gibt.
 */
const sp = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ');

function blatt(wertart: string) {
  const onUeberwacht = vi.fn();
  render(
    <UeberwachenBlatt
      offen
      isPhone={false}
      onClose={() => {}}
      wertart={wertart}
      bezug={{ anlage: 'a1' }}
      aktuellerWert={null}
      titelZusatz="Anlage folgt nicht"
      onUeberwacht={onUeberwacht}
    />,
  );
  return onUeberwacht;
}

afterEach(() => {
  anlegen.mockReset();
  probelauf.mockReset();
});

describe('UeberwachenBlatt · Erzeuger-Vorlagen', () => {
  it('belegt „Anlage folgt nicht“ vor und schickt die Toleranzen als Schwellen der Regel', async () => {
    anlegen.mockResolvedValue({ id: 'r1' });
    const onUeberwacht = blatt('erzeuger.anlage_folgt_nicht');

    expect(sp(screen.getByText(/Sag mir Bescheid/).textContent)).toBe(
      'Sag mir Bescheid, wenn die Anlage länger als 5 Minuten mehr erzeugt, als die wirksame Grenze erlaubt '
        + '(Toleranz 5 % der installierten Leistung, mindestens 5 kW), oder die Steuerung meldet, dass sie nicht '
        + 'folgt. · Warnung',
    );
    expect(screen.getByText('Meldet ab dem Start, ohne Probelauf.')).toBeTruthy();
    // keine freie Schwelle/Rückkehrschwelle und keine Zustands-Chips - die Vorlage kennt ihr Ziel
    expect(screen.queryByLabelText(/Rückkehr/)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Wenn der Zustand' })).toBeNull();

    const kw = screen.getByLabelText('Toleranz mindestens (kW)') as HTMLInputElement;
    expect(kw.value).toBe('5');
    fireEvent.change(kw, { target: { value: '12' } });
    expect(sp(screen.getByText(/Sag mir Bescheid/).textContent)).toContain('mindestens 12 kW');
    expect((screen.getByLabelText('Toleranz (% der installierten Leistung)') as HTMLInputElement).value).toBe('5');

    fireEvent.click(screen.getByRole('button', { name: 'Überwachung starten' }));
    await waitFor(() => expect(anlegen).toHaveBeenCalledTimes(1));
    expect(anlegen.mock.calls[0][0]).toEqual({
      wertart: 'erzeuger.anlage_folgt_nicht',
      bezug: { anlage: 'a1' },
      bedingung: { art: 'zustand', ziel: ['folgt_nicht'], dauer_s: 300, erholen_s: 300, toleranz_prozent: 5, toleranz_kw: 12 },
      schwere: 'warnung',
    });
    await waitFor(() => expect(onUeberwacht).toHaveBeenCalled());
    expect(probelauf).not.toHaveBeenCalled();
  });

  it('meldet „Netzbetreiber hat abgeschaltet“ sofort und lässt die Dauer 0 zu', async () => {
    anlegen.mockResolvedValue({ id: 'r2' });
    blatt('erzeuger.netzbetreiber_abgeschaltet');

    expect(sp(screen.getByText(/Sag mir Bescheid/).textContent)).toBe(
      'Sag mir Bescheid, sobald der Netzbetreiber die Anlage abschaltet (Not-Aus). · Warnung',
    );
    const dauer = screen.getByLabelText('Länger als (Minuten, 0 = sofort)') as HTMLInputElement;
    expect(dauer.value).toBe('0');

    fireEvent.click(screen.getByRole('button', { name: 'Überwachung starten' }));
    await waitFor(() => expect(anlegen).toHaveBeenCalledTimes(1));
    expect(anlegen.mock.calls[0][0].bedingung).toEqual({ art: 'zustand', ziel: ['abgeschaltet'], dauer_s: 0, erholen_s: 300 });
  });

  it('sperrt „Überwachung starten“ bei einer negativen Toleranz', () => {
    blatt('erzeuger.anlage_folgt_nicht');
    fireEvent.change(screen.getByLabelText('Toleranz (% der installierten Leistung)'), { target: { value: '-1' } });
    expect((screen.getByRole('button', { name: 'Überwachung starten' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('nennt die Fernwirk-Vorlage mit ihren zehn Minuten', () => {
    blatt('erzeuger.fernwirk_verbindung_weg');
    expect(sp(screen.getByText(/Sag mir Bescheid/).textContent)).toBe(
      'Sag mir Bescheid, wenn die Fernwirk-Verbindung zum Netzbetreiber länger als 10 Minuten nicht steht '
        + '(nur bei Fernwirktechnik). · Warnung',
    );
  });

  it('belegt „Programmstand veraltet“ mit 24 Stunden vor und schickt Ziel „älter als erwartet“ (EZ-11b)', async () => {
    anlegen.mockResolvedValue({ id: 'r3' });
    blatt('erzeuger.programmstand_veraltet');

    expect(sp(screen.getByText(/Sag mir Bescheid/).textContent)).toBe(
      'Sag mir Bescheid, wenn die Anlagensteuerung länger als 24 Stunden einen älteren Programmstand fährt als '
        + 'erwartet. · Warnung',
    );
    expect(screen.getByText('Meldet ab dem Start, ohne Probelauf.')).toBeTruthy();
    const dauer = screen.getByLabelText('Länger als (Minuten)') as HTMLInputElement;
    expect(dauer.value).toBe('1440');
    fireEvent.change(dauer, { target: { value: '2880' } });
    expect(sp(screen.getByText(/Sag mir Bescheid/).textContent)).toContain('länger als 48 Stunden');

    fireEvent.click(screen.getByRole('button', { name: 'Überwachung starten' }));
    await waitFor(() => expect(anlegen).toHaveBeenCalledTimes(1));
    expect(anlegen.mock.calls[0][0]).toEqual({
      wertart: 'erzeuger.programmstand_veraltet',
      bezug: { anlage: 'a1' },
      bedingung: { art: 'zustand', ziel: ['aelter'], dauer_s: 172800, erholen_s: 300 },
      schwere: 'warnung',
    });
    expect(probelauf).not.toHaveBeenCalled();
  });
});
