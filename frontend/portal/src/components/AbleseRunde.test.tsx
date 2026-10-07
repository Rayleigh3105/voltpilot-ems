import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type AblesungAntwort, type MessstelleRegisterZeile, type MessstellenRegister } from '../api';
import { setSelbstauskunft } from '../rollen';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { AbleseRunde } from './AbleseRunde';

/**
 * Die Ablese-Runde je Gebäude (Konzept Messen m1, §6.5 Variante 3A) am 02.11.2026, 07:30 MEZ - dem Szenario-Tag des
 * Konzepts: vier Zähler in Halle 1, zuletzt abgelesen am 01.10.2026.
 */

const ZONE = 'Europe/Berlin';
const ERSTER_OKTOBER = '2026-10-01T00:00:00+02:00';
const WARTEN = { timeout: 3000 };

function abgelesen(z: MessstelleRegisterZeile, stand: number): MessstelleRegisterZeile {
  return {
    ...z,
    lebenszyklus: 'aktiv',
    quelle: { stand: 'ablesung', fuehrend: null, davor: null, vergleichsquellen: 0, ablesung: { seit: '2024-10-01T00:00:00+02:00', zuletzt: ERSTER_OKTOBER, faellig_ab: '2026-12-01T00:00:00+01:00' } },
    letzter_wert: { wert: stand, text: null, einheit: 'kWh', zeitpunkt: ERSTER_OKTOBER },
  };
}

function halle1(): MessstellenRegister {
  const r = ahrenbergRegister();
  const stand: Record<string, number> = { 'MS-03': 1_204_500, 'MS-06': 647_760, 'MS-07': 523_560, 'MS-08': 747_120 };
  return { ...r, register: r.register.map((z) => (z.kennzeichen in stand ? abgelesen(z, stand[z.kennzeichen]) : z)) };
}

const antwort = (kz: string, menge: number): AblesungAntwort => ({
  urteil: 'eingetragen',
  korrektur: null,
  ablesung: { quelle: 'q', zeitpunkt: '2026-11-02T07:30:00+01:00', fassung: 1, stand: 1, monat: '2026-10-01', woher: 'eingabe', urheber: { name: 'Jonas Wendlinger', rolle: 'kundenadministrator' }, korrektur: null, eingetragen_am: '2026-11-02T07:31:00+01:00' },
  ablesezeitraum: { menge, zustand: 'vollständig', kennzeichen: `Ablesezeitraum ${kz}` },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T06:30:00Z'));
  vi.spyOn(api, 'messstellenRegister').mockResolvedValue(halle1());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const reihen = () => screen.getAllByTestId('ablese-runde-reihe');
const feld = (kz: string) => within(reihen().find((r) => r.textContent?.includes(kz))!).getByRole('textbox');

describe('Ablese-Runde Halle 1', () => {
  it('ein Zeitpunkt für alle, je Zähler der letzte Stand; das erste Feld ist das Ziel der Wiedervorlage', async () => {
    render(<AbleseRunde ort="G-1" zone={ZONE} anfrage={{}} onZurueck={vi.fn()} />);
    const titel = await screen.findByRole('heading', { level: 1 }, WARTEN);
    expect(titel.textContent).toMatch(/ ablesen$/);
    expect(screen.getByText('4 Zähler · Werk Ahrenberg · zuletzt abgelesen am 01.10.2026')).toBeInTheDocument();
    expect(screen.getByText('Abgelesen am')).toBeInTheDocument();
    expect(screen.getByText('Zählt zum Oktober 2026 – dem Zeitraum seit der letzten Ablesung am 01.10.')).toBeInTheDocument();
    expect(screen.getByTestId('ablese-runde-fortschritt')).toHaveTextContent('0 von 4 eingetragen');
    expect(reihen().map((r) => r.querySelector('.vp-ar-kz')?.textContent)).toEqual(['MS-03', 'MS-06', 'MS-07', 'MS-08']);
    expect(reihen()[1].textContent).toContain('zuletzt 647.760 kWh');
    expect(feld('MS-03')).toHaveAttribute('data-entscheid', 'zaehlerablesung');
    expect(feld('MS-06')).not.toHaveAttribute('data-entscheid');
    expect(feld('MS-03')).toHaveAttribute('enterkeyhint', 'next');
    expect(feld('MS-08')).toHaveAttribute('enterkeyhint', 'done');
  });

  it('„Weiter“ speichert mit derselben Route wie der Dialog und springt zum nächsten Feld; die Antwort bestätigt in Grün', async () => {
    const post = vi.spyOn(api, 'ablesungEintragen').mockImplementation(async (kz) => antwort(kz, 14_420));
    render(<AbleseRunde ort="G-1" zone={ZONE} anfrage={{}} onZurueck={vi.fn()} />);
    await screen.findAllByTestId('ablese-runde-reihe', undefined, WARTEN);
    fireEvent.change(feld('MS-06'), { target: { value: '662.180' } });
    fireEvent.keyDown(feld('MS-06'), { key: 'Enter' });
    await waitFor(() => expect(post).toHaveBeenCalledWith('MS-06', { zeitpunkt: '2026-11-02T07:30:00+01:00', stand: '662.180', zuordnung_monat: '2026-10' }));
    await waitFor(() => expect(reihen()[1].textContent).toContain('gespeichert · 14.420\u00a0kWh seit 01.10.'));
    expect(reihen()[1]).toHaveClass('is-gespeichert');
    expect(feld('MS-06')).toHaveAttribute('readonly');
    expect(screen.getByTestId('ablese-runde-fortschritt')).toHaveTextContent('1 von 4 eingetragen');
    await waitFor(() => expect(document.activeElement).toBe(feld('MS-07')));
    // Das Ziel der Wiedervorlage wandert nicht hinter ein gespeichertes Feld.
    expect(feld('MS-03')).toHaveAttribute('data-entscheid', 'zaehlerablesung');
  });

  it('ein Prüfsatz bleibt am Zähler und die Runde läuft weiter - vor dem Senden und aus der Antwort des Servers', async () => {
    const post = vi
      .spyOn(api, 'ablesungEintragen')
      .mockRejectedValue(new ApiError(422, 'Rücksprung — Zählerwechsel eintragen?', { code: 'ruecksprung' }));
    render(<AbleseRunde ort="G-1" zone={ZONE} anfrage={{}} onZurueck={vi.fn()} />);
    await screen.findAllByTestId('ablese-runde-reihe', undefined, WARTEN);
    fireEvent.change(feld('MS-03'), { target: { value: 'zwölf' } });
    fireEvent.keyDown(feld('MS-03'), { key: 'Enter' });
    expect(await within(reihen()[0]).findByRole('alert')).toHaveTextContent('Bitte geben Sie eine Zahl ein, zum Beispiel 1.234,5.');
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(feld('MS-06'), { target: { value: '600.000' } });
    fireEvent.keyDown(feld('MS-06'), { key: 'Enter' });
    expect(await within(reihen()[1]).findByRole('alert', undefined, WARTEN)).toHaveTextContent('Rücksprung — Zählerwechsel eintragen?');
    expect(feld('MS-06')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('ablese-runde-fortschritt')).toHaveTextContent('0 von 4 eingetragen');
    // Eine neue Eingabe nimmt den Satz zurück.
    fireEvent.change(feld('MS-06'), { target: { value: '662.180' } });
    expect(within(reihen()[1]).queryByRole('alert')).toBeNull();
  });

  it('„Fertig“ speichert, was eingetragen und noch nicht gespeichert ist, und führt zurück', async () => {
    const post = vi.spyOn(api, 'ablesungEintragen').mockImplementation(async (kz) => antwort(kz, 1_000));
    const zurueck = vi.fn();
    render(<AbleseRunde ort="G-1" zone={ZONE} anfrage={{}} onZurueck={zurueck} />);
    await screen.findAllByTestId('ablese-runde-reihe', undefined, WARTEN);
    fireEvent.change(feld('MS-07'), { target: { value: '540.000' } });
    fireEvent.change(feld('MS-08'), { target: { value: '760.000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    await waitFor(() => expect(zurueck).toHaveBeenCalled(), WARTEN);
    expect(post.mock.calls.map((c) => c[0])).toEqual(['MS-07', 'MS-08']);
  });

  it('„Fertig“ schickt einen abgelehnten, unveränderten Stand nicht noch einmal und bleibt in der Runde', async () => {
    const post = vi
      .spyOn(api, 'ablesungEintragen')
      .mockImplementation(async (kz) => {
        if (kz === 'MS-06') throw new ApiError(422, 'Rücksprung — Zählerwechsel eintragen?', { code: 'ruecksprung' });
        return antwort(kz, 1_000);
      });
    const zurueck = vi.fn();
    render(<AbleseRunde ort="G-1" zone={ZONE} anfrage={{}} onZurueck={zurueck} />);
    await screen.findAllByTestId('ablese-runde-reihe', undefined, WARTEN);
    fireEvent.change(feld('MS-06'), { target: { value: '600.000' } });
    fireEvent.keyDown(feld('MS-06'), { key: 'Enter' });
    await within(reihen()[1]).findByRole('alert', undefined, WARTEN);
    fireEvent.change(feld('MS-07'), { target: { value: '540.000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    await waitFor(() => expect(reihen()[2]).toHaveClass('is-gespeichert'), WARTEN);
    expect(post.mock.calls.map((c) => c[0])).toEqual(['MS-06', 'MS-07']);
    expect(zurueck).not.toHaveBeenCalled();
  });

  it('ein neuer Zeitpunkt macht einen abgelehnten Stand wieder sendbar - „Fertig“ schickt ihn dann (Review r4 S10)', async () => {
    let erster = true;
    const post = vi.spyOn(api, 'ablesungEintragen').mockImplementation(async (kz) => {
      if (kz === 'MS-06' && erster) {
        erster = false;
        throw new ApiError(422, 'Liegt nicht nach der letzten Ablesung (01.10.2026, 00:00).', { code: 'reihenfolge' });
      }
      return antwort(kz, 1_000);
    });
    const zurueck = vi.fn();
    render(<AbleseRunde ort="G-1" zone={ZONE} anfrage={{}} onZurueck={zurueck} />);
    await screen.findAllByTestId('ablese-runde-reihe', undefined, WARTEN);
    fireEvent.change(feld('MS-06'), { target: { value: '662.180' } });
    fireEvent.keyDown(feld('MS-06'), { key: 'Enter' });
    expect(await within(reihen()[1]).findByRole('alert', undefined, WARTEN)).toHaveTextContent('Liegt nicht nach der letzten Ablesung');
    const uhr = screen.getByLabelText(/^Uhrzeit/) as HTMLInputElement;
    // Früher als „jetzt“ (07:30 MEZ) - eine Ablesung liegt nie in der Zukunft.
    fireEvent.change(uhr, { target: { value: '07:15' } });
    fireEvent.blur(uhr);
    await waitFor(() => expect(within(reihen()[1]).queryByRole('alert')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    await waitFor(() => expect(zurueck).toHaveBeenCalled(), WARTEN);
    expect(post.mock.calls.filter((c) => c[0] === 'MS-06')).toHaveLength(2);
  });

  it('wer das Feld verlässt, speichert einen neuen Stand; „Fertig“ währenddessen wartet darauf statt doppelt zu senden (Review r4 S12)', async () => {
    let fertigMelden: () => void = () => undefined;
    const post = vi.spyOn(api, 'ablesungEintragen').mockImplementation(
      (kz) => new Promise<AblesungAntwort>((ok) => (fertigMelden = () => ok(antwort(kz, 1_000)))),
    );
    const zurueck = vi.fn();
    render(<AbleseRunde ort="G-1" zone={ZONE} anfrage={{}} onZurueck={zurueck} />);
    await screen.findAllByTestId('ablese-runde-reihe', undefined, WARTEN);
    fireEvent.change(feld('MS-07'), { target: { value: '540.000' } });
    fireEvent.blur(feld('MS-07'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    fertigMelden();
    await waitFor(() => expect(zurueck).toHaveBeenCalled(), WARTEN);
    expect(post).toHaveBeenCalledTimes(1);
    // Ein leeres oder abgelehntes Feld verlassen sendet nichts.
    fireEvent.blur(feld('MS-08'));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('am Telefon zoomt iOS das Feld nicht heran (16 px)', () => {
    const css = readFileSync(resolve('src/components/AbleseRunde.css'), 'utf8');
    expect(css).toMatch(/font: 600 1rem var\(--vp-font-heading\)/);
  });

  it('ohne Recht zum Ablesen: lesen ja, ein Feld nein - mit Grund und Person', async () => {
    setSelbstauskunft(rechteSeed('MD').me);
    render(<AbleseRunde ort="G-1" zone={ZONE} anfrage={{}} onZurueck={vi.fn()} />);
    await screen.findByRole('heading', { level: 1 }, WARTEN);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getByRole('note')).toHaveTextContent('Jonas Wendlinger');
  });

  it('ein Ort ohne Ablesezähler sagt es', async () => {
    render(<AbleseRunde ort="G-2" zone={ZONE} anfrage={{}} onZurueck={vi.fn()} />);
    expect(await screen.findByText('An diesem Ort wird kein Zähler von Hand abgelesen.', undefined, WARTEN)).toBeInTheDocument();
  });
});
