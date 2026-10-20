import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Overview, PortfolioKpi } from '../src/api';
import { ahrenbergHeute, ahrenbergUnternehmen, FIXTURE_IDS } from '../src/test/standorteFixtures';

/**
 * Der Boot-Ablauf der SCHALE (nach der Keycloak-Anmeldung): `/tenant-context`,
 * `/sites`, `/devices`. Genau hier sass der falsche „Noch keine Anlage"-Blitz -
 * `UnifiedPortal` rendert vor der ersten Antwort mit `sites=[]`, und weil
 * `loaded` noch `false` ist, fiel es früher durch bis zum Leer-Zustand der
 * Landung, bevor Skelett und Inhalt kamen.
 *
 * Die Ehrlichkeitsregel des Hauses: „Fehlend ist keine Null" - ein
 * „noch keine …"-Leer-Zustand darf erst nach einer ERFOLGREICHEN Antwort
 * erscheinen. Bis dahin trägt der Marken-Lade-Moment (`VpLoader`) die Zeit.
 */

// Nachweis-Fotos: ohne `BOOT_FLOW_NACHWEISE` in den Ausgabeordner des Tests - ein fester Pfad
// eines anderen Rechners liesse jeden Fall an `page.screenshot` scheitern.
function nachweis(info: TestInfo, datei: string): string {
  const ordner = process.env.BOOT_FLOW_NACHWEISE;
  return ordner ? `${ordner}/nachher/${datei}` : info.outputPath(datei);
}

/** Eine plausible, vollständige Anlage - der Inhalt kommt aus diesem Mock. */
const site = {
  id: '10000000-0000-0000-0000-000000000001',
  name: 'Sonnenhof',
  biddingZone: 'DE-LU',
  latitude: 49.2,
  longitude: 12.8,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  gridChargingEnabled: false,
};

const device = {
  id: '20000000-0000-0000-0000-000000000001',
  siteId: site.id,
  name: 'Wechselrichter',
  lastSeenAt: new Date().toISOString(),
};

/**
 * Der DATEN-Boot wird verzögert, damit die Lücke sichtbar wird, die in
 * Produktion (echte Latenz) von selbst entsteht. Lokal ist alles schneller -
 * die Drosselung macht denselben Fehlerpfad reproduzierbar.
 */
async function mockBoot(
  page: Page,
  opts: {
    sites: unknown[];
    devices: unknown[];
    delayMs: number;
    tenants?: unknown[];
    // Lässt den Sites-Abruf mit diesem HTTP-Status scheitern (z. B. 500/401) -
    // der initiale Ladefehler, der NICHT als leeres Konto durchgehen darf.
    failSites?: number;
    // Plattform-Konto mit gewähltem Mandanten (UEMS-Selbstauskunft `konto: plattform`).
    admin?: boolean;
    // UEMS-Ortsstruktur des Referenzunternehmens (zwei Standorte), Werk Ahrenberg misst: die Landung ist die
    // Unternehmens-Übersicht. Seit K2 (PR #1482) ist sie das nur, wenn mindestens ein Standort misst. Die
    // Übersicht bekommt gültige Antworten, und was der Mock nicht kennt, gibt es nicht (404): eine Absage fängt
    // die Seite ab, an einem leeren `{}` wirft sie - der Fall prüfte dann den Satz der Fehlergrenze.
    orte?: boolean;
    // Die Anlagenliste (`/tenant-context`, `/sites`, `/devices`) kommt erst, wenn der Fall dieses Tor öffnet -
    // statt nach `delayMs`. So liegt ein Schritt des Falls sicher VOR der Anlagenliste.
    tor?: Promise<void>;
  },
) {
  const wait = () => opts.tor ?? new Promise<void>((r) => setTimeout(r, opts.delayMs));
  // ⚠ In Playwright gewinnt der ZULETZT registrierte Handler. Die Auffang-Route
  // (alle übrigen Anlagen-/Flotten-Reads fail-soft leer, damit der Test am
  // Boot-Fenster misst und nicht an den Innereien einer Seite) steht deshalb
  // ZUERST; die konkreten, verzögerten Routen kommen danach.
  await page.route('**/api/v1/**', async (route) => {
    if (opts.orte) {
      await route.fulfill({ status: 404, json: { message: 'nicht da' } });
      return;
    }
    const url = route.request().url();
    const body = /\/(sites|devices|components|entities|candidates|tenants|runs|releases)(\b|\/|\?|$)/.test(url)
      ? '[]'
      : '{}';
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  await page.route('**/api/v1/admin/tenants', (route) =>
    route.fulfill({ json: opts.tenants ?? [{ id: 't-1', name: 'Demo GmbH' }] }),
  );
  // UEMS: die Schale liest zuerst die Selbstauskunft (`/me`, AP-03) - ein Konto mit Unternehmenssicht, sonst
  // stünde „Kein Standort zugewiesen“ statt der Landung. Ohne Ortsstruktur (`/standorte` 404 = älteres Backend)
  // bleibt die Startansicht „wie heute“.
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: selbstauskunft(opts.admin === true, opts.orte === true) }));
  await page.route('**/api/v1/standorte**', (route) => route.fulfill({ status: 404, json: { message: 'nicht da' } }));
  if (opts.orte) {
    await page.route('**/api/v1/standorte', (route) => route.fulfill({ json: ahrenbergHeute() }));
    await page.route('**/api/v1/unternehmen', (route) => route.fulfill({ json: ahrenbergUnternehmen() }));
    await page.route('**/api/v1/portfolio/kpis', (route) => route.fulfill({ json: kpisOhneGrundlage() }));
    await page.route('**/api/v1/overview', (route) => route.fulfill({ json: uebersicht(opts.sites as { id: string; name: string }[]) }));
  }
  // Die Funktionen (AP-01): niemand misst oder steuert schon - die Anlege-Wege bleiben wie bisher. Mit `orte`
  // misst Werk Ahrenberg: erst dann ist die Unternehmensebene die Landung (K2, `ebenenNav.ts misst()`).
  await page.route('**/api/v1/funktionen', (route) =>
    route.fulfill({
      json: {
        unternehmen: {
          messen: { laeuft_an: opts.orte ? 1 : 0, standorte: opts.orte ? 2 : 0, text: null },
          steuern: { laeuft_an: 0, standorte: opts.orte ? 2 : 0, text: null },
        },
        standorte: opts.orte
          ? [
              {
                id: FIXTURE_IDS.st1,
                kurzzeichen: 'ST-1',
                name: 'Werk Ahrenberg',
                zeitzone: 'Europe/Berlin',
                messen: { zustand: 'aktiv', seit: '2026-10-01T00:00:00+02:00', text: 'Eingerichtet am 01.10.2026', fehlt: [], datenlage: null },
                steuern: { zustand: 'kein_objekt', seit: null, text: 'Steuern & Optimieren — noch nicht eingerichtet', fehlt: [], aktionen: ['einrichten'], anlagen: [] },
              },
            ]
          : [],
      },
    }),
  );
  await page.route('**/api/v1/tenant-context', async (route) => {
    await wait();
    await route.fulfill({ json: { tenantId: 't-1', name: 'Demo', segment: 'B2C', betriebsart: null } });
  });
  await page.route('**/api/v1/sites', async (route) => {
    await wait();
    if (opts.failSites) {
      await route.fulfill({
        status: opts.failSites,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'boom' }),
      });
      return;
    }
    await route.fulfill({ json: sichtbar(opts.sites) });
  });
  await page.route('**/api/v1/devices', async (route) => {
    await wait();
    await route.fulfill({ json: sichtbar(opts.devices) });
  });
}

/** UEMS AP-03 IP-10: Anlagen- und Gerätelisten kommen als sichtbare Liste mit Teilansicht. */
function sichtbar(eintraege: unknown[]) {
  return { eintraege, teilansicht: { sichtbar: eintraege.length, gesamt: eintraege.length } };
}

/** Die Selbstauskunft eines Kontos, das das ganze Unternehmen sieht (keine Teilansicht); mit `orte` beide Standorte. */
function selbstauskunft(admin: boolean, orte = false) {
  const standorte = orte
    ? ahrenbergHeute().standorte.map((st) => ({
        id: st.id, kennzeichen: st.kurzzeichen, name: st.name, rollen: ['kundenadministrator'], umfang: null, rechte: ['anlage.verwalten'],
      }))
    : [];
  return {
    kennung: 'e2e', name: 'Alex Beispiel', konto: admin ? 'plattform' : 'benutzer', zustand: 'aktiv',
    kundenbereich: { id: 't-1', name: 'Demo' }, zugang: admin ? 'umschalter' : 'konto', rollen: ['kundenadministrator'],
    unternehmensweit: true, standorte, unternehmen_rechte: ['anlage.verwalten'], kuenftig: [], text: null,
    teilansicht: null, unterstuetzungen: { eigene: [], gewaehrte: [] }, kundenadministratoren: [],
  };
}

/** Das Kachelraster der Unternehmens-Übersicht für den letzten vollen Monat, noch ohne Messwerte und Tarif. */
function kpisOhneGrundlage(): PortfolioKpi {
  const heute = new Date();
  const bis = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), 1) - 86_400_000);
  const von = new Date(Date.UTC(bis.getUTCFullYear(), bis.getUTCMonth(), 1));
  return {
    periode: { von: von.toISOString().slice(0, 10), bis: bis.toISOString().slice(0, 10), jahr: bis.getUTCFullYear(), monat: bis.getUTCMonth() + 1 },
    verbrauch: { kwh: null, kwh_vorjahr: null, vollstaendig: true },
    kosten: { eur: null, eur_vorjahr: null, tarif_hinterlegt: false },
    lastspitze: { kw: null, vereinbart_kw: null, anteil_prozent: null, anlage: null, zeitpunkt: null, zeitraum: null },
    datenlage: null,
    leit: null,
  };
}

/** `GET /overview`: je Anlage eine Zeile, Gerät verbunden, noch ohne Momentaufnahme. */
function uebersicht(anlagen: { id: string; name: string }[]): Overview {
  return {
    sites: anlagen.map((a) => ({
      id: a.id, name: a.name, plantKind: 'eigenverbrauch', netzladenErlaubt: false, batteryWithoutDevice: false,
      deviceCount: 1, onlineCount: 1, waitingCount: 0, worstStatus: 'online', lastSeenAt: new Date().toISOString(),
      live: null, plannedSavingsTodayEur: null,
    })),
    totals: { sites: anlagen.length, devices: anlagen.length, online: anlagen.length, plannedSavingsTodayEur: null, liveSitesCovered: 0 },
    dailySavings: [],
  };
}

/** Öffnet der Fall selbst: `mockBoot({ tor })` hält die Anlagenliste zurück, bis `auf()` gerufen ist. */
function tor(): { zu: Promise<void>; auf: () => void } {
  let auf = () => {};
  const zu = new Promise<void>((r) => { auf = r; });
  return { zu, auf };
}

/**
 * Hält die Uhr der Seite an und lässt erst DANACH die Anlagenliste durch. Die 3-s-Grenze der Lade-Bühne ist ein
 * Zeitgeber der Seite, der mit der Anlagenliste startet: bei stehender Uhr löst er nie aus. Beginnt die Bühne
 * trotzdem zu gehen, hat jemand das erste Bild gemeldet - gleich, wie lange der Dev-Server für die Module der Seite
 * braucht. Vorher `page.clock.install()` rufen (vor `goto`).
 *
 * ⚠ Die Reihenfolge trägt den Fall: `pauseAt` springt vor und löst dabei fällige Zeitgeber EINMAL aus. Liefe die
 * 3-s-Grenze schon, ginge die Bühne durch diesen Sprung - darum kommt die Anlagenliste erst nach dem Anhalten.
 */
async function uhrAnhaltenDannAnlagenliste(page: Page, anlagenliste: { auf: () => void }) {
  // Die Bühne steht schon: der Start des Portals lief mit laufender Uhr.
  await expect(page.locator('.vp-loader-screen')).toBeVisible();
  await page.clock.pauseAt(new Date(Date.now() + 60_000));
  anlagenliste.auf();
}

/**
 * Die Bühne beginnt zu gehen (`is-leaving`). Bei stehender Uhr bleibt dieser Zustand stehen, bis der Fall die Uhr
 * um die Ausblendung weiterdreht - dann ist die Bühne fort. Die Frist ist Geduld mit dem Dev-Server (er liefert die
 * Module der Landeseite einzeln aus), keine Messgrenze: ohne Meldung käme der Zustand nie.
 */
async function buehneGehtDurchMeldung(page: Page) {
  await expect(page.locator('.vp-loader-screen.is-leaving')).toBeVisible({ timeout: 20_000 });
  await page.clock.runFor(500);
  await expect(page.locator('.vp-loader-screen')).toHaveCount(0);
}

/** Der Marken-Lade-Moment ist als EIN Statusbereich ausgewiesen. */
function loader(page: Page) {
  return page.locator('[data-vp-loader]');
}

const FALSCHER_LEERTEXT = /Noch keine Anlage|Willkommen bei VoltPilot|noch keine Anlage/;

test.describe('Boot-Ablauf · kein Leer-Zustand vor der ersten Antwort', () => {
  test('Kunde mit Anlage: Marken-Lader statt „Noch keine Anlage"', async ({ page }, info) => {
    await mockBoot(page, { sites: [site], devices: [device], delayMs: 1500 });
    await page.goto('/e2e/boot-flow.html');

    // Im Boot-Fenster (Antwort steht aus): der Marken-Lader trägt die Zeit …
    await expect(loader(page)).toBeVisible();
    // … und der Leer-Zustand darf zu KEINEM Zeitpunkt behauptet werden.
    await expect(page.getByText(FALSCHER_LEERTEXT)).toHaveCount(0);
    await page.screenshot({ path: nachweis(info, `kunde-lader-${info.project.name}.png`) });

    // Nach der Antwort verschwindet der Lader und der echte Inhalt kommt -
    // der falsche Leertext ist nie erschienen.
    await expect(loader(page)).toHaveCount(0, { timeout: 8000 });
    await expect(page.getByText(FALSCHER_LEERTEXT)).toHaveCount(0);
  });

  test('leeres Mandanten-Konto (Admin): Lader zuerst, Leer-Zustand ERST nach der Antwort', async ({
    page,
  }, info) => {
    await mockBoot(page, { sites: [], devices: [], delayMs: 1500, admin: true });
    await page.goto('/e2e/boot-flow.html?admin=1&tenant=t-1#/uebersicht');

    // Boot-Fenster: Lader sichtbar, Leer-Zustand NOCH NICHT.
    await expect(loader(page)).toBeVisible();
    await expect(page.getByText(/noch keine Anlage/i)).toHaveCount(0);
    await page.screenshot({ path: nachweis(info, `leer-lader-${info.project.name}.png`) });

    // Nach der (erfolgreichen, leeren) Antwort: der ehrliche Leer-Zustand.
    await expect(
      page.getByRole('heading', { name: 'Dieser Mandant hat noch keine Anlage' }),
    ).toBeVisible({ timeout: 8000 });
    await expect(loader(page)).toHaveCount(0);
  });
});

/**
 * ⚠ SOLLTE-4-WÄCHTER: die drei Ränder des Boot-Covers, die der Review nachgezogen
 * sehen wollte - der Ladefehler, die reduzierte Bewegung und die Unterseite, die
 * NICHT meldet. Alle drei am echten `App` über das Boot-Harness (Netzrand
 * gemockt), nicht am Einzelbaustein.
 */
test.describe('Boot-Cover · Ränder', () => {
  test('Sites-Abruf scheitert (500): ehrliche Fehlerkarte, KEIN endloser Lader', async ({
    page,
  }, info) => {
    await mockBoot(page, { sites: [], devices: [], delayMs: 300, failSites: 500 });
    await page.goto('/e2e/boot-flow.html');

    // Im Boot-Fenster trägt der Marken-Lader die Zeit …
    await expect(loader(page)).toBeVisible();

    // … doch nach dem Fehler kommt die EHRLICHE Fehlerkarte (kein „Willkommen"/
    // Leer-Zustand über einer Störung, M2) - und der Lader steht NICHT endlos.
    await expect(
      page.getByRole('heading', { name: 'Daten konnten nicht geladen werden' }),
    ).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.vp-loader-screen')).toHaveCount(0);
    await expect(loader(page)).toHaveCount(0);
    await expect(page.getByText(FALSCHER_LEERTEXT)).toHaveCount(0);
    await page.screenshot({ path: nachweis(info, `sites-500-fehlerkarte-${info.project.name}.png`) });
  });

  test('reduzierte Bewegung: Ringe ruhen, der Lader trägt die Zeit ehrlich, dann Inhalt', async ({
    page,
  }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockBoot(page, { sites: [site], devices: [device], delayMs: 900 });
    await page.goto('/e2e/boot-flow.html');

    // Der Lader ist als Statusbereich da (kein Leer-Zustand vor der Antwort) …
    await expect(loader(page)).toBeVisible();
    await expect(page.getByText(FALSCHER_LEERTEXT)).toHaveCount(0);
    // … und die Puls-Ringe RUHEN (der EINE `prefers-reduced-motion`-Schalter):
    // computed `animation-name` ist `none`, ein leiser Halo bleibt.
    const ringAnim = await page
      .locator('.vp-loader-screen .vp-loader-ring.r1')
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(ringAnim, 'die Ringe müssen unter reduzierter Bewegung ruhen').toBe('none');
    await page.screenshot({ path: nachweis(info, `reduced-motion-lader-${info.project.name}.png`) });

    // Nach der Antwort kommt der Inhalt, der Lader hebt ab, kein falscher Leertext.
    await expect(loader(page)).toHaveCount(0, { timeout: 8000 });
    await expect(page.getByText(FALSCHER_LEERTEXT)).toHaveCount(0);
  });

  test('Deep-Link auf eine Portfolio-Unterseite: der Cover hebt bei `loaded` ab, nicht erst an der 3-s-Grenze', async ({
    page,
  }) => {
    // Eine Unterseite (`portfolio-messwerte`) MELDET kein erstes Bild
    // (`useReportFirstPaint`). Ohne die `isReportingLanding`-Grenze hinge der
    // Cover bis zur 3-s-Sicherheitsgrenze unter fertigem Inhalt (Review SOLLTE-2);
    // mit ihr hebt er ab, sobald die Anlagenliste da ist (`loaded`).
    // ⚠ ZWEI Anlagen: mit nur einer lenkt `canonicalShellRoute` einen Admin von jeder Flottenseite auf die
    // (meldende) Übersicht - dann mäße der Fall die Übersicht, nicht die Unterseite (Nachzug main → uems 1a).
    const zweite = { ...site, id: '10000000-0000-0000-0000-000000000002', name: 'Waldblick' };
    await mockBoot(page, { sites: [site, zweite], devices: [device], delayMs: 400, admin: true });
    await page.goto('/e2e/boot-flow.html?admin=1&tenant=t-1#/portfolio/messwerte');
    // Die Uhr läuft ab dem geladenen Dokument: den Seitenaufbau des Dev-Servers (unter zwei Workern über 1 s für
    // das UEMS-Bündel) misst der Fall nicht - die 3-s-Grenze zählt ohnehin erst ab der Anlagenliste.
    const t0 = Date.now();

    // Der Cover erscheint im Boot-Fenster …
    await expect(page.locator('.vp-loader-screen')).toBeVisible();
    // … und ist deutlich VOR der 3-s-Grenze wieder weg (er wartete auf `loaded`,
    // nicht auf die Sicherheitsgrenze). Die Übergabe kostet die Ausblendzeit -
    // 2,5 s trennt sauber von 3 s + Latenz.
    await expect(page.locator('.vp-loader-screen')).toHaveCount(0, { timeout: 2500 });
    await expect(page).toHaveURL(/#\/portfolio\/messwerte$/);
    const dt = Date.now() - t0;
    expect(dt, `der Cover hing ${dt} ms - Verdacht auf die 3-s-Grenze`).toBeLessThan(2500);
  });

  test('UEMS-Übersicht (Unternehmensebene): der Cover hebt mit ihrem ersten Bild ab, nicht an der 3-s-Grenze', async ({
    page,
  }) => {
    // Die Landung eines Kunden mit zwei Standorten ist die Unternehmens-Übersicht (`EbenenCockpit`). Sie muss ihr
    // erstes Bild melden wie das Portfolio-Cockpit - sonst hängt der Cover bei JEDER Anmeldung bis zur 3-s-Grenze und
    // zeigt ab 2,2 s „Das dauert gerade etwas länger als sonst …“ über fertigem Inhalt.
    // Ohne Stoppuhr: am Dev-Server holt der Browser nach der Anlagenliste erst die Module der Übersicht, eine
    // Zeitgrenze mäße ihn und nicht die Bühne. Stattdessen steht die Uhr der Seite - die 3-s-Grenze kann nicht greifen.
    const anlagen = [FIXTURE_IDS.an1, FIXTURE_IDS.an2, FIXTURE_IDS.an3].map((id, i) => ({ ...site, id, name: `Anlage ${i + 1}` }));
    const geraete = anlagen.map((a, i) => ({ ...device, id: `20000000-0000-0000-0000-00000000000${i + 1}`, siteId: a.id }));
    const anlagenliste = tor();
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(String(e)));
    await page.clock.install();
    await mockBoot(page, { sites: anlagen, devices: geraete, delayMs: 0, orte: true, tor: anlagenliste.zu });
    // Das Kachelraster der Unternehmens-Übersicht fragt seine Kennzahlen an: die Landung IST das EbenenCockpit.
    const kpis = page.waitForRequest('**/api/v1/portfolio/kpis');
    await page.goto('/e2e/boot-flow.html');
    await uhrAnhaltenDannAnlagenliste(page, anlagenliste);
    await buehneGehtDurchMeldung(page);
    await kpis;
    await expect(page).toHaveURL(/#\/portfolio$/);
    // Unter der Bühne steht die Seite, nicht der Satz der Fehlergrenze.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('fehlergrenze')).toHaveCount(0);
    expect(fehler).toEqual([]);
  });

  test('Landeseite scheitert beim Zeichnen: der Cover hebt mit dem Satz der Fehlergrenze ab, nicht an der 3-s-Grenze', async ({
    page,
  }) => {
    // Wirft die Landeseite, bevor sie ihr erstes Bild gemeldet hat, meldet sie nie mehr - an ihrer Stelle steht der
    // Satz der Fehlergrenze. Die Grenze meldet ihn der Bühne als erstes Bild; sonst stünde die Bühne volle drei
    // Sekunden über dem Satz. Auch hier steht die Uhr der Seite: nur eine Meldung lässt die Bühne gehen.
    const anlagen = [FIXTURE_IDS.an1, FIXTURE_IDS.an2, FIXTURE_IDS.an3].map((id, i) => ({ ...site, id, name: `Anlage ${i + 1}` }));
    const geraete = anlagen.map((a, i) => ({ ...device, id: `20000000-0000-0000-0000-00000000000${i + 1}`, siteId: a.id }));
    const anlagenliste = tor();
    const overview = tor();
    await page.clock.install();
    await mockBoot(page, { sites: anlagen, devices: geraete, delayMs: 0, orte: true, tor: anlagenliste.zu });
    // Die Kennzahlen kommen ohne die zugesagten Felder: daran wirft das Kachelraster. `/overview` (mit ihm meldete
    // die Übersicht ihr erstes Bild) steht bis zum Ende des Falls aus - der Fehler kommt sicher VOR jeder Meldung.
    await page.route('**/api/v1/portfolio/kpis', (route) => route.fulfill({ json: {} }));
    await page.route('**/api/v1/overview', async (route) => {
      await overview.zu;
      await route.fulfill({ json: uebersicht(anlagen) });
    });
    await page.goto('/e2e/boot-flow.html');
    await uhrAnhaltenDannAnlagenliste(page, anlagenliste);
    await buehneGehtDurchMeldung(page);
    // Unter der Bühne steht der Satz an der Stelle der Seite; Kopf und Navigation bleiben.
    await expect(page.getByTestId('fehlergrenze')).toBeVisible();
    await expect(page.getByRole('navigation').first()).toBeVisible();
    await expect(page).toHaveURL(/#\/portfolio$/);
    overview.auf();
  });

  test('Deep-Link auf einen Reiter der Anlage: der Cover hebt bei `loaded` ab, nicht erst an der 3-s-Grenze', async ({
    page,
  }) => {
    // Nur die Anlage selbst (ohne Reiter) meldet ihr erstes Bild; ein Reiter wie „Messwerte“ meldet nicht.
    const zweite = { ...site, id: '10000000-0000-0000-0000-000000000002', name: 'Waldblick' };
    await mockBoot(page, { sites: [site, zweite], devices: [device], delayMs: 400, admin: true });
    await page.goto(`/e2e/boot-flow.html?admin=1&tenant=t-1#/anlage/${site.id}/messwerte`);
    await expect(page.locator('.vp-loader-screen')).toBeVisible();
    // Keine Dauer am Dev-Server messen (er liefert jedes Modul einzeln, unter Last
    // hing der Fall auch auf main bei 3 s): die Uhr der Seite steht, also KANN die
    // 3-s-Grenze den Cover nicht heben. Geht er trotzdem, hat ihn `loaded` gehoben.
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await buehneGehtDurchMeldung(page);
    await expect(page).toHaveURL(new RegExp(`#/anlage/${site.id}/messwerte$`));
  });

  test('Einmal gehoben, kehrt der Cover nicht zurück: nach einem Deep-Link auf eine Unterseite auch nicht auf der Übersicht', async ({
    page,
  }) => {
    const zweite = { ...site, id: '10000000-0000-0000-0000-000000000002', name: 'Waldblick' };
    await mockBoot(page, { sites: [site, zweite], devices: [device], delayMs: 400, admin: true });
    await page.goto('/e2e/boot-flow.html?admin=1&tenant=t-1#/portfolio/messwerte');
    await expect(page.locator('.vp-loader-screen')).toHaveCount(0, { timeout: 2500 });
    // Ab jetzt jedes Auftauchen der Lade-Bühne mitschreiben - auch ein Aufblitzen für die Dauer der Ausblendung.
    await page.evaluate(() => {
      const w = window as unknown as { __buehne: number };
      w.__buehne = 0;
      new MutationObserver(() => {
        if (document.querySelector('.vp-loader-screen')) w.__buehne += 1;
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.evaluate(() => {
      window.location.hash = '#/portfolio';
    });
    await expect(page).toHaveURL(/#\/portfolio$/);
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => (window as unknown as { __buehne: number }).__buehne), 'die Lade-Bühne kam zurück').toBe(0);
  });
});
