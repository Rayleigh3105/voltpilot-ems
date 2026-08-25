import { describe, expect, it } from 'vitest';
import {
  activeAreaKey,
  anlageBereiche,
  anlageSidebar,
  bereichFor,
  bereichLabel,
  bottomBarSlots,
  modeViewItems,
  resolveAnlage,
  tabsFor,
  type AnlageBereich,
  type BereichId,
} from './anlageNav';
import { MAIN_PAGES, type AnlagenSub } from './nav';
import { anlageSurface, type AnlageSurfaceInput } from './surface';

/**
 * Jede `AnlagenSub`, die es gibt - die Wahrheit für „nichts ist verwaist".
 *
 * ⚠ `geraet` und `box` stehen bewusst NICHT hier: die Geräte-Detailseite
 * braucht eine Geräte-Referenz im Pfad, und die BOX-Seite ist das TOR der
 * Zentrale - ein Reiter könnte beides gar nicht erzeugen. Sie sind eine Ebene
 * UNTER dem Bereich „Anlage" und heben ihn hervor (`activeAreaKey`),
 * erreichbar ausschließlich von dort.
 */
const ALL_SUBS: AnlagenSub[] = [
  'fahrplan',
  'ladevorgaenge',
  'messwerte',
  'erloese',
  'marktpreise',
  'prognose',
  'wetter',
  'lastspitzen',
  'steuerung',
  'modell',
  'technik',
  'befehle',
];

const ENTITIES: AnlageSurfaceInput['entities'] = [
  { id: 'e1', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } },
];

/** Eine Anlage ohne Speicher (nur Erzeugung) - kein Fahrplan an der Basis. */
const PV_ONLY = {
  id: 'e-pv',
  entityType: 'producer',
  capabilities: { measure: [{ channel: 'pv_power_kw' }] },
};

/** Die FÜNF Bereiche in ihrer festen Reihenfolge, auf einer Speicher-Anlage. */
const FUENF: BereichId[] = ['cockpit', 'fahrplan', 'verlauf', 'steuerung', 'anlage'];

/** A migrated plant with the market mode active. */
const MARKT = anlageSurface({
  entities: ENTITIES,
  config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
});

/** A migrated plant with the peak mode active. */
const PEAK = anlageSurface({
  entities: ENTITIES,
  config: { plantKind: 'eigenverbrauch', leistungspreisEurKw: 120 },
});

/** Both money modes at once - the widest possible nav. */
const ALLE = anlageSurface({
  entities: ENTITIES,
  config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch', leistungspreisEurKw: 120 },
  signals: {
    hasStorage: true,
    hasPv: true,
    activeStrategyNodeTypes: [],
    plantKind: 'direktvermarktung',
    hasLeistungspreis: true,
  },
});

/** A plain self-consumption plant (no market, no peak). */
const PRIVAT = anlageSurface({
  entities: ENTITIES,
  signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'fest' },
});

function keys(bereiche: AnlageBereich[]): BereichId[] {
  return bereiche.map((b) => b.key);
}

function tabsOf(bereiche: AnlageBereich[], key: BereichId): string[] {
  return bereiche.find((b) => b.key === key)?.tabs.map((t) => t.key) ?? [];
}

/** Jede Unterseite, die die fünf Bereiche + ihre Reiter erreichen. */
function reachable(bereiche: AnlageBereich[]): (AnlagenSub | null)[] {
  const out: (AnlagenSub | null)[] = [];
  for (const b of bereiche) {
    if (b.tabs.length > 0) out.push(...b.tabs.map((t) => t.sub));
    else if (b.target.kind === 'sub') out.push(b.target.sub);
  }
  return out;
}

describe('anlageBereiche - die fünf Bereiche sind FEST und geordnet', () => {
  it('sind Cockpit · Fahrplan · Verlauf · Steuerung · Anlage auf jeder Speicher-Anlage', () => {
    for (const surface of [MARKT, PEAK, ALLE, PRIVAT]) {
      expect(keys(anlageBereiche(surface))).toEqual(FUENF);
    }
  });

  it('lässt den zweiten Bereich WEG, wo es weder Speicher noch Ladepunkte gibt', () => {
    // „Ein Bereich ohne Inhalt existiert nicht" - der einzige Bereich, der der
    // Komposition folgt.
    const ohne = anlageSurface({ entities: [PV_ONLY], config: { plantKind: 'eigenverbrauch' } });
    expect(keys(anlageBereiche(ohne))).toEqual(['cockpit', 'verlauf', 'steuerung', 'anlage']);
  });

  it('nennt ihn „Ladevorgänge" auf einem REINEN Ladepark', () => {
    const ladepark = anlageSurface({
      entities: [
        { id: 'cp', entityType: 'ev-charger', capabilities: { measure: [{ channel: 'power_kw' }] } },
      ],
      config: { plantKind: 'eigenverbrauch' },
    });
    const bereiche = anlageBereiche(ladepark);
    const zweiter = bereiche[1];
    expect(zweiter.key).toBe('ladevorgaenge');
    expect(zweiter.label).toBe('Ladevorgänge');
    expect(zweiter.target).toEqual({ kind: 'sub', sub: 'ladevorgaenge' });
    // Ein Bereich mit EINEM Reiter behauptet keine Wahl.
    expect(tabsFor(anlageSidebar(ladepark), 'ladevorgaenge')).toEqual([]);
  });

  it('hängt die Ladevorgänge als ZWEITEN Reiter an den Fahrplan, wo es beides gibt', () => {
    const beides = anlageSurface({
      entities: [
        ...(ENTITIES ?? []),
        { id: 'cp', entityType: 'ev-charger', capabilities: { measure: [{ channel: 'power_kw' }] } },
      ],
      config: { plantKind: 'eigenverbrauch' },
    });
    const bereiche = anlageBereiche(beides);
    expect(keys(bereiche)).toEqual(FUENF);
    expect(tabsOf(bereiche, 'fahrplan')).toEqual(['fahrplan', 'ladevorgaenge']);
  });

  it('öffnet jeder Bereich seine erste Seite', () => {
    const b = anlageBereiche(MARKT);
    expect(b.map((x) => (x.target.kind === 'sub' ? x.target.sub : null))).toEqual([
      null, // Cockpit
      'fahrplan',
      'messwerte', // der erste Reiter des Verlaufs
      'steuerung',
      'modell', // der erste Reiter der Anlage
    ]);
  });
});

describe('die REITER entstehen aus dem M0-Read-Model', () => {
  it('führt „Messwerte" auf JEDER Anlage - auch einer nie migrierten', () => {
    for (const surface of [MARKT, PRIVAT, null, undefined]) {
      const b = anlageBereiche(surface);
      expect(tabsOf(b, 'verlauf')[0]).toBe('messwerte');
    }
  });

  it('trägt „Erlöse" nur mit Geld-Modus', () => {
    expect(tabsOf(anlageBereiche(MARKT), 'verlauf')).toContain('erloese');
    expect(tabsOf(anlageBereiche(PRIVAT), 'verlauf')).not.toContain('erloese');
  });

  it('trägt „Marktpreise" nur auf einem Börsentarif', () => {
    expect(tabsOf(anlageBereiche(MARKT), 'verlauf')).toContain('marktpreise');
    expect(tabsOf(anlageBereiche(PRIVAT), 'verlauf')).not.toContain('marktpreise');
  });

  it('trägt „Lastspitzen" nur mit der Lastspitzenkappung', () => {
    expect(tabsOf(anlageBereiche(PEAK), 'verlauf')).toContain('lastspitzen');
    expect(tabsOf(anlageBereiche(PRIVAT), 'verlauf')).not.toContain('lastspitzen');
  });

  it('hält die Reihenfolge des Zielbilds ein', () => {
    expect(tabsOf(anlageBereiche(ALLE), 'verlauf')).toEqual([
      'messwerte',
      'erloese',
      'marktpreise',
      'lastspitzen',
      'prognose',
      'wetter',
    ]);
  });

  it('gibt dem Bereich „Anlage" seine drei strukturellen Reiter', () => {
    for (const surface of [MARKT, PRIVAT, null]) {
      expect(tabsOf(anlageBereiche(surface), 'anlage')).toEqual(['modell', 'technik', 'befehle']);
    }
  });

  it('gibt Cockpit und Steuerung GAR KEINE Reiter - sie sind je EINE Seite', () => {
    const b = anlageBereiche(ALLE);
    expect(tabsOf(b, 'cockpit')).toEqual([]);
    expect(tabsOf(b, 'steuerung')).toEqual([]);
  });
});

describe('das Abzeichen bleibt an der Steuerung', () => {
  it('trägt die Modus-Zahl des M0-Read-Models', () => {
    const b = anlageBereiche(MARKT, 3);
    expect(b.find((x) => x.key === 'steuerung')?.badge).toBe(3);
  });

  it('rendert bei 0/null/NaN KEIN Abzeichen - nie eine entmutigende „0"', () => {
    for (const n of [0, null, Number.NaN, -2]) {
      expect(anlageBereiche(MARKT, n).find((x) => x.key === 'steuerung')?.badge).toBeNull();
    }
  });

  it('badgt sonst NICHTS', () => {
    const b = anlageBereiche(ALLE, 2);
    expect(b.filter((x) => x.badge != null).map((x) => x.key)).toEqual(['steuerung']);
  });

  it('nimmt ohne Argument die eigene Modus-Zahl der Projektion', () => {
    const b = anlageBereiche(MARKT);
    expect(b.find((x) => x.key === 'steuerung')?.badge).toBe(MARKT.modes.length || null);
  });
});

describe('anlageSidebar - Bereiche plus Fuß', () => {
  it('trägt im Fuß NUR noch „Hilfe & Kontakt"', () => {
    // Die „Einstellungen" sind ein Reiter des Bereichs „Anlage" geworden.
    const { foot } = anlageSidebar(MARKT);
    expect(foot.map((f) => f.key)).toEqual(['hilfe']);
    expect(foot[0].target).toEqual({ kind: 'help' });
  });

  it('hat KEINE Anwendungs-Gruppen mehr - nur die fünf Bereiche', () => {
    const s = anlageSidebar(ALLE);
    expect(keys(s.bereiche)).toEqual(FUENF);
  });
});

describe('bottomBarSlots - die Telefon-Leiste sind die fünf Bereiche', () => {
  it('ist byte-gleich mit der Seitenleiste, ohne „Mehr"', () => {
    const s = anlageSidebar(ALLE, 2);
    const slots = bottomBarSlots(s);
    expect(slots.map((i) => i.key)).toEqual(FUENF);
    expect(slots.some((i) => i.key === 'more')).toBe(false);
  });

  it('trägt das Steuerungs-Abzeichen auf seiner eigenen Kachel', () => {
    const slots = bottomBarSlots(anlageSidebar(MARKT, 4));
    expect(slots.find((i) => i.key === 'steuerung')?.badge).toBe(4);
  });

  it('kürzt nur, wo das volle Wort am Telefon nicht trägt', () => {
    const ladepark = anlageSurface({
      entities: [
        { id: 'cp', entityType: 'ev-charger', capabilities: { measure: [{ channel: 'power_kw' }] } },
      ],
      config: { plantKind: 'eigenverbrauch' },
    });
    const slots = bottomBarSlots(anlageSidebar(ladepark));
    expect(slots.find((i) => i.key === 'ladevorgaenge')?.label).toBe('Laden');
    expect(slots.find((i) => i.key === 'cockpit')?.label).toBe('Cockpit');
  });

  it('hat auf einer Anlage ohne Speicher/Ladepunkte VIER Kacheln - nie einen leeren Slot', () => {
    const ohne = anlageSurface({ entities: [PV_ONLY], config: { plantKind: 'eigenverbrauch' } });
    expect(bottomBarSlots(anlageSidebar(ohne)).map((i) => i.key)).toEqual([
      'cockpit',
      'verlauf',
      'steuerung',
      'anlage',
    ]);
  });
});

describe('tabsFor - EINE Ableitung für Leiste und Reiter', () => {
  it('gibt einer Unterseite die Reiter IHRES Bereichs', () => {
    const s = anlageSidebar(ALLE);
    expect(tabsFor(s, 'erloese').map((t) => t.sub)).toEqual([
      'messwerte',
      'erloese',
      'marktpreise',
      'lastspitzen',
      'prognose',
      'wetter',
    ]);
    expect(tabsFor(s, 'technik').map((t) => t.sub)).toEqual(['modell', 'technik', 'befehle']);
  });

  it('liefert LEER, wo der Bereich EINE Seite ist', () => {
    const s = anlageSidebar(ALLE);
    expect(tabsFor(s, null)).toEqual([]);
    expect(tabsFor(s, 'steuerung')).toEqual([]);
  });

  it('liefert LEER, wo der Bereich nur EINEN Reiter hätte', () => {
    // Speicher, aber keine Ladepunkte: der Fahrplan ist EINE Seite.
    expect(tabsFor(anlageSidebar(PRIVAT), 'fahrplan')).toEqual([]);
  });

  it('benennt den Bereich, in dem eine Unterseite wohnt', () => {
    const s = anlageSidebar(ALLE);
    expect(bereichLabel(s, 'marktpreise')).toBe('Verlauf');
    expect(bereichLabel(s, 'befehle')).toBe('Anlage');
    expect(bereichLabel(s, null)).toBe('Cockpit');
  });
});

describe('nichts ist verwaist: jede AnlagenSub hat einen Bereich oder einen Reiter', () => {
  it('erreicht auf der breitesten Anlage jede Unterseite - und keine zweimal', () => {
    const beides = anlageSurface({
      entities: [
        ...(ENTITIES ?? []),
        { id: 'cp', entityType: 'ev-charger', capabilities: { measure: [{ channel: 'power_kw' }] } },
      ],
      config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch', leistungspreisEurKw: 120 },
      signals: {
        hasStorage: true,
        hasPv: true,
        activeStrategyNodeTypes: [],
        plantKind: 'direktvermarktung',
        hasLeistungspreis: true,
      },
    });
    const subs = reachable(anlageBereiche(beides));
    for (const sub of ALL_SUBS) {
      expect(subs.filter((s) => s === sub)).toHaveLength(1);
    }
    // Das Cockpit ist der einzige „sub: null"-Eintrag.
    expect(subs.filter((s) => s === null)).toHaveLength(1);
  });

  it('ordnet JEDE Unterseite genau einem Bereich zu', () => {
    for (const sub of [...ALL_SUBS, 'geraet' as AnlagenSub, 'box' as AnlagenSub]) {
      expect(FUENF.concat('ladevorgaenge')).toContain(bereichFor(sub));
    }
  });
});

describe('activeAreaKey - EINE Hervorhebungs-Regel', () => {
  it('bildet das Cockpit und jede Unterseite auf ihren BEREICH ab', () => {
    expect(activeAreaKey(null)).toBe('cockpit');
    expect(activeAreaKey('fahrplan')).toBe('fahrplan');
    expect(activeAreaKey('ladevorgaenge')).toBe('fahrplan');
    for (const sub of ['messwerte', 'erloese', 'marktpreise', 'prognose', 'wetter', 'lastspitzen'] as const) {
      expect(activeAreaKey(sub)).toBe('verlauf');
    }
    expect(activeAreaKey('steuerung')).toBe('steuerung');
    for (const sub of ['modell', 'technik', 'befehle', 'geraet', 'box'] as const) {
      expect(activeAreaKey(sub)).toBe('anlage');
    }
  });
});

describe('modeViewItems - die geteilte Ableitung des Anwendungs-Containers', () => {
  it('bildet Ansichten auf ANLAGEN-Unterseiten ab, nie auf Seiten daneben', () => {
    const items = modeViewItems(['marktpreise', 'prognosequalitaet']);
    expect(items.map((i) => i.target)).toEqual([
      { kind: 'sub', sub: 'marktpreise' },
      { kind: 'sub', sub: 'prognose' },
    ]);
  });

  it('zieht ab, was die Basis schon trägt', () => {
    expect(modeViewItems(['fahrplan', 'lastspitzen'], ['fahrplan']).map((i) => i.key)).toEqual([
      'lastspitzen',
    ]);
  });

  it('ist leer für einen Modus, dessen Ansichten alle Basis-Bereiche sind', () => {
    expect(modeViewItems(['live', 'geraete', 'telemetrie-historie'])).toEqual([]);
  });
});

describe('Marktpreise/Prognose sind keine Seiten der oberen Ebene mehr', () => {
  it('die Hauptnavigation ist nur noch die Übersicht', () => {
    expect(MAIN_PAGES.map((p) => p.id)).toEqual(['uebersicht']);
  });
});

describe('resolveAnlage - one resolution for the shell AND the page', () => {
  const sites = [{ id: 'a' }, { id: 'b' }];

  it('prefers the requested Anlage', () => {
    expect(resolveAnlage(sites, 'b')).toEqual({ id: 'b' });
  });

  it('falls back to the single Anlage of a one-Anlage customer', () => {
    expect(resolveAnlage([{ id: 'only' }], null)).toEqual({ id: 'only' });
  });

  it('resolves to null for a fleet without a selection (the list)', () => {
    expect(resolveAnlage(sites, null)).toBeNull();
  });

  it('falls back rather than 404-ing on an unknown/stale site id', () => {
    expect(resolveAnlage([{ id: 'only' }], 'gone')).toEqual({ id: 'only' });
    expect(resolveAnlage(sites, 'gone')).toBeNull();
  });

  it('handles the empty account', () => {
    expect(resolveAnlage([], null)).toBeNull();
  });
});
