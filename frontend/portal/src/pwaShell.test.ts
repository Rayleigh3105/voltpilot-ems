import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Wächter über die App-Hülle (Manifest, Icons, Service Worker, Offline-Seite).
 *
 * Er prüft genau die Zusagen, die man beim Anfassen still bricht und die kein
 * Render-Test sieht:
 *   1. Das Manifest verweist auf Icons, die es WIRKLICH gibt - ein umbenanntes
 *      Icon fällt sonst erst am Telefon des Kunden auf.
 *   2. `index.html` nennt Manifest und Apple-Icon (das iPhone liest das
 *      Manifest dafür nicht) und trägt DIESELBE `theme-color` - zwei Farben
 *      ergäben eine sichtbare Kante über der Kopfzeile.
 *   3. DIE REGEL, an der alles hängt: der Service Worker cacht NIEMALS
 *      `index.html` oder `/assets/*` und beantwortet ausschließlich
 *      Navigationen. Sonst wäre er eine zweite Cache-Schicht über der
 *      Auslieferungs-Politik der nginx, die `deployWatch` nicht einmal
 *      bemerken könnte.
 *   4. Die Offline-Seite ist selbsttragend und ohne inline `<script>` - die
 *      Produktions-CSP ist `script-src 'self'` OHNE 'unsafe-inline' (der
 *      Login-Ausfall vom 17.07.2026), ein Skript-Knopf dort wäre tot.
 *
 * Läuft ohne Docker - die beiden nginx-Smokes (test:csp/test:cache) prüfen die
 * HEADER am echten Image, dieser Wächter den INHALT.
 */
// vitest root ist frontend/portal (vitest.config.ts).
const at = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(at(p), 'utf8');

/**
 * Kommentare abstreifen, BEVOR geprüft wird - sonst prüft der Wächter seine
 * eigene Begründung (`copy.test.ts`-Muster). In `sw.js` steht „index.html" und
 * „respondWith" im Kopfkommentar, in `offline.html` erklärt ein HTML-Kommentar
 * die `<script>`-Regel.
 */
const stripJs = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const stripHtml = (markup: string) => markup.replace(/<!--[\s\S]*?-->/g, ' ');

const html = read('index.html');
const manifest = JSON.parse(read('public/manifest.webmanifest')) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  lang: string;
  background_color: string;
  theme_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
};
const sw = stripJs(read('public/sw.js'));
const offlineRaw = read('public/offline.html');
const offline = stripHtml(offlineRaw);

describe('manifest.webmanifest', () => {
  it('startet die App im Vollbild in der Wurzel', () => {
    expect(manifest.name).toBe('VoltPilot');
    expect(manifest.short_name).toBe('VoltPilot');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.lang).toBe('de');
  });

  it('trägt die Marken-Hintergrundfarbe (weiß wie die Kopfzeile der App)', () => {
    expect(manifest.background_color).toBe('#FFFFFF');
    expect(manifest.theme_color).toBe('#FFFFFF');
  });

  it('führt 192, 512 und eine maskable Fassung - und jede Datei gibt es wirklich', () => {
    const sizes = manifest.icons.map((i) => `${i.sizes}/${i.purpose}`);
    expect(sizes).toContain('192x192/any');
    expect(sizes).toContain('512x512/any');
    expect(sizes).toContain('512x512/maskable');
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      expect(existsSync(at(`public${icon.src}`)), `${icon.src} fehlt`).toBe(true);
    }
  });
});

describe('index.html: die vier Zeilen der Hülle', () => {
  it('verweist auf Manifest und Apple-Icon, und beide Dateien existieren', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    const apple = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html);
    expect(apple, 'kein apple-touch-icon - das iPhone liest das Manifest nicht').not.toBeNull();
    expect(existsSync(at(`public${apple![1]}`))).toBe(true);
  });

  it('nennt dieselbe theme-color wie das Manifest', () => {
    const m = /<meta name="theme-color" content="([^"]+)"/.exec(html);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(manifest.theme_color);
  });

  it('startet auf beiden Plattformen im Vollbild', () => {
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
  });

  it('lässt die Statusleiste hell, solange kein safe-area-inset-top im CSS steht', () => {
    // `black-translucent` schöbe den Inhalt unter die Statusleiste; die 68-px-
    // Kopfzeile hat dafür kein Polster (siehe den Kommentar in index.html).
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="default"');
  });

  it('hat weiterhin kein inline <script> (die CSP-Regel des Hauses)', () => {
    const inline = (stripHtml(html).match(/<script[^>]*>/g) ?? []).filter(
      (t) => !t.includes('src='),
    );
    expect(inline).toEqual([]);
  });
});

describe('sw.js: Durchreiche mit Offline-Rückfall, nichts weiter', () => {
  it('nimmt NIEMALS index.html oder /assets/* in den Vorrat', () => {
    expect(sw).not.toContain('index.html');
    expect(sw).not.toContain('/assets');
  });

  it('beantwortet ausschließlich Navigationen', () => {
    expect(sw).toContain("request.mode !== 'navigate'");
    // Genau EIN respondWith: jede weitere Antwort käme aus einem Cache, den die
    // Deploy-Erkennung nicht regiert.
    expect(sw.match(/respondWith/g)).toHaveLength(1);
  });

  it('reicht jede Navigation ans Netz und fällt nur bei einem Fehler zurück', () => {
    expect(sw).toContain('return await fetch(request)');
    expect(sw).toContain('caches.match(OFFLINE_URL)');
  });

  it('hält genau die Dateien im Vorrat, die es wirklich gibt', () => {
    const block = /const PRECACHE = \[([\s\S]*?)\];/.exec(sw);
    expect(block).not.toBeNull();
    const paths = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(paths).toContain('/manifest.webmanifest');
    expect(paths.length).toBeGreaterThan(1);
    for (const p of paths) {
      const file = p === '/offline.html' ? 'public/offline.html' : `public${p}`;
      expect(existsSync(at(file)), `${p} fehlt`).toBe(true);
    }
    // OFFLINE_URL ist eine Konstante und steht deshalb nicht als Zeichenkette
    // in der Liste - sie muss trotzdem drin sein.
    expect(block![1]).toContain('OFFLINE_URL');
    expect(sw).toContain("const OFFLINE_URL = '/offline.html'");
  });

  it('räumt alte Vorräte beim Aktivieren ab und trägt eine Fassung', () => {
    expect(sw).toMatch(/const SW_VERSION = '[^']+'/);
    expect(sw).toContain('caches.delete');
  });
});

describe('offline.html', () => {
  it('ist selbsttragend: kein Bündel, kein externes Bild, keine Schriftdatei', () => {
    expect(offline).not.toMatch(/<script[^>]*src=/);
    expect(offline).not.toMatch(/<link[^>]+rel="stylesheet"/);
    expect(offline).not.toMatch(/<img\b/);
    expect(offline).not.toMatch(/https?:\/\//);
  });

  it('trägt kein inline <script> - der Knopf ist ein echter Link', () => {
    const inline = (offline.match(/<script[^>]*>/g) ?? []).filter((t) => !t.includes('src='));
    expect(inline).toEqual([]);
    expect(offline).toContain('href="/"');
    expect(offline).not.toContain('onclick');
  });

  it('sagt ehrlich, was los ist - und was trotzdem weiterläuft', () => {
    expect(offline).toContain('Keine Verbindung');
    expect(offline).toMatch(/braucht Internet/);
    expect(offline).toMatch(/Anlage arbeitet unabhängig davon weiter/);
  });
});
