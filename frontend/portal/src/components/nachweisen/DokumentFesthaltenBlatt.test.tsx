import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api';
import { setSelbstauskunft } from '../../rollen';
import * as N from '../../nachweisDokumente';
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

  /** Die erste Freigabe scheitert (Netz), die zweite geht durch - der Entwurf steht da schon. */
  const freigabeScheitertEinmal = () => {
    const freigeben = api.energiemanagementFassungFreigeben;
    const zaehler = { versuche: 0 };
    api.energiemanagementFassungFreigeben = async (...a: Parameters<typeof freigeben>) => {
      zaehler.versuche += 1;
      if (zaehler.versuche === 1) throw new Error('Netz');
      return freigeben(...a);
    };
    return zaehler;
  };

  it('Review r2, N-2.1: nach gescheiterter Freigabe wird der geänderte Text freigegeben, nicht der alte Entwurf', async () => {
    const zaehler = freigabeScheitertEinmal();
    const fertig = await zeige('energiepolitik');
    await klick(screen.getByTestId('festhalten-weiter'));
    fireEvent.change(screen.getByTestId('festhalten-text'), { target: { value: 'Alter Text der Energiepolitik, der nicht gelten soll.' } });
    await klick(screen.getByTestId('festhalten-weiter'));
    await waitFor(() => expect(screen.getByTestId('festhalten-pruefen').textContent).toContain('Robert Falk'));
    await klick(screen.getByTestId('festhalten-weiter'));
    // Anlegen, Entwurf und die gescheiterte Freigabe sind eine Kette von Abrufen - abwarten, was die Person sieht.
    await screen.findByTestId('blatt-ablehnung');
    expect(zaehler.versuche).toBe(1);
    expect(fertig).not.toHaveBeenCalled();

    // Die Person korrigiert den Text über „Ändern“ und hält erneut fest.
    await klick(within(screen.getByTestId('festhalten-pruefen')).getByRole('button', { name: 'Text ändern' }));
    fireEvent.change(screen.getByTestId('festhalten-text'), { target: { value: 'Neuer Text der Energiepolitik, der gelten soll.' } });
    await klick(screen.getByTestId('festhalten-weiter'));
    expect(screen.getByTestId('festhalten-pruefen').textContent).toContain('Neuer Text');
    await klick(screen.getByTestId('festhalten-weiter'));

    await waitFor(() => expect(fertig).toHaveBeenCalledTimes(1));
    expect(zaehler.versuche).toBe(2);
    expect(fertig.mock.calls[0][0].fassungen[0].wortlaut).toBe('Neuer Text der Energiepolitik, der gelten soll.');
    // Der offene Entwurf derselben Nummer wird überschrieben, bevor die Leitung entscheidet (die gescheiterte erste
    // Freigabe erreicht die Bühne nicht).
    expect(buehne.gesendet.map((g) => g.route.split('/').pop())).toEqual(['dokumente', 'fassungen', 'fassungen', 'freigeben']);
  });

  it('Review r2, N-2.1: auch eine geänderte Geltung des Anwendungsbereichs geht vor der Freigabe in den Entwurf', async () => {
    const zaehler = freigabeScheitertEinmal();
    const fertig = await zeige('anwendungsbereich');
    await klick(screen.getByTestId('festhalten-weiter'));
    fireEvent.change(screen.getByTestId('festhalten-text'), { target: { value: 'Das Energiemanagement umfasst beide Werke.' } });
    await klick(screen.getByTestId('festhalten-weiter'));
    await waehle('Energieträger', /^Strom$/);
    await klick(screen.getByTestId('festhalten-weiter'));
    await waitFor(() => expect(screen.getByTestId('festhalten-pruefen').textContent).toContain('Robert Falk'));
    await klick(screen.getByTestId('festhalten-weiter'));
    // Anlegen, Entwurf und die gescheiterte Freigabe sind eine Kette von Abrufen - abwarten, was die Person sieht.
    await screen.findByTestId('blatt-ablehnung');
    expect(zaehler.versuche).toBe(1);

    await klick(within(screen.getByTestId('festhalten-pruefen')).getByRole('button', { name: 'Geltung ändern' }));
    await waehle('Energieträger', /^Gas$/);
    await klick(screen.getByTestId('festhalten-weiter'));
    expect(screen.getByTestId('festhalten-pruefen').textContent).toContain('Strom, Gas');
    await klick(screen.getByTestId('festhalten-weiter'));

    await waitFor(() => expect(fertig).toHaveBeenCalledTimes(1));
    const entwuerfe = buehne.gesendet.filter((g) => g.route.endsWith('/fassungen'));
    expect(entwuerfe).toHaveLength(2);
    expect((entwuerfe[1].koerper as { anwendungsbereich: { traeger: string[] } }).anwendungsbereich.traeger).toEqual(['Strom', 'Gas']);
  });

  it('Review r2, N-2.1: ist das Dokument angelegt, stehen Art, Titel und Ort fest - „Zurück“ zeigt sie nur noch', async () => {
    const zaehler = freigabeScheitertEinmal();
    render(<DokumentFesthaltenBlatt onFertig={vi.fn()} onClose={() => {}} onTrifftNichtZu={vi.fn()} />);
    await act(async () => {});
    await waehle('Was?', /^Vorgehen$/);
    fireEvent.change(screen.getByTestId('festhalten-titel'), { target: { value: 'Wartung der Druckluft' } });
    await klick(screen.getByTestId('festhalten-weiter'));
    fireEvent.change(screen.getByTestId('festhalten-ablage'), { target: { value: 'QM-Handbuch, Kapitel 4' } });
    await klick(screen.getByTestId('festhalten-weiter'));
    await waitFor(() => expect(screen.getByTestId('festhalten-pruefen').textContent).toContain('Ines Kaltenbach'));
    await klick(screen.getByTestId('festhalten-weiter'));
    // Anlegen, Entwurf und die gescheiterte Freigabe sind eine Kette von Abrufen - abwarten, was die Person sieht.
    await screen.findByTestId('blatt-ablehnung');
    expect(zaehler.versuche).toBe(1);

    await klick(screen.getByRole('button', { name: 'Zurück' }));
    await klick(screen.getByRole('button', { name: 'Zurück' }));
    expect((screen.getByTestId('festhalten-titel') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('combobox', { name: 'Was?' }) as HTMLButtonElement).disabled).toBe(true);
    for (const chip of within(screen.getByTestId('festhalten-ort')).getAllByRole('radio')) expect((chip as HTMLInputElement).disabled).toBe(true);
    // „Trifft zurzeit nicht zu“ passt nicht mehr zu einem angelegten Dokument.
    expect(within(screen.getByTestId('festhalten-wo')).queryByText('Trifft zurzeit nicht zu')).toBeNull();
    expect(screen.getByTestId('festhalten-angelegt').textContent).toBe(N.SCHON_ANGELEGT);
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
