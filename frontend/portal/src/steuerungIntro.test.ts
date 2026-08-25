import { describe, expect, it } from 'vitest';
import {
  STEUERUNG_INTRO_KEY,
  STEUERUNG_INTRO_ZEILEN,
  introGesehen,
  mitGesehen,
} from './steuerungIntro';
import type { CockpitLayoutDocument } from './cockpitLayout';

const LEER: CockpitLayoutDocument = { order: [], hidden: [], shown: [], lead: null };

describe('Stufe 8 · der Erklärkasten der Steuerung', () => {
  it('nennt DREI Zonen in drei Sätzen', () => {
    expect(STEUERUNG_INTRO_ZEILEN).toHaveLength(3);
    expect(STEUERUNG_INTRO_ZEILEN[0]).toContain('Jetzt');
    expect(STEUERUNG_INTRO_ZEILEN[1]).toContain('Regeln');
    expect(STEUERUNG_INTRO_ZEILEN[2]).toContain('Betriebsmodelle');
  });

  it('ohne Antwort gilt er als NICHT gesehen — einmal zu viel ist harmlos', () => {
    expect(introGesehen(null)).toBe(false);
    expect(introGesehen(undefined)).toBe(false);
    expect(introGesehen(LEER)).toBe(false);
  });

  it('eine gesetzte Marke wird erkannt, eine fremde nicht', () => {
    expect(introGesehen({ ...LEER, seen: [STEUERUNG_INTRO_KEY] })).toBe(true);
    expect(introGesehen({ ...LEER, seen: ['ein-anderer-kasten'] })).toBe(false);
  });

  it('das Merken ist ADDITIV — jede andere Aussage reist unverändert mit', () => {
    const doc: CockpitLayoutDocument = {
      order: ['status', 'geld'],
      hidden: ['kacheln'],
      shown: ['zustand'],
      lead: 'energiefluss',
      custom: [
        { id: 'eigen:1', titel: 'Dach', darstellung: 'kachel', entityId: 'e1', channel: 'pv_power_kw', aggregat: 'jetzt' },
      ],
      seen: ['ein-anderer-kasten'],
    };
    const neu = mitGesehen(doc);
    expect(neu.order).toEqual(doc.order);
    expect(neu.hidden).toEqual(doc.hidden);
    expect(neu.shown).toEqual(doc.shown);
    expect(neu.lead).toBe('energiefluss');
    expect(neu.custom).toEqual(doc.custom);
    expect(neu.seen).toEqual(['ein-anderer-kasten', STEUERUNG_INTRO_KEY]);
  });

  it('ohne Dokument entsteht das MINIMALE — und das ist keine Anordnungs-Schicht', () => {
    const neu = mitGesehen(null);
    expect(neu).toEqual({ order: [], hidden: [], shown: [], lead: null, seen: [STEUERUNG_INTRO_KEY] });
  });

  it('zweimal merken erzeugt keinen Doppel-Eintrag', () => {
    const einmal = mitGesehen(LEER);
    expect(mitGesehen(einmal).seen).toEqual([STEUERUNG_INTRO_KEY]);
  });
});
