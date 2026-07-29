/**
 * Portal v3 · M1 — the Anlage-scoped SHELL navigation.
 *
 * v3 gives an Anlage **one** navigation (`docs/portal-v3/M1-shell.md`): the
 * sidebar shows every area of the selected plant openly, grouped into
 * **Anlage** (Cockpit · Historie · Steuerung · Anlagen-Modell — the former
 * Live-Daten area merged INTO the cockpit, owner decision Option A) plus
 * **one group per active mode profile** (`Modus · <Name>`, colour-tagged).
 * The v2 "Mehr ▾" popover and the retired U1 tab strip are gone; phones get a
 * 5-slot bottom bar whose last slot opens a sheet with everything else.
 *
 * Pure + deterministic (the `betriebsart.ts`/`surface.ts` precedent) — no
 * React, no network. The three laws it encodes:
 *
 * 1. **The base group is fixed and ordered.** The four areas are always there,
 *    always in the same order. Only Steuerung carries a badge (the active-mode
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
import type { AnlagenSub, PageId } from './nav';
import type { ActiveMode, AnlageSurface, DeepViewId, ModeKind } from './surface';

/**
 * Where a nav entry leads. `sub: null` = the Anlage cockpit itself; `page` = a
 * top-level page (the market mode's Marktpreise/Prognosequalität, whose routes
 * predate the Anlage subpages); `help` opens the shell's Hilfe panel (there is
 * deliberately no invented support address — see `HELP_TEXT`); `more` opens the
 * phone sheet.
 */
export type NavTarget =
  | { kind: 'sub'; sub: AnlagenSub | null }
  | { kind: 'page'; page: PageId }
  | { kind: 'help' }
  | { kind: 'more' };

/** The colour key of a mode group's dot; resolved to a token in Shell.css. */
export type ModeTone = 'markt' | 'peak' | 'eigen' | 'atyp' | 'automation';

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
function baseItems(badge: number | null, baseViews: readonly DeepViewId[]): SidebarItem[] {
  const items: SidebarItem[] = [
    { key: 'cockpit', label: 'Cockpit', icon: 'dashboard', target: { kind: 'sub', sub: null }, badge: null },
    { key: 'historie', label: 'Historie', icon: 'history', target: { kind: 'sub', sub: 'historie' }, badge: null },
    { key: 'steuerung', label: 'Steuerung', icon: 'zap', target: { kind: 'sub', sub: 'steuerung' }, badge },
  ];
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
function footItems(): SidebarItem[] {
  return [
    { key: 'technik', label: 'Einstellungen', icon: 'settings', target: { kind: 'sub', sub: 'technik' }, badge: null },
    { key: 'hilfe', label: 'Hilfe & Kontakt', icon: 'help-circle', target: { kind: 'help' }, badge: null },
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
};

/** The deep view that has no nav entry but must stay reachable (phone sheet). */
const SHEET_ONLY_ITEMS: SidebarItem[] = [
  { key: 'wetter', label: 'Wetter', icon: 'sun', target: { kind: 'sub', sub: 'wetter' }, badge: null },
];

const MODE_TONES: Record<ModeKind, ModeTone> = {
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
  const groups: SidebarGroup[] = [
    { key: 'base', label: BASE_GROUP_LABEL, tone: null, items: baseItems(badge, baseViews) },
  ];
  // Was die Basis schon trägt, taucht unter keinem Modus ein zweites Mal auf.
  const taken = new Set<string>(groups[0].items.map((i) => i.key));
  for (const mode of surface?.modes ?? []) {
    const group = modeGroup(mode, taken, baseViews);
    if (group) groups.push(group);
  }
  return { groups, foot: footItems() };
}

/** The bottom-bar keys, in order — the four core areas plus the Mehr sheet.
 *  Owner Q3: Historie takes the slot the Live-Daten merge freed (every
 *  „Verlauf →" jump lands there — one thumb away). */
const BOTTOM_KEYS = ['cockpit', 'historie', 'steuerung', 'anlagen-modell'] as const;

/** Shorter phone labels; the sidebar keeps the full words. */
const BOTTOM_LABELS: Record<string, string> = {
  cockpit: 'Cockpit',
  historie: 'Historie',
  steuerung: 'Steuerung',
  'anlagen-modell': 'Anlage',
};

/**
 * The phone bottom bar: EXACTLY five slots —
 * Cockpit · Historie · Steuerung · Anlage · Mehr. The core areas are always
 * one thumb away; nothing hides behind a hamburger.
 */
export function bottomBarSlots(sidebar: AnlageSidebar): SidebarItem[] {
  const base = sidebar.groups[0]?.items ?? [];
  const slots = BOTTOM_KEYS.map((key) => {
    const item = base.find((i) => i.key === key);
    return item ? { ...item, label: BOTTOM_LABELS[key] ?? item.label } : null;
  }).filter((i): i is SidebarItem => i != null);
  slots.push({ key: 'more', label: 'Mehr', icon: 'more-horizontal', target: { kind: 'more' }, badge: null });
  return slots;
}

/**
 * The "Mehr" sheet: everything the bottom bar does not carry, grouped and
 * colour-tagged exactly like the sidebar — the base remainder (the bar carries
 * the four fixed areas, so this is exactly the derived base views: Fahrplan and
 * Marktpreise), the mode groups, and a trailing group with the entries that
 * have no sidebar home (Wetter) plus the foot (Einstellungen · Hilfe & Kontakt).
 */
export function moreSheetItems(sidebar: AnlageSidebar): SidebarGroup[] {
  const inBottom = new Set<string>(BOTTOM_KEYS);
  const groups: SidebarGroup[] = [];
  const [base, ...modes] = sidebar.groups;
  const rest = (base?.items ?? []).filter((i) => !inBottom.has(i.key));
  if (rest.length > 0) groups.push({ key: 'base', label: BASE_GROUP_LABEL, tone: null, items: rest });
  groups.push(...modes);
  groups.push({
    key: 'mehr',
    label: 'Mehr',
    tone: null,
    items: [...SHEET_ONLY_ITEMS, ...sidebar.foot],
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
