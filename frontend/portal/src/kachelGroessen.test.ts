import { describe, expect, it } from 'vitest';
import { anpassenDokument, CANONICAL_DESKTOP, kachelGroesse, KACHELN, layoutResolve } from './cockpitLayout';

// Kachelgrößen (Konzept „Cockpit als Tagesfilm“): additiv im Layout-Dokument.
describe('Kachelgrößen', () => {
  it('jede Kachel des Katalogs trägt ihren Standard; breite Inhalte sind immer breit', () => {
    expect(KACHELN.length).toBeGreaterThan(0);
    for (const k of KACHELN) expect(k.groessen).toContain(k.standard);
    const def = (id: string) => KACHELN.find((k) => k.id === id)!;
    // Wie im Konzept: Sonne breit (umstellbar), Handel und Lastspitze immer breit.
    expect(def('sonne')).toMatchObject({ standard: 'breit', groessen: ['klein', 'breit'] });
    expect(def('handel').groessen).toEqual(['breit']);
    expect(def('lastspitze').groessen).toEqual(['breit']);
    expect(def('autarkie').standard).toBe('klein');
  });

  it('eine gewählte Größe gilt nur, wenn die Kachel sie tragen kann', () => {
    expect(kachelGroesse('wetter', { wetter: 'breit' })).toBe('breit');
    expect(kachelGroesse('wetter', null)).toBe('klein');
    expect(kachelGroesse('gibtsnicht', { gibtsnicht: 'breit' })).toBe('klein');
  });

  it('die höhere Schicht gewinnt, und eine Größe allein ist eine Aussage', () => {
    const r = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: CANONICAL_DESKTOP,
      siteVorgabe: { order: [], hidden: [], shown: [], lead: null, groessen: { wetter: 'breit', handel: 'breit' } },
      eigen: { order: [], hidden: [], shown: [], lead: null, groessen: { wetter: 'klein' } },
    });
    expect(r.groessen).toEqual({ wetter: 'klein', handel: 'breit' });
    expect(r.quelle).toBe('eigen');
  });

  it('das gespeicherte Dokument trägt Größen nur, wenn welche gewählt sind', () => {
    const ohne = anpassenDokument({ arrangement: ['status'], hidden: [], lead: null });
    expect('groessen' in ohne).toBe(false);
    const mit = anpassenDokument({ arrangement: ['status'], hidden: [], lead: null, groessen: { wetter: 'breit' } });
    expect(mit.groessen).toEqual({ wetter: 'breit' });
  });
});

import { betriebAus, canonicalFuer } from './cockpitLayout';

describe('Voreinstellung je Betriebsmodell', () => {
  const b = (id: string) => ({ id, title: id, order: 0, from: [] }) as never;
  it('erkennt das Betriebsmodell aus den Blöcken', () => {
    expect(betriebAus([b('peak-band'), b('handel')])).toBe('spitze');
    expect(betriebAus([b('handel')])).toBe('markt');
    expect(betriebAus([])).toBe('eigenverbrauch');
  });

  it('Eigenverbrauch: erst die Tageskacheln, dann Laden und Fahrplan (wie im Prototyp)', () => {
    const e = canonicalFuer(false, 'eigenverbrauch');
    expect(e.indexOf('kacheln')).toBeLessThan(e.indexOf('laden'));
    expect(e.indexOf('laden')).toBeLessThan(e.indexOf('fahrplan'));
    // Rechner und Telefon teilen die Folge; am Rechner steht die Leitkachel neben dem Fluss.
    expect(canonicalFuer(true, 'eigenverbrauch')).toEqual(e);
  });

  it('Marktoptimierung: der Börsenpreis folgt der Bühne; Lastspitze: die Kacheln', () => {
    const m = canonicalFuer(true, 'markt');
    expect(m.indexOf('strompreis')).toBe(m.indexOf('energiefluss') + 1);
    const s = canonicalFuer(false, 'spitze');
    expect(s.indexOf('kacheln')).toBeLessThan(s.indexOf('geld'));
    for (const b of ['eigenverbrauch', 'markt', 'spitze'] as const) {
      expect([...canonicalFuer(false, b)].sort()).toEqual([...CANONICAL_DESKTOP].sort());
    }
  });

});
