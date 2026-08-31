import { describe, expect, it } from 'vitest';
import {
  STEUERART_INTRO_KEY,
  STEUERART_INTRO_SCHLUSS,
  introGesehen,
  introSichtbar,
  introZeilen,
  mitGesehen,
  ranglisteSatz,
} from './steuerartIntro';
import type { SiteVerbraucher } from './verbraucherZone';

function daten(over: Partial<SiteVerbraucher> = {}): SiteVerbraucher {
  return {
    verbraucher: [],
    ladepunkte: { standard: null, standardFolger: 0, gesamt: 0, rahmen: null },
    rangliste: [],
    ...over,
  };
}

describe('Der Erstbesuch-Hinweis zählt auf, was ÜBERNOMMEN wurde (§7.4)', () => {
  it('nennt je Komponente Steuerart UND Herkunft', () => {
    const z = introZeilen(daten({
      verbraucher: [
        {
          entityId: 'a', name: 'Wallbox Garage', typ: 'ev-charger', typLabel: 'Ladepunkt',
          ladepunkt: true, regeln: 0,
          steuerart: { quelle: 'ueberschuss', herkunft: 'standard', ueberschussModus: 'mindestleistung' },
        },
        {
          entityId: 'b', name: 'Heizstab', typ: 'heating-rod', typLabel: 'Heizstab',
          ladepunkt: false, regeln: 0,
          steuerart: {
            quelle: 'feste_zeiten', herkunft: 'policy',
            fenster: { tage: 'daily', von: '22:00', bis: '06:00' },
          },
        },
      ],
    }));
    expect(z[0].text).toContain('Wallbox Garage');
    expect(z[0].text).toContain('Überschuss');
    expect(z[0].herkunft).toContain('Ladepark-Einstellung');
    expect(z[1].herkunft).toContain('bisherigen Regel');
  });

  it('sagt bei einer nicht abbildbaren Regel, dass sie UNVERÄNDERT bleibt', () => {
    const z = introZeilen(daten({
      verbraucher: [{
        entityId: 'c', name: 'Pumpe Keller', typ: 'pump', typLabel: 'Pumpe',
        ladepunkt: false, regeln: 0,
        steuerart: { quelle: 'eigene_regel', herkunft: 'policy' },
      }],
    }));
    expect(z[0].text).toContain('bleibt eine eigene Regel');
    expect(z[0].herkunft).toContain('unverändert');
  });

  it('behauptet über eine Komponente ohne Policy kein „übernommen"', () => {
    const z = introZeilen(daten({
      verbraucher: [{
        entityId: 'd', name: 'Schaltlast', typ: 'generic-load', typLabel: 'Schaltlast',
        ladepunkt: false, regeln: 0, steuerart: { quelle: 'sofort', herkunft: 'ohne' },
      }],
    }));
    expect(z[0].herkunft).toBe('bisher nicht gesteuert');
  });

  it('entsteht auf einer Anlage OHNE steuerbares Gerät gar nicht', () => {
    // „Nichts ist verloren gegangen" über eine leere Anlage wäre eine Aussage
    // über nichts.
    expect(introSichtbar(daten())).toBe(false);
    expect(introSichtbar(null)).toBe(false);
    expect(STEUERART_INTRO_SCHLUSS).toContain('Nichts ist verloren');
  });
});

describe('Der Rangliste-Satz steht nur, wo es wirklich eine Reihenfolge gibt', () => {
  it('schweigt unter zwei Einträgen', () => {
    expect(ranglisteSatz(daten())).toBeNull();
    expect(ranglisteSatz(daten({
      rangliste: [{ position: 1, art: 'speicher', entityId: null, name: 'Speicher' }],
    }))).toBeNull();
  });

  it('nennt den Speicher, wenn er oben steht', () => {
    const s = ranglisteSatz(daten({
      rangliste: [
        { position: 1, art: 'speicher', entityId: null, name: 'Speicher' },
        { position: 2, art: 'ladepunkt', entityId: 'a', name: 'Wallbox' },
      ],
    }));
    expect(s).toContain('Speicher zuerst');
  });

  it('nennt sonst den Namen, der oben steht — nie „Speicher" ins Blaue', () => {
    const s = ranglisteSatz(daten({
      rangliste: [
        { position: 1, art: 'ladepunkt', entityId: 'a', name: 'Wallbox' },
        { position: 2, art: 'speicher', entityId: null, name: 'Speicher' },
      ],
    }));
    expect(s).toContain('„Wallbox" zuerst');
  });
});

describe('Die „gesehen"-Marke — je ANLAGE, additiv, nie eine Anordnung überschreibend', () => {
  it('gilt als NICHT gesehen, solange nichts vorliegt', () => {
    expect(introGesehen(null)).toBe(false);
    expect(introGesehen(undefined)).toBe(false);
    expect(introGesehen({ order: [], hidden: [], shown: [], lead: null })).toBe(false);
  });

  it('merkt sich die Marke, ohne die Anordnung anzufassen', () => {
    const doc = {
      order: ['status', 'geld'], hidden: ['preis'], shown: [], lead: 'geld',
      seen: ['steuerung-intro'],
    };
    const neu = mitGesehen(doc);
    expect(neu.seen).toEqual(['steuerung-intro', STEUERART_INTRO_KEY]);
    expect(neu.order).toEqual(['status', 'geld']);
    expect(neu.hidden).toEqual(['preis']);
    expect(neu.lead).toBe('geld');
    expect(introGesehen(neu)).toBe(true);
  });

  it('ist idempotent', () => {
    const einmal = mitGesehen(null);
    expect(mitGesehen(einmal).seen).toEqual([STEUERART_INTRO_KEY]);
  });
});
