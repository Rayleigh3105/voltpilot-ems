import { afterEach, describe, expect, it } from 'vitest';
import { ersteWerteErledigt, ersteWerteOffen, merkeErsteWerte } from './ersteWerte';

afterEach(() => localStorage.clear());

describe('die Karte „Ihre Anlage ist live“ - einmal je Anlage (Anlage-Flow a1, D7)', () => {
  it('steht an nach dem Anlegen, bis sie erledigt ist', () => {
    expect(ersteWerteOffen('s-1')).toBe(false);
    merkeErsteWerte('s-1');
    expect(ersteWerteOffen('s-1')).toBe(true);
    expect(ersteWerteOffen('s-2')).toBe(false);
    ersteWerteErledigt('s-1');
    expect(ersteWerteOffen('s-1')).toBe(false);
  });
});
