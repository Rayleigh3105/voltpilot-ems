/**
 * Page registry + tiny hash router for the unified dashboard shell.
 * Keycloak's redirect response lands in the query string (auth.ts sets
 * responseMode 'query'), so the hash stays free for navigation and survives
 * the login round-trip.
 *
 * IA (captain decision 2026-07-07, "Anlagen-Seite"; evolved by M1 #529): the
 * customer nav is Übersicht / Meine Anlage(n) plus, per SELECTED Anlage, the
 * shell trio Übersicht · Steuerung · Geräte (`ebenenNav.ts`) and — only while
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
  | 'kunden-benutzer'
  | 'meldungen'
  | 'einstellungen'
  | 'hilfe'
  | 'portfolio'
  | 'portfolio-standorte'
  | 'portfolio-messstellen'
  | 'portfolio-bezugsgroessen'
  | 'portfolio-kennzahlen'
  | 'portfolio-berichte'
  | 'portfolio-bewertung'
  | 'portfolio-verbrauch'
  | 'portfolio-verbesserung'
  | 'portfolio-energiemanagement'
  | 'portfolio-messwerte'
  | 'portfolio-erloese'
  | 'standort'
  | 'uebersicht'
  | 'anlagen'
  | 'plattform-uebersicht'
  | 'mandanten'
  | 'geraete-registry'
  | 'edge-updates'
  | 'fernwartung'
  | 'werkstatt'
  | 'optimizer'
  | 'vorlagen'
  | 'komponenten-flotte'
  | 'steuerungs-freigabe'
  | 'flows'
  | 'katalog';

/** Subpages of one Anlage (the deep views behind the Anlagen-Seite). */
export type AnlagenSub =
  | 'fahrplan'
  | 'messwerte'
  // UEMS AP-13 IP-8: die Energiebilanz je Anlage — ein Reiter des Verlaufs, nur mit Hauptzähler in der Stellung.
  | 'energiebilanz'
  | 'erloese'
  // Die einzelnen Messwerte und Summenwerte (Verlauf-Rework P3): der frühere
  // Aufklapper der Energie-Seite als eigener Reiter „Messwerte".
  | 'einzelwerte'
  // Marktpreise und Prognose sind seit der Navigations-Runde „zwei Ebenen"
  // (r2 §5.5, E3) Unterseiten DER ANLAGE statt Seiten daneben: sie beantworten
  // eine Frage ÜBER diese Anlage (ihr Börsentarif, ihr Prognosemodell) und
  // standen trotzdem ausserhalb - Befund N3. Ihre alten Adressen leiten um
  // (`LEGACY_ROUTES`), also gilt jedes Lesezeichen weiter.
  | 'marktpreise'
  | 'prognose'
  | 'wetter'
  | 'technik'
  | 'modell'
  | 'steuerung'
  // Die Reiter der Steuerung (Konzept `docs/konzepte/steuerung`, E4 = A):
  // „Geräte" ist `steuerung` selbst (jedes Lesezeichen gilt weiter), „Laden"
  // steht nur, wo es Ladepunkte gibt, „Regeln" immer.
  | 'laden'
  | 'regeln'
  | 'lastspitzen'
  | 'ladevorgaenge'
  | 'befehle'
  | 'geraet'
  | 'box';

const SUBS = new Set<string>([
  'fahrplan', 'messwerte', 'erloese', 'einzelwerte', 'marktpreise', 'prognose', 'wetter',
  'technik', 'modell', 'steuerung', 'laden', 'regeln', 'lastspitzen', 'ladevorgaenge', 'befehle',
  'geraet', 'box', 'energiebilanz',
]);

/**
 * Retired subpage hashes that redirect so bookmarks never break (the
 * LEGACY_ROUTES discipline, at the sub level):
 * - `optimierung` -> `steuerung` (U3: "Optimierung" merged into Steuerung).
 * - `entitaeten` -> `modell` (Portal v3 M6: the "Geräte & Entitäten" list
 *   became the Anlagen-Modell — Gerät/Komponente/Messwert).
 * - `profile` -> `steuerung` (v3.1-M2: the standalone „Anwendungen" shelf became
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
  /**
   * Nur bei `page === 'standort'` gesetzt: WELCHER Standort die
   * Standort-Übersicht ist (UEMS AP-01 IP-5, `#/standort/{id}`). Absent bei
   * jeder anderen Route - wie `geraet`.
   */
  standortId?: string;
  /**
   * Nur bei `page === 'standort'`: eine Seite des Standorts statt seiner
   * Übersicht (UEMS AP-04 IP-5 `#/standort/{id}/messstellen`, AP-13 IP-2
   * `…/gebaeude`, `…/anlagen`, `…/kennzahlen`, `…/berichte`). Absent = die
   * Übersicht — jede bestehende Standort-Route bleibt unverändert.
   */
  standortBereich?: StandortBereich;
  /**
   * Nur bei `page === 'portfolio-kennzahlen'` oder am Standort mit
   * `standortBereich: 'kennzahlen'`: WELCHE Kennzahl die Seite zeigt (UEMS
   * AP-11 IP-13 `#/portfolio/kennzahlen/{id}`, AP-13 IP-2
   * `#/standort/{sid}/kennzahlen/{id}`). Absent = die Liste.
   */
  kennzahlId?: string;
  /**
   * Nur mit `kennzahlId`: die Ebene unter der Kennzahl-Seite (Konzept Auswerten a1 §6.6) -
   * `bezugsbasis` = `…/kennzahlen/{id}/bezugsbasis` (Fassungen, Freigaben, Überprüfung). Absent = die Seite.
   */
  kennzahlEbene?: 'bezugsbasis';
  /**
   * Nur bei `page === 'portfolio-berichte'` oder am Standort mit
   * `standortBereich: 'berichte'`: WELCHER Bericht die Seite zeigt (UEMS
   * AP-12 IP-13 `#/portfolio/berichte/{kennung}`, AP-13 IP-2
   * `#/standort/{sid}/berichte/{kennung}`). Absent = die Liste.
   */
  berichtKennung?: string;
  /**
   * Nur bei `page === 'portfolio-verbrauch'`: WELCHER Energieeinsatz die Seite zeigt (Konzept Auswerten a1, Entscheid
   * 10.1: `#/portfolio/verbrauch/{id}`; bis dahin UEMS AP-16 IP-6 `#/portfolio/bewertung/{id}`, das weiterleitet).
   * Absent = die Verteilung.
   */
  energieeinsatzId?: string;
  /**
   * Nur bei `page === 'portfolio-verbesserung'` (UEMS AP-18 IP-8): der Reiter des Bereichs „Ziele und Maßnahmen“
   * (`#/portfolio/verbesserung/massnahmen` · `…/abweichungen`; absent = Energieziele) und WELCHES Energieziel die Seite
   * zeigt (`#/portfolio/verbesserung/energieziele/{id}`).
   */
  verbesserungReiter?: VerbesserungReiter;
  energiezielId?: string;
  /** UEMS AP-18 IP-13: WELCHE Maßnahme die Seite zeigt (`#/portfolio/verbesserung/massnahmen/{id}`). */
  massnahmeId?: string;
  /** UEMS AP-18 IP-18: WELCHE Abweichung die Seite zeigt (`#/portfolio/verbesserung/abweichungen/{id}`). */
  abweichungId?: string;
  /**
   * Nur bei `page === 'portfolio-energiemanagement'` (UEMS AP-19 IP-9): der Reiter des Bereichs „Energiemanagement“
   * (`#/portfolio/energiemanagement/dokumente`, `…/zuschnitt` die Zuschnitt-Hilfe; absent = Überblick, seit Konzept
   * Nachweisen n1; `…/verzeichnis` das Verzeichnis eine Ebene tiefer) und WELCHES
   * Dokument die Seite zeigt (`#/portfolio/energiemanagement/dokumente/{id}`). Seit IP-13 die Reiter `aufgaben` und
   * `verantwortung` („Wer ist wofür verantwortlich“, eine Ansicht unter „Aufgaben“) und WELCHE Person die Seite zeigt
   * (`#/portfolio/energiemanagement/personen/{id}`). Seit IP-20 die Reiter `audits` und `feststellungen` und WELCHES
   * Audit bzw. WELCHE Feststellung die Seite zeigt (`…/audits/{id}`, `…/feststellungen/{id}`) — statt der Kennung darf
   * das Kennzeichen stehen (`…/feststellungen/F-2029-0001`), so springt die Maßnahmen-Seite zu ihrer Herkunft (SP5).
   * Seit IP-24 die Reiter `wiedervorlage` und `managementbewertung` und WELCHE Managementbewertung die Seite zeigt
   * (`…/managementbewertung/BR-2029-0001` — die Kennung des Berichts).
   */
  energiemanagementReiter?: EnergiemanagementReiter;
  dokumentId?: string;
  personId?: string;
  auditId?: string;
  feststellungId?: string;
  managementbewertungKennung?: string;
  /** Konzept Nachweisen n1, Entscheid 7: WELCHE Mappe „Unterlagen zusammenstellen“ die Seite zeigt (`…/mappen/{id}`). */
  mappeId?: string;
  /**
   * Nur im Bereich „Messstellen“ (`portfolio-messstellen` oder `standort` mit
   * `standortBereich: 'messstellen'`): WELCHE Messstelle die Seite zeigt (UEMS
   * AP-04 IP-8, `#/portfolio/messstellen/{id}` bzw. `#/standort/{sid}/messstellen/{id}`).
   * Absent = das Register.
   */
  messstelleId?: string;
  /**
   * Nur bei `portfolio-bezugsgroessen`: WELCHE Bezugsgröße die Seite zeigt (Konzept Messen m1 §6.8, Entscheid 9,
   * `#/portfolio/bezugsgroessen/{id}`). Absent = die Liste.
   */
  bezugsgroesseId?: string;
  /** Global handbook article; never scoped to a tenant or Anlage. */
  helpArticle?: string;
  /**
   * Nur bei `page === 'geraete-registry'` MIT Referenz: die GERÄTEAKTE einer
   * Box statt der Geräte-Liste (Konzept `vp-adminview-konzept-k1` §4.2/4.4,
   * Scheibe S2) - `#/plattform/geraete/{ref}[/software|verbindung|einrichtung|verlauf]`.
   * Absent = die Liste. Der Reiter „Anlage" kommt erst mit S3.
   */
  geraeteAkte?: { ref: string; reiter: GeraeteAkteReiter | null };
}

/** Ein Reiter der Geräteakte (§4.4). „Anlage" fehlt bewusst - er kommt erst mit S3. */
export type GeraeteAkteReiter = 'software' | 'verbindung' | 'einrichtung' | 'verlauf';

const GERAETE_AKTE_REITER = new Set<string>(['software', 'verbindung', 'einrichtung', 'verlauf']);

/**
 * Das Ziel einer Geräte-Detailseite: die REFERENZ der VoltPilot-Box, dahinter
 * optional die Kennung eines Geräts AN ihr (`inverter` = das Hauptgerät,
 * `src-…` = eine gemeldete Quelle, `cp-…` = eine OCPP-Säule).
 *
 * **Der Schlüssel ist die Referenz, nicht die Geräte-UUID** - sie überlebt
 * Unclaim/Re-Claim (der dokumentierte Identitäts-Drift), also überlebt auch
 * jedes Lesezeichen darauf (die Referenz-statt-UUID-Disziplin).
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

/**
 * Die Seiten der oberen Ebene, die die Schale als eigenen Punkt führt.
 *
 * ⚠ **„Meine Anlage(n)" steht hier seit der Navigations-Runde „zwei Ebenen"
 * NICHT mehr** (r2 §5.5 + Captain-Schärfung 25.08.2026: „Ist dann meine
 * Anlagen navigation nicht überflüssig?" — ja): das PORTFOLIO **IST** die
 * Liste, ein zweiter Eintrag daneben war dieselbe Frage mit zwei Antworten.
 * Die Seite `anlagen` bleibt als ROUTE (sie beherbergt `#/anlage/{id}`), und
 * `#/anlagen` leitet auf das Portfolio, wo es eine Flotten-Ebene gibt.
 */
export const MAIN_PAGES: PageDef[] = [
  { id: 'uebersicht', label: 'Übersicht', icon: 'dashboard' },
];

/**
 * Die Anlagen-Seite selbst bleibt eine `PageId` (sie beherbergt jede
 * `#/anlage/{id}`-Route), auch wenn die Navigation sie nicht mehr als Punkt
 * führt. Sie steht deshalb hier statt in {@link MAIN_PAGES} - sonst verlöre
 * `parseRoute` sie und `#/anlagen` liefe ins Leere.
 */
export const ANLAGEN_PAGE: PageDef = { id: 'anlagen', label: 'Meine Anlage', icon: 'sun' };

export const PORTFOLIO_PAGE: PageDef = { id: 'portfolio', label: 'Portfolio', icon: 'building' };

/**
 * Die STANDORT-ÜBERSICHT (UEMS AP-01 IP-5, E1): `#/standort/{id}` — die
 * Anlagen eines Standorts unter seinem Kopf. Sie ist die Landung eines Kunden
 * mit genau einem Standort und mehreren Anlagen und das mittlere Glied des
 * Pfades „Unternehmen › Standort › Anlage“. Ob es sie für einen Kunden gibt,
 * entscheidet `betriebsart.startEbene`; ohne Standorte leitet
 * `canonicalShellRoute` die Adresse dorthin, wo der Kunde heute landet.
 */
export const STANDORT_PAGE: PageDef = { id: 'standort', label: 'Standort', icon: 'map-pin' };

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
  // UEMS AP-02 IP-6: „Unternehmen › Standorte“ wohnt hier, bis die
  // Ebenen-Navigation aus AP-01 IP-5/IP-7 steht (`#/portfolio/standorte`) —
  // der Report nennt den Weg „erreichbar über die Standort-Übersicht“. Kein
  // Historie-Reiter: `PORTFOLIO_TAB_HASH` kennt ihn nicht, ein Zeitraum reist
  // nicht mit. `#/standorte` bleibt die Alt-Adresse der Technik.
  { id: 'portfolio-standorte', label: 'Standorte', icon: 'map-pin' },
  // UEMS AP-04 IP-5: „Unternehmen › Messstellen“ (`#/portfolio/messstellen`). Der
  // Reiter steht nur, wenn ein Standort misst (`PortfolioTabs.showMessstellen`).
  { id: 'portfolio-messstellen', label: 'Messstellen', icon: 'activity' },
  // UEMS AP-11 IP-13: „Unternehmen › Kennzahlen“ (`#/portfolio/kennzahlen`, eine
  // Kennzahl unter `…/kennzahlen/{id}`), bis AP-13 die Ebenen-Navigation bringt.
  // Der Reiter steht nur, wenn die Ebene den Bereich hat (`PortfolioTabs.showKennzahlen`).
  { id: 'portfolio-bezugsgroessen', label: 'Bezugsgrößen', icon: 'layers' },
  // Konzept Auswerten a1 (Richtungsfrage 1 = A, Entscheid 10.1): „Unternehmen › Verbrauch“ (`#/portfolio/verbrauch`,
  // ein Energieeinsatz unter `…/verbrauch/{id}`) — der erste Reiter von „Auswerten“, vor Kennzahlen und Bewertung.
  // Der Reiter steht nach der Regel der Bewertung (`PortfolioTabs.showVerbrauch`).
  { id: 'portfolio-verbrauch', label: 'Verbrauch', icon: 'zap' },
  { id: 'portfolio-kennzahlen', label: 'Kennzahlen', icon: 'trending-up' },
  // UEMS AP-12 IP-13: „Unternehmen › Berichte“ (`#/portfolio/berichte`, ein Bericht unter
  // `…/berichte/{kennung}`), bis AP-13 die Ebenen-Navigation bringt. Der Reiter steht
  // nur, wenn die Ebene den Bereich hat (`PortfolioTabs.showBerichte`).
  { id: 'portfolio-berichte', label: 'Berichte', icon: 'file-text' },
  // UEMS AP-16 IP-6: „Unternehmen › Bewertung“ (`#/portfolio/bewertung`, ein Energieeinsatz unter
  // `…/bewertung/{id}`). Der Reiter steht nur, wenn die Ebene den Bereich hat (`PortfolioTabs.showBewertung`).
  { id: 'portfolio-bewertung', label: 'Bewertung', icon: 'list' },
  // UEMS AP-18 IP-8: „Unternehmen › Ziele und Maßnahmen“ (`#/portfolio/verbesserung`, ein Energieziel unter
  // `…/verbesserung/energieziele/{id}`). Der Reiter steht nur mit `verbesserung.ansehen` (`PortfolioTabs.showVerbesserung`).
  { id: 'portfolio-verbesserung', label: 'Ziele und Maßnahmen', icon: 'list' },
  // UEMS AP-19 IP-9: „Unternehmen › Energiemanagement“ (`#/portfolio/energiemanagement`, ein Dokument unter
  // `…/energiemanagement/dokumente/{id}`). Der Reiter steht nur mit `energiemanagement.ansehen`
  // (`PortfolioTabs.showEnergiemanagement`).
  { id: 'portfolio-energiemanagement', label: 'Energiemanagement', icon: 'file-text' },
  // „Energie" wie der Reiter der Anlage (Verlauf-Rework P4); die Adresse
  // bleibt `#/portfolio/messwerte`, damit Lesezeichen weiter tragen.
  { id: 'portfolio-messwerte', label: 'Energie', icon: 'activity' },
  { id: 'portfolio-erloese', label: 'Erlöse', icon: 'euro' },
];

/** Ist das eine Seite der Portfolio-Ebene (Landung oder eine ihrer Welten)? */
export function isPortfolioPage(page: PageId): boolean {
  return page === 'portfolio' || PORTFOLIO_WELT_PAGES.some((p) => p.id === page);
}

/**
 * Ein RAUM der Plattform-Navigation (Admin-Umbau Scheibe S1, Konzept
 * `vp-adminview-konzept-k1` §4.1/4.2, Captain-Freigabe „alle Empfehlungen",
 * E3 = A). Die vier Gruppen aus Stufe 1 waren selbst noch elf Seiten unter
 * EINEM Dach - der neue Schnitt ist nach dem, was der Admin IST (Plattform ·
 * Geräte · Benutzer), nicht mehr nach dem, was er TUT.
 *
 * `page` nennt die LANDUNG des Raums - dort öffnet ein Klick auf den
 * Raum-Punkt und dort leuchtet der Punkt, solange irgendeine Seite des Raums
 * offen ist (siehe {@link navPageFor}).
 */
export interface PlattformRoom {
  key: 'plattform' | 'geraete' | 'benutzer';
  label: string;
  icon: IconName;
  page: PageId;
}

/**
 * Die drei Räume (§4.2): **Plattform** (alles Geräteübergreifende, mit
 * Reitern - {@link PLATTFORM_BEREICH}), **Geräte** (die Liste aller Boxen -
 * bis zur Geräteakte in S2 bleibt das die bestehende Registrierung) und
 * **Benutzer** (Kundenliste und Kundenakte, Scheibe S5 - `MandantenPage`
 * trägt beide weiter unter der PageId `mandanten`).
 */
export const PLATTFORM_ROOMS: PlattformRoom[] = [
  { key: 'plattform', label: 'Plattform', icon: 'dashboard', page: 'plattform-uebersicht' },
  { key: 'geraete', label: 'Geräte', icon: 'cpu', page: 'geraete-registry' },
  { key: 'benutzer', label: 'Benutzer', icon: 'users', page: 'mandanten' },
];

/** Ein Tab eines Plattform-BEREICHS: eine eigene Route, ein Ort. */
export interface BereichTab {
  id: PageId;
  label: string;
}

/**
 * Der Raum „Plattform" trägt fünf Reiter (§4.2/§4.3): die Landung
 * (Plattform-Übersicht), **Software** (N5, Abschnitt 9 - EIN Name für die
 * Seite, die bisher fünf trug: „Geräte", „Updates", „Geräte & Updates",
 * „Edge-Updates" und die Route `edge-updates`), Werkstatt, Fernwartung und
 * Katalog (Gerätevorlagen, Steuerungs-Freigabe, Komponenten - zusammengefasst
 * hinter {@link KATALOG_TABS}).
 */
export const PLATTFORM_BEREICH: { host: PageId; tabs: BereichTab[] } = {
  host: 'plattform-uebersicht',
  tabs: [
    { id: 'plattform-uebersicht', label: 'Übersicht' },
    { id: 'edge-updates', label: 'Software' },
    { id: 'werkstatt', label: 'Werkstatt' },
    { id: 'fernwartung', label: 'Fernwartung' },
    { id: 'katalog', label: 'Katalog' },
  ],
};

/** Ein Unter-Reiter des Raums „Katalog" (§4.3): je eine bestehende Seite, ungeändert. */
export type KatalogSektion = 'vorlagen' | 'modelle' | 'komponenten';

export const KATALOG_TABS: { id: KatalogSektion; label: string }[] = [
  { id: 'vorlagen', label: 'Gerätevorlagen' },
  { id: 'modelle', label: 'Steuerungs-Freigabe' },
  { id: 'komponenten', label: 'Komponenten' },
];

/** Die bestehende Seite hinter einem Katalog-Unter-Reiter. */
export function katalogSektionPage(sektion: KatalogSektion): PageId {
  if (sektion === 'vorlagen') return 'vorlagen';
  if (sektion === 'komponenten') return 'komponenten-flotte';
  return 'steuerungs-freigabe';
}

/**
 * Plattform-Seiten, die als TAB eines Bereichs leben statt als eigener
 * Nav-Punkt. Sie sind vollwertige Routen (Lesezeichen, Deep-Links, der
 * Admin-Zaun in `App.tsx`) und stehen deshalb in {@link PLATFORM_PAGES} - nur
 * eben nicht als eigener Raum-Punkt.
 */
export const PLATFORM_TAB_PAGES: PageDef[] = [
  { id: 'edge-updates', label: 'Software', icon: 'refresh-cw', adminOnly: true },
  { id: 'werkstatt', label: 'Werkstatt', icon: 'sliders', adminOnly: true },
  { id: 'fernwartung', label: 'Fernwartung', icon: 'lock', adminOnly: true },
  { id: 'katalog', label: 'Katalog', icon: 'archive', adminOnly: true },
  // Nicht mehr in der Navigation (Scheibe S1 hält sich an Schale + Umhängen),
  // aber als Route gültig bis Scheibe S3 ihnen einen Ort in der Geräteakte gibt.
  { id: 'optimizer', label: 'Optimizer', icon: 'settings', adminOnly: true },
  { id: 'flows', label: 'Flows', icon: 'zap', adminOnly: true },
  { id: 'steuerungs-freigabe', label: 'Steuerungs-Freigabe', icon: 'shield', adminOnly: true },
  { id: 'vorlagen', label: 'Gerätevorlagen', icon: 'layers', adminOnly: true },
  { id: 'komponenten-flotte', label: 'Komponenten', icon: 'list', adminOnly: true },
];

/**
 * Die LANDUNG jedes Raums (die Punkte, die die Schale zeigt) - nur
 * {@link PLATTFORM_ROOMS} selbst, keine Tab-Seite steht hier zusätzlich.
 */
const PLATFORM_LANDING_PAGES: PageDef[] = PLATTFORM_ROOMS.map((r) => ({
  id: r.page,
  label: r.label,
  icon: r.icon,
  adminOnly: true,
}));

/**
 * Die flache Liste aller Plattform-Seiten: die Raum-Landungen PLUS die
 * Tab-Seiten. Sie ist die EINE Wahrheit über die MENGE der Plattform-Routen
 * und trägt jeden Bestandsleser (den Admin-Zaun in `App.tsx`, `ALL_PAGES`).
 */
export const PLATFORM_PAGES: PageDef[] = [
  ...PLATFORM_LANDING_PAGES,
  ...PLATFORM_TAB_PAGES,
];

/**
 * Der Nav-Punkt, unter dem eine Seite WOHNT - für die Hervorhebung in der
 * Schale. Für jede Seite sie selbst; für einen Reiter des Raums „Plattform"
 * dessen Landung, für eine Katalog-Unterseite „Katalog".
 */
export function navPageFor(page: PageId): PageId {
  if (PLATTFORM_BEREICH.tabs.some((t) => t.id === page)) return PLATTFORM_BEREICH.host;
  if (KATALOG_TABS.some((t) => katalogSektionPage(t.id) === page)) return 'katalog';
  return page;
}

/**
 * Gehört diese Seite in den WRAPPER des Raums „Plattform" (= rendert sie die
 * äußere Reiterleiste)? Nur die fünf Reiter selbst - eine Katalog-Unterseite
 * über ihre EIGENE, alte Adresse (`#/vorlagen`, …) bleibt bewusst ungerahmt,
 * damit sie nicht zweimal rendert.
 */
export function isPlattformBereich(page: PageId): boolean {
  return PLATTFORM_BEREICH.tabs.some((t) => t.id === page);
}

/** "Meine Anlage" for 0-1 Anlagen, "Meine Anlagen" from 2 (the fleet list). */
export function anlagenLabel(siteCount: number | null): string {
  return siteCount != null && siteCount > 1 ? 'Meine Anlagen' : 'Meine Anlage';
}

/** Every page def, wherever it is rendered (main nav, mode group, Plattform). */
export const ALL_PAGES: PageDef[] = [
  { id: 'hilfe', label: 'Hilfe & Kontakt', icon: 'help-circle' },
  { id: 'kunden-benutzer', label: 'Benutzer', icon: 'users' },
  // Alerting Scheibe 1 (Entscheid 4A): kein Eintrag in der Leiste - nur ein Label/Icon für die
  // Kopfzeile und das Lesezeichen; die Glocke führt hin, nie ein Menüpunkt.
  { id: 'meldungen', label: 'Meldungen', icon: 'bell' },
  // Einstellungen Scheibe 1 (Entscheid 1A/7A): wie `meldungen` eine Seite ohne Leisten-Eintrag -
  // der Einstieg ist allein das Avatar-Menü (`AppShell.tsx`).
  { id: 'einstellungen', label: 'Einstellungen', icon: 'settings' },
  PORTFOLIO_PAGE,
  ...PORTFOLIO_WELT_PAGES,
  STANDORT_PAGE,
  ...MAIN_PAGES,
  ANLAGEN_PAGE,
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
  // r2 §5.5 / E3: die zwei Markt-Ansichten ziehen UNTER die Anlage. Ohne
  // Anlage im Pfad löst die Anlagen-Seite sie wie jede andere Alt-Adresse auf
  // (die EINE Anlage eines Einzel-Kunden, sonst die Flotten-Ebene).
  marktpreise: 'marktpreise',
  prognose: 'prognose',
};

/**
 * Das Segment hinter `#/plattform/…` je Seite des Raums (leer = die Landung
 * selbst, `#/plattform`). Nur die drei Raum-Landungen und die Reiter des
 * Raums „Plattform" stehen hier - Katalog-Unterseiten (Vorlagen,
 * Steuerungs-Freigabe, Komponenten) bleiben bei ihrer EIGENEN, flachen
 * Adresse (`#/vorlagen`, …), denn der Katalog-Reiter adressiert sie über
 * `?sektion=`, nicht über eine eigene Zeile dieser Tabelle.
 */
const PLATTFORM_HASH_SEGMENT: Partial<Record<PageId, string>> = {
  'plattform-uebersicht': '',
  'edge-updates': 'software',
  werkstatt: 'werkstatt',
  fernwartung: 'fernwartung',
  katalog: 'katalog',
  'geraete-registry': 'geraete',
  mandanten: 'benutzer',
};

/** Die Seite hinter einem `#/plattform/<segment>`-Pfad (umgekehrt zu {@link PLATTFORM_HASH_SEGMENT}). */
const PLATTFORM_SEGMENT_PAGE: Record<string, PageId> = Object.fromEntries(
  Object.entries(PLATTFORM_HASH_SEGMENT)
    .filter(([, seg]) => seg !== '')
    .map(([page, seg]) => [seg as string, page as PageId]),
);

/**
 * Stillgelegte PLATTFORM-Seiten, die in eine andere Seite GEFALTET wurden -
 * das `LEGACY_ROUTES`-Muster auf Seiten-Ebene. Anders als ein Tab existiert
 * eine Seite HIER nicht mehr unter eigenem Namen; ihr Hash wird auf die
 * aufnehmende Seite umgeschrieben, die ihrerseits KEINE eigene `PageId` ist
 * (`geraetetypen`, `benutzer`) - {@link PAGE_IDS} kennt sie nicht, darum
 * braucht `parseRoute` diese direkte Abbildung, nicht nur `canonicalPlatformHash`.
 */
const LEGACY_FOLDED_PLATFORM_PAGES: Record<string, PageId> = {
  // Dieselbe Betreiber-Frage („was dürfen wir steuern?"), nur für die andere
  // Geräteklasse - eine Sektion der Steuerungs-Freigabe, seit S1 im Katalog.
  geraetetypen: 'steuerungs-freigabe',
  // Die Benutzer wohnen im Mandanten-Drawer, seit S1 im Raum „Benutzer".
  benutzer: 'mandanten',
};

/**
 * Bestehende Seiten, die seit Scheibe S1 keine eigene Raum-Landung mehr sind,
 * sondern ein UNTER-Reiter des Raums „Plattform › Katalog" (§4.3) - ihr Inhalt
 * und ihre eigene Adresse bleiben unverändert gültig, die KANONISCHE Adresse
 * zeigt aber auf den Katalog-Reiter.
 */
const LEGACY_KATALOG_PAGES: Record<string, KatalogSektion> = {
  vorlagen: 'vorlagen',
  'komponenten-flotte': 'komponenten',
  'steuerungs-freigabe': 'modelle',
};

/**
 * Die kanonische Adresse einer STILLGELEGTEN oder UMGEHÄNGTEN Plattform-Seite
 * (Scheibe S1, Umzugstabelle §4.7), sonst null. Der Aufrufer schreibt sie per
 * `history.replaceState` (kein Verlaufseintrag, kein `hashchange` - die
 * geparste Route ist ohnehin identisch), genau wie bei {@link canonicalAnlageHash}.
 * Vorhandene Parameter (`?geraet=`, `?box=`, `?werkbank=1`, `?sektion=`) reisen mit.
 */
export function canonicalPlatformHash(hash: string): string | null {
  const [pathPart, ...rest] = hash.replace(/^#\/?/, '').split('?');
  const query = rest.length > 0 ? `?${rest.join('?')}` : '';
  const head = pathPart.split('/').filter(Boolean)[0] ?? '';

  // Scheibe S2 (Umzugstabelle §4.7): eine Adresse mit Box-Referenz führt nicht
  // mehr auf die alte Seite, sondern direkt in die Geräteakte - genau DORT
  // wohnen die Fakten jetzt. Ohne Referenz bleibt es bei der Raum-Landung
  // (unten, über {@link PLATTFORM_HASH_SEGMENT}).
  if (head === 'geraete-registry') {
    const ref = parseGeraetRef(hash);
    if (ref) return geraeteAkteHash(ref);
  }
  if (head === 'fernwartung') {
    const ref = parseFernwartungBox(hash);
    if (ref) return geraeteAkteHash(ref, 'verbindung');
  }
  if (head === 'werkstatt' && !istWerkstattWerkbank(hash)) {
    const ref = parseFernwartungBox(hash);
    if (ref) return geraeteAkteHash(ref, 'einrichtung');
  }

  if (head in LEGACY_FOLDED_PLATFORM_PAGES) {
    const sektion = head === 'geraetetypen' ? 'geraetetypen' : null;
    return sektion ? `#/plattform/katalog?sektion=${encodeURIComponent(sektion)}` : '#/plattform/benutzer';
  }
  if (head in LEGACY_KATALOG_PAGES) {
    // Ein vorhandenes `?sektion=` (die alte Gerätetypen-Sektion der Steuerungs-Freigabe) bleibt
    // erhalten statt vom Standard-Reiter des Katalogs überschrieben zu werden.
    return query ? `#/plattform/katalog${query}` : `#/plattform/katalog?sektion=${LEGACY_KATALOG_PAGES[head]}`;
  }
  // Scheibe S5: der geöffnete Mandant stand bis dahin als `?mandant=<id>` in der
  // Adresse (`MandantenPage.mandantHash`), die Kundenakte adressiert ihn seitdem
  // als PFAD-Segment (`#/plattform/geraete/{ref}`-Muster). Der Parameter reist
  // mit, nur eben ins Segment umgeschrieben statt angehängt.
  if (head === 'mandanten') {
    const id = query ? new URLSearchParams(query.slice(1)).get('mandant') : null;
    return id && id.trim() ? `#/plattform/benutzer/${encodeURIComponent(id.trim())}` : '#/plattform/benutzer';
  }
  const segment = PLATTFORM_HASH_SEGMENT[head as PageId];
  if (segment !== undefined) {
    return `${segment ? `#/plattform/${segment}` : '#/plattform'}${query}`;
  }
  return null;
}

/**
 * Die Adresse einer SEKTION einer Plattform-Seite (`?sektion=<id>`) - das
 * Hash-Parameter-Muster von {@link befehleHash}/{@link parseGeraetRef}:
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
 * Periode, Version und Vergleich der Werte einer Messstelle aus dem Hash (UEMS AP-13 IP-3/IP-5, E9/E6):
 * `#/portfolio/messstellen/{id}?periode=2026-10&version=2&v=vorperiode` (aus „Stand am …“ dazu `&stand=2029-04-30`). `parseRoute` schneidet den Query-Teil ab — die
 * Route bleibt die Messstellen-Seite; geschrieben wird die Adresse über `uemsOberflaechen.sprungziel`. Die
 * Periode kommt roh (die Sektion prüft sie, `uemsWerteKarte.periodeAus`), die Version nur als ganze Zahl ab 1, und
 * `v` ebenfalls roh — welche Wahl der Zeitraum überhaupt anbietet, weiß `uemsVergleich.wahlAus`.
 */
export function parseMessstelleWerte(hash: string): {
  periode: string | null;
  version: number | null;
  vergleich: string | null;
  stand: string | null;
} {
  const [, ...rest] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(rest.join('?'));
  const version = params.get('version')?.trim() ?? '';
  const stand = params.get('stand')?.trim() ?? '';
  return {
    periode: params.get('periode')?.trim() || null,
    version: /^[1-9]\d{0,5}$/.test(version) ? Number(version) : null,
    vergleich: params.get('v')?.trim() || null,
    // Messen m1 (Review r4 S4): aus „Stand an einem Tag ansehen“ geöffnet - die Seite liest diesen Tag, nur lesend.
    stand: /^\d{4}-\d{2}-\d{2}$/.test(stand) ? stand : null,
  };
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
 * Der Link aus der Bestätigungs-Mail (`#/zustellweg/bestaetigen?token=...`,
 * `ZustellwegService#anfordern`): ihr Endpunkt verlangt bewusst keine
 * Anmeldung (§6.6, der Klick kommt oft ohne angemeldete Sitzung) - die Route
 * muss deshalb wie `#register` VOR/OHNE den Auth-Bootstrap rendern. Gibt den
 * Token zurück, oder `null`, wenn der Hash diese Route nicht nennt oder der
 * Token fehlt.
 */
export function zustellwegBestaetigenToken(): string | null {
  const [pfad, ...rest] = window.location.hash.replace(/^#\/?/, '').split('?');
  if (pfad !== 'zustellweg/bestaetigen') return null;
  return new URLSearchParams(rest.join('?')).get('token')?.trim() || null;
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

  // Meldungs-Center (Alerting Scheibe 1, Entscheid 4A): `#/meldungen`, kein Eintrag in der Leiste
  // (die Glocke im Kopf führt hin); `?anlage=`/`?status=` liest die Seite selbst aus der Rohadresse.
  if (head === 'meldungen') return pageRoute('meldungen');
  if (head === 'hilfe') {
    // Invalid slugs stay in help and receive a useful not-found page.
    let article = segments.slice(1).join('/');
    try { article = decodeURIComponent(article); } catch { /* retain malformed input for not-found */ }
    return { page: 'hilfe', siteId: null, sub: null, ...(article ? { helpArticle: article } : {}) };
  }

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
      // ⚠ Die BOX ist ein TOR, kein Gerät (E3): `…/geraet/{ref}` OHNE Gerät
      // dahinter MEINT die Box und wird auf `…/box/{ref}` kanonisiert - die
      // Adresse sagt damit dasselbe wie die Seite. Die Referenz reist mit,
      // also ist die Weiterleitung verlustfrei (siehe canonicalAnlageHash).
      if (!segments[4]) {
        return {
          page: 'anlagen',
          siteId: segments[1],
          sub: 'box',
          geraet: { ref: decodeURIComponent(ref), geraetId: null },
        };
      }
      return {
        page: 'anlagen',
        siteId: segments[1],
        sub: 'geraet',
        geraet: { ref: decodeURIComponent(ref), geraetId: decodeURIComponent(segments[4]) },
      };
    }
    // Die BOX-Seite: `#/anlage/{id}/box[/{ref}]`. Die Referenz ist OPTIONAL -
    // eine Anlage hat genau EINE Box, die Fläche löst sie selbst auf; ein
    // Lesezeichen aus der Zeit der Geräte-Adresse trägt sie trotzdem mit,
    // damit die Weiterleitung nichts verliert.
    if (sub === 'box') {
      const ref = segments[3];
      return {
        page: 'anlagen',
        siteId: segments[1],
        sub: 'box',
        geraet: ref ? { ref: decodeURIComponent(ref), geraetId: null } : undefined,
      };
    }
    return { page: 'anlagen', siteId: segments[1], sub };
  }
  // Die Portfolio-Ebene ist zweistufig: `#/portfolio` (Landung) und
  // `#/portfolio/{welt}`. Ein unbekannter zweiter Abschnitt landet auf der
  // Landung, statt ins Leere zu zeigen.
  if (head === 'unternehmen' && segments[1] === 'einstellungen' && segments[2] === 'benutzer')
    return pageRoute('kunden-benutzer');
  if (head === 'portfolio') {
    if (segments[1] === 'kennzahlen' && segments[2]) {
      return kennzahlRoute(decodeURIComponent(segments[2]), null, segments[3] === 'bezugsbasis' ? 'bezugsbasis' : undefined);
    }
    if (segments[1] === 'berichte' && segments[2]) return berichtRoute(decodeURIComponent(segments[2]));
    // Die Seite eines Energieeinsatzes wohnt unter „Verbrauch“; die frühere Adresse unter „Bewertung“ führt dorthin.
    if ((segments[1] === 'verbrauch' || segments[1] === 'bewertung') && segments[2]) {
      return energieeinsatzRoute(decodeURIComponent(segments[2]));
    }
    if (segments[1] === 'verbesserung') {
      if (segments[2] === 'energieziele' && segments[3]) return energiezielRoute(decodeURIComponent(segments[3]));
      if (segments[2] === 'massnahmen' && segments[3]) return massnahmeRoute(decodeURIComponent(segments[3]));
      if (segments[2] === 'abweichungen' && segments[3]) return abweichungRoute(decodeURIComponent(segments[3]));
      if (segments[2] === 'massnahmen' || segments[2] === 'abweichungen') return verbesserungRoute(segments[2]);
      return verbesserungRoute();
    }
    if (segments[1] === 'energiemanagement') {
      if (segments[2] === 'dokumente' && segments[3]) return dokumentRoute(decodeURIComponent(segments[3]));
      if (segments[2] === 'personen' && segments[3]) return personRoute(decodeURIComponent(segments[3]));
      if (segments[2] === 'audits' && segments[3]) return auditRoute(decodeURIComponent(segments[3]));
      if (segments[2] === 'feststellungen' && segments[3]) return feststellungRoute(decodeURIComponent(segments[3]));
      if (segments[2] === 'managementbewertung' && segments[3]) return managementbewertungRoute(decodeURIComponent(segments[3]));
      if (segments[2] === 'mappen' && segments[3]) return mappeRoute(decodeURIComponent(segments[3]));
      if (
        segments[2] === 'dokumente' || segments[2] === 'zuschnitt' || segments[2] === 'aufgaben' || segments[2] === 'verantwortung' ||
        segments[2] === 'audits' || segments[2] === 'feststellungen' || segments[2] === 'wiedervorlage' || segments[2] === 'managementbewertung' ||
        segments[2] === 'verzeichnis'
      ) {
        return energiemanagementRoute(segments[2]);
      }
      return energiemanagementRoute();
    }
    if (segments[1] === 'messstellen' && segments[2]) return messstelleRoute(decodeURIComponent(segments[2]));
    if (segments[1] === 'bezugsgroessen' && segments[2]) return bezugsgroesseRoute(decodeURIComponent(segments[2]));
    const welt = PORTFOLIO_WELT_PAGES.find((p) => p.id === `portfolio-${segments[1] ?? ''}`);
    return { page: welt ? welt.id : 'portfolio', siteId: null, sub: null };
  }
  // Die Standort-Übersicht (IP-5): `#/standort/{id}`. Ohne Kennung bleibt es
  // die Seite ohne Ziel — `canonicalShellRoute` legt sie auf die Landung.
  // ⚠ `#/standorte` (Mehrzahl) ist NICHT diese Seite, sondern die Alt-Adresse
  // der Technik in `LEGACY_ROUTES`.
  if (head === 'standort') {
    if (segments[1] && segments[2] === 'messstellen') {
      return segments[3]
        ? messstelleRoute(decodeURIComponent(segments[3]), segments[1])
        : standortMessstellenRoute(segments[1]);
    }
    // AP-13 IP-2: die übrigen Seiten des Standorts; Kennzahl und Bericht bleiben im Standort, aus dem sie geöffnet werden.
    if (segments[1] && segments[2] === 'kennzahlen') {
      return segments[3]
        ? kennzahlRoute(decodeURIComponent(segments[3]), segments[1], segments[4] === 'bezugsbasis' ? 'bezugsbasis' : undefined)
        : standortBereichRoute(segments[1], 'kennzahlen');
    }
    if (segments[1] && segments[2] === 'berichte') {
      return segments[3]
        ? berichtRoute(decodeURIComponent(segments[3]), segments[1])
        : standortBereichRoute(segments[1], 'berichte');
    }
    if (segments[1] && (segments[2] === 'aufbau' || segments[2] === 'gebaeude' || segments[2] === 'netzanschluesse')) {
      return standortBereichRoute(segments[1], segments[2]);
    }
    // Die früheren Seiten „Boxen“ und „Anlagen“ sind im Aufbau aufgegangen — jedes Lesezeichen gilt weiter.
    if (segments[1] && (segments[2] === 'boxen' || segments[2] === 'anlagen')) {
      return standortBereichRoute(segments[1], 'aufbau');
    }
    return segments[1]
      ? { page: 'standort', siteId: null, sub: null, standortId: segments[1] }
      : { page: 'standort', siteId: null, sub: null };
  }
  if (head in LEGACY_ROUTES) {
    return { page: 'anlagen', siteId: null, sub: LEGACY_ROUTES[head] };
  }
  // Die drei Räume (§4.2): `#/plattform[/software|werkstatt|fernwartung|katalog|geraete|benutzer]`.
  // Ein unbekanntes oder fehlendes Segment ist die Landung (die Übersicht).
  if (head === 'plattform') {
    const segment = segments[1] ?? '';
    // Die GERÄTEAKTE (Scheibe S2): `#/plattform/geraete/{ref}[/{reiter}]`. Ohne
    // Referenz bleibt es die Liste (`geraete-registry` ohne `geraeteAkte`).
    if (segment === 'geraete' && segments[2]) {
      const ref = decodeURIComponent(segments[2]);
      const reiterRaw = segments[3];
      const reiter = reiterRaw && GERAETE_AKTE_REITER.has(reiterRaw) ? (reiterRaw as GeraeteAkteReiter) : null;
      return { page: 'geraete-registry', siteId: null, sub: null, geraeteAkte: { ref, reiter } };
    }
    const page = PLATTFORM_SEGMENT_PAGE[segment] ?? 'plattform-uebersicht';
    return { page, siteId: null, sub: null };
  }
  // Eine gefaltete Plattform-Seite landet auf ihrer AUFNEHMENDEN Seite - der
  // Anker reist über `canonicalPlatformHash` in die Adresse (die Route selbst
  // trägt ihn nicht, sie ist ja dieselbe Seite).
  if (head in LEGACY_FOLDED_PLATFORM_PAGES) {
    return { page: LEGACY_FOLDED_PLATFORM_PAGES[head], siteId: null, sub: null };
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
  // ⚠ Die BOX-Weiterleitung ist eine SHAPE-Regel, keine Namens-Regel (E3):
  // `…/geraet/{ref}` OHNE Gerät dahinter meint die Box. `LEGACY_SUBS` kann das
  // nicht ausdrücken - `geraet` bleibt MIT Gerät gültig. Die Referenz reist
  // mit, die Weiterleitung ist also verlustfrei.
  if (raw === 'geraet' && segments[3] && !segments[4]) {
    return `${boxSeiteHash(segments[1], decodeURIComponent(segments[3]))}${query}`;
  }
  // Ein Lesezeichen auf EINZELNE Messwerte (`…/messwerte?m=…`) meint seit dem
  // Verlauf-Rework den Reiter „Messwerte" (`einzelwerte`); ohne `m=` bleibt
  // `messwerte` die Energie-Seite. Die Parameter reisen mit.
  if (raw === 'messwerte' && !segments[3] && /(?:^|[?&])m=/.test(query)) {
    return `#/anlage/${segments[1]}/einzelwerte${query}`;
  }
  // Die Regel-Deep-Links (`?vorlage=`, `?verbraucher=`, `?komponente=`)
  // meinten die Regel-Kapsel der alten Steuerungsseite; seit den Reitern wohnt
  // sie im Reiter „Regeln". Die Parameter reisen mit - der Baukasten öffnet
  // also weiterhin genau die Regel, die das Lesezeichen meint.
  const regelLink = /(?:^|[?&])(vorlage|verbraucher|komponente)=/.test(query);
  if ((raw === 'steuerung' || raw === 'verbraucher') && !segments[3] && regelLink) {
    return `#/anlage/${segments[1]}/regeln${query}`;
  }
  if (!raw || !(raw in LEGACY_SUBS)) return null;
  const alt = LEGACY_SUBS[raw];
  const sub = alt === 'messwerte' && /(?:^|[?&])m=/.test(query) ? 'einzelwerte' : alt;
  const path = sub ? `#/anlage/${segments[1]}/${sub}` : `#/anlage/${segments[1]}`;
  return `${path}${query}`;
}

/** The canonical hash of a route (what goes into window.location.hash). */
export function hashForRoute(route: Route): string {
  if (route.page === 'hilfe') return `#/hilfe${route.helpArticle ? `/${encodeURIComponent(route.helpArticle)}` : ''}`;
  if (route.page === 'anlagen' && route.siteId) {
    if (route.sub === 'geraet' && route.geraet) {
      return geraetSeiteHash(route.siteId, route.geraet.ref, route.geraet.geraetId);
    }
    if (route.sub === 'box') {
      return boxSeiteHash(route.siteId, route.geraet?.ref ?? null);
    }
    return route.sub
      ? `#/anlage/${route.siteId}/${route.sub}`
      : `#/anlage/${route.siteId}`;
  }
  if (route.page === 'anlagen') return '#/anlagen';
  if (route.page === 'standort') {
    if (!route.standortId) return '#/standort';
    const objekt =
      route.standortBereich === 'messstellen'
        ? route.messstelleId
        : route.standortBereich === 'kennzahlen'
          ? route.kennzahlId
          : route.standortBereich === 'berichte'
            ? route.berichtKennung
            : undefined;
    const ebene = route.standortBereich === 'kennzahlen' && route.kennzahlId && route.kennzahlEbene ? `/${route.kennzahlEbene}` : '';
    const unter = objekt ? `/${encodeURIComponent(objekt)}${ebene}` : '';
    return `#/standort/${route.standortId}${route.standortBereich ? `/${route.standortBereich}` : ''}${unter}`;
  }
  // Die Portfolio-Welten schreiben sich zweistufig (`#/portfolio/messwerte`).
  if (PORTFOLIO_WELT_PAGES.some((p) => p.id === route.page)) {
    const kennzahl =
      route.page === 'portfolio-kennzahlen' && route.kennzahlId
        ? `/${encodeURIComponent(route.kennzahlId)}${route.kennzahlEbene ? `/${route.kennzahlEbene}` : ''}`
        : '';
    const messstelle =
      route.page === 'portfolio-messstellen' && route.messstelleId ? `/${encodeURIComponent(route.messstelleId)}` : '';
    const bezugsgroesse =
      route.page === 'portfolio-bezugsgroessen' && route.bezugsgroesseId ? `/${encodeURIComponent(route.bezugsgroesseId)}` : '';
    const bericht = route.page === 'portfolio-berichte' && route.berichtKennung ? `/${encodeURIComponent(route.berichtKennung)}` : '';
    const einsatz =
      route.page === 'portfolio-verbrauch' && route.energieeinsatzId ? `/${encodeURIComponent(route.energieeinsatzId)}` : '';
    const verbesserung =
      route.page !== 'portfolio-verbesserung'
        ? ''
        : route.energiezielId
          ? `/energieziele/${encodeURIComponent(route.energiezielId)}`
          : route.massnahmeId
            ? `/massnahmen/${encodeURIComponent(route.massnahmeId)}`
            : route.abweichungId
              ? `/abweichungen/${encodeURIComponent(route.abweichungId)}`
              : route.verbesserungReiter && route.verbesserungReiter !== 'energieziele'
                ? `/${route.verbesserungReiter}`
                : '';
    const energiemanagement =
      route.page !== 'portfolio-energiemanagement'
        ? ''
        : route.dokumentId
          ? `/dokumente/${encodeURIComponent(route.dokumentId)}`
          : route.personId
            ? `/personen/${encodeURIComponent(route.personId)}`
            : route.auditId
            ? `/audits/${encodeURIComponent(route.auditId)}`
            : route.feststellungId
            ? `/feststellungen/${encodeURIComponent(route.feststellungId)}`
            : route.managementbewertungKennung
            ? `/managementbewertung/${encodeURIComponent(route.managementbewertungKennung)}`
            : route.mappeId
            ? `/mappen/${encodeURIComponent(route.mappeId)}`
            : route.energiemanagementReiter && route.energiemanagementReiter !== 'ueberblick'
            ? `/${route.energiemanagementReiter}`
            : '';
    return `#/portfolio/${route.page.slice('portfolio-'.length)}${kennzahl}${messstelle}${bezugsgroesse}${bericht}${einsatz}${verbesserung}${energiemanagement}`;
  }
  if (route.page === 'kunden-benutzer') return '#/unternehmen/einstellungen/benutzer';
  // Die Geräteakte (Scheibe S2): `#/plattform/geraete/{ref}[/{reiter}]`.
  if (route.page === 'geraete-registry' && route.geraeteAkte) {
    return geraeteAkteHash(route.geraeteAkte.ref, route.geraeteAkte.reiter);
  }
  // Die drei Räume (§4.2): die Plattform-Landung und ihre Reiter/Unterräume
  // schreiben sich zweistufig unter `#/plattform/…`, Geräte und Benutzer je
  // mit einem Wort hinter dem Raum.
  const plattformPfad = PLATTFORM_HASH_SEGMENT[route.page];
  if (plattformPfad !== undefined) return plattformPfad ? `#/plattform/${plattformPfad}` : '#/plattform';
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

/** Route der Standort-Übersicht eines Standorts (UEMS AP-01 IP-5). */
export function standortRoute(standortId: string): Route {
  return { page: 'standort', siteId: null, sub: null, standortId };
}

/**
 * Die Seiten eines Standorts mit eigener Adresse, ohne seine Übersicht (UEMS AP-04 IP-5, AP-13 IP-2).
 * ⚠ Kennzahlen und Berichte sind hier SEITEN, aber keine Bereiche der Ebene (AP-01 §4.6, O17): sie haben keine
 * Kachel, man erreicht sie von der Standort-Übersicht (`ebenenNav.standortEinstiege`).
 *
 * „Aufbau“ ist der EINE Ort für Anlagen, VoltPilot-Boxen und Geräte des Standorts (derselbe Baum wie
 * „Anlage › Aufbau“). Die früheren Seiten `…/boxen` und `…/anlagen` sind darin aufgegangen; ihre Adressen
 * leiten auf `…/aufbau` ({@link canonicalStandortHash}).
 */
export type StandortBereich = 'aufbau' | 'netzanschluesse' | 'gebaeude' | 'messstellen' | 'kennzahlen' | 'berichte';

/**
 * Was der Aufbau beim Öffnen gleich anbietet (`?neu=`): der Weg aus Cockpit, Kopf und Assistent in den EINEN Ort.
 * `suche` öffnet „Geräte suchen" an der Box aus `box=` (Gerätesuche, Bericht §2: Geräte entstehen nur im Aufbau).
 */
export type AufbauNeu = 'box' | 'geraet' | 'anlage' | 'suche';

const AUFBAU_NEU: ReadonlySet<string> = new Set<AufbauNeu>(['box', 'geraet', 'anlage', 'suche']);

/**
 * Der Aufbau einer Anlage, optional mit einer Handlung, die er beim Öffnen gleich anbietet:
 * `#/anlage/{id}/modell?neu=box|geraet|anlage`. `an` nennt beim Gerät den Weg, an dem es hinzukommt
 * (`?neu=geraet&an=DQ-3`, „Gerät an diesem Gateway hinzufügen", GE-5) — sein Kennzeichen, nie eine Adresse.
 */
export function aufbauHash(
  siteId: string,
  neu?: AufbauNeu | null,
  opts: { an?: string | null; ref?: string | null } & AufbauSuche = {},
): string {
  const params = new URLSearchParams();
  if (neu) params.set('neu', neu);
  if (neu === 'geraet' && opts.an) params.set('an', opts.an);
  // Der Direktlink vom Gehäuse (`koppelLink.ts`): die Referenz, die „Box hinzufügen“ vorausfüllt.
  if (neu === 'box' && opts.ref) params.set('ref', opts.ref);
  if (neu === 'suche') sucheParams(params, opts);
  const q = params.toString();
  return `#/anlage/${siteId}/modell${q ? `?${q}` : ''}`;
}

/**
 * Der Aufbau eines Standorts: `#/standort/{id}/aufbau[?anlage=…][&neu=…]`. `anlage` wählt, welche Anlage des
 * Standorts aufgeklappt und bearbeitbar ist (ohne: die erste).
 */
export function standortAufbauHash(
  standortId: string,
  opts: { anlage?: string | null; neu?: AufbauNeu | null } & AufbauSuche = {},
): string {
  const params = new URLSearchParams();
  if (opts.anlage) params.set('anlage', opts.anlage);
  if (opts.neu) params.set('neu', opts.neu);
  if (opts.neu === 'suche') sucheParams(params, opts);
  const q = params.toString();
  return `#/standort/${standortId}/aufbau${q ? `?${q}` : ''}`;
}

/**
 * Die Gerätesuche aus `?neu=suche`: `box` = die Box, die sucht (ihre Kennung, nie eine Adresse), `such` = eine laufende
 * Suche zum Mitansehen, `ansicht=verlauf` = erst „Letzte Suchen".
 */
export interface AufbauSuche {
  box?: string | null;
  such?: string | null;
  verlauf?: boolean;
}

function sucheParams(params: URLSearchParams, opts: AufbauSuche): void {
  if (opts.box) params.set('box', opts.box);
  if (opts.such) params.set('such', opts.such);
  if (opts.verlauf) params.set('ansicht', 'verlauf');
}

/** Box, laufende Suche und Ansicht aus `?neu=suche&box=…`; ohne `box` ist es die führende Box. */
export function parseAufbauSuche(hash: string): Required<AufbauSuche> {
  return {
    box: befehleParam(hash, 'box'),
    such: befehleParam(hash, 'such'),
    verlauf: befehleParam(hash, 'ansicht') === 'verlauf',
  };
}

/** Die Handlung aus `?neu=` (nur die bekannten), sonst null. */
export function parseAufbauNeu(hash: string): AufbauNeu | null {
  const wert = befehleParam(hash, 'neu');
  return wert && AUFBAU_NEU.has(wert) ? (wert as AufbauNeu) : null;
}

/** Die Referenz aus `?ref=`, die „Box hinzufügen“ vorausfüllt (Direktlink vom Gehäuse); sonst null. */
export function parseAufbauRef(hash: string): string | null {
  return befehleParam(hash, 'ref');
}

/** Der Weg aus `?an=` (das Kennzeichen „DQ-3"), an dem ein neues Gerät hinzukommt; sonst null. */
export function parseAufbauAn(hash: string): string | null {
  return befehleParam(hash, 'an');
}

/** Die Anlage aus `?anlage=` des Standort-Aufbaus, sonst null. */
export function parseAufbauAnlage(hash: string): string | null {
  return befehleParam(hash, 'anlage');
}

/** Dieselbe Adresse ohne `?neu=` (und sein `an=`/`ref=`) — nach dem Öffnen des Dialogs, damit ein Neuladen ihn nicht erneut öffnet. */
export function ohneAufbauNeu(hash: string): string {
  const [path, ...rest] = hash.split('?');
  if (rest.length === 0) return hash;
  const params = new URLSearchParams(rest.join('?'));
  params.delete('neu');
  params.delete('an');
  params.delete('ref');
  params.delete('box');
  params.delete('such');
  params.delete('ansicht');
  const query = params.toString();
  return `${path}${query ? `?${query}` : ''}`;
}

/**
 * Die kanonische Adresse einer STILLGELEGTEN Standort-Seite: `…/boxen` und `…/anlagen` sind im Aufbau
 * aufgegangen. Die Parameter reisen mit; sonst null.
 */
export function canonicalStandortHash(hash: string): string | null {
  const [pathPart, ...rest] = hash.replace(/^#\/?/, '').split('?');
  const segments = pathPart.split('/').filter((s) => s.length > 0);
  if (segments[0] !== 'standort' || !segments[1] || segments.length !== 3) return null;
  if (segments[2] !== 'boxen' && segments[2] !== 'anlagen') return null;
  const query = rest.length > 0 ? `?${rest.join('?')}` : '';
  return `#/standort/${segments[1]}/aufbau${query}`;
}

/**
 * Die kanonische Adresse der früheren Seite eines Energieeinsatzes (Konzept Auswerten a1, Entscheid 10.1):
 * `#/portfolio/bewertung/{id}` steht jetzt unter `#/portfolio/verbrauch/{id}`. Die Parameter reisen mit (der Sprung der
 * Wiedervorlage trägt `?entscheid=…`); sonst null.
 */
export function canonicalVerbrauchHash(hash: string): string | null {
  const [pathPart, ...rest] = hash.replace(/^#\/?/, '').split('?');
  const segments = pathPart.split('/').filter((s) => s.length > 0);
  if (segments[0] !== 'portfolio' || segments[1] !== 'bewertung' || !segments[2] || segments.length !== 3) return null;
  const query = rest.length > 0 ? `?${rest.join('?')}` : '';
  return `#/portfolio/verbrauch/${segments[2]}${query}`;
}

/** Die Wahl der Liste „Verbrauch“ (`zeitraum`, `bis`) aus einer Adresse - als Query, sonst leer. */
function verbrauchWahl(hash: string): string {
  const q = new URLSearchParams(hash.split('?').slice(1).join('?'));
  const wahl = new URLSearchParams();
  for (const k of ['zeitraum', 'bis']) {
    const v = q.get(k);
    if (v) wahl.set(k, v);
  }
  const s = wahl.toString();
  return s ? `?${s}` : '';
}

/**
 * Die Seite eines Energieeinsatzes, geöffnet aus der Liste „Verbrauch“: die Wahl der Liste reist mit, damit der
 * Rückweg „Verbrauch“ denselben Zeitraum zeigt (Queryparameter bei Rückwegen erhalten).
 */
export const verbrauchEinsatzHash = (energieeinsatzId: string, listeHash: string): string =>
  `#/portfolio/verbrauch/${encodeURIComponent(energieeinsatzId)}${verbrauchWahl(listeHash)}`;

/** Der Rückweg von der Seite eines Energieeinsatzes zur Liste „Verbrauch“ - mit der Wahl, die sie beim Öffnen hatte. */
export const verbrauchListeHash = (einsatzHash: string): string => `#/portfolio/verbrauch${verbrauchWahl(einsatzHash)}`;

/** Route einer Seite des Standorts (UEMS AP-13 IP-2): `#/standort/{id}/{bereich}`. */
export function standortBereichRoute(standortId: string, standortBereich: StandortBereich): Route {
  return { page: 'standort', siteId: null, sub: null, standortId, standortBereich };
}

/** Route von „Standort › Messstellen“ (UEMS AP-04 IP-5): `#/standort/{id}/messstellen`. */
export function standortMessstellenRoute(standortId: string): Route {
  return standortBereichRoute(standortId, 'messstellen');
}

/**
 * Route einer Kennzahl-Seite (UEMS AP-11 IP-13): ohne Standort `#/portfolio/kennzahlen/{id}`, aus
 * „Kennzahlen dieses Standorts“ (AP-13 IP-2) `#/standort/{sid}/kennzahlen/{id}`. Mit `ebene` `bezugsbasis` die Ebene
 * darunter (Konzept Auswerten a1 §6.6): `…/kennzahlen/{id}/bezugsbasis`.
 */
export function kennzahlRoute(kennzahlId: string, standortId?: string | null, ebene?: 'bezugsbasis'): Route {
  const unter = ebene ? { kennzahlEbene: ebene } : {};
  return standortId
    ? { ...standortBereichRoute(standortId, 'kennzahlen'), kennzahlId, ...unter }
    : { page: 'portfolio-kennzahlen', siteId: null, sub: null, kennzahlId, ...unter };
}

/** Die drei Reiter des Bereichs „Ziele und Maßnahmen“ (UEMS AP-18 IP-8, §6.3). */
export type VerbesserungReiter = 'energieziele' | 'massnahmen' | 'abweichungen';

/** Route des Bereichs „Ziele und Maßnahmen“ (UEMS AP-18 IP-8): `#/portfolio/verbesserung[/massnahmen|/abweichungen]`. */
export function verbesserungRoute(reiter: VerbesserungReiter = 'energieziele'): Route {
  return { page: 'portfolio-verbesserung', siteId: null, sub: null, ...(reiter === 'energieziele' ? {} : { verbesserungReiter: reiter }) };
}

/** Route der Seite eines Energieziels (UEMS AP-18 IP-8): `#/portfolio/verbesserung/energieziele/{id}` — nur am Unternehmen. */
export function energiezielRoute(energiezielId: string): Route {
  return { page: 'portfolio-verbesserung', siteId: null, sub: null, energiezielId };
}

/** Route der Seite einer Maßnahme (UEMS AP-18 IP-13): `#/portfolio/verbesserung/massnahmen/{id}` — nur am Unternehmen. */
export function massnahmeRoute(massnahmeId: string): Route {
  return { page: 'portfolio-verbesserung', siteId: null, sub: null, verbesserungReiter: 'massnahmen', massnahmeId };
}

/** Route der Seite einer Abweichung (UEMS AP-18 IP-18): `#/portfolio/verbesserung/abweichungen/{id}` — nur am Unternehmen. */
export function abweichungRoute(abweichungId: string): Route {
  return { page: 'portfolio-verbesserung', siteId: null, sub: null, verbesserungReiter: 'abweichungen', abweichungId };
}

/**
 * Die Reiter des Bereichs „Energiemanagement“ (UEMS AP-19 IP-9, §6.3) — seit Konzept Nachweisen n1 der Überblick zuerst
 * (Entscheid 2), das Verzeichnis eine Ebene darunter; Wiedervorlage (IP-24), Dokumente,
 * Aufgaben (IP-13), Audits und Feststellungen (IP-20), Managementbewertung (IP-24); `zuschnitt` ist die Zuschnitt-Hilfe „Was VoltPilot führt — was
 * bei Ihnen liegt.“, eine Seite ohne eigenen Reiter; `verantwortung` („Wer ist wofür verantwortlich“, IP-13) eine
 * Ansicht unter dem Reiter „Aufgaben“.
 */
export type EnergiemanagementReiter =
  | 'verzeichnis'
  | 'wiedervorlage'
  | 'dokumente'
  | 'aufgaben'
  | 'verantwortung'
  | 'audits'
  | 'feststellungen'
  | 'managementbewertung'
  | 'zuschnitt'
  | 'ueberblick';

/**
 * Route des Bereichs „Energiemanagement“ (UEMS AP-19 IP-9/IP-13/IP-24): `#/portfolio/energiemanagement[/wiedervorlage|/dokumente|/aufgaben|/verantwortung|/audits|/feststellungen|/managementbewertung|/zuschnitt|/verzeichnis]`.
 * Seit Konzept Nachweisen n1 (Entscheid 2) öffnet die Adresse ohne Reiter den Überblick; das Verzeichnis liegt eine Ebene
 * tiefer unter `…/verzeichnis`.
 */
export function energiemanagementRoute(reiter: EnergiemanagementReiter = 'ueberblick'): Route {
  return { page: 'portfolio-energiemanagement', siteId: null, sub: null, ...(reiter === 'ueberblick' ? {} : { energiemanagementReiter: reiter }) };
}

/** Route der Seite einer Person im Energiemanagement (UEMS AP-19 IP-13): `#/portfolio/energiemanagement/personen/{id}`. */
export function personRoute(personId: string): Route {
  return { page: 'portfolio-energiemanagement', siteId: null, sub: null, energiemanagementReiter: 'aufgaben', personId };
}

/** Route der Seite eines internen Audits (UEMS AP-19 IP-20): `#/portfolio/energiemanagement/audits/{id|AU-…}`. */
export function auditRoute(auditId: string): Route {
  return { page: 'portfolio-energiemanagement', siteId: null, sub: null, energiemanagementReiter: 'audits', auditId };
}

/** Route der Seite einer Feststellung (UEMS AP-19 IP-20): `#/portfolio/energiemanagement/feststellungen/{id|F-…}`. */
export function feststellungRoute(feststellungId: string): Route {
  return { page: 'portfolio-energiemanagement', siteId: null, sub: null, energiemanagementReiter: 'feststellungen', feststellungId };
}

/** Route der Seite einer Mappe (Konzept Nachweisen n1, Entscheid 7): `#/portfolio/energiemanagement/mappen/{id}`, unter dem Überblick. */
export function mappeRoute(mappeId: string): Route {
  return { page: 'portfolio-energiemanagement', siteId: null, sub: null, mappeId };
}

/** Route der Seite einer Managementbewertung (UEMS AP-19 IP-24): `#/portfolio/energiemanagement/managementbewertung/{BR-…}`. */
export function managementbewertungRoute(kennung: string): Route {
  return { page: 'portfolio-energiemanagement', siteId: null, sub: null, energiemanagementReiter: 'managementbewertung', managementbewertungKennung: kennung };
}

/** Route der Seite eines Dokuments (UEMS AP-19 IP-9): `#/portfolio/energiemanagement/dokumente/{id}` — nur am Unternehmen. */
export function dokumentRoute(dokumentId: string): Route {
  return { page: 'portfolio-energiemanagement', siteId: null, sub: null, energiemanagementReiter: 'dokumente', dokumentId };
}

/**
 * Route der Seite eines Energieeinsatzes (UEMS AP-16 IP-6) — nur am Unternehmen. Seit dem Konzept Auswerten a1
 * (Entscheid 10.1) unter „Verbrauch“: `#/portfolio/verbrauch/{id}`; `#/portfolio/bewertung/{id}` leitet dorthin
 * ({@link canonicalVerbrauchHash}).
 */
export function energieeinsatzRoute(energieeinsatzId: string): Route {
  return { page: 'portfolio-verbrauch', siteId: null, sub: null, energieeinsatzId };
}

/**
 * Route einer Berichtsseite (UEMS AP-12 IP-13): ohne Standort `#/portfolio/berichte/{kennung}`, aus
 * „Berichte dieses Standorts“ (AP-13 IP-2) `#/standort/{sid}/berichte/{kennung}`.
 */
export function berichtRoute(berichtKennung: string, standortId?: string | null): Route {
  return standortId
    ? { ...standortBereichRoute(standortId, 'berichte'), berichtKennung }
    : { page: 'portfolio-berichte', siteId: null, sub: null, berichtKennung };
}

/**
 * Route einer Messstellen-Seite (UEMS AP-04 IP-8) — im Bereich „Messstellen“, aus dem sie geöffnet
 * wird: ohne Standort `#/portfolio/messstellen/{id}`, mit `#/standort/{sid}/messstellen/{id}`.
 */
export function messstelleRoute(messstelleId: string, standortId?: string | null): Route {
  return standortId
    ? { ...standortMessstellenRoute(standortId), messstelleId }
    : { page: 'portfolio-messstellen', siteId: null, sub: null, messstelleId };
}

/** Route der Seite einer Bezugsgröße (Konzept Messen m1 §6.8, Entscheid 9): `#/portfolio/bezugsgroessen/{id}`. */
export function bezugsgroesseRoute(bezugsgroesseId: string): Route {
  return { page: 'portfolio-bezugsgroessen', siteId: null, sub: null, bezugsgroesseId };
}

/* =========================================================================
   DIE RICHTUNG EINES SEITENWECHSELS (Bewegungs-Programm P5)
   Konzept `data/vp-motion-konzept-m1/report.md` §6 („Seitenwechsel Telefon"
   / „Seitenwechsel Rechner"), Empfehlung E5 (a), Captain-Antwort 8
   („Handy wie eine App — Blätter schieben; Rechner nur blenden").

   Sie ist REIN und wohnt hier, weil sie eine Aussage über ROUTEN ist, nicht
   über Pixel: `App.tsx` schreibt daraus nur eine Klasse ans `<html>`, das CSS
   macht daraus Bewegung. Wer die Hierarchie des Portals ändert, ändert die
   Bewegung damit an EINER Stelle mit.
   ========================================================================= */

/** Wohin ein Wechsel führt — tiefer (`push`), flacher (`pop`), daneben (`fade`). */
export type TransitionKind = 'push' | 'pop' | 'fade';

/**
 * Die TIEFE einer Route in der Hierarchie des Portals.
 *
 * Sie folgt der Navigations-Runde „zwei Ebenen" (`vp-portfolio-konzept-r2`
 * §5.5) und der Anlagen-Zentrale Stufe 1 — also genau der Brotkrume, die der
 * Kunde liest:
 *
 * | Tiefe | Route | Brotkrume |
 * |---|---|---|
 * | 0 | jede Seite der FLOTTEN-Ebene (Portfolio, Übersicht, Plattform-Seiten) | — |
 * | 1 | eine geöffnete Anlage (`#/anlage/{id}`) | Anlage |
 * | 2 | ein REITER dieser Anlage (`…/messwerte`, `…/modell`, …) | Anlage › Reiter |
 * | 3 | eine Geräte-/Box-Seite (`…/geraet/…`, `…/box/…`) | Anlage › Komponenten › Gerät |
 *
 * ⚠ `#/anlagen` OHNE Anlage ist Tiefe 0: das ist die Umleitungs-Adresse der
 * Flotten-Ebene, keine geöffnete Anlage — sie zeigt nie den Kopf einer Anlage.
 */
export function routeDepth(route: Route): number {
  if (route.page !== 'anlagen' || route.siteId == null) return 0;
  if (route.sub == null) return 1;
  // Die Geräte- und die Box-Seite wohnen EINE Ebene unter dem Anlagen-Modell
  // (`ebenenNav.OHNE_BEREICHS_REITER`: sie tragen deshalb keinen Reiter,
  // sondern ihren eigenen Rückweg als Brotkrume).
  return route.sub === 'geraet' || route.sub === 'box' ? 3 : 2;
}

/**
 * Die Richtung eines Seitenwechsels.
 *
 * ⚠ **`back` ist KEINE Heuristik am Hash, sondern die gemessene
 * Verlaufstiefe.** Sie zu raten geht nachweislich schief: wer von einem Reiter
 * über die Brotkrume auf die Anlage zurückgeht (flacher = `pop`) und dann
 * BROWSER-ZURÜCK drückt, landet wieder tiefer — die Tiefe sagt `push`, der
 * Kunde erlebt aber ein Zurück. `App.tsx` liest dafür den Verlaufs-Index, den
 * `navigationBlocker.ts` ohnehin mitführt, und reicht das Urteil hier herein.
 *
 * Ohne Vorgänger (`from == null`, das erste Bild) gibt es keinen Wechsel zu
 * beschreiben — das Ankommen der Anwendung gehört dem App-Start (P4), nicht
 * dieser Regel. Sie antwortet dann `fade`.
 */
export function transitionKind(
  from: Route | null,
  to: Route,
  back = false,
): TransitionKind {
  if (back) return 'pop';
  if (from == null) return 'fade';
  const a = routeDepth(from);
  const b = routeDepth(to);
  if (b > a) return 'push';
  if (b < a) return 'pop';
  // Gleiche Tiefe = Geschwister: ein Reiter neben dem Reiter, eine Anlage
  // neben der Anlage, eine Flotten-Seite neben der Flotten-Seite. Nichts
  // wird tiefer, also schiebt auch nichts.
  return 'fade';
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
  return befehleParam(hash, 'komponente');
}

/**
 * Die Adresse der BEFEHLE-Seite eines GERÄTS (Anlagen-Zentrale Stufe 1,
 * Konzept `vp-anlagen-zentrale-konzept-h6` §7.4, Captain-Entscheid D3: die
 * Befehle-Seite bleibt, die Geräteseite zeigt die gefilterte Sicht).
 *
 * Bewusst eine EIGENE Funktion neben {@link befehleHash} statt eines zweiten
 * Arguments: Komponente und Gerät sind zwei verschiedene Fragen, und der
 * Server lehnt beides zusammen mit 400 ab - eine Signatur, die sie gleichzeitig
 * annimmt, lüde genau dazu ein.
 */
export function befehleGeraetHash(siteId: string, geraetRef: string): string {
  return `#/anlage/${siteId}/befehle?geraet=${encodeURIComponent(geraetRef)}`;
}

/** Das Gerät aus einem `?geraet=`-Hash, oder null. */
export function parseBefehleGeraet(hash: string): string | null {
  return befehleParam(hash, 'geraet');
}

function befehleParam(hash: string, name: string): string | null {
  const [, ...rest] = hash.replace(/^#\/?/, '').split('?');
  if (rest.length === 0) return null;
  const value = new URLSearchParams(rest.join('?')).get(name);
  return value && value.trim() ? value.trim() : null;
}

/**
 * Der Weg ZURÜCK auf EINE Komponente (Anlagen-Zentrale Stufe 3, PR 3c):
 * `…/modell?komponente=<entityId>`.
 *
 * Er ist die Gegenrichtung jedes Drill-ins der Landkarte - Cockpit, Regel-Karte
 * und Schaltbild fragen alle dasselbe („wo kommt das her?"), und die Antwort
 * ist IMMER die Zeile der Komponente IN ihrer Geräte-Karte. Von dort führt der
 * Kartenkopf mit „Geräteseite ›" weiter; ein zweiter Weg direkt auf die
 * Geräteseite würde die Zeile überspringen, an der die Handlungen hängen.
 *
 * Ein HASH-PARAMETER, keine eigene Unterseite (das Muster von
 * {@link befehleHash}) - die Route bleibt der Aufbau, und ein Lesezeichen
 * öffnet exakt dieselbe Komponente wieder.
 */
export function komponenteHash(siteId: string, entityId: string): string {
  return `#/anlage/${siteId}/modell?komponente=${encodeURIComponent(entityId)}`;
}

export function komponenteBearbeitenHash(siteId: string, entityId: string): string {
  const params = new URLSearchParams({ bearbeiten: '1', komponente: entityId });
  return `#/anlage/${siteId}/modell?${params.toString()}`;
}

export function modellBearbeitenKomponente(hash: string): string | null {
  if (befehleParam(hash, 'bearbeiten') !== '1') return null;
  return parseKomponente(hash);
}

export function ohneModellBearbeiten(hash: string): string {
  const [path, ...rest] = hash.split('?');
  if (rest.length === 0) return hash;
  const params = new URLSearchParams(rest.join('?'));
  params.delete('bearbeiten');
  params.delete('komponente');
  const query = params.toString();
  return `${path}${query ? `?${query}` : ''}`;
}

/** Die gemeinte Komponente aus einem `?komponente=`-Hash, oder null. */
export function parseKomponente(hash: string): string | null {
  return befehleParam(hash, 'komponente');
}

/**
 * Die Geräte-Referenz aus einem `?geraet=`-Hash, oder null.
 *
 * ⚠ **Diese Adresse wird seit der Anlagen-Zentrale Stufe 3 (PR 3b) nur noch
 * GELESEN, nie mehr geschrieben.** `#/geraete-registry?geraet=<referenz>` war
 * die Adresse der zweiten, plattform-seitigen Vollansicht desselben Geräts.
 * Seit der Geräteakte (Konzept `vp-adminview-konzept-k1` §4.2, Scheibe S2)
 * führt sie dorthin ({@link canonicalPlatformHash}, {@link geraeteAkteHash}) -
 * nicht mehr auf die Geräteseite der Kundenansicht ({@link geraetSeiteHash}):
 * die Akte ist der EINE Ort für PLATTFORM-Fakten einer Box, die Geräteseite
 * bleibt der eine Ort für die Fakten, die der Kunde selbst sieht. Der frühere
 * Schreiber `geraetHash` ist ERSATZLOS entfallen - eine Funktion, die eine
 * Adresse erzeugt, auf der nichts mehr wohnt, wäre eine Einladung, sie wieder
 * zu benutzen.
 *
 * **Der Schlüssel ist die REFERENZ, nicht die Geräte-UUID** - sie überlebt
 * Unclaim/Re-Claim (der dokumentierte Identitäts-Drift), also überlebt auch
 * das Lesezeichen.
 */
/**
 * Die Fernwartung mit einer gewählten Box: `#/fernwartung?box=<referenz>`.
 * Dasselbe Hash-Parameter-Muster wie `?geraet=`: die Route bleibt die Seite,
 * ein Lesezeichen öffnet dieselbe Box wieder.
 */
export function fernwartungHash(ref?: string | null): string {
  return ref && ref.trim() ? `#/fernwartung?box=${encodeURIComponent(ref.trim())}` : '#/fernwartung';
}

/** Die Werkstatt, auf Wunsch bei einer Box: `#/werkstatt?box=<referenz>` (dasselbe Muster wie die Fernwartung). */
export function werkstattHash(ref?: string | null): string {
  return ref && ref.trim() ? `#/werkstatt?box=${encodeURIComponent(ref.trim())}` : '#/werkstatt';
}

/** Die Werkstatt-Bildschirme an der Werkbank (WI-8 A): `#/werkstatt?werkbank=1`. */
export function werkstattWerkbankHash(): string {
  return '#/werkstatt?werkbank=1';
}

/** Ob ein Werkstatt-Hash die Bildschirme an der Werkbank meint. */
export function istWerkstattWerkbank(hash: string): boolean {
  const [, ...rest] = hash.replace(/^#\/?/, '').split('?');
  return rest.length > 0 && new URLSearchParams(rest.join('?')).get('werkbank') === '1';
}

/** Die Box aus einem `?box=`-Hash, oder null. */
export function parseFernwartungBox(hash: string): string | null {
  const [, ...rest] = hash.replace(/^#\/?/, '').split('?');
  if (rest.length === 0) return null;
  const value = new URLSearchParams(rest.join('?')).get('box');
  return value && value.trim() ? value.trim() : null;
}

export function parseGeraetRef(hash: string): string | null {
  const [, ...rest] = hash.replace(/^#\/?/, '').split('?');
  if (rest.length === 0) return null;
  const value = new URLSearchParams(rest.join('?')).get('geraet');
  return value && value.trim() ? value.trim() : null;
}

/**
 * Die Adresse der GERÄTEAKTE (§4.2/4.4, Scheibe S2): `#/plattform/geraete/{ref}[/{reiter}]`.
 * Die Referenz ist die Box-Kennung, nicht die Geräte-UUID - dasselbe
 * Lesezeichen-Argument wie bei {@link geraetSeiteHash}.
 */
export function geraeteAkteHash(ref: string, reiter?: GeraeteAkteReiter | null): string {
  const base = `#/plattform/geraete/${encodeURIComponent(ref)}`;
  return reiter ? `${base}/${reiter}` : base;
}

/** Die Route der Geräteakte, zum Aufrufen über `onNavigate`. */
export function geraeteAkteRoute(ref: string, reiter: GeraeteAkteReiter | null = null): Route {
  return { page: 'geraete-registry', siteId: null, sub: null, geraeteAkte: { ref, reiter } };
}

/** Die Adresse der GERÄTE-LISTE, auf Wunsch mit einem vorgewählten Filter-Chip. */
export function geraeteListeHash(filter?: string | null): string {
  return filter && filter.trim() ? `#/plattform/geraete?filter=${encodeURIComponent(filter.trim())}` : '#/plattform/geraete';
}

/** Der vorgewählte Filter aus einem `?filter=`-Hash der Geräte-Liste, oder null. */
export function parseGeraeteListeFilter(hash: string): string | null {
  const [, ...rest] = hash.replace(/^#\/?/, '').split('?');
  if (rest.length === 0) return null;
  const value = new URLSearchParams(rest.join('?')).get('filter');
  return value && value.trim() ? value.trim() : null;
}

/**
 * Die Adresse der GERÄTE-DETAILSEITE in der Anlagen-Zentrale (Konzept
 * `vp-anlagen-zentrale-konzept-h6` §7.1): `#/anlage/{siteId}/geraet/{ref}` für
 * die VoltPilot-Box, `…/{geraetId}` für ein Gerät DAHINTER.
 *
 * Anders als der frühere `geraetHash` (die abgelöste Plattform-Vollansicht,
 * ein Hash-Parameter) sind Referenz und Gerät hier echte Pfad-Abschnitte: die
 * Seite gehört zur ANLAGE, also gehört sie in ihren Pfad. Beide Werte werden
 * kodiert - eine Referenz ist per Kontrakt topic-sicher, eine Säulen-Kennung
 * (`cp-<ChargePointId>`) muss es nicht sein.
 */
/**
 * Die Adresse der BOX-Seite (`#/anlage/{siteId}/box[/{ref}]`, Scout
 * `vp-geraeteseite-rev-b8` E3).
 *
 * Die Box ist ein TOR, kein Gerät - das sagt seit Stufe 1 auch die Adresse.
 * Die Referenz ist OPTIONAL: eine Anlage hat genau EINE Box, die Fläche löst
 * sie über `boxRefOf` auf. Sie wird trotzdem GESCHRIEBEN, wo sie bekannt ist,
 * damit die Weiterleitung aus `…/geraet/{ref}` verlustfrei bleibt (eine Anlage
 * mit mehreren beanspruchten Geräten könnte sie sonst nicht mehr auflösen).
 */
export function boxSeiteHash(siteId: string, ref?: string | null): string {
  const base = `#/anlage/${siteId}/box`;
  return ref && ref.trim() ? `${base}/${encodeURIComponent(ref.trim())}` : base;
}

/**
 * Die Adresse der GERÄTE-Detailseite (siehe {@link boxSeiteHash} für die Box).
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

/**
 * Derselbe Geräte-Ort im Bearbeitungsmodus. Der Query-Parameter ist nur ein
 * EINMALIGER Eintritt: die Geräteseite entfernt ihn nach dem Öffnen, damit ein
 * Abbrechen oder Speichern beim nächsten Render nicht erneut hinein springt.
 */
export function geraetBearbeitenHash(siteId: string, ref: string, geraetId: string): string {
  return `${geraetSeiteHash(siteId, ref, geraetId)}?bearbeiten=1`;
}

/** Ein Namens-Stift einer konkreten Komponente führt in denselben Seitenmodus. */
export function geraetKomponenteBearbeitenHash(
  siteId: string,
  ref: string,
  geraetId: string,
  componentId: string,
): string {
  const params = new URLSearchParams({ bearbeiten: '1', komponente: componentId });
  return `${geraetSeiteHash(siteId, ref, geraetId)}?${params.toString()}`;
}

export function istGeraetBearbeitenHash(hash: string): boolean {
  return befehleParam(hash, 'bearbeiten') === '1';
}

/** Welche Komponente der einmalige Namens-Einstieg meint, falls er eine nennt. */
export function geraetBearbeitenKomponente(hash: string): string | null {
  const value = befehleParam(hash, 'komponente');
  return value?.trim() || null;
}

/** Entfernt den verbrauchten Eintritt samt Ziel; alle anderen Parameter reisen mit. */
export function ohneGeraetBearbeiten(hash: string): string {
  const [path, ...rest] = hash.split('?');
  if (rest.length === 0) return hash;
  const params = new URLSearchParams(rest.join('?'));
  params.delete('bearbeiten');
  params.delete('komponente');
  const query = params.toString();
  return `${path}${query ? `?${query}` : ''}`;
}
