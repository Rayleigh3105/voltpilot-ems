import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ee8, mb1, messplanungRouten } from '../test/messplanungBuehne';
import { MS23_ID } from '../test/messplanungFixtures';
import { MessbedarfKarte } from './Messplanung';

/**
 * UEMS AP-16 IP-20 (§5.3 Schritte 1–3, R5): an der Seite von EE-8 — erfassen, „Messstelle einrichten“ springt in den
 * ECHTEN Messstellen-Dialog mit Ort G-1 und Wirkenergie · Bezug vorbelegt, der Bedarf ist danach mit MS-23 eingelöst;
 * verwerfen verlangt eine Begründung. Die Routen spielt `messplanungRouten` (dieselbe Bühne wie `e2e/bewertung.tsx`).
 */

type Routen = ReturnType<typeof messplanungRouten>;
let routen: Routen;
const spione: Partial<Record<keyof Routen, ReturnType<typeof vi.fn>>> = {};

function verdrahte(bedarfe = [mb1()]) {
  routen = messplanungRouten('2026-11-27', 'IK', bedarfe);
  for (const k of Object.keys(routen) as (keyof Routen)[]) {
    spione[k] = vi.spyOn(api, k as never).mockImplementation(routen[k] as never) as unknown as ReturnType<typeof vi.fn>;
  }
}

const knopf = (name: string | RegExp) => screen.getByRole('button', { name });
async function waehle(label: string, option: RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => verdrahte());
afterEach(() => vi.restoreAllMocks());

describe('MessbedarfKarte (AP-16 IP-20)', () => {
  it('einlösen: Sprung in den Messstellen-Dialog mit Ort und Größe vorbelegt; danach eingelöst durch MS-23 — keine Datenquelle, nie 0', async () => {
    render(<MessbedarfKarte einsatz={ee8()} verwalten />);
    const zeile = await screen.findByTestId('messbedarf-MB-1');
    expect(within(zeile).getByTestId('messbedarf-zustand').textContent).toBe('offen');
    fireEvent.click(within(zeile).getByRole('button', { name: 'Messstelle einrichten' }));

    // Schritt 1: Kennzeichen-Vorschlag, Hauptgröße und Richtung aus dem Bedarf.
    await waitFor(() => expect((screen.getByLabelText('Kennzeichen') as HTMLInputElement).value).toBe('MS-23'));
    expect(screen.getByRole('combobox', { name: 'Hauptgröße *' }).textContent).toContain('Wirkenergie');
    expect(screen.getByRole('combobox', { name: 'Richtung *' }).textContent).toContain('Bezug');
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Halle 1 Allgemein' } });
    await waehle('Wertart *', /^Zählerstand/);
    fireEvent.click(knopf('Weiter: Zuordnung'));

    // Schritt 2: der Ort G-1 Halle 1 ist vorbelegt; „Weiter“ schreibt ihn — jetzt ist MS-23 eingerichtet.
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Ort' }).textContent).toContain('Halle 1'));
    expect(spione.messbedarfEinloesen).not.toHaveBeenCalled();
    fireEvent.click(knopf('Weiter: Quelle'));
    await waitFor(() => expect(spione.messbedarfEinloesen).toHaveBeenCalledWith(ee8().id, mb1().id, MS23_ID));
    expect(spione.messbedarfEinloesen).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole('button', { name: 'Später binden' }));
    await waitFor(() =>
      expect(screen.getByTestId('messbedarf-satz').textContent).toBe(
        'Messbedarf MB-1: Lüftung, Beleuchtung und Allgemeinstrom Halle 1 — eingelöst durch MS-23 Halle 1 Allgemein (keine Datenquelle seit 27.11.2026).',
      ),
    );
    expect(screen.getByTestId('messbedarf-zustand').textContent).toBe('eingelöst');
    expect(screen.getByTestId('messbedarf-messstelle').textContent).toBe('MS-23');
    expect(screen.queryByRole('button', { name: 'Messstelle einrichten' })).toBeNull();
  });

  it('erfassen: Wortlaut ist Pflicht; der neue Bedarf steht offen in der Liste', async () => {
    verdrahte([]);
    render(<MessbedarfKarte einsatz={ee8()} verwalten />);
    await screen.findByTestId('messplanung-leer');
    fireEvent.click(knopf('Messbedarf erfassen'));
    const dialog = await screen.findByTestId('messbedarf-erfassen');
    fireEvent.submit(dialog);
    expect(await screen.findByText('Bitte beschreiben Sie, was gemessen werden soll.')).toBeTruthy();
    expect(spione.messbedarfErfassen).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Was soll gemessen werden?'), { target: { value: 'Lüftung Halle 1' } });
    fireEvent.submit(dialog);
    await waitFor(() => expect(spione.messbedarfErfassen).toHaveBeenCalledWith(ee8().id, { wortlaut: 'Lüftung Halle 1', ort: null, groesse: null, frist: null }));
    expect((await screen.findByTestId('messbedarf-MB-1')).textContent).toContain('Lüftung Halle 1');
  });

  it('verwerfen verlangt eine Begründung; der Bedarf bleibt lesbar', async () => {
    render(<MessbedarfKarte einsatz={ee8()} verwalten />);
    fireEvent.click(await screen.findByRole('button', { name: 'Verwerfen' }));
    const dialog = await screen.findByTestId('messbedarf-verwerfen');
    fireEvent.submit(dialog);
    expect(await screen.findByText('Bitte begründen Sie, warum der Bedarf verworfen wird.')).toBeTruthy();
    expect(spione.messbedarfVerwerfen).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Begründung'), { target: { value: 'Zähler wirtschaftlich nicht sinnvoll' } });
    fireEvent.submit(dialog);
    await waitFor(() => expect(screen.getByTestId('messbedarf-zustand').textContent).toBe('verworfen'));
    expect(screen.getByTestId('messbedarf-satz').textContent).toBe('Verworfen am 27.11.2026: ‚Zähler wirtschaftlich nicht sinnvoll‘');
    expect(screen.getByTestId('messbedarf-MB-1').textContent).toContain('Lüftung, Beleuchtung und Allgemeinstrom Halle 1');
  });

  it('ohne energieeinsatz.verwalten: lesen ja, kein Schreibknopf, ein Satz', async () => {
    render(<MessbedarfKarte einsatz={ee8()} verwalten={false} />);
    await screen.findByTestId('messbedarf-MB-1');
    expect(screen.queryByRole('button', { name: /Messbedarf erfassen|Messstelle einrichten|Verwerfen/ })).toBeNull();
    expect(screen.getByText(/dürfen Kundenadministratoren und Energiemanager/)).toBeTruthy();
  });
});
