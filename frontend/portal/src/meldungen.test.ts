import { describe, expect, it } from 'vitest';
import {
  anlageAusHash,
  istEigeneUeberwachung,
  meldungQuelleLink,
  reiterAusHash,
  type Meldung,
  sortiereJetzt,
  sortiereVerlauf,
} from './meldungen';

function meldung(teil: Partial<Meldung>): Meldung {
  return {
    id: 'id', kennzeichen: 'AL-2026-000001', wertart: 'box.erreichbar', schwere: 'warnung',
    anlageId: 'an-1', anlageName: 'Halle 1', standortId: 'st-1', ausgeloestAm: '2026-11-03T14:00:00Z',
    zustand: 'aktiv', wiederNormalAm: null, gesehenVon: null, gesehenAm: null, erledigtAm: null,
    bezugKennung: null,
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

describe('reiterAusHash — das Energiemanagement-Verzeichnis zeigt direkt auf den Verlauf (Entscheid 14A)', () => {
  it('liest ?reiter=verlauf aus der rohen Adresse', () => {
    expect(reiterAusHash('#/meldungen?reiter=verlauf')).toBe('verlauf');
  });

  it('ignoriert einen unbekannten Reiter', () => {
    expect(reiterAusHash('#/meldungen?reiter=sonstwas')).toBeNull();
  });

  it('liefert null ohne Filter', () => {
    expect(reiterAusHash('#/meldungen')).toBeNull();
  });
});

describe('istEigeneUeberwachung — Scheibe 5, Entscheid 9A (§6.4 Nr. 7)', () => {
  it('erkennt alle fünf Scheibe-5-Wertarten', () => {
    for (const wertart of ['kennzahl.bezugsbasis', 'energieziel.kurs', 'messstelle.menge',
      'messstelle.beobachtung', 'messstelle.monat_unvollstaendig']) {
      expect(istEigeneUeberwachung(wertart)).toBe(true);
    }
  });

  it('lässt jede andere Wertart unberührt', () => {
    expect(istEigeneUeberwachung('box.erreichbar')).toBe(false);
  });
});

describe('meldungQuelleLink — „Zur Auffälligkeit zur Quelle“ (§6.4 Nr. 7)', () => {
  it('führt von einer Kennzahl-Meldung zur Kennzahl', () => {
    const m = meldung({ wertart: 'kennzahl.bezugsbasis', bezugKennung: 'kennzahl:kz-1' });
    expect(meldungQuelleLink(m)).toEqual({ label: 'Zur Kennzahl', hash: '#/portfolio/kennzahlen/kz-1' });
  });

  it('führt von einer Energieziel-Meldung zum Energieziel', () => {
    const m = meldung({ wertart: 'energieziel.kurs', bezugKennung: 'energieziel:ez-1' });
    expect(meldungQuelleLink(m)).toEqual({ label: 'Zum Energieziel', hash: '#/portfolio/verbesserung/energieziele/ez-1' });
  });

  it('führt von jeder Messstellen-Meldung zur Messstelle', () => {
    const m = meldung({ wertart: 'messstelle.beobachtung', bezugKennung: 'messstelle:ms-1' });
    expect(meldungQuelleLink(m)).toEqual({ label: 'Zur Messstelle', hash: '#/portfolio/messstellen/ms-1' });
  });

  it('liefert null ohne passenden Bezug', () => {
    expect(meldungQuelleLink(meldung({ wertart: 'kennzahl.bezugsbasis', bezugKennung: null }))).toBeNull();
  });

  it('liefert null für jede andere Wertart', () => {
    expect(meldungQuelleLink(meldung({ wertart: 'box.erreichbar', bezugKennung: 'anlage:an-1' }))).toBeNull();
  });
});
