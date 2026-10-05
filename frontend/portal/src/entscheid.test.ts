import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ansehenSprung,
  artFilterAus,
  artFilterSprung,
  entscheidAus,
  entscheidSprung,
  ohneEntscheid,
  seitenSprung,
  sprungKlick,
} from './entscheid';
import { dokumentRoute, energiemanagementRoute, parseRoute, pageRoute } from './nav';

describe('Sprung mit offenem Entscheid (Konzept Wiedervorlage w1, Entscheid 8)', () => {
  it('die Adresse trägt den Entscheid; die Route bleibt die Seite', () => {
    const s = entscheidSprung(dokumentRoute('d1'), 'dokument_ueberpruefung');
    expect(s.hash).toBe('#/portfolio/energiemanagement/dokumente/d1?entscheid=dokument_ueberpruefung');
    expect(parseRoute(s.hash)).toEqual(dokumentRoute('d1'));
    expect(entscheidAus(s.hash)).toEqual({ art: 'dokument_ueberpruefung', kennzeichen: null });
  });

  it('mit Kennzeichen, wo eine Seite mehrere Gegenstände derselben Art trägt', () => {
    const s = entscheidSprung(pageRoute('portfolio-bewertung'), 'messbedarf_frist', 'MB-1');
    expect(s.hash).toBe('#/portfolio/bewertung?entscheid=messbedarf_frist&kennzeichen=MB-1');
    expect(entscheidAus(s.hash)).toEqual({ art: 'messbedarf_frist', kennzeichen: 'MB-1' });
  });

  it('mit einem Filter der Zielseite: das Register eines Orts; zum Ansehen geht nur der Entscheid', () => {
    const s = entscheidSprung(pageRoute('portfolio-messstellen'), 'zaehlerablesung', null, { ort: 'G-1' });
    expect(s.hash).toBe('#/portfolio/messstellen?ort=G-1&entscheid=zaehlerablesung');
    expect(parseRoute(s.hash)).toEqual(pageRoute('portfolio-messstellen'));
    expect(entscheidAus(s.hash)).toEqual({ art: 'zaehlerablesung', kennzeichen: null });
    expect(ansehenSprung(s)).toEqual({ route: pageRoute('portfolio-messstellen'), hash: '#/portfolio/messstellen?ort=G-1' });
    expect(ansehenSprung(entscheidSprung(dokumentRoute('d1'), 'dokument_ueberpruefung')).hash)
      .toBe(seitenSprung(dokumentRoute('d1')).hash);
  });

  it('ohne Entscheid: andere Parameter bleiben, eine Adresse ohne Parameter bleibt gleich', () => {
    expect(ohneEntscheid('#/portfolio/bewertung?entscheid=messbedarf_frist&kennzeichen=MB-1')).toBe('#/portfolio/bewertung');
    expect(ohneEntscheid('#/portfolio/x?periode=monat&entscheid=a')).toBe('#/portfolio/x?periode=monat');
    expect(ohneEntscheid('#/portfolio/x')).toBe('#/portfolio/x');
    expect(entscheidAus('#/portfolio/x?periode=monat')).toBeNull();
    expect(entscheidAus('#/portfolio/x?entscheid=')).toBeNull();
  });

  it('der Art-Filter der Wiedervorlage', () => {
    const s = artFilterSprung(energiemanagementRoute('wiedervorlage'), 'bezugsbasis_ueberpruefung');
    expect(s.hash).toBe('#/portfolio/energiemanagement/wiedervorlage?art=bezugsbasis_ueberpruefung');
    expect(artFilterAus(s.hash)).toBe('bezugsbasis_ueberpruefung');
    expect(artFilterAus('#/portfolio/energiemanagement/wiedervorlage')).toBeNull();
    expect(seitenSprung(energiemanagementRoute('wiedervorlage')).hash).toBe('#/portfolio/energiemanagement/wiedervorlage');
  });
});

describe('sprungKlick: ein echter Link', () => {
  afterEach(() => vi.restoreAllMocks());
  const klick = (mehr: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }> = {}) => ({
    defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn(), ...mehr,
  });
  const s = seitenSprung(energiemanagementRoute('wiedervorlage'));

  it('ein einfacher Klick springt über die Schale', () => {
    const springe = vi.fn();
    const e = klick();
    sprungKlick(s, springe)(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(springe).toHaveBeenCalledWith(s);
  });

  it('mit Zusatztaste, mittlerer Taste oder schon behandelt öffnet der Browser den Link selbst', () => {
    const springe = vi.fn();
    for (const e of [klick({ metaKey: true }), klick({ ctrlKey: true }), klick({ shiftKey: true }), klick({ altKey: true }), klick({ button: 1 }), klick({ defaultPrevented: true })]) {
      sprungKlick(s, springe)(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(springe).not.toHaveBeenCalled();
  });

  it('ohne eigene Schale über die Adresse, oben auf der neuen Seite', () => {
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    window.location.hash = '#/portfolio';
    sprungKlick(s)(klick());
    expect(window.location.hash).toBe('#/portfolio/energiemanagement/wiedervorlage');
    expect(scroll).toHaveBeenCalledWith({ top: 0 });
  });
});
