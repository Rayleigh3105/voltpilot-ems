import { describe, expect, it } from 'vitest';
import { reiterRand } from './reiterRand';

describe('reiterRand — welche Kante einer Reiterleiste noch Reiter verbirgt', () => {
  it('passt alles hinein, blendet keine Kante aus', () => {
    expect(reiterRand(0, 400, 400)).toBe('');
  });

  it('ganz links: rechts liegen noch Reiter', () => {
    expect(reiterRand(0, 343, 620)).toBe('rechts');
  });

  it('in der Mitte: beide Kanten', () => {
    expect(reiterRand(120, 343, 620)).toBe('beide');
  });

  it('ganz rechts: nur links liegen noch Reiter', () => {
    expect(reiterRand(277, 343, 620)).toBe('links');
  });

  it('verzeiht Rundung um einen Pixel (Browser melden Bruchteile)', () => {
    expect(reiterRand(0.6, 343, 344)).toBe('');
    expect(reiterRand(276.4, 343, 620)).toBe('links');
  });
});
