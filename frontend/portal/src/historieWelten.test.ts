import { describe, expect, it } from 'vitest';
import * as welten from './historieWelten';
import {
  availableWelten,
  historieHash,
  PROVENIENZ,
  WELTEN,
  weltForSub,
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

/**
 * E3 (Konzept `vp-erloese-lesbar-konzept-u3` §3.5): der Welt-Kopf und sein
 * Kartenpaar sind ERSATZLOS entfallen — der Wechsel wohnt in den
 * Bereichs-Reitern (`anlageNav` Verlauf › Messwerte · Erlöse), und ein
 * Kartenpaar daneben war derselbe Schalter ein zweites Mal (189 px vor der
 * ersten Zahl, Befund B4).
 */
describe('der Welt-Wechsel wohnt in den Bereichs-Reitern', () => {
  it('führt keine zweite Wechsel-Liste mehr', () => {
    const modul = welten as Record<string, unknown>;
    expect(modul.weltSwitchCards).toBeUndefined();
    expect(modul.WELT_ORDER).toBeUndefined();
  });

  it('lässt die Welt nur sagen, WAS sie ist — nicht, wie man sie wechselt', () => {
    for (const welt of Object.values(WELTEN)) {
      expect(Object.keys(welt).sort()).toEqual(
        ['badge', 'fussText', 'icon', 'id', 'label', 'sub'].sort(),
      );
    }
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
