import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/components/Fahrplan.css'), 'utf8');

describe('Jetzt-Held responsive contract', () => {
  it('stays mobile-first and adds a bounded two-column desktop layout', () => {
    const mobile = css.indexOf('.vp-jetzt-body {\n  display: block;');
    const desktop = css.indexOf('@media (min-width: 1024px)');
    expect(mobile).toBeGreaterThanOrEqual(0);
    expect(desktop).toBeGreaterThan(mobile);
    expect(css.slice(desktop)).toContain(
      'grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr)',
    );
    expect(css).toContain('.vp-jetzt-chips {\n  display: flex;\n  flex-wrap: wrap;');
    expect(css).toMatch(/\.vp-jetzt-main,\n\.vp-jetzt-side \{\n  min-width: 0;/);
  });
});
