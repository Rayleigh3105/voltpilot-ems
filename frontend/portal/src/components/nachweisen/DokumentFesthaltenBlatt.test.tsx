import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api';
import { setSelbstauskunft } from '../../rollen';
import { energiemanagementBuehne } from '../../test/energiemanagementFixtures';
import { rechteSeed } from '../../test/rollenFixtures';
import { DokumentFesthaltenBlatt } from './DokumentFesthaltenBlatt';

const klick = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

async function waehle(label: string, option: RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  await klick(await screen.findByRole('option', { name: option }));
}

/** Review r1 (Nachweisen PR 2): „Festhalten“ eines offenen Teils - Anwendungsbereich, Vier-Augen, Original, Prüfsumme. */
describe('Blatt „Festhalten“ (Review r1, P2-2, P2-4, P2-8)', () => {
  const original = { ...api };
  let buehne: ReturnType<typeof energiemanagementBuehne>;

  beforeEach(async () => {
    const me = rechteSeed('IK').me;
    setSelbstauskunft(me);
    buehne = energiemanagementBuehne('ahrenberg', { kennung: me.kennung!, name: me.name! }, () => '2029-02-12T09:00:00+01:00');
    Object.assign(api, buehne.routen);
    await buehne.bereit;
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
  });

  const zeige = async (art: string, onFertig = vi.fn()) => {
    render(<DokumentFesthaltenBlatt art={art} onFertig={onFertig} onClose={() => {}} />);
    await act(async () => {});
    return onFertig;
  };

  it('P2-2: der Anwendungsbereich fragt „Wofür gilt es?“ und schickt Standorte, Energieträger und Ausschlüsse schon mit dem Entwurf', async () => {
    const fertig = await zeige('anwendungsbereich');
    await klick(screen.getByTestId('festhalten-weiter'));
    fireEvent.change(screen.getByTestId('festhalten-text'), { target: { value: 'Das Energiemanagement umfasst beide Werke mit Strom.' } });
    await klick(screen.getByTestId('festhalten-weiter'));

    expect(screen.getByRole('heading', { name: 'Wofür gilt es?' })).toBeTruthy();
    // Ohne Energieträger geht es nicht weiter - die Route lehnte sonst mit `anwendungsbereich_fehlt` ab.
    await klick(screen.getByTestId('festhalten-weiter'));
    expect(screen.getByTestId('festhalten-blatt').textContent).toContain('Bitte wählen Sie mindestens einen Energieträger.');
    await waehle('Energieträger', /^Strom$/);
    await klick(screen.getByTestId('festhalten-weiter'));

    expect(screen.getByTestId('festhalten-pruefen').textContent).toContain('Geltung2 Standorte · Strom');
    await klick(screen.getByRole('radio', { name: 'Als Entwurf speichern' }));
    await klick(screen.getByTestId('festhalten-weiter'));

    const [ahrenberg, lindach] = (await api.standorte()).standorte;
    expect(buehne.gesendet.find((g) => g.route.endsWith('/fassungen'))?.koerper).toEqual({
      form: 'wortlaut',
      wortlaut: 'Das Energiemanagement umfasst beide Werke mit Strom.',
      anwendungsbereich: { standort_ids: [ahrenberg.id, lindach.id], traeger: ['Strom'], ausschluesse: [] },
    });
    expect(fertig).toHaveBeenCalledTimes(1);
  });

  it('P2-4: ist Vier-Augen nicht geladen, bleibt „Festhalten“ beim Freigeben zu - „Erneut laden“ holt die Einstellung', async () => {
    const vierAugen = api.unternehmenVierAugen;
    let versuche = 0;
    api.unternehmenVierAugen = async () => {
      versuche += 1;
      if (versuche === 1) throw new Error('Netz');
      return vierAugen();
    };
    await zeige('verfahren');
    await klick(screen.getByTestId('festhalten-weiter'));
    fireEvent.change(screen.getByTestId('festhalten-ablage'), { target: { value: 'QM-Handbuch, Kapitel 4' } });
    await klick(screen.getByTestId('festhalten-weiter'));
    expect(screen.getByTestId('vieraugen-unbekannt')).toBeTruthy();
    expect((screen.getByTestId('festhalten-weiter') as HTMLButtonElement).disabled).toBe(true);
    await klick(screen.getByTestId('vieraugen-erneut'));
    expect(screen.queryByTestId('vieraugen-unbekannt')).toBeNull();
    await waitFor(() => expect((screen.getByTestId('festhalten-weiter') as HTMLButtonElement).disabled).toBe(false));
  });

  it('P2-4: sagt die Route „mit Vier-Augen beantragen“, stellt das Blatt um und der nächste Klick beantragt', async () => {
    const fertig = await zeige('verfahren');
    await klick(screen.getByTestId('festhalten-weiter'));
    fireEvent.change(screen.getByTestId('festhalten-ablage'), { target: { value: 'QM-Handbuch, Kapitel 4' } });
    await klick(screen.getByTestId('festhalten-weiter'));
    await waitFor(() => expect(screen.getByTestId('festhalten-pruefen').textContent).toContain('Ines Kaltenbach'));
    // Inzwischen hat jemand Vier-Augen eingeschaltet.
    buehne.setzeVierAugen(true);
    await klick(screen.getByTestId('festhalten-weiter'));
    expect(screen.getByTestId('blatt-ablehnung').textContent).toContain('Vier-Augen');
    expect(screen.getByRole('radio', { name: 'Gleich beantragen' })).toBeTruthy();
    await klick(screen.getByTestId('festhalten-weiter'));
    expect(buehne.gesendet.map((g) => g.route.split('/').pop())).toEqual(['dokumente', 'fassungen', 'freigeben', 'beantragen']);
    expect(fertig).toHaveBeenCalledTimes(1);
  });

  it('P2-8: ein Original ohne „Wo liegt es?“ verwirft Kennung und Prüfsumme nicht still - das Feld sagt es', async () => {
    await zeige('energiepolitik');
    await klick(screen.getByTestId('festhalten-weiter'));
    fireEvent.change(screen.getByTestId('festhalten-text'), { target: { value: 'Wir verbessern unsere energiebezogene Leistung.' } });
    await klick(screen.getByTestId('festhalten-weiter'));
    await waitFor(() => expect(screen.getByTestId('festhalten-pruefen').textContent).toContain('Robert Falk'));
    await klick(screen.getByTestId('festhalten-original'));
    fireEvent.change(screen.getByTestId(/-original-kennung$/), { target: { value: 'EP-2029' } });
    await klick(screen.getByTestId('festhalten-weiter'));
    expect(within(screen.getByTestId('festhalten-blatt')).getByText('Bitte nennen Sie, wo das Original liegt.')).toBeTruthy();
    expect(buehne.gesendet).toEqual([]);
  });

  it('P2-8: scheitert die Prüfsumme der Datei, sagt es das Blatt - statt still zurückzuspringen', async () => {
    await zeige('verfahren');
    await klick(screen.getByTestId('festhalten-weiter'));
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => Promise.reject(new Error('kein sicherer Kontext')));
    try {
      const feld = screen.getByTestId('datei-pruefen').querySelector('input') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(feld, { target: { files: [new File(['QM'], 'qm.pdf')] } });
      });
      expect((await screen.findByTestId('datei-fehler')).textContent).toBe('Diese Datei ließ sich hier nicht prüfen.');
      expect(screen.getByTestId('datei-pruefen').textContent).toContain('Datei prüfen');
    } finally {
      digest.mockRestore();
    }
  });
});
