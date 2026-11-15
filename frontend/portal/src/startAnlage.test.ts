import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { merkeStartAnlage, vergissStartAnlage, vorabAdresse } from './startAnlage';

/**
 * Die Anlage des leeren Starts (Welle 3, `startAnlage.ts`): nur für denselben Nutzer im selben Kundenbereich, nur
 * beim Start ohne Adresse, und ein fremder Nutzer verwirft sie.
 */
const SCHLUESSEL = 'vp.startAnlage';

describe('startAnlage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('leerer Start desselben Nutzers: die gemerkte Anlage', () => {
    merkeStartAnlage('nutzer-1', null, 's-1');
    expect(vorabAdresse('', 'nutzer-1', null)).toBe('#/anlage/s-1');
    expect(vorabAdresse('#/', 'nutzer-1', null)).toBe('#/anlage/s-1');
    expect(vorabAdresse('#', 'nutzer-1', null)).toBe('#/anlage/s-1');
  });

  it('eine Adresse gewinnt immer - die gemerkte Anlage zählt nur ohne Adresse', () => {
    merkeStartAnlage('nutzer-1', null, 's-1');
    expect(vorabAdresse('#/anlage/s-2/messwerte', 'nutzer-1', null)).toBe('#/anlage/s-2/messwerte');
    expect(vorabAdresse('#/portfolio', 'nutzer-1', null)).toBe('#/portfolio');
  });

  it('Nutzerwechsel: kein Vorab, und die Anlage des anderen ist verworfen', () => {
    merkeStartAnlage('nutzer-1', null, 's-1');
    expect(vorabAdresse('', 'nutzer-2', null)).toBe('');
    expect(localStorage.getItem(SCHLUESSEL)).toBeNull();
    expect(vorabAdresse('', 'nutzer-1', null)).toBe('');
  });

  it('ohne bekannten Nutzer weder Vorab noch Merken', () => {
    merkeStartAnlage('nutzer-1', null, 's-1');
    expect(vorabAdresse('', undefined, null)).toBe('');
    merkeStartAnlage(undefined, null, 's-1');
    expect(localStorage.getItem(SCHLUESSEL)).toBeNull();
  });

  it('anderer Kundenbereich: kein Vorab, die Anlage bleibt für den eigenen gemerkt', () => {
    merkeStartAnlage('partner-1', 'kb-1', 's-1');
    expect(vorabAdresse('', 'partner-1', 'kb-2')).toBe('');
    expect(vorabAdresse('', 'partner-1', null)).toBe('');
    expect(vorabAdresse('', 'partner-1', 'kb-1')).toBe('#/anlage/s-1');
  });

  it('ein leerer Start, der woanders landet, vergisst die Anlage', () => {
    merkeStartAnlage('nutzer-1', null, 's-1');
    merkeStartAnlage('nutzer-1', null, null);
    expect(localStorage.getItem(SCHLUESSEL)).toBeNull();
    expect(vorabAdresse('', 'nutzer-1', null)).toBe('');
  });

  it.each([
    ['kein JSON', '{kaputt'],
    ['ohne Nutzer', JSON.stringify({ bereich: null, anlage: 's-1' })],
    ['keine Anlagen-Kennung', JSON.stringify({ nutzer: 'nutzer-1', bereich: null, anlage: '../../admin' })],
    ['leere Anlage', JSON.stringify({ nutzer: 'nutzer-1', bereich: null, anlage: '' })],
  ])('ein unlesbarer Eintrag (%s) gilt als nicht gemerkt und wird entfernt', (_, roh) => {
    localStorage.setItem(SCHLUESSEL, roh);
    expect(vorabAdresse('', 'nutzer-1', null)).toBe('');
    expect(localStorage.getItem(SCHLUESSEL)).toBeNull();
  });

  it('ein gesperrter Speicher bricht nichts: kein Vorab, kein Fehler', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('gesperrt', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('gesperrt', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('gesperrt', 'SecurityError');
    });
    expect(() => merkeStartAnlage('nutzer-1', null, 's-1')).not.toThrow();
    expect(vorabAdresse('', 'nutzer-1', null)).toBe('');
    expect(() => vergissStartAnlage()).not.toThrow();
  });
});

describe('Abmelden verwirft die Anlage des leeren Starts', () => {
  it('logout() leert sie mit den Tokens', async () => {
    vi.resetModules();
    vi.doMock('keycloak-js', () => ({
      default: class {
        logout = vi.fn(() => Promise.resolve());
      },
    }));
    const { logout } = await import('./auth');
    const { merkeStartAnlage: merke } = await import('./startAnlage');
    merke('nutzer-1', null, 's-1');
    logout();
    expect(localStorage.getItem(SCHLUESSEL)).toBeNull();
    vi.doUnmock('keycloak-js');
  });
});
