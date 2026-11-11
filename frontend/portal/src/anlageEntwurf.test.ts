import { afterEach, describe, expect, it } from 'vitest';
import {
  alsEntwurf,
  entwurfHatInhalt,
  entwurfSchluessel,
  leseEntwurf,
  loescheEntwurf,
  schreibeEntwurf,
  type AnlageEntwurf,
} from './anlageEntwurf';

function entwurf(over: Partial<AnlageEntwurf> = {}): AnlageEntwurf {
  return {
    v: 1,
    wirt: 'assistent',
    schritt: 1,
    siteId: null,
    standortId: null,
    art: null,
    mitBox: false,
    ort: null,
    adresse: null,
    kennung: '',
    teile: null,
    ...over,
  };
}

const ADRESSE = {
  name: 'Zuhause',
  nameOffen: false,
  suche: 'Marktplatz 2 Pappenheim',
  adresse: null,
  lat: null,
  lon: null,
  wahl: null,
  plantKind: 'eigenverbrauch' as const,
  tarifArt: 'ohne' as const,
  tarifParam: '',
  praemie: '',
  maxFeedIn: '',
  netzladen: false,
};

afterEach(() => sessionStorage.clear());

describe('der Entwurf des Anlege-Flusses (Anlage-Flow a1, F9)', () => {
  it('je Kundenbereich und Person', () => {
    expect(entwurfSchluessel({ tenantId: 'kb', email: 'a@b.test' })).toBe('vp.anlage-entwurf.kb.a@b.test');
    expect(entwurfSchluessel({ tenantId: 'kb', name: 'Erika' })).toBe('vp.anlage-entwurf.kb.Erika');
  });

  it('schreibt nur, was ohne ihn verloren ginge - ein unberührter erster Schritt ist keiner', () => {
    const k = 'vp.anlage-entwurf.kb.a';
    schreibeEntwurf(k, entwurf({ adresse: { ...ADRESSE, suche: '' } }));
    expect(sessionStorage.getItem(k)).toBeNull();
    schreibeEntwurf(k, entwurf({ adresse: ADRESSE }));
    expect(leseEntwurf(k)?.adresse?.suche).toBe('Marktplatz 2 Pappenheim');
    schreibeEntwurf(k, entwurf({ schritt: 2, siteId: 's-1' }));
    expect(entwurfHatInhalt(leseEntwurf(k)!)).toBe(true);
    // Zurück auf leer räumt ab.
    schreibeEntwurf(k, entwurf());
    expect(sessionStorage.getItem(k)).toBeNull();
    schreibeEntwurf(k, entwurf({ schritt: 3, siteId: 's-1' }));
    loescheEntwurf(k);
    expect(leseEntwurf(k)).toBeNull();
  });

  it('ein fremder, alter oder kaputter Eintrag gilt als keiner', () => {
    expect(alsEntwurf(null)).toBeNull();
    expect(alsEntwurf({ v: 2, wirt: 'assistent', schritt: 1 })).toBeNull();
    expect(alsEntwurf({ v: 1, wirt: 'irgendwer', schritt: 1 })).toBeNull();
    expect(alsEntwurf({ v: 1, wirt: 'dialog', schritt: 4 })).toBeNull();
    expect(alsEntwurf({ v: 1, wirt: 'dialog', schritt: 2, siteId: null })).toBeNull();
    sessionStorage.setItem('x', '{kaputt');
    expect(leseEntwurf('x')).toBeNull();
  });
});
