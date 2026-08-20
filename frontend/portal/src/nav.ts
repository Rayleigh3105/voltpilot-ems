/**
 * Page registry + tiny hash router for the unified dashboard shell.
 * Keycloak's redirect response lands in the query string (auth.ts sets
 * responseMode 'query'), so the hash stays free for navigation and survives
 * the login round-trip.
 *
 * IA (captain decision 2026-07-07, "Anlagen-Seite"; evolved by M1 #529): the
 * customer nav is Übersicht / Meine Anlage(n) plus, per SELECTED Anlage, the
 * shell trio Übersicht · Steuerung · Geräte (`anlageNav.ts`) and — only while
 * the market mode is active — the mode-tagged Marktpreise/Prognosequalität
 * group. ONE site = ONE Anlage; everything that used to be its own menu item
 * (Standorte,
 * Geräte, Live-Daten, Fahrplan, Wetter, Historie) lives ON the Anlagen-Seite
 * (`#/anlage/{siteId}`) or as one of its subpages
 * (`#/anlage/{siteId}/fahrplan|historie|wetter|…`). The old hashes keep
 * working as redirects so bookmarks never break.
 */
import type { IconName } from '../designsystem/components/core/Icon';

export type PageId =
  | 'portfolio'
  | 'portfolio-messwerte'
  | 'portfolio-erloese'
  | 'uebersicht'
  | 'anlagen'
  | 'marktpreise'
  | 'prognose'
  | 'plattform-uebersicht'
  | 'mandanten'
  | 'geraete-registry'
  | 'edge-updates'
  | 'optimizer'
  | 'vorlagen'
  | 'komponenten-flotte'
  | 'steuerungs-freigabe'
  | 'flows';

/** Subpages of one Anlage (the deep views behind the Anlagen-Seite). */
export type AnlagenSub =
  | 'fahrplan'
  | 'messwerte'
  | 'erloese'
  | 'wetter'
  | 'technik'
  | 'modell'
  | 'steuerung'
  | 'lastspitzen'
  | 'ladevorgaenge'
  | 'befehle'
  | 'geraet';

const SUBS = new Set<string>([
  'fahrplan', 'messwerte', 'erloese', 'wetter', 'technik', 'modell',
  'steuerung', 'lastspitzen', 'ladevorgaenge', 'befehle', 'geraet',
]);

/**
 * Retired subpage hashes that redirect so bookmarks never break (the
 * LEGACY_ROUTES discipline, at the sub level):
 * - `optimierung` -> `steuerung` (U3: "Optimierung" merged into Steuerung).
 * - `entitaeten` -> `modell` (Portal v3 M6: the "Geräte & Entitäten" list
 *   became the Anlagen-Modell — Gerät/Komponente/Messwert).
 * - `profile` -> `steuerung` (v3.1-M2: the standalone Modus-Profile shelf became
 *   the per-mode container opened from the Steuerung capsule).
 * - `live` -> the cockpit itself (`null`) — the Cockpit + Live-Daten merge
 *   (Option A): the Komponenten-Board and the compact Verlauf chart live ON
 *   the Anlagen-Startseite now, so `#/anlage/{id}/live` lands there.
 * - `verbraucher` -> `steuerung` (Einheitsmodell Stufe 5a): die eigene
 *   Verbraucher-Seite ist aufgelöst - ihre REGELN wohnen in der Kapsel
 *   „Regeln" der Steuerung, ihre GERÄTE im Anlagen-Modell. Der Deep-Link
 *   `?verbraucher=`/`?vorlage=` reist über `canonicalAnlageHash` mit, also
 *   öffnet ein altes Lesezeichen weiterhin genau seinen Regelbaukasten.
 * - `historie` -> `messwerte` (Historie = zwei Welten, Captain-Struktur H1):
 *   die eine Historie-Seite wurde zu `messwerte` + `erloese`. Die Basis-Welt
 *   erbt die Route, und `canonicalAnlageHash` schreibt die Adresse UNTER
 *   BEIBEHALTUNG der Parameter (`?m=`, `z=`, `at=`) um — jeder Deep-Link und
 *   jedes Lesezeichen bleibt gültig.
 */
const LEGACY_SUBS: Record<string, AnlagenSub | null> = {
  optimierung: 'steuerung',
  entitaeten: 'modell',
  profile: 'steuerung',
  live: null,
  historie: 'messwerte',
  verbraucher: 'steuerung',
};

/**
 * One navigation state. `siteId`/`sub` only carry meaning for page 'anlagen':
 * siteId null = the "Meine Anlage(n)" entry (single-Anlage customers land on
 * their Anlage, fleets on the list); sub non-null = a subpage of that Anlage.
 * A legacy deep link like `#/fahrplan` parses to siteId null + sub 'fahrplan'
 * - the Anlagen page resolves it to the single Anlage or falls back to the
 * list when the customer has several.
 */
export interface Route {
  page: PageId;
  siteId: string | null;
  sub: AnlagenSub | null;
  /**
   * Nur bei `sub === 'geraet'` gesetzt: WELCHES Gerät die Adresse nennt
   * (Anlagen-Zentrale Stufe 1). Absent bei jeder anderen Route - `toEqual`
   * ignoriert ein `undefined`-Feld, also bleibt jede bestehende
   * Routen-Zusicherung unverändert gültig.
   */
  geraet?: GeraetTarget;
}

/**
 * Das Ziel einer Geräte-Detailseite: die REFERENZ der VoltPilot-Box, dahinter
 * optional die Kennung eines Geräts AN ihr (`inverter` = das Hauptgerät,
 * `src-…` = eine gemeldete Quelle, `cp-…` = eine OCPP-Säule).
 *
 * **Der Schlüssel ist die Referenz, nicht die Geräte-UUID** - sie überlebt
 * Unclaim/Re-Claim (der dokumentierte Identitäts-Drift), also überlebt auch
 * jedes Lesezeichen darauf (die `geraetHash`-Disziplin).
 */
export interface GeraetTarget {
  ref: string;
  geraetId: string | null;
}

export interface PageDef {
  id: PageId;
  label: string;
  /** Icon name in the design-system Icon set (designsystem/components/core/Icon). */
  icon: IconName;
  /** Only visible/reachable for Portal-Admins (the "Plattform" nav group). */
  adminOnly?: boolean;
}

export const MAIN_PAGES: PageDef[] = [
  { id: 'uebersicht', label: 'Übersicht', icon: 'dashboard' },
  { id: 'anlagen', label: 'Meine Anlage', icon: 'sun' },
];

/**
 * M1 (Projektion #529, captain feedback round 1): Marktpreise and
 * Prognosequalität are NOT a global "Markt & Wissen" menu group any more -
 * they are the MARKET mode's deep views and render as a mode-tagged sidebar
 * group only while that mode is active (`anlageNav.modeNavGroup`, driven by
 * the M0 `deepViews(...)`). Trading knowledge on a site that does not trade is
 * noise at best. The PAGES and their routes are untouched, so every existing
 * `#/marktpreise` / `#/prognose` bookmark keeps working.
 */
export const MODE_PAGES: PageDef[] = [
  { id: 'marktpreise', label: 'Marktpreise', icon: 'euro' },
  { id: 'prognose', label: 'Prognosequalität', icon: 'trending-up' },
];

/**
 * The Betreiber PORTFOLIO landing (U5): NOT in MAIN_PAGES because it renders
 * ONLY for a betreiber frame, IN PLACE of "Übersicht" (the shell decides, see
 * betriebsart.ts). The shell hoists it to the top of the sidebar when
 * `showPortfolioNav` is true; a non-betreiber landing on `#/portfolio` is
 * redirected away (App.tsx).
 */
export const PORTFOLIO_PAGE: PageDef = { id: 'portfolio', label: 'Portfolio', icon: 'building' };

/**
 * Die zwei Welten der Historie EINE EBENE HÖHER (PR G des Historie-Konzepts,
 * §4.3 Betreiber-Schale): `#/portfolio/messwerte` · `#/portfolio/erloese`.
 * Sie hängen an derselben Bedingung wie die Portfolio-Landung (Betreiber-Rahmen)
 * und stehen in der Schale als eigene Gruppe unter „Portfolio"; die Erlöse-Welt
 * erscheint nur, wenn mindestens eine Anlage einen Geld-Modus hat
 * (`portfolioHistorie.hatGeldWelt`) — sonst gibt es dort nichts zu erzählen.
 *
 * Die Adresse ist bewusst ZWEISTUFIG (`portfolio/…`), damit sie sagt, auf
 * welcher Ebene man steht; die `PageId` bleibt flach, damit der Router
 * unverändert eine Seite je Id kennt.
 */
export const PORTFOLIO_WELT_PAGES: PageDef[] = [
  { id: 'portfolio-messwerte', label: 'Messwerte', icon: 'activity' },
  { id: 'portfolio-erloese', label: 'Erlöse', icon: 'euro' },
];

/** Ist das eine Seite der Portfolio-Ebene (Landung oder eine ihrer Welten)? */
export function isPortfolioPage(page: PageId): boolean {
  return page === 'portfolio' || PORTFOLIO_WELT_PAGES.some((p) => p.id === page);
}

/**
 * Eine benannte Gruppe der Plattform-Navigation (Admin-Umbau Stufe 1
 * „Ordnung", Konzept `vp-admin-neu-konzept-a9` §3.1, Captain-Entscheid F1).
 *
 * Die Plattform-Gruppe war auf ELF flache Punkte gewachsen, weil jede
 * Ausbaustufe einen Punkt ANGEHÄNGT statt eingeordnet hat - die Reihenfolge
 * erzählte die Baugeschichte statt der Arbeit. Die Gruppen leiten sich aus den
 * belegten Abläufen ab (§2), nicht aus der Datenmodell-Nachbarschaft.
 *
 * `label: null` heißt „führt die Gruppe an, ohne eigene Überschrift" - das ist
 * die LANDUNG (Plattform-Übersicht), die schon unter dem „Plattform"-Label der
 * Schale steht und keine zweite Zeile über sich braucht.
 */
export interface PlatformGroup {
  key: string;
  label: string | null;
  pages: PageDef[];
}

/**
 * Die Plattform-Navigation, gruppiert nach dem, was ein Betreiber TUT.
 *
 * Sie führt mit der **Plattform-Übersicht** - dem Flotten-Puls über ALLE
 * Mandanten (Captain-Entscheid Q1: ein eigener Nav-Punkt, die Mandanten-Seite
 * bleibt reine Verwaltung) und seit Stufe 1 auch die LANDUNG eines
 * Admin-Boots. Darunter vier Gruppen: die Flotte betreiben · eine Anlage tief
 * diagnostizieren · den Katalog pflegen · Kunden verwalten.
 *
 * **Zwei Punkte stehen hier bewusst schon an ihrem KÜNFTIGEN Platz, obwohl sie
 * eigene Nav-Punkte bleiben:** „Edge-Updates" neben „Geräte" (in Stufe 3 wird
 * es dessen zweiter Tab) und „Gerätetypen" neben „Steuerungs-Freigabe" (in
 * Stufe 3 wird es dessen dritte Sektion). Damit ist Stufe 3 ein reines
 * Entfernen dieser zwei Einträge und kein zweites Umsortieren.
 *
 * **Icons sind entdoppelt** (§1.5 B2): innerhalb dieser Liste trägt jeder Punkt
 * ein eigenes Icon - wer die Leiste scannt, konnte vorher vier Punkte nicht
 * unterscheiden (`settings` zweimal, `cpu` zweimal).
 */
export const PLATFORM_GROUPS: PlatformGroup[] = [
  {
    key: 'landing',
    label: null,
    pages: [
      {
        id: 'plattform-uebersicht',
        label: 'Plattform-Übersicht',
        icon: 'dashboard',
        adminOnly: true,
      },
    ],
  },
  {
    key: 'flotte',
    label: 'Flotte',
    pages: [
      // E4: „Geräte", nicht mehr „Geräte-Registry" - die Seite ist seit dem
      // Konsolidierungs-Umbau das INVENTAR über den ganzen Lebenszyklus, nicht
      // mehr nur die Manufacturing-Registry (die echte Flotte kam dort gar
      // nicht vor). Die Id bleibt, damit jedes Lesezeichen und jeder Deep-Link
      // gilt.
      // Seit Stufe 3 „Zusammenwachsen" ist das EIN Bereich mit zwei Tabs
      // (`GERAETE_BEREICH`): Inventar + Updates. Der Nav-Punkt ist einer, die
      // zwei Routen bleiben beide gültig.
      { id: 'geraete-registry', label: 'Geräte', icon: 'cpu', adminOnly: true },
      // Das PLATTFORM-Gedaechtnis der Steuerungs-Freigabe: ein Modell wird
      // EINMAL am Pruefstand freigegeben, jede Anlage wird einzeln
      // scharfgeschaltet. Seit Stufe 3 wohnen die steuerbaren GERÄTETYPEN als
      // dritte Sektion hier - dieselbe Frage („was dürfen wir steuern?"), nur
      // für die andere Geräteklasse.
      { id: 'steuerungs-freigabe', label: 'Steuerungs-Freigabe', icon: 'shield', adminOnly: true },
    ],
  },
  {
    key: 'anlagen-werkzeuge',
    label: 'Anlagen-Werkzeuge',
    pages: [
      { id: 'optimizer', label: 'Optimizer', icon: 'settings', adminOnly: true },
      { id: 'flows', label: 'Flows', icon: 'zap', adminOnly: true },
    ],
  },
  {
    key: 'katalog',
    label: 'Katalog',
    pages: [
      // Einheitsmodell Stufe 6: eine geprüfte Gerätevorlage entsteht als
      // DATENSATZ (kein Software-Release), und die Komponenten-Welt der Flotte
      // ist an EINER Stelle sichtbar statt nur je Anlage.
      { id: 'vorlagen', label: 'Gerätevorlagen', icon: 'layers', adminOnly: true },
      { id: 'komponenten-flotte', label: 'Komponenten', icon: 'list', adminOnly: true },
    ],
  },
  {
    key: 'kunden',
    label: 'Kunden',
    pages: [
      // Seit Stufe 4 „Feinschliff" trägt der Mandanten-Drawer die VOLLE
      // Benutzer-Verwaltung (inkl. Passwort-Reset), deshalb ist „Benutzer"
      // kein eigener Punkt mehr - die alte Route bleibt als Legacy gültig.
      { id: 'mandanten', label: 'Mandanten', icon: 'building', adminOnly: true },
    ],
  },
];

/** Ein Tab eines Plattform-BEREICHS (Stufe 3): eine eigene Route, ein Ort. */
export interface BereichTab {
  id: PageId;
  label: string;
}

/**
 * Der Bereich **Geräte** (Admin-Umbau Stufe 3 „Zusammenwachsen",
 * Captain-Entscheid F3): EIN Nav-Punkt mit zwei Tabs - **Inventar** (der
 * Lebenszyklus je Box) und **Updates** (die Rollout-Kampagne).
 *
 * **Die revidierte Entscheidung, mit Begründung:** `vp-admin-geraete-ux-k2` §4
 * hatte die Voll-Fusion abgelehnt („zwei Job-Familien mit verschiedener
 * Kadenz auf einer Fläche" ergäbe eine Tabellen-Wand). Das Argument gilt
 * weiter - es richtet sich aber gegen EINE SEITE, nicht gegen EINEN ORT. Beide
 * Flächen bleiben inhaltlich, wie sie sind; nur ihr Ort wird einer.
 *
 * **Beide Routen bleiben ECHTE `PageId`s, kein Redirect** (§6.3): ein
 * Lesezeichen auf `#/edge-updates` landet auf dem Tab Updates, und der
 * programmatische Sprung des Flotten-Pulses (`onNavigate('edge-updates')`)
 * funktioniert unverändert. Nur die NAVIGATION zeigt einen Punkt - welchen,
 * beantwortet {@link navPageFor}.
 */
export const GERAETE_BEREICH: { host: PageId; tabs: BereichTab[] } = {
  host: 'geraete-registry',
  tabs: [
    { id: 'geraete-registry', label: 'Inventar' },
    { id: 'edge-updates', label: 'Updates' },
  ],
};

/**
 * Plattform-Seiten, die als TAB eines Bereichs leben statt als eigener
 * Nav-Punkt. Sie sind vollwertige Routen (Lesezeichen, Deep-Links, der
 * Admin-Zaun in `App.tsx`) und stehen deshalb in {@link PLATFORM_PAGES} - nur
 * eben nicht in {@link PLATFORM_GROUPS}, das die NAVIGATION beschreibt.
 */
export const PLATFORM_TAB_PAGES: PageDef[] = [
  // OTA Stufe 2: Releases, der laufende Rollout und das Audit-Journal.
  { id: 'edge-updates', label: 'Edge-Updates', icon: 'refresh-cw', adminOnly: true },
];

/**
 * Die flache Liste aller Plattform-Seiten: die Nav-Gruppen PLUS die Tab-Seiten.
 * Sie ist die EINE Wahrheit über die MENGE der Plattform-Routen und trägt
 * jeden Bestandsleser (den Admin-Zaun in `App.tsx`, `ALL_PAGES`); die Gruppen
 * beschreiben davon nur die PRÄSENTATION.
 *
 * **Der Unterschied ist tragend:** stünde `edge-updates` nur in den Gruppen,
 * verlöre die Seite mit Stufe 3 ihren Admin-Zaun - ein Nicht-Admin käme über
 * `#/edge-updates` durch.
 */
export const PLATFORM_PAGES: PageDef[] = [
  ...PLATFORM_GROUPS.flatMap((g) => g.pages),
  ...PLATFORM_TAB_PAGES,
];

/**
 * Der Nav-Punkt, unter dem eine Seite WOHNT - für die Hervorhebung in der
 * Schale. Für jede Seite sie selbst; für einen Tab sein Bereich (Tab Updates
 * lässt „Geräte" leuchten, nicht nichts).
 */
export function navPageFor(page: PageId): PageId {
  return GERAETE_BEREICH.tabs.some((t) => t.id === page) ? GERAETE_BEREICH.host : page;
}

/** Gehört diese Seite in den Geräte-Bereich (= ist sie einer seiner Tabs)? */
export function isGeraeteBereich(page: PageId): boolean {
  return GERAETE_BEREICH.tabs.some((t) => t.id === page);
}

/** "Meine Anlage" for 0-1 Anlagen, "Meine Anlagen" from 2 (the fleet list). */
export function anlagenLabel(siteCount: number | null): string {
  return siteCount != null && siteCount > 1 ? 'Meine Anlagen' : 'Meine Anlage';
}

/** Every page def, wherever it is rendered (main nav, mode group, Plattform). */
export const ALL_PAGES: PageDef[] = [
  PORTFOLIO_PAGE,
  ...PORTFOLIO_WELT_PAGES,
  ...MAIN_PAGES,
  ...MODE_PAGES,
  ...PLATFORM_PAGES,
];

export function pageLabel(id: PageId, siteCount: number | null = null): string {
  if (id === 'anlagen') return anlagenLabel(siteCount);
  return ALL_PAGES.find((p) => p.id === id)?.label ?? id;
}

const PAGE_IDS = new Set<string>(ALL_PAGES.map((p) => p.id));

/**
 * The retired menu items redirect into the Anlage (nothing was deleted -
 * everything moved onto the Anlagen-Seite, captain decision 2). Site-scoped
 * deep views keep their intent as a sub; the entity lists map to the
 * Anlagen entry itself (their content is the Technik section).
 */
const LEGACY_ROUTES: Record<string, AnlagenSub | null> = {
  // Cockpit + Live-Daten merge: `#/live` resolves to the Anlage itself.
  live: null,
  fahrplan: 'fahrplan',
  // Die Historie ist seit der Zwei-Welten-Struktur die Messwerte-Welt.
  historie: 'messwerte',
  wetter: 'wetter',
  // The former Standorte/Geräte content now lives behind the Technik subpage
  // (money-centric v2: Technik moved behind the gear icon).
  standorte: 'technik',
  geraete: 'technik',
};

/**
 * Stillgelegte PLATTFORM-Seiten, die in eine andere Seite GEFALTET wurden -
 * das `LEGACY_ROUTES`-Muster auf Seiten-Ebene (Admin-Umbau Stufe 3/4, §6.3).
 *
 * **Der Unterschied zu einem TAB:** `edge-updates` bleibt eine ECHTE `PageId`
 * (sie rendert den Geräte-Bereich mit ihrem Tab), weil auch programmatische
 * Sprünge - der Flotten-Puls ruft `onNavigate('edge-updates')` - unverändert
 * funktionieren müssen. Eine Seite HIER dagegen existiert nicht mehr; ihr
 * Hash wird auf die aufnehmende Seite umgeschrieben, mitsamt dem
 * SEKTIONS-Anker, damit ein Lesezeichen genau dort landet, wo sein Inhalt
 * jetzt wohnt.
 */
const LEGACY_PLATFORM_PAGES: Record<string, { page: PageId; sektion?: string }> = {
  // Stufe 3: dieselbe Betreiber-Frage („was dürfen wir steuern?"), nur für die
  // andere Geräteklasse - deshalb eine Sektion der Steuerungs-Freigabe.
  geraetetypen: { page: 'steuerungs-freigabe', sektion: 'geraetetypen' },
  // Stufe 4 (F5): die Benutzer wohnen im Mandanten-Drawer. Es gibt hier
  // ausdrücklich KEINEN Sektions-Anker - die alte Seite begann mit einer
  // Mandanten-AUSWAHL, und welchen der Betreiber gemeint hat, weiß der Hash
  // nicht; er landet deshalb auf der Liste, wo er ihn wählt.
  benutzer: { page: 'mandanten' },
};

/**
 * Die kanonische Adresse einer stillgelegten PLATTFORM-Seite, sonst null.
 * Der Aufrufer schreibt sie per `history.replaceState` (kein Verlaufseintrag,
 * kein `hashchange` - die geparste Route ist ohnehin identisch), genau wie
 * bei {@link canonicalAnlageHash}.
 */
export function canonicalPlatformHash(hash: string): string | null {
  const head = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean)[0] ?? '';
  const target = LEGACY_PLATFORM_PAGES[head];
  if (!target) return null;
  return target.sektion
    ? `#/${target.page}?sektion=${encodeURIComponent(target.sektion)}`
    : `#/${target.page}`;
}

/**
 * Die Adresse einer SEKTION einer Plattform-Seite (`?sektion=<id>`) - das
 * Hash-Parameter-Muster von {@link befehleHash}/{@link geraetHash}:
 * `parseRoute` schneidet den Query-Teil ohnehin ab, die Route bleibt also die
 * Seite, und ein Lesezeichen öffnet exakt dieselbe Sektion wieder.
 */
export function sektionHash(page: PageId, sektion?: string | null): string {
  const base = `#/${page}`;
  return sektion && sektion.trim()
    ? `${base}?sektion=${encodeURIComponent(sektion.trim())}`
    : base;
}

/** Die Sektion aus einem `?sektion=`-Hash, oder null. */
export function parseSektion(hash: string): string | null {
  const [, ...rest] = hash.replace(/^#\/?/, '').split('?');
  if (rest.length === 0) return null;
  const value = new URLSearchParams(rest.join('?')).get('sektion');
  return value && value.trim() ? value.trim() : null;
}

/**
 * The self-registration route (`#register` / `#/register`): the "Konto
 * erstellen" form lives in the PORTAL (custom form + seamless auto-login), not
 * in Keycloak - this route must render WITHOUT the automatic login redirect,
 * and the Keycloak login page links back to it.
 */
export function isRegisterRoute(): boolean {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return raw === 'register';
}

/**
 * Nennt dieser Hash ein ZIEL, oder ist es der nackte Boot-Hash?
 *
 * `parseRoute` beantwortet die Frage nicht: es bildet den leeren Hash UND
 * jeden unbekannten Hash auf `uebersicht` ab, ein Aufrufer könnte „ohne Ziel
 * gestartet" also nicht von „ausdrücklich zur Übersicht" unterscheiden. Genau
 * daran hängt die Admin-Landung (Stufe 1, F1): weitergeleitet wird nur ein
 * zielloser Start, ein Deep-Link und ein Klick auf „Übersicht" nie.
 */
export function isBootHash(hash: string): boolean {
  return hash.replace(/^#\/?/, '').split('?')[0].trim() === '';
}

/** Parse a location hash (e.g. "#/anlage/abc/live") into a Route. Pure. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '').split('?')[0];
  const segments = raw.split('/').filter((s) => s.length > 0);
  const head = segments[0] ?? '';

  if (head === 'anlage' && segments[1]) {
    const raw = segments[2];
    // `in`-check, not `??`: a legacy sub may map to null (= the cockpit).
    const sub = raw
      ? raw in LEGACY_SUBS
        ? LEGACY_SUBS[raw]
        : SUBS.has(raw)
          ? (raw as AnlagenSub)
          : null
      : null;
    // Die Geräteseite ist die EINZIGE Unterseite mit weiteren Abschnitten:
    // `…/geraet/{ref}[/{geraetId}]`. Ohne Referenz gibt es kein Gerät, also
    // fällt sie auf die Zentrale zurück - nie ein 404 (die `parseRoute`-Regel).
    if (sub === 'geraet') {
      const ref = segments[3];
      if (!ref) return { page: 'anlagen', siteId: segments[1], sub: 'modell' };
      return {
        page: 'anlagen',
        siteId: segments[1],
        sub: 'geraet',
        geraet: { ref: decodeURIComponent(ref), geraetId: segments[4] ? decodeURIComponent(segments[4]) : null },
      };
    }
    return { page: 'anlagen', siteId: segments[1], sub };
  }
  // Die Portfolio-Ebene ist zweistufig: `#/portfolio` (Landung) und
  // `#/portfolio/{welt}`. Ein unbekannter zweiter Abschnitt landet auf der
  // Landung, statt ins Leere zu zeigen.
  if (head === 'portfolio') {
    const welt = PORTFOLIO_WELT_PAGES.find((p) => p.id === `portfolio-${segments[1] ?? ''}`);
    return { page: welt ? welt.id : 'portfolio', siteId: null, sub: null };
  }
  if (head in LEGACY_ROUTES) {
    return { page: 'anlagen', siteId: null, sub: LEGACY_ROUTES[head] };
  }
  // Eine gefaltete Plattform-Seite landet auf ihrer AUFNEHMENDEN Seite - der
  // Anker reist über `canonicalPlatformHash` in die Adresse (die Route selbst
  // trägt ihn nicht, sie ist ja dieselbe Seite).
  if (head in LEGACY_PLATFORM_PAGES) {
    return { page: LEGACY_PLATFORM_PAGES[head].page, siteId: null, sub: null };
  }
  if (PAGE_IDS.has(head)) {
    return { page: head as PageId, siteId: null, sub: null };
  }
  return { page: 'uebersicht', siteId: null, sub: null };
}

export function routeFromHash(): Route {
  return parseRoute(window.location.hash);
}

/**
 * Die kanonische Adresse einer Anlagen-Route, wenn der Hash eine STILLGELEGTE
 * Unterseite benutzt (`historie` → `messwerte`, `entitaeten` → `modell`, …) —
 * sonst null (nichts umzuschreiben).
 *
 * **Die Parameter reisen mit.** Genau daran hängt, dass ein
 * `#/anlage/{id}/historie?m=…&z=woche&at=…`-Lesezeichen nach der Weiterleitung
 * noch denselben Messwert im selben Zeitraum öffnet; ohne das wäre die
 * Weiterleitung ein stiller Datenverlust. Der Aufrufer schreibt sie per
 * `history.replaceState` (kein Verlaufseintrag, kein `hashchange` - die
 * geparste Route ist ohnehin identisch).
 */
export function canonicalAnlageHash(hash: string): string | null {
  const [pathPart, ...rest] = hash.replace(/^#\/?/, '').split('?');
  const query = rest.length > 0 ? `?${rest.join('?')}` : '';
  const segments = pathPart.split('/').filter((s) => s.length > 0);
  if (segments[0] !== 'anlage' || !segments[1]) return null;
  const raw = segments[2];
  if (!raw || !(raw in LEGACY_SUBS)) return null;
  const sub = LEGACY_SUBS[raw];
  const path = sub ? `#/anlage/${segments[1]}/${sub}` : `#/anlage/${segments[1]}`;
  return `${path}${query}`;
}

/** The canonical hash of a route (what goes into window.location.hash). */
export function hashForRoute(route: Route): string {
  if (route.page === 'anlagen' && route.siteId) {
    if (route.sub === 'geraet' && route.geraet) {
      return geraetSeiteHash(route.siteId, route.geraet.ref, route.geraet.geraetId);
    }
    return route.sub
      ? `#/anlage/${route.siteId}/${route.sub}`
      : `#/anlage/${route.siteId}`;
  }
  if (route.page === 'anlagen') return '#/anlagen';
  // Die Portfolio-Welten schreiben sich zweistufig (`#/portfolio/messwerte`).
  if (PORTFOLIO_WELT_PAGES.some((p) => p.id === route.page)) {
    return `#/portfolio/${route.page.slice('portfolio-'.length)}`;
  }
  return `#/${route.page}`;
}

/** Shorthand for a plain top-level page route. */
export function pageRoute(page: PageId): Route {
  return { page, siteId: null, sub: null };
}

/** Route of one Anlage's page (or one of its subpages). */
export function anlageRoute(siteId: string, sub: AnlagenSub | null = null): Route {
  return { page: 'anlagen', siteId, sub };
}

/**
 * Die Adresse der BEFEHLE-Seite einer Komponente (Kommando-Transparenz V1,
 * Captain-Entscheid F2: eine eigene Unterseite je Komponente).
 *
 * Die Komponente reist als HASH-PARAMETER (`?komponente=`, das
 * `historieHash`/`settingsNav`-Muster) - `parseRoute` schneidet den
 * Query-Teil ohnehin ab, die Route bleibt also `befehle`, und ein Lesezeichen
 * öffnet exakt dieselbe Komponente wieder. Ohne Komponente zeigt die Seite
 * den Verlauf der ganzen Anlage.
 */
export function befehleHash(siteId: string, entityId?: string | null): string {
  const base = `#/anlage/${siteId}/befehle`;
  return entityId ? `${base}?komponente=${encodeURIComponent(entityId)}` : base;
}

/** Die Komponente aus einem `?komponente=`-Hash, oder null. */
export function parseBefehleKomponente(hash: string): string | null {
  const [, ...rest] = hash.replace(/^#\/?/, '').split('?');
  if (rest.length === 0) return null;
  const value = new URLSearchParams(rest.join('?')).get('komponente');
  return value && value.trim() ? value.trim() : null;
}

/**
 * Die Adresse der GERÄTE-DETAILSEITE (Admin-Umbau Stufe 2, Captain-Entscheid
 * F2): `#/geraete-registry?geraet=<referenz>`.
 *
 * Das Muster ist das von {@link befehleHash} - ein HASH-PARAMETER, keine
 * eigene `PageId`: `parseRoute` schneidet den Query-Teil ohnehin ab, die Route
 * bleibt also die Geräte-Seite, und ein Lesezeichen öffnet exakt dasselbe
 * Gerät wieder. **Der Schlüssel ist die REFERENZ, nicht die Geräte-UUID** -
 * sie überlebt Unclaim/Re-Claim (der dokumentierte Identitäts-Drift), also
 * überlebt auch das Lesezeichen.
 */
export function geraetHash(ref?: string | null): string {
  const base = '#/geraete-registry';
  return ref && ref.trim() ? `${base}?geraet=${encodeURIComponent(ref.trim())}` : base;
}

/** Die Geräte-Referenz aus einem `?geraet=`-Hash, oder null. */
export function parseGeraetRef(hash: string): string | null {
  const [, ...rest] = hash.replace(/^#\/?/, '').split('?');
  if (rest.length === 0) return null;
  const value = new URLSearchParams(rest.join('?')).get('geraet');
  return value && value.trim() ? value.trim() : null;
}

/**
 * Die Adresse der GERÄTE-DETAILSEITE in der Anlagen-Zentrale (Konzept
 * `vp-anlagen-zentrale-konzept-h6` §7.1): `#/anlage/{siteId}/geraet/{ref}` für
 * die VoltPilot-Box, `…/{geraetId}` für ein Gerät DAHINTER.
 *
 * Anders als {@link geraetHash} (die Plattform-Geräteseite, ein
 * Hash-Parameter) sind Referenz und Gerät hier echte Pfad-Abschnitte: die
 * Seite gehört zur ANLAGE, also gehört sie in ihren Pfad. Beide Werte werden
 * kodiert - eine Referenz ist per Kontrakt topic-sicher, eine Säulen-Kennung
 * (`cp-<ChargePointId>`) muss es nicht sein.
 */
export function geraetSeiteHash(
  siteId: string,
  ref: string,
  geraetId?: string | null,
): string {
  const base = `#/anlage/${siteId}/geraet/${encodeURIComponent(ref)}`;
  return geraetId && geraetId.trim()
    ? `${base}/${encodeURIComponent(geraetId.trim())}`
    : base;
}
