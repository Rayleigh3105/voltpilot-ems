import type { Betriebsart, StandorteAmStichtag, Unternehmen } from './api';
import { UEMS_STANDORT, UEMS_UNTERNEHMEN } from './glossar';
import { anlageRoute, hashForRoute, isPortfolioPage, pageRoute, standortRoute, type Route } from './nav';

/**
 * U0 shell decision (design vp-ems-ui-overhaul §2 / epic UO #509): which
 * navigation SHELL the portal renders. The former `sites.length >= 2`
 * heuristic is replaced by the tenant's EFFECTIVE Betriebsart (resolved
 * server-side, read from /tenant-context at login):
 *
 * - `endkunde` -> single-object cockpit shell. NEVER fleet/operator chrome:
 *   with one Anlage the Anlage IS the home; with 2-3 Anlagen the Übersicht
 *   shows the calm existing FleetUebersicht CARDS, never an operator table.
 * - `betreiber` -> the PORTFOLIO shell (U5, #516): the sidebar leads with a
 *   `Portfolio` item (aggregate KPIs + operator table) instead of `Übersicht`,
 *   even with a single Standort (the operator signed up for portfolio
 *   affordances; the chrome must not jump when site 2 arrives). Opening a
 *   Standort renders the SAME cockpit as the Endkunde shell (one cockpit, two
 *   shells).
 * - `null` (no explicit override stored, context not loaded, older backend) ->
 *   the v1 site-count fallback, byte-identical to the pre-U0 behavior. This is
 *   the DEFAULT for every existing tenant: the api derives the frame ONLY from
 *   an explicit `tenant.betriebsart`, never from `tenant.segment` (which
 *   defaults to `CI` and would otherwise have flipped every admin-provisioned
 *   customer into the Portfolio shell on deploy - pre-deploy audit HIGH-1).
 *
 * Admins keep today's behavior (tenant switcher + always-Übersicht); the
 * betriebsart in play is the currently-selected tenant's.
 */

export interface ShellInput {
  isAdmin: boolean;
  /** Sites/devices load settled (the pre-U0 gate for showing fleet nav). */
  loaded: boolean;
  /** False for an admin without a selected tenant (no context yet). */
  tenantReady: boolean;
  /** EFFECTIVE betriebsart from /tenant-context; null = unknown. */
  betriebsart: Betriebsart | null;
  siteCount: number;
  /**
   * UEMS AP-01 IP-5: die Ebene, die {@link startEbene} aus den Standorten
   * abgeleitet hat. Absent (ältere Aufrufer, Standorte nicht geladen) = `heute`:
   * dann entscheidet alles wie vor IP-5.
   */
  ebene?: Ebene;
}

/**
 * Does the tenant get the fleet shell (Übersicht as the fleet/portfolio
 * level)? Pure frame question - admin handling and load gates live in the
 * callers below.
 */
export function isFleetShell(betriebsart: Betriebsart | null, siteCount: number): boolean {
  if (betriebsart === 'betreiber') return true;
  if (betriebsart === 'endkunde') return siteCount >= 2;
  // Unknown frame: the v1 heuristic (fail-soft, no regression).
  return siteCount >= 2;
}

/**
 * Der BETREIBER-Rahmen: die EFFEKTIVE Betriebsart des Mandanten ist
 * `betreiber`.
 *
 * ⚠ Seit dem Anwendungs-Programm Stufe 4 (Captain-Entscheid E5) entscheidet
 * er NICHT mehr, WELCHE Fläche die Flotten-Ebene zeigt — es gibt nur noch EINE
 * ({@link showPortfolioNav}). Er steuert dort ausschliesslich DICHTE (Tabelle
 * statt Karten, `portfolioDichte`) und TONALITÄT (`fleetTonalitaet`). Sein
 * zweiter Nutzen ist unverändert: ein Betreiber hat seine Flotten-Ebene ab der
 * ERSTEN Anlage, ein Endkunde erst ab der zweiten.
 */
export function isBetreiberShell(betriebsart: Betriebsart | null): boolean {
  return betriebsart === 'betreiber';
}

/**
 * Wie die FLOTTEN-EBENE im Menü heisst (Navigations-Runde „zwei Ebenen",
 * r2 §5.1: „nur das Wort folgt der Tonalität").
 *
 * Es gibt sie GENAU EINMAL — ein Betreiber nennt sie „Portfolio", ein Endkunde
 * „Meine Anlagen". Der frühere zweite Eintrag „Meine Anlage(n)" (die Listen-
 * Seite) ist darin aufgegangen: das Portfolio IST die Liste, und zwei Einträge
 * für dieselbe Ebene waren dieselbe Frage mit zwei Antworten.
 */
export function fleetLabel(betriebsart: Betriebsart | null): string {
  return betriebsart === 'betreiber' ? 'Portfolio' : 'Meine Anlagen';
}

/**
 * Zeigt die Schale den Punkt `Portfolio` — und ist die Landung damit das
 * Portfolio-Cockpit?
 *
 * ⚠ **Anwendungs-Programm Stufe 4 (E5): die Bedingung ist die FLOTTEN-Ebene,
 * nicht mehr der Betreiber-Rahmen.** Bis dahin sah ein Endkunde mit drei
 * Anlagen die ruhigen `FleetUebersicht`-Karten und NIE eine Portfolio-Welt,
 * während ein Betreiber die feste Geld-/Speicher-Tabelle bekam — zwei
 * Implementierungen derselben Frage, und für einen Nur-Monitoring-Kunden
 * antwortete die eine mit „—, —, —". Jetzt komponiert EINE Fläche sich aus den
 * Anwendungen der Anlagen, und die Betriebsart wählt nur noch ihre Dichte.
 *
 * Sichtbare Folge (gewollt, in `concept.html` gezeigt): ein Endkunde ab zwei
 * Anlagen sieht statt „Übersicht" den Punkt „Portfolio" — dieselbe ruhige
 * Karten-Dichte, jetzt mit den Bausteinen seiner Anwendungen. Sein altes
 * Lesezeichen `#/uebersicht` gilt weiter: {@link redirectToPortfolio} leitet
 * es weiter.
 *
 * Ein Admin erreicht das Portfolio wie bisher über den Mandanten-Umschalter
 * (dessen Kontext den Rahmen und die Anlagen-Zahl liefert), deshalb braucht es
 * hier keinen Admin-Sonderfall.
 */
export function showPortfolioNav(i: ShellInput): boolean {
  if (!i.loaded || !i.tenantReady) return false;
  return hatFlottenEbene(i);
}

/**
 * Whether the "Übersicht" nav item renders in the sidebar. Wer eine
 * Flotten-Ebene hat, bekommt `Portfolio` STATTDESSEN (siehe
 * {@link showPortfolioNav}); Admins behalten sonst ihr heutiges
 * Immer-Übersicht-Verhalten, und ein Kunde ohne Flotten-Ebene hat gar keinen
 * Punkt (seine Welt IST die eine Anlage).
 */
export function showOverviewNav(i: ShellInput): boolean {
  if (showPortfolioNav(i)) return false;
  if (i.isAdmin) return true;
  if (!i.loaded || !i.tenantReady) return false;
  return isFleetShell(i.betriebsart, i.siteCount);
}

/**
 * Whether a customer landing on #/uebersicht (default boot hash, old
 * bookmark) is forwarded to the Anlagen entry - i.e. the tenant has no fleet
 * level. Wer eine Flotten-Ebene HAT, wird stattdessen auf das
 * Portfolio-Cockpit geleitet ({@link redirectToPortfolio}, das im Aufrufer
 * ZUERST greift) — hier bleibt nur der Einzel-Anlagen-Kunde übrig, und für den
 * ist alles unverändert.
 */
export function redirectOverviewToAnlage(i: ShellInput): boolean {
  if (i.isAdmin || !i.loaded) return false;
  if (isBetreiberShell(i.betriebsart)) return false;
  return !hatFlottenEbene(i);
}

/**
 * Wird die Landung auf das Portfolio-Cockpit umgelegt? Ein Mandant MIT
 * Flotten-Ebene, der auf `#/uebersicht` landet (Boot-Hash oder altes
 * Lesezeichen), wird auf `#/portfolio` geleitet — das ist der Weg, auf dem
 * seit Stufe 4 auch jedes Endkunden-Lesezeichen gilt. Admins sind
 * eingeschlossen: die Wahl im Umschalter bringt sie „über den Umschalter" ins
 * Portfolio des gewählten Kunden (Design §2.3).
 */
export function redirectToPortfolio(i: ShellInput): boolean {
  return showPortfolioNav(i);
}

/* ─────────────────────────────────────────────────────────────────────────────
   DIE STARTANSICHT-WEICHE (UEMS AP-01 IP-5, Captain-Entscheid E1 = A)
   „Die tiefste Ebene, die alles zeigt": 1 Standort/1 Anlage → Cockpit ·
   1 Standort/n Anlagen → Standort-Übersicht · n Standorte → Unternehmens-
   Übersicht; die Betriebsart-Regel bleibt. Ohne Standorte gilt ALLES wie heute
   — das ist die härteste Anforderung des Pakets, `migration.test.ts` beweist sie.
   ───────────────────────────────────────────────────────────────────────────── */

/** Ein Standort, wie die Weiche ihn braucht: Kennung, Name und die Anlagen, die ihm HEUTE zugeordnet sind. */
export interface OrtStandort {
  id: string;
  name: string;
  anlagen: string[];
}

/**
 * Die Ortsstruktur des Kundenbereichs HEUTE (`GET /api/v1/standorte` +
 * `GET /api/v1/unternehmen`). Am Aufrufer heisst `null`: nicht geladen, älteres
 * Backend oder Fehler — unbekannt ist keine Null, also gilt dann alles wie heute.
 */
export interface Orte {
  /** Die Standorte, die dieser Benutzer heute sieht (archivierte zählen nicht). */
  standorte: OrtStandort[];
  /** Die Standorte des Unternehmens insgesamt; `null` = unbekannt. */
  standorteGesamt: number | null;
  /** Kurzname, sonst Name des Unternehmens; `null` = keines angelegt. */
  unternehmen: string | null;
}

/**
 * Die oberste Ebene, die ein Kunde sieht.
 *
 * - `heute` — keine Standorte (oder nicht geladen), Betreiber oder Admin: die
 *   Weiche vor IP-5 entscheidet unverändert.
 * - `anlage` — ein Standort mit genau einer Anlage: beide oberen Ebenen sind
 *   übersprungen, der Kunde sieht, was er heute sieht.
 * - `standort` — ein Standort mit mehreren Anlagen, oder der Zugriff reicht nur
 *   auf einen Standort (`teilansicht`, AP-03): die Unternehmensebene ist übersprungen.
 * - `unternehmen` — mehrere Standorte, oder Anlagen, die noch keinem Standort
 *   zugeordnet sind (die Standort-Übersicht zeigte dann nicht alles).
 */
export type Ebene =
  | { art: 'heute' }
  | { art: 'anlage' }
  | { art: 'standort'; standort: OrtStandort; teilansicht: boolean }
  | { art: 'unternehmen'; name: string | null; standorte: OrtStandort[] };

export const EBENE_HEUTE: Ebene = { art: 'heute' };

/** Die zwei Antworten des Lesemodells → {@link Orte}. Das Portal zählt nichts nach. */
export function orteAus(liste: StandorteAmStichtag, unternehmen: Unternehmen | null): Orte {
  const angelegt = unternehmen?.zustand === 'angelegt' ? unternehmen : null;
  return {
    standorte: liste.standorte
      .filter((s) => s.zustand !== 'archiviert')
      .map((s) => ({ id: s.id, name: s.name, anlagen: s.anlagen.map((a) => a.id) })),
    standorteGesamt: angelegt ? angelegt.standortZahl : null,
    unternehmen: angelegt ? angelegt.kurzname?.trim() || angelegt.name?.trim() || null : null,
  };
}

/**
 * Welche Ebene ist die Landung (E1)? Die Reihenfolge ist Regel: erst was
 * „wie heute" bleibt, dann die Zahl der Standorte, dann die der Anlagen.
 */
export function startEbene(i: {
  isAdmin: boolean;
  betriebsart: Betriebsart | null;
  siteIds: string[];
  orte: Orte | null | undefined;
  eingeschraenkt?: boolean;
}): Ebene {
  const { orte } = i;
  // Ohne Standorte, als Admin (behält seine Übersicht) und als Betreiber
  // („Übersicht ab der ersten Anlage — unverändert") entscheidet die Weiche von heute.
  if ((!i.eingeschraenkt && i.isAdmin) || !orte || orte.standorte.length === 0) return EBENE_HEUTE;
  if (!i.eingeschraenkt && isBetreiberShell(i.betriebsart)) return EBENE_HEUTE;
  // 0 Anlagen: der Leerzustand der Übersicht ist die Landung — wie heute.
  if (!i.eingeschraenkt && i.siteIds.length === 0) return EBENE_HEUTE;
  if (orte.standorte.length >= 2) {
    return { art: 'unternehmen', name: orte.unternehmen, standorte: orte.standorte };
  }
  const standort = orte.standorte[0];
  // Zugriff nur auf einen von mehreren Standorten (AP-03): dessen Übersicht,
  // die Unternehmensebene ist nicht sichtbar — auch mit nur einer Anlage dort.
  if (orte.standorteGesamt != null && orte.standorteGesamt > 1) {
    return { art: 'standort', standort, teilansicht: true };
  }
  if (i.siteIds.length === 1) return { art: 'anlage' };
  if (i.siteIds.every((id) => standort.anlagen.includes(id))) {
    return { art: 'standort', standort, teilansicht: false };
  }
  // Eine Anlage ohne Standort: nur die Unternehmensebene zeigt alles.
  return { art: 'unternehmen', name: orte.unternehmen, standorte: orte.standorte };
}

/** Gibt es eine Flotten-Ebene über der Anlage? Ohne Ebene die Frage von heute. */
export function hatFlottenEbene(i: ShellInput): boolean {
  const art = i.ebene?.art ?? 'heute';
  if (art === 'anlage') return false;
  if (art === 'standort' || art === 'unternehmen') return true;
  return isFleetShell(i.betriebsart, i.siteCount);
}

/**
 * Wohin der Rückweg auf die Flotten-Ebene führt: auf die Standort-Übersicht,
 * wenn der Standort die oberste Ebene ist, sonst dorthin, wo er heute führt.
 */
export function flottenLandung(i: ShellInput): Route {
  if (i.ebene?.art === 'standort') return standortRoute(i.ebene.standort.id);
  return pageRoute(showPortfolioNav(i) ? 'portfolio' : 'uebersicht');
}

/** Ein Glied des Pfades im Seitenkopf VOR dem, was gerade offen ist. */
export interface PfadGlied {
  /** Die Ebene des Glieds; `flotte` = der Rückweg von heute („Meine Anlagen"). */
  ebene: 'flotte' | 'unternehmen' | 'standort';
  label: string;
  route: Route;
}

/** Der Pfad im Seitenkopf. */
export interface KopfPfad {
  /** Die Glieder davor, vom obersten an; leer = kein Rückweg im Pfad. */
  vor: PfadGlied[];
  /** Das letzte Glied, wenn es KEINE Anlage ist; `null` = wie heute (`pageLabel`). */
  hier: string | null;
}

function unternehmenGlied(name: string | null, fleet: string): PfadGlied {
  return { ebene: 'unternehmen', label: name ?? fleet, route: pageRoute('portfolio') };
}

function standortGlied(standort: OrtStandort): PfadGlied {
  return { ebene: 'standort', label: standort.name, route: standortRoute(standort.id) };
}

/**
 * Der Pfad „Unternehmen › Standort › Anlage" (IP-5). Übersprungene Ebenen
 * entfallen: ein Kunde mit genau einer Anlage an genau einem Standort sieht
 * nur „Halle 1 ▾" — genau das, was er heute sieht. `anlageId` ist die Anlage,
 * die die Schale zeigt (bei einer Anlagen-Route).
 */
export function kopfPfad(i: {
  shell: ShellInput;
  route: Route;
  anlageId: string | null;
  fleetLabel: string;
}): KopfPfad {
  const { shell, route, anlageId } = i;
  const ebene = shell.ebene ?? EBENE_HEUTE;
  if (route.page === 'anlagen') {
    if (ebene.art === 'standort') return { vor: [standortGlied(ebene.standort)], hier: null };
    if (ebene.art === 'unternehmen') {
      const standort = ebene.standorte.find((s) => anlageId != null && s.anlagen.includes(anlageId));
      return {
        vor: [unternehmenGlied(ebene.name, i.fleetLabel), ...(standort ? [standortGlied(standort)] : [])],
        hier: null,
      };
    }
    if (ebene.art === 'anlage') return { vor: [], hier: null };
    // `heute`: genau der Rückweg, den die Schale vor IP-5 zeigte.
    const flotte = showPortfolioNav(shell) || showOverviewNav(shell);
    return {
      vor: flotte ? [{ ebene: 'flotte', label: i.fleetLabel, route: flottenLandung(shell) }] : [],
      hier: null,
    };
  }
  if (route.page === 'standort') {
    if (ebene.art === 'standort' && route.standortId === ebene.standort.id) {
      return { vor: [], hier: ebene.standort.name };
    }
    if (ebene.art === 'unternehmen') {
      const standort = ebene.standorte.find((s) => s.id === route.standortId);
      if (standort) return { vor: [unternehmenGlied(ebene.name, i.fleetLabel)], hier: standort.name };
    }
    return { vor: [], hier: null };
  }
  if (route.page === 'portfolio' && ebene.art === 'unternehmen' && ebene.name) {
    return { vor: [], hier: ebene.name };
  }
  return { vor: [], hier: null };
}

/** Der Wert, mit dem der Anlagen-Umschalter ein Pfad-Glied meint. `flotte` = `anlagenWahl.ALLE_ANLAGEN`. */
export function pfadWert(glied: PfadGlied): string {
  return glied.ebene === 'flotte' ? '__all__' : `__${glied.ebene}__`;
}

/**
 * Die Zeile eines Pfad-Glieds im Anlagen-Umschalter. Am Telefon zeigt die
 * Kopfzeile nur den Anlagennamen — dort SIND diese Zeilen der Rückweg.
 */
export function pfadZeile(glied: PfadGlied): { value: string; label: string; sub: string } {
  const sub =
    glied.ebene === 'unternehmen'
      ? `${UEMS_UNTERNEHMEN} · Übersicht`
      : glied.ebene === 'standort'
        ? `${UEMS_STANDORT} · Übersicht`
        : 'Zurück zur Übersicht';
  return { value: pfadWert(glied), label: glied.label, sub };
}

/**
 * One post-hydration canonical destination for the shell. The caller applies
 * at most one history replacement; no intermediate `#/anlagen` or
 * `#/uebersicht` route is ever emitted.
 *
 * UEMS AP-01 IP-5: `shell.ebene` legt die Landung auf die Standort- oder die
 * Unternehmens-Übersicht; ohne Ebene (`heute`) ist jeder Zweig der von vorher,
 * und `#/standort/…` führt dorthin, wo der Kunde heute landet.
 */
export function canonicalShellRoute(input: {
  shell: ShellInput;
  route: Route;
  siteIds: string[];
}): Route | null {
  const { shell, route, siteIds } = input;
  if (!shell.loaded || !shell.tenantReady) return null;
  const ebene = shell.ebene ?? EBENE_HEUTE;
  const fleet = ebene.art === 'heute' ? isFleetShell(shell.betriebsart, siteIds.length) : ebene.art !== 'anlage';
  const nakedAnlage = route.page === 'anlagen' && route.siteId == null && route.sub == null;
  const invalidSite = route.page === 'anlagen'
    && route.siteId != null
    && !siteIds.includes(route.siteId);
  const standortSeite = route.page === 'standort';

  // Admins keep their explicit customer overview. A fleet context has exactly
  // one portfolio landing; without that shell level, old portfolio bookmarks
  // return to the customer overview instead of rendering an orphaned surface.
  if (shell.isAdmin) {
    if (fleet) {
      if (route.page === 'uebersicht' || nakedAnlage || invalidSite || standortSeite) return pageRoute('portfolio');
      return null;
    }
    if (isPortfolioPage(route.page) || invalidSite || standortSeite) return pageRoute('uebersicht');
    return null;
  }

  if (ebene.art === 'standort') {
    // Die Unternehmensebene ist übersprungen: auch `#/portfolio` landet hier.
    // Die Reiter Messwerte · Erlöse · Standorte bleiben erreichbar.
    const landung = standortRoute(ebene.standort.id);
    if (route.page === 'uebersicht' || route.page === 'portfolio' || nakedAnlage || invalidSite) return landung;
    if (standortSeite && route.standortId !== ebene.standort.id) return landung;
    return null;
  }

  if (ebene.art === 'unternehmen') {
    if (route.page === 'uebersicht' || nakedAnlage || invalidSite) return pageRoute('portfolio');
    if (standortSeite && !ebene.standorte.some((s) => s.id === route.standortId)) return pageRoute('portfolio');
    return null;
  }

  if (fleet) {
    if (route.page === 'uebersicht' || nakedAnlage || invalidSite || standortSeite) return pageRoute('portfolio');
    return null;
  }

  const soleSiteId = siteIds.length === 1 ? siteIds[0] : null;
  if (!soleSiteId) return standortSeite ? pageRoute('uebersicht') : null;
  if (route.page === 'uebersicht' || nakedAnlage || isPortfolioPage(route.page) || standortSeite) {
    return anlageRoute(soleSiteId);
  }
  if (invalidSite) {
    // Preserve the requested deep section/device while correcting the only
    // invalid segment. This avoids silently rendering the sole site under a
    // foreign URL, which `resolveAnlage` would otherwise do.
    return { ...route, siteId: soleSiteId };
  }
  return null;
}

/**
 * Build the single canonical replacement without losing route-local filter,
 * zoom or time parameters. Route intentionally models only the path, so the
 * query suffix must travel byte-for-byte from the browser hash.
 */
export function canonicalShellHash(target: Route, currentHash: string): string {
  const queryStart = currentHash.indexOf('?');
  return `${hashForRoute(target)}${queryStart < 0 ? '' : currentHash.slice(queryStart)}`;
}

/**
 * Landet dieser Aufruf auf der PLATTFORM-ÜBERSICHT statt auf der
 * Kunden-Übersicht? (Admin-Umbau Stufe 1, Captain-Entscheid F1.)
 *
 * Ein Admin-Boot rendert bis hierher die KUNDEN-Übersicht - ohne gewählten
 * Mandanten praktisch leer -, während die Plattform-Übersicht, die als
 * „täglicher erster Blick" gebaut wurde (Captain-Entscheid Q1), einen Klick
 * entfernt lag. Der Admin soll auf seiner Landung aufwachen.
 *
 * ⚠ Die Bedingung ist der LEERE Boot-Hash, nicht „die Übersicht ist offen":
 * ein Admin hat den Nav-Punkt „Übersicht" weiterhin und muss ihn anklicken
 * können, ohne sofort weitergeleitet zu werden. Deshalb entscheidet
 * ausschließlich, ob der Aufruf überhaupt ein Ziel genannt hat - ein
 * Deep-Link (auch `#/uebersicht`) bleibt unangetastet, und die Weiterleitung
 * läuft genau EINMAL je Sitzung (der Aufrufer merkt sich das).
 */
export function redirectAdminToPlattform(i: { isAdmin: boolean; bootHash: boolean }): boolean {
  return i.isAdmin && i.bootHash;
}
