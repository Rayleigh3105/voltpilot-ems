import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * WCAG 2.2 AA · automatischer axe-core-Durchgang über die Hauptseiten des
 * Kunden- und des Admin-Bereichs, je Seite bei 1440 und 390 px.
 *
 * Gescannt werden die vorhandenen Prüfbühnen mit echten Beispieldaten:
 * `help.html` (die ganze App mit `installHelpFixtures`, dieselbe Bühne wie die
 * Hilfe-Bilder), `steuerung.html` und die Admin-Bühnen. Ein leerer Mock zeigte
 * fast nur Leerzustände und fand dort nichts.
 *
 * Kein Soll/Ist-Schnappschuss: ein axe-Fund ist ein Verstoß gegen eine der
 * eingeschalteten Regelgruppen. Bekannte, offene Funde stehen einzeln in
 * {@link OFFEN} (Regel + Element), damit jeder NEUE Fund den Lauf rot macht.
 */

const plant = (sub = '') => '#/anlage/help-site' + (sub ? '/' + sub : '');
/** Die Beispielanlage der Steuerung (`e2e/steuerung.*`) lebt am 29.09.2026, 13:10 Uhr. */
const STEUERUNG_UHR = '2026-09-29T11:10:00Z';

const SEITEN: { name: string; seite?: string; query?: string; hash?: string; uhr?: string }[] = [
  { name: 'Cockpit', hash: plant() },
  { name: 'Fahrplan', hash: plant('fahrplan') },
  { name: 'Verlauf · Energie', hash: plant('messwerte') },
  { name: 'Verlauf · Erlöse', hash: plant('erloese') },
  { name: 'Preise', hash: plant('marktpreise'), uhr: '2026-09-10T03:00:00Z' },
  { name: 'Wetter', hash: plant('wetter') },
  { name: 'Lastspitzen', hash: plant('lastspitzen') },
  { name: 'Ladevorgänge', hash: plant('ladevorgaenge') },
  { name: 'Aufbau', hash: plant('modell') },
  { name: 'Box', hash: plant('box/VP-DEMO-0001') },
  { name: 'Gerät', hash: plant('geraet/VP-DEMO-0001/inverter') },
  { name: 'Anlage · Einstellungen', hash: plant('technik') },
  { name: 'Portfolio', hash: '#/portfolio' },
  { name: 'Anlage anlegen', query: 'state=empty', hash: '#/uebersicht' },
  { name: 'Hilfe', hash: '#/hilfe/fahrplan' },
  { name: 'Steuerung', seite: 'steuerung', hash: plant('steuerung'), uhr: STEUERUNG_UHR },
  { name: 'Laden', seite: 'steuerung', hash: plant('laden'), uhr: STEUERUNG_UHR },
  { name: 'Persönliche Einstellungen', seite: 'einstellungen' },
  { name: 'Admin · Flotte', seite: 'admin-flotte' },
  { name: 'Admin · Plattform-Übersicht', seite: 'plattform-uebersicht' },
  { name: 'Admin · Benutzer', seite: 'benutzer' },
  { name: 'Admin · Mandantenakte', seite: 'mandanten-akte' },
  { name: 'Admin · Geräteakte', seite: 'geraete-akte' },
];

const BREITEN = [
  { name: '1440px', width: 1440, height: 1000 },
  { name: '390px', width: 390, height: 844 },
];

/**
 * Offene Funde aus dem Wartungsbericht `vp-wartung-a11y-w1` (07.11.2026), je
 * Regel und Element. Sie brauchen eine Entscheidung (neue Farbe, anderer Name,
 * größeres Feld) und sind darum hier benannt statt still abgeschaltet. Wer
 * einen behebt, streicht seine Zeile.
 */
const OFFEN: { regel: string; ziel: RegExp; warum: string }[] = [
  { regel: 'color-contrast', ziel: /\.vp-wt-tag-ertrag > b$/, warum: 'PV-Orange #e65100 als Schrift (3,56 : 1), braucht ein PV-Ink' },
  { regel: 'color-contrast', ziel: /\.l-top > b$/, warum: 'PV-Orange #e65100 als Schrift (3,78 : 1), braucht ein PV-Ink' },
  { regel: 'label-content-name-mismatch', ziel: /\.vp-tb-status$/, warum: 'Name ohne Kopf/„Geplant“ der sichtbaren Zeile' },
  { regel: 'label-content-name-mismatch', ziel: /\.vp-antw-knopf$/, warum: 'Name ist die Frage, sichtbar ist die Kurzantwort' },
  { regel: 'label-content-name-mismatch', ziel: /\.vp-wt-tag$/, warum: 'Name ohne den sichtbaren Ertrag' },
  { regel: 'label-content-name-mismatch', ziel: /\.vp-help-image-button$/, warum: 'Name „Screenshot vergrößern: …“ statt sichtbarem „Vergrößern“' },
  { regel: 'label-content-name-mismatch', ziel: /\.vp-healthbadge$/, warum: 'Name mit „Zustand der Anlage:“ und Gedankenstrich' },
  { regel: 'label-content-name-mismatch', ziel: /aria-label="Womit laden: /, warum: 'Name ohne die sichtbare Erklärzeile' },
  { regel: 'label-content-name-mismatch', ziel: /\.vp-ueb-flotte-kachel/, warum: 'Gerätewand (#1787): Zustandswort steht sichtbar vor Kunde/Anlage, im Namen dahinter' },
];

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

for (const seite of SEITEN) {
  for (const breite of BREITEN) {
    test(`axe: ${seite.name} bei ${breite.name}`, async ({ page }, info) => {
      // Die Breite setzt der Fall selbst - in den Tablet-/Telefon-Projekten
      // liefe derselbe Scan nur doppelt.
      test.skip(info.project.name !== 'desktop-chromium', 'setzt die Breite selbst');
      // Die großen Lazy-Stücke (Fahrplan, Steuerung, Admin) übersetzt der
      // Dev-Server beim ersten Abruf; unter Last braucht das länger als das
      // Standard-Budget (siehe `playwright.global-setup.ts`).
      test.setTimeout(120_000);
      await page.setViewportSize({ width: breite.width, height: breite.height });
      await page.clock.setFixedTime(new Date(seite.uhr ?? '2026-09-10T10:00:00Z'));
      await page.goto(`/e2e/${seite.seite ?? 'help'}.html${seite.query ? `?${seite.query}` : ''}${seite.hash ?? ''}`, {
        timeout: 90_000,
      });
      await page.locator('.vp-app, .vp-modal, main').first().waitFor({ timeout: 60_000 });
      await expect(page.locator('[data-vp-loader], .vp-skeleton')).toHaveCount(0, { timeout: 30_000 });
      // Einblendungen erst zu Ende laufen lassen: mitten im Übergang misst axe
      // eine halb deckende Schrift (gesehen: Zeilen des Aufbaus mit 3,1 : 1).
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        ),
      );

      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      const neu = results.violations
        .map((v) => ({
          ...v,
          nodes: v.nodes.filter(
            (n) => !OFFEN.some((o) => o.regel === v.id && (o.ziel.test(n.target.join(' ')) || o.ziel.test(n.html))),
          ),
        }))
        .filter((v) => v.nodes.length > 0);
      const meldung = neu
        .map(
          (v) =>
            `\n[${v.impact}] ${v.id} (${v.help}) - ${v.nodes.length} Stelle(n):\n` +
            v.nodes.map((n) => `  ${n.target.join(' ')} :: ${n.failureSummary ?? ''}`).join('\n'),
        )
        .join('\n');
      expect(neu, meldung).toEqual([]);
    });
  }
}

