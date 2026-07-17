import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthScreen, BrandStage, TrustRow } from './AuthScreen';

describe('BrandStage (the voltpilot.de orbit on the auth gradient)', () => {
  it('renders the three rings with their six category nodes and the energy core', () => {
    const { container } = render(<BrandStage />);
    expect(container.querySelectorAll('.vp-orbit-ring')).toHaveLength(3);
    // Ring 3 is the dashed outer ring.
    expect(container.querySelector('.vp-orbit-ring-3')).not.toBeNull();
    const nodes = container.querySelectorAll('.vp-orbit-node');
    expect(nodes).toHaveLength(6);
    // The six voltpilot.de categories, each as its own node.
    for (const cat of ['pv', 'battery', 'home', 'car', 'industry', 'grid']) {
      expect(container.querySelector(`.vp-orbit-node.${cat}`)).not.toBeNull();
    }
    // Ring-2/3 nodes carry the matching counter-rotation duration classes.
    expect(container.querySelectorAll('.vp-orbit-node.ring2')).toHaveLength(2);
    expect(container.querySelectorAll('.vp-orbit-node.ring3')).toHaveLength(2);
    expect(container.querySelector('.vp-orbit-center-inner svg')).not.toBeNull();
  });

  it('shows the logo on the frosted glass plaque, not a bare image', () => {
    const { container } = render(<BrandStage />);
    const glass = container.querySelector('.vp-brand-glass');
    expect(glass).not.toBeNull();
    expect(glass!.querySelector('img[alt="VoltPilot"]')).not.toBeNull();
  });

  it('keeps the orbit decorative for screen readers (aria-hidden shell)', () => {
    const { container } = render(<BrandStage />);
    expect(
      container.querySelector('.vp-orbit-shell')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });
});

describe('AuthScreen (split view shell)', () => {
  it('renders brand stage left and the panel content right', () => {
    const { container } = render(
      <AuthScreen>
        <h1>Willkommen zurück</h1>
      </AuthScreen>,
    );
    expect(container.querySelector('.vp-auth-brand .vp-orbit')).not.toBeNull();
    expect(container.querySelector('.vp-auth-panel')).not.toBeNull();
    expect(screen.getByText('Willkommen zurück')).toBeInTheDocument();
    // The brand logo stays accessible (it is the page's VoltPilot identity).
    expect(screen.getByAltText('VoltPilot')).toBeInTheDocument();
  });
});

describe('TrustRow', () => {
  it('carries the three German trust claims', () => {
    render(<TrustRow />);
    expect(screen.getByText(/Verschlüsselt/)).toBeInTheDocument();
    expect(screen.getByText('Server in Deutschland')).toBeInTheDocument();
    expect(screen.getByText('DSGVO-konform')).toBeInTheDocument();
  });
});
