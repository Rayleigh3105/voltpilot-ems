/**
 * Portal v3 · M1 — the Anlage-scoped SHELL navigation.
 *
 * v3 gives an Anlage **one** navigation (`docs/portal-v3/M1-shell.md`): the
 * sidebar shows every area of the selected plant openly, grouped into
 * **Anlage** (Cockpit · Messwerte · [Erlöse] · Steuerung · Anlagen-Modell — the
 * former Live-Daten area merged INTO the cockpit, owner decision Option A, and
 * the former single „Historie" split into its two worlds, captain decision H1
 * 2026-07-30) plus
 * **one group per active mode profile** (`Modus · <Name>`, colour-tagged).
 * The v2 "Mehr ▾" popover and the retired U1 tab strip are gone; phones get a
 * bottom bar whose last slot opens a sheet with everything else — on the Anlage
 * level (`bottomBarSlots`/`moreSheetItems`) AND one level up
 * (`fleetBarSlots`/`fleetSheetGroups`, Mobil-Umbau Stufe 1), so the thumb
 * pattern survives leaving the plant and the phone needs no hamburger at all.
 *
 * Pure + deterministic (the `betriebsart.ts`/`surface.ts` precedent) — no
 * React, no network. The three laws it encodes:
 *
 * 1. **The base group is fixed and ordered.** The four areas are always there,
 *    always in the same order — plus „Erlöse", the ONE base-group entry whose
 *    presence follows the read-model (`erloes-historie` is mode-bound, its
 *    sibling `telemetrie-historie` is base). Placement is deliberate: the two
 *    Historie worlds are siblings, so a customer never hunts for the money world
 *    inside a mode group. Only Steuerung carries a badge (the active-mode
 *    count from the M0 read-model), and a 0/unknown count renders NO badge —
 *    never a discouraging "0". Since the Captain hotfix 2026-07-29 the group
 *    additionally carries the BASE deep views of the M0 read-model
 *    (`surface.base.deepViews`): **Fahrplan** right behind Steuerung on every
 *    plant with a storage, **Marktpreise** at the end on every plant with a
 *    spot tariff — both derived, never hardcoded, and reachable without a
 *    single active mode. See `baseSurface` for the why.
 * 2. **Mode groups are a PROJECTION, never a hardcoded list.** A group exists
 *    for every `activeModes(site)` entry whose manifest contributes at least
 *    one deep view that is not already a base area — so Prognosequalität exists
 *    exactly while the market mode is active, and a plain self-consumption
 *    plant never sees it.
 * 3. **Nothing is orphaned.** Every `AnlagenSub` is reachable from the sidebar,
 *    a mode group or the phone Mehr sheet; `anlageNav.test.ts` enforces it, so
 *    a new sub must be mounted somewhere or the test fails.
 *
 * Routes are untouched — every bookmark keeps working (`nav.ts` LEGACY
 * discipline).
 */
import type { IconName } from '../designsystem/components/core/Icon';
import { PLATFORM_GROUPS, type AnlagenSub, type PageId } from './nav';
import type { ActiveMode, AnlageSurface, DeepViewId, ModeKind } from './surface';

/**
 * Where a nav entry leads. `sub: null` = the Anlage cockpit itself; `page` = a
 * top-level page (the market mode's Marktpreise/Prognosequalität, whose routes
 * predate the Anlage subpages); `help` opens the shell's Hilfe panel (there is
 * deliberately no invented support address — see `HELP_TEXT`); `more` opens the
 * phone sheet; `action` is a shell ACTION rather than a destination — the two
 * top-bar buttons that the phone moves into that sheet (Mobil-Umbau Stufe 1).
 */
export type NavTarget =
  | { kind: 'sub'; sub: AnlagenSub | null }
  | { kind: 'page'; page: PageId }
  | { kind: 'help' }
  | { kind: 'more' }
  | { kind: 'action'; action: 'add-anlage' | 'logout' };

/** The colour key of a mode group's dot; resolved to a token in Shell.css. */
export type ModeTone = 'markt' | 'peak' | 'eigen' | 'atyp' | 'laden' | 'automation';

/** One sidebar / bottom-bar / sheet entry. */
export interface SidebarItem {
  /** Stable key; also what `activeAreaKey` returns for the open route. */
  key: string;
  label: string;
  icon: IconName;
  target: NavTarget;
  /** Trailing count badge; null = none (Steuerung only, and only when > 0). */
  badge: number | null;
}

/** A labelled sidebar group: the fixed base group, or one active mode. */
export interface SidebarGroup {
  key: string;
  label: string;
  /** null = the base group (no colour dot); else the mode's tone. */
  tone: ModeTone | null;
  items: SidebarItem[];
}

/** The whole Anlage sidebar model: groups plus the foot (Einstellungen · Hilfe). */
export interface AnlageSidebar {
  groups: SidebarGroup[];
  foot: SidebarItem[];
}

/** The label of the always-present base group. */
export const BASE_GROUP_LABEL = 'Anlage';

/**
 * The Hilfe & Kontakt copy. There is no self-service support channel in this
 * platform (no SMTP, and "Vertrieb läuft persönlich" — captain decision, see
 * `moduleSurface.ts`), so the foot item states the honest truth instead of
 * linking a mailto nobody reads.
 */
export const HELP_TEXT =
  'Ihr VoltPilot-Team hilft Ihnen weiter. Wenden Sie sich an Ihren Ansprechpartner bei VoltPilot — ' +
  'auch wenn Sie Ihr Passwort zurücksetzen möchten oder ein Gerät sich nicht meldet.';

/**
 * The four base areas — fixed, ordered, always present (the former Live-Daten
 * area merged into the cockpit — Option A; `#/anlage/{id}/live` redirects
 * there) — PLUS the base deep views the M0 read-model derived for this plant.
 *
 * Placement is deliberate: **Fahrplan sits directly behind Steuerung** (it is
 * what the storage is going to do — the same neighbourhood a customer looks in
 * when they ask "what does VoltPilot do with my battery?"), and the two
 * top-level pages **Marktpreise · Prognosequalität close the group** (the
 * outliers that are not Anlage subpages). None is a loose special route: all
 * are regular entries of the Anlage group, so they also travel into the phone
 * „Mehr"-sheet on their own.
 */
function baseItems(
  badge: number | null,
  baseViews: readonly DeepViewId[],
  allViews: readonly DeepViewId[],
): SidebarItem[] {
  const items: SidebarItem[] = [
    { key: 'cockpit', label: 'Cockpit', icon: 'dashboard', target: { kind: 'sub', sub: null }, badge: null },
    // Die Messwerte-Welt ist Basis: sie existiert auf JEDER Anlage.
    { key: 'messwerte', label: 'Messwerte', icon: 'history', target: { kind: 'sub', sub: 'messwerte' }, badge: null },
  ];
  // Die Erlöse-Welt ist modusgebunden — sie erscheint genau dann, wenn die
  // Projektion `erloes-historie` beisteuert (`surface.ts`). Eine Privat-Anlage
  // ohne Geld-Modus bekommt gar keinen Eintrag statt einer leeren Fläche.
  if (allViews.includes('erloes-historie')) {
    items.push({
      key: 'erloese',
      label: 'Erlöse',
      icon: 'euro',
      target: { kind: 'sub', sub: 'erloese' },
      badge: null,
    });
  }
  items.push({
    key: 'steuerung',
    label: 'Steuerung',
    icon: 'zap',
    target: { kind: 'sub', sub: 'steuerung' },
    badge,
  });
  if (baseViews.includes('fahrplan')) items.push(viewItem('fahrplan'));
  items.push({
    key: 'anlagen-modell',
    label: 'Anlagen-Modell',
    icon: 'layers',
    // M6 built the three-column plant model behind this route.
    target: { kind: 'sub', sub: 'modell' },
    badge: null,
  });
  if (baseViews.includes('marktpreise')) items.push(viewItem('marktpreise'));
  if (baseViews.includes('prognosequalitaet')) items.push(viewItem('prognosequalitaet'));
  return items;
}

/**
 * Einstellungen · Hilfe & Kontakt — the sidebar foot.
 *
 * v3.1-M2 retired the standalone „Modus-Profile"-Regal: every mode is now a
 * CONTAINER opened from the Steuerung capsule, so the foot no longer carries a
 * `profile` entry. Steuerung remains the ONE door to the modes (base group).
 */
const HELP_ITEM: SidebarItem = {
  key: 'hilfe',
  label: 'Hilfe & Kontakt',
  icon: 'help-circle',
  target: { kind: 'help' },
  badge: null,
};

function footItems(): SidebarItem[] {
  return [
    // Der frühere Fuß-Eintrag „Verbraucher" ist mit dem Einheitsmodell
    // (Stufe 5a) ERSATZLOS entfallen: die Regeln eines Verbrauchers wohnen in
    // der Kapsel „Regeln" der Steuerung, das Gerät selbst im Anlagen-Modell.
    // Die Route bleibt als Weiterleitung erhalten (`nav.ts` LEGACY_SUBS).
    { key: 'technik', label: 'Einstellungen', icon: 'settings', target: { kind: 'sub', sub: 'technik' }, badge: null },
    HELP_ITEM,
  ];
}

/**
 * Which deep views become their OWN nav entry — ONE definition, used by the
 * base group AND the mode groups, so a view carries the same label/icon/target
 * wherever it is mounted. Everything else a manifest lists is already an area
 * of its own (`live`, `geraete`, `telemetrie-historie`, `erloes-historie`,
 * `flow-editor`) or deliberately has no nav entry any more (`wetter` becomes a
 * cockpit card + drill-in in M2; its route stays and the phone sheet keeps it
 * reachable).
 *
 * OPEN(O2, BUILD.md §8) is CLOSED: the owner decided on 2026-07-29 that every
 * plant with a storage carries the Fahrplan as a BASE entry — the derivation
 * lives in `baseSurface`, this map only says how the entry looks.
 */
const VIEW_ITEMS: Partial<Record<DeepViewId, Omit<SidebarItem, 'badge'>>> = {
  fahrplan: { key: 'fahrplan', label: 'Fahrplan', icon: 'calendar', target: { kind: 'sub', sub: 'fahrplan' } },
  marktpreise: {
    key: 'marktpreise',
    label: 'Marktpreise',
    icon: 'euro',
    target: { kind: 'page', page: 'marktpreise' },
  },
  prognosequalitaet: {
    key: 'prognose',
    label: 'Prognosequalität',
    icon: 'trending-up',
    target: { kind: 'page', page: 'prognose' },
  },
  lastspitzen: {
    key: 'lastspitzen',
    label: 'Lastspitzen',
    icon: 'trending-up',
    target: { kind: 'sub', sub: 'lastspitzen' },
  },
  ladevorgaenge: {
    key: 'ladevorgaenge',
    label: 'Ladevorgänge',
    icon: 'zap',
    target: { kind: 'sub', sub: 'ladevorgaenge' },
  },
};

/** The deep view that has no nav entry but must stay reachable (phone sheet). */
const SHEET_ONLY_ITEMS: SidebarItem[] = [
  { key: 'wetter', label: 'Wetter', icon: 'sun', target: { kind: 'sub', sub: 'wetter' }, badge: null },
  // Die BEFEHLE-Seite gehört einer KOMPONENTE (Kommando-Transparenz V1, F2):
  // ihre Einstiege sind die Komponenten-Karte und die Steuerung, wo die
  // Komponente schon feststeht. Ein Seitenleisten-Eintrag hätte keine - und
  // orphan darf sie trotzdem nicht sein, also trägt das Blatt sie (die
  // `wetter`-Disziplin). Ohne Komponente zeigt sie die ganze Anlage.
  {
    key: 'befehle',
    label: 'Befehle an Geräte',
    icon: 'shield',
    target: { kind: 'sub', sub: 'befehle' },
    badge: null,
  },
];

const MODE_TONES: Record<ModeKind, ModeTone> = {
  // Der Ladepark trägt den Verbraucher-Ton des Hauses: Ladepunkte sind die
  // Verbraucher-Rolle (Mockups §2 Entscheidung 3, Violett `--vp-flow-load`).
  lastmanagement: 'laden',
  marktvermarktung: 'markt',
  lastspitzenkappung: 'peak',
  'atypische-netznutzung': 'atyp',
  automation: 'automation',
};

function viewItem(view: DeepViewId): SidebarItem {
  // Nur mit einer Definition aufgerufen (die Aufrufer prüfen vorher).
  return { ...(VIEW_ITEMS[view] as Omit<SidebarItem, 'badge'>), badge: null };
}

/**
 * The navigable sidebar entries a set of deep views contributes — the mode
 * group's items, and the SAME list the v3.1-M2 „Modus-Container" renders as its
 * „Ansichten dieses Modus" section. Only deep views that become their OWN nav
 * entry appear (see `VIEW_ITEMS`); base areas contribute none.
 *
 * `baseViews` (the M0 `surface.base.deepViews`) is subtracted: a view the base
 * group already carries must not appear a second time under a mode — and the
 * container must not claim it "becomes available once you switch the mode on"
 * when it is reachable right now. Omitted = nothing subtracted (the pre-hotfix
 * behaviour).
 */
export function modeViewItems(
  deepViews: readonly DeepViewId[],
  baseViews: readonly DeepViewId[] = [],
): SidebarItem[] {
  const items: SidebarItem[] = [];
  for (const view of deepViews) {
    if (baseViews.includes(view)) continue;
    if (VIEW_ITEMS[view]) items.push(viewItem(view));
  }
  return items;
}

function modeGroup(
  mode: ActiveMode,
  taken: Set<string>,
  baseViews: readonly DeepViewId[],
): SidebarGroup | null {
  const items: SidebarItem[] = [];
  for (const item of modeViewItems(mode.manifest.deepViews, baseViews)) {
    if (taken.has(item.key)) continue;
    taken.add(item.key);
    items.push(item);
  }
  if (items.length === 0) return null;
  return {
    key: `mode:${mode.key}`,
    // M3 gives the customer-facing profile its own name; until then the group
    // carries the mode label straight from the M0 read-model.
    label: `Modus · ${mode.label}`,
    tone: MODE_TONES[mode.kind],
    items,
  };
}

/**
 * The grouped Anlage sidebar: the fixed base group plus one group per active
 * mode that contributes a view of its own. `activeModeCount` badges Steuerung
 * (defaults to the surface's own mode count); 0/null/NaN renders no badge.
 */
export function anlageSidebar(
  surface: AnlageSurface | null | undefined,
  activeModeCount?: number | null,
): AnlageSidebar {
  const raw = activeModeCount === undefined ? surface?.modes.length ?? null : activeModeCount;
  const badge =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;

  const baseViews = surface?.base?.deepViews ?? [];
  const allViews = surface?.deepViews ?? [];
  const groups: SidebarGroup[] = [
    {
      key: 'base',
      label: BASE_GROUP_LABEL,
      tone: null,
      items: baseItems(badge, baseViews, allViews),
    },
  ];
  // Was die Basis schon trägt, taucht unter keinem Modus ein zweites Mal auf.
  const taken = new Set<string>(groups[0].items.map((i) => i.key));
  for (const mode of surface?.modes ?? []) {
    const group = modeGroup(mode, taken, baseViews);
    if (group) groups.push(group);
  }
  return { groups, foot: footItems() };
}

/**
 * The order in which the phone bar hands out its four slots — the Mobil-Umbau
 * Stufe 1 re-belegung (concept `data/vp-mobile-views-x1`, Captain-Go
 * 09.08.2026). **The bar carries the DAILY questions**: „Was ist jetzt?"
 * (Cockpit) · „Was macht die Batterie heute?" (Fahrplan) · „Was war?"
 * (Messwerte) · „Was verdiene ich?" (Erlöse). Steuerung and Anlagen-Modell are
 * setup/trust surfaces — important, but not daily — so they follow in the list
 * and normally travel in the Mehr sheet.
 *
 * **The belegung stays DERIVED, never hard.** Fahrplan exists only on a plant
 * with a storage, Erlöse only with a money mode (`surface.ts`), so a plant
 * without either automatically moves Steuerung/Anlagen-Modell up — no empty
 * slot, and no special case in the shell.
 *
 * The lookup spans BASE *and* mode groups on purpose: on a DV park without a
 * storage the Fahrplan is a mode entry, and it deserves its slot wherever it
 * is mounted.
 */
const BOTTOM_PRIORITY = [
  'cockpit',
  'fahrplan',
  'messwerte',
  'erloese',
  'steuerung',
  'anlagen-modell',
] as const;

/** Four areas plus „Mehr" — the fifth tile is always the sheet. */
const BOTTOM_SLOTS = 4;

/** Shorter phone labels; the sidebar keeps the full words. */
const BOTTOM_LABELS: Record<string, string> = {
  cockpit: 'Cockpit',
  fahrplan: 'Fahrplan',
  messwerte: 'Messwerte',
  erloese: 'Erlöse',
  steuerung: 'Steuerung',
  'anlagen-modell': 'Anlage',
};

const MORE_ITEM: SidebarItem = {
  key: 'more',
  label: 'Mehr',
  icon: 'more-horizontal',
  target: { kind: 'more' },
  badge: null,
};

/** Every navigable entry of the Anlage nav — base group AND mode groups. */
function navItems(sidebar: AnlageSidebar): SidebarItem[] {
  return sidebar.groups.flatMap((g) => g.items);
}

/**
 * Which keys the bar really carries — ONE derivation, read by the bar AND by
 * the sheet, so the two can never claim the same entry (or drop one).
 */
function bottomKeys(sidebar: AnlageSidebar): string[] {
  const present = new Set(navItems(sidebar).map((i) => i.key));
  return BOTTOM_PRIORITY.filter((k) => present.has(k)).slice(0, BOTTOM_SLOTS);
}

/**
 * The phone bottom bar of one Anlage: up to four derived areas plus the Mehr
 * sheet. The daily areas are always one thumb away; nothing hides behind a
 * hamburger (the phone has none since Stufe 1).
 */
export function bottomBarSlots(sidebar: AnlageSidebar): SidebarItem[] {
  const items = navItems(sidebar);
  const keys = bottomKeys(sidebar);
  const slots = keys
    .map((key) => items.find((i) => i.key === key))
    .filter((i): i is SidebarItem => i != null)
    .map((i) => ({ ...i, label: BOTTOM_LABELS[i.key] ?? i.label }));
  // Falls die Steuerung ins Blatt fällt, wandert ihr Abzeichen sichtbar auf
  // „Mehr" — sonst verschwände der einzige Hinweis auf Handlungsbedarf hinter
  // einer geschlossenen Klappe.
  const hidden = keys.includes('steuerung')
    ? null
    : items.find((i) => i.key === 'steuerung') ?? null;
  slots.push({ ...MORE_ITEM, badge: hidden?.badge ?? null });
  return slots;
}

/** What travels into the sheet BESIDES the areas of the current level. */
export interface ShellExtras {
  /** Portal-Admin: the Plattform group travels into the sheet (no hamburger). */
  isAdmin?: boolean;
  /** The single-Anlage customer's „＋ Anlage hinzufügen" (a top-bar button on
   *  wider screens, a sheet entry on the phone). */
  showAddAnlage?: boolean;
}

function accountItems(extras: ShellExtras): SidebarItem[] {
  const items: SidebarItem[] = [];
  if (extras.showAddAnlage) {
    items.push({
      key: 'add-anlage',
      label: 'Anlage hinzufügen',
      icon: 'plus',
      target: { kind: 'action', action: 'add-anlage' },
      badge: null,
    });
  }
  items.push({
    key: 'logout',
    label: 'Abmelden',
    icon: 'log-out',
    target: { kind: 'action', action: 'logout' },
    badge: null,
  });
  return items;
}

/**
 * Die Plattform-Gruppen als Blatt-Einträge — eine PROJEKTION von
 * `PLATFORM_GROUPS`, damit die Faltung am Telefon dieselbe Ordnung zeigt wie
 * die Seitenleiste (Admin-Umbau Stufe 1). Die LANDUNG trägt dabei das
 * „Plattform"-Label, jede weitere Gruppe ihr eigenes — im Blatt gibt es keine
 * zweite Ebene, also wäre eine Überschrift ohne Einträge nur Lärm.
 */
function platformGroups(): SidebarGroup[] {
  return PLATFORM_GROUPS.map((group) => ({
    key: `plattform-${group.key}`,
    label: group.label ?? 'Plattform',
    tone: null,
    items: group.pages.map((p) => ({
      key: p.id,
      label: p.label,
      icon: p.icon,
      target: { kind: 'page', page: p.id } as NavTarget,
      badge: null,
    })),
  }));
}

/**
 * The "Mehr" sheet of one Anlage: everything the bottom bar does not carry,
 * grouped and colour-tagged exactly like the sidebar — the base remainder, the
 * mode remainder, the Plattform group for an operator, and a trailing group
 * with the entries that have no sidebar home (Wetter), the foot
 * (Einstellungen · Hilfe & Kontakt) and the two top-bar actions the phone
 * folds in here (＋ Anlage · Abmelden).
 */
export function moreSheetItems(
  sidebar: AnlageSidebar,
  extras: ShellExtras = {},
): SidebarGroup[] {
  const inBottom = new Set(bottomKeys(sidebar));
  const groups: SidebarGroup[] = [];
  const [base, ...modes] = sidebar.groups;
  const rest = (base?.items ?? []).filter((i) => !inBottom.has(i.key));
  if (rest.length > 0) groups.push({ key: 'base', label: BASE_GROUP_LABEL, tone: null, items: rest });
  for (const mode of modes) {
    const items = mode.items.filter((i) => !inBottom.has(i.key));
    if (items.length > 0) groups.push({ ...mode, items });
  }
  if (extras.isAdmin) groups.push(...platformGroups());
  groups.push({
    key: 'mehr',
    label: 'Mehr',
    tone: null,
    items: [...SHEET_ONLY_ITEMS, ...sidebar.foot, ...accountItems(extras)],
  });
  return groups;
}

/**
 * What the FLEET level (no single Anlage in scope) offers — the same bar
 * mechanics one level up (concept §3: „dieselbe Bar auf Flotten-Ebene"), so the
 * thumb pattern survives the level change instead of falling back to a
 * hamburger.
 */
export interface FleetNavInput {
  /** Betreiber frame: the Portfolio landing replaces „Übersicht" (U5). */
  showPortfolio: boolean;
  /** Only when at least one Anlage has a money mode (PR G). */
  showPortfolioErloese: boolean;
  /** Fleet customers + admins; a single-Anlage endkunde has no Übersicht. */
  showOverview: boolean;
  /** Drives singular/plural of the Anlagen slot; null = not loaded yet. */
  siteCount: number | null;
}

/** The visible top-level entries, in the order the bar hands out its slots. */
function fleetItems(input: FleetNavInput): SidebarItem[] {
  const entry = (page: PageId, label: string, icon: IconName): SidebarItem => ({
    key: page,
    label,
    icon,
    target: { kind: 'page', page },
    badge: null,
  });
  const items: SidebarItem[] = [];
  if (input.showPortfolio) items.push(entry('portfolio', 'Portfolio', 'building'));
  if (input.showOverview) items.push(entry('uebersicht', 'Übersicht', 'dashboard'));
  items.push(
    entry('anlagen', input.siteCount != null && input.siteCount > 1 ? 'Anlagen' : 'Anlage', 'sun'),
  );
  if (input.showPortfolio) {
    items.push(entry('portfolio-messwerte', 'Messwerte', 'activity'));
    if (input.showPortfolioErloese) items.push(entry('portfolio-erloese', 'Erlöse', 'euro'));
  }
  return items;
}

/** The phone bottom bar one level up: Übersicht · Anlagen · Mehr (derived). */
export function fleetBarSlots(input: FleetNavInput): SidebarItem[] {
  return [...fleetItems(input).slice(0, BOTTOM_SLOTS), MORE_ITEM];
}

/** The fleet-level „Mehr" sheet — the complement of `fleetBarSlots`. */
export function fleetSheetGroups(
  input: FleetNavInput,
  extras: ShellExtras = {},
): SidebarGroup[] {
  const groups: SidebarGroup[] = [];
  const rest = fleetItems(input).slice(BOTTOM_SLOTS);
  if (rest.length > 0) {
    groups.push({ key: 'ebene', label: 'Alle Anlagen', tone: null, items: rest });
  }
  if (extras.isAdmin) groups.push(...platformGroups());
  groups.push({
    key: 'mehr',
    label: 'Mehr',
    tone: null,
    items: [HELP_ITEM, ...accountItems(extras)],
  });
  return groups;
}

/**
 * Which nav entry the open route highlights. ONE rule, decided here and never
 * spread into `AppShell`: the cockpit is `cockpit`, the Anlagen-Modell route
 * (`modell`) carries its own nav key, everything else highlights the entry with
 * its own sub key — deep views are real sidebar entries now, so (unlike v2)
 * none of them leaves the navigation unhighlighted.
 */
export function activeAreaKey(sub: AnlagenSub | null): string {
  if (sub == null) return 'cockpit';
  if (sub === 'modell') return 'anlagen-modell';
  // Die GERÄTE-DETAILSEITE ist eine Ebene UNTER dem Anlagen-Modell (sie braucht
  // eine Geräte-Referenz, hat also keinen eigenen Navigationspunkt und kann
  // auch keinen haben). Sie hebt deshalb ihren Wirt hervor - sonst stünde die
  // Navigation ohne Markierung da, während der Kunde offensichtlich IN der
  // Zentrale ist (die `GERAETE_BEREICH`-Disziplin der Plattform-Tabs).
  if (sub === 'geraet') return 'anlagen-modell';
  return sub;
}

/**
 * The highlighted entry while a mode PAGE is open (Marktpreise /
 * Prognosequalität keep the Anlage nav — they are that Anlage's market-mode
 * deep views). Any other page is outside the Anlage nav.
 */
export function activeKeyForPage(page: PageId): string | null {
  if (page === 'marktpreise') return 'marktpreise';
  if (page === 'prognose') return 'prognose';
  return null;
}

/**
 * The Anlage a route addresses: the requested site, else the single Anlage of
 * a one-Anlage customer, else null (the fleet list). Shared by `AnlagenPage`
 * (which renders it) and `App.tsx` (which builds the shell nav for it) so the
 * two can never disagree about which Anlage the shell is scoped to.
 */
export function resolveAnlage<T extends { id: string }>(
  sites: T[],
  siteId: string | null,
): T | null {
  const requested = siteId ? sites.find((s) => s.id === siteId) ?? null : null;
  if (requested) return requested;
  return sites.length === 1 ? sites[0] : null;
}
