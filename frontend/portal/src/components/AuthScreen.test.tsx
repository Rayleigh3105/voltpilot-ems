import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ANMELDE_TEXT, AuthScreen, BEWEGUNG_KEY, BrandStage, TrustRow } from './AuthScreen';
import { anlageBereiche, ebenenBereiche, PLAN_KONTEXT_TABS, VERLAUF_TABS } from '../ebenenNav';
import { anlageSurface } from '../surface';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { ahrenbergKennzahlen } from '../test/kennzahlenFixtures';
import { werkAhrenberg, werkLindach } from '../test/standorteFixtures';

const THEMA = join(process.cwd(), '../../deploy/keycloak/themes/voltpilot/login');

/** `schluessel=wert` je Zeile; Kommentare und Leerzeilen zaehlen nicht. */
function meldungen(datei: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const zeile of readFileSync(join(THEMA, 'messages', datei), 'utf8').split('\n')) {
    if (!zeile.trim() || /^\s*[#!]/.test(zeile)) continue;
    const i = zeile.indexOf('=');
    if (i > 0) out[zeile.slice(0, i)] = zeile.slice(i + 1);
  }
  return out;
}

beforeEach(() => {
  window.localStorage.clear();
});

const kachelTitel = (root: ParentNode) =>
  [...root.querySelectorAll('.vp-auth-tile-head b')].map((b) => b.textContent);

describe('BrandStage (Wortmarke auf Weiss + Kacheln)', () => {
  it('zeigt die Wortmarke als Bild, nicht als Text auf einem Verlauf', () => {
    const { container } = render(<BrandStage />);
    const logo = screen.getByAltText('VoltPilot');
    expect(logo.tagName).toBe('IMG');
    expect(logo).toHaveClass('vp-auth-wordmark');
    // Der frühere Orbit samt Glas-Plakette ist ersatzlos entfallen.
    expect(container.querySelector('.vp-orbit, .vp-brand-glass')).toBeNull();
  });

  it('zeigt zehn Kacheln in der Reihenfolge des Konzepts, Cockpit und Fahrplan doppelt breit', () => {
    const { container } = render(<BrandStage />);
    expect(kachelTitel(container)).toEqual([
      'Cockpit',
      'Verlauf',
      'Prognose',
      'Fahrplan',
      'Preise',
      'Steuerung',
      'Erlöse',
      'Kennzahlen',
      'Berichte',
      'Standorte',
    ]);
    const breit = [...container.querySelectorAll('.vp-auth-tile.is-wide b')].map((b) => b.textContent);
    expect(breit).toEqual(['Cockpit', 'Fahrplan']);
    // Je Kachel eine eigene Versatz-Klasse - sonst leuchten zwei zugleich.
    const versatz = [...container.querySelectorAll('.vp-auth-tile')].map((k) => k.className.match(/vp-auth-t\d/)![0]);
    expect(new Set(versatz).size).toBe(10);
  });

  it('das Cockpit zeigt Sonne → Haus in den Rollenfarben - das Haus ist Verbrauch', () => {
    const { container } = render(<BrandStage />);
    const farben = [...container.querySelectorAll('.vp-auth-fl')].map((p) => p.getAttribute('stroke'));
    expect(farben).toEqual(['var(--vp-flow-pv)', 'var(--vp-flow-load)']);
  });

  it('trägt keine Zahl ausser „15 Minuten“ - die Bühne kennt keine Anlage', () => {
    const { container } = render(<BrandStage />);
    const kacheln = container.querySelector('.vp-auth-tiles')!.textContent!.replace(T_PLAN_SUB, '');
    expect(kacheln).not.toMatch(/\d/);
    expect(container.querySelector('.vp-auth-intro')!.textContent).not.toMatch(/\d/);
  });

  it('hält das Motiv dekorativ - der Knopf steht ausserhalb der versteckten Teile', () => {
    const { container } = render(<BrandStage />);
    for (const sel of ['.vp-auth-intro', '.vp-auth-tiles', '.vp-auth-footnote']) {
      expect(container.querySelector(sel)?.getAttribute('aria-hidden'), sel).toBe('true');
    }
    const knopf = screen.getByRole('button', { name: 'Bewegung anhalten' });
    expect(knopf.closest('[aria-hidden="true"]')).toBeNull();
  });
});

const T_PLAN_SUB = ANMELDE_TEXT.vpTilePlanSub;

describe('Die Kacheln folgen der echten Navigation', () => {
  it('jede Kachel heisst wie ein Bereich oder Reiter, den es im Portal gibt', () => {
    const speicherAnlage = anlageSurface({
      entities: [{ id: 'e1', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } }],
    });
    const messkunde = {
      standorte: [werkAhrenberg(), werkLindach()],
      funktionen: ahrenbergFunktionen(),
      kennzahlen: ahrenbergKennzahlen(),
      verbesserung: true,
    };
    const echt = [
      ...anlageBereiche(speicherAnlage).map((b) => b.label),
      ...VERLAUF_TABS.map((t) => t.label),
      ...PLAN_KONTEXT_TABS.map((t) => t.label),
      ...ebenenBereiche({ art: 'unternehmen' }, messkunde).map((b) => b.label),
    ];
    const { container } = render(<BrandStage />);
    // Die Prognose hat für Kunden keinen eigenen Reiter („Prognosen“ ist ein
    // VoltPilot-Werkzeug): sie steht als Zeile im Fahrplan, das Wetter als Reiter.
    const ziel: Record<string, string> = { Prognose: 'Wetter' };
    const fremd = kachelTitel(container).filter((t) => !echt.includes(ziel[t!] ?? t!));
    expect(fremd).toEqual([]);
  });
});

describe('Keycloak-Thema und Portal sprechen denselben Satz', () => {
  const de = meldungen('messages_de.properties');
  const en = meldungen('messages_en.properties');
  const vorlage = readFileSync(join(THEMA, 'template.ftl'), 'utf8');
  const anmeldung = readFileSync(join(THEMA, 'login.ftl'), 'utf8');

  it('jeder Text der Portal-Bühne steht wortgleich in messages_de.properties', () => {
    const abweichend = Object.entries(ANMELDE_TEXT)
      .filter(([k, v]) => de[k] !== v)
      .map(([k, v]) => `${k}: Portal „${v}" · Thema „${de[k] ?? '(fehlt)'}"`);
    expect(abweichend).toEqual([]);
  });

  it('und hat einen englischen Zwilling (sonst rendert Keycloak den nackten Schlüssel)', () => {
    expect(Object.keys(ANMELDE_TEXT).filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
  });

  it('das Thema zeigt jeden dieser Texte auch', () => {
    const ungenutzt = Object.keys(ANMELDE_TEXT).filter(
      (k) => !vorlage.includes(`msg("${k}")`) && !anmeldung.includes(`msg("${k}")`),
    );
    expect(ungenutzt).toEqual([]);
  });

  it('beide Bühnen merken sich die Bewegung unter demselben Schlüssel', () => {
    const skript = readFileSync(join(THEMA, 'resources/js/stage-motion.js'), 'utf8');
    expect(skript).toContain(`'${BEWEGUNG_KEY}'`);
    expect(readFileSync(join(THEMA, 'theme.properties'), 'utf8')).toMatch(/^scripts=.*js\/stage-motion\.js/m);
  });
});

describe('AuthScreen (die Bühne)', () => {
  it('rendert Markenfläche, Karte und den Marken-Verlauf als 3-px-Akzent', () => {
    const { container } = render(
      <AuthScreen>
        <h1>Willkommen zurück</h1>
      </AuthScreen>,
    );
    expect(container.querySelector('.vp-auth-strip')).not.toBeNull();
    expect(container.querySelector('.vp-auth-brand .vp-auth-wordmark')).not.toBeNull();
    expect(container.querySelector('.vp-auth-panel .vp-auth-card')).not.toBeNull();
    expect(screen.getByText('Willkommen zurück')).toBeInTheDocument();
  });

  it('macht `.vp-auth` zum Container - das Raster liegt eine Ebene tiefer', () => {
    // Ein Element kann nicht von seiner EIGENEN Container-Query gestylt werden;
    // liegen beide auf demselben Knoten, greift die breite Fassung nie.
    const { container } = render(<AuthScreen>x</AuthScreen>);
    const auth = container.querySelector('.vp-auth');
    expect(auth).not.toBeNull();
    expect(auth!.querySelector(':scope > .vp-auth-split')).not.toBeNull();
  });

  it('stellt am Telefon EINE ruhige Kachel UNTER die Karte - das Formular führt (C3)', () => {
    const { container } = render(<AuthScreen>x</AuthScreen>);
    const panel = container.querySelector('.vp-auth-panel')!;
    const kinder = [...panel.children].map((k) => k.className);
    expect(kinder.indexOf('vp-auth-card')).toBeLessThan(kinder.indexOf('vp-auth-onetile'));
    const kachel = panel.querySelector('.vp-auth-onetile')!;
    expect(kachel.getAttribute('aria-hidden')).toBe('true');
    expect(kachel.textContent).toBe(ANMELDE_TEXT.vpOneTile + ANMELDE_TEXT.vpOneTileSub);
    // Dort bewegt sich nichts: kein Laufpunkt, kein Lichtpunkt.
    expect(kachel.querySelector('.vp-auth-fl, .vp-auth-tile')).toBeNull();
  });

  it('der Knopf hält die Bühne an und merkt sich das', () => {
    const { container, unmount } = render(<AuthScreen>x</AuthScreen>);
    fireEvent.click(screen.getByRole('button', { name: 'Bewegung anhalten' }));
    expect(container.querySelector('.vp-auth')).toHaveClass('vp-auth-still');
    expect(screen.getByRole('button', { name: 'Bewegung fortsetzen' })).toBeInTheDocument();
    expect(window.localStorage.getItem(BEWEGUNG_KEY)).toBe('aus');
    unmount();

    // Die nächste Fläche (z.B. die Registrierung nach dem Neuladen) startet still.
    const zweite = render(<AuthScreen>x</AuthScreen>);
    expect(zweite.container.querySelector('.vp-auth')).toHaveClass('vp-auth-still');
    fireEvent.click(screen.getByRole('button', { name: 'Bewegung fortsetzen' }));
    expect(zweite.container.querySelector('.vp-auth')).not.toHaveClass('vp-auth-still');
    expect(window.localStorage.getItem(BEWEGUNG_KEY)).toBeNull();
  });

  it('ohne Speicher (privates Fenster) läuft die Bühne einfach und der Knopf wirkt trotzdem', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    try {
      const { container } = render(<AuthScreen>x</AuthScreen>);
      expect(container.querySelector('.vp-auth')).not.toHaveClass('vp-auth-still');
      fireEvent.click(screen.getByRole('button', { name: 'Bewegung anhalten' }));
      expect(container.querySelector('.vp-auth')).toHaveClass('vp-auth-still');
    } finally {
      Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('TrustRow', () => {
  it('says only „Verschlüsselt · Server in Deutschland“ — no legal claim (AP-20 E9)', () => {
    const { container } = render(<TrustRow />);
    expect(screen.getByText(/Verschlüsselt/)).toBeInTheDocument();
    expect(screen.getByText('Server in Deutschland')).toBeInTheDocument();
    const row = container.querySelector('.vp-auth-trust');
    expect(row?.children).toHaveLength(2);
    expect(row?.textContent).not.toMatch(/DSGVO|GDPR|konform/i);
  });
});
