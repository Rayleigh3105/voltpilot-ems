import { describe, expect, it } from 'vitest';
import { anpassenDokument, CANONICAL_DESKTOP, kachelGroesse, KACHELN, layoutResolve } from './cockpitLayout';

// Kachelgrößen (Konzept „Cockpit als Tagesfilm“): additiv im Layout-Dokument.
describe('Kachelgrößen', () => {
  it('jede Kachel des Katalogs kann klein, der Standard bleibt das heutige Bild', () => {
    expect(KACHELN.length).toBeGreaterThan(0);
    for (const k of KACHELN) {
      expect(k.groessen).toContain(k.standard);
      expect(k.standard).toBe('klein');
    }
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

import { betriebAus, CANONICAL_PHONE, canonicalFuer } from './cockpitLayout';

describe('Voreinstellung je Betriebsmodell', () => {
  const b = (id: string) => ({ id, title: id, order: 0, from: [] }) as never;
  it('erkennt das Betriebsmodell aus den Blöcken', () => {
    expect(betriebAus([b('peak-band'), b('handel')])).toBe('spitze');
    expect(betriebAus([b('handel')])).toBe('markt');
    expect(betriebAus([])).toBe('eigenverbrauch');
  });

  it('Eigenverbrauch bleibt die bisherige Reihenfolge', () => {
    expect(canonicalFuer(false, 'eigenverbrauch')).toEqual(CANONICAL_DESKTOP);
    expect(canonicalFuer(true, 'eigenverbrauch')).toEqual(CANONICAL_PHONE);
  });

  it('Marktoptimierung: der Börsenpreis folgt der Bühne; Lastspitze: die Kacheln', () => {
    const m = canonicalFuer(false, 'markt');
    expect(m.indexOf('strompreis')).toBe(m.indexOf('steuerung') + 1);
    const t = canonicalFuer(true, 'markt');
    expect(t.indexOf('strompreis')).toBe(t.indexOf('geld') + 1);
    const s = canonicalFuer(true, 'spitze');
    expect(s.indexOf('kacheln')).toBe(s.indexOf('geld') + 1);
    // Dieselben Bausteine, nur umgestellt.
    expect([...m].sort()).toEqual([...CANONICAL_DESKTOP].sort());
  });
});
