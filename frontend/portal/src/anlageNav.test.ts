import { describe, expect, it } from 'vitest';
import {
  activeAreaKey,
  activeKeyForPage,
  anlageSidebar,
  bottomBarSlots,
  BASE_GROUP_LABEL,
  fleetBarSlots,
  fleetSheetGroups,
  modeViewItems,
  moreSheetItems,
  resolveAnlage,
  type SidebarGroup,
  type SidebarItem,
} from './anlageNav';
import { MAIN_PAGES, PLATFORM_PAGES, type AnlagenSub } from './nav';
import { anlageSurface, type AnlageSurface, type AnlageSurfaceInput } from './surface';

/** Every AnlagenSub that exists - the "nothing is orphaned" ground truth. */
const ALL_SUBS: AnlagenSub[] = [
  'fahrplan',
  'messwerte',
  'erloese',
  'wetter',
  'technik',
  'modell',
  'steuerung',
  'lastspitzen',
  'verbraucher',
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

/** Die vier FESTEN Basis-Bereiche (abgeleitete Ansichten reihen sich ein). */
const FIXED = ['cockpit', 'messwerte', 'steuerung', 'anlagen-modell'];

/** Dieselben vier plus die modusgebundene Erlöse-Welt an ihrem Platz. */
const FIXED_MIT_ERLOESE = ['cockpit', 'messwerte', 'erloese', 'steuerung', 'anlagen-modell'];

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

function subsOf(items: SidebarItem[]): (AnlagenSub | null)[] {
  return items
    .filter((i) => i.target.kind === 'sub')
    .map((i) => (i.target as { kind: 'sub'; sub: AnlagenSub | null }).sub);
}

function allSubs(groups: SidebarGroup[]): (AnlagenSub | null)[] {
  return groups.flatMap((g) => subsOf(g.items));
}

describe('anlageSidebar - the base group is fixed and ordered', () => {
  it('always carries the four Anlage areas, in that order', () => {
    // Cockpit+Live merge (Option A): the former Live-Daten area is gone — the
    // cockpit hosts the Komponenten-Board + the compact Verlauf itself.
    for (const surface of [MARKT, PEAK, PRIVAT, null, undefined]) {
      const base = anlageSidebar(surface).groups[0];
      expect(base.label).toBe(BASE_GROUP_LABEL);
      expect(base.tone).toBeNull();
      // Die vier festen Bereiche stehen immer und in dieser Reihenfolge da;
      // abgeleitete Basis-Ansichten (Fahrplan/Marktpreise) reihen sich ein.
      expect(base.items.map((i) => i.key).filter((k) => FIXED.includes(k))).toEqual(FIXED);
      // No "Live-Daten" nav item anywhere.
      expect(base.items.some((i) => i.label.includes('Live'))).toBe(false);
    }
  });

  it('is exactly the four areas on a plant with neither storage nor spot tariff', () => {
    for (const surface of [null, undefined]) {
      const base = anlageSidebar(surface).groups[0];
      expect(base.items.map((i) => i.key)).toEqual(FIXED);
      expect(base.items.map((i) => i.label)).toEqual([
        'Cockpit',
        'Messwerte',
        'Steuerung',
        'Anlagen-Modell',
      ]);
    }
  });

  it('opens the cockpit and the three area routes', () => {
    expect(subsOf(anlageSidebar(null).groups[0].items)).toEqual([
      null,
      'messwerte',
      'steuerung',
      'modell',
    ]);
  });

  it('carries the Fahrplan behind Steuerung on EVERY plant with a storage (Hotfix 2026-07-29)', () => {
    // Der gemeldete Vorfall: DV → Eigenverbrauch, kein Modus mehr — und der
    // Fahrplan war weg, obwohl der Optimierer weiterplant. Er hängt am
    // Speicher, also steht er in der Basis-Gruppe, direkt hinter Steuerung.
    for (const surface of [PRIVAT, MARKT, PEAK, ALLE]) {
      const keys = anlageSidebar(surface).groups[0].items.map((i) => i.key);
      expect(keys).toContain('fahrplan');
      expect(keys.indexOf('fahrplan')).toBe(keys.indexOf('steuerung') + 1);
    }
    // Ohne Speicher-Nachweis bleibt die Basis unverändert.
    expect(
      anlageSidebar(anlageSurface({ entities: [PV_ONLY] })).groups[0].items.map((i) => i.key),
    ).toEqual(FIXED);
  });

  it('carries Marktpreise at the end of the base group on a spot tariff', () => {
    const boerse = anlageSurface({
      entities: ENTITIES,
      config: { plantKind: 'eigenverbrauch', tarifArt: 'dynamisch' },
    });
    // Kein Markt-Modus (Eigenverbrauch, kein Netzladen) - und trotzdem die
    // Preisseite: der Kunde zahlt viertelstündlich den Börsenpreis.
    expect(boerse.modes).toEqual([]);
    const keys = anlageSidebar(boerse).groups[0].items.map((i) => i.key);
    expect(keys).toEqual([
      ...FIXED.slice(0, 3),
      'fahrplan',
      'anlagen-modell',
      'marktpreise',
      // Speicher-Anlage ⇒ Prognosequalität ist Basis (Captain 2026-07-29).
      'prognose',
    ]);
    // Fester Tarif: keine Preisseite.
    expect(anlageSidebar(PRIVAT).groups[0].items.map((i) => i.key)).not.toContain('marktpreise');
  });

  it('trägt „Erlöse" nur mit Geld-Modus - und immer neben „Messwerte"', () => {
    // Die Navigation folgt dem Lese-Modell: `telemetrie-historie` ist Basis,
    // `erloes-historie` modusgebunden. Eine Privat-Anlage bekommt also gar
    // keinen Erlöse-Eintrag statt einer Fläche, die leer wäre.
    for (const surface of [MARKT, PEAK, ALLE]) {
      expect(surface.deepViews).toContain('erloes-historie');
      const keys = anlageSidebar(surface).groups[0].items.map((i) => i.key);
      expect(keys).toContain('erloese');
      // Die zwei Welten sind Geschwister - „Erlöse" steht direkt hinter
      // „Messwerte", nie in einer Modus-Gruppe.
      expect(keys.indexOf('erloese')).toBe(keys.indexOf('messwerte') + 1);
    }
    for (const surface of [PRIVAT, null, undefined]) {
      expect(anlageSidebar(surface).groups[0].items.map((i) => i.key)).not.toContain('erloese');
    }
    // Und sie taucht nie unter einem Modus auf (die Geschwister-Regel).
    expect(
      anlageSidebar(ALLE)
        .groups.slice(1)
        .flatMap((g) => g.items.map((i) => i.key)),
    ).not.toContain('erloese');
  });

  it('badges Steuerung with the active-mode count from the M0 read-model', () => {
    const badge = (count: number | null | undefined) =>
      anlageSidebar(null, count).groups[0].items.find((i) => i.key === 'steuerung')?.badge;
    expect(badge(3)).toBe(3);
    expect(badge(1)).toBe(1);
    // Never a discouraging "0" / an invented number.
    expect(badge(0)).toBeNull();
    expect(badge(null)).toBeNull();
    expect(badge(Number.NaN)).toBeNull();
  });

  it('defaults the badge to the surface’s own mode count', () => {
    const steuerung = anlageSidebar(MARKT).groups[0].items.find((i) => i.key === 'steuerung');
    expect(steuerung?.badge).toBe(MARKT.modes.length);
  });

  it('never badges anything but Steuerung', () => {
    const base = anlageSidebar(ALLE).groups[0];
    expect(base.items.filter((i) => i.badge != null).map((i) => i.key)).toEqual(['steuerung']);
  });

  it('carries the foot: Einstellungen · Hilfe & Kontakt (no standalone profile)', () => {
    // v3.1-M2 retired the Modus-Profile shelf - modes are containers opened from
    // the Steuerung capsule, so the foot no longer carries a `profile` entry.
    const { foot } = anlageSidebar(PRIVAT);
    expect(foot.map((i) => i.key)).toEqual(['verbraucher', 'technik', 'hilfe']);
    expect(foot[0].target).toEqual({ kind: 'sub', sub: 'verbraucher' });
    expect(foot[1].target).toEqual({ kind: 'sub', sub: 'technik' });
    expect(foot[2].target).toEqual({ kind: 'help' });
  });
});

describe('anlageSidebar - mode groups are a projection, never a hardcoded list', () => {
  it('renders one labelled, colour-tagged group per active mode with own views', () => {
    const groups = anlageSidebar(PEAK).groups.slice(1);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Modus · Lastspitzenkappung');
    expect(groups[0].tone).toBe('peak');
    expect(groups[0].items.map((i) => i.key)).toEqual(['lastspitzen']);
  });

  it('adds NO group for a mode whose views the base already carries', () => {
    // Seit Fahrplan/Marktpreise/Prognose Basis-Ansichten sind, steuert der
    // Markt-Modus auf einer Speicher-Anlage mit Börsentarif nichts Eigenes mehr
    // bei - dann entfällt die Gruppe (dieselbe Regel wie beim Eigenverbrauch),
    // statt eine leere Überschrift zu zeigen. Erreichbar bleibt alles.
    expect(anlageSidebar(MARKT).groups.slice(1)).toEqual([]);
    const baseKeys = anlageSidebar(MARKT).groups[0].items.map((i) => i.key);
    for (const key of ['fahrplan', 'marktpreise', 'prognose']) {
      expect(baseKeys).toContain(key);
    }
  });

  it('carries Prognose in the BASE group of every storage plant, never in a mode group', () => {
    // Captain 2026-07-29: die Prognose ist die Eingabe des Fahrplans, nicht
    // Marktwissen - sie folgt deshalb derselben Basis-Mechanik.
    const modeKeys = (s: AnlageSurface) =>
      anlageSidebar(s)
        .groups.slice(1)
        .flatMap((g) => g.items.map((i) => i.key));
    const baseKeys = (s: AnlageSurface) => anlageSidebar(s).groups[0].items.map((i) => i.key);
    for (const s of [MARKT, PRIVAT, PEAK]) {
      expect(baseKeys(s)).toContain('prognose');
      expect(modeKeys(s)).not.toContain('prognose');
    }
    // Marktwissen bleibt Marktwissen: keine Preisseite ohne Börsentarif/Modus.
    expect(modeKeys(PRIVAT)).not.toContain('marktpreise');
    expect(baseKeys(PRIVAT)).not.toContain('marktpreise');
    expect(modeKeys(PEAK)).not.toContain('marktpreise');
  });

  it('keeps a market plant WITHOUT storage on the mode-borne Fahrplan', () => {
    // Reichweite wird nie kleiner: ein DV-Park ohne Batterie behält seinen
    // Zugang - er kommt dann eben aus der Modus-Gruppe statt aus der Basis.
    const park = anlageSurface({
      entities: [PV_ONLY],
      config: { plantKind: 'direktvermarktung', tarifArt: 'fest' },
    });
    // Ein DV-Park hat einen Geld-Modus, also auch die Erlöse-Welt.
    expect(anlageSidebar(park).groups[0].items.map((i) => i.key)).toEqual(FIXED_MIT_ERLOESE);
    expect(anlageSidebar(park).groups[1].items.map((i) => i.key)).toEqual([
      'fahrplan',
      'marktpreise',
      'prognose',
    ]);
  });

  it('gives the peak mode its own group with Lastspitzen', () => {
    const groups = anlageSidebar(PEAK).groups.slice(1);
    expect(groups.map((g) => g.label)).toEqual(['Modus · Lastspitzenkappung']);
    expect(groups[0].tone).toBe('peak');
    expect(groups[0].items.map((i) => i.key)).toEqual(['lastspitzen']);
  });

  it('emits NO mode group for a plant with no market/peak/automation mode', () => {
    // Eigenverbrauch is base behaviour (report vp-nacht-bezug-e7 §3.3): a pure
    // PV+Speicher plant has no mode, so it adds no navigation of its own.
    expect(PRIVAT.modes).toEqual([]);
    expect(anlageSidebar(PRIVAT).groups).toHaveLength(1);
  });

  it('never duplicates an entry across two mode groups', () => {
    const keys = anlageSidebar(ALLE)
      .groups.slice(1)
      .flatMap((g) => g.items.map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has no mode group at all for an un-migrated / unloaded plant', () => {
    expect(anlageSidebar(null).groups).toHaveLength(1);
    expect(anlageSidebar(anlageSurface({})).groups).toHaveLength(1);
  });
});

/**
 * Mobil-Umbau Stufe 1 (Konzept `data/vp-mobile-views-x1`, Captain-Go
 * 09.08.2026): die Leiste trägt die TÄGLICHEN Fragen. Vorher hielt das
 * Anlagen-Modell - eine Verifikations-Fläche, die man einmal ansieht - einen
 * Prime-Slot, während Fahrplan und Erlöse hinter „Mehr" lagen.
 */
describe('bottomBarSlots - die tägliche Belegung, ABGELEITET', () => {
  it('ist Cockpit · Fahrplan · Messwerte · Erlöse · Mehr, sobald es beides gibt', () => {
    for (const surface of [MARKT, PEAK, ALLE]) {
      const slots = bottomBarSlots(anlageSidebar(surface));
      expect(slots).toHaveLength(5);
      expect(slots.map((s) => s.label)).toEqual([
        'Cockpit',
        'Fahrplan',
        'Messwerte',
        'Erlöse',
        'Mehr',
      ]);
      expect(slots[4].target).toEqual({ kind: 'more' });
    }
  });

  it('rückt Steuerung/Anlage nach, wo Fahrplan bzw. Erlöse fehlen - nie ein leerer Slot', () => {
    // Speicher, aber kein Geld-Modus: der Fahrplan bleibt, die Erlöse-Welt gibt
    // es gar nicht - also rückt die Steuerung nach.
    expect(bottomBarSlots(anlageSidebar(PRIVAT)).map((s) => s.label)).toEqual([
      'Cockpit',
      'Fahrplan',
      'Messwerte',
      'Steuerung',
      'Mehr',
    ]);
    // Weder Speicher noch Geld-Modus (auch die nie migrierte Anlage): beide
    // Nachrücker ziehen ein. Die Leiste bleibt immer fünf Kacheln lang.
    for (const surface of [anlageSurface({ entities: [PV_ONLY] }), null, undefined]) {
      expect(bottomBarSlots(anlageSidebar(surface)).map((s) => s.label)).toEqual([
        'Cockpit',
        'Messwerte',
        'Steuerung',
        'Anlage',
        'Mehr',
      ]);
    }
  });

  it('holt den Fahrplan auch aus einer MODUS-Gruppe in die Leiste', () => {
    // Ein DV-Park ohne Speicher trägt den Fahrplan im Markt-Modus, nicht in der
    // Basis - die tägliche Frage verdient ihren Platz, wo immer sie hängt.
    const park = anlageSurface({
      entities: [PV_ONLY],
      config: { plantKind: 'direktvermarktung', tarifArt: 'fest' },
    });
    expect(anlageSidebar(park).groups[0].items.map((i) => i.key)).not.toContain('fahrplan');
    expect(bottomBarSlots(anlageSidebar(park)).map((s) => s.label)).toEqual([
      'Cockpit',
      'Fahrplan',
      'Messwerte',
      'Erlöse',
      'Mehr',
    ]);
  });

  it('behält das Steuerungs-Abzeichen sichtbar - auf der Kachel oder auf „Mehr"', () => {
    // In der Leiste: am eigenen Slot.
    const inBar = bottomBarSlots(anlageSidebar(null, 4));
    expect(inBar.find((s) => s.key === 'steuerung')?.badge).toBe(4);
    expect(inBar.find((s) => s.key === 'more')?.badge).toBeNull();
    // Fällt die Steuerung ins Blatt, wandert das Abzeichen sichtbar auf „Mehr" -
    // sonst verschwände der einzige Hinweis auf Handlungsbedarf.
    const inSheet = bottomBarSlots(anlageSidebar(MARKT, 2));
    expect(inSheet.map((s) => s.key)).not.toContain('steuerung');
    expect(inSheet.find((s) => s.key === 'more')?.badge).toBe(2);
    // Und eine 0 wird auch hier nie zu einem entmutigenden Abzeichen.
    expect(bottomBarSlots(anlageSidebar(MARKT, 0)).find((s) => s.key === 'more')?.badge).toBeNull();
  });
});

describe('moreSheetItems - everything the bottom bar does not carry', () => {
  it('carries the base remainder, the mode groups (colour-tagged) and the foot', () => {
    const groups = moreSheetItems(anlageSidebar(ALLE));
    expect(groups[0].label).toBe(BASE_GROUP_LABEL);
    expect(groups[0].tone).toBeNull();
    // Cockpit/Fahrplan/Messwerte/Erlöse sind in der Leiste, der Rest hier.
    expect(groups[0].items.map((i) => i.key)).toEqual([
      'steuerung',
      'anlagen-modell',
      'marktpreise',
      'prognose',
    ]);
    expect(groups[1].label).toBe('Modus · Lastspitzenkappung');
    expect(groups[1].tone).toBe('peak');
    const last = groups[groups.length - 1];
    // Wetter + der Fuß (inkl. „Verbraucher") - und „Abmelden", das am Telefon
    // nirgends sonst steht.
    expect(last.items.map((i) => i.key)).toEqual([
      'wetter',
      'verbraucher',
      'technik',
      'hilfe',
      'logout',
    ]);
  });

  it('lässt eine Modus-Gruppe weg, deren einziger Eintrag in der Leiste steht', () => {
    // Der DV-Park: sein Markt-Modus trägt Fahrplan + Marktpreise + Prognose, der
    // Fahrplan zieht in die Leiste - die Gruppe bleibt mit dem Rest bestehen.
    const park = anlageSurface({
      entities: [PV_ONLY],
      config: { plantKind: 'direktvermarktung', tarifArt: 'fest' },
    });
    const modeGroups = moreSheetItems(anlageSidebar(park)).filter((g) =>
      g.label.startsWith('Modus ·'),
    );
    expect(modeGroups.flatMap((g) => g.items.map((i) => i.key))).toEqual([
      'marktpreise',
      'prognose',
    ]);
    // Und eine Gruppe, die NUR den Leisten-Eintrag trug, verschwindet ganz statt
    // als leere Überschrift stehen zu bleiben.
    const nurFahrplan = {
      groups: [
        { key: 'base', label: BASE_GROUP_LABEL, tone: null, items: [] },
        {
          key: 'mode:x',
          label: 'Modus · X',
          tone: 'markt' as const,
          items: [
            {
              key: 'fahrplan',
              label: 'Fahrplan',
              icon: 'calendar' as const,
              target: { kind: 'sub' as const, sub: 'fahrplan' as const },
              badge: null,
            },
          ],
        },
      ],
      foot: [],
    };
    expect(moreSheetItems(nurFahrplan).some((g) => g.label === 'Modus · X')).toBe(false);
  });

  it('has no base group in the sheet when nothing was derived', () => {
    const groups = moreSheetItems(anlageSidebar(null));
    expect(groups.some((g) => g.label === BASE_GROUP_LABEL)).toBe(false);
  });

  /**
   * „Verbraucher" (#363) ist eine EINRICHTUNGS-Fläche wie Einstellungen, keine
   * tägliche Frage - sie wohnt im Fuß und reist damit ins Blatt, nie in die
   * Leiste. Wer sie später doch in `BOTTOM_PRIORITY` schriebe, bräuchte einen
   * sechsten Slot; dieser Test hält die Belegung bei fünf.
   */
  it('trägt eine Fuß-Fläche wie „Verbraucher" im Blatt, nie in der Leiste', () => {
    for (const surface of [ALLE, MARKT, PEAK, PRIVAT, null]) {
      const sidebar = anlageSidebar(surface);
      expect(bottomBarSlots(sidebar)).toHaveLength(5);
      expect(bottomBarSlots(sidebar).map((s) => s.key)).not.toContain('verbraucher');
      const sheet = moreSheetItems(sidebar).flatMap((g) => g.items.map((i) => i.key));
      expect(sheet.filter((k) => k === 'verbraucher')).toEqual(['verbraucher']);
    }
  });

  it('faltet die zwei Kopfzeilen-Aktionen und die Plattform-Gruppe ein (kein Hamburger mehr)', () => {
    // Am Telefon gibt es seit Stufe 1 keine zweite Menü-Tür - also muss ALLES,
    // was die Kopfzeile bzw. die Seitenleiste trägt, hier ankommen.
    const groups = moreSheetItems(anlageSidebar(PRIVAT), { isAdmin: true, showAddAnlage: true });
    const platform = groups.find((g) => g.label === 'Plattform');
    expect(platform?.items.map((i) => i.key)).toEqual(PLATFORM_PAGES.map((p) => p.id));
    const last = groups[groups.length - 1];
    expect(last.items.map((i) => i.key)).toEqual([
      'wetter',
      'verbraucher',
      'technik',
      'hilfe',
      'add-anlage',
      'logout',
    ]);
    expect(last.items.at(-1)?.target).toEqual({ kind: 'action', action: 'logout' });
    // Ein Kunde ohne zweite Anlage bekommt keinen „＋"-Eintrag, und keine
    // Plattform-Gruppe.
    const kunde = moreSheetItems(anlageSidebar(PRIVAT), { isAdmin: false, showAddAnlage: false });
    expect(kunde.some((g) => g.label === 'Plattform')).toBe(false);
    expect(kunde.at(-1)?.items.map((i) => i.key)).toEqual([
      'wetter',
      'verbraucher',
      'technik',
      'hilfe',
      'logout',
    ]);
  });
});

/**
 * Flotten-Ebene: dieselbe Bar-Mechanik eine Ebene höher (Konzept §3), damit das
 * Daumen-Muster den Ebenen-Wechsel überlebt.
 */
describe('fleetBarSlots / fleetSheetGroups - die Leiste über der Anlage', () => {
  const FLOTTE = {
    showPortfolio: false,
    showPortfolioErloese: false,
    showOverview: true,
    siteCount: 3,
  };

  it('ist Übersicht · Anlagen · Mehr für einen Flotten-Kunden', () => {
    const slots = fleetBarSlots(FLOTTE);
    expect(slots.map((s) => s.label)).toEqual(['Übersicht', 'Anlagen', 'Mehr']);
    expect(slots[0].target).toEqual({ kind: 'page', page: 'uebersicht' });
    expect(slots.at(-1)?.target).toEqual({ kind: 'more' });
  });

  it('führt beim Betreiber mit dem Portfolio und seinen zwei Welten', () => {
    const slots = fleetBarSlots({
      showPortfolio: true,
      showPortfolioErloese: true,
      showOverview: false,
      siteCount: 12,
    });
    expect(slots.map((s) => s.label)).toEqual([
      'Portfolio',
      'Anlagen',
      'Messwerte',
      'Erlöse',
      'Mehr',
    ]);
    // Ohne Geld-Modus in der Flotte gibt es die Erlöse-Welt nicht.
    expect(
      fleetBarSlots({
        showPortfolio: true,
        showPortfolioErloese: false,
        showOverview: false,
        siteCount: 12,
      }).map((s) => s.label),
    ).toEqual(['Portfolio', 'Anlagen', 'Messwerte', 'Mehr']);
  });

  it('bleibt bedienbar, wenn es noch gar keine Anlage gibt (Einrichtung)', () => {
    const slots = fleetBarSlots({
      showPortfolio: false,
      showPortfolioErloese: false,
      showOverview: false,
      siteCount: 0,
    });
    // Singular, und „Mehr" trägt weiterhin Hilfe + Abmelden - ohne Hamburger
    // wäre das Portal sonst eine Sackgasse.
    expect(slots.map((s) => s.label)).toEqual(['Anlage', 'Mehr']);
    expect(
      fleetSheetGroups(
        { showPortfolio: false, showPortfolioErloese: false, showOverview: false, siteCount: 0 },
        {},
      )
        .flatMap((g) => g.items.map((i) => i.key)),
    ).toEqual(['hilfe', 'logout']);
  });

  it('trägt im Blatt die Plattform-Gruppe und die Kopfzeilen-Aktionen', () => {
    const groups = fleetSheetGroups(FLOTTE, { isAdmin: true, showAddAnlage: true });
    expect(groups.find((g) => g.label === 'Plattform')?.items.map((i) => i.key)).toEqual(
      PLATFORM_PAGES.map((p) => p.id),
    );
    expect(groups.at(-1)?.items.map((i) => i.key)).toEqual(['hilfe', 'add-anlage', 'logout']);
  });

  it('verwaist keinen Eintrag: Leiste ∪ Blatt = alle sichtbaren Ebenen-Einträge', () => {
    for (const input of [
      FLOTTE,
      { showPortfolio: true, showPortfolioErloese: true, showOverview: false, siteCount: 9 },
      { showPortfolio: true, showPortfolioErloese: false, showOverview: true, siteCount: 9 },
      { showPortfolio: false, showPortfolioErloese: false, showOverview: false, siteCount: 1 },
    ]) {
      const bar = fleetBarSlots(input)
        .filter((i) => i.target.kind === 'page')
        .map((i) => i.key);
      const sheet = fleetSheetGroups(input, { isAdmin: false, showAddAnlage: false })
        .flatMap((g) => g.items)
        .filter((i) => i.target.kind === 'page')
        .map((i) => i.key);
      const all = [...bar, ...sheet];
      // Immer die Anlagen-Ebene, nie ein Eintrag zweimal.
      expect(all).toContain('anlagen');
      expect(new Set(all).size).toBe(all.length);
      if (input.showPortfolio) expect(all).toContain('portfolio');
      if (input.showOverview) expect(all).toContain('uebersicht');
    }
  });
});

describe('no orphaned view: every AnlagenSub is mounted exactly once', () => {
  it('base ∪ mode groups ∪ Mehr sheet covers every sub, none twice', () => {
    // The widest surface, so every mode group that can exist does.
    const sidebar = anlageSidebar(ALLE);
    const sidebarSubs = allSubs(sidebar.groups).concat(subsOf(sidebar.foot));
    const sheetSubs = allSubs(moreSheetItems(sidebar));

    // Nothing is listed twice WITHIN one surface.
    expect(new Set(sidebarSubs).size).toBe(sidebarSubs.length);
    expect(new Set(sheetSubs).size).toBe(sheetSubs.length);

    // And together they reach every sub the router knows - a new AnlagenSub
    // must be mounted somewhere or this fails.
    const reachable = new Set(
      [...sidebarSubs, ...sheetSubs].filter((s): s is AnlagenSub => s != null),
    );
    expect([...reachable].sort()).toEqual([...ALL_SUBS].sort());
  });

  /**
   * Seit Stufe 1 hat das Telefon KEINEN Hamburger mehr: erreichbar ist genau,
   * was Leiste oder Blatt tragen. Diese Verfassung gilt also am Telefon eigens -
   * die Seitenleiste rettet dort nichts mehr.
   */
  it('am TELEFON: Leiste ∪ Blatt trägt jede Ansicht, und keine zweimal', () => {
    for (const surface of [ALLE, MARKT, PEAK, PRIVAT]) {
      const sidebar = anlageSidebar(surface);
      const barKeys = bottomBarSlots(sidebar)
        .filter((i) => i.target.kind !== 'more')
        .map((i) => i.key);
      // Nur ZIELE, keine Aktionen (＋ Anlage / Abmelden sind keine Ansichten).
      const sheetKeys = moreSheetItems(sidebar)
        .flatMap((g) => g.items)
        .filter((i) => i.target.kind !== 'action')
        .map((i) => i.key);
      const together = [...barKeys, ...sheetKeys];
      // Partition: was die Leiste trägt, steht nicht noch einmal im Blatt.
      expect(new Set(together).size).toBe(together.length);
      // Und zusammen sind sie GENAU die Navigation der Anlage (plus Wetter +
      // Fuß, die keinen Seitenleisten-Platz haben).
      const navKeys = [
        ...sidebar.groups.flatMap((g) => g.items.map((i) => i.key)),
        ...sidebar.foot.map((i) => i.key),
        'wetter',
      ];
      expect([...new Set(together)].sort()).toEqual([...new Set(navKeys)].sort());
    }
  });

  it('reaches every sub even on a plant with no mode at all (via the sheet)', () => {
    const sidebar = anlageSidebar(null);
    const reachable = new Set(
      [...allSubs(sidebar.groups), ...subsOf(sidebar.foot), ...allSubs(moreSheetItems(sidebar))]
        .filter((s): s is AnlagenSub => s != null),
    );
    // Nur die modusgebundenen Ansichten fehlen legitim ohne Modus - die
    // Erlöse-Welt gehört seit der Zwei-Welten-Struktur dazu.
    expect([...reachable].sort()).toEqual(
      ALL_SUBS.filter((s) => !['fahrplan', 'lastspitzen', 'erloese'].includes(s)).sort(),
    );
  });
});

describe('activeAreaKey / activeKeyForPage - ONE highlight rule', () => {
  it('maps the cockpit and every sub onto its own entry', () => {
    expect(activeAreaKey(null)).toBe('cockpit');
    expect(activeAreaKey('modell')).toBe('anlagen-modell');
    for (const sub of ['messwerte', 'erloese', 'steuerung', 'fahrplan', 'lastspitzen', 'wetter', 'technik'] as const) {
      expect(activeAreaKey(sub)).toBe(sub);
    }
  });

  it('keeps a mode page highlighted inside its mode group', () => {
    expect(activeKeyForPage('marktpreise')).toBe('marktpreise');
    expect(activeKeyForPage('prognose')).toBe('prognose');
    expect(activeKeyForPage('uebersicht')).toBeNull();
    expect(activeKeyForPage('mandanten')).toBeNull();
  });

  it('highlights a real sidebar entry for every mode-group item', () => {
    for (const group of anlageSidebar(ALLE).groups.slice(1)) {
      for (const item of group.items) {
        const key =
          item.target.kind === 'sub'
            ? activeAreaKey(item.target.sub)
            : item.target.kind === 'page'
              ? activeKeyForPage(item.target.page)
              : null;
        expect(key).toBe(item.key);
      }
    }
  });
});

describe('Marktpreise/Prognose are not a global main-nav group', () => {
  it('the main nav is just Übersicht + Meine Anlage(n)', () => {
    expect(MAIN_PAGES.map((p) => p.id)).toEqual(['uebersicht', 'anlagen']);
  });
});

describe('modeViewItems - the shared derivation for the sidebar group AND the container', () => {
  it('maps a mode’s deep views onto navigable entries, dropping base areas', () => {
    // Marktvermarktung: fahrplan/marktpreise/prognose become entries;
    // erloes-historie is a base area and contributes none.
    const markt = MARKT.modes.find((m) => m.kind === 'marktvermarktung');
    const items = modeViewItems(markt?.manifest.deepViews ?? []);
    expect(items.map((i) => i.key)).toEqual(['fahrplan', 'marktpreise', 'prognose']);
  });

  it('subtracts what the BASE surface already carries (Hotfix 2026-07-29)', () => {
    // Sonst behauptete der Modus-Container „wird verfügbar, sobald Sie den
    // Modus einschalten" über eine Ansicht, die längst in der Navigation steht.
    const markt = MARKT.modes.find((m) => m.kind === 'marktvermarktung');
    // Auf einer Speicher-Anlage mit Börsentarif trägt die BASIS inzwischen
    // alle drei Ansichten des Markt-Manifests - der Modus doppelt keine davon.
    expect(modeViewItems(markt?.manifest.deepViews ?? [], MARKT.base.deepViews)).toEqual([]);
    // Ohne Basis-Ansichten bleiben sie dem Modus (der Rückfall-Beweis).
    expect(modeViewItems(markt?.manifest.deepViews ?? [], []).map((i) => i.key)).toEqual([
      'fahrplan',
      'marktpreise',
      'prognose',
    ]);
  });

  it('is empty for a mode whose views are all base areas', () => {
    const eigen = PRIVAT.modes.find((m) => m.kind === 'eigenverbrauch');
    expect(modeViewItems(eigen?.manifest.deepViews ?? [])).toEqual([]);
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
