import { describe, expect, it } from 'vitest';
import {
  activeAreaKey,
  anlageBereiche,
  anlageSidebar,
  bereichFor,
  bereichLabel,
  bottomBarSlots,
  ebenenAktiv,
  ebenenBereiche,
  ebenenLeiste,
  ebenenOrt,
  EBENEN_SEITEN,
  modeViewItems,
  resolveAnlage,
  tabsFor,
  type AnlageBereich,
  type BereichId,
  type EbenenLesemodell,
  type EbenenSeiten,
} from './ebenenNav';
import { MAIN_PAGES, pageRoute, standortRoute, type AnlagenSub } from './nav';
import { anlageSurface, type AnlageSurfaceInput } from './surface';
import { ahrenbergFunktionen, funktionWerkAhrenberg, funktionWerkLindach } from './test/funktionenFixtures';
import { ahrenbergKennzahlen } from './test/kennzahlenFixtures';
import { FIXTURE_IDS, werkAhrenberg, werkLindach } from './test/standorteFixtures';

/**
 * Jede `AnlagenSub`, die es gibt - die Wahrheit für „nichts ist verwaist".
 *
 * ⚠ `geraet`, `box` und `befehle` stehen bewusst NICHT hier: Geräte- und
 * Box-Seite brauchen eine Referenz im Pfad; die Befehlsseite wird nur noch aus
 * der jeweiligen Geräte-Detailseite gefiltert geöffnet. Ein Anlagen-Reiter
 * könnte diese Ziele nicht korrekt erzeugen. Sie heben weiterhin den Bereich
 * „Anlage" hervor (`activeAreaKey`).
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

  it('gibt dem Bereich „Anlage" nur Komponenten und Einstellungen', () => {
    for (const surface of [MARKT, PRIVAT, null]) {
      expect(tabsOf(anlageBereiche(surface), 'anlage')).toEqual(['modell', 'technik']);
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
    expect(tabsFor(s, 'technik').map((t) => t.sub)).toEqual(['modell', 'technik']);
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
    for (const sub of [
      ...ALL_SUBS,
      'befehle' as AnlagenSub,
      'geraet' as AnlagenSub,
      'box' as AnlagenSub,
    ]) {
      expect(FUENF.concat('ladevorgaenge')).toContain(bereichFor(sub));
    }
  });
});

describe('tabsFor - eine Ebene unter dem Bereich traegt keine Bereichs-Reiter', () => {
  it('gibt der Geraete- und der Box-Seite KEINE Reiter, obwohl ihr Bereich zwei hat', () => {
    const sidebar = anlageSidebar(anlageSurface({ entities: ENTITIES, config: {} }));
    // Der Wirt hat wirklich mehr als einen Reiter - der Beweis waere sonst
    // vakuum (die Regel `tabs.length > 1` haette ohnehin geschwiegen).
    expect(tabsFor(sidebar, 'modell').map((t) => t.sub)).toEqual(['modell', 'technik']);
    // ... und genau diese Leiste steht ueber einem einzelnen Geraet NICHT:
    // sie gehoert dem BEREICH, die Seite zeigt EIN Geraet, und keiner ihrer
    // Reiter waere aktiv (Stufe 0, Paragraph 2.1).
    expect(tabsFor(sidebar, 'geraet')).toEqual([]);
    expect(tabsFor(sidebar, 'box')).toEqual([]);
    // Die Hervorhebung der Seitenleiste bleibt davon unberuehrt.
    expect(activeAreaKey('geraet')).toBe('anlage');
    expect(activeAreaKey('box')).toBe('anlage');
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

/**
 * Steuern-Regel (Captain über firstmate 004, 15.09.2026: „Okay ich will aber
 * schon das Messkunden auch zu Kunden werden wo man verbraucher steuern kann."):
 * eine Anlage, die nur misst, bekommt kein Steuern angeboten — aber der Weg
 * dorthin bleibt offen. Still heißt nicht Sackgasse.
 */
describe('Steuern-Regel · Erreichbarkeit: eine Anlage, die nur misst, behält den Bereich „Steuerung"', () => {
  it('nur ein Netzzähler: „Steuerung" steht in der Seitenleiste UND als Telefon-Kachel, jeweils mit Ziel', () => {
    const nurMessen = anlageSurface({
      entities: [{ id: 'e-netz', entityType: 'grid-meter', capabilities: { measure: [{ channel: 'power_kw' }] } }],
      config: { plantKind: 'eigenverbrauch' },
    });
    const sidebar = anlageSidebar(nurMessen);
    expect(sidebar.bereiche.find((b) => b.key === 'steuerung')).toMatchObject({
      label: 'Steuerung',
      target: { kind: 'sub', sub: 'steuerung' },
    });
    expect(bottomBarSlots(sidebar).find((s) => s.key === 'steuerung')).toMatchObject({
      label: 'Steuerung',
      target: { kind: 'sub', sub: 'steuerung' },
    });
  });
});

// ---------------------------------------------------------------------------
// UEMS AP-01 IP-7 — die Telefon-Leiste je Ebene (E4 = A)
// ---------------------------------------------------------------------------

const UNTERNEHMEN = { art: 'unternehmen' } as const;
const WERK = { art: 'standort', standortId: FIXTURE_IDS.st1 } as const;
const LINDACH = { art: 'standort', standortId: FIXTURE_IDS.st2 } as const;

/** Ahrenberg am 20.10.2026: zwei Standorte, beide messen, Kennzahlen aus dem Referenzunternehmen. */
const MESSKUNDE: EbenenLesemodell = {
  standorte: [werkAhrenberg(), werkLindach()],
  funktionen: ahrenbergFunktionen(),
  kennzahlen: ahrenbergKennzahlen(),
};

/** Ein Betriebskunde ohne „Messen": dieselben zwei Standorte, Messen hat kein Objekt (A11). */
const BETRIEBSKUNDE: EbenenLesemodell = {
  standorte: [werkAhrenberg(), werkLindach()],
  funktionen: ahrenbergFunktionen({ messen: 'bestand' }),
  kennzahlen: [],
};

/**
 * Das Bild, sobald JEDER Bereich eine Seite hat (AP-04 IP-5, AP-13) — nur, um
 * die Regel unabhängig vom heutigen Stand der Seiten zu prüfen.
 */
const ALLE_SEITEN: EbenenSeiten = (ort) => {
  const hier = ort.art === 'unternehmen' ? pageRoute('portfolio') : standortRoute(ort.standortId);
  return { uebersicht: hier, standorte: hier, gebaeude: hier, anlagen: hier, messstellen: hier, kennzahlen: hier, berichte: hier };
};

const labels = (liste: { label: string }[]) => liste.map((b) => b.label);

describe('ebenenBereiche - die Bereiche der Ebene kommen aus dem Read-Model, nicht aus einer festen Liste', () => {
  it('Unternehmen eines Messkunden: Übersicht · Standorte · Messstellen · Kennzahlen · Berichte', () => {
    expect(labels(ebenenBereiche(UNTERNEHMEN, MESSKUNDE))).toEqual([
      'Übersicht',
      'Standorte',
      'Messstellen',
      'Kennzahlen',
      'Berichte',
    ]);
  });

  it('Standort Werk Ahrenberg (3 Gebäude, 2 Anlagen, misst): Übersicht · Gebäude · Anlagen · Messstellen', () => {
    expect(labels(ebenenBereiche(WERK, MESSKUNDE))).toEqual(['Übersicht', 'Gebäude', 'Anlagen', 'Messstellen']);
  });

  it('Werk Lindach hat EINE Anlage: kein Bereich „Anlagen"', () => {
    expect(labels(ebenenBereiche(LINDACH, MESSKUNDE))).toEqual(['Übersicht', 'Gebäude', 'Messstellen']);
  });

  it('Standorte erst ab zwei — ein archivierter zählt nicht', () => {
    const einer = { ...MESSKUNDE, standorte: [werkAhrenberg(), werkLindach({ zustand: 'archiviert' })] };
    expect(labels(ebenenBereiche(UNTERNEHMEN, einer))).not.toContain('Standorte');
  });

  it('Kennzahlen erst mit einer Kennzahl — eine archivierte zählt nicht', () => {
    const archiviert = ahrenbergKennzahlen().map((k) => ({ ...k, archiviert_am: '2026-10-19T12:00:00+02:00' }));
    expect(labels(ebenenBereiche(UNTERNEHMEN, { ...MESSKUNDE, kennzahlen: [] }))).not.toContain('Kennzahlen');
    expect(labels(ebenenBereiche(UNTERNEHMEN, { ...MESSKUNDE, kennzahlen: archiviert }))).not.toContain('Kennzahlen');
    // Ohne Messen gibt es keine Kennzahlen-Ebene, auch mit Kennzahl.
    expect(labels(ebenenBereiche(UNTERNEHMEN, { ...BETRIEBSKUNDE, kennzahlen: ahrenbergKennzahlen() }))).toEqual([
      'Übersicht',
      'Standorte',
    ]);
  });

  it('ein Entwurf misst noch nicht; eingerichtet schon', () => {
    const mit = (zustand: 'entwurf' | 'eingerichtet') => {
      const f = ahrenbergFunktionen({ messen: 'bestand' });
      f.standorte[1].messen = { ...f.standorte[1].messen, zustand };
      return { ...BETRIEBSKUNDE, funktionen: f };
    };
    expect(labels(ebenenBereiche(LINDACH, mit('entwurf')))).toEqual(['Übersicht', 'Gebäude']);
    expect(labels(ebenenBereiche(LINDACH, mit('eingerichtet')))).toEqual(['Übersicht', 'Gebäude', 'Messstellen']);
    // Am Standort zählt NUR er selbst: Werk Ahrenberg misst hier nicht.
    expect(labels(ebenenBereiche(WERK, mit('eingerichtet')))).toEqual(['Übersicht', 'Gebäude', 'Anlagen']);
  });

  it('unbekannt ist nie vorhanden: ohne Funktionen und Kennzahlen nur, was die Standorte selbst tragen', () => {
    const unbekannt: EbenenLesemodell = { standorte: MESSKUNDE.standorte, funktionen: null, kennzahlen: null };
    expect(labels(ebenenBereiche(UNTERNEHMEN, unbekannt))).toEqual(['Übersicht', 'Standorte']);
    expect(labels(ebenenBereiche(WERK, { standorte: null, funktionen: null, kennzahlen: null }))).toEqual(['Übersicht']);
  });
});

describe('ebenenLeiste - Prüfnachweis AP-01 IP-7', () => {
  it('1 · ein Betriebskunde ohne „Messen" bekommt keine Leiste — wie heute, auch wenn alle Seiten da wären', () => {
    expect(ebenenLeiste(UNTERNEHMEN, BETRIEBSKUNDE)).toEqual([]);
    expect(ebenenLeiste(UNTERNEHMEN, BETRIEBSKUNDE, ALLE_SEITEN)).toEqual([]);
  });

  it('2 · ein Messkunde bekommt fünf Kacheln, in der Reihenfolge der Tabelle', () => {
    const leiste = ebenenLeiste(UNTERNEHMEN, MESSKUNDE, ALLE_SEITEN);
    expect(labels(leiste)).toEqual(['Übersicht', 'Standorte', 'Messstellen', 'Kennzahlen', 'Berichte']);
    expect(leiste.map((k) => k.icon)).toEqual(['dashboard', 'map-pin', 'activity', 'trending-up', 'file-text']);
  });

  it('2 · heute: ein Bereich ohne Seite bekommt keine Kachel — Ahrenberg bleibt bei zwei, also ohne Leiste', () => {
    expect(ebenenBereiche(UNTERNEHMEN, MESSKUNDE)).toHaveLength(5);
    expect(ebenenLeiste(UNTERNEHMEN, MESSKUNDE)).toEqual([]);
    expect(ebenenLeiste(WERK, MESSKUNDE)).toEqual([]);
    expect(ebenenLeiste(LINDACH, MESSKUNDE)).toEqual([]);
  });

  it('jede Seite, die es heute gibt, ist eingetragen — und keine, die es nicht gibt', () => {
    expect(EBENEN_SEITEN(UNTERNEHMEN)).toEqual({
      uebersicht: pageRoute('portfolio'),
      standorte: pageRoute('portfolio-standorte'),
    });
    expect(EBENEN_SEITEN(WERK)).toEqual({ uebersicht: standortRoute(FIXTURE_IDS.st1) });
  });

  it('3 · die Anlagen-Ebene ist unverändert: Cockpit · Fahrplan · Verlauf · Steuerung · Anlage', () => {
    expect(bottomBarSlots(anlageSidebar(ALLE, 2)).map((s) => [s.key, s.label, s.target])).toEqual([
      ['cockpit', 'Cockpit', { kind: 'sub', sub: null }],
      ['fahrplan', 'Fahrplan', { kind: 'sub', sub: 'fahrplan' }],
      ['verlauf', 'Verlauf', { kind: 'sub', sub: 'messwerte' }],
      ['steuerung', 'Steuerung', { kind: 'sub', sub: 'steuerung' }],
      ['anlage', 'Anlage', { kind: 'sub', sub: 'modell' }],
    ]);
  });

  it('4 · Steuern-Regel: in der Leiste eines reinen Messkunden steht keine Steuerungs-Kachel — und der Weg zum Steuern bleibt', () => {
    // Reiner Messkunde: keine Anlage nimmt an „Steuern & Optimieren" teil, kein Standort spricht davon.
    const still = structuredClone(ahrenbergFunktionen());
    for (const st of still.standorte) for (const a of st.steuern.anlagen) a.teilnahme.zustand = 'kein_objekt';
    const reinerMesskunde: EbenenLesemodell = { ...MESSKUNDE, funktionen: still };
    for (const ort of [UNTERNEHMEN, WERK, LINDACH]) {
      const leiste = ebenenLeiste(ort, reinerMesskunde, ALLE_SEITEN);
      expect(leiste.length).toBeGreaterThanOrEqual(3);
      expect(labels(leiste).join(' · ')).not.toMatch(/Steuer/);
      // Der Weg: die erste Kachel ist die Übersicht, deren Anlagen-Tabelle jede Anlage öffnet …
      expect(leiste[0].key).toBe('uebersicht');
    }
    expect(EBENEN_SEITEN(UNTERNEHMEN).uebersicht).toEqual(pageRoute('portfolio'));
    // … und dort behält die Anlage, die nur misst, ihre Kachel „Steuerung" mit Ziel.
    const nurMessen = anlageSurface({
      entities: [{ id: 'e-netz', entityType: 'grid-meter', capabilities: { measure: [{ channel: 'power_kw' }] } }],
      config: { plantKind: 'eigenverbrauch' },
    });
    expect(bottomBarSlots(anlageSidebar(nurMessen)).find((s) => s.key === 'steuerung')).toMatchObject({
      label: 'Steuerung',
      target: { kind: 'sub', sub: 'steuerung' },
    });
    // Auch wo ein Standort von Steuern spricht (Halle 1 steuert), bekommt die EBENE keine Steuerungs-Kachel:
    // gesteuert wird je Anlage.
    expect(labels(ebenenLeiste(UNTERNEHMEN, MESSKUNDE, ALLE_SEITEN)).join(' · ')).not.toMatch(/Steuer/);
  });

  it('5 · Schwelle: bei zwei Bereichen keine Leiste, bei drei eine', () => {
    const ohneGebaeude: EbenenLesemodell = { ...BETRIEBSKUNDE, standorte: [werkAhrenberg({ gebaeudeZahl: 0 })] };
    expect(labels(ebenenBereiche(WERK, ohneGebaeude))).toEqual(['Übersicht', 'Anlagen']);
    expect(ebenenLeiste(WERK, ohneGebaeude, ALLE_SEITEN)).toEqual([]);
    const mitGebaeude: EbenenLesemodell = { ...BETRIEBSKUNDE, standorte: [werkAhrenberg()] };
    expect(labels(ebenenLeiste(WERK, mitGebaeude, ALLE_SEITEN))).toEqual(['Übersicht', 'Gebäude', 'Anlagen']);
  });

  it('5 · die Schwelle zählt nur Kacheln MIT Seite', () => {
    const mitGebaeude: EbenenLesemodell = { ...BETRIEBSKUNDE, standorte: [werkAhrenberg()] };
    expect(ebenenBereiche(WERK, mitGebaeude)).toHaveLength(3);
    expect(ebenenLeiste(WERK, mitGebaeude)).toEqual([]);
  });
});

describe('ebenenOrt / ebenenAktiv - welche Ebene eine Seite ohne Anlage zeigt', () => {
  it('Standort-Übersicht, Portfolio-Seiten — und ohne Standorte keine Ebene', () => {
    const unternehmen = { art: 'unternehmen' };
    expect(ebenenOrt(standortRoute(FIXTURE_IDS.st2), unternehmen)).toEqual(LINDACH);
    expect(ebenenOrt(pageRoute('portfolio-messwerte'), unternehmen)).toEqual(UNTERNEHMEN);
    expect(ebenenOrt(pageRoute('portfolio'), { art: 'standort', standort: { id: FIXTURE_IDS.st1 } })).toEqual(WERK);
    expect(ebenenOrt(pageRoute('portfolio'), { art: 'heute' })).toBeNull();
    expect(ebenenOrt(pageRoute('hilfe'), unternehmen)).toBeNull();
  });

  it('die Reiter Messwerte · Erlöse wohnen in der Übersicht, „Standorte" in seinem Bereich', () => {
    expect(ebenenAktiv('portfolio')).toBe('uebersicht');
    expect(ebenenAktiv('portfolio-messwerte')).toBe('uebersicht');
    expect(ebenenAktiv('portfolio-erloese')).toBe('uebersicht');
    expect(ebenenAktiv('standort')).toBe('uebersicht');
    expect(ebenenAktiv('portfolio-standorte')).toBe('standorte');
    expect(ebenenAktiv('hilfe')).toBeNull();
  });
});
