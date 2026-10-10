import { describe, expect, it } from 'vitest';
import type { BerichteBetroffen, BerichtStandRef } from './api';
import {
  BERICHTE_FOLGEN_TITEL,
  berichteFolgen,
  berichteFolgenZeile,
  istKalendertag,
  type BerichteFolgenArt,
} from './berichteFolgen';
import { UEMS_BERICHTE, UEMS_REVISION } from './glossar';

/**
 * UEMS AP-12 IP-9 — die Zeile „Freigegebene Berichte: …“ in drei Folgen-Karten (Fläche ändern, Anlage
 * zuordnen, Archivieren). Referenzunternehmen Ahrenberg: Halle 2 (G-2) bekommt ab 01.01.2027 eine neue
 * Fläche — kein gültiger Berichtsstand ist betroffen; Halle 2 Lager wird archiviert — vier freigegebene
 * Berichtsstände zitieren ihre Messstellen.
 */

const antwort = (over: Partial<BerichteBetroffen> = {}): BerichteBetroffen => ({
  anlass: 'flaeche_rueckwirkend',
  gilt_ab: '2027-01-01',
  berichte_vorhanden: true,
  betroffen: [],
  zitieren: [],
  ...over,
});
const stand = (kennung: string, nr: number): BerichtStandRef => ({ kennung, nr });
const VIER = [stand('BR-2026-0001', 1), stand('BR-2026-0001', 2), stand('BR-2026-0002', 1), stand('BR-2026-0004', 1)];

function zeile(a: BerichteBetroffen, art: BerichteFolgenArt): string | null {
  const f = berichteFolgen(a, art);
  return f && berichteFolgenZeile(f);
}

describe('berichteFolgen — „Freigegebene Berichte: …“ (AP-12 IP-9)', () => {
  it('Fläche Halle 2 ab 01.01.2027, kein Stand betroffen: „Freigegebene Berichte: keine betroffen“', () => {
    expect(zeile(antwort(), 'aendern')).toBe('Freigegebene Berichte: keine betroffen');
    expect(berichteFolgen(antwort(), 'aendern')).toEqual({ titel: 'Freigegebene Berichte', text: 'keine betroffen' });
  });

  it('ein betroffener Stand bekommt den Vermerk, mehrere bekommen ihn — in der Reihenfolge der Antwort', () => {
    expect(berichteFolgen(antwort({ betroffen: [stand('BR-2026-0001', 2)] }), 'aendern')?.text).toBe(
      'BR-2026-0001 Nr. 2 bekommt den Vermerk „Revision nötig“',
    );
    expect(
      berichteFolgen(antwort({ betroffen: [stand('BR-2026-0002', 1), stand('BR-2026-0001', 2)] }), 'aendern')?.text,
    ).toBe('BR-2026-0002 Nr. 1, BR-2026-0001 Nr. 2 bekommen den Vermerk „Revision nötig“');
  });

  it('eine Änderung liest nur `betroffen` — dass Stände zitieren, macht noch keine Revision', () => {
    expect(zeile(antwort({ zitieren: VIER }), 'aendern')).toBe('Freigegebene Berichte: keine betroffen');
  });

  it('Archivieren zählt die zitierenden Stände (auch ersetzte): „4 zitieren Messstellen dieses Orts — sie bleiben unverändert“', () => {
    const a = antwort({ anlass: 'zuordnung_rueckwirkend', gilt_ab: '2027-06-30', zitieren: VIER });
    expect(zeile(a, 'archivieren_ort')).toBe(
      'Freigegebene Berichte: 4 zitieren Messstellen dieses Orts — sie bleiben unverändert',
    );
    // `betroffen` spielt beim Archivieren keine Rolle: der Satz sagt, dass nichts umgeschrieben wird.
    expect(zeile({ ...a, betroffen: [stand('BR-2026-0001', 2)] }, 'archivieren_ort')).toBe(
      'Freigegebene Berichte: 4 zitieren Messstellen dieses Orts — sie bleiben unverändert',
    );
  });

  it('Archivieren: Einzahl, keiner, und ein Standort sagt „dieses Standorts“', () => {
    const eins = antwort({ zitieren: [stand('BR-2026-0001', 1)] });
    expect(berichteFolgen(eins, 'archivieren_ort')?.text).toBe('1 zitiert Messstellen dieses Orts — er bleibt unverändert');
    expect(berichteFolgen(eins, 'archivieren_standort')?.text).toBe(
      '1 zitiert Messstellen dieses Standorts — er bleibt unverändert',
    );
    expect(berichteFolgen(antwort({ zitieren: VIER }), 'archivieren_standort')?.text).toBe(
      '4 zitieren Messstellen dieses Standorts — sie bleiben unverändert',
    );
    expect(zeile(antwort(), 'archivieren_ort')).toBe('Freigegebene Berichte: keine betroffen');
  });

  it('ohne lesbaren Bericht im Unternehmen gibt es die Zeile nicht — auch nicht „keine betroffen“', () => {
    for (const art of ['aendern', 'archivieren_ort', 'archivieren_standort'] as const) {
      expect(berichteFolgen(antwort({ berichte_vorhanden: false }), art)).toBeNull();
      expect(berichteFolgen(antwort({ berichte_vorhanden: false, betroffen: VIER, zitieren: VIER }), art)).toBeNull();
    }
  });

  it('die Wörter kommen aus dem Glossar: Berichte, Revision', () => {
    expect(BERICHTE_FOLGEN_TITEL).toBe(`Freigegebene ${UEMS_BERICHTE}`);
    expect(berichteFolgen(antwort({ betroffen: VIER.slice(0, 1) }), 'aendern')?.text).toContain(`„${UEMS_REVISION} nötig“`);
  });

  it('gefragt wird nur mit einem echten Kalendertag', () => {
    expect(istKalendertag('2027-01-01')).toBe(true);
    expect(istKalendertag('2028-02-29')).toBe(true);
    for (const kein of [null, undefined, '', '2027-1-01', '2027-02-30', '2027-13-01', '01.01.2027']) {
      expect(istKalendertag(kein), String(kein)).toBe(false);
    }
  });
});
