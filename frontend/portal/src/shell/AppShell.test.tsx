import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AppShell } from './AppShell';
import { anlageSidebar, ebenenLeiste } from '../ebenenNav';
import { pageRoute, standortBereichRoute } from '../nav';
import { anlageSurface } from '../surface';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { ahrenbergKennzahlen } from '../test/kennzahlenFixtures';
import { werkAhrenberg, werkLindach } from '../test/standorteFixtures';

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
  // dann entfällt die Gruppe - das prüft `ebenenNav.test.ts`.
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

  it('rendert die BEREICHE der Anlage - ohne Gruppen-Überschrift', () => {
    // E3: die Seitenleiste trägt die Bereiche, nicht mehr eine Gruppe „Anlage"
    // über Einträgen, von denen einer ebenfalls „Anlage" heißt.
    const { container } = renderShell();
    expect(container.querySelector('.vp-anlagenav .vp-nav-group-label')).toBeNull();
    // Ohne Speicher/Ladepunkte gibt es den zweiten Bereich nicht (Gesetz 1:
    // ein Bereich ohne Inhalt existiert nicht).
    expect(
      [...container.querySelectorAll('.vp-anlagenav .vp-nav-lbl')].map((n) => n.textContent),
    ).toEqual(['Cockpit', 'Verlauf', 'Steuerung', 'Anlage']);
    // Und die früheren Einzel-Einträge sind Reiter geworden, keine Nav-Zeilen.
    expect(container.querySelector('.vp-anlagenav')?.textContent).not.toContain('Messwerte');
    expect(screen.queryByRole('button', { name: /Live-Daten/ })).toBeNull();
  });

  it('trägt die Anwendungs-Ansichten als REITER, nicht als Nav-Gruppe', () => {
    // Ein DV-Park: Fahrplan/Marktpreise/Prognose kommen aus dem Modus. Sie
    // stehen im Bereich, nicht in einer farbigen Gruppe daneben.
    const { container } = renderShell({ sidebar: anlageSidebar(MARKT) });
    const nav = container.querySelector('.vp-anlagenav') as HTMLElement;
    expect(nav.textContent).not.toContain('Anwendung · ');
    expect([...nav.querySelectorAll('.vp-nav-lbl')].map((n) => n.textContent)).toEqual([
      'Cockpit',
      'Fahrplan',
      'Verlauf',
      'Steuerung',
      'Anlage',
    ]);
  });

  it('hat KEINEN „Mehr ▾"-Auslöser und kein Blatt mehr', () => {
    const { container } = renderShell();
    expect(container.querySelector('.vp-more-btn')).toBeNull();
    expect(container.querySelector('.vp-sheet')).toBeNull();
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

  it('„Alles in Ordnung" trägt den grünen Zustand - GENAU EINMAL, in der Kopfzeile', () => {
    const { container } = renderShell();
    const badge = container.querySelector('.vp-topbar .vp-healthbadge');
    expect(badge?.className).toContain('state-ok');
    expect(badge?.textContent).toContain('Alles in Ordnung');
    // Der Punkt hängt an genau dem Zustand, den das Stylesheet einfärbt.
    expect(badge?.querySelector('.vp-health-dot')).not.toBeNull();
    // E3: die Anlagen-Karte der Seitenleiste ist entfallen - der Zustand steht
    // nur noch im Pfad, sonst wären es zwei Orte für dieselbe Aussage.
    expect(container.querySelectorAll('.vp-healthbadge')).toHaveLength(1);
    expect(container.querySelector('.vp-anlagenav-health')).toBeNull();
    // Eine Warnung behält ihre eigene Farbe - der grüne Zustand darf sie nicht
    // vereinnahmen.
    const warn = renderShell({ health: WARN_HEALTH }).container.querySelector(
      '.vp-topbar .vp-healthbadge',
    );
    expect(warn?.className).toContain('state-warnung');
    expect(warn?.className).not.toContain('state-ok');
  });

  it('zeigt einem Einzel-Anlagen-Kunden Namen + Zustand, aber keinen Umschalter', () => {
    const { container } = renderShell();
    // E3: keine Picker-Karte in der Seitenleiste mehr.
    expect(container.querySelector('.vp-anlagenav-label')).toBeNull();
    expect(container.querySelector('.vp-topbar .here')?.textContent).toBe('Hof Lindenberg');
    expect(container.querySelector('.vp-topbar .vp-healthbadge')?.textContent).toContain(
      'Alles in Ordnung',
    );
    // Eine Anlage, keine Flotte: es gibt nichts zu wechseln, also auch keinen
    // Wechsler - ein Knopf, der nichts bewirken kann, wird nicht angeboten.
    expect(screen.queryByRole('combobox', { name: 'Anlage wechseln' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Anlage wählen' })).toBeNull();
  });

  it('der Umschalter wohnt im PFAD - und die erste Zeile führt zurück auf die Flotte', () => {
    const onSelectSite = vi.fn();
    const onOpenFleet = vi.fn();
    const { container } = renderShell({
      sites: [
        { id: 's-1', name: 'Hof Lindenberg' },
        { id: 's-2', name: 'Halle Nord' },
      ],
      onSelectSite,
      onOpenFleet,
    });
    // E3: die Picker-KARTE der Seitenleiste ist entfallen, es gibt genau EINEN
    // Umschalter - den im Pfad der Kopfzeile.
    expect(screen.queryByRole('combobox', { name: 'Anlage wählen' })).toBeNull();
    const pfad = container.querySelector('.vp-topbar-anlage') as HTMLElement;
    fireEvent.click(within(pfad).getByRole('combobox', { name: 'Anlage wechseln' }));
    fireEvent.click(screen.getByRole('option', { name: /Halle Nord/ }));
    expect(onSelectSite).toHaveBeenCalledWith('s-2');
  });

  it('der PFAD nennt die Flotten-Ebene und führt zurück', () => {
    const onOpenFleet = vi.fn();
    const { container } = renderShell({ onOpenFleet, sites: [{ id: 's-1', name: 'Hof Lindenberg' }] });
    const up = container.querySelector('.vp-crumb-up') as HTMLElement;
    // Ohne eigene Angabe trägt er den Vorgabe-Namen der Flotten-Ebene.
    expect(up.textContent).toBe('Portfolio');
    fireEvent.click(up);
    expect(onOpenFleet).toHaveBeenCalledTimes(1);
  });

  it('nennt die Flotten-Ebene beim WORT des Kunden (fleetLabel)', () => {
    const { container } = render(
      <AppShell
        {...baseProps}
        showAddAnlage={false}
        onAddAnlage={vi.fn()}
        fleetLabel="Meine Anlagen"
        anlage={{ ...anlage, onOpenFleet: vi.fn() }}
      >
        <div>content</div>
      </AppShell>,
    );
    expect(container.querySelector('.vp-crumb-up')?.textContent).toBe('Meine Anlagen');
  });

  it('zeigt ohne Flotten-Ebene NUR den Anlagen-Namen', () => {
    const { container } = renderShell();
    expect(container.querySelector('.vp-crumb-up')).toBeNull();
    expect(container.querySelector('.vp-topbar .here')?.textContent).toBe('Hof Lindenberg');
  });

  it('opens an area on click', () => {
    const onOpenSub = vi.fn();
    renderShell({ onOpenSub });
    fireEvent.click(screen.getAllByRole('button', { name: /Steuerung/ })[0]);
    expect(onOpenSub).toHaveBeenCalledWith('steuerung');
  });

  /**
   * E4 · die Telefon-Leiste: die FÜNF Bereiche, kein „Mehr", kein Blatt. Sie
   * heißt am Telefon wie in der Seitenleiste - derselbe Ort, dasselbe Wort.
   */
  it('belegt die Leiste mit den BEREICHEN der Anlage - ohne „Mehr"', () => {
    renderShell({ sidebar: anlageSidebar(MARKT) });
    const bar = screen.getByLabelText('Bereiche der Anlage Hof Lindenberg');
    expect([...bar.querySelectorAll('.lbl')].map((n) => n.textContent)).toEqual([
      'Cockpit',
      'Fahrplan',
      'Verlauf',
      'Steuerung',
      'Anlage',
    ]);
    expect(bar.textContent).not.toContain('Mehr');
    expect(bar.getAttribute('style')).toContain('--vp-bar-slots: 5');
    expect(screen.queryByRole('dialog', { name: 'Weitere Bereiche' })).toBeNull();
  });

  it('rückt nach, wo ein Bereich fehlt - nie ein leerer Platz', () => {
    renderShell();
    const bar = screen.getByLabelText(/Bereiche der Anlage/);
    expect([...bar.querySelectorAll('.lbl')].map((n) => n.textContent)).toEqual([
      'Cockpit',
      'Verlauf',
      'Steuerung',
      'Anlage',
    ]);
    expect(bar.getAttribute('style')).toContain('--vp-bar-slots: 4');
  });

  it('die Leiste NAVIGIERT in ihren Bereich', () => {
    const onOpenSub = vi.fn();
    renderShell({ sidebar: anlageSidebar(MARKT), onOpenSub });
    const bar = screen.getByLabelText(/Bereiche der Anlage/);
    fireEvent.click(bar.querySelectorAll('.vp-bottombar-item')[1]);
    expect(onOpenSub).toHaveBeenCalledWith('fahrplan');
  });

  it('das Steuerungs-Abzeichen BLEIBT an der Steuerung - in Leiste und Seitenleiste', () => {
    const { container } = renderShell({ sidebar: anlageSidebar(MARKT, 2) });
    const bar = screen.getByLabelText(/Bereiche der Anlage/);
    const steuerung = [...bar.querySelectorAll('.vp-bottombar-item')].find((n) =>
      n.textContent?.includes('Steuerung'),
    ) as HTMLElement;
    expect(steuerung.querySelector('.vp-bottombar-badge')?.textContent).toBe('2');
    // Und derselbe Zähler steht in der Seitenleiste - eine Zahl, zwei Orte.
    expect(container.querySelector('.vp-anlagenav')?.textContent).toContain('2');
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

  /**
   * E4 · das Avatar-Menü ist der Wohnort von Hilfe · Abmelden — und am Telefon
   * zusätzlich der Plattform-Gruppe: die Seitenleiste rendert dort nicht, das
   * „Mehr"-Blatt gibt es nicht mehr, und einen Hamburger gab es schon vorher
   * nicht. Ohne dieses Menü käme ein Admin am Telefon nirgends hin.
   */
  it('trägt Hilfe und Abmelden im Avatar-Menü', () => {
    renderShell();
    // Zu ist zu: kein Menü im DOM, bevor jemand es öffnet.
    expect(screen.queryByRole('menu', { name: 'Konto-Menü' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Konto-Menü/ }));
    const menu = screen.getByRole('menu', { name: 'Konto-Menü' });
    expect(menu.textContent).toContain('Hilfe & Kontakt');
    expect(menu.textContent).toContain('Abmelden');
  });

  it('führt die Plattform-Punkte im Avatar-Menü mit (der Telefon-Weg des Admins)', () => {
    render(
      <AppShell
        {...baseProps}
        isAdmin
        showAddAnlage={false}
        onAddAnlage={vi.fn()}
        anlage={anlage}
      >
        <div>content</div>
      </AppShell>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Konto-Menü/ }));
    const menu = screen.getByRole('menu', { name: 'Konto-Menü' });
    expect(menu.textContent).toContain('Plattform');
    // Seit Stufe 3 ist „Edge-Updates" ein TAB von „Geräte" - im Menü steht der
    // Bereich, nicht sein Tab (der wäre ein zweiter Weg zum selben Ort).
    expect(menu.textContent).toContain('Geräte');
    expect(menu.textContent).not.toContain('Edge-Updates');
    // Und ein Kunde bekommt die Gruppe gar nicht erst.
    cleanup();
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /Konto-Menü/ }));
    expect(screen.getByRole('menu', { name: 'Konto-Menü' }).textContent).not.toContain('Plattform');
  });

  it('das Avatar-Menü schließt mit Escape', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /Konto-Menü/ }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Konto-Menü' })).toBeNull();
  });

  it('the foot Hilfe entry navigates to the global handbook', () => {
    renderShell();
    // Der Fuß der Seitenleiste trägt ihn weiterhin (am Rechner), das
    // Avatar-Menü am Telefon - beide öffnen dieselbe Fläche.
    fireEvent.click(screen.getAllByRole('button', { name: /Hilfe & Kontakt/ })[0]);
    expect(baseProps.onNavigate).toHaveBeenCalledWith('hilfe');
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
 * E4 · die Flotten-Ebene hat KEINE Leiste: dort navigieren die Reiter der
 * Portfolio-Seite, eine zweite Leiste daneben wäre ein zweites Menü für
 * dieselbe Ebene.
 */
describe('AppShell: die Flotten-Ebene navigiert ohne Leiste', () => {
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

  it('rendert weder Leiste noch Blatt', () => {
    const { container } = renderFleet();
    expect(container.querySelector('.vp-bottombar')).toBeNull();
    expect(screen.queryByLabelText('Hauptbereiche')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Weitere Bereiche' })).toBeNull();
  });

  it('führt beim Betreiber mit dem Portfolio - unter SEINEM Namen', () => {
    const onNavigate = vi.fn();
    renderFleet({
      page: 'portfolio',
      showOverview: false,
      showPortfolio: true,
      fleetLabel: 'Portfolio',
      onNavigate,
    });
    const nav = screen.getByLabelText('Hauptnavigation');
    const eintraege = [...nav.querySelectorAll('.vp-nav-lbl')].map((n) => n.textContent);
    expect(eintraege[0]).toBe('Portfolio');
    // Die frühere Listen-Seite „Meine Anlagen" ist ersatzlos aufgegangen.
    expect(eintraege).not.toContain('Meine Anlage');
    expect(eintraege).not.toContain('Meine Anlagen');
    fireEvent.click(screen.getByTitle('Portfolio'));
    expect(onNavigate).toHaveBeenCalledWith('portfolio');
  });

  it('nennt dieselbe Ebene beim Endkunden „Meine Anlagen"', () => {
    renderFleet({
      page: 'portfolio',
      showOverview: false,
      showPortfolio: true,
      fleetLabel: 'Meine Anlagen',
    });
    expect(screen.getByTitle('Meine Anlagen')).toBeInTheDocument();
    expect(screen.queryByTitle('Portfolio')).toBeNull();
  });

  it('trägt Hilfe und Abmelden auch hier im Avatar-Menü', () => {
    renderFleet();
    fireEvent.click(screen.getByRole('button', { name: /Konto-Menü/ }));
    const menu = screen.getByRole('menu', { name: 'Konto-Menü' });
    expect(menu.textContent).toContain('Hilfe & Kontakt');
    expect(menu.textContent).toContain('Abmelden');
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

  /**
   * S8: die Gruppe ist ZUSAMMENKLAPPBAR und startet EINGEKLAPPT, solange ein
   * Mandant gewählt ist - dort arbeitet der Admin in der Kundensicht, und elf
   * Plattform-Punkte darüber sind dann Rauschen. Ohne Mandant ist sie offen.
   */
  function oeffnePlattform() {
    // Exakt „Plattform" - `/Plattform/` träfe auch „Plattform-Übersicht".
    const knopf = screen.getByRole('button', { name: 'Plattform' });
    if (knopf.getAttribute('aria-expanded') === 'false') fireEvent.click(knopf);
  }

  it('rendert „Plattform" plus die vier Gruppen-Überschriften in Arbeits-Reihenfolge', () => {
    render(
      <AppShell {...adminProps}>
        <div>content</div>
      </AppShell>,
    );
    oeffnePlattform();
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
    oeffnePlattform();
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
    oeffnePlattform();
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
    expect(onNavigate).toHaveBeenCalledWith('edge-updates');
    expect(screen.getByTitle('Mandanten').textContent).toContain('1');
  });

  it('lässt „Geräte" auch auf dem Tab Updates leuchten', () => {
    render(
      <AppShell {...adminProps} page="edge-updates">
        <div>content</div>
      </AppShell>,
    );
    oeffnePlattform();
    // Ein Tab darf die Leiste nie ins Nichts zeigen lassen: der Bereich ist
    // aktiv, sonst wüsste der Betreiber nicht, wo er steht.
    expect(screen.getByTitle('Geräte').className).toContain('active');
  });

  it('S8: die Gruppe startet EINGEKLAPPT, solange ein Mandant gewählt ist', () => {
    render(
      <AppShell {...adminProps} tenantOverride="t-1">
        <div>content</div>
      </AppShell>,
    );
    const knopf = screen.getByRole('button', { name: 'Plattform' });
    expect(knopf.getAttribute('aria-expanded')).toBe('false');
    // Eingeklappt heißt EINGEKLAPPT: die Punkte stehen nicht im DOM.
    expect(screen.queryByTitle('Mandanten')).toBeNull();
    // Ein Klick öffnet sie - der Weg ist da, er drängt sich nur nicht auf.
    fireEvent.click(knopf);
    expect(screen.getByTitle('Mandanten')).toBeInTheDocument();

    // Und ohne gewählten Mandanten steht sie von sich aus offen.
    cleanup();
    render(
      <AppShell {...adminProps} tenantOverride={null}>
        <div>content</div>
      </AppShell>,
    );
    expect(
      screen.getByRole('button', { name: 'Plattform' }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('S8: die Wahl eines Mandanten klappt sie zu, das Zurücksetzen wieder auf', () => {
    const { rerender } = render(
      <AppShell {...adminProps} tenantOverride={null}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.getByTitle('Mandanten')).toBeInTheDocument();
    rerender(
      <AppShell {...adminProps} tenantOverride="t-1">
        <div>content</div>
      </AppShell>,
    );
    expect(screen.queryByTitle('Mandanten')).toBeNull();
    rerender(
      <AppShell {...adminProps} tenantOverride={null}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.getByTitle('Mandanten')).toBeInTheDocument();
  });

  it('zeigt einem Kunden keine einzige Plattform-Gruppe', () => {
    render(
      <AppShell {...baseProps} showAddAnlage={false} onAddAnlage={vi.fn()}>
        <div>content</div>
      </AppShell>,
    );
    expect(sidebarLabels()).not.toContain('Plattform');
    expect(screen.queryByRole('button', { name: 'Plattform' })).toBeNull();
    expect(screen.queryByTitle('Geräte')).toBeNull();
  });
});

describe('AppShell: die Telefon-Leiste je Ebene (UEMS AP-01 IP-7, E4 = A)', () => {
  const titel = 'Bereiche des Unternehmens Kunststoffwerk Ahrenberg GmbH';
  // Das Bild mit eingehängten Seiten (AP-04 IP-5, AP-13) — heute gäbe es für Ahrenberg keine Leiste.
  const kacheln = ebenenLeiste(
    { art: 'unternehmen' },
    { standorte: [werkAhrenberg(), werkLindach()], funktionen: ahrenbergFunktionen(), kennzahlen: ahrenbergKennzahlen() },
    () => ({
      uebersicht: pageRoute('portfolio'),
      standorte: pageRoute('portfolio-standorte'),
      messstellen: pageRoute('portfolio'),
      bezugsgroessen: pageRoute('portfolio-bezugsgroessen'),
      kennzahlen: pageRoute('portfolio'),
      berichte: pageRoute('portfolio'),
    }),
  );
  const ebenen: NonNullable<React.ComponentProps<typeof AppShell>['ebenen']> =
    { titel, kacheln, aktiv: 'uebersicht', onOpen: vi.fn() };

  const renderEbene = (over: Partial<typeof ebenen> | null = {}, anlage: React.ComponentProps<typeof AppShell>['anlage'] = null) =>
    render(
      <AppShell
        {...baseProps}
        page="portfolio"
        showPortfolio
        showAddAnlage={false}
        onAddAnlage={vi.fn()}
        anlage={anlage}
        ebenen={over == null ? null : { ...ebenen, ...over }}
      >
        <div>content</div>
      </AppShell>,
    );

  it('trägt die Kacheln der Ebene; `--vp-bar-slots` folgt ihrer Zahl, die offene ist markiert', () => {
    renderEbene();
    const bar = screen.getByLabelText(titel);
    expect([...bar.querySelectorAll('.lbl')].map((n) => n.textContent)).toEqual([
      'Übersicht',
      'Standorte',
      'Messstellen',
      'Bezugsgrößen',
      'Kennzahlen',
      'Berichte',
    ]);
    expect(bar.getAttribute('style')).toContain('--vp-bar-slots: 6');
    expect(bar.querySelector('[aria-current="page"]')?.textContent).toBe('Übersicht');
    expect(bar.textContent).not.toMatch(/Steuer/);
  });

  it.each(['uebersicht', 'netzanschluesse'] as const)(
    'die Netzanschlüsse-Kachel lässt bestehende Buttons bytegleich, aktiv: %s', (aktiv) => {
      const vorher = renderEbene({ aktiv });
      const bestehendeButtons = within(screen.getByLabelText(titel)).getAllByRole('button')
        .map(button => ({ name: button.textContent!, html: button.outerHTML }));
      vorher.unmount();

      const ziel = standortBereichRoute(werkAhrenberg().id, 'netzanschluesse');
      const onOpen = vi.fn();
      renderEbene({ aktiv, onOpen, kacheln: [...kacheln, { key: 'netzanschluesse', label: 'Netzanschlüsse', icon: 'zap', ziel }] });
      const bar = screen.getByLabelText(titel);
      for (const { name, html } of bestehendeButtons) {
        expect(within(bar).getByRole('button', { name }).outerHTML).toBe(html);
      }
      const netzanschluesse = within(bar).getByRole('button', { name: 'Netzanschlüsse' });
      expect(bar.querySelectorAll('.vp-bottombar-netzanschluesse')).toHaveLength(1);
      expect(netzanschluesse.className).toBe(`vp-bottombar-item vp-bottombar-netzanschluesse${aktiv === 'netzanschluesse' ? ' active' : ''}`);
      expect(netzanschluesse.getAttribute('aria-current')).toBe(aktiv === 'netzanschluesse' ? 'page' : null);
      fireEvent.click(netzanschluesse);
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(onOpen).toHaveBeenCalledWith(ziel);
    },
  );

  it('eine Kachel navigiert auf ihre Seite', () => {
    const onOpen = vi.fn();
    renderEbene({ onOpen });
    fireEvent.click(within(screen.getByLabelText(titel)).getByRole('button', { name: 'Standorte' }));
    expect(onOpen).toHaveBeenCalledWith(pageRoute('portfolio-standorte'));
  });

  it('ohne Kacheln — unter drei Bereichen mit Seite — gibt es keine Leiste, wie heute', () => {
    const { container, unmount } = renderEbene({ kacheln: [] });
    expect(container.querySelector('.vp-bottombar')).toBeNull();
    unmount();
    const ohne = renderEbene(null);
    expect(ohne.container.querySelector('.vp-bottombar')).toBeNull();
  });

  it('in einer Anlage gilt IHRE Leiste — die Ebene ändert daran nichts', () => {
    renderEbene({}, {
      siteId: 's-1',
      siteName: 'Hof Lindenberg',
      sites: [{ id: 's-1', name: 'Hof Lindenberg' }],
      onSelectSite: vi.fn(),
      sidebar: anlageSidebar(null, 3),
      activeKey: 'steuerung',
      onOpenSub: vi.fn(),
      onOpenPage: vi.fn(),
      onOpenFleet: null,
      health: null,
    });
    expect(screen.queryByLabelText(titel)).toBeNull();
    const bar = screen.getByLabelText('Bereiche der Anlage Hof Lindenberg');
    expect([...bar.querySelectorAll('.lbl')].map((n) => n.textContent)).toEqual([
      'Cockpit',
      'Verlauf',
      'Steuerung',
      'Anlage',
    ]);
    expect(bar.getAttribute('style')).toContain('--vp-bar-slots: 4');
    expect(bar.querySelector('[aria-current="page"]')?.textContent).toContain('Steuerung');
  });
});
