import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UebersichtBausteine, type UebersichtDaten } from './UebersichtBausteine';
import { ortsbaumAhrenberg } from '../test/ortsbaumFixtures';
import { werkAhrenberg } from '../test/standorteFixtures';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { ahrenbergBilanz } from '../test/bilanzFixtures';

describe('O18 · Betriebskunde ohne Messfunktion', () => {
  it.each([['unternehmen', false], ['standort', false], ['standort', true]] as const)('%s, Gebäude %s: kein Baustein und kein neues Wort, auch mit gespeicherter Baustein-Auswahl', (art, mitGebaeuden) => {
    const st = werkAhrenberg();
    const register = ahrenbergRegister();
    const leer = { erfuellt: 0, gesamt: 0, text: 'Noch keine Messstellen' };
    const leeresRegister = { ...register, register: [], aggregat: { ...register.aggregat, unternehmen: leer, standorte: [{ ...leer, id: st.id }] } };
    const daten: UebersichtDaten = {
      ebene: art === 'standort' ? { art, standort: st } : { art, name: 'Ahrenberg', standorte: [st] },
      heute: '2026-11-04', periode: 'monat', am: '2026-10-01', waehle: () => {},
      register: leeresRegister,
      anlagen: st.anlagen.map((anlage) => ({ anlage, bilanz: ahrenbergBilanz(anlage.id, 'monat', '2026-10-01', { ohneHauptzaehler: true }) })),
      laedt: false,
      gebaeude: mitGebaeuden ? ortsbaumAhrenberg().gebaeude.map((g) => ({ id: g.id, kurzzeichen: g.kurzzeichen, name: g.name, heute: leeresRegister, imZeitraum: [] })) : [],
      kennzahlen: { liste: [], werte: {}, fehler: false }, inhalt: [],
    };
    const { container } = render(<UebersichtBausteine daten={daten} zeigen={['messstellen', 'energiebilanz', 'kennzahlen']} onNavigate={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
