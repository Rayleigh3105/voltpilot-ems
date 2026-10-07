import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type FeststellungMitVerlauf, type FeststellungStand } from '../api';
import { setSelbstauskunft } from '../rollen';
import { vergissAbruf } from '../routenUhr';
import { AF_IDS, auditFeststellungBuehne } from '../test/auditFeststellungFixtures';
import { energiemanagementBuehne } from '../test/energiemanagementFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { FeststellungSeite } from './FeststellungSeite';

/**
 * Vier-Augen an der Feststellung (FS6, Review P4-2): über einen offenen Antrag entscheidet nur die zweite Person, wie die
 * Route sie nennt (`vieraugen.zweite_person`: Berechtigte ohne die Antragstellerin und ohne die Verantwortliche). Wer
 * nicht entscheiden darf, sieht keinen Knopf, den der Server danach ablehnen würde, sondern wer entscheiden kann; was
 * beantragt ist, sagt die Status-Zeile, die Begründung steht einen Tipp tiefer.
 */
const JETZT = '2029-04-15T10:00:00+02:00';
const laden = async () => {
  await act(async () => {});
  await act(async () => {});
};
const IK = { sub: 'IK', name: 'Ines Kaltenbach' };
const JW = { sub: 'JW', name: 'Jonas Wendlinger' };
const MD = { sub: 'MD', name: 'Murat Demirci' };

describe('FeststellungSeite · Vier-Augen', () => {
  const original = { ...api };
  let basis: FeststellungMitVerlauf;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(JETZT));
    vergissAbruf();
    const me = rechteSeed('IK').me;
    const ich = { kennung: me.kennung!, name: me.name! };
    const em = energiemanagementBuehne('ahrenberg', ich, () => JETZT);
    const af = auditFeststellungBuehne('r11', ich, () => JETZT, async () => []);
    Object.assign(api, em.routen, af.routen, { massnahmen: async () => ({ massnahmen: [] }) });
    await em.bereit;
    await af.bereit;
    basis = await api.energiemanagementFeststellung(AF_IDS.f1);
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
    vergissAbruf();
    vi.useRealTimers();
  });

  /** IK hat „wirksam“ beantragt; `verantwortlich` und die zweite Person wie die Route sie rechnet. */
  function mitAntrag(verantwortlich: { sub: string; name: string }, zweite: { sub: string; name: string }[]): FeststellungMitVerlauf {
    const antrag: FeststellungStand = {
      nr: 1,
      ergebnis: 'wirksam',
      begruendung: 'Die Zuständigkeit ist seit 01.03.2029 festgelegt; zwei Freigaben nannten seither die Vertretung.',
      am: '2029-04-14',
      entschieden_von: basis.feststellung.festgestellt_von,
      kopie: {},
      pruefsumme: `sha256:${'a'.repeat(64)}`,
      vieraugen: true,
      status: 'beantragt',
      eingetragen: { akteur: { ...IK, rolle: 'energiemanager', art: 'kunde' }, am: '2029-04-14T09:00:00+02:00' },
      zweite_person: null,
      ablehnung_begruendung: null,
    };
    return {
      ...structuredClone(basis),
      feststellung: { ...structuredClone(basis.feststellung), zustand: 'offen', ergebnis: null, abgeschlossen_am: null, verantwortlich },
      wirksamkeit: [antrag],
      vieraugen: {
        an: true,
        erfuellbar: zweite.length > 0,
        berechtigte: [IK, JW],
        zweite_person: zweite,
        satz: zweite.length ? null : 'Vier-Augen nicht erfüllbar: Ines Kaltenbach und Jonas Wendlinger sind beide beteiligt.',
      },
    };
  }

  function zeige(kennung: string, daten: FeststellungMitVerlauf) {
    setSelbstauskunft(rechteSeed(kennung).me);
    Object.assign(api, { energiemanagementFeststellung: async () => structuredClone(daten) });
    return render(<FeststellungSeite id={AF_IDS.f1} onListe={vi.fn()} onAudit={vi.fn()} />);
  }

  it('wer beantragt hat, entscheidet nicht: kein Bestätigen, kein Ablehnen, dafür wer entscheiden kann', async () => {
    zeige('IK', mitAntrag(MD, [JW]));
    await laden();
    expect(screen.queryByTestId('feststellung-bestaetigen')).toBeNull();
    expect(screen.queryByTestId('feststellung-ablehnen')).toBeNull();
    expect(screen.getByTestId('feststellung-entscheidet').textContent).toBe('Entscheiden kann Jonas Wendlinger.');
  });

  it('wer verantwortlich ist, entscheidet nicht - auch wenn sie nicht beantragt hat', async () => {
    zeige('JW', mitAntrag(JW, []));
    await laden();
    expect(screen.queryByTestId('feststellung-bestaetigen')).toBeNull();
    expect(screen.queryByTestId('feststellung-ablehnen')).toBeNull();
    expect(screen.getByTestId('feststellung-vieraugen').textContent).toContain('Vier-Augen nicht erfüllbar');
  });

  it('die zweite Person bestätigt oder lehnt ab; was beantragt ist, steht in der Status-Zeile und einen Tipp tiefer', async () => {
    const freigeben = vi.fn(async () => basis);
    Object.assign(api, { energiemanagementFeststellungFreigeben: freigeben });
    zeige('JW', mitAntrag(MD, [JW]));
    await laden();
    expect(screen.getByTestId('feststellung-status').textContent).toBe('Wirksamkeit beantragt· Ines Kaltenbach');
    expect(screen.queryByTestId('feststellung-entscheidet')).toBeNull();
    fireEvent.click(screen.getByTestId('feststellung-antrag-zeile'));
    expect(screen.getByTestId('feststellung-blatt-stand').textContent).toContain('zwei Freigaben nannten seither die Vertretung');
    expect(screen.getByTestId('feststellung-ablehnen')).toBeTruthy();
    fireEvent.click(screen.getByTestId('feststellung-bestaetigen'));
    await laden();
    expect(freigeben).toHaveBeenCalledWith(AF_IDS.f1);
  });
});
