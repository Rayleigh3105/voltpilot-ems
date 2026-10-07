import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { grenzHinweisZeigt } from './grenzHinweis';

/**
 * „Unternehmen › Energiemanagement“ (UEMS AP-19 IP-9) bei 375 px und 1440 px auf der eigenen Bühne
 * `e2e/energiemanagement.html` — die ECHTE Schale mit der ECHTEN Leiste und den ECHTEN Reitern, die Routen von
 * IP-6/IP-7/IP-8 gespielt aus dem Referenzunternehmen 1.10 (`src/test/energiemanagementFixtures.ts`, R1–R3).
 *
 * Fälle: Anlegen → Fassung → Freigabe mit „entschieden von“ → Überblick und Verzeichnis (R1, mit Person anlegen als
 * Leitung) · Verweis-Fassung (R7-Muster): nur die Prüfsumme geht hinaus · Stand 12.02.2029 (R1–R3): Überblick mit dem
 * Blatt einer Gruppe, Verzeichnis nach Monaten, „Meine“, CSV, Überprüfung, Vergleich, Zuschnitt-Hilfe (Konzept
 * Nachweisen n1: der Überblick ist der erste Reiter, das Verzeichnis liegt eine Ebene tiefer).
 *
 * NETZWERK-PROBE: jede Anfrage außer GET wird mitgeschrieben, und die Bühne legt jeden Schreib-Körper an der Grenze zur
 * Route in `window.__emGesendet` ab. Geprüft wird: der Datei-Inhalt steht in KEINER Anfrage und in KEINEM Körper; der
 * Verweis trägt genau die Felder des Vertrags; seine Prüfsumme ist die SHA-256 des Inhalts, hier in Node nachgerechnet.
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente je Schritt. Mit `ENERGIEMANAGEMENT_BILDER=<Ordner>` legt
 * der Lauf je Schritt ein Bild ab — die Ansicht. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.ENERGIEMANAGEMENT_BILDER;
const AM_15_12_2026 = new Date('2026-12-15T10:00:00+01:00');
const AM_12_11_2028 = new Date('2028-11-12T10:00:00+01:00');
const AM_12_02_2029 = new Date('2029-02-12T14:00:00+01:00');
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const VERANTWORTUNG =
  'Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen. VoltPilot hält fest, wer was wann entschieden hat, und beurteilt nicht, ob Ihr Energiemanagement genügt.';
const LEER = 'Hier ist noch nichts festgehalten.';
const OHNE_LEITUNG =
  'Diese Fassung braucht eine Entscheidung der Leitung. Für die Aufgabe ‚Leitung des Unternehmens‘ ist keine Person festgelegt.';
const PRUEFSUMME_SATZ = 'Die Prüfsumme wird in Ihrem Browser gebildet; die Datei verlässt Ihren Rechner nicht.';
const POLITIK =
  'Die Kunststoffwerk Ahrenberg GmbH will ihren Energieeinsatz in beiden Werken kennen und ihre energiebezogene Leistung Jahr für Jahr verbessern.';
const VERWEIS_FELDER = ['ablage', 'adresse', 'bezeichnung', 'datum', 'fassungsangabe', 'kennung', 'sha256'];

async function oeffne(page: Page, query: string, breite: number, jetzt: Date) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/energiemanagement.html?${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *, .vp-modal *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs') && !(e instanceof HTMLInputElement && e.type === 'file'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    const reiter = [...document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')]
      .filter((t) => sichtbar(t))
      .map((t) => (t.textContent ?? '').trim());
    return { route: document.body.dataset.route ?? null, dokument: doc.scrollWidth - doc.clientWidth, ueberstehend: [...new Set(ueberstehend)], reiter };
  });
}

function ohneQuerlauf(m: Awaited<ReturnType<typeof messe>>, fall: string) {
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
}

async function ablegen(page: Page, name: string, ganz = false) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const path = join(BILDER, `${name}.png`);
  const vp = page.viewportSize();
  // Ein hohes Fenster statt `fullPage` — sonst stünde die feste Leiste mitten im Bild (AP-18 IP-13).
  if (ganz && vp) {
    const hoehe = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.querySelector('.vp-main')?.scrollHeight ?? 0));
    await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, hoehe) });
    await page.screenshot({ path });
    await page.setViewportSize(vp);
    return;
  }
  await page.screenshot({ path });
}

/** Ein Dialog als Bild: das Fenster so hoch wie der Dialog, damit er ganz zu sehen ist. */
async function dialogBild(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const vp = page.viewportSize()!;
  // Das Fenster so hoch, dass der Dialog nicht mehr in sich scrollt; dann ruhig (ohne Übergang) als Element fotografieren.
  const zuviel = await page.evaluate(() =>
    Math.max(0, ...[...document.querySelectorAll<HTMLElement>('.vp-modal *')].map((e) => e.scrollHeight - e.clientHeight).filter((d) => d > 1)),
  );
  await page.setViewportSize({ width: vp.width, height: vp.height + zuviel + 40 });
  await page.waitForTimeout(300);
  await modal(page).screenshot({ path: join(BILDER, `${name}.png`), animations: 'disabled' });
  await page.setViewportSize(vp);
}

async function waehle(page: Page, feld: Locator, option: RegExp) {
  await feld.click();
  const id = await feld.getAttribute('id');
  await page.locator(`[id="${id}-liste"]`).getByRole('option', { name: option }).click();
}

const modal = (page: Page) => page.locator('.vp-modal').last();
const gesendet = (page: Page) => page.evaluate(() => (window as unknown as { __emGesendet: { route: string; koerper: unknown }[] }).__emGesendet);
const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');

for (const breite of [375, 1440]) {
  test.describe(`Energiemanagement bei ${breite} px`, () => {
    test('R1: Anlegen → Fassung → Freigabe mit „entschieden von“ (Leitung neu angelegt) → Verzeichnis; nur die Prüfsumme geht hinaus', async ({ page }) => {
      const anfragen: string[] = [];
      page.on('request', (r) => {
        if (r.method() !== 'GET') anfragen.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`);
      });
      await oeffne(page, 'lage=start', breite, AM_15_12_2026);
      const bereich = page.getByTestId('energiemanagement-bereich');
      // Konzept Nachweisen n1 (Entscheid 2): der Überblick ist der erste Reiter; bei einem neuen Kunden ist die Energiepolitik
      // offen und der nächste Schritt (§6.13).
      await expect(bereich.getByRole('heading', { level: 1 })).toHaveText('Überblick');
      await expect(page.getByTestId('energiemanagement-reiter-ueberblick')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('zaehler-offen')).toHaveText(/^\d+Teile offen$/);
      const offenVorher = Number((await page.getByTestId('zaehler-offen').textContent())!.match(/^\d+/)![0]);
      await expect(page.getByTestId('teil-chip-energiepolitik')).toHaveClass(/is-offen/);
      await expect(page.getByTestId('ueberblick-naechstes')).toContainText('Energiepolitik festhalten');
      await grenzHinweisZeigt(page, GRENZE, VERANTWORTUNG);
      const m0 = await messe(page);
      expect(m0.reiter).toEqual(expect.arrayContaining(['Überblick', 'Dokumente']));
      expect(m0.reiter.indexOf('Überblick')).toBeLessThan(m0.reiter.indexOf('Dokumente'));
      expect(m0.reiter).not.toContain('Verzeichnis');
      // K1/D2: die Reiter der Gruppe „Nachweisen“ sind die des Energiemanagements und die Berichte. N1: die Gruppe selbst
      // steht am Rechner in der Seitenleiste, nicht als Reiter.
      if (breite >= 720) await expect(page.getByTestId('seitenleiste-nachweisen')).toHaveAttribute('aria-current', 'page');
      expect(m0.reiter).not.toContain('Nachweisen');
      expect(m0.reiter).not.toContain('Energiemanagement');
      ohneQuerlauf(m0, 'Überblick leer');
      await ablegen(page, `a-ueberblick-leer-${breite}`);

      // Konzept Nachweisen n1, Runde 2 (§6.5, §6.10): Festhalten in drei Schritten - Art, wo es geführt wird, Text;
      // Prüfen mit „Gleich freigeben“. Bei der Energiepolitik entscheidet die Leitung - ohne Leitung sagt das Blatt, warum,
      // und bietet „Person anlegen“ an (PA3). Das unterschriebene Original gehört zur Fassung (Entscheid 10).
      await page.getByTestId('energiemanagement-reiter-dokumente').click();
      await expect(page.getByTestId('dokumente-status')).toHaveText('Noch kein Dokument festgehalten.');
      expect(await page.evaluate(() => location.hash)).toBe('#/portfolio/energiemanagement/dokumente');
      await page.getByTestId('dokumente-kopf').getByRole('button', { name: 'Weitere Aktionen' }).click();
      await page.getByRole('menuitem', { name: 'Dokument festhalten' }).click();
      const blatt = page.getByTestId('festhalten-blatt');
      await waehle(page, blatt.getByRole('combobox', { name: 'Was?' }), /^Energiepolitik/);
      await expect(page.getByTestId('festhalten-titel')).toHaveValue('Energiepolitik');
      await expect(page.getByTestId('festhalten-wo-wortlaut').getByRole('radio')).toBeChecked();
      ohneQuerlauf(await messe(page), 'Festhalten: was und wo');
      await dialogBild(page, `b-festhalten-${breite}`);
      await page.getByTestId('festhalten-weiter').click();
      await page.getByTestId('festhalten-text').fill(POLITIK);
      await page.getByTestId('festhalten-weiter').click();
      await expect(blatt.getByTestId('freigabe-ohne-leitung')).toHaveText(OHNE_LEITUNG);
      ohneQuerlauf(await messe(page), 'Festhalten ohne Leitung');
      await dialogBild(page, `d-festhalten-ohne-leitung-${breite}`);
      await blatt.getByTestId('freigabe-person-anlegen').click();
      const personDialog = page.getByTestId('person-dialog');
      await personDialog.getByLabel('Name').fill('Robert Falk');
      await personDialog.getByLabel('Funktion').fill('Geschäftsführer');
      await personDialog.getByLabel('Kürzel · wahlfrei').fill('RF');
      await expect(personDialog.getByTestId('person-leitung-ja')).toHaveCount(0);
      await personDialog.getByLabel('Warum?').fill('Geschäftsführer der Kunststoffwerk Ahrenberg GmbH.');
      ohneQuerlauf(await messe(page), 'Person anlegen');
      await page.getByTestId('person-senden').click();
      await expect(personDialog).toBeHidden();
      // Die neue Person ist gewählt und steht als Prüfzeile „Entschieden“ (Review r1, P2-1: das Absenden von „Person
      // anlegen“ erreicht das Blatt darunter nicht mehr).
      await expect(blatt.getByTestId('festhalten-pruefen')).toContainText('Robert Falk · 15.12.2026');
      await page.getByTestId('festhalten-original').click();
      await page.getByTestId(/-original-ablage$/).fill('QM-Laufwerk, Ordner Energiemanagement/Politik');
      await page.getByTestId(/-original-kennung$/).fill('EP-2026');
      const inhalt = `UNTERSCHRIEBENE-ENERGIEPOLITIK-${breite}-DIESER-INHALT-VERLAESST-DEN-RECHNER-NIE`;
      await blatt.locator('input[type="file"]').setInputFiles({ name: 'energiepolitik-2026.pdf', mimeType: 'application/pdf', buffer: Buffer.from(inhalt) });
      await expect(blatt.getByTestId('datei-pruefen')).toContainText('Prüfsumme festgehalten');
      ohneQuerlauf(await messe(page), 'Festhalten: prüfen');
      await dialogBild(page, `f-festhalten-pruefen-${breite}`);
      await page.getByTestId('festhalten-weiter').click();

      const seite = page.getByTestId('dokument-seite');
      await expect(seite.getByRole('heading', { level: 1 })).toHaveText('EnergiepolitikD-0001');
      await expect(page.getByTestId('dokument-status')).toHaveText('gilt· Robert Falk');
      await expect(page.getByTestId('dokument-stufen').getByRole('listitem')).toHaveText(['Entwurf15.12.2026', 'Freigegeben15.12.2026', 'Bekannt', 'Prüfenbis 15.12.2027']);
      await expect(page.getByTestId('zeile-original')).toContainText('QM-Laufwerk');
      await grenzHinweisZeigt(seite, VERANTWORTUNG);
      ohneQuerlauf(await messe(page), 'Dokument-Seite');
      await ablegen(page, `g-dokument-${breite}`, true);

      await seite.getByRole('button', { name: 'Alle Dokumente' }).click();
      await expect(page.getByTestId('dokument-zeile-D-0001')).toContainText('Energiepolitik');
      await expect(page.getByTestId('dokument-zeile-D-0001').getByRole('img')).toHaveAttribute('aria-label', 'bis 15.12.2027');
      // Im Überblick sind Energiepolitik und Aufgaben (die Leitung) festgehalten.
      await page.getByTestId('energiemanagement-reiter-ueberblick').click();
      await expect(page.getByTestId('zaehler-offen')).toHaveText(`${offenVorher - 2}Teile offen`);
      await expect(page.getByTestId('teil-chip-energiepolitik')).toHaveClass(/is-festgehalten/);
      // Das Verzeichnis liegt eine Ebene tiefer, im Menü des Überblicks.
      await page.getByTestId('ueberblick-kopf').getByRole('button', { name: 'Weitere Aktionen' }).click();
      await page.getByRole('menuitem', { name: 'Verzeichnis', exact: true }).click();
      expect(await page.evaluate(() => location.hash)).toBe('#/portfolio/energiemanagement/verzeichnis');
      const dezember = page.getByTestId('verzeichnis-monat-2026-12');
      await expect(dezember.getByRole('heading', { level: 2 })).toHaveText('Dezember 2026');
      await expect(dezember).toContainText('Leitung des Unternehmens: Robert Falk');
      const zeile = dezember.getByTestId('verzeichnis-eintrag').filter({ hasText: /^15\.12\.Energiepolitik/ });
      await expect(zeile).toContainText('RF');
      ohneQuerlauf(await messe(page), 'Verzeichnis');
      await ablegen(page, `h-verzeichnis-${breite}`, true);
      // Ein Eintrag zeigt Personen, Tag und Ort - und öffnet sein Dokument.
      await zeile.click();
      const eintrag = page.getByTestId('eintrag-blatt');
      await expect(eintrag).toContainText('Robert Falk');
      await expect(eintrag).toContainText('Ines Kaltenbach');
      await expect(eintrag).toContainText('15.12.2026');
      await expect(eintrag).toContainText('Wortlaut in VoltPilot, Original bei Ihnen: QM-Laufwerk, Ordner Energiemanagement/Politik');
      ohneQuerlauf(await messe(page), 'Eintrag');
      await ablegen(page, `h2-eintrag-${breite}`);
      await eintrag.getByRole('button', { name: 'Dokument öffnen' }).click();
      await expect(page.getByTestId('dokument-kopf')).toContainText('Fassung 1');

      // Netzwerk-Probe: der Inhalt stand in keiner Anfrage und in keinem Körper; gesendet wurde nur seine Prüfsumme.
      const koerper = await gesendet(page);
      expect(anfragen.filter((a) => a.includes(inhalt))).toEqual([]);
      expect(JSON.stringify(koerper)).not.toContain(inhalt);
      expect(koerper.map((k) => k.route.replace(/[0-9a-f-]{36}/g, '{id}'))).toEqual([
        'POST /api/v1/energiemanagement/personen',
        'POST /api/v1/energiemanagement/aufgaben',
        'POST /api/v1/energiemanagement/dokumente',
        'POST /api/v1/energiemanagement/dokumente/{id}/fassungen',
        'POST /api/v1/energiemanagement/dokumente/{id}/fassungen/1/freigeben',
      ]);
      const freigegeben = koerper[4].koerper as Record<string, unknown>;
      expect(freigegeben).toEqual({
        entschieden_von: expect.any(String), entschieden_am: null, begruendung: 'Erste Fassung festgehalten.',
        original: { ablage: 'QM-Laufwerk, Ordner Energiemanagement/Politik', bezeichnung: 'energiepolitik-2026.pdf', kennung: 'EP-2026', adresse: null, sha256: sha256(inhalt) },
      });
      expect((koerper[1].koerper as { aufgabe: string }).aufgabe).toBe('unternehmensleitung');
    });

    test('Verweis-Fassung (R7-Muster): Ablage, Kennung, Fassungsangabe und die Prüfsumme — die Datei verlässt den Rechner nicht', async ({ page }) => {
      const anfragen: string[] = [];
      page.on('request', (r) => {
        if (r.method() !== 'GET') anfragen.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`);
      });
      await oeffne(page, 'lage=start&seite=dokumente', breite, AM_12_11_2028);
      await page.getByTestId('dokumente-kopf').getByRole('button', { name: 'Weitere Aktionen' }).click();
      await page.getByRole('menuitem', { name: 'Dokument festhalten' }).click();
      const blatt = page.getByTestId('festhalten-blatt');
      await waehle(page, blatt.getByRole('combobox', { name: 'Was?' }), /^Betrieb und Instandhaltung/);
      await page.getByTestId('festhalten-titel').fill('Kriterien für Betrieb und Instandhaltung - Spritzguss');
      await expect(page.getByTestId('festhalten-wo-verweis').getByRole('radio')).toBeChecked();
      await page.getByTestId('festhalten-weiter').click();
      await page.getByTestId('festhalten-ablage').fill('Instandhaltungssystem, Arbeitspläne');
      await page.getByTestId('festhalten-kennung').fill('IH-SG-01');
      const inhalt = `ARBEITSPLAN-IH-SG-01-REV-4-${breite}-INHALT-BLEIBT-AUF-DEM-GERAET`;
      await blatt.locator('input[type="file"]').setInputFiles({ name: 'IH-SG-01_Rev4.pdf', mimeType: 'application/pdf', buffer: Buffer.from(inhalt) });
      await expect(blatt.getByTestId('datei-pruefen')).toContainText('Prüfsumme festgehalten');
      ohneQuerlauf(await messe(page), 'Verweis-Blatt');
      await dialogBild(page, `i-verweis-${breite}`);
      await page.getByTestId('festhalten-weiter').click();
      await expect(page.getByTestId('festhalten-pruefen')).toContainText('Instandhaltungssystem, Arbeitspläne · IH-SG-01');
      await page.getByTestId('festhalten-weiter').click();
      const original = page.getByTestId('dokument-original');
      await expect(original).toContainText('Instandhaltungssystem, Arbeitspläne');
      await expect(original).toContainText('IH-SG-01');
      await expect(page.getByTestId('dokument-status')).toHaveText('gilt· Ines Kaltenbach');
      ohneQuerlauf(await messe(page), 'Verweis-Seite');
      await ablegen(page, `j-verweis-seite-${breite}`, true);

      const koerper = await gesendet(page);
      expect(anfragen.filter((a) => a.includes(inhalt))).toEqual([]);
      expect(JSON.stringify(koerper)).not.toContain(inhalt);
      const entwurf = koerper.find((k) => k.route.endsWith('/fassungen'))!.koerper as { form: string; verweis: Record<string, unknown>; wortlaut?: unknown };
      expect(entwurf.form).toBe('verweis');
      expect(entwurf.wortlaut).toBeUndefined();
      expect(Object.keys(entwurf.verweis).sort()).toEqual(VERWEIS_FELDER);
      expect(entwurf.verweis).toMatchObject({ ablage: 'Instandhaltungssystem, Arbeitspläne', kennung: 'IH-SG-01', bezeichnung: 'IH-SG-01_Rev4.pdf', sha256: sha256(inhalt) });
    });

    test('Stand 12.02.2029 (R1–R3): Überblick, Verzeichnis nach Monaten, „Meine“, CSV, Überprüfung, Vergleich, Zuschnitt-Hilfe', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg', breite, AM_12_02_2029);
      // Offen sind die Teile ohne Eintrag; Risiken und Chancen etwa (Konzept n1, §6.3).
      await expect(page.getByTestId('teil-chip-risiken_chancen')).toHaveClass(/is-offen/);
      await page.getByRole('button', { name: /^Grundlagen:/ }).click();
      const grundlagen = page.getByTestId('gruppen-blatt');
      await expect(grundlagen.getByTestId('gruppen-teil-rechtliche_anforderungen')).toContainText('Fassung 1');
      await expect(grundlagen.getByTestId('gruppen-teil-risiken_chancen')).toContainText('Festhalten');
      ohneQuerlauf(await messe(page), 'Blatt Grundlagen');
      await ablegen(page, `k0-blatt-grundlagen-${breite}`);
      await page.keyboard.press('Escape');
      await expect(grundlagen).toBeHidden();
      ohneQuerlauf(await messe(page), 'Überblick 12.02.2029');
      await ablegen(page, `k-ueberblick-ahrenberg-${breite}`, true);

      await oeffne(page, 'lage=ahrenberg&seite=verzeichnis', breite, AM_12_02_2029);
      await expect(page.getByTestId('verzeichnis-eintrag').first()).toBeVisible();
      await expect(page.getByTestId('verzeichnis-monat-2026-12')).toContainText('Energiepolitik bekannt gemacht');
      await expect(page.getByTestId('verzeichnis')).toContainText('Rechtskataster');
      ohneQuerlauf(await messe(page), 'Verzeichnis 12.02.2029');
      await ablegen(page, `k2-verzeichnis-ahrenberg-${breite}`, true);

      await page.getByRole('button', { name: 'Meine', exact: true }).click();
      await expect(page.getByTestId('verzeichnis')).toContainText('Rechtskataster');
      await expect(page.getByTestId('verzeichnis-eintrag').filter({ hasText: /^15\.12\.Energiepolitik$/ })).toHaveCount(0);
      const download = page.waitForEvent('download');
      await page.getByTestId('verzeichnis-kopf').getByRole('button', { name: 'Weitere Aktionen' }).click();
      await page.getByRole('menuitem', { name: 'Als CSV abrufen' }).click();
      const datei = await (await download).path();
      const csv = readFileSync(datei!, 'utf8');
      expect(csv).toContain(VERANTWORTUNG);
      expect(csv).toContain('Gruppe;Art;Kennzeichen;Titel;Fassung oder Nr.;entschieden von;eingetragen von;Tag;Prüfsumme;Ort');
      expect(csv).toContain('D-0003');

      await oeffne(page, 'lage=ahrenberg&dok=1', breite, AM_12_02_2029);
      // Konzept Nachweisen n1, Runde 2 (§6.5): Status-Zeile statt Kopf-Satz; die Prüfung ist seit dem 10.12.2028 fällig.
      await expect(page.getByTestId('dokument-status')).toHaveText('Prüfung seit 10.12.2028· gilt');
      await expect(page.getByTestId('dokument-stufen').getByRole('listitem')).toHaveText(['Entwurf15.12.2026', 'Freigegeben15.12.2026', 'Bekannt18.12.2026', 'Prüfenseit 10.12.2028']);
      await expect(page.getByTestId('zeile-original')).toContainText('QM-Laufwerk');
      await page.getByTestId('zeile-fassungen').click();
      await expect(page.getByTestId('fassung-1')).toContainText('Fassung 1 · gilt');
      await page.keyboard.press('Escape');
      await page.getByTestId('zeile-original').click();
      await expect(page.getByTestId('original-zeilen')).toContainText('EP-2026');
      await page.keyboard.press('Escape');
      ohneQuerlauf(await messe(page), 'D-0001');
      await ablegen(page, `l-energiepolitik-${breite}`, true);

      await oeffne(page, 'lage=ahrenberg&dok=2', breite, AM_12_02_2029);
      await page.getByTestId('zeile-geltung').click();
      await expect(page.getByTestId('geltung-zeilen')).toContainText('Werk Ahrenberg, Werk Lindach');
      await expect(page.getByTestId('geltung-zeilen')).toContainText('deckungsgleich');
      await page.keyboard.press('Escape');
      ohneQuerlauf(await messe(page), 'D-0002');
      await ablegen(page, `m-anwendungsbereich-${breite}`, true);

      await oeffne(page, 'lage=ahrenberg', breite, AM_12_02_2029);
      await page.getByTestId('ueberblick-kopf').getByRole('button', { name: 'Weitere Aktionen' }).click();
      await page.getByRole('menuitem', { name: 'Was VoltPilot führt' }).click();
      const hilfe = page.getByTestId('zuschnitt-hilfe');
      await expect(hilfe.getByRole('heading', { level: 1 })).toHaveText('Was VoltPilot führt — was bei Ihnen liegt.');
      await expect(page.getByTestId('zuschnitt-teile').locator('tbody tr')).toHaveCount(16);
      await expect(page.getByTestId('zuschnitt-nachbarn').locator('tbody tr')).toHaveCount(4);
      await expect(hilfe.getByText(GRENZE)).toBeVisible();
      await expect(hilfe.getByText(VERANTWORTUNG)).toBeVisible();
      expect(await page.evaluate(() => location.hash)).toBe('#/portfolio/energiemanagement/zuschnitt');
      ohneQuerlauf(await messe(page), 'Zuschnitt-Hilfe');
      await ablegen(page, `n-zuschnitt-${breite}`, true);
      await page.getByTestId('zuschnitt-zurueck').click();
      await expect(page.getByTestId('nachweisen-ueberblick')).toBeVisible();
    });
  });
}
