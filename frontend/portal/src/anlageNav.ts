/**
 * Die ANLAGEN-Navigation — seit der Navigations-Runde „zwei Ebenen"
 * (Konzept `data/vp-portfolio-konzept-r2` §5.5 + §8 Stufen S3–S5,
 * Captain-Entscheide E3/E4 vom 25.08.2026) **fünf BEREICHE mit REITERN**.
 *
 * Der behobene Befund war die ZÄHLUNG, nicht der Inhalt: ein Kunde mit
 * geöffneter Anlage sah 14 Einträge in 3 Gruppen (Admin: 23 in 8), „Messwerte"
 * und „Erlöse" standen doppelt (Flotten-Ebene UND Anlage), „Prognosequalität"
 * war ein Hauptmenü-Punkt, und jede Ausbaustufe hatte ANGEHÄNGT statt
 * eingeordnet — die Reihenfolge erzählte die Baugeschichte. Jetzt sind es
 * **fünf Bereiche + Fuß**, und die Seitenleiste ändert ihre FORM nie.
 *
 * Rein + deterministisch (das `betriebsart.ts`/`surface.ts`-Muster) — kein
 * React, kein Netz. Die Gesetze, die sie trägt:
 *
 * 1. **Die fünf Bereiche sind FEST und geordnet:** Cockpit · Fahrplan ·
 *    Verlauf · Steuerung · Anlage. Nur der zweite folgt der Komposition
 *    (Speicher · Ladepunkte) — er heißt auf einem reinen Ladepark
 *    „Ladevorgänge" und fehlt ganz, wo es weder das eine noch das andere gibt.
 *    **Ein Bereich ohne Inhalt existiert nicht — nie ein leerer Reiter.**
 * 2. **Die REITER entstehen aus dem M0-Read-Model** (`surface.deepViews`), wie
 *    vorher die Nav-Einträge: „Erlöse" erscheint mit einem Geld-Modus,
 *    „Lastspitzen" mit der Lastspitzenkappung, „Marktpreise" auf einem
 *    Börsentarif. Nichts davon ist hier fest verdrahtet.
 * 3. **Nichts ist verwaist.** Jede `AnlagenSub` hat einen Bereich oder einen
 *    Reiter; `anlageNav.test.ts` erzwingt es, eine neue Unterseite muss also
 *    irgendwo montiert werden oder der Test fällt. Das wiegt seit dem Wegfall
 *    des Telefon-Blatts SCHWERER als vorher: es gibt keinen Sammelort mehr,
 *    an dem eine vergessene Ansicht noch erreichbar wäre.
 *
 * ⚠ **Die Anwendungs-Gruppen („Anwendung · X") sind ERSATZLOS entfallen**
 * (E3 + Steuerungs-Konzept `vp-steuerung-konzept-b3` §3.1): ihre tiefen
 * Ansichten (Lastspitzen · Ladevorgänge · Prognose · Marktpreise) haben jetzt
 * einen Wohnort als Reiter. Eine neue Betriebsmodell-Ansicht bekommt einen
 * REITER, nie einen Nav-Eintrag. `modeViewItems` bleibt trotzdem — der
 * Anwendungs-Container rendert damit seine „Ansichten dieser Anwendung".
 *
 * Routen bleiben (`nav.ts` LEGACY-Disziplin): jedes Lesezeichen gilt weiter.
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type { AnlagenSub, PageId } from './nav';
import type { AnlageSurface, DeepViewId } from './surface';

/**
 * Wohin ein Nav-Eintrag führt. `sub: null` = das Cockpit der Anlage selbst;
 * `page` = eine Seite der oberen Ebene (heute nur noch aus dem
 * Anwendungs-Container heraus); `help` öffnet die Hilfe-Fläche der Schale
 * (es gibt bewusst keine erfundene Support-Adresse — siehe `HELP_TEXT`);
 * `action` ist eine SCHALEN-Handlung statt eines Ziels.
 */
export type NavTarget =
  | { kind: 'sub'; sub: AnlagenSub | null }
  | { kind: 'page'; page: PageId }
  | { kind: 'help' }
  | { kind: 'action'; action: 'add-anlage' | 'logout' };

/** Eine Zeile der Seitenleiste / der Telefon-Leiste / des Fußes. */
export interface SidebarItem {
  /** Stabiler Schlüssel; zugleich das, was `activeAreaKey` zurückgibt. */
  key: string;
  label: string;
  icon: IconName;
  target: NavTarget;
  /** Zahl-Abzeichen; null = keines (nur Steuerung, und nur > 0). */
  badge: number | null;
  /**
   * Was das Abzeichen ZÄHLT, als Satz (`title`/`aria-label`) — Steuerung
   * Stufe 8. Ein nacktes „2" an einer Seitenleiste ist ein Rätsel; genau das
   * war der Zustand, den diese Stufe behoben hat. `null` = kein Abzeichen,
   * also auch kein Titel.
   */
  badgeTitel?: string | null;
}

/** Die fünf Bereiche einer Anlage. */
export type BereichId = 'cockpit' | 'fahrplan' | 'ladevorgaenge' | 'verlauf' | 'steuerung' | 'anlage';

/**
 * Ein REITER eines Bereichs. Er zeigt IMMER auf eine Unterseite derselben
 * Anlage — ein Reiter, der die Anlage verlässt, wäre keiner (genau das war der
 * Befund N3: „Marktpreise" stand in der Anlagen-Gruppe und öffnete eine Seite
 * ausserhalb).
 */
export interface BereichTab {
  key: string;
  label: string;
  sub: AnlagenSub;
}

/**
 * Ein Bereich: eine Zeile der Seitenleiste, dahinter seine Reiter.
 *
 * `tabs.length <= 1` heißt „dieser Bereich IST eine Seite" — die Fläche
 * rendert dann keine Reiter-Leiste (eine Leiste mit einem Reiter behauptet
 * eine Wahl, die es nicht gibt).
 */
export interface AnlageBereich extends SidebarItem {
  key: BereichId;
  tabs: BereichTab[];
}

/** Das ganze Modell: die Bereiche plus der Fuß (Hilfe & Kontakt). */
export interface AnlageSidebar {
  bereiche: AnlageBereich[];
  foot: SidebarItem[];
}

/**
 * Der Text von „Hilfe & Kontakt". Es gibt in dieser Plattform keinen
 * Selbstbedienungs-Kanal (kein SMTP, und „Vertrieb läuft persönlich" —
 * Captain-Entscheid, siehe `moduleSurface.ts`), also sagt der Fuß-Eintrag die
 * ehrliche Wahrheit statt einen mailto zu verlinken, den niemand liest.
 */
export const HELP_TEXT =
  'Ihr VoltPilot-Team hilft Ihnen weiter. Wenden Sie sich an Ihren Ansprechpartner bei VoltPilot — ' +
  'auch wenn Sie Ihr Passwort zurücksetzen möchten oder ein Gerät sich nicht meldet.';

const HELP_ITEM: SidebarItem = {
  key: 'hilfe',
  label: 'Hilfe & Kontakt',
  icon: 'help-circle',
  target: { kind: 'help' },
  badge: null,
};

/**
 * Die REITER des Bereichs „Verlauf", in der Reihenfolge des Zielbilds
 * (Mockup `06-navigation-ist-ziel.html`): Messwerte · Erlöse · Marktpreise ·
 * Lastspitzen · Prognose · Wetter.
 *
 * `view: null` = unbedingt. Das gilt genau für **Messwerte**: die Basis-Welt
 * der Historie existiert auf JEDER Anlage (sie war vor diesem Umbau ein fester
 * Basis-Eintrag und bleibt es) — ohne sie hätte eine frisch angelegte Anlage
 * einen leeren Bereich, und genau das verbietet Gesetz 1.
 *
 * ⚠ **`wetter` ist hier eine bewusste Abweichung vom Mockup-Wortlaut.** Das
 * Fragment sagt „Wetter bleibt Cockpit-Karte mit Absprung" — eine solche Karte
 * gibt es heute NICHT (`AnlagenPage.tsx` kennt nur die Unterseite), und mit dem
 * Wegfall des Telefon-Blatts verlöre die Ansicht damit ihren einzigen
 * Wohnort. Sie ist eine abgeleitete Basis-Ansicht des Read-Models wie die
 * anderen, also bekommt sie einen Reiter statt einer erfundenen Karte. Baut
 * jemand die Cockpit-Karte, kann der Reiter entfallen — der Wächter „nichts
 * ist verwaist" merkt es sofort.
 */
const VERLAUF_TABS: { key: string; label: string; sub: AnlagenSub; view: DeepViewId | null }[] = [
  { key: 'messwerte', label: 'Messwerte', sub: 'messwerte', view: null },
  { key: 'erloese', label: 'Erlöse', sub: 'erloese', view: 'erloes-historie' },
  { key: 'marktpreise', label: 'Marktpreise', sub: 'marktpreise', view: 'marktpreise' },
  { key: 'lastspitzen', label: 'Lastspitzen', sub: 'lastspitzen', view: 'lastspitzen' },
  { key: 'prognose', label: 'Prognose', sub: 'prognose', view: 'prognosequalitaet' },
  { key: 'wetter', label: 'Wetter', sub: 'wetter', view: 'wetter' },
];

/**
 * Die REITER des Bereichs „Anlage": Modell · Einstellungen · Befehle an
 * Geräte. Alle drei sind STRUKTURELL da (sie folgen keinem Modus) — die
 * Befehle-Seite zeigt ohne Komponente den Verlauf der ganzen Anlage.
 */
const ANLAGE_TABS: BereichTab[] = [
  // ⚠ „Komponenten", nicht „Modell": seit Steuerung Stufe 8 heisst der Reiter
  // wie das, was er zeigt (Konzept `vp-steuerung-konzept-b3` §3.9 — „Komponenten
  // & Regeln" → „Komponenten"; die Regeln wohnen in der Steuerung, EIN Ort je
  // Sache). Der SCHLÜSSEL `modell` und die Route bleiben — jedes Lesezeichen gilt.
  { key: 'modell', label: 'Komponenten', sub: 'modell' },
  { key: 'technik', label: 'Einstellungen', sub: 'technik' },
  { key: 'befehle', label: 'Befehle an Geräte', sub: 'befehle' },
];

/** Welcher Bereich eine Unterseite beherbergt — die EINE Zuordnung. */
const SUB_BEREICH: Record<AnlagenSub, BereichId> = {
  fahrplan: 'fahrplan',
  ladevorgaenge: 'fahrplan',
  messwerte: 'verlauf',
  erloese: 'verlauf',
  marktpreise: 'verlauf',
  lastspitzen: 'verlauf',
  prognose: 'verlauf',
  wetter: 'verlauf',
  steuerung: 'steuerung',
  modell: 'anlage',
  technik: 'anlage',
  befehle: 'anlage',
  // Die GERÄTE-DETAILSEITE und die BOX-Seite sind eine Ebene UNTER dem
  // Anlagen-Modell (die eine braucht eine Geräte-Referenz, die andere IST das
  // Tor der Zentrale) - beide haben keinen eigenen Reiter und heben deshalb
  // ihren Wirt hervor; sonst stünde die Navigation ohne Markierung da,
  // während der Kunde offensichtlich IN der Zentrale ist.
  geraet: 'anlage',
  box: 'anlage',
};

function bereich(
  key: BereichId,
  label: string,
  icon: IconName,
  sub: AnlagenSub | null,
  tabs: BereichTab[],
  badge: number | null = null,
  badgeTitel: string | null = null,
): AnlageBereich {
  return { key, label, icon, target: { kind: 'sub', sub }, badge, badgeTitel, tabs };
}

/**
 * Die fünf Bereiche einer Anlage. `badgeAnzahl` badgt die Steuerung; 0/null/NaN
 * rendert KEIN Abzeichen — nie eine entmutigende „0".
 *
 * ⚠ **Seit Steuerung Stufe 8 zählt das Abzeichen AUFMERKSAMKEIT** (§3.1: „Zahl
 * der Dinge, die Aufmerksamkeit brauchen" statt „aktive Anwendungen") — die
 * Ableitung wohnt in `steuerungAufmerksamkeit.ts`, der Aufrufer reicht ihr
 * Ergebnis hier durch. Der ORT hat sich nie geändert; genau deshalb war es ein
 * Argument-Wechsel und kein Umbau. Die alte Vorgabe (die Modus-Zahl der
 * Projektion) bleibt der Rückfall für einen Aufrufer, der nichts übergibt —
 * so rendert ein älterer Testaufruf zeichengleich wie vorher.
 */
export function anlageBereiche(
  surface: AnlageSurface | null | undefined,
  badgeAnzahl?: number | null,
  badgeTitel?: string | null,
): AnlageBereich[] {
  const raw = badgeAnzahl === undefined ? surface?.modes.length ?? null : badgeAnzahl;
  const badge =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
  const views = surface?.deepViews ?? [];

  const out: AnlageBereich[] = [
    bereich('cockpit', 'Cockpit', 'dashboard', null, []),
  ];

  // Bereich 2 folgt als EINZIGER der Komposition: mit Speicher heißt er
  // „Fahrplan" (und trägt die Ladevorgänge als zweiten Reiter, wo es auch
  // Ladepunkte gibt), auf einem REINEN Ladepark „Ladevorgänge", sonst gibt es
  // ihn nicht.
  const hatFahrplan = views.includes('fahrplan');
  const hatLade = views.includes('ladevorgaenge');
  if (hatFahrplan) {
    const tabs: BereichTab[] = [{ key: 'fahrplan', label: 'Fahrplan', sub: 'fahrplan' }];
    if (hatLade) tabs.push({ key: 'ladevorgaenge', label: 'Ladevorgänge', sub: 'ladevorgaenge' });
    out.push(bereich('fahrplan', 'Fahrplan', 'calendar', 'fahrplan', tabs));
  } else if (hatLade) {
    out.push(
      bereich('ladevorgaenge', 'Ladevorgänge', 'zap', 'ladevorgaenge', [
        { key: 'ladevorgaenge', label: 'Ladevorgänge', sub: 'ladevorgaenge' },
      ]),
    );
  }

  const verlaufTabs = VERLAUF_TABS.filter((t) => t.view === null || views.includes(t.view)).map(
    ({ key, label, sub }) => ({ key, label, sub }),
  );
  out.push(bereich('verlauf', 'Verlauf', 'history', verlaufTabs[0].sub, verlaufTabs));

  out.push(
    bereich('steuerung', 'Steuerung', 'zap', 'steuerung', [], badge,
      badge == null ? null : (badgeTitel ?? null)),
  );
  out.push(bereich('anlage', 'Anlage', 'layers', 'modell', ANLAGE_TABS));
  return out;
}

/**
 * Das ganze Navigations-Modell einer Anlage: die Bereiche plus der Fuß.
 *
 * Der Fuß trägt seit diesem Umbau NUR noch „Hilfe & Kontakt" — die
 * „Einstellungen" sind ein Reiter des Bereichs „Anlage" geworden, wo sie
 * hingehören (die Stammdaten DIESER Anlage). Ihre Route bleibt unverändert.
 */
export function anlageSidebar(
  surface: AnlageSurface | null | undefined,
  badgeAnzahl?: number | null,
  badgeTitel?: string | null,
): AnlageSidebar {
  return {
    bereiche: anlageBereiche(surface, badgeAnzahl, badgeTitel),
    foot: [HELP_ITEM],
  };
}

/** Kürzere Telefon-Beschriftungen; die Seitenleiste behält die vollen Wörter. */
const BOTTOM_LABELS: Partial<Record<BereichId, string>> = {
  ladevorgaenge: 'Laden',
};

/**
 * Die Telefon-Leiste einer Anlage: **die fünf Bereiche, ohne „Mehr"** (E4 —
 * das Blatt entfällt ersatzlos; Hilfe · Abmelden · Plattform wohnen im
 * Avatar-Menü). Die Belegung ist damit nicht mehr abgeleitet, sondern IDENTISCH
 * mit der Seitenleiste: derselbe Ort heißt am Telefon nicht anders als am
 * Rechner.
 */
export function bottomBarSlots(sidebar: AnlageSidebar): SidebarItem[] {
  return sidebar.bereiche.map((b) => ({
    key: b.key,
    label: BOTTOM_LABELS[b.key] ?? b.label,
    icon: b.icon,
    target: b.target,
    badge: b.badge,
    badgeTitel: b.badgeTitel ?? null,
  }));
}

/** Der Bereich, in dem eine Unterseite wohnt. */
export function bereichFor(sub: AnlagenSub | null): BereichId {
  return sub == null ? 'cockpit' : SUB_BEREICH[sub];
}

/**
 * Die Reiter, die über einer offenen Unterseite stehen — leer, wo der Bereich
 * EINE Seite ist (Cockpit, Steuerung) oder nur einen Reiter hätte.
 *
 * ⚠ Sie kommen aus DEMSELBEN Modell wie die Seitenleiste. Eine zweite
 * Ableitung ließe Leiste und Reiter über dieselbe Anlage Verschiedenes
 * behaupten.
 */
export function tabsFor(sidebar: AnlageSidebar, sub: AnlagenSub | null): BereichTab[] {
  const key = bereichFor(sub);
  const tabs = sidebar.bereiche.find((b) => b.key === key)?.tabs ?? [];
  return tabs.length > 1 ? tabs : [];
}

/** Die Beschriftung des Bereichs, in dem eine Unterseite wohnt. */
export function bereichLabel(sidebar: AnlageSidebar, sub: AnlagenSub | null): string {
  const key = bereichFor(sub);
  return sidebar.bereiche.find((b) => b.key === key)?.label ?? key;
}

/**
 * Welcher Bereich die offene Route hervorhebt. EINE Regel, hier entschieden
 * und nie in die `AppShell` verstreut.
 */
export function activeAreaKey(sub: AnlagenSub | null): BereichId {
  return bereichFor(sub);
}

/**
 * Welche tiefen Ansichten eine Modus-Menge als eigene Zeile beisteuert — das
 * bleibt für den v3.1-M2-**Anwendungs-Container** („Ansichten dieser
 * Anwendung"), NICHT mehr für die Navigation: Anwendungs-Gruppen gibt es
 * seit E3 keine.
 *
 * `baseViews` wird abgezogen: was der Kunde ohnehin erreicht, darf der
 * Container nicht als „wird verfügbar, sobald Sie den Modus einschalten"
 * ausgeben.
 */
export function modeViewItems(
  deepViews: readonly DeepViewId[],
  baseViews: readonly DeepViewId[] = [],
): SidebarItem[] {
  const items: SidebarItem[] = [];
  for (const view of deepViews) {
    if (baseViews.includes(view)) continue;
    const def = VIEW_ITEMS[view];
    if (def) items.push({ ...def, badge: null });
  }
  return items;
}

/**
 * Wie eine tiefe Ansicht im Anwendungs-Container aussieht. Sie zeigt seit
 * diesem Umbau auf ihre ANLAGEN-Unterseite (Marktpreise und Prognose sind
 * keine Seiten der oberen Ebene mehr, sondern Reiter des Verlaufs).
 */
const VIEW_ITEMS: Partial<Record<DeepViewId, Omit<SidebarItem, 'badge'>>> = {
  fahrplan: { key: 'fahrplan', label: 'Fahrplan', icon: 'calendar', target: { kind: 'sub', sub: 'fahrplan' } },
  marktpreise: {
    key: 'marktpreise',
    label: 'Marktpreise',
    icon: 'euro',
    target: { kind: 'sub', sub: 'marktpreise' },
  },
  prognosequalitaet: {
    key: 'prognose',
    label: 'Prognosequalität',
    icon: 'trending-up',
    target: { kind: 'sub', sub: 'prognose' },
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

/**
 * Die Anlage, die eine Route meint: die verlangte, sonst die EINE Anlage eines
 * Einzel-Anlagen-Kunden, sonst null (die Flotten-Ebene). Geteilt von
 * `AnlagenPage` (die sie rendert) und `App.tsx` (die die Schale dafür baut),
 * damit die zwei nie uneins darüber sind, auf welche Anlage die Schale zeigt.
 */
export function resolveAnlage<T extends { id: string }>(
  sites: T[],
  siteId: string | null,
): T | null {
  const requested = siteId ? sites.find((s) => s.id === siteId) ?? null : null;
  if (requested) return requested;
  return sites.length === 1 ? sites[0] : null;
}
