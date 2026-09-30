import { afterEach, describe, expect, it } from 'vitest';
import { readBootPulsePhase } from './bootHandoff';

/**
 * ⚠ NICE-2-WÄCHTER (Phasen-Übergabe Inline → React): der React-Lader muss die
 * LAUFENDE Puls-Phase des Inline-Laders übernehmen, nicht bei 0 neu starten -
 * sonst springt der Rhythmus beim Übergang, obwohl die Form pixelgleich ist.
 * `readBootPulsePhase()` liest die `currentTime` des ersten (versatzfreien)
 * Inline-Rings und gibt den negativen `animation-delay` zurück. JSDOM kennt kein
 * `getAnimations`, deshalb stellen wir hier ein kontrolliertes Skelett + eine
 * Fake-Animation und prüfen die Ableitung.
 */

function mountSkeleton(anims: Partial<Animation>[] | null): HTMLElement {
  const skeleton = document.createElement('div');
  skeleton.id = 'vp-boot-skeleton';
  const ring = document.createElement('span');
  ring.className = 'vp-bs-ring r1';
  if (anims) {
    (ring as unknown as { getAnimations: () => Partial<Animation>[] }).getAnimations = () => anims;
  }
  skeleton.appendChild(ring);
  document.body.appendChild(skeleton);
  return skeleton;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('readBootPulsePhase', () => {
  it('liefert null ohne Inline-Skelett (spätere Lader knüpfen an nichts an)', () => {
    expect(readBootPulsePhase()).toBeNull();
  });

  it('liefert null, wenn der Ring keine getAnimations kennt', () => {
    mountSkeleton(null);
    expect(readBootPulsePhase()).toBeNull();
  });

  it('leitet aus der laufenden Puls-Phase den negativen Delay ab', () => {
    mountSkeleton([{ animationName: 'vp-bs-pulse', currentTime: 742 } as unknown as Animation]);
    expect(readBootPulsePhase()).toBe('-742ms');
  });

  it('wählt die vp-bs-pulse-Animation, nicht eine fremde daneben', () => {
    mountSkeleton([
      { animationName: 'irgendwas', currentTime: 10 } as unknown as Animation,
      { animationName: 'vp-bs-pulse', currentTime: 300 } as unknown as Animation,
    ]);
    expect(readBootPulsePhase()).toBe('-300ms');
  });

  it('faltet eine currentTime über eine Periode (1800ms) hinaus in die Periode', () => {
    mountSkeleton([{ animationName: 'vp-bs-pulse', currentTime: 2000 } as unknown as Animation]);
    expect(readBootPulsePhase()).toBe('-200ms');
  });

  it('liefert null bei fehlender/nicht-endlicher currentTime (reduzierte Bewegung, Halt)', () => {
    mountSkeleton([{ animationName: 'vp-bs-pulse', currentTime: null } as unknown as Animation]);
    expect(readBootPulsePhase()).toBeNull();
  });
});
