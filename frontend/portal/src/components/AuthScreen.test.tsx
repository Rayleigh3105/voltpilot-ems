import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthScreen, BrandStage, TrustRow } from './AuthScreen';

describe('BrandStage (Wortmarke auf Weiss + Energiefluss-Motiv)', () => {
  it('zeigt die Wortmarke als Bild, nicht als Text auf einem Verlauf', () => {
    const { container } = render(<BrandStage />);
    const logo = screen.getByAltText('VoltPilot');
    expect(logo.tagName).toBe('IMG');
    expect(logo).toHaveClass('vp-auth-wordmark');
    // Der frühere Orbit samt Glas-Plakette ist ersatzlos entfallen.
    expect(container.querySelector('.vp-orbit, .vp-brand-glass')).toBeNull();
  });

  it('traegt das Energiefluss-Motiv in den Rollenfarben des Cockpits', () => {
    const { container } = render(<BrandStage />);
    const flow = container.querySelector('.vp-auth-flow');
    expect(flow).not.toBeNull();
    // Vier Speichen in den vier --vp-flow-*-Rollenfarben.
    const spokes = [...container.querySelectorAll('.vp-auth-flow .spoke')];
    expect(spokes).toHaveLength(4);
    expect(spokes.map((s) => s.getAttribute('stroke'))).toEqual([
      'var(--vp-flow-pv)',
      'var(--vp-flow-batt)',
      'var(--vp-flow-load)',
      'var(--vp-flow-grid)',
    ]);
  });

  it('laesst zwischen „Solar erzeugt" und dem Sonnenkreis sichtbar Luft', () => {
    const { container } = render(<BrandStage />);
    const flow = container.querySelector('.vp-auth-flow')!;
    const solarSub = [...flow.querySelectorAll('text')].find((node) => node.textContent === 'erzeugt')!;
    const solarCircle = flow.querySelector('circle')!;

    const textBaseline = Number(solarSub.getAttribute('y'));
    const circleTop = Number(solarCircle.getAttribute('cy')) - Number(solarCircle.getAttribute('r'));
    expect(circleTop - textBaseline).toBeGreaterThanOrEqual(7);
  });

  it('haelt das Motiv dekorativ - die Aussage tragen die Texte daneben', () => {
    const { container } = render(<BrandStage />);
    expect(container.querySelector('.vp-auth-stage')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Ihre Anlage, auf einen Blick.')).toBeInTheDocument();
  });

  it('nennt die vier taeglichen Fragen in der Reihenfolge der Telefon-Leiste', () => {
    const { container } = render(<BrandStage />);
    const titles = [...container.querySelectorAll('.vp-auth-quartet b')].map((b) => b.textContent);
    expect(titles).toEqual(['Cockpit', 'Fahrplan', 'Messwerte', 'Erlöse']);
  });
});

describe('AuthScreen (die Buehne)', () => {
  it('rendert Markenflaeche, Karte und den Marken-Verlauf als 3-px-Akzent', () => {
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

  it('haelt die Quartett-Zeile der schmalen Fassung dekorativ', () => {
    const { container } = render(<AuthScreen>x</AuthScreen>);
    const line = container.querySelector('.vp-auth-quartet-line');
    expect(line?.getAttribute('aria-hidden')).toBe('true');
    expect([...line!.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Cockpit',
      'Fahrplan',
      'Messwerte',
      'Erlöse',
    ]);
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
