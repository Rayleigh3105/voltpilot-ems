import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { setSelbstauskunft } from '../rollen';
import { EM_IDS, energiemanagementBuehne } from '../test/energiemanagementFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { DokumentSeite } from './DokumentSeite';

const JETZT = '2029-02-12T09:00:00+01:00';

async function waehle(label: string, option: RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

describe('Dokument: „Geprüft, bleibt“ (DK5) als Entscheid der Wiedervorlage (Konzept Wiedervorlage w1)', () => {
  const original = { ...api };
  let buehne: ReturnType<typeof energiemanagementBuehne>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(JETZT));
    const me = rechteSeed('IK').me;
    setSelbstauskunft(me);
    buehne = energiemanagementBuehne('ahrenberg', { kennung: me.kennung!, name: me.name! }, () => new Date().toISOString());
    Object.assign(api, buehne.routen);
    await buehne.bereit;
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
    vi.useRealTimers();
  });

  it('die Aktionen tragen den Entscheid; „Geprüft, bleibt“ hält Person, Tag und Begründung fest und meldet die nächste Überprüfung', async () => {
    render(<DokumentSeite id={EM_IDS.d1} onListe={() => {}} />);
    await act(async () => {});
    const aktionen = screen.getByTestId('dokument-geprueft').closest('[data-entscheid]');
    expect(aktionen?.getAttribute('data-entscheid')).toBe('dokument_ueberpruefung');
    // Der erste Knopf im Entscheid ist „Geprüft, bleibt“: dorthin führt der Schritt „Bestätigen oder neu fassen“.
    expect(aktionen?.querySelector('button')?.textContent).toBe('Geprüft, bleibt');

    await act(async () => {
      fireEvent.click(screen.getByTestId('dokument-geprueft'));
    });
    const dialog = await screen.findByTestId('geprueft-dialog');
    expect(dialog.textContent).toContain('Fassung 1 bleibt gültig.');
    // Ohne Person und Begründung hält VoltPilot nichts fest.
    await act(async () => {
      fireEvent.click(screen.getByTestId('geprueft-senden'));
    });
    expect(dialog.textContent).toContain('Bitte wählen Sie, wer entschieden hat.');
    expect(buehne.gesendet.filter((g) => g.route.endsWith('/geprueft'))).toEqual([]);

    await waehle('entschieden von', /^Robert Falk/);
    fireEvent.change(screen.getByLabelText('Begründung'), { target: { value: 'Mit der Jahresplanung 2029 durchgesehen; die Politik gilt unverändert.' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('geprueft-senden'));
    });
    expect(buehne.gesendet.filter((g) => g.route.endsWith('/geprueft'))).toEqual([
      {
        route: `POST /api/v1/energiemanagement/dokumente/${EM_IDS.d1}/geprueft`,
        koerper: { entschieden_von: EM_IDS.RF, am: null, begruendung: 'Mit der Jahresplanung 2029 durchgesehen; die Politik gilt unverändert.' },
      },
    ]);
    expect(screen.getByTestId('dokument-geprueft-bestaetigt').textContent).toBe(
      'Energiepolitik D-0001: geprüft, bleibt. Die nächste Überprüfung ist am 12.02.2030 fällig.',
    );
    expect(screen.queryByTestId('geprueft-dialog')).toBeNull();
  });

  it('nur an einer Vorgabe mit gültiger Fassung: ein Nachweis hat keine Überprüfung', async () => {
    const d = await api.energiemanagementDokumentAnlegen({ art: 'kompetenz', titel: 'Unterweisung Zeitschaltung', bezug: { art: 'unternehmen' } });
    await api.energiemanagementFassungEntwerfen(d.id, { form: 'wortlaut', wortlaut: 'Unterweisung vom 01.02.2029, Teilnehmende siehe Liste.' });
    await api.energiemanagementFassungFreigeben(d.id, 1, { entschieden_von: EM_IDS.IK, entschieden_am: '2029-02-01', begruendung: 'Unterweisung durchgeführt und festgehalten.' });
    render(<DokumentSeite id={d.id} onListe={() => {}} />);
    await act(async () => {});
    expect(screen.getByTestId('dokument-fassung')).toBeTruthy();
    expect(screen.queryByTestId('dokument-geprueft')).toBeNull();
  });
});
