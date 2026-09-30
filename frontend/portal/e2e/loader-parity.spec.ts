import { expect, test, type Page } from '@playwright/test';

/**
 * ⚠ DER DECKUNGSGLEICH-WÄCHTER (Feedback 5): der Inline-Lader (`index.html`
 * `#vp-boot-skeleton`) und der React-Lader (`VpLoaderScreen`) müssen am selben
 * Ort dasselbe zeigen - sonst SPRINGT der Übergang Inline → React sichtbar
 * (andere Wortmarke, fehlende Statuszeile, Versatz). Der Test misst beide
 * Geometrien gegeneinander: das Zeichen (die Pulse-Marke) und die vertikalen
 * Positionen von Wortmarke, Marke und Statuszeile sind schrift-UNABHÄNGIG
 * (feste Höhen, `line-height: 1`, reservierte Statuszeile) - sie müssen also
 * pixelnah übereinstimmen. Die Wortmarken-BREITE hängt an der Schrift und wird
 * bewusst nicht verglichen (der Inline-Lader misst hier ohne Bündel-Schriften);
 * ihre MITTE (Bühnen-Zentrum) und Höhe schon.
 */

type Box = { x: number; y: number; width: number; height: number };
const cx = (b: Box) => b.x + b.width / 2;
const cy = (b: Box) => b.y + b.height / 2;

async function box(page: Page, sel: string): Promise<Box> {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`kein boundingBox für ${sel}`);
  return b;
}

test('Inline-Lader und React-Lader sind deckungsgleich (kein Sprung beim Übergang)', async ({
  page,
}) => {
  // (1) Inline-Lader: das echte `/` mit blockiertem Einstiegs-JS - so bleibt
  // `#vp-boot-skeleton` stehen (React entfernt es sonst sofort).
  await page.route('**/src/main.tsx', (r) => r.abort());
  await page.route('**/assets/*.js', (r) => r.abort());
  await page.goto('/');
  await page.waitForSelector('#vp-boot-skeleton .vp-bs-mark');
  const inl = {
    word: await box(page, '#vp-boot-skeleton .vp-bs-word'),
    mark: await box(page, '#vp-boot-skeleton .vp-bs-mark'),
    text: await box(page, '#vp-boot-skeleton .vp-bs-text'),
  };

  // (2) React-Lader: `VpLoaderScreen` mit demselben Text.
  const p2 = await page.context().newPage();
  await p2.goto('/e2e/loader-parity.html');
  await p2.waitForSelector('.vp-loader-mark');
  await p2.evaluate(async () => {
    try {
      await (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready;
    } catch {
      /* egal */
    }
  });
  const rea = {
    word: await box(p2, '.vp-loader-word'),
    mark: await box(p2, '.vp-loader-mark'),
    text: await box(p2, '.vp-loader-text'),
  };
  // ⚠ Review SOLLTE-1: die React-Wortmarke darf NICHT über `?inline` (Vite-6,
  // auf Vite 5.4 wirkungslos) laufen - dann wäre `src` ein Netz-Asset mit
  // `?inline`-Query statt ein Data-URI, und die Marke tauchte spät auf. Hier (Dev)
  // ist der `src` eine gebündelte URL ohne `?inline`; dass sie im BUILD wirklich
  // ein Data-URI (kein Request) ist, prüft `test:bundle`. Zusätzlich: das Bild
  // ist dekodiert (kein leeres Marken-Feld).
  const img = await p2.locator('.vp-loader-word').evaluate((el) => ({
    src: (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src,
    naturalWidth: (el as HTMLImageElement).naturalWidth,
  }));
  expect(img.src, 'Wortmarke darf keine `?inline`-Query tragen (Vite-6-Falle)').not.toContain(
    '?inline',
  );
  expect(img.naturalWidth, 'Wortmarke ist nicht dekodiert (leeres Marken-Feld)').toBeGreaterThan(0);
  await p2.close();

  const near = (a: number, b: number, tol: number, label: string) =>
    expect(Math.abs(a - b), `${label}: inline ${a.toFixed(1)} vs react ${b.toFixed(1)}`).toBeLessThan(
      tol,
    );

  // Die Pulse-Marke - schrift-unabhängig, muss pixelnah deckungsgleich sein.
  near(cx(inl.mark), cx(rea.mark), 1.5, 'Marke Mitte-X');
  near(cy(inl.mark), cy(rea.mark), 1.5, 'Marke Mitte-Y');
  near(inl.mark.width, rea.mark.width, 1.5, 'Marke Breite');
  near(inl.mark.height, rea.mark.height, 1.5, 'Marke Höhe');

  // Wortmarke: Mitte-X (Bühnen-Zentrum), Oberkante und Höhe.
  near(cx(inl.word), cx(rea.word), 2, 'Wortmarke Mitte-X');
  near(inl.word.y, rea.word.y, 2, 'Wortmarke Oberkante-Y');
  near(inl.word.height, rea.word.height, 2.5, 'Wortmarke Höhe');

  // Statuszeile: an derselben Höhe (reservierte zwei Zeilen in beiden Fassungen).
  near(cx(inl.text), cx(rea.text), 2, 'Statuszeile Mitte-X');
  near(inl.text.y, rea.text.y, 2.5, 'Statuszeile Oberkante-Y');
  near(inl.text.height, rea.text.height, 2.5, 'Statuszeile Höhe');
});
