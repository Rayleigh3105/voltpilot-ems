/**
 * Bild-Vergleich fuer den P0-Beweis: zaehlt abweichende Pixel zweier PNGs
 * IM BROWSER (kein zusaetzliches Paket noetig — die Maschine hat weder PIL
 * noch ImageMagick). Aufruf: node e2e/motion-p0/diff.mjs A_DIR B_DIR
 */
import { chromium } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [a, b] = process.argv.slice(2);
const namen = readdirSync(a).filter((n) => n.endsWith('.png') && readdirSync(b).includes(n));
const browser = await chromium.launch();
const page = await browser.newPage();
const url = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

for (const n of namen.sort()) {
  const r = await page.evaluate(
    async ([ua, ub]) => {
      const laden = (u) =>
        new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = rej;
          i.src = u;
        });
      const [ia, ib] = await Promise.all([laden(ua), laden(ub)]);
      if (ia.width !== ib.width || ia.height !== ib.height) {
        return { groesse: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
      }
      const px = (img) => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        return c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
      };
      const da = px(ia);
      const db = px(ib);
      let anders = 0;
      let maxAbw = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d =
          Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
        if (d > 12) anders += 1;
        if (d > maxAbw) maxAbw = d;
      }
      const gesamt = da.length / 4;
      return {
        breite: ia.width,
        hoehe: ia.height,
        anders,
        prozent: ((anders / gesamt) * 100).toFixed(3),
        maxAbw,
      };
    },
    [url(join(a, n)), url(join(b, n))],
  );
  console.log(n, JSON.stringify(r));
}
await browser.close();
