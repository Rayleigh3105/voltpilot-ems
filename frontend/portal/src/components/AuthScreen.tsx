import type { ReactNode } from 'react';
import logoUrl from '../../designsystem/assets/voltpilot-logo.png';
import { Icon } from '../../designsystem/components/core/Icon';

/*
 * The captain-approved auth brand language (login redesign, 2026-07-17):
 * a split view - left the PURE brand on the --vp-grad-hero gradient with the
 * ORIGINAL voltpilot.de orbit animation (three rotating rings, category nodes
 * counter-rotating so their icons stay upright, navy energy core) and the
 * logo on a frosted GLASS plaque (captain design update 2026-07-17: matte
 * glass - rgba(255,255,255,.30) + backdrop-blur(12px, -webkit-prefixed for
 * Safari) + hairline white border - NOT a solid white card); right the calm
 * form panel. On phones the gradient collapses into a compact head band with
 * a mini orbit and a smaller glass plaque. All rotation stops under
 * prefers-reduced-motion (CSS, ".vp-auth" block in index.css).
 *
 * Every unauthenticated surface renders through <AuthScreen> so login,
 * register, boot splash, lockout/expired and the error card speak one visual
 * language. The Keycloak theme (deploy/keycloak/themes/voltpilot) carries the
 * same stage for the direct-to-Keycloak login - change both together.
 */

const STROKE_ICON = {
  fill: 'none',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function OrbitNode({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div className={`vp-orbit-node ${className}`}>
      <svg viewBox="0 0 24 24" {...STROKE_ICON}>
        {children}
      </svg>
    </div>
  );
}

/**
 * The voltpilot.de orbit: ring 1 (15s), ring 2 (20s reverse), ring 3 (25s,
 * dashed) with the six category nodes (Solar / Speicher / Zuhause / E-Auto /
 * Gewerbe / Netz) as white circles carrying category-colored stroke icons.
 */
export function BrandStage() {
  return (
    <div className="vp-brandstage">
      <div className="vp-orbit-shell" aria-hidden="true">
        <div className="vp-orbit">
          <div className="vp-orbit-ring vp-orbit-ring-1">
            <OrbitNode className="n-top pv">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
            </OrbitNode>
            <OrbitNode className="n-bot battery">
              <rect x="3" y="7" width="16" height="10" rx="2" />
              <path d="M22 11v2" />
            </OrbitNode>
          </div>
          <div className="vp-orbit-ring vp-orbit-ring-2">
            <OrbitNode className="ring2 n-left home">
              <path d="M3 11 12 3l9 8" />
              <path d="M5 10v10h14V10" />
            </OrbitNode>
            <OrbitNode className="ring2 n-right car">
              <path d="M5 16l2-6h10l2 6" />
              <rect x="4" y="16" width="16" height="4" rx="1" />
              <circle cx="7.5" cy="20" r="1" />
              <circle cx="16.5" cy="20" r="1" />
            </OrbitNode>
          </div>
          <div className="vp-orbit-ring vp-orbit-ring-3">
            <OrbitNode className="ring3 n-top industry">
              <path d="M3 21V9l6 4V9l6 4V5h6v16z" />
            </OrbitNode>
            <OrbitNode className="ring3 n-bot grid">
              <path d="M6 21V8l6-5 6 5v13M9 21v-6h6v6" />
            </OrbitNode>
          </div>
          <div className="vp-orbit-center">
            <div className="vp-orbit-center-inner">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"
                  fill="#fff"
                  stroke="#fff"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          </div>
        </div>
      </div>
      <div className="vp-brand-glass">
        <img className="vp-brand-logo" src={logoUrl} alt="VoltPilot" />
      </div>
    </div>
  );
}

/** Split auth shell: brand stage left (head band on phones), content right. */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="vp-auth">
      <aside className="vp-auth-brand">
        <BrandStage />
      </aside>
      <div className="vp-auth-panel">
        <div className="vp-auth-body">{children}</div>
      </div>
    </div>
  );
}

/** Vertrauenszeile: Verschlüsselt / Server in Deutschland / DSGVO-konform. */
export function TrustRow() {
  return (
    <div className="vp-auth-trust">
      <span>
        <Icon name="lock" size={12} strokeWidth={2.4} /> Verschlüsselt
      </span>
      <span>Server in Deutschland</span>
      <span>DSGVO-konform</span>
    </div>
  );
}
