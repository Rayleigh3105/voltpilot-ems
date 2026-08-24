import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AppShell } from './AppShell';
import { anlageSidebar } from '../anlageNav';
import { anlageSurface } from '../surface';

// Avoid pulling in keycloak-js: the shell only needs a name for the avatar.
vi.mock('../auth', () => ({
  currentUser: () => ({ name: 'Erika Kaiser', email: 'erika@example.com', roles: [] }),
  logout: vi.fn(),
}));

const baseProps = {
  page: 'anlagen' as const,
  onNavigate: vi.fn(),
  isAdmin: false,
  showOverview: false,
  counts: { sites: 1, devices: 1 },
  tenants: [],
  tenantOverride: null,
  onTenantChange: vi.fn(),
};

describe('AppShell "＋ Anlage hinzufügen" header action', () => {
  it('renders the action and opens the flow when showAddAnlage is true', () => {
    const onAddAnlage = vi.fn();
    render(
      <AppShell {...baseProps} showAddAnlage onAddAnlage={onAddAnlage}>
        <div>content</div>
      </AppShell>,
    );
    const btn = screen.getByRole('button', { name: 'Anlage hinzufügen' });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onAddAnlage).toHaveBeenCalledTimes(1);
  });

  it('is absent when showAddAnlage is false (fleets/admins already have one)', () => {
    render(
      <AppShell {...baseProps} showAddAnlage={false} onAddAnlage={vi.fn()}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.queryByRole('button', { name: 'Anlage hinzufügen' })).toBeNull();
  });
});

describe('AppShell admin tenant switcher', () => {
  const tenants = [
    { id: 't-1', name: 'Stadtwerke Musterstadt', segment: 'CI', plan: 'basic', betriebsart: null, betriebsartEffective: 'betreiber' as const, createdAt: '2026-01-01T00:00:00Z' },
    { id: 't-2', name: 'Familie Kaiser', segment: 'B2C', plan: 'basic', betriebsart: null, betriebsartEffective: 'endkunde' as const, createdAt: '2026-01-01T00:00:00Z' },
  ];

  it('renders the tenant switcher with an "Alle Mandanten" default for admins', () => {
    const onTenantChange = vi.fn();
    render(
      <AppShell
        {...baseProps}
        isAdmin
        showOverview
        showAddAnlage={false}
        onAddAnlage={vi.fn()}
        tenants={tenants}
        onTenantChange={onTenantChange}
      >
        <div>content</div>
      </AppShell>,
    );
    // Seit dem Picker-System ist der Umschalter der Haus-Picker, kein `select`.
    const trigger = screen.getByRole('combobox', { name: 'Mandanten-Umschalter' });
    expect(trigger).toHaveTextContent('Alle Mandanten');
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'Alle Mandanten' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Familie Kaiser' }));
    expect(onTenantChange).toHaveBeenCalledWith('t-2');
  });

  it('shows no tenant switcher for a customer', () => {
    render(
      <AppShell {...baseProps} isAdmin={false} showAddAnlage={false} onAddAnlage={vi.fn()} tenants={[]}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.queryByRole('combobox', { name: 'Mandanten-Umschalter' })).toBeNull();
  });
});

describe('AppShell Anlage nav (v3 M1: grouped sidebar + health badge + bottom bar)', () => {
  // Ein DV-Park OHNE Speicher: dort trägt der Markt-Modus den Fahrplan + die
  // Prognose selbst, es gibt also eine echte Modus-Gruppe zu rendern. Auf einer
  // SPEICHER-Anlage sind beide inzwischen Basis-Ansichten (Captain 2026-07-29),
  // dann entfällt die Gruppe - das prüft `anlageNav.test.ts`.
  const MARKT = anlageSurface({
    entities: [{ id: 'e1', entityType: 'producer', capabilities: { measure: [{ channel: 'pv_power_kw' }] } }],
    config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
  });

  const anlage = {
    siteId: 's-1',
    siteName: 'Hof Lindenberg',
    sites: [{ id: 's-1', name: 'Hof Lindenberg' }],
    onSelectSite: vi.fn(),
    sidebar: anlageSidebar(null, 3),
    activeKey: 'cockpit',
    onOpenSub: vi.fn(),
    onOpenPage: vi.fn(),
    onOpenFleet: null,
    health: { state: 'ok' as const, label: 'Alles in Ordnung', detail: null, findings: [] },
  };

  const renderShell = (over: Partial<typeof anlage> = {}) =>
    render(
      <AppShell
        {...baseProps}
        showAddAnlage={false}
        onAddAnlage={vi.fn()}
        anlage={{ ...anlage, ...over }}
      >
        <div>content</div>
      </AppShell>,
    );

  it('renders the base group with its four areas, labelled "Anlage"', () => {
    // Cockpit+Live merge (Option A): no "Live-Daten" nav item any more.
    const { container } = renderShell();
    expect(container.querySelector('.vp-anlagenav .vp-nav-group-label')?.textContent).toBe(
      'Anlage',
    );
    for (const label of ['Cockpit', 'Messwerte', 'Steuerung', 'Anlagen-Modell']) {
      expect(screen.getAllByRole('button', { name: new RegExp(label) }).length).toBeGreaterThanOrEqual(1);
    }
    expect(screen.queryByRole('button', { name: /Live-Daten/ })).toBeNull();
  });

  it('renders the 5-slot bottom bar for the Anlage', () => {
    renderShell();
    const bar = screen.getByLabelText('Bereiche der Anlage Hof Lindenberg');
    expect(bar.querySelectorAll('.vp-bottombar-item')).toHaveLength(5);
    expect(bar.textContent).toContain('Mehr');
  });

  it('has NO "Mehr ▾" popover trigger anywhere', () => {
    const { container } = renderShell();
    expect(container.querySelector('.vp-more-btn')).toBeNull();
  });

  it('carries the active-mode count as the Steuerung badge', () => {
    renderShell();
    // Sidebar count + bottom-bar badge both read the same number.
    expect(screen.getAllByText('3').length).toBe(2);
  });

  const WARN_HEALTH = {
    state: 'warnung' as const,
    label: 'Warnung',
    detail: 'Gerät: meldet sich nicht',
    findings: [
      { state: 'warn' as const, text: 'Gerät: meldet sich nicht' },
      { state: 'off' as const, text: 'Steuerung: noch nicht freigegeben' },
    ],
  };

  it('renders the health badge with its state and names the worst finding', () => {
    const { container } = renderShell({ health: WARN_HEALTH });
    const badge = container.querySelector('.vp-topbar .vp-healthbadge');
    expect(badge).not.toBeNull();
    expect(badge?.className).toContain('state-warnung');
    expect(badge?.getAttribute('title')).toBe('Gerät: meldet sich nicht');
    expect(badge?.textContent).toContain('Warnung');
  });

  it('shows the CAUSE as visible text, not only in a hover title', () => {
    const { container } = renderShell({ health: WARN_HEALTH });
    const cause = container.querySelector('.vp-topbar .vp-healthbadge-cause');
    // The cause must be real text in the DOM - a `title=` alone is invisible
    // on touch and undiscoverable everywhere else.
    expect(cause?.textContent).toBe('Gerät: meldet sich nicht');
  });

  it('is a real, keyboard-reachable control with a cause-carrying accessible name', () => {
    renderShell({ health: WARN_HEALTH });
    const badge = screen.getByRole('button', {
      name: /Zustand der Anlage: Warnung – Gerät: meldet sich nicht/,
    });
    expect(badge.tagName).toBe('BUTTON');
    expect(badge.getAttribute('aria-expanded')).toBe('false');
  });

  it('one click opens a popover listing EVERY finding, and drills into the Anlage', () => {
    const onOpenSub = vi.fn();
    renderShell({ health: WARN_HEALTH, onOpenSub });
    fireEvent.click(screen.getByRole('button', { name: /Zustand der Anlage/ }));
    const pop = screen.getByRole('dialog', { name: 'Zustand der Anlage' });
    expect(pop.textContent).toContain('Gerät: meldet sich nicht');
    expect(pop.textContent).toContain('Steuerung: noch nicht freigegeben');
    // The drill target: the plant's own Zustand card on its cockpit.
    fireEvent.click(screen.getByRole('button', { name: /Zur Anlage/ }));
    expect(onOpenSub).toHaveBeenCalledWith(null);
    expect(screen.queryByRole('dialog', { name: 'Zustand der Anlage' })).toBeNull();
  });

  it('a healthy plant opens an honest "nichts zu melden" popover', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /Zustand der Anlage/ }));
    expect(screen.getByRole('dialog', { name: 'Zustand der Anlage' }).textContent).toContain(
      'nichts zu melden',
    );
  });

  it('renders no health badge when the state is not known yet', () => {
    const { container } = renderShell({ health: null });
    expect(container.querySelector('.vp-healthbadge')).toBeNull();
  });

  it('„Alles in Ordnung" trägt den grünen Zustand - in Kopfzeile UND Anlagen-Karte', () => {
    const { container } = renderShell();
    const badge = container.querySelector('.vp-topbar .vp-healthbadge');
    expect(badge?.className).toContain('state-ok');
    expect(badge?.textContent).toContain('Alles in Ordnung');
    // Der Punkt hängt an genau dem Zustand, den das Stylesheet einfärbt.
    expect(badge?.querySelector('.vp-health-dot')).not.toBeNull();
    expect(container.querySelector('.vp-anlagenav-health.state-ok')).not.toBeNull();
    // Eine Warnung behält ihre eigene Farbe - der grüne Zustand darf sie nicht
    // vereinnahmen.
    const warn = renderShell({ health: WARN_HEALTH }).container.querySelector(
      '.vp-topbar .vp-healthbadge',
    );
    expect(warn?.className).toContain('state-warnung');
    expect(warn?.className).not.toContain('state-ok');
  });

  it('shows a static Anlage label with its health line for a single-Anlage customer', () => {
    const { container } = renderShell();
    expect(container.querySelector('.vp-anlagenav-label .t')?.textContent).toBe('Hof Lindenberg');
    expect(container.querySelector('.vp-anlagenav-health')?.textContent).toContain(
      'Alles in Ordnung',
    );
    expect(container.querySelector('.vp-topbar .here')?.textContent).toBe('Hof Lindenberg');
    expect(screen.queryByLabelText('Anlage wählen')).toBeNull();
  });

  it('turns the label into a real switcher with "Alle Anlagen" for a fleet', () => {
    const onSelectSite = vi.fn();
    const onOpenFleet = vi.fn();
    renderShell({
      sites: [
        { id: 's-1', name: 'Hof Lindenberg' },
        { id: 's-2', name: 'Halle Nord' },
      ],
      onSelectSite,
      onOpenFleet,
    });
    // Seit dem Picker-System ist der Wechsler ein VpPicker, kein `select`:
    // aufklappen, Zeile antippen. Der Wert ist derselbe.
    fireEvent.click(screen.getByRole('combobox', { name: 'Anlage wählen' }));
    fireEvent.click(screen.getByRole('option', { name: /Halle Nord/ }));
    expect(onSelectSite).toHaveBeenCalledWith('s-2');
    fireEvent.click(screen.getByRole('combobox', { name: 'Anlage wählen' }));
    fireEvent.click(screen.getByRole('option', { name: /Alle Anlagen/ }));
    expect(onOpenFleet).toHaveBeenCalledTimes(1);
  });

  it('opens an area on click', () => {
    const onOpenSub = vi.fn();
    renderShell({ onOpenSub });
    fireEvent.click(screen.getAllByRole('button', { name: /Steuerung/ })[0]);
    expect(onOpenSub).toHaveBeenCalledWith('steuerung');
  });

  it('renders the market mode group ONLY while that mode is active', () => {
    const { container } = renderShell();
    expect(container.querySelector('.vp-sidebar')?.textContent).not.toContain('Marktpreise');

    const onOpenPage = vi.fn();
    const second = renderShell({ sidebar: anlageSidebar(MARKT), onOpenPage });
    const sidebar = second.container.querySelector('.vp-sidebar') as HTMLElement;
    expect(sidebar.textContent).toContain('Anwendung · Marktvermarktung');
    expect(sidebar.textContent).toContain('Fahrplan');
    fireEvent.click(within(sidebar).getByRole('button', { name: /Marktpreise/ }));
    expect(onOpenPage).toHaveBeenCalledWith('marktpreise');
  });

  it('the Mehr slot opens a sheet with the remaining areas, colour-tagged', () => {
    renderShell({ sidebar: anlageSidebar(MARKT) });
    const bar = screen.getByLabelText('Bereiche der Anlage Hof Lindenberg');
    fireEvent.click(bar.querySelectorAll('.vp-bottombar-item')[4]);
    const sheet = screen.getByRole('dialog', { name: 'Weitere Bereiche' });
    // Der DV-Park trägt Fahrplan/Marktpreise/Prognose im Modus; der Fahrplan
    // zieht in die Leiste, der Rest bleibt farbig getaggt im Blatt.
    expect(sheet.textContent).toContain('Anwendung · Marktvermarktung');
    expect(sheet.textContent).toContain('Wetter');
    expect(sheet.textContent).toContain('Einstellungen');
    expect(sheet.textContent).toContain('Hilfe & Kontakt');
    expect(sheet.querySelector('.tone-markt')).not.toBeNull();
  });

  /**
   * Mobil-Umbau Stufe 1: die Leiste trägt die täglichen Fragen, der Hamburger
   * ist weg, und die Kopfzeile wird zur Anlagen-Identität.
   */
  it('belegt die Leiste mit den täglichen Fragen (und rückt ohne sie nach)', () => {
    // Speicher + Geld-Modus: die neue Belegung.
    renderShell({ sidebar: anlageSidebar(MARKT) });
    expect(
      [...screen.getByLabelText(/Bereiche der Anlage/).querySelectorAll('.lbl')].map(
        (n) => n.textContent,
      ),
    ).toEqual(['Cockpit', 'Fahrplan', 'Messwerte', 'Erlöse', 'Mehr']);

    // Weder Speicher noch Geld-Modus: Steuerung und Anlage rücken nach.
    cleanup();
    renderShell();
    expect(
      [...screen.getByLabelText(/Bereiche der Anlage/).querySelectorAll('.lbl')].map(
        (n) => n.textContent,
      ),
    ).toEqual(['Cockpit', 'Messwerte', 'Steuerung', 'Anlage', 'Mehr']);
  });

  it('zeigt das Steuerungs-Abzeichen auf „Mehr", wenn die Steuerung ins Blatt fällt', () => {
    renderShell({ sidebar: anlageSidebar(MARKT, 2) });
    const bar = screen.getByLabelText(/Bereiche der Anlage/);
    const mehr = [...bar.querySelectorAll('.vp-bottombar-item')].at(-1) as HTMLElement;
    expect(mehr.textContent).toContain('Mehr');
    expect(mehr.querySelector('.vp-bottombar-badge')?.textContent).toBe('2');
  });

  it('hat KEINEN Hamburger mehr - Leiste und Blatt tragen alles', () => {
    const { container } = renderShell();
    expect(container.querySelector('.vp-hamburger')).toBeNull();
    expect(container.querySelector('.vp-sidebar-close')).toBeNull();
    expect(container.querySelector('.vp-sidebar.mobile-open')).toBeNull();
  });

  it('macht den Anlagen-Namen in der Kopfzeile antippbar - und nur, wenn es etwas zu wechseln gibt', () => {
    const onSelectSite = vi.fn();
    const { container } = renderShell({
      sites: [
        { id: 's-1', name: 'Hof Lindenberg' },
        { id: 's-2', name: 'Halle Nord' },
      ],
      onSelectSite,
    });
    const block = container.querySelector('.vp-topbar-anlage') as HTMLElement;
    // Name + Zustands-Unterzeile leben in EINEM Block (am Telefon gestapelt).
    expect(block.querySelector('.here')?.textContent).toBe('Hof Lindenberg');
    expect(block.querySelector('.vp-healthbadge')).not.toBeNull();
    // Der Wechsler ist seit dem Picker-System eine unsichtbare Fläche über dem
    // ganzen Block, die das Sheet öffnet - kein natives Auswahlfeld mehr.
    fireEvent.click(within(block).getByRole('combobox', { name: 'Anlage wechseln' }));
    fireEvent.click(screen.getByRole('option', { name: /Halle Nord/ }));
    expect(onSelectSite).toHaveBeenCalledWith('s-2');

    // Ein Kunde mit genau EINER Anlage bekommt keinen Wechsler vorgegaukelt.
    cleanup();
    const single = renderShell();
    expect(
      single.container.querySelector('.vp-topbar-anlage .vp-tb-switch'),
    ).toBeNull();
  });

  it('⚠ versteckt den Telefon-Wechsler mit einem Spezifitäts-SCHRITT', () => {
    // Im Browser gemessen: `.vp-picker` setzt `display: flex` aus einem
    // komponenten-lokalen Stylesheet - bei gleicher Spezifität entschiede die
    // Bündel-Reihenfolge, und der Wechsler stand bei 1440 px in der Kopfzeile.
    const css = readFileSync(join(process.cwd(), 'src/shell/Shell.css'), 'utf8');
    expect(css).toContain('.vp-app .vp-tb-switchwrap,');
    expect(css).toMatch(/\.vp-app \.vp-tb-switchwrap \{\s*display: block;/);
  });

  it('faltet „＋ Anlage" und „Abmelden" ins Blatt (sie verlassen die Kopfzeile am Telefon)', () => {
    render(
      <AppShell
        {...baseProps}
        showAddAnlage
        onAddAnlage={vi.fn()}
        anlage={anlage}
      >
        <div>content</div>
      </AppShell>,
    );
    fireEvent.click(
      [...screen.getByLabelText(/Bereiche der Anlage/).querySelectorAll('.vp-bottombar-item')].at(
        -1,
      ) as HTMLElement,
    );
    const sheet = screen.getByRole('dialog', { name: 'Weitere Bereiche' });
    expect(sheet.textContent).toContain('Anlage hinzufügen');
    expect(sheet.textContent).toContain('Abmelden');
  });

  it('führt die Plattform-Gruppe im Blatt mit, weil ein Admin am Telefon sonst nirgends hinkommt', () => {
    render(
      <AppShell {...baseProps} isAdmin showAddAnlage={false} onAddAnlage={vi.fn()} anlage={anlage}>
        <div>content</div>
      </AppShell>,
    );
    fireEvent.click(
      [...screen.getByLabelText(/Bereiche der Anlage/).querySelectorAll('.vp-bottombar-item')].at(
        -1,
      ) as HTMLElement,
    );
    const sheet = screen.getByRole('dialog', { name: 'Weitere Bereiche' });
    expect(sheet.textContent).toContain('Plattform');
    // Seit Stufe 3 ist „Edge-Updates" ein TAB von „Geräte" - im Blatt steht
    // der Bereich, nicht sein Tab (der wäre ein zweiter Weg zum selben Ort).
    expect(sheet.textContent).toContain('Geräte');
    expect(sheet.textContent).not.toContain('Edge-Updates');
  });

  it('the foot Hilfe entry opens an honest help panel, never a dead link', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /Hilfe & Kontakt/ }));
    const panel = screen.getByRole('dialog', { name: 'Hilfe & Kontakt' });
    expect(panel.textContent).toContain('VoltPilot');
  });

  it('renders no Anlage nav without an Anlage in scope', () => {
    const { container } = render(
      <AppShell {...baseProps} showAddAnlage={false} onAddAnlage={vi.fn()} anlage={null}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.queryByLabelText(/Bereiche der Anlage/)).toBeNull();
    expect(container.querySelector('.vp-anlagenav')).toBeNull();
    expect(container.querySelector('.vp-topbar-anlage')).toBeNull();
    expect(screen.queryByRole('button', { name: /Anlagen-Modell/ })).toBeNull();
  });
});

/**
 * Mobil-Umbau Stufe 1, Flotten-Ebene: dieselbe Bar-Mechanik eine Ebene höher -
 * das Daumen-Muster überlebt den Ebenen-Wechsel, statt am Hamburger zu enden.
 */
describe('AppShell: die Leiste der Flotten-Ebene', () => {
  const renderFleet = (over: Partial<React.ComponentProps<typeof AppShell>> = {}) =>
    render(
      <AppShell
        {...baseProps}
        page="uebersicht"
        showOverview
        counts={{ sites: 3, devices: 4 }}
        showAddAnlage={false}
        onAddAnlage={vi.fn()}
        anlage={null}
        {...over}
      >
        <div>content</div>
      </AppShell>,
    );

  it('ist Übersicht · Anlagen · Mehr und hebt die offene Seite hervor', () => {
    renderFleet();
    const bar = screen.getByLabelText('Hauptbereiche');
    expect([...bar.querySelectorAll('.lbl')].map((n) => n.textContent)).toEqual([
      'Übersicht',
      'Anlagen',
      'Mehr',
    ]);
    expect(bar.querySelector('.vp-bottombar-item.active')?.textContent).toContain('Übersicht');
    // Die Spaltenzahl folgt der Belegung, statt fünf zu behaupten.
    expect(bar.getAttribute('style')).toContain('--vp-bar-slots: 3');
  });

  it('navigiert per Leiste und trägt Hilfe/Abmelden im Blatt', () => {
    const onNavigate = vi.fn();
    renderFleet({ onNavigate });
    const bar = screen.getByLabelText('Hauptbereiche');
    fireEvent.click(bar.querySelectorAll('.vp-bottombar-item')[1]);
    expect(onNavigate).toHaveBeenCalledWith('anlagen');

    fireEvent.click([...bar.querySelectorAll('.vp-bottombar-item')].at(-1) as HTMLElement);
    const sheet = screen.getByRole('dialog', { name: 'Weitere Bereiche' });
    expect(sheet.textContent).toContain('Hilfe & Kontakt');
    expect(sheet.textContent).toContain('Abmelden');
  });

  it('führt beim Betreiber mit dem Portfolio und legt die Plattform ins Blatt', () => {
    renderFleet({
      isAdmin: true,
      page: 'portfolio',
      showOverview: false,
      showPortfolio: true,
      showPortfolioErloese: true,
    });
    const bar = screen.getByLabelText('Hauptbereiche');
    expect([...bar.querySelectorAll('.lbl')].map((n) => n.textContent)).toEqual([
      'Portfolio',
      'Anlagen',
      'Messwerte',
      'Erlöse',
      'Mehr',
    ]);
    fireEvent.click([...bar.querySelectorAll('.vp-bottombar-item')].at(-1) as HTMLElement);
    expect(screen.getByRole('dialog', { name: 'Weitere Bereiche' }).textContent).toContain(
      'Mandanten',
    );
  });
});

/**
 * Admin-Umbau Stufe 1 „Ordnung": die Plattform-Gruppe ist nicht mehr eine
 * flache Liste aus elf Punkten, sondern die Landung plus vier benannte
 * Gruppen. Geprüft wird die ORDNUNG in der Schale - die Mengen-Invarianten
 * liegen in `nav.test.ts`.
 */
describe('AppShell Plattform-Gruppen (Admin-Umbau Stufe 1)', () => {
  const adminProps = {
    ...baseProps,
    isAdmin: true,
    showOverview: true,
    showAddAnlage: false,
    onAddAnlage: vi.fn(),
  };

  function sidebarLabels() {
    const nav = screen.getByLabelText('Hauptnavigation');
    return [...nav.querySelectorAll('.vp-nav-group-label .vp-nav-lbl')].map((n) => n.textContent);
  }

  it('rendert „Plattform" plus die vier Gruppen-Überschriften in Arbeits-Reihenfolge', () => {
    render(
      <AppShell {...adminProps}>
        <div>content</div>
      </AppShell>,
    );
    expect(sidebarLabels()).toEqual([
      'Plattform',
      'Flotte',
      'Anlagen-Werkzeuge',
      'Katalog',
      'Kunden',
    ]);
  });

  it('stellt die Landung OHNE eigene Überschrift an die Spitze', () => {
    render(
      <AppShell {...adminProps}>
        <div>content</div>
      </AppShell>,
    );
    const nav = screen.getByLabelText('Hauptnavigation');
    const gruppen = [...nav.querySelectorAll('.vp-navgroup')];
    // Die erste Gruppe ist die Landung: ein Eintrag, keine Zwischenüberschrift.
    expect(gruppen[0].querySelector('.vp-nav-sublabel')).toBeNull();
    expect(gruppen[0].textContent).toContain('Plattform-Übersicht');
    // Und die Gruppen darunter tragen ihre Überschrift.
    expect(gruppen[1].querySelector('.vp-nav-sublabel')?.textContent).toBe('Flotte');
  });

  it('behält jeden Punkt bedienbar und den Mandanten-Zähler', () => {
    const onNavigate = vi.fn();
    render(
      <AppShell
        {...adminProps}
        onNavigate={onNavigate}
        tenants={[
          { id: 't-1', name: 'A', segment: 'CI', plan: 'basic', betriebsart: null, betriebsartEffective: 'endkunde' as const, createdAt: '2026-01-01T00:00:00Z' },
        ]}
      >
        <div>content</div>
      </AppShell>,
    );
    for (const label of ['Geräte', 'Steuerungs-Freigabe',
      'Optimizer', 'Flows', 'Gerätevorlagen', 'Komponenten', 'Mandanten']) {
      expect(screen.getByTitle(label)).toBeInTheDocument();
    }
    // Die drei gefalteten Punkte sind aus der LEISTE verschwunden - ihre
    // Flächen leben als Tab (Updates), als Sektion (Gerätetypen) bzw. im
    // Mandanten-Drawer (Benutzer) weiter.
    expect(screen.queryByTitle('Edge-Updates')).toBeNull();
    expect(screen.queryByTitle('Gerätetypen')).toBeNull();
    expect(screen.queryByTitle('Benutzer')).toBeNull();
    fireEvent.click(screen.getByTitle('Geräte'));
    expect(onNavigate).toHaveBeenCalledWith('geraete-registry');
    expect(screen.getByTitle('Mandanten').textContent).toContain('1');
  });

  it('lässt „Geräte" auch auf dem Tab Updates leuchten', () => {
    render(
      <AppShell {...adminProps} page="edge-updates">
        <div>content</div>
      </AppShell>,
    );
    // Ein Tab darf die Leiste nie ins Nichts zeigen lassen: der Bereich ist
    // aktiv, sonst wüsste der Betreiber nicht, wo er steht.
    expect(screen.getByTitle('Geräte').className).toContain('active');
  });

  it('zeigt einem Kunden keine einzige Plattform-Gruppe', () => {
    render(
      <AppShell {...baseProps} showAddAnlage={false} onAddAnlage={vi.fn()}>
        <div>content</div>
      </AppShell>,
    );
    expect(sidebarLabels()).not.toContain('Plattform');
    expect(screen.queryByTitle('Geräte')).toBeNull();
  });
});
