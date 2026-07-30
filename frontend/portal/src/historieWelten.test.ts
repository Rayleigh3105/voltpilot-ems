import { describe, expect, it } from 'vitest';
import {
  availableWelten,
  historieHash,
  PROVENIENZ,
  WELTEN,
  WELT_ORDER,
  weltForSub,
  weltSwitchCards,
} from './historieWelten';
import { anlageSurface, type AnlageSurfaceInput } from './surface';

const SPEICHER: AnlageSurfaceInput['entities'] = [
  { id: 'e1', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } },
];

/** Eine Privat-Anlage: PV + Speicher, fester Tarif — kein Geld-Modus. */
const PRIVAT = anlageSurface({
  entities: SPEICHER,
  signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'fest' },
});

/** Eine Direktvermarktungs-Anlage — Geld-Modus, also auch die Erlöse-Welt. */
const MARKT = anlageSurface({
  entities: SPEICHER,
  config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
});

describe('welche Welten es gibt — das Lese-Modell entscheidet', () => {
  it('gibt es die Messwerte-Welt auf JEDER Anlage', () => {
    for (const surface of [PRIVAT, MARKT, anlageSurface({}), null, undefined]) {
      expect(availableWelten(surface)).toContain('messwerte');
    }
  });

  it('gibt es die Erlöse-Welt genau mit einem Geld-Modus', () => {
    expect(MARKT.deepViews).toContain('erloes-historie');
    expect(availableWelten(MARKT)).toEqual(['messwerte', 'erloese']);

    // Privat/nie migriert/nicht geladen: kein Geld-Modus, also keine Erlöse-Welt
    // - nie eine Fläche, die dann leer wäre.
    expect(PRIVAT.deepViews).not.toContain('erloes-historie');
    for (const surface of [PRIVAT, anlageSurface({}), null, undefined]) {
      expect(availableWelten(surface)).toEqual(['messwerte']);
    }
  });
});

describe('das Kartenpaar — Wechsel in einem Klick', () => {
  it('zeigt beide Welten, die aktive markiert, in kanonischer Reihenfolge', () => {
    const cards = weltSwitchCards('messwerte', ['messwerte', 'erloese']);
    expect(cards.map((c) => c.welt.id)).toEqual([...WELT_ORDER]);
    expect(cards.map((c) => c.active)).toEqual([true, false]);
    expect(weltSwitchCards('erloese', ['messwerte', 'erloese']).map((c) => c.active)).toEqual([
      false,
      true,
    ]);
  });

  it('rendert KEINEN einsamen Schalter, wenn es nur eine Welt gibt', () => {
    // Eine Privat-Anlage hat nur die Messwerte-Welt - dann gibt es nichts zu
    // wechseln, und der Kopf zeigt gar kein Kartenpaar.
    expect(weltSwitchCards('messwerte', ['messwerte'])).toEqual([]);
  });

  it('ist per Lesezeichen nie eine Sackgasse', () => {
    // Erlöse-Welt geöffnet, obwohl die Anlage keinen Geld-Modus hat: die Karte
    // zurück in die Messwerte-Welt MUSS da sein.
    const cards = weltSwitchCards('erloese', ['messwerte']);
    expect(cards.map((c) => c.welt.id)).toEqual(['messwerte', 'erloese']);
    expect(cards.find((c) => c.welt.id === 'erloese')?.active).toBe(true);
  });
});

describe('der Link nimmt den Zeitraum mit', () => {
  it('trägt Zeitraum und Anker in die andere Welt', () => {
    expect(historieHash('s-1', 'erloese', 'month', '2026-05-01')).toBe(
      '#/anlage/s-1/erloese?z=monat&at=2026-05-01',
    );
    expect(historieHash('s-1', 'messwerte', 'week')).toBe('#/anlage/s-1/messwerte?z=woche');
    expect(historieHash('s-1', 'messwerte', 'day', null)).toBe('#/anlage/s-1/messwerte?z=tag');
  });
});

describe('Ehrlichkeits-Abzeichen (report §7)', () => {
  it('benennt die drei Arten und spricht ihre Einschränkung aus', () => {
    expect(PROVENIENZ.gemessen.label).toBe('Gemessen');
    expect(PROVENIENZ.bewertet.label).toBe('Bewertet');
    expect(PROVENIENZ.geplant.label).toBe('Geplant');
    // Der Satz nennt die Einschränkung, nicht nur das Wort.
    expect(PROVENIENZ.gemessen.satz).toMatch(/Ausreißer/);
    expect(PROVENIENZ.bewertet.satz).toMatch(/Preisblatt/);
    expect(PROVENIENZ.geplant.satz).toMatch(/nicht die gemessene Ersparnis/i);
  });

  it('gibt jeder Welt genau ein Kopf-Abzeichen und einen Fußtext', () => {
    expect(WELTEN.messwerte.badge).toBe('gemessen');
    expect(WELTEN.erloese.badge).toBe('bewertet');
    for (const welt of Object.values(WELTEN)) {
      expect(welt.fussText.length).toBeGreaterThan(40);
      expect(welt.lead.length).toBeGreaterThan(10);
    }
    // Die Erlöse-Welt sagt ausdrücklich, dass sie keine Abrechnung ist.
    expect(WELTEN.erloese.fussText).toMatch(/nicht abgerechnet/);
    // Die Messwerte-Welt sagt, dass die Reihe aufbereitet ist.
    expect(WELTEN.messwerte.fussText).toMatch(/ersetzt/);
  });
});

describe('weltForSub', () => {
  it('bildet die zwei Routen auf ihre Welt ab, alles andere auf null', () => {
    expect(weltForSub('messwerte')).toBe(WELTEN.messwerte);
    expect(weltForSub('erloese')).toBe(WELTEN.erloese);
    expect(weltForSub('fahrplan')).toBeNull();
    expect(weltForSub(null)).toBeNull();
  });

  it('nennt die Route jeder Welt gleich wie ihre Id (eine Wahrheit)', () => {
    for (const welt of Object.values(WELTEN)) expect(welt.sub).toBe(welt.id);
  });
});
