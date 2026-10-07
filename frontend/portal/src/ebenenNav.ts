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
 *    Reiter; `ebenenNav.test.ts` erzwingt es, eine neue Unterseite muss also
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
import type { Funktionen, Kennzahl, StandortAmStichtag } from './api';
import {
  isPortfolioPage,
  pageRoute,
  standortBereichRoute,
  standortMessstellenRoute,
  standortRoute,
  type AnlagenSub,
  type PageId,
  type Route,
} from './nav';
import type { AnlageSurface, DeepViewId } from './surface';
import { UEMS_ENERGIEBILANZ, UEMS_ENERGIEMANAGEMENT, UEMS_ZIELE_UND_MASSNAHMEN } from './glossar';
import type { FunktionZustand } from './uemsFunktion';

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

export const HELP_ITEM: SidebarItem = {
  key: 'hilfe',
  label: 'Hilfe & Kontakt',
  icon: 'help-circle',
  target: { kind: 'help' },
  badge: null,
};

/**
 * Die REITER des Bereichs „Verlauf" (Verlauf-Rework, Entscheid E1 = A):
 * **Energie · Erlöse · Messwerte** — was gemessen, was bewertet und welche
 * einzelnen Werte dahinterstehen.
 *
 * `view: null` = unbedingt: Energie und Messwerte existieren auf JEDER Anlage,
 * sonst hätte eine frisch angelegte Anlage einen leeren Bereich (Gesetz 1).
 * Der Schlüssel `messwerte` bleibt für die Energie-Seite (jedes Lesezeichen
 * gilt); die einzelnen Messwerte wohnen unter `einzelwerte`.
 *
 * Preise und Wetter gehören seit dem Rework zum FAHRPLAN (sie erklären den
 * Plan), die Prognosen zur ANLAGE (sie beschreiben ihr Modell). Wo es keinen
 * Fahrplan-Bereich gibt, bleiben Preise und Wetter hier — eine Ansicht wird nie
 * heimatlos. Die Lastspitze ist kein Reiter mehr: ihr Geld steht auf „Erlöse",
 * ihre gemessene Spitze auf „Energie"; die Seite bleibt über die Erlöse-Karte
 * erreichbar.
 */
export const VERLAUF_TABS: { key: string; label: string; sub: AnlagenSub; view: DeepViewId | null }[] = [
  { key: 'messwerte', label: 'Energie', sub: 'messwerte', view: null },
  { key: 'erloese', label: 'Erlöse', sub: 'erloese', view: 'erloes-historie' },
  { key: 'einzelwerte', label: 'Messwerte', sub: 'einzelwerte', view: null },
];

/** Preise und Wetter — im Fahrplan, wo es ihn gibt, sonst im Verlauf. */
export const PLAN_KONTEXT_TABS: { key: string; label: string; sub: AnlagenSub; view: DeepViewId }[] = [
  { key: 'marktpreise', label: 'Preise', sub: 'marktpreise', view: 'marktpreise' },
  { key: 'wetter', label: 'Wetter', sub: 'wetter', view: 'wetter' },
];

/**
 * Der Name des Reiters, der den Aufbau der Anlage zeigt. Texte, die auf ihn
 * verweisen („Sie finden es unter „Aufbau""), nehmen diese Konstante - ein
 * umbenannter Reiter hinterlässt sonst Wegweiser ins Nichts.
 */
export const AUFBAU_REITER = 'Aufbau';

/**
 * Die REITER des Bereichs „Anlage": Aufbau · Einstellungen. Beide sind
 * STRUKTURELL da (sie folgen keinem Modus).
 *
 * ⚠ **„Befehle an Geräte" ist als SEITEN-Reiter ERSATZLOS entfallen**
 * (Captain-Auftrag 27.08.2026): Gerätebefehle stehen ausschließlich auf der
 * jeweiligen Geräte-Detailseite. Die Route `befehle` bleibt gültig (jeder
 * per-Gerät-Absprung `…/befehle?geraet=` / `…?komponente=` funktioniert weiter)
 * — sie hat nur keinen eigenen Reiter mehr und hebt wie {@link SUB_BEREICH}
 * `geraet`/`box` ihren Wirt, den Bereich „Anlage", hervor.
 */
const ANLAGE_TABS_BASIS: BereichTab[] = [
  // „Aufbau" (Konzept „Anlage – neu gedacht", E1 = A vom 25.09.2026): der
  // Reiter zeigt den Baum Standort → Anlage → Box → Gerät, nicht nur
  // Komponenten. Der SCHLÜSSEL `modell` und die Route bleiben — jedes
  // Lesezeichen gilt.
  { key: 'modell', label: AUFBAU_REITER, sub: 'modell' },
  { key: 'technik', label: 'Einstellungen', sub: 'technik' },
];

/** Welcher Bereich eine Unterseite beherbergt — die EINE Zuordnung. */
const SUB_BEREICH: Record<AnlagenSub, BereichId> = {
  fahrplan: 'fahrplan',
  ladevorgaenge: 'fahrplan',
  messwerte: 'verlauf',
  energiebilanz: 'verlauf',
  erloese: 'verlauf',
  einzelwerte: 'verlauf',
  // Rückfall, wenn das Modell sie nicht in einen Reiter legt (siehe `bereichFor`).
  marktpreise: 'verlauf',
  lastspitzen: 'verlauf',
  prognose: 'anlage',
  wetter: 'verlauf',
  steuerung: 'steuerung',
  laden: 'steuerung',
  regeln: 'steuerung',
  modell: 'anlage',
  technik: 'anlage',
  // Die BEFEHLE-Seite, die GERÄTE-DETAILSEITE und die BOX-Seite haben KEINEN
  // eigenen Reiter (Befehle stehen auf der jeweiligen Geräteseite; die beiden
  // anderen sind eine Ebene UNTER dem Anlagen-Modell) - sie heben trotzdem
  // ihren Wirt, den Bereich „Anlage", hervor; sonst stünde die Navigation ohne
  // Markierung da, während der Kunde offensichtlich IN der Zentrale ist.
  befehle: 'anlage',
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
  /**
   * Der Reiter „Prognosen" (Modelle, Abweichungen, Kandidaten) ist seit
   * „Anlage – neu gedacht" (E6 = A) ein Werkzeug für VoltPilot: der Kunde sieht
   * die Treffsicherheit als Zeile im Fahrplan. Der Aufrufer reicht das EINE Tor
   * (`showTechnicalLayer()`) herein - dieses Modul bleibt rein.
   */
  mitPrognosen = false,
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
  const planKontext = PLAN_KONTEXT_TABS.filter((t) => views.includes(t.view)).map(
    ({ key, label, sub }) => ({ key, label, sub }),
  );
  if (hatFahrplan) {
    const tabs: BereichTab[] = [{ key: 'fahrplan', label: 'Fahrplan', sub: 'fahrplan' }];
    if (hatLade) tabs.push({ key: 'ladevorgaenge', label: 'Ladevorgänge', sub: 'ladevorgaenge' });
    tabs.push(...planKontext);
    out.push(bereich('fahrplan', 'Fahrplan', 'calendar', 'fahrplan', tabs));
  } else if (hatLade) {
    out.push(
      bereich('ladevorgaenge', 'Ladevorgänge', 'zap', 'ladevorgaenge', [
        { key: 'ladevorgaenge', label: 'Ladevorgänge', sub: 'ladevorgaenge' },
      ]),
    );
  }

  const verlaufTabs: BereichTab[] = VERLAUF_TABS.filter((t) => t.view === null || views.includes(t.view)).map(
    ({ key, label, sub }) => ({ key, label, sub }),
  );
  if (!hatFahrplan) {
    verlaufTabs.push(
      ...planKontext.map((t) => (t.sub === 'marktpreise' ? { ...t, label: 'Marktpreise' } : t)),
    );
  }
  // UEMS AP-13 IP-8 (E7 = A): „Energiebilanz“ direkt nach „Energie“ (Schlüssel `messwerte`) — NUR mit Hauptzähler in der Stellung
  // (`surface.energiebilanz`, gesetzt von `anlageEnergiebilanz.mitEnergiebilanz`). Ohne den Fakt bleibt der Verlauf
  // zeichengleich (Bestandsschutz, AP-13 E2). Bewusst KEIN `VERLAUF_TABS`-Eintrag: der Reiter hängt an keiner Ansicht
  // der Projektion und trägt nie Geld (`anlageGeld.GELD_UNTERSEITEN` liest nur Reiter mit Ansicht).
  if (surface?.energiebilanz) {
    verlaufTabs.splice(1, 0, { key: 'energiebilanz', label: UEMS_ENERGIEBILANZ, sub: 'energiebilanz' });
  }
  out.push(bereich('verlauf', 'Verlauf', 'history', verlaufTabs[0].sub, verlaufTabs));

  // Die Steuerung hat seit dem Konzept „Steuerung neu" (E4 = A) drei Reiter:
  // „Geräte" (die Route `steuerung` selbst, damit jedes Lesezeichen gilt),
  // „Laden" nur, wo es Ladepunkte gibt (dasselbe Signal wie die Ladevorgänge),
  // und „Regeln". Das Ziel des Bereichs bleibt `steuerung`.
  const steuerungTabs: BereichTab[] = [{ key: 'steuerung', label: 'Geräte', sub: 'steuerung' }];
  if (hatLade) steuerungTabs.push({ key: 'laden', label: 'Laden', sub: 'laden' });
  steuerungTabs.push({ key: 'regeln', label: 'Regeln', sub: 'regeln' });
  out.push(
    bereich('steuerung', 'Steuerung', 'zap', 'steuerung', steuerungTabs, badge,
      badge == null ? null : (badgeTitel ?? null)),
  );
  const anlageTabs = mitPrognosen && views.includes('prognosequalitaet')
    ? [...ANLAGE_TABS_BASIS, { key: 'prognose', label: 'Prognosen', sub: 'prognose' as AnlagenSub }]
    : ANLAGE_TABS_BASIS;
  out.push(bereich('anlage', 'Anlage', 'layers', 'modell', anlageTabs));
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
  mitPrognosen = false,
): AnlageSidebar {
  return {
    bereiche: anlageBereiche(surface, badgeAnzahl, badgeTitel, mitPrognosen),
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

/**
 * Der Bereich, in dem eine Unterseite wohnt. Mit Modell zählt, wo ihr REITER
 * steht (Preise und Wetter wandern mit dem Fahrplan); ohne Reiter gilt die
 * feste Zuordnung {@link SUB_BEREICH}.
 */
export function bereichFor(sub: AnlagenSub | null, sidebar?: AnlageSidebar | null): BereichId {
  if (sub == null) return 'cockpit';
  const wirt = sidebar?.bereiche.find((b) => b.tabs.some((t) => t.sub === sub));
  return wirt?.key ?? SUB_BEREICH[sub];
}

/**
 * Unterseiten EINE Ebene unter ihrem Bereich - sie tragen nie dessen Reiter.
 *
 * ⚠ Die Geräte- und die Box-Seite wohnen im Bereich „Anlage" (`SUB_BEREICH`,
 * damit die Seitenleiste ihren Wirt hervorhebt), stehen aber eine Ebene
 * DARUNTER: sie zeigen EIN Gerät. Ein Bereichs-Umschalter über einem einzelnen
 * Gerät läse sich, als wechselte er dessen Ansicht (die Disziplin der
 * Plattform-Geräteseite, `GERAETE_BEREICH`) - und weil die Unterseite in
 * keinem der Reiter steht, wäre obendrein keiner aktiv. Ihr Rückweg ist die
 * Brotkrume im Seitenkopf, und zwar GENAU EINMAL
 * (Konzept `vp-geraeteseite-rahmen-r2` §2.1/§4.2, Captain-Entscheid D1a).
 */
const OHNE_BEREICHS_REITER: ReadonlySet<AnlagenSub> = new Set(['geraet', 'box']);

/**
 * Die Reiter, die über einer offenen Unterseite stehen — leer, wo der Bereich
 * EINE Seite ist (Cockpit), wo er nur einen Reiter hätte oder wo die
 * Unterseite eine Ebene unter ihm wohnt ({@link OHNE_BEREICHS_REITER}).
 *
 * ⚠ Sie kommen aus DEMSELBEN Modell wie die Seitenleiste. Eine zweite
 * Ableitung ließe Leiste und Reiter über dieselbe Anlage Verschiedenes
 * behaupten.
 */
export function tabsFor(sidebar: AnlageSidebar, sub: AnlagenSub | null): BereichTab[] {
  if (sub != null && OHNE_BEREICHS_REITER.has(sub)) return [];
  const key = bereichFor(sub, sidebar);
  const tabs = sidebar.bereiche.find((b) => b.key === key)?.tabs ?? [];
  return tabs.length > 1 ? tabs : [];
}

/** Die Beschriftung des Bereichs, in dem eine Unterseite wohnt. */
export function bereichLabel(sidebar: AnlageSidebar, sub: AnlagenSub | null): string {
  const key = bereichFor(sub, sidebar);
  return sidebar.bereiche.find((b) => b.key === key)?.label ?? key;
}

/**
 * Welcher Bereich die offene Route hervorhebt. EINE Regel, hier entschieden
 * und nie in die `AppShell` verstreut.
 */
export function activeAreaKey(sub: AnlagenSub | null, sidebar?: AnlageSidebar | null): BereichId {
  return bereichFor(sub, sidebar);
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

// ---------------------------------------------------------------------------
// Die Ebenen ÜBER der Anlage: Unternehmen und Standort (UEMS AP-01 IP-7, E4 = A)
// ---------------------------------------------------------------------------

/**
 * Die Bereiche einer Ebene über der Anlage (AP-01 §4.6). Unternehmen:
 * Übersicht · Standorte · Messstellen · Kennzahlen · Berichte. Standort:
 * Übersicht · Aufbau · Gebäude · Messstellen · Netzanschlüsse. Die Anlage oben
 * behält ihre fünf Bereiche — dieselbe Regel, eine Ebene tiefer, unverändert.
 *
 * ⚠ „Aufbau“ ist am Standort der EINE Ort für Anlagen, VoltPilot-Boxen und
 * Geräte (derselbe Baum wie „Anlage › Aufbau“). Die früheren Bereiche „Boxen“
 * und „Anlagen“ sind darin aufgegangen — sie zeigten dieselben Dinge ein
 * zweites und drittes Mal, und hinzufügen ließ sich dort nichts.
 */
export type EbenenBereichId =
  | 'uebersicht'
  | 'standorte'
  | 'aufbau'
  | 'netzanschluesse'
  | 'gebaeude'
  | 'messstellen'
  | 'bezugsgroessen'
  | 'kennzahlen'
  | 'berichte'
  | 'bewertung'
  | 'verbesserung'
  | 'energiemanagement'
  | 'verbrauch';

export interface EbenenBereich {
  key: EbenenBereichId;
  label: string;
  icon: IconName;
}

/** Ein Reiter einer Ebene: ein Bereich MIT seiner Seite. */
export interface EbenenKachel extends EbenenBereich {
  ziel: Route;
}

/**
 * Ein EINTRAG einer Ebene — derselbe in der Seitenleiste am Rechner und als Kachel der Telefon-Leiste (Konzept
 * „Navigation aus einem Guss“, R1/R2). Am Standort ist er genau ein Bereich; am Unternehmen eine GRUPPE von Bereichen
 * ({@link UNTERNEHMEN_GRUPPEN}), ohne Messfunktion eine Seite der Flotte ({@link flottenEintraege}) — nie mehr als
 * fünf. `bereiche` nennt, welche Bereiche er hervorhebt; `ziel` ist die Seite des ersten davon.
 */
export interface EbenenLeistenKachel {
  key: string;
  label: string;
  /** Die kürzere Beschriftung der Telefon-Leiste („Anschlüsse“); die Seitenleiste behält das volle Wort. */
  kurz?: string;
  icon: IconName;
  ziel: Route;
  bereiche: readonly EbenenBereichId[];
  /** K1: die Arbeitsfrage einer Unternehmens-Gruppe („Können wir belegen, was wir tun?“); am Standort keine. */
  frage?: string;
  /**
   * N3: Einträge der Flotte meinen SEITEN — „Energie“ und „Erlöse“ wohnen im Bereich „Übersicht“. Sie leuchten nach
   * der offenen Seite ({@link aktiverEintrag}), und die Reiter der Seite zeigen sie kein zweites Mal.
   */
  seiten?: readonly PageId[];
}

/** Die Ebene, deren Bereiche gemeint sind. */
export type EbenenOrt = { art: 'unternehmen' } | { art: 'standort'; standortId: string };

/**
 * Was die Ableitung liest: die drei Lesemodelle, jedes `null` = unbekannt
 * (lädt, Fehler, älteres Backend). Unbekannt ist nie „vorhanden" — ein Bereich,
 * dessen Voraussetzung niemand kennt, entsteht nicht.
 */
export interface EbenenLesemodell {
  /** `GET /api/v1/standorte` — die Standorte heute. */
  standorte: readonly StandortAmStichtag[] | null;
  /** `GET /api/v1/funktionen` — je Standort der Zustand von „Messen & Auswerten". */
  funktionen: Funktionen | null;
  /** `GET /api/v1/kennzahlen`. */
  kennzahlen: readonly Kennzahl[] | null;
  /**
   * UEMS AP-16 IP-6: darf die Person Energieeinsätze ansehen (`energieeinsatz.ansehen` aus `/me`, am Unternehmen
   * oder an einem Standort)? Fehlt der Wert, gibt es den Bereich „Bewertung“ nicht — unbekannt ist nie „ja“.
   */
  bewertung?: boolean | null;
  /**
   * UEMS AP-18 IP-8: darf die Person Energieziele, Maßnahmen und Abweichungen ansehen (`verbesserung.ansehen` aus
   * `/me`, am Unternehmen oder an einem Standort)? Fehlt der Wert, gibt es den Bereich „Ziele und Maßnahmen“ nicht.
   */
  verbesserung?: boolean | null;
  /**
   * UEMS AP-19 IP-9: darf die Person das Energiemanagement ansehen (`energiemanagement.ansehen` aus `/me`, am
   * Unternehmen oder an einem Standort)? Fehlt der Wert, gibt es den Bereich „Energiemanagement“ nicht.
   */
  energiemanagement?: boolean | null;
  /**
   * N3: trägt die Flotte Geld (`geldWelt.hatGeldWelt`)? Nur dann hat sie den Eintrag „Erlöse“ — wie der Reiter bisher.
   */
  geldWelt?: boolean | null;
}

const EBENEN_BEREICH: Record<EbenenBereichId, EbenenBereich> = {
  uebersicht: { key: 'uebersicht', label: 'Übersicht', icon: 'dashboard' },
  standorte: { key: 'standorte', label: 'Standorte', icon: 'map-pin' },
  aufbau: { key: 'aufbau', label: AUFBAU_REITER, icon: 'layers' },
  netzanschluesse: { key: 'netzanschluesse', label: 'Netzanschlüsse', icon: 'zap' },
  gebaeude: { key: 'gebaeude', label: 'Gebäude', icon: 'building' },
  messstellen: { key: 'messstellen', label: 'Messstellen', icon: 'activity' },
  bezugsgroessen: { key: 'bezugsgroessen', label: 'Bezugsgrößen', icon: 'layers' },
  kennzahlen: { key: 'kennzahlen', label: 'Kennzahlen', icon: 'trending-up' },
  berichte: { key: 'berichte', label: 'Berichte', icon: 'file-text' },
  bewertung: { key: 'bewertung', label: 'Bewertung', icon: 'list' },
  verbesserung: { key: 'verbesserung', label: UEMS_ZIELE_UND_MASSNAHMEN, icon: 'list' },
  energiemanagement: { key: 'energiemanagement', label: UEMS_ENERGIEMANAGEMENT, icon: 'file-text' },
  verbrauch: { key: 'verbrauch', label: 'Verbrauch', icon: 'zap' },
};

/** Ein Standort misst: „Messen & Auswerten" ist eingerichtet, angehalten oder aktiv — ein Entwurf misst noch nicht. */
const MISST: ReadonlySet<FunktionZustand> = new Set<FunktionZustand>(['eingerichtet', 'angehalten', 'aktiv']);

export const misst = (lm: EbenenLesemodell, standortId: string) =>
  MISST.has(lm.funktionen?.standorte.find((f) => f.id === standortId)?.messen.zustand ?? 'kein_objekt');

/**
 * UEMS AP-13 IP-11 (E2 = A, O18): misst der Standort, an dem DIESE Anlage steht? Nur dann bekommt das
 * Anlagen-Cockpit den EINEN Weg „Messstellen dieser Anlage“ — und fragt dafür überhaupt eine Route.
 * Unbekannt ist nie „ja“: ohne Lesemodell und ohne Standort für die Anlage bleibt es beim Cockpit von
 * gestern (ein reiner Betriebskunde sieht kein neues Wort).
 */
export function misstAnlage(lm: EbenenLesemodell, siteId: string): boolean {
  const standort = (lm.standorte ?? []).find((s) => s.zustand !== 'archiviert' && s.anlagen.some((a) => a.id === siteId));
  return standort !== undefined && misst(lm, standort.id);
}

/** Der Standort, wenn es ihn heute gibt und er nicht archiviert ist — sonst hat er keine Bereiche. */
const lebenderStandort = (lm: EbenenLesemodell, standortId: string) =>
  (lm.standorte ?? []).find((s) => s.id === standortId && s.zustand !== 'archiviert') ?? null;

/**
 * ALLE Bereiche, die es auf der Ebene nach der Tabelle AP-01 §4.6 gibt — aus
 * den Lesemodellen, nie aus einer festen Liste. Ob ein Bereich schon eine
 * Seite hat, entscheidet erst {@link ebenenLeiste}.
 *
 * - Unternehmen: Übersicht immer · Standorte ab 2 Standorten · Messstellen und
 *   Bezugsgrößen und Berichte, sobald ein Standort misst · Kennzahlen, sobald ein Standort misst
 *   UND es eine Kennzahl gibt · Bewertung, sobald ein Standort misst UND die Person
 *   Energieeinsätze sehen darf (AP-16 IP-6) · Ziele und Maßnahmen nach derselben Regel mit
 *   `verbesserung.ansehen` (AP-18 IP-8).
 * - Standort: Übersicht immer · Aufbau, Messstellen und Netzanschlüsse, wenn
 *   DIESER Standort misst · Gebäude ab 1 Gebäude.
 *
 * ⚠ Einen Bereich „Steuerung" gibt es auf keiner der beiden Ebenen (Steuern-Regel
 * vom 15.09.2026): gesteuert wird je Anlage, und dort bleibt der Bereich
 * „Steuerung" in Seitenleiste und Leiste erreichbar — der Weg führt über die
 * Übersicht in die Anlage.
 */
export function ebenenBereiche(ort: EbenenOrt, lm: EbenenLesemodell): EbenenBereich[] {
  const out: EbenenBereichId[] = ['uebersicht'];
  if (ort.art === 'unternehmen') {
    const lebend = (lm.standorte ?? []).filter((s) => s.zustand !== 'archiviert');
    const irgendwoGemessen = lebend.some((s) => misst(lm, s.id));
    if (lebend.length >= 2) out.push('standorte');
    if (irgendwoGemessen) out.push('messstellen', 'bezugsgroessen');
    // Konzept Auswerten a1 (Entscheid 10.1): „Verbrauch“ liest Rangliste und Messabdeckung — dieselbe Regel und dasselbe
    // Recht wie die Bewertung (`energieeinsatz.ansehen`); er steht vor den Kennzahlen wie in der Gruppe „Auswerten“.
    if (irgendwoGemessen && lm.bewertung === true) out.push('verbrauch');
    if (irgendwoGemessen && (lm.kennzahlen ?? []).some((k) => k.archiviert_am == null)) out.push('kennzahlen');
    if (irgendwoGemessen) out.push('berichte');
    // AP-16 IP-6 (§5.1/§6.3): „Bewertung“ nach der Berichte-Regel — und nur, wer Energieeinsätze sehen darf.
    if (irgendwoGemessen && lm.bewertung === true) out.push('bewertung');
    // AP-18 IP-8 (§6.3): „Ziele und Maßnahmen“ neben Kennzahlen, Berichte, Bewertung — nur mit `verbesserung.ansehen`.
    if (irgendwoGemessen && lm.verbesserung === true) out.push('verbesserung');
    // AP-19 IP-9 (§6.3): „Energiemanagement“ als neunte Seite, nach derselben Regel mit `energiemanagement.ansehen`.
    if (irgendwoGemessen && lm.energiemanagement === true) out.push('energiemanagement');
  } else {
    const standort = lebenderStandort(lm, ort.standortId);
    if (standort) {
      if (misst(lm, standort.id)) out.push('aufbau');
      if ((standort.gebaeudeZahl ?? 0) >= 1) out.push('gebaeude');
      if (misst(lm, standort.id)) out.push('messstellen', 'netzanschluesse');
    }
  }
  return out.map((key) => EBENEN_BEREICH[key]);
}

/** Welche Seite ein Bereich im Portal hat; ein fehlender Eintrag = noch keine. */
export type EbenenSeiten = (ort: EbenenOrt, lm?: EbenenLesemodell) => Partial<Record<EbenenBereichId, Route>>;

/**
 * Die Seiten, die das Portal HEUTE für die Bereiche hat.
 *
 * ⚠ **Ein Bereich ohne Seite bekommt keine Kachel** (firstmate 001 vom
 * 15.09.2026, dieselbe Antwort wie an der Karte „Funktionen" in PR 771): eine
 * Kachel, die nirgendwohin führt, ist die Sackgasse, die das Portal nicht baut,
 * und „immer fünf Kacheln, auch leere" hat E4 ausdrücklich verworfen. Seit
 * AP-04 IP-5 haben die Messstellen beider Ebenen ihre Seite — beim
 * Referenzkunden steigt das Unternehmen damit auf drei Kacheln, und die Leiste
 * erscheint. Seit AP-11 IP-13 haben auch die Kennzahlen des Unternehmens ihre
 * Seite (`#/portfolio/kennzahlen`), seit AP-12 IP-13 die Berichte
 * (`#/portfolio/berichte`). AP-09 IP-9 ergänzt Bezugsgrößen als sechste Unternehmenswelt.
 *
 * Seit AP-13 IP-2 hat auch der Standort jede Seite: Gebäude (`#/standort/{id}/gebaeude`)
 * und — seit Boxen und Anlagen dort aufgegangen sind — den Aufbau (`…/aufbau`). Kennzahlen und
 * Berichte des Standorts (`…/kennzahlen`, `…/berichte`, Ü8) stehen hier als
 * Seiten, sind aber kein Bereich der Ebene (AP-01 §4.6) und werden darum nie
 * eine Kachel — ihr Einstieg ist {@link standortEinstiege}.
 */
export const EBENEN_SEITEN: EbenenSeiten = (ort, lm) =>
  ort.art === 'unternehmen'
    ? {
        uebersicht: pageRoute('portfolio'),
        standorte: pageRoute('portfolio-standorte'),
        messstellen: pageRoute('portfolio-messstellen'),
        bezugsgroessen: pageRoute('portfolio-bezugsgroessen'),
        kennzahlen: pageRoute('portfolio-kennzahlen'),
        berichte: pageRoute('portfolio-berichte'),
        bewertung: pageRoute('portfolio-bewertung'),
        verbesserung: pageRoute('portfolio-verbesserung'),
        energiemanagement: pageRoute('portfolio-energiemanagement'),
        verbrauch: pageRoute('portfolio-verbrauch'),
      }
    : {
        uebersicht: standortRoute(ort.standortId),
        messstellen: standortMessstellenRoute(ort.standortId),
        // AP-13 E2/Q2/O18 und AP-10 IP-13: diese Seiten nur mit Messfunktion.
        // Auch vorhandene Gebäude und Anlagen ändern den Betriebskunden nicht.
        ...(lm && misst(lm, ort.standortId) ? {
          // Der Aufbau des Standorts (früher „Boxen“ und „Anlagen“). Ein Betriebskunde baut im Aufbau seiner
          // Anlage — derselbe Baum; alte Lesezeichen landen bei ihm auf der Übersicht (O18).
          aufbau: standortBereichRoute(ort.standortId, 'aufbau'),
          netzanschluesse: standortBereichRoute(ort.standortId, 'netzanschluesse'),
          gebaeude: standortBereichRoute(ort.standortId, 'gebaeude'),
          kennzahlen: standortBereichRoute(ort.standortId, 'kennzahlen'),
          berichte: standortBereichRoute(ort.standortId, 'berichte'),
        } : {}),
      };

/** Direkte AP-13-Adressen fallen ohne Messfunktion wie vor AP-13 auf die Übersicht zurück. */
export function standortBereichFuer(route: Route, lm: EbenenLesemodell): Route['standortBereich'] {
  const bereich = route.standortBereich;
  if (route.page !== 'standort' || !route.standortId || !bereich || bereich === 'messstellen') return bereich;
  return EBENEN_SEITEN({ art: 'standort', standortId: route.standortId }, lm)[bereich] ? bereich : undefined;
}

/** Ein Einstieg der Standort-Übersicht in eine Welt, die am Standort keine Kachel hat (AP-13 IP-2). */
export interface StandortEinstieg {
  key: 'kennzahlen' | 'berichte';
  label: string;
  icon: IconName;
  ziel: Route;
}

/** Die Wörter der zwei Einstiege — zugleich die Überschriften der gefilterten Seiten (K3). */
export const STANDORT_KENNZAHLEN = 'Kennzahlen dieses Standorts';
export const STANDORT_BERICHTE = 'Berichte dieses Standorts';

/**
 * Die Einstiege der Standort-Übersicht in „Kennzahlen dieses Standorts“ und
 * „Berichte dieses Standorts“ (AP-13 IP-2, Ü8/K3; AP-12 §6.6: „Einstieg auf der
 * Standort-Seite“).
 *
 * ⚠ **Kennzahlen und Berichte sind am Standort KEINE Bereiche.** Die Tabelle
 * AP-01 §4.6 nennt dort Übersicht · Gebäude · Anlagen · Messstellen, und O17
 * zählt an Werk Ahrenberg vier Kacheln, an Werk Lindach drei. Wären sie
 * Bereiche, stünden sechs und fünf Kacheln in der Leiste — darum wohnen sie in
 * der Übersicht, wie Messwerte und Erlöse.
 *
 * Dieselben Bedingungen wie am Unternehmen, auf DIESEN Standort bezogen:
 * Berichte, sobald er misst; Kennzahlen, sobald er misst UND eine lebende
 * Kennzahl hier gilt (`standort_id` nennt den Standort ihres Geltungsbereichs —
 * Standort, Gebäude oder Prozess mit Ort im Standort). Ohne Seite kein Einstieg.
 */
export function standortEinstiege(
  ort: EbenenOrt,
  lm: EbenenLesemodell,
  seiten: EbenenSeiten = EBENEN_SEITEN,
): StandortEinstieg[] {
  if (ort.art !== 'standort') return [];
  const standort = lebenderStandort(lm, ort.standortId);
  if (!standort || !misst(lm, standort.id)) return [];
  const ziele = seiten(ort, lm);
  const out: StandortEinstieg[] = [];
  const hierGilt = (lm.kennzahlen ?? []).some((k) => k.archiviert_am == null && k.standort_id === standort.id);
  if (hierGilt && ziele.kennzahlen) {
    out.push({ key: 'kennzahlen', label: STANDORT_KENNZAHLEN, icon: 'trending-up', ziel: ziele.kennzahlen });
  }
  if (ziele.berichte) out.push({ key: 'berichte', label: STANDORT_BERICHTE, icon: 'file-text', ziel: ziele.berichte });
  return out;
}

/** E4 = A: unter drei Kacheln keine Leiste — dann navigieren die Reiter der Seite wie heute. */
export const EBENEN_LEISTE_AB = 3;

/**
 * Die REITER einer Ebene: dieselben Bereiche MIT Seite wie die Leiste, aber
 * ohne deren Schwelle — ab zwei (ein einzelner Reiter behauptete eine Wahl, die
 * es nicht gibt). Am Rechner sind sie der einzige Weg in einen Bereich: dort
 * gibt es auf dieser Ebene keine Seitenleisten-Bereiche (AP-04 IP-5).
 */
export function ebenenReiter(
  ort: EbenenOrt,
  lm: EbenenLesemodell,
  seiten: EbenenSeiten = EBENEN_SEITEN,
): EbenenKachel[] {
  const ziele = seiten(ort, lm);
  const reiter = ebenenBereiche(ort, lm).flatMap((b) => {
    const ziel = ziele[b.key];
    return ziel ? [{ ...b, ziel }] : [];
  });
  return reiter.length >= 2 ? reiter : [];
}

/** Höchstens so viele Kacheln trägt eine Telefon-Leiste — wie die Anlage mit ihren fünf Bereichen. */
export const LEISTE_HOECHSTENS = 5;

/**
 * Die GRUPPEN des Unternehmens — nach Arbeitsfragen statt nach Bereichen (Konzept „Energiemanagement ohne
 * Fachsprache“ K1, Entscheide D1/D2). Mit allen Rechten hat das Unternehmen neun Bereiche; neun Kacheln auf 375 px
 * sind je gut 40 px breit, und „Messstellen“ brach dort mitten im Wort. Seitenleiste und Telefon-Leiste tragen deshalb
 * höchstens fünf GRUPPEN in der Reihenfolge der Arbeit — sehen, messen, auswerten, verbessern, nachweisen (Konzept
 * „Navigation aus einem Guss“, N1); über der Seite stehen nur die Reiter der offenen Gruppe, ihre Frage steht unter dem
 * offenen Eintrag der Seitenleiste (N4).
 *
 * „Nachweisen“ trägt die Berichte und die Reiter des Energiemanagements (ohne zweite Reiterreihe); dessen
 * Wiedervorlage steht in der Übersicht, weil sie „Was steht an?“ beantwortet ({@link ebenenAktiv}). Adressen und
 * Rechte je Bereich bleiben, wie sie sind.
 *
 * Eine Gruppe ohne einen Bereich mit Seite gibt es nicht (Gesetz 1: nie eine
 * leere Kachel); ihr Ziel ist die Seite ihres ersten Bereichs in der Reihenfolge der Gruppe.
 */
export const UNTERNEHMEN_GRUPPEN: readonly {
  key: string;
  label: string;
  icon: IconName;
  frage: string;
  bereiche: readonly EbenenBereichId[];
}[] = [
  { key: 'uebersicht', label: 'Übersicht', icon: 'dashboard', frage: 'Läuft alles? Was steht an?', bereiche: ['uebersicht', 'standorte'] },
  { key: 'messen', label: 'Messen', icon: 'activity', frage: 'Wird alles erfasst?', bereiche: ['messstellen', 'bezugsgroessen'] },
  { key: 'auswerten', label: 'Auswerten', icon: 'trending-up', frage: 'Wo geht die Energie hin, wird es besser?', bereiche: ['verbrauch', 'kennzahlen', 'bewertung'] },
  { key: 'verbessern', label: 'Verbessern', icon: 'list', frage: 'Was tun wir dagegen?', bereiche: ['verbesserung'] },
  // Konzept Nachweisen n1, Entscheid 1: statt „Können wir es belegen?“ - „es“ blieb offen.
  { key: 'nachweisen', label: 'Nachweisen', icon: 'file-text', frage: 'Können wir belegen, was wir tun?', bereiche: ['energiemanagement', 'berichte'] },
];

/** Kürzere Telefon-Beschriftungen am Standort; Seitenleiste, Reiter und Überschriften behalten die vollen Wörter. */
const LEISTE_KURZ: Partial<Record<EbenenBereichId, string>> = {
  netzanschluesse: 'Anschlüsse',
};

/** Die Bereiche einer Ebene MIT Seite, in der Reihenfolge von {@link ebenenBereiche}. */
function bereicheMitSeite(ort: EbenenOrt, lm: EbenenLesemodell, seiten: EbenenSeiten): EbenenKachel[] {
  const ziele = seiten(ort, lm);
  return ebenenBereiche(ort, lm).flatMap((b) => {
    const ziel = ziele[b.key];
    return ziel ? [{ ...b, ziel }] : [];
  });
}

/**
 * Die GRUPPEN des Unternehmens mit Seite ({@link UNTERNEHMEN_GRUPPEN}) — erst ab drei, wie die Leiste. Darunter misst
 * noch kein Standort; dann gelten die Einträge der Flotte ({@link flottenEintraege}), und `[]` heißt: keine Gruppen.
 */
export function unternehmensGruppen(lm: EbenenLesemodell, seiten: EbenenSeiten = EBENEN_SEITEN): EbenenLeistenKachel[] {
  const mitSeite = bereicheMitSeite({ art: 'unternehmen' }, lm, seiten);
  const gruppen = UNTERNEHMEN_GRUPPEN.flatMap((g) => {
    // In der Reihenfolge der Gruppe: „Nachweisen“ öffnet das Verzeichnis, ohne Energiemanagement die Berichte.
    const drin = g.bereiche.flatMap((key) => mitSeite.filter((b) => b.key === key));
    return drin.length > 0
      ? [{ key: g.key, label: g.label, icon: g.icon, ziel: drin[0].ziel, bereiche: drin.map((b) => b.key), frage: g.frage }]
      : [];
  });
  return gruppen.length >= EBENEN_LEISTE_AB ? gruppen.slice(0, LEISTE_HOECHSTENS) : [];
}

/**
 * N3 (Konzept „Navigation aus einem Guss“): die Einträge der FLOTTE — „Meine Anlagen“, „Portfolio“ und ein Unternehmen,
 * an dem noch kein Standort misst. Es sind die Seiten, die bisher Reiter der Flotte waren: Übersicht · Standorte ·
 * Energie · Erlöse. „Erlöse“ nur mit Geld (wie der Reiter bisher) oder wenn die Seite gerade offen ist — eine offene
 * Seite ohne Eintrag wäre eine Sackgasse.
 */
export function flottenEintraege(i: { standorte: boolean; geldWelt: boolean; offen?: PageId | null }): EbenenLeistenKachel[] {
  const out: EbenenLeistenKachel[] = [
    { key: 'uebersicht', label: 'Übersicht', icon: 'dashboard', ziel: pageRoute('portfolio'), bereiche: ['uebersicht'], seiten: ['portfolio'] },
  ];
  if (i.standorte) {
    out.push({ key: 'standorte', label: 'Standorte', icon: 'map-pin', ziel: pageRoute('portfolio-standorte'), bereiche: ['standorte'], seiten: ['portfolio-standorte'] });
  }
  out.push({ key: 'energie', label: 'Energie', icon: 'activity', ziel: pageRoute('portfolio-messwerte'), bereiche: [], seiten: ['portfolio-messwerte'] });
  if (i.geldWelt || i.offen === 'portfolio-erloese') {
    out.push({ key: 'erloese', label: 'Erlöse', icon: 'euro', ziel: pageRoute('portfolio-erloese'), bereiche: [], seiten: ['portfolio-erloese'] });
  }
  return out;
}

/**
 * Die EINTRÄGE einer Ebene (Konzept „Navigation aus einem Guss“, R1/R2) — dieselben in der Seitenleiste am Rechner
 * und in der Telefon-Leiste, damit beide nie auseinanderlaufen: am Standort seine Bereiche mit Seite, am Unternehmen
 * seine Gruppen, ohne Messfunktion die Seiten der Flotte (N3). Höchstens fünf.
 */
export function ebenenEintraege(
  ort: EbenenOrt,
  lm: EbenenLesemodell,
  seiten: EbenenSeiten = EBENEN_SEITEN,
  offen: PageId | null = null,
): EbenenLeistenKachel[] {
  if (ort.art === 'unternehmen') {
    const gruppen = unternehmensGruppen(lm, seiten);
    if (gruppen.length > 0) return gruppen;
    const standorte = ebenenBereiche(ort, lm).some((b) => b.key === 'standorte');
    return flottenEintraege({ standorte, geldWelt: lm.geldWelt === true, offen });
  }
  return bereicheMitSeite(ort, lm, seiten)
    .map((b) => ({ key: b.key, label: b.label, kurz: LEISTE_KURZ[b.key], icon: b.icon, ziel: b.ziel, bereiche: [b.key] }))
    .slice(0, LEISTE_HOECHSTENS);
}

/**
 * Die Leiste einer Ebene — Telefon-Leiste und Seitenleiste zugleich: die Einträge ({@link ebenenEintraege}), erst ab
 * drei (E4 = A); darunter keine, und die Reiter der Seite navigieren wie bisher. `--vp-bar-slots` folgt der Zahl wie
 * in der Anlage.
 */
export function ebenenLeiste(
  ort: EbenenOrt,
  lm: EbenenLesemodell,
  seiten: EbenenSeiten = EBENEN_SEITEN,
  offen: PageId | null = null,
): EbenenLeistenKachel[] {
  const eintraege = ebenenEintraege(ort, lm, seiten, offen);
  return eintraege.length >= EBENEN_LEISTE_AB ? eintraege : [];
}

/**
 * Welcher Eintrag leuchtet: der, dessen Seiten die offene Seite nennen (Einträge der Flotte), sonst der, der den
 * offenen Bereich trägt (`ebenenAktiv`). `null` = keiner — dann leuchtet auch nichts.
 */
export function aktiverEintrag(
  eintraege: readonly EbenenLeistenKachel[],
  page: PageId,
  aktiv: EbenenBereichId | null,
): string | null {
  const nachSeite = eintraege.find((e) => e.seiten?.includes(page));
  if (nachSeite) return nachSeite.key;
  if (!aktiv) return null;
  return eintraege.find((e) => e.bereiche.includes(aktiv))?.key ?? null;
}

/**
 * R4 (Konzept „Navigation aus einem Guss“): eine DETAILSEITE — eine Kennzahl, ein Bericht, ein Energieeinsatz, ein
 * Energieziel, eine Maßnahme, eine Abweichung, ein Eintrag des Energiemanagements, eine Messstelle. Sie zeigt ihren
 * Rückweg („‹ Alle Kennzahlen“) statt der Reiter des Bereichs.
 */
export function istDetailseite(route: Route): boolean {
  return Boolean(
    route.kennzahlId || route.berichtKennung || route.energieeinsatzId || route.energiezielId || route.massnahmeId ||
      route.abweichungId || route.dokumentId || route.personId || route.auditId || route.feststellungId ||
      route.managementbewertungKennung || route.mappeId || route.messstelleId || route.bezugsgroesseId,
  );
}

/**
 * Die Bereiche, deren Reiter am TELEFON über der Seite stehen: die der Kachel,
 * die den offenen Bereich trägt (ihre Gruppe). Ohne Leiste oder ohne passende
 * Kachel `null` — dann gilt die Regel von vorher.
 */
export function telefonReiterBereiche(
  kacheln: readonly EbenenLeistenKachel[],
  aktiv: EbenenBereichId | null,
): readonly EbenenBereichId[] | null {
  if (!aktiv) return null;
  return kacheln.find((k) => k.bereiche.includes(aktiv))?.bereiche ?? null;
}

/**
 * Die Ebene, die eine Seite OHNE Anlage zeigt: `#/standort/{id}` den Standort,
 * die Portfolio-Seiten die oberste Ebene (Unternehmen, oder den Standort, wenn
 * er die oberste ist). `null` = keine Ebene — ohne Standorte bleibt alles wie
 * vorher, also auch ohne Leiste.
 */
export function ebenenOrt(
  route: Route,
  oben: { art: string; standort?: { id: string } },
): EbenenOrt | null {
  if (route.page === 'standort') return route.standortId ? { art: 'standort', standortId: route.standortId } : null;
  if (!isPortfolioPage(route.page)) return null;
  if (oben.art === 'unternehmen') return { art: 'unternehmen' };
  if (oben.art === 'standort' && oben.standort) return { art: 'standort', standortId: oben.standort.id };
  return null;
}

/**
 * Der Bereich, in dem eine Seite der Ebene wohnt — die Reiter Messwerte · Erlöse
 * gehören zur Übersicht. `standortBereich` ist der der Standort-Route
 * (`#/standort/{id}/messstellen`, AP-04 IP-5; Gebäude und Anlagen AP-13 IP-2).
 * Kennzahlen und Berichte des Standorts wohnen in seiner Übersicht — dort ist
 * ihr Einstieg ({@link standortEinstiege}).
 */
export function ebenenAktiv(
  page: PageId,
  standortBereich?: Route['standortBereich'],
  energiemanagementReiter?: Route['energiemanagementReiter'],
): EbenenBereichId | null {
  // Unternehmenseinstellungen werden über das Avatar-Menü geöffnet, ohne fachlichen Reiter.
  if (page === 'kunden-benutzer') return null;
  // K1: die Wiedervorlage beantwortet „Was steht an?“ — sie wohnt in der Übersicht, ihre Adresse bleibt.
  if (page === 'portfolio-energiemanagement' && energiemanagementReiter === 'wiedervorlage') return 'uebersicht';
  if (page === 'portfolio-standorte') return 'standorte';
  if (page === 'standort' && (standortBereich === 'aufbau' || standortBereich === 'gebaeude' || standortBereich === 'netzanschluesse')) return standortBereich;
  if (page === 'portfolio-messstellen' || (page === 'standort' && standortBereich === 'messstellen')) return 'messstellen';
  if (page === 'portfolio-bezugsgroessen') return 'bezugsgroessen';
  if (page === 'portfolio-kennzahlen') return 'kennzahlen';
  if (page === 'portfolio-berichte') return 'berichte';
  if (page === 'portfolio-bewertung') return 'bewertung';
  if (page === 'portfolio-verbrauch') return 'verbrauch';
  if (page === 'portfolio-verbesserung') return 'verbesserung';
  if (page === 'portfolio-energiemanagement') return 'energiemanagement';
  return page === 'standort' || isPortfolioPage(page) ? 'uebersicht' : null;
}

/** Der Name der Leiste für Screenreader („Bereiche des Standorts Werk Ahrenberg"). */
export function ebenenTitel(ort: EbenenOrt, lm: EbenenLesemodell, unternehmen: string): string {
  if (ort.art === 'unternehmen') return `Bereiche des Unternehmens ${unternehmen}`;
  const name = lm.standorte?.find((s) => s.id === ort.standortId)?.name;
  return name ? `Bereiche des Standorts ${name}` : 'Bereiche des Standorts';
}
