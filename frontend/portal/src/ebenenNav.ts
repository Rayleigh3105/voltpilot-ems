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
import { UEMS_ENERGIEBILANZ } from './glossar';
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
export const VERLAUF_TABS: { key: string; label: string; sub: AnlagenSub; view: DeepViewId | null }[] = [
  { key: 'messwerte', label: 'Messwerte', sub: 'messwerte', view: null },
  { key: 'erloese', label: 'Erlöse', sub: 'erloese', view: 'erloes-historie' },
  { key: 'marktpreise', label: 'Marktpreise', sub: 'marktpreise', view: 'marktpreise' },
  { key: 'lastspitzen', label: 'Lastspitzen', sub: 'lastspitzen', view: 'lastspitzen' },
  { key: 'prognose', label: 'Prognose', sub: 'prognose', view: 'prognosequalitaet' },
  { key: 'wetter', label: 'Wetter', sub: 'wetter', view: 'wetter' },
];

/**
 * Die REITER des Bereichs „Anlage": Komponenten · Einstellungen. Beide sind
 * STRUKTURELL da (sie folgen keinem Modus).
 *
 * ⚠ **„Befehle an Geräte" ist als SEITEN-Reiter ERSATZLOS entfallen**
 * (Captain-Auftrag 27.08.2026): Gerätebefehle stehen ausschließlich auf der
 * jeweiligen Geräte-Detailseite. Die Route `befehle` bleibt gültig (jeder
 * per-Gerät-Absprung `…/befehle?geraet=` / `…?komponente=` funktioniert weiter)
 * — sie hat nur keinen eigenen Reiter mehr und hebt wie {@link SUB_BEREICH}
 * `geraet`/`box` ihren Wirt, den Bereich „Anlage", hervor.
 */
const ANLAGE_TABS: BereichTab[] = [
  // ⚠ „Komponenten", nicht „Modell": seit Steuerung Stufe 8 heisst der Reiter
  // wie das, was er zeigt (Konzept `vp-steuerung-konzept-b3` §3.9 — „Komponenten
  // & Regeln" → „Komponenten"; die Regeln wohnen in der Steuerung, EIN Ort je
  // Sache). Der SCHLÜSSEL `modell` und die Route bleiben — jedes Lesezeichen gilt.
  { key: 'modell', label: 'Komponenten', sub: 'modell' },
  { key: 'technik', label: 'Einstellungen', sub: 'technik' },
];

/** Welcher Bereich eine Unterseite beherbergt — die EINE Zuordnung. */
const SUB_BEREICH: Record<AnlagenSub, BereichId> = {
  fahrplan: 'fahrplan',
  ladevorgaenge: 'fahrplan',
  messwerte: 'verlauf',
  energiebilanz: 'verlauf',
  erloese: 'verlauf',
  marktpreise: 'verlauf',
  lastspitzen: 'verlauf',
  prognose: 'verlauf',
  wetter: 'verlauf',
  steuerung: 'steuerung',
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

  const verlaufTabs: BereichTab[] = VERLAUF_TABS.filter((t) => t.view === null || views.includes(t.view)).map(
    ({ key, label, sub }) => ({ key, label, sub }),
  );
  // UEMS AP-13 IP-8 (E7 = A): „Energiebilanz“ direkt nach „Messwerte“ — NUR mit Hauptzähler in der Stellung
  // (`surface.energiebilanz`, gesetzt von `anlageEnergiebilanz.mitEnergiebilanz`). Ohne den Fakt bleibt der Verlauf
  // zeichengleich (Bestandsschutz, AP-13 E2). Bewusst KEIN `VERLAUF_TABS`-Eintrag: der Reiter hängt an keiner Ansicht
  // der Projektion und trägt nie Geld (`anlageGeld.GELD_UNTERSEITEN` liest nur Reiter mit Ansicht).
  if (surface?.energiebilanz) {
    verlaufTabs.splice(1, 0, { key: 'energiebilanz', label: UEMS_ENERGIEBILANZ, sub: 'energiebilanz' });
  }
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
 * EINE Seite ist (Cockpit, Steuerung), wo er nur einen Reiter hätte oder wo die
 * Unterseite eine Ebene unter ihm wohnt ({@link OHNE_BEREICHS_REITER}).
 *
 * ⚠ Sie kommen aus DEMSELBEN Modell wie die Seitenleiste. Eine zweite
 * Ableitung ließe Leiste und Reiter über dieselbe Anlage Verschiedenes
 * behaupten.
 */
export function tabsFor(sidebar: AnlageSidebar, sub: AnlagenSub | null): BereichTab[] {
  if (sub != null && OHNE_BEREICHS_REITER.has(sub)) return [];
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

// ---------------------------------------------------------------------------
// Die Ebenen ÜBER der Anlage: Unternehmen und Standort (UEMS AP-01 IP-7, E4 = A)
// ---------------------------------------------------------------------------

/**
 * Die Bereiche einer Ebene über der Anlage (AP-01 §4.6). Unternehmen:
 * Übersicht · Standorte · Messstellen · Kennzahlen · Berichte. Standort:
 * Übersicht · Gebäude · Anlagen · Messstellen. Die Anlage oben behält ihre fünf
 * Bereiche — dieselbe Regel, eine Ebene tiefer, unverändert.
 */
export type EbenenBereichId =
  | 'uebersicht'
  | 'standorte'
  | 'gebaeude'
  | 'anlagen'
  | 'messstellen'
  | 'kennzahlen'
  | 'berichte';

export interface EbenenBereich {
  key: EbenenBereichId;
  label: string;
  icon: IconName;
}

/** Eine Kachel der Telefon-Leiste einer Ebene: ein Bereich MIT seiner Seite. */
export interface EbenenKachel extends EbenenBereich {
  ziel: Route;
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
}

const EBENEN_BEREICH: Record<EbenenBereichId, EbenenBereich> = {
  uebersicht: { key: 'uebersicht', label: 'Übersicht', icon: 'dashboard' },
  standorte: { key: 'standorte', label: 'Standorte', icon: 'map-pin' },
  gebaeude: { key: 'gebaeude', label: 'Gebäude', icon: 'building' },
  anlagen: { key: 'anlagen', label: 'Anlagen', icon: 'layers' },
  messstellen: { key: 'messstellen', label: 'Messstellen', icon: 'activity' },
  kennzahlen: { key: 'kennzahlen', label: 'Kennzahlen', icon: 'trending-up' },
  berichte: { key: 'berichte', label: 'Berichte', icon: 'file-text' },
};

/** Ein Standort misst: „Messen & Auswerten" ist eingerichtet, angehalten oder aktiv — ein Entwurf misst noch nicht. */
const MISST: ReadonlySet<FunktionZustand> = new Set<FunktionZustand>(['eingerichtet', 'angehalten', 'aktiv']);

const misst = (lm: EbenenLesemodell, standortId: string) =>
  MISST.has(lm.funktionen?.standorte.find((f) => f.id === standortId)?.messen.zustand ?? 'kein_objekt');

/** Der Standort, wenn es ihn heute gibt und er nicht archiviert ist — sonst hat er keine Bereiche. */
const lebenderStandort = (lm: EbenenLesemodell, standortId: string) =>
  (lm.standorte ?? []).find((s) => s.id === standortId && s.zustand !== 'archiviert') ?? null;

/**
 * ALLE Bereiche, die es auf der Ebene nach der Tabelle AP-01 §4.6 gibt — aus
 * den Lesemodellen, nie aus einer festen Liste. Ob ein Bereich schon eine
 * Seite hat, entscheidet erst {@link ebenenLeiste}.
 *
 * - Unternehmen: Übersicht immer · Standorte ab 2 Standorten · Messstellen und
 *   Berichte, sobald ein Standort misst · Kennzahlen, sobald ein Standort misst
 *   UND es eine Kennzahl gibt.
 * - Standort: Übersicht immer · Gebäude ab 1 Gebäude · Anlagen ab 2 Anlagen ·
 *   Messstellen, wenn DIESER Standort misst.
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
    if (irgendwoGemessen) out.push('messstellen');
    if (irgendwoGemessen && (lm.kennzahlen ?? []).some((k) => k.archiviert_am == null)) out.push('kennzahlen');
    if (irgendwoGemessen) out.push('berichte');
  } else {
    const standort = lebenderStandort(lm, ort.standortId);
    if (standort) {
      if ((standort.gebaeudeZahl ?? 0) >= 1) out.push('gebaeude');
      if (standort.anlagen.length >= 2) out.push('anlagen');
      if (misst(lm, standort.id)) out.push('messstellen');
    }
  }
  return out.map((key) => EBENEN_BEREICH[key]);
}

/** Welche Seite ein Bereich im Portal hat; ein fehlender Eintrag = noch keine. */
export type EbenenSeiten = (ort: EbenenOrt) => Partial<Record<EbenenBereichId, Route>>;

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
 * (`#/portfolio/berichte`) — Ahrenberg hat damit FÜNF Kacheln.
 *
 * Seit AP-13 IP-2 hat auch der Standort jede Seite: Gebäude und Anlagen
 * (`#/standort/{id}/gebaeude`, `…/anlagen`) — Werk Ahrenberg bekommt damit VIER
 * Kacheln und die Leiste, Werk Lindach (eine Anlage) DREI (O17). Kennzahlen und
 * Berichte des Standorts (`…/kennzahlen`, `…/berichte`, Ü8) stehen hier als
 * Seiten, sind aber kein Bereich der Ebene (AP-01 §4.6) und werden darum nie
 * eine Kachel — ihr Einstieg ist {@link standortEinstiege}.
 */
export const EBENEN_SEITEN: EbenenSeiten = (ort) =>
  ort.art === 'unternehmen'
    ? {
        uebersicht: pageRoute('portfolio'),
        standorte: pageRoute('portfolio-standorte'),
        messstellen: pageRoute('portfolio-messstellen'),
        kennzahlen: pageRoute('portfolio-kennzahlen'),
        berichte: pageRoute('portfolio-berichte'),
      }
    : {
        uebersicht: standortRoute(ort.standortId),
        gebaeude: standortBereichRoute(ort.standortId, 'gebaeude'),
        anlagen: standortBereichRoute(ort.standortId, 'anlagen'),
        messstellen: standortMessstellenRoute(ort.standortId),
        kennzahlen: standortBereichRoute(ort.standortId, 'kennzahlen'),
        berichte: standortBereichRoute(ort.standortId, 'berichte'),
      };

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
  const ziele = seiten(ort);
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
  const ziele = seiten(ort);
  const reiter = ebenenBereiche(ort, lm).flatMap((b) => {
    const ziel = ziele[b.key];
    return ziel ? [{ ...b, ziel }] : [];
  });
  return reiter.length >= 2 ? reiter : [];
}

/**
 * Die Telefon-Leiste einer Ebene: ihre Bereiche MIT Seite, in der Reihenfolge
 * der Tabelle — oder keine (leer), wenn es weniger als drei sind.
 * `--vp-bar-slots` folgt der Zahl wie in der Anlage.
 */
export function ebenenLeiste(
  ort: EbenenOrt,
  lm: EbenenLesemodell,
  seiten: EbenenSeiten = EBENEN_SEITEN,
): EbenenKachel[] {
  const ziele = seiten(ort);
  const kacheln = ebenenBereiche(ort, lm).flatMap((b) => {
    const ziel = ziele[b.key];
    return ziel ? [{ ...b, ziel }] : [];
  });
  return kacheln.length >= EBENEN_LEISTE_AB ? kacheln : [];
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
export function ebenenAktiv(page: PageId, standortBereich?: Route['standortBereich']): EbenenBereichId | null {
  if (page === 'portfolio-standorte') return 'standorte';
  if (page === 'standort' && (standortBereich === 'gebaeude' || standortBereich === 'anlagen')) return standortBereich;
  if (page === 'portfolio-messstellen' || (page === 'standort' && standortBereich === 'messstellen')) return 'messstellen';
  if (page === 'portfolio-kennzahlen') return 'kennzahlen';
  if (page === 'portfolio-berichte') return 'berichte';
  return page === 'standort' || isPortfolioPage(page) ? 'uebersicht' : null;
}

/** Der Name der Leiste für Screenreader („Bereiche des Standorts Werk Ahrenberg"). */
export function ebenenTitel(ort: EbenenOrt, lm: EbenenLesemodell, unternehmen: string): string {
  if (ort.art === 'unternehmen') return `Bereiche des Unternehmens ${unternehmen}`;
  const name = lm.standorte?.find((s) => s.id === ort.standortId)?.name;
  return name ? `Bereiche des Standorts ${name}` : 'Bereiche des Standorts';
}
