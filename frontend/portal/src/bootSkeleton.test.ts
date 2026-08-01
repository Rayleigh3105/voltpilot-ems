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

describe('index.html Sofort-Skelett', () => {
  it('ships the skeleton markup React later replaces', () => {
    expect(html).toContain('id="vp-boot-skeleton"');
    // Der Wortmarken-Blitz ist inline-SVG, kein Bild-Request.
    expect(html).toContain('<svg viewBox="0 0 24 24"');
    expect(html).toContain('VoltPilot');
  });

  it('references no external asset (bleibt no-cache-tauglich, kein Hash nötig)', () => {
    const skeleton = html.slice(html.indexOf('<style>'));
    expect(skeleton).not.toMatch(/url\(/i);
    expect(skeleton).not.toMatch(/<img\b/i);
    // Der einzige erlaubte externe Verweis im Dokument bleibt das Favicon und
    // das Modul-Skript - beide ausserhalb des Skeletts.
    expect(skeleton).not.toMatch(/https?:\/\//i);
  });

  it('carries no inline <script> (die CSP wuerde es still blockieren)', () => {
    const openingTags = html.match(/<script[^>]*>/gi) ?? [];
    expect(openingTags.length).toBeGreaterThan(0);
    for (const tag of openingTags) expect(tag).toMatch(/\bsrc=/);
  });
});
