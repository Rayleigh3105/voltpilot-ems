import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ABWEICHUNG_NACH_MS, boxSchritt, rueckmeldung, type Gesendet } from './rueckmeldung';

/** Der Vertrag, aus dem Box und API ihre Hälfte prüfen - hier der Abschnitt `portal`. */
const VEKTOREN = JSON.parse(readFileSync(join(__dirname, '../../../../docs/contracts/ladepunkt-quelle-echo-vectors.json'), 'utf8')) as {
  portal: { name: string; uebernommen: boolean | null; gemeldet_nach_senden: boolean; sekunden_seit_senden?: number; schritt: string }[];
};

describe('boxSchritt: die Vektoren des Vertrags', () => {
  for (const f of VEKTOREN.portal) {
    it(f.name, () => {
      expect(boxSchritt(f.uebernommen, f.gemeldet_nach_senden, (f.sekunden_seit_senden ?? 10) * 1000)).toBe(f.schritt);
    });
  }
});

const uhr = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const SENDEN = Date.parse('2026-09-29T11:11:00Z');
const g: Gesendet = { modus: 'guenstig', ms: SENDEN, vorherGemeldet: '2026-09-29T11:10:50Z', vorherGemessen: '2026-09-29T11:10:40Z' };
const lp = {
  angesteckt: true, laedt: true, leistungKw: 11, gemessenAm: '2026-09-29T11:10:40Z', grund: 'Sonnenstrom',
  uebernommen: false as boolean | null, gemeldetAm: '2026-09-29T11:10:50Z',
};

describe('rueckmeldung: gesendet › Box hat übernommen › Wirkung gemessen', () => {
  it('direkt nach dem Senden: gesendet, die Box still, nichts gemessen', () => {
    const [a, b, c] = rueckmeldung(lp, g, SENDEN + 2000, uhr);
    expect(a).toEqual({ zustand: 'fertig', text: 'Gesendet: Günstig', unter: '11:11' });
    expect(b).toMatchObject({ zustand: 'laeuft', text: 'Box hat noch nicht bestätigt' });
    expect(c).toMatchObject({ zustand: 'offen', text: 'Wirkung noch nicht gemessen' });
  });

  it('eine NEUERE Meldung mit Übernahme und eine neuere Messung: alle drei erledigt', () => {
    const neu = { ...lp, uebernommen: true, gemeldetAm: '2026-09-29T11:11:05Z', gemessenAm: '2026-09-29T11:11:20Z' };
    const [, b, c] = rueckmeldung(neu, g, SENDEN + 30_000, uhr);
    expect(b).toEqual({ zustand: 'fertig', text: 'Box hat übernommen', unter: '11:11' });
    expect(c).toEqual({ zustand: 'fertig', text: 'Lädt mit 11,0 kW', unter: 'gemessen 11:11' });
  });

  it('eine alte Meldung, die zufällig passt, bestätigt nichts', () => {
    const [, b] = rueckmeldung({ ...lp, uebernommen: true }, g, SENDEN + 30_000, uhr);
    expect(b.zustand).toBe('laeuft');
  });

  it('weicht das Echo nach zwei Minuten noch ab, sagt die Karte es', () => {
    const neu = { ...lp, gemeldetAm: '2026-09-29T11:13:30Z' };
    expect(rueckmeldung(neu, g, SENDEN + ABWEICHUNG_NACH_MS - 1000, uhr)[1].zustand).toBe('laeuft');
    expect(rueckmeldung(neu, g, SENDEN + ABWEICHUNG_NACH_MS + 1000, uhr)[1]).toMatchObject({ zustand: 'warn', text: 'Box fährt noch die alte Wahl' });
  });

  it('eine ältere Box ohne Echo: ehrlich nicht bestätigt, nie eine erfundene Bestätigung', () => {
    const [, b] = rueckmeldung({ ...lp, uebernommen: null, gemeldetAm: '2026-09-29T11:12:00Z' }, g, SENDEN + 600_000, uhr);
    expect(b).toEqual({ zustand: 'offen', text: 'Box hat noch nicht bestätigt', unter: 'Diese Box meldet die Übernahme noch nicht.' });
  });

  it('ohne Ladung: der Grund der Säule aus der Messung', () => {
    const neu = { ...lp, laedt: false, leistungKw: 0, gemessenAm: '2026-09-29T11:11:20Z', grund: 'wartet auf Sonne' };
    expect(rueckmeldung(neu, g, SENDEN + 30_000, uhr)[2]).toEqual({ zustand: 'fertig', text: 'Wartet, lädt gerade nicht', unter: 'wartet auf Sonne · gemessen 11:11' });
    const ohneAuto = { ...neu, angesteckt: false };
    expect(rueckmeldung(ohneAuto, g, SENDEN + 30_000, uhr)[2].text).toBe('Kein Auto angesteckt');
  });
});
