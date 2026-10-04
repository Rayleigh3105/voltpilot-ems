import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Wächter für das Sofort-Skelett in index.html (siehe dessen Kommentarblock).
 *
 * Es ist die einzige Fläche, die Chromes Paint-Holding nach einem Deploy
 * beendet, bevor JS + Keycloak-Prüfung durch sind - und sie trägt genau zwei
 * harte Randbedingungen, die kein Test sonst abdeckt:
 *   1. NUR inline (kein externes Asset), sonst zeichnet sie erst nach einem
 *      weiteren Roundtrip und index.html bräuchte einen Hash.
 *   2. Kein inline <script>: die Produktions-CSP ist `script-src 'self'` OHNE
 *      'unsafe-inline' (der Login-Ausfall vom 17.07.2026). Inline <style> ist
 *      erlaubt (`style-src ... 'unsafe-inline'`), inline <script> nicht.
 * Läuft ohne Docker - die beiden nginx-Smoke-Tests (test:csp/test:cache)
 * brauchen einen Daemon, dieser Wächter nicht.
 */
// vitest root ist frontend/portal (vitest.config.ts).
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

describe('index.html Sofort-Lader', () => {
  it('ships the loader markup React later replaces', () => {
    expect(html).toContain('id="vp-boot-skeleton"');
    // Die ECHTE Wortmarke als Data-URI (byte-genau dasselbe Bild wie der
    // React-Lader), kein zusätzlicher Request und kein Ersatz-Logo.
    expect(html).toMatch(/class="vp-bs-word"[^>]*src="data:image\/png;base64,/);
    expect(html).toContain('VoltPilot');
    // Der VoltPilot-Lade-Moment „Der Puls": ausstrahlende Ringe (dieselbe Loop,
    // die der React-Lader `.vp-loader-ring`/`vp-loader-pulse` weiterführt).
    expect(html).toContain('vp-bs-ring');
    expect(html).toContain('@keyframes vp-bs-pulse');
  });

  it('references no EXTERNAL asset (bleibt no-cache-tauglich, kein Hash nötig)', () => {
    const skeleton = html.slice(html.indexOf('<style>'));
    // Kein `url(...)` auf ein externes Asset. Erlaubt sind lokale SVG-Fragment-
    // Refs (`url(#vplFill-bs)`) und Data-URIs (`url(data:…)`) - beide kosten
    // KEINEN Request.
    expect(skeleton).not.toMatch(/url\(\s*["']?(?!#|data:)/i);
    // Kein <img> auf ein externes Asset - nur Data-URIs (die Wortmarke; kein
    // Request). Ein externes `src` (http/relativ/Wurzel) ist verboten.
    for (const tag of skeleton.match(/<img\b[^>]*>/gi) ?? []) {
      expect(tag, `externes Bild im Lader: ${tag.slice(0, 60)}`).toMatch(/\bsrc="data:/);
    }
    // Kein externer http(s)-Verweis im Lader (Data-URI-Base64 enthält kein `://`).
    expect(skeleton).not.toMatch(/https?:\/\//i);
  });

  it('carries no inline <script> (die CSP wuerde es still blockieren)', () => {
    const openingTags = html.match(/<script[^>]*>/gi) ?? [];
    expect(openingTags.length).toBeGreaterThan(0);
    for (const tag of openingTags) expect(tag).toMatch(/\bsrc=/);
  });
});
