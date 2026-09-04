// Beweist, was ein Browser OHNE `@property` mit der Familie macht (Safari < 16.4).
import { chromium, webkit } from '@playwright/test';
const html = `<!doctype html><meta charset=utf-8><style>
:root{
  --vp-motion-scale:1;
  --vp-motion-chart: calc(400ms * var(--vp-motion-scale));
  --vp-motion-fast: calc(120ms * var(--vp-motion-scale));
}
@media (prefers-reduced-motion: reduce){ :root{ --vp-motion-scale:0 } }
#p{ transition: opacity var(--vp-motion-chart) linear; }
#q{ transition: opacity var(--vp-motion-fast) linear; }
</style><div id=p></div><div id=q></div>`;
for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
  for (const reduced of [false, true]) {
    const b = await engine.launch();
    const ctx = await b.newContext(reduced ? { reducedMotion: 'reduce' } : {});
    const page = await ctx.newPage();
    await page.setContent(html);
    const r = await page.evaluate(() => ({
      rootChart: getComputedStyle(document.documentElement).getPropertyValue('--vp-motion-chart').trim(),
      genutztChart: getComputedStyle(document.getElementById('p')).transitionDuration,
      genutztFast: getComputedStyle(document.getElementById('q')).transitionDuration,
    }));
    console.log(`${name} ohne @property, reduced=${reduced}:`, JSON.stringify(r));
    await b.close();
  }
}
