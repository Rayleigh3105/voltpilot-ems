import { describe, expect, it } from 'vitest';
import { anlageAusHash, type Meldung, sortiereJetzt, sortiereVerlauf } from './meldungen';

function meldung(teil: Partial<Meldung>): Meldung {
  return {
    id: 'id', kennzeichen: 'AL-2026-000001', wertart: 'box.erreichbar', schwere: 'warnung',
    anlageId: 'an-1', anlageName: 'Halle 1', standortId: 'st-1', ausgeloestAm: '2026-11-03T14:00:00Z',
    zustand: 'aktiv', wiederNormalAm: null, gesehenVon: null, gesehenAm: null, erledigtAm: null,
    ...teil,
  };
}

describe('Meldungen — Sortierung (§6.8 Entwurf 2)', () => {
  it('ordnet Jetzt nach Schwere (Dringend vor Warnung vor Hinweis), darin das Älteste zuerst', () => {
    const hinweis = meldung({ id: 'h', schwere: 'hinweis', ausgeloestAm: '2026-11-03T10:00:00Z' });
    const warnungAlt = meldung({ id: 'wa', schwere: 'warnung', ausgeloestAm: '2026-11-03T08:00:00Z' });
    const warnungNeu = meldung({ id: 'wn', schwere: 'warnung', ausgeloestAm: '2026-11-03T12:00:00Z' });
    const dringend = meldung({ id: 'd', schwere: 'dringend', ausgeloestAm: '2026-11-03T14:00:00Z' });

    const sortiert = sortiereJetzt([hinweis, warnungNeu, dringend, warnungAlt]);

    expect(sortiert.map((m) => m.id)).toEqual(['d', 'wa', 'wn', 'h']);
  });

  it('ordnet den Verlauf nach der jüngsten Meldung zuerst', () => {
    const alt = meldung({ id: 'alt', ausgeloestAm: '2026-11-01T00:00:00Z' });
    const neu = meldung({ id: 'neu', ausgeloestAm: '2026-11-05T00:00:00Z' });

    expect(sortiereVerlauf([alt, neu]).map((m) => m.id)).toEqual(['neu', 'alt']);
  });
});

describe('anlageAusHash — die Seite liest ihren Filter selbst (§6.2)', () => {
  it('liest ?anlage= aus der rohen Adresse', () => {
    expect(anlageAusHash('#/meldungen?anlage=an-42')).toBe('an-42');
  });

  it('liefert null ohne Filter', () => {
    expect(anlageAusHash('#/meldungen')).toBeNull();
  });
});
