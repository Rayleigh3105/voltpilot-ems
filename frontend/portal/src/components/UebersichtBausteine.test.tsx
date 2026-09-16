import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Funktionen } from '../api';
import { UebersichtBausteine, useUebersichtBausteine } from './UebersichtBausteine';
import { werkAhrenberg } from '../test/standorteFixtures';
import { ortsbaumAhrenberg } from '../test/ortsbaumFixtures';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { ahrenbergBilanz } from '../test/bilanzFixtures';

const st = werkAhrenberg();
const anlagen = st.anlagen.map((a) => ({ id: a.id, name: a.name }));
function Uebersicht({ art, funktionen }: { art: 'unternehmen' | 'standort'; funktionen: Funktionen | null }) {
  const daten = useUebersichtBausteine(
    art === 'standort' ? { art, standort: st } : { art, name: 'Ahrenberg', standorte: [st] },
    anlagen,
    funktionen,
  );
  return daten && <UebersichtBausteine daten={daten} zeigen={['messstellen', 'energiebilanz', 'kennzahlen']} onNavigate={() => {}} />;
}

beforeEach(() => {
  // Absichtlich auch vorhandene Messdaten: ohne Messfunktion dürfen selbst diese keinen Baustein öffnen.
  vi.spyOn(api, 'messstellenRegister').mockResolvedValue(ahrenbergRegister());
  vi.spyOn(api, 'anlageBilanz').mockImplementation(async (id, periode, am) => ahrenbergBilanz(id, periode, am));
  vi.spyOn(api, 'standortOrte').mockResolvedValue(ortsbaumAhrenberg());
  vi.spyOn(api, 'kennzahlen').mockResolvedValue({ kennzahlen: [] });
});
afterEach(() => vi.restoreAllMocks());

describe('O18 · Betriebskunde ohne Messfunktion, mit drei Gebäuden', () => {
  for (const art of ['unternehmen', 'standort'] as const) {
    it.each(['bestand', 'unbekannt', 'entwurf'] as const)(`${art}, %s: kein Baustein, kein neues Wort und keine Abfrage`, async (zustand) => {
      const f = zustand === 'unbekannt' ? null : ahrenbergFunktionen({ messen: 'bestand' });
      if (f && zustand === 'entwurf') f.standorte.forEach((s) => { s.messen.zustand = 'entwurf'; });
      const { container } = render(<Uebersicht art={art} funktionen={f} />);
      await act(async () => {});
      expect(container).toBeEmptyDOMElement();
      for (const methode of ['messstellenRegister', 'anlageBilanz', 'standortOrte', 'kennzahlen'] as const) {
        expect(api[methode]).not.toHaveBeenCalled();
      }
    });
  }

  it('blendet bereits geladene Bausteine aus, sobald die Messfunktion entfällt', async () => {
    const view = render(<Uebersicht art="standort" funktionen={ahrenbergFunktionen()} />);
    await screen.findByTestId('baustein-messstellen');
    await screen.findByTestId('gebaeude-zeilen');
    view.rerender(<Uebersicht art="standort" funktionen={ahrenbergFunktionen({ messen: 'bestand' })} />);
    expect(view.container).toBeEmptyDOMElement();
  });
});
