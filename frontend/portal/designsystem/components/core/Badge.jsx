import React from 'react';

/**
 * VoltPilot Badge / Pill — tinted or gradient label, plus the status variants
 * ok / warn / off (green / amber / muted) used for device and user states.
 * `dot` renders a small status dot before the label.
 */
export function Badge({
  children,
  variant = 'tint', // tint | gradient | solid | ok | warn | offline | off
  dot = false,
  // Schlägt den Punkt EINMAL (keine Dauer-Animation) - der Beleg, dass eine
  // Antwort gerade einen neueren Herzschlag getragen hat (Adminview-Konzept
  // §5.4). Nie mit `pulse` als Dauerzustand verwechseln: der endet nach einem
  // Lauf von selbst und braucht deshalb KEINEN Eintrag im
  // `prefers-reduced-motion`-Block von `index.css` (eine einmalige Animation
  // steht unter `--vp-motion-scale: 0` sofort auf ihrem Endzustand).
  pulse = false,
  style = {},
  ...props
}) {
  const variants = {
    // Text in --vp-action (Navy): --vp-primary-deep erreichte auf dem hellen Tint nur ~3,1:1
    // (WCAG AA verlangt 4,5:1 für diese kleine Schrift).
    tint: {
      background: 'var(--vp-tint)',
      color: 'var(--vp-action)',
    },
    gradient: {
      background: 'var(--vp-grad-badge)',
      color: 'var(--vp-action)',
    },
    solid: {
      background: 'var(--vp-primary-deep)',
      color: '#fff',
    },
    ok: {
      background: 'var(--vp-mint-start)',
      color: 'var(--vp-ok-ink, #2e7d32)',
    },
    warn: {
      background: '#FFF3E0',
      color: 'var(--vp-warn-ink, #b45309)',
    },
    // Eine Stufe dunkler als `warn` (Adminview-Konzept §5.3: „verzögert" ist
    // bernstein, „meldet sich nicht" ist orange - zwei verschiedene Ernste,
    // zwei verschiedene Töne, nie derselbe wie ein Fehler (`fehler`).
    offline: {
      background: '#FDE9D3',
      color: '#9A4A0A',
    },
    off: {
      background: 'var(--vp-bg-light)',
      color: '#57606A',
    },
  };

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        fontFamily: 'var(--vp-font-body)',
        fontSize: 'var(--vp-text-badge)',
        fontWeight: 600,
        lineHeight: 1,
        padding: '0.3rem 0.75rem',
        borderRadius: 'var(--vp-radius-pill)',
        ...variants[variant],
        ...style,
      }}
      {...props}
    >
      {dot && (
        <span
          className={pulse ? 'vp-badge-dot-puls' : undefined}
          style={{
            width: 7,
            height: 7,
            borderRadius: 'var(--vp-radius-full)',
            background: 'currentColor',
            flexShrink: 0,
          }}
        />
      )}
      {children}
    </span>
  );
}
