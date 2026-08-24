import { describe, expect, it } from 'vitest';
import {
  faceKey,
  fetchGate,
  parseFace,
  readFace,
  rememberFace,
  serializeFace,
} from './anlageFace';

describe('anlageFace · das gemerkte Gesicht', () => {
  it('liest zurueck, was es geschrieben hat', () => {
    rememberFace('site-1', { stack: true, peak: false });
    expect(readFace('site-1')).toEqual({ stack: true, peak: false });
  });

  it('haelt die Anlagen auseinander', () => {
    rememberFace('site-1', { stack: true, peak: true });
    rememberFace('site-2', { stack: false, peak: false });
    expect(readFace('site-1')).toEqual({ stack: true, peak: true });
    expect(readFace('site-2')).toEqual({ stack: false, peak: false });
  });

  it('merkt sich NICHTS, solange nichts gemerkt wurde', () => {
    expect(readFace('nie-besucht')).toBeNull();
  });

  it('schreibt nicht, wenn sich nichts geaendert hat', () => {
    rememberFace('site-1', { stack: true, peak: false });
    const vorher = sessionStorage.getItem(faceKey('site-1'));
    rememberFace('site-1', { stack: true, peak: false });
    expect(sessionStorage.getItem(faceKey('site-1'))).toBe(vorher);
  });

  it('ueberschreibt ein geaendertes Gesicht', () => {
    rememberFace('site-1', { stack: true, peak: false });
    rememberFace('site-1', { stack: false, peak: true });
    expect(readFace('site-1')).toEqual({ stack: false, peak: true });
  });

  it('serialisiert mit stabiler Schluesselreihenfolge', () => {
    expect(serializeFace({ peak: true, stack: false } as never)).toBe(
      serializeFace({ stack: false, peak: true }),
    );
  });
});

describe('anlageFace · parseFace ist STRENG', () => {
  it('nimmt die erwartete Form', () => {
    expect(parseFace('{"stack":true,"peak":false}')).toEqual({ stack: true, peak: false });
  });

  it.each([
    ['nichts gespeichert', null],
    ['kaputtes JSON', '{'],
    ['kein Objekt', '"stack"'],
    ['null', 'null'],
    ['ein Feld fehlt', '{"stack":true}'],
    ['falscher Typ', '{"stack":"ja","peak":false}'],
    ['ein aelterer Stand', '{"projection":"stack"}'],
  ])('faellt bei %s auf „nichts gemerkt" zurueck', (_name, stored) => {
    expect(parseFace(stored)).toBeNull();
  });

  it('ignoriert Zusatzfelder, solange die zwei stimmen', () => {
    expect(parseFace('{"stack":false,"peak":true,"spaeter":1}')).toEqual({
      stack: false,
      peak: true,
    });
  });
});

/**
 * Das Gate ist die ganze Sicherheits-Aussage von B1: sobald ENTSCHIEDEN ist,
 * gilt ausschliesslich die echte Entscheidung - die Erinnerung kann nie etwas
 * am Ergebnis aendern, nur am Startzeitpunkt.
 */
describe('anlageFace · fetchGate', () => {
  it('spekuliert vor der Entscheidung nach der Erinnerung', () => {
    expect(fetchGate(false, false, true)).toBe(true);
    expect(fetchGate(false, false, false)).toBe(false);
  });

  it('spekuliert NICHT ohne Erinnerung (byte-gleich zu vor B1)', () => {
    expect(fetchGate(false, false, undefined)).toBe(false);
  });

  it('gibt nach der Entscheidung IMMER die Wahrheit, egal was gemerkt war', () => {
    expect(fetchGate(true, true, false)).toBe(true);
    expect(fetchGate(false, true, true)).toBe(false);
    expect(fetchGate(true, true, undefined)).toBe(true);
  });

  it('ein RICHTIGER Tipp aendert das Gate beim Entscheiden nicht - also kein zweiter Abruf', () => {
    expect(fetchGate(true, false, true)).toBe(true);
    expect(fetchGate(true, true, true)).toBe(true);
  });

  it('ein FALSCHER Tipp verwirft die Spekulation beim Entscheiden', () => {
    expect(fetchGate(false, false, true)).toBe(true);
    expect(fetchGate(false, true, true)).toBe(false);
  });
});
