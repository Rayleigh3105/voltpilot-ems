import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Cache-Busting des Keycloak-Login-Themas (20.10.2026). Keycloak liefert Theme-Dateien unter
 * `/auth/resources/<Kennung>/login/voltpilot/…` mit `max-age` 30 Tage; die Kennung wechselt erst mit
 * einem Keycloak-Upgrade, nie mit unserem Thema. Darum trägt jede eigene URL `?v=…`, und
 * `deploy/keycloak/Dockerfile` setzt dort den Inhalts-Hash des Themas ein. Eine URL ohne Version fällt
 * erst nach dem nächsten Deploy auf: als altes CSS zur neuen Vorlage (Cloudflare und Browser halten es
 * bis zu 30 Tage). Dass ein echter Keycloak jede Datei der Anmeldeseite liefert, prüft
 * `ProduktionsRealmImportTest` in services/api.
 */
const THEMA = join(process.cwd(), '../../deploy/keycloak/themes/voltpilot/login');
const VORLAGEN_VERSION = '?v=${properties.assetVersion}';

describe('Keycloak-Thema: jede eigene URL trägt die Thema-Version', () => {
  it('theme.properties trägt den Platzhalter, den das Image ersetzt', () => {
    expect(readFileSync(join(THEMA, 'theme.properties'), 'utf8')).toMatch(/^assetVersion=dev$/m);
  });

  it('jede URL unter url.resourcesPath in den Vorlagen', () => {
    const urls = readdirSync(THEMA)
      .filter((name) => name.endsWith('.ftl'))
      .flatMap((name) => {
        const text = readFileSync(join(THEMA, name), 'utf8').replace(/<#--[\s\S]*?-->/g, '');
        return [...text.matchAll(/\$\{url\.resourcesPath\}[^"'\s>]*/g)].map((m) => `${name}: ${m[0]}`);
      });
    expect(urls.length).toBeGreaterThanOrEqual(6);
    expect(urls.filter((u) => !u.endsWith(VORLAGEN_VERSION))).toEqual([]);
  });

  it("jede url() im CSS, in einfachen Anführungszeichen (das Image ersetzt genau `?v=dev'`)", () => {
    const css = join(THEMA, 'resources/css');
    const urls = readdirSync(css)
      .filter((name) => name.endsWith('.css'))
      .flatMap((name) => {
        const text = readFileSync(join(css, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        return [...text.matchAll(/url\([^)]*\)/g)].map((m) => `${name}: ${m[0]}`);
      });
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls.filter((u) => !/url\('[^']+\?v=dev'\)$/.test(u))).toEqual([]);
  });
});
