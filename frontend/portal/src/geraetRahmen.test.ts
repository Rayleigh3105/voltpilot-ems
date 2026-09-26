import { describe, expect, it } from 'vitest';
import {
  abschnittHash,
  ALTER_ABSCHNITT,
  ankerId,
  BAUSTEIN_ORDNUNG,
  BAUSTEIN_TITEL,
  bausteine,
  istTechnikAnsicht,
  kopfHinweis,
  ohneTechnikHash,
  parseKachel,
  sprungZiel,
  TECHNIK_ANSICHT_TITEL,
  TECHNIK_ORDNUNG,
  TECHNIK_TITEL,
  technikHash,
  technikTeile,
  zielHash,
  zielTitel,
  type AlterAbschnitt,
  type BausteinId,
  type TechnikId,
} from './geraetRahmen';

/**
 * Der KERN aller Geräteseiten (Konzept „Geräteseiten: Ein Blick, eine
 * Antwort"). Geprüft wird, was den Kern ausmacht: die feste Ordnung der fünf
 * Bausteine, die eigene Technik-Ansicht (E1 a), die alten Lesezeichen, der
 * EINE Kopf-Hinweis und die Deep-Links ohne zweite Raute.
 */
describe('BAUSTEIN_ORDNUNG - fünf Bausteine, immer in derselben Reihenfolge', () => {
  it('ist Jetzt · Steuerung · Heute · Aktivität · Gerät & Verbindung', () => {
    expect(BAUSTEIN_ORDNUNG).toEqual(['buehne', 'steuerung', 'heute', 'aktivitaet', 'details']);
    expect(BAUSTEIN_ORDNUNG.map((id) => BAUSTEIN_TITEL[id])).toEqual([
      'Jetzt', 'Steuerung', 'Heute', 'Aktivität', 'Gerät & Verbindung',
    ]);
  });

  it('gibt jedem Technik-Teil einen Namen', () => {
    for (const id of TECHNIK_ORDNUNG) expect(TECHNIK_TITEL[id]?.trim()).toBeTruthy();
    expect(TECHNIK_ANSICHT_TITEL).toBe('Technik & Diagnose');
  });
});

describe('bausteine / technikTeile - die Ordnung gehört dem Kern', () => {
  it('sortiert kanonisch, egal in welcher Reihenfolge der Wirt anbietet', () => {
    expect(bausteine(['details', 'buehne', 'aktivitaet', 'steuerung'])).toEqual([
      'buehne', 'steuerung', 'aktivitaet', 'details',
    ]);
    expect(technikTeile(['rohdaten', 'register', 'plattform'])).toEqual([
      'register', 'rohdaten', 'plattform',
    ]);
  });

  it('lässt Fehlendes STILL weg - kein Kasten, der erklärt, dass er leer ist (S5)', () => {
    expect(bausteine(['buehne', null, false, undefined, 'details'])).toEqual(['buehne', 'details']);
    expect(technikTeile([null, 'rohdaten'])).toEqual(['rohdaten']);
  });

  it('nennt doppelt Angebotenes einmal und ignoriert Unbekanntes', () => {
    expect(bausteine(['buehne', 'buehne', 'erfunden' as BausteinId])).toEqual(['buehne']);
    expect(technikTeile(['register', 'register', 'erfunden' as TechnikId])).toEqual(['register']);
  });
});

describe('sprungZiel - wohin eine Adresse springt', () => {
  const basis = '#/anlage/s1/geraet/vp-1/inverter';

  it('liest einen Baustein der Hauptansicht', () => {
    expect(sprungZiel(`${basis}?abschnitt=steuerung`)).toEqual({ ansicht: 'geraet', baustein: 'steuerung' });
    expect(sprungZiel(`${basis}?x=1&abschnitt=heute`)).toEqual({ ansicht: 'geraet', baustein: 'heute' });
  });

  it('öffnet die Technik-Ansicht über `?ansicht=technik` - mit oder ohne Teil', () => {
    expect(sprungZiel(`${basis}?ansicht=technik`)).toEqual({ ansicht: 'technik', teil: null });
    expect(sprungZiel(`${basis}?ansicht=technik&abschnitt=rohdaten`))
      .toEqual({ ansicht: 'technik', teil: 'rohdaten' });
    expect(istTechnikAnsicht(`${basis}?ansicht=technik`)).toBe(true);
    expect(istTechnikAnsicht(`${basis}?abschnitt=details`)).toBe(false);
  });

  it('lässt `?ansicht=technik` gewinnen - ein Baustein daneben wäre dort unsichtbar', () => {
    expect(sprungZiel(`${basis}?ansicht=technik&abschnitt=steuerung`))
      .toEqual({ ansicht: 'technik', teil: null });
  });

  it('rät NIE: ein unbekanntes Wort öffnet nichts', () => {
    expect(sprungZiel(`${basis}?abschnitt=erfunden`)).toBeNull();
    expect(sprungZiel(basis)).toBeNull();
    expect(sprungZiel('')).toBeNull();
  });
});

describe('Alte Lesezeichen `?abschnitt=` bleiben gültig (E1 a)', () => {
  const basis = '#/anlage/s1/geraet/vp-1/inverter';

  it('führt jeden alten Abschnitt dorthin, wo sein Inhalt heute wohnt', () => {
    expect(sprungZiel(`${basis}?abschnitt=jetzt`)).toEqual({ ansicht: 'geraet', baustein: 'buehne' });
    expect(sprungZiel(`${basis}?abschnitt=befehle`)).toEqual({ ansicht: 'geraet', baustein: 'aktivitaet' });
    expect(sprungZiel(`${basis}?abschnitt=verbindung`)).toEqual({ ansicht: 'geraet', baustein: 'details' });
    expect(sprungZiel(`${basis}?abschnitt=register`)).toEqual({ ansicht: 'technik', teil: 'register' });
    expect(sprungZiel(`${basis}?abschnitt=diagnose`)).toEqual({ ansicht: 'technik', teil: 'rohdaten' });
    expect(sprungZiel(`${basis}?abschnitt=plattform`)).toEqual({ ansicht: 'technik', teil: 'plattform' });
  });

  it('kennt alle neun Abschnitte des früheren Rahmens', () => {
    const alt: AlterAbschnitt[] = [
      'jetzt', 'befehle', 'steuerung', 'komponenten', 'register',
      'verbindung', 'software', 'diagnose', 'plattform',
    ];
    for (const a of alt) {
      expect(ALTER_ABSCHNITT[a]).toBeTruthy();
      expect(sprungZiel(`${basis}?abschnitt=${a}`)).toEqual(ALTER_ABSCHNITT[a]);
    }
  });
});

describe('Adressen schreiben - Parameter, nie eine zweite Raute', () => {
  const basis = '#/anlage/s1/geraet/vp-1/inverter';

  it('schreibt die Technik-Ansicht und nimmt sie wieder heraus', () => {
    const h = technikHash(basis, 'register');
    expect(h).toBe(`${basis}?ansicht=technik&abschnitt=register`);
    expect(h.slice(1)).not.toContain('#');
    expect(ohneTechnikHash(h)).toBe(basis);
    expect(technikHash(basis)).toBe(`${basis}?ansicht=technik`);
  });

  it('erhält fremde Parameter beim Hin- und Rückweg', () => {
    const h = technikHash(`${basis}?f=1`, 'rohdaten');
    expect(h).toBe(`${basis}?f=1&ansicht=technik&abschnitt=rohdaten`);
    expect(ohneTechnikHash(h)).toBe(`${basis}?f=1`);
  });

  it('ist mit `sprungZiel` rundlauffähig', () => {
    for (const id of BAUSTEIN_ORDNUNG) {
      expect(sprungZiel(abschnittHash(basis, id))).toEqual({ ansicht: 'geraet', baustein: id });
    }
    for (const teil of TECHNIK_ORDNUNG) {
      expect(sprungZiel(technikHash(basis, teil))).toEqual({ ansicht: 'technik', teil });
    }
  });

  // ⚠ Die Batterie hat KEINE eigene Seite - ihre Komponenten-Karte führt auf die
  // Hybrid-Seite und markiert dort GENAU ihre Kachel.
  it('nennt zusätzlich die angesprungene KACHEL als eigenen Parameter', () => {
    const h = abschnittHash(basis, 'buehne', 'speicher');
    expect(h).toBe(`${basis}?abschnitt=buehne&kachel=speicher`);
    expect(parseKachel(h)).toBe('speicher');
    expect(sprungZiel(h)).toEqual({ ansicht: 'geraet', baustein: 'buehne' });
  });

  it('lässt eine gesetzte Kachel unangetastet, wenn keine genannt wird - `null` nimmt sie heraus', () => {
    expect(abschnittHash(`${basis}?kachel=speicher`, 'aktivitaet'))
      .toBe(`${basis}?kachel=speicher&abschnitt=aktivitaet`);
    expect(zielHash(`${basis}?abschnitt=buehne&kachel=speicher`, { ansicht: 'geraet', baustein: 'buehne' }, null))
      .toBe(`${basis}?abschnitt=buehne`);
  });

  it('behauptet ohne Parameter KEINE Kachel', () => {
    expect(parseKachel(basis)).toBeNull();
    expect(parseKachel(`${basis}?kachel=`)).toBeNull();
    expect(parseKachel(`${basis}?kachel=%20`)).toBeNull();
    expect(parseKachel('')).toBeNull();
  });

  it('gibt jedem Baustein und Technik-Teil einen eigenen Sprungpunkt', () => {
    const ids = new Set([...BAUSTEIN_ORDNUNG, ...TECHNIK_ORDNUNG].map((id) => ankerId(id)));
    expect(ids.size).toBe(BAUSTEIN_ORDNUNG.length + TECHNIK_ORDNUNG.length);
  });
});

describe('kopfHinweis - höchstens EINER, der schlimmste', () => {
  it('gibt ohne Befund nichts zurück', () => {
    expect(kopfHinweis([])).toBeNull();
    expect(kopfHinweis([null, undefined])).toBeNull();
  });

  it('zeigt den EINEN Befund samt dem Ort, der ihn erklärt', () => {
    const h = kopfHinweis([
      { art: 'grenze', satz: 'Ihr Wechselrichter begrenzt auf 33,0 kW — hinterlegt sind 70,0 kW.', ton: 'warn' },
    ]);
    expect(h).toEqual({
      satz: 'Ihr Wechselrichter begrenzt auf 33,0 kW — hinterlegt sind 70,0 kW.',
      ton: 'warn',
      art: 'grenze',
      ziel: { ansicht: 'technik', teil: 'register' },
    });
  });

  it('lässt den schlimmsten gewinnen, unabhängig von der Aufruf-Reihenfolge', () => {
    const befunde = [
      { art: 'grenze' as const, satz: 'Grenze', ton: 'warn' as const },
      { art: 'verbindung' as const, satz: 'Tot', ton: 'off' as const },
      { art: 'waechter' as const, satz: 'Wächter', ton: 'warn' as const },
    ];
    expect(kopfHinweis(befunde)?.art).toBe('verbindung');
    expect(kopfHinweis([...befunde].reverse())?.art).toBe('verbindung');
  });

  it('ordnet die vier Arten: Verbindung > Rücklesen > Wächter > Grenze', () => {
    const satz = (art: 'verbindung' | 'ruecklesen' | 'waechter' | 'grenze') =>
      ({ art, satz: art, ton: 'warn' as const });
    expect(kopfHinweis([satz('ruecklesen'), satz('waechter'), satz('grenze')])?.art).toBe('ruecklesen');
    expect(kopfHinweis([satz('waechter'), satz('grenze')])?.art).toBe('waechter');
    expect(kopfHinweis([satz('grenze')])?.art).toBe('grenze');
  });

  it('verwirft einen Befund ohne Satz oder mit unbekannter Art - der Kern formuliert keinen', () => {
    expect(kopfHinweis([{ art: 'waechter', satz: '   ', ton: 'warn' }])).toBeNull();
    expect(kopfHinweis([{ art: 'erfunden' as 'grenze', satz: 'irgendwas', ton: 'warn' }])).toBeNull();
  });

  it('bietet KEINEN Sprung an, wo die Seite den Ort gar nicht hat', () => {
    const h = kopfHinweis(
      [{ art: 'grenze', satz: 'Grenze', ton: 'warn' }],
      { bausteine: ['buehne', 'details'], technik: ['rohdaten'] },
    );
    expect(h?.satz).toBe('Grenze');
    expect(h?.ziel).toBeNull();
    const r = kopfHinweis(
      [{ art: 'ruecklesen', satz: 'Rücklesen', ton: 'warn' }],
      { bausteine: ['buehne'], technik: [] },
    );
    expect(r?.ziel).toBeNull();
  });

  it('beschriftet den Sprung mit dem Namen seines Ziels', () => {
    expect(zielTitel({ ansicht: 'geraet', baustein: 'aktivitaet' })).toBe('Aktivität');
    expect(zielTitel({ ansicht: 'technik', teil: 'register' })).toBe('Register');
    expect(zielTitel({ ansicht: 'technik', teil: null })).toBe('Technik & Diagnose');
  });
});
