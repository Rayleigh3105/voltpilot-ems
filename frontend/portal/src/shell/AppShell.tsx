import { KundenbereichEndeHinweis } from '../components/KundenbereichEndeHinweis';
import { UnterstuetzungBanner } from '../components/UnterstuetzungBanner';
import { useRollen } from '../rollen';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Badge } from '../../designsystem/components/core/Badge';
import { Icon } from '../../designsystem/components/core/Icon';
import { FUNKTIONEN_EINTRAG } from '../messenEinstieg';
import { NavItem } from '../../designsystem/components/shell/NavItem';
// Die BESCHNITTENE Wortmarke (640x152, 9 kB), nicht die 292-kB-Bestandsdatei
// (Perf-Review `vp-cockpit-perf-p7` §2 U3): die grosse Datei traegt einen
// grosszuegigen transparenten Rand und lud KALT VOR der ersten API-Welle -
// 292 kB, die auf Mobilfunk um Bandbreite und Verbindungsplaetze konkurrierten,
// fuer ein Bild, dessen sichtbarer Teil ~40 % der Flaeche fuellt. Die
// Wortmarke ist laut `designsystem/assets/README.md` genau dafuer angelegt
// (und die Anmeldeseite benutzt sie seit dem 23.08. schon).
import logoUrl from '../../designsystem/assets/voltpilot-wordmark.png';
import { currentUser, logout } from '../auth';
import type { Tenant } from '../admin/adminApi';
import {
  MAIN_PAGES,
  PLATFORM_GROUPS,
  navPageFor,
  PORTFOLIO_PAGE,
  pageLabel,
  STANDORT_PAGE,
  type PageId,
} from '../nav';
import {
  bottomBarSlots,
  HELP_ITEM,
  type AnlageSidebar,
  type EbenenBereichId,
  type EbenenKachel,
  type NavTarget,
  type SidebarItem,
} from '../ebenenNav';
import type { HealthBadge } from '../health';
import { VpPicker } from '../components/VpPicker';
import type { VpOption } from '../picker/optionen';
import type { AnlagenSub, Route } from '../nav';
import { HealthBadgeButton } from './HealthBadgeButton';
import './Shell.css';
import { HelpProvider, HelpLink } from '../help/HelpProvider';
import type { HelpArticleId } from '../help/model';

/**
 * Die Anlagen-Navigation der Schale — seit der Navigations-Runde „zwei Ebenen"
 * (Konzept `data/vp-portfolio-konzept-r2` §5.5, Captain-Entscheide E3/E4 vom
 * 25.08.2026) sind es die FÜNF BEREICHE aus `ebenenNav.ts`, der Pfad
 * („Portfolio › Solarpark Dachau ▾") in der Kopfzeile und der Fuß
 * (Hilfe & Kontakt).
 *
 * Was dabei ERSATZLOS entfallen ist: die Anlagen-Picker-KARTE der Seitenleiste
 * (der Umschalter wohnt im Pfad), der Link „‹ Alle Anlagen" (der Pfad IST der
 * Rückweg) und die farbigen Anwendungs-Gruppen (ihre Ansichten sind Reiter
 * geworden). Die Seitenleiste ändert ihre FORM damit nie: Portfolio · fünf
 * Bereiche · Fuß.
 */
export interface AnlageNav {
  /** The Anlage in scope (the switcher's current value). */
  siteId: string;
  siteName: string;
  /** All Anlagen of the tenant; 2+ turn the label into a real switcher. */
  sites: { id: string; name: string }[];
  /**
   * Die ANGEREICHERTEN Zeilen des Anlagen-Pickers (`anlagenWahl.anlagenOptionen`):
   * je Anlage Gesundheits-Punkt + Nebenzeile, plus die Flotten-Zeile ganz oben.
   *
   * ⚠ Sie kommen FERTIG von aussen - die Schale rechnet keine Gesundheit. Eine
   * zweite Ableitung liesse Kopfzeile und Liste über dieselbe Anlage
   * Verschiedenes behaupten. Fehlen sie (älterer Aufrufer), fällt der Picker
   * auf blosse Namen zurück.
   */
  siteOptions?: VpOption[];
  onSelectSite: (siteId: string) => void;
  /** Das Bereichs-Modell (`anlageSidebar`), hier NIE neu abgeleitet. */
  sidebar: AnlageSidebar;
  /** Welcher BEREICH gerade offen ist (`activeAreaKey`). */
  activeKey: string | null;
  onOpenSub: (sub: AnlagenSub | null) => void;
  onOpenPage: (page: PageId) => void;
  /** Der Rückweg auf die Flotten-Ebene; null = es gibt keine. */
  onOpenFleet: (() => void) | null;
  /**
   * UEMS AP-01 IP-5: die Glieder des Pfades VOR dem Anlagennamen
   * („Ahrenberg › Werk Ahrenberg ›", `betriebsart.kopfPfad`); jedes ist auch
   * eine Zeile des Umschalters (`wert`). Absent = der Rückweg von heute
   * (`onOpenFleet` unter `fleetLabel`).
   */
  pfad?: PfadEintrag[];
  /** The aggregated plant state; null = not known yet (no badge is shown). */
  health: HealthBadge | null;
}

/**
 * Die Telefon-Leiste der Unternehmens- oder Standort-Ebene (UEMS AP-01 IP-7,
 * E4 = A). Die Kacheln kommen FERTIG aus `ebenenNav.ebenenLeiste` — Bereiche
 * mit Seite, erst ab drei; die Schale leitet hier nichts ab.
 */
export interface EbenenLeisteNav {
  /** Der Name der Leiste („Bereiche des Unternehmens Kunststoffwerk Ahrenberg GmbH"). */
  titel: string;
  kacheln: EbenenKachel[];
  /** Welcher Bereich gerade offen ist (`ebenenAktiv`). */
  aktiv: EbenenBereichId | null;
  onOpen: (ziel: Route) => void;
}

/** Ein Glied des Pfades in der Kopfzeile (UEMS AP-01 IP-5). */
export interface PfadEintrag {
  /** Zugleich der Wert seiner Zeile im Anlagen-Umschalter. */
  wert: string;
  label: string;
  onOpen: () => void;
}

/**
 * Der Wert, mit dem der Umschalter die FLOTTEN-Ebene meint - wortgleich mit
 * `anlagenWahl.ALLE_ANLAGEN` (die Zeilen kommen von dort). Wie sie HEISST,
 * sagt `fleetLabel`; hier steht nur ihr Schlüssel.
 */
const ALL_SITES = '__all__';

/**
 * The unified dashboard shell: left sidebar (primary navigation, identical for
 * both roles; Portal-Admins additively get the "Plattform" group), top bar
 * (breadcrumb, tenant context, user menu) and the main content area.
 *
 * Seit E4 hat das TELEFON keine „Mehr"-Klappe mehr: die Leiste trägt die fünf
 * Bereiche der Anlage, und Hilfe · Abmelden · Plattform wohnen im Avatar-Menü.
 * Auf der Flotten-Ebene gibt es GAR KEINE Leiste — dort navigieren die Reiter
 * der Portfolio-Seite.
 */
export function AppShell({
  page,
  onNavigate,
  isAdmin,
  showOverview,
  showPortfolio,
  fleetLabel = PORTFOLIO_PAGE.label,
  showAddAnlage,
  onAddAnlage,
  onFunktionen,
  counts,
  tenants,
  tenantOverride,
  onTenantChange,
  anlage = null,
  ebenen = null,
  ortsPfad = null,
  helpArticle = null,
  children,
  ohneStandort = false,
  teilansicht = null,
}: {
  ohneStandort?: boolean;
  teilansicht?: string | null;
  page: PageId;
  onNavigate: (page: PageId) => void;
  isAdmin: boolean;
  /** Show the "Übersicht" nav item (fleet customers + admins only). */
  showOverview: boolean;
  /**
   * Zeigt die Schale die FLOTTEN-EBENE (das Portfolio) als Punkt — und ist die
   * Landung damit dort? Er ersetzt „Übersicht" (dann ist `showOverview` false).
   */
  showPortfolio: boolean;
  /**
   * Wie die Flotten-Ebene HEISST (`betriebsart.fleetLabel`): „Portfolio" beim
   * Betreiber, „Meine Anlagen" beim Endkunden — nur das WORT folgt der
   * Tonalität, die Ebene gibt es genau einmal.
   */
  fleetLabel?: string;
  /**
   * UEMS AP-01 IP-5: der Pfad einer Seite OHNE Anlage — die Standort-Übersicht
   * („Ahrenberg › Werk Ahrenberg") und die Unternehmens-Übersicht („Ahrenberg").
   * `null` = wie heute der Seitenname.
   */
  ortsPfad?: { vor: PfadEintrag[]; hier: string } | null;
  /**
   * Show the always-visible "＋ Anlage hinzufügen" header action. Scoped to a
   * single-Anlage customer (see `showAddAnlageButton`) - their only obvious way
   * to a second Anlage, reachable from every page.
   */
  showAddAnlage: boolean;
  /** Open the "Anlage anlegen" one-flow drawer (hosted by the caller). */
  onAddAnlage: () => void;
  /**
   * AP-01 E5 = A: „Funktionen“ im Avatar-Menü führt zur Karte „Funktionen“ der Übersicht. Ohne Ziel (Anlage-
   * oder Bestands-Landung, keine Karte) gibt es den Eintrag nicht.
   */
  onFunktionen?: () => void;
  counts: { sites: number | null; devices: number | null };
  /** Admin only: tenants for the context switcher. */
  tenants: Tenant[];
  /** Admin only: the selected tenant id ('' = Alle Mandanten). */
  tenantOverride: string | null;
  onTenantChange: (tenantId: string | null) => void;
  /** Die Anlagen-Navigation (fünf Bereiche + Pfad); null = keine Anlage offen. */
  anlage?: AnlageNav | null;
  /**
   * UEMS AP-01 IP-7: die Telefon-Leiste der Unternehmens- oder Standort-Ebene;
   * null = keine (unter drei Bereichen mit Seite). In einer Anlage gilt IHRE Leiste.
   */
  ebenen?: EbenenLeisteNav | null;
  helpArticle?: HelpArticleId | null;
  children: React.ReactNode;
}) {
  const user = currentUser();
  const { benutzerLesen, selbst } = useRollen();
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * S8 · „Plattform ▸" ist EINGEKLAPPT, solange ein Mandant gewählt ist — der
   * Admin ist dann in der Rolle des Kunden unterwegs. Ohne Mandant bleibt sie
   * aufgeklappt wie bisher. Der Zustand ist bedienbar (der Betreiber darf sie
   * jederzeit öffnen); die WAHL des Mandanten setzt ihn nur neu.
   */
  const [platformOpen, setPlatformOpen] = useState(!tenantOverride);
  useEffect(() => {
    setPlatformOpen(!tenantOverride);
  }, [tenantOverride]);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const topbarRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const topbar = topbarRef.current;
    const app = topbar?.closest<HTMLElement>('.vp-app');
    if (!topbar || !app) return;
    const updateHeight = () => app.style.setProperty('--vp-topbar-height', `${topbar.getBoundingClientRect().height}px`);
    updateHeight();
    // The admin tenant picker adds a row on phones. Fixed cockpit summaries
    // follow the measured header, including font changes and picker resizing.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(topbar);
    return () => observer.disconnect();
  }, []);

  // Navigation schliesst das Avatar-Menü.
  useEffect(() => {
    setMenuOpen(false);
  }, [page]);

  // Escape oder ein Klick daneben schliesst das Avatar-Menü.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [menuOpen]);

  const initials = (user.name || 'VP')
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  /**
   * ONE place that turns a nav target into navigation — sidebar, bottom bar and
   * the Avatar menu all go through it, so they can never drift.
   */
  const openTarget = (target: NavTarget) => {
    setMenuOpen(false);
    switch (target.kind) {
      case 'sub':
        anlage?.onOpenSub(target.sub);
        return;
      case 'page':
        // Inside an Anlage the page jump keeps its Anlage context; at fleet
        // level there is none, so the plain shell navigation carries it.
        if (anlage) anlage.onOpenPage(target.page);
        else onNavigate(target.page);
        return;
      case 'help':
        onNavigate('hilfe');
        return;
      case 'action':
      default:
        if (target.action === 'add-anlage') onAddAnlage();
        else logout();
    }
  };

  /**
   * Die Telefon-Leiste: in einer Anlage ihre fünf Bereiche (E4), auf der
   * Unternehmens- oder Standort-Ebene deren Bereiche mit Seite, erst ab drei
   * (UEMS AP-01 IP-7) — sonst keine: dann navigieren die Reiter der Seite, eine
   * zweite Leiste daneben wäre ein zweites Menü für dieselbe Ebene.
   */
  const barSlots: { key: string; label: string; icon: SidebarItem['icon']; badge: number | null; aktiv: boolean; oeffnen: () => void }[] =
    anlage
      ? bottomBarSlots(anlage.sidebar).map((item) => ({
          key: item.key,
          label: item.label,
          icon: item.icon,
          badge: item.badge,
          aktiv: anlage.activeKey === item.key,
          oeffnen: () => openTarget(item.target),
        }))
      : (ebenen?.kacheln ?? []).map((kachel) => ({
          key: kachel.key,
          label: kachel.label,
          icon: kachel.icon,
          badge: null,
          aktiv: ebenen?.aktiv === kachel.key,
          oeffnen: () => ebenen?.onOpen(kachel.ziel),
        }));
  const barName = anlage ? `Bereiche der Anlage ${anlage.siteName ?? ''}`.trim() : ebenen?.titel ?? '';
  /** 2+ Anlagen or a fleet level to return to = there is something to switch. */
  const canSwitchAnlage =
    !!anlage && (anlage.sites.length > 1 || !!anlage.onOpenFleet || (anlage.pfad?.length ?? 0) > 0);
  /** Die Glieder VOR dem Anlagennamen: der Pfad (IP-5), sonst der Rückweg von heute. */
  const anlagePfad: PfadEintrag[] = anlage
    ? anlage.pfad
      ?? (anlage.onOpenFleet ? [{ wert: ALL_SITES, label: fleetLabel ?? '', onOpen: anlage.onOpenFleet }] : [])
    : [];

  const navEntry = (item: SidebarItem) => (
    <NavItem
      key={item.key}
      icon={<Icon name={item.icon} size={18} />}
      // The label is wrapped so the tablet icon rail can hide it in CSS while
      // the accessible name (and the tooltip) stay intact.
      label={<span className="vp-nav-lbl">{item.label}</span>}
      count={item.badge}
      active={item.target.kind === 'help' ? page === 'hilfe' : anlage?.activeKey === item.key}
      // ⚠ Der Titel NENNT das Abzeichen, wo es eines gibt (Steuerung Stufe 8):
      // ein nacktes „2" an einer Seitenleiste ist ein Rätsel, und der Satz ist
      // die EINE Stelle, an der steht, was gezählt wurde.
      title={item.badgeTitel ? `${item.label} — ${item.badgeTitel}` : item.label}
      onClick={() => openTarget(item.target)}
    />
  );

  /**
   * Die Zeilen des Anlagen-Pickers. Kommen sie fertig von aussen
   * (`anlagenWahl.anlagenOptionen`), tragen sie Punkt und Nebenzeile; sonst
   * bleibt es beim blossen Namen - nie eine hier erfundene Gesundheit.
   */
  const anlagenZeilen: VpOption[] = anlage
    ? anlage.siteOptions
      ?? [
        ...anlage.sites.map((s) => ({ value: s.id, label: s.name })),
        ...(anlage.onOpenFleet
          ? [{ value: ALL_SITES, label: fleetLabel, sub: 'Zurück zur Übersicht' }]
          : []),
      ]
    : [];

  /** Der EINE Ort, an dem ein Anlagen-Wechsel entschieden wird. */
  const waehleAnlage = (wert: string) => {
    const glied = anlage?.pfad?.find((g) => g.wert === wert);
    if (glied) glied.onOpen();
    else if (wert === ALL_SITES) anlage?.onOpenFleet?.();
    else anlage?.onSelectSite(wert);
  };

  /**
   * Die fünf Bereiche der offenen Anlage — OHNE Gruppen-Überschrift und ohne
   * Picker-Karte (E3): der Umschalter wohnt im Pfad der Kopfzeile, und eine
   * Überschrift „Anlage" über einem Bereich, der ebenfalls „Anlage" heisst,
   * wäre nur Rauschen.
   */
  const anlageNav = anlage && (
    <div className="vp-anlagenav">{anlage.sidebar.bereiche.map(navEntry)}</div>
  );

  const sidebar = (
    // Desktop (>=1024px) and the tablet icon rail (721-1023px) are unchanged.
    // The phone slide-over is GONE since Mobil-Umbau Stufe 1: the bottom bar
    // covers every destination of an Anlage, so a second menu (and its
    // hamburger) would only compete with the thumb pattern.
    <aside className="vp-sidebar">
      <div className="brand">
        <img src={logoUrl} alt="VoltPilot EMS" />
      </div>
      <nav aria-label="Hauptnavigation">
        {showPortfolio && (
          // Die FLOTTEN-Ebene führt die Leiste. Ihre zwei Welten (Messwerte ·
          // Erlöse) sind seit E3 REITER der Portfolio-Seite — die frühere
          // Gruppe der Flotten-Welten ist dort aufgegangen.
          <NavItem
            icon={<Icon name={PORTFOLIO_PAGE.icon} size={18} />}
            label={<span className="vp-nav-lbl">{fleetLabel}</span>}
            title={fleetLabel}
            active={page === PORTFOLIO_PAGE.id || page === STANDORT_PAGE.id}
            onClick={() => onNavigate(PORTFOLIO_PAGE.id)}
          />
        )}
        {MAIN_PAGES.filter((p) => !ohneStandort && (p.id !== 'uebersicht' || showOverview)).map((p) => (
          <NavItem
            key={p.id}
            icon={<Icon name={p.icon} size={18} />}
            label={<span className="vp-nav-lbl">{p.label}</span>}
            title={p.label}
            active={page === p.id}
            onClick={() => onNavigate(p.id)}
          />
        ))}
        {anlageNav}
        {isAdmin && (
          // Admin-Umbau Stufe 1 „Ordnung": die elf flachen Punkte sind vier
          // benannte Gruppen hinter der LANDUNG (Plattform-Übersicht). Seit S8
          // ist der ganze Block ZUSAMMENKLAPPBAR und startet eingeklappt,
          // solange ein Mandant gewählt ist.
          <>
            <button
              type="button"
              className="vp-nav-group-label vp-nav-fold"
              aria-expanded={platformOpen}
              onClick={() => setPlatformOpen((v) => !v)}
            >
              <Icon name={platformOpen ? 'chevron-down' : 'chevron-right'} size={14} />
              <span className="vp-nav-lbl">Plattform</span>
            </button>
            {platformOpen &&
              PLATFORM_GROUPS.map((group) => (
                <div className="vp-navgroup" key={group.key}>
                  {/* Die Landung trägt keine eigene Überschrift - sie steht schon
                      unter „Plattform" und braucht keine zweite Zeile. */}
                  {group.label && (
                    <div className="vp-nav-group-label vp-nav-sublabel">
                      <span className="vp-nav-lbl">{group.label}</span>
                    </div>
                  )}
                  {group.pages.map((p) => (
                    <NavItem
                      key={p.id}
                      icon={<Icon name={p.icon} size={18} />}
                      label={<span className="vp-nav-lbl">{p.label}</span>}
                      title={p.label}
                      // Seit Stufe 3 leuchtet der BEREICH, nicht die Seite: der
                      // Tab „Updates" gehört zu „Geräte", also darf die Leiste
                      // dort nicht ins Nichts zeigen.
                      active={navPageFor(page) === p.id}
                      count={p.id === 'mandanten' && tenants.length ? tenants.length : null}
                      onClick={() => onNavigate(p.id)}
                    />
                  ))}
                </div>
              ))}
          </>
        )}
      </nav>
      <div className="side-foot">
        {(anlage?.sidebar.foot ?? [HELP_ITEM]).map(navEntry)}
        <p className="vp-note vp-nav-lbl" style={{ margin: 0, padding: '0 var(--vp-space-3)' }}>
          VoltPilot EMS
        </p>
      </div>
    </aside>
  );

  return (
    <HelpProvider><div className="vp-app">
      {sidebar}

      <div className="vp-content">
        <header className="vp-topbar" ref={topbarRef}>
          {/* Der PFAD ersetzt den Sprung (E3): „Portfolio › Solarpark Dachau ▾".
              Der Name IST der Anlagen-Umschalter, das führende Wort der
              Rückweg auf die Flotten-Ebene. Auf einer Anlage ohne Flotte
              bleibt nur der Name. */}
          <div className={anlage ? 'vp-topbar-anlage' : ortsPfad ? 'crumbs vp-crumbs-ort' : 'crumbs'}>
            {anlage ? (
              <div className="crumbs">
                {/* IP-5: „Ahrenberg › Werk Ahrenberg ›" — übersprungene Ebenen
                    fehlen, ohne Standorte ist es der Rückweg von heute. */}
                {anlagePfad.map((glied) => (
                  <Fragment key={glied.wert}>
                    <button type="button" className="vp-crumb-up" onClick={glied.onOpen}>
                      {glied.label}
                    </button>
                    <span className="vp-crumb-sep" aria-hidden="true">
                      ›
                    </span>
                  </Fragment>
                ))}
                {/* The breadcrumb names the ANLAGE, not the menu item ("Hof
                    Lindenberg", not "Meine Anlagen") - that is what the
                    customer is looking at (G1). The full text stays in the
                    title for a truncated phone width. */}
                {/* Der NAME ist der Umschalter — auf BEIDEN Breiten (E3: es
                    gibt keine Picker-Karte in der Seitenleiste mehr, das hier
                    ist der einzige Wechsler). Die unsichtbare Fläche liegt am
                    Rechner über genau diesem Block, damit der Rückweg links
                    und das Zustands-Abzeichen daneben anklickbar bleiben; am
                    Telefon über der ganzen Kopfzeile (die dokumentierte
                    68-px-Trefferfläche). EINE absolute Regel, zwei Anker. */}
                <span className="vp-crumb-anlage">
                  <span className="here" title={anlage.siteName}>
                    {anlage.siteName}
                  </span>
                  {canSwitchAnlage && (
                    <>
                      <Icon name="chevron-down" size={16} className="vp-tb-caret" />
                      <VpPicker
                        className="vp-tb-switchwrap"
                        triggerClassName="vp-tb-switch"
                        ariaLabel="Anlage wechseln"
                        options={anlagenZeilen}
                        value={anlage.siteId}
                        onChange={waehleAnlage}
                        searchPlaceholder="Anlage suchen …"
                      />
                    </>
                  )}
                </span>
              </div>
            ) : ortsPfad ? (
              // IP-5: die Standort- und die Unternehmens-Übersicht nennen ihren
              // Ort; der Rückweg bleibt am Telefon sichtbar (keine Leiste dort).
              <>
                {ortsPfad.vor.map((glied) => (
                  <Fragment key={glied.wert}>
                    <button type="button" className="vp-crumb-up" onClick={glied.onOpen}>
                      {glied.label}
                    </button>
                    <span className="vp-crumb-sep" aria-hidden="true">
                      ›
                    </span>
                  </Fragment>
                ))}
                <span className="here" title={ortsPfad.hier}>
                  {ortsPfad.hier}
                </span>
              </>
            ) : (
              <span className="here">{pageLabel(page, counts.sites)}</span>
            )}
            {anlage?.health && (
              // ONE aggregated plant state, always in sight (concept tab 2) —
              // and a REAL control: the worst cause is visible text, one click
              // lists every finding, and "Zur Anlage" leads to the plant's
              // Zustand card (a warning names its cause and is reachable in one
              // click). On a phone it renders as the switcher's sub-line.
              <HealthBadgeButton
                health={anlage.health}
                onOpenDetail={() => anlage.onOpenSub(null)}
              />
            )}
          </div>
          <div className="spacer" />

          {showAddAnlage && (
            // The single-Anlage customer's always-visible way to a second
            // Anlage. Icon + label on wider screens, icon-only on phones (the
            // aria-label keeps it accessible). Opens the same one-flow drawer.
            <Button
              variant="primary"
              size="sm"
              className="vp-add-anlage-btn"
              iconLeft={<Icon name="plus" size={18} />}
              onClick={onAddAnlage}
              aria-label="Anlage hinzufügen"
            >
              <span className="vp-add-anlage-label">Anlage hinzufügen</span>
            </Button>
          )}

          {isAdmin && (
            // Admin: the context chip is a real tenant SWITCHER - the operator's
            // core cross-tenant tool. Picking a tenant renders the customer
            // pages for that tenant (RLS-scoped via the X-Tenant-Id header, see
            // api.ts). The leading building icon + trailing caret make it
            // unmistakably THE Mandanten control and clearly a dropdown.
            // Customers get no chip: their tenant is fixed by the login.
            <span className="vp-context" title="Mandanten-Umschalter">
              <Icon name="building" size={16} className="vp-context-ic" />
              <VpPicker
                className="vp-context-picker"
                ariaLabel="Mandanten-Umschalter"
                options={[
                  { value: '', label: 'Alle Mandanten' },
                  ...tenants.map((t) => ({ value: t.id, label: t.name })),
                ]}
                value={tenantOverride ?? ''}
                onChange={(v) => onTenantChange(v || null)}
                searchPlaceholder="Mandant suchen …"
              />
            </span>
          )}

          <div className="vp-usermenu" ref={menuRef}>
            <div className="meta">
              <div className="n">
                {user.name}{' '}
                {isAdmin && (
                  <Badge variant="solid" style={{ fontSize: '0.62rem', verticalAlign: 'middle' }}>
                    ADMIN
                  </Badge>
                )}
              </div>
              {user.email && user.email !== user.name && <div className="e">{user.email}</div>}
            </div>
            {/* E4: das Avatar-Menü ist der Wohnort von Hilfe · Abmelden — und am
                Telefon zusätzlich der Plattform-Gruppe, weil die Seitenleiste
                dort nicht rendert und es keinen Hamburger mehr gibt. */}
            <button
              type="button"
              className="vp-avatar vp-avatar-btn"
              title={user.name}
              aria-label={`${initials} – Konto-Menü`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              {initials}
            </button>
            {menuOpen && (
              <div className="vp-avatarmenu" role="menu" aria-label="Konto-Menü">
                {benutzerLesen && <button type="button" role="menuitem" className="vp-avatarmenu-item"
                  onClick={() => openTarget({ kind: 'page', page: 'kunden-benutzer' })}>
                  <Icon name="users" size={18} />Benutzer
                </button>}
                {onFunktionen && (
                  <button
                    type="button"
                    role="menuitem"
                    className="vp-avatarmenu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onFunktionen();
                    }}
                  >
                    <Icon name="layers" size={18} />
                    {FUNKTIONEN_EINTRAG}
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="vp-avatarmenu-item"
                  onClick={() => openTarget({ kind: 'help' })}
                >
                  <Icon name="help-circle" size={18} />
                  Hilfe &amp; Kontakt
                </button>
                {isAdmin && (
                  // Nur am Telefon eingeblendet (CSS): am Rechner steht die
                  // Plattform-Gruppe in der Seitenleiste, ein zweiter Ort für
                  // dieselben Punkte wäre eine Doppelung.
                  <div className="vp-avatarmenu-phone">
                    <div className="vp-avatarmenu-head">Plattform</div>
                    {PLATFORM_GROUPS.flatMap((g) => g.pages).map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="menuitem"
                        className="vp-avatarmenu-item"
                        onClick={() => openTarget({ kind: 'page', page: p.id })}
                      >
                        <Icon name={p.icon} size={18} />
                        {p.label}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="vp-avatarmenu-item"
                  onClick={() => openTarget({ kind: 'action', action: 'logout' })}
                >
                  <Icon name="log-out" size={18} />
                  Abmelden
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="vp-main has-bottombar">
          {helpArticle && <div className="vp-context-help"><HelpLink article={helpArticle} /></div>}
          {teilansicht && <p className="vp-alert" role="status">{teilansicht}</p>}
          {selbst?.konto === 'partner' && <div className="vp-kundenbereich-wechsel"><VpPicker label="Kundenbereich"
            value={tenantOverride ?? ''} onChange={v => onTenantChange(v || null)} options={[
              { value: '', label: 'Kundenbereich wählen' },
              ...[...new Map((selbst.kundenbereiche ?? []).filter(k => Date.parse(k.endet) > Date.now()).map(k => [k.id, k])).values()].map(k => ({ value: k.id, label: k.name })),
            ]} /></div>}
          <KundenbereichEndeHinweis beendet={selbst?.kundenbereich?.beendet} />
          <UnterstuetzungBanner />
          {children}
        </main>
      </div>

      {/* Die Telefon-Leiste trägt seit E4 die FÜNF Bereiche der Anlage und
          KEINE „Mehr"-Kachel — es gibt nichts mehr zu falten. Auf der
          Unternehmens- und Standort-Ebene trägt sie deren Bereiche mit Seite,
          erst ab drei (IP-7); darunter rendert sie gar nicht (dort navigieren
          die Reiter). Oberhalb von 720 px blendet CSS sie aus. */}
      {barSlots.length > 0 && (
        <nav
          className="vp-bottombar"
          aria-label={barName}
          style={{ ['--vp-bar-slots' as string]: String(barSlots.length) } as React.CSSProperties}
        >
          {barSlots.map((item) => {
            const active = item.aktiv;
            return (
              <button
                key={item.key}
                type="button"
                className={`vp-bottombar-item${item.key === 'netzanschluesse' ? ' vp-bottombar-netzanschluesse' : ''}${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={item.oeffnen}
              >
                <span className="ic" aria-hidden="true">
                  <Icon name={item.icon} size={20} />
                  {item.badge != null && <span className="vp-bottombar-badge">{item.badge}</span>}
                </span>
                <span className="lbl">{item.label}</span>
              </button>
            );
          })}
        </nav>
      )}

    </div></HelpProvider>
  );
}
