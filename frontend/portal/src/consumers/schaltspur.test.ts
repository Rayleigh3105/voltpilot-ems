import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConsumerRuntimeStatus } from './status';
import {
  merkeSpur, pruefeSpuren, spurMeldeweg, spurUrteil, SPUR_WARTET_MS, vergissSpuren, type SpurWunsch,
} from './schaltspur';

interface Vektor {
  name: string;
  wunsch: SpurWunsch;
  status: {
    state: string;
    reason_code?: string;
    confirmed?: boolean;
    stage?: ConsumerRuntimeStatus['stufe'];
  };
  urteil: string;
}

const vektoren = (JSON.parse(readFileSync(
  resolve(process.cwd(), '../../docs/contracts/v2/schaltspur-abgleich-vectors.json'), 'utf8',
)) as { vectors: Vektor[] }).vectors;

function status(entityId: string, v: Vektor['status']): ConsumerRuntimeStatus {
  return {
    entityId,
    state: v.state,
    reasonCode: v.reason_code ?? null,
    confirmed: v.confirmed ?? null,
    stufe: v.stage ?? null,
    reportedAt: '2026-11-27T10:00:00Z',
  };
}

describe('spurUrteil - Zwilling von SchaltSpurAbgleich (gemeinsame Vektoren)', () => {
  it('kennt alle Vektoren', () => {
    expect(vektoren.length).toBeGreaterThan(10);
  });
  for (const v of vektoren) {
    it(v.name, () => {
      expect(spurUrteil(v.wunsch, status('x', v.status))).toBe(v.urteil);
    });
  }
  it('ohne Rückmeldung bleibt es offen', () => {
    expect(spurUrteil({ art: 'stop' }, null)).toBe('offen');
  });
});

describe('Portal-Zeiten einer Schaltspur', () => {
  let uhr = 0;
  const gemeldet: { siteId: string; entityId: string; spur: string; zeiten: object }[] = [];
  spurMeldeweg(async (siteId, entityId, spur, zeiten) => {
    gemeldet.push({ siteId, entityId, spur, zeiten });
  }, () => uhr);

  afterEach(() => {
    vergissSpuren();
    gemeldet.length = 0;
    uhr = 0;
  });

  const aus = status('stab', { state: 'waiting', confirmed: true, stage: { commanded: 0, confirmed: 0, outputs_on: [] } });
  const nochAn = status('stab', { state: 'running_manual', confirmed: true,
    stage: { commanded: 1, confirmed: 1, outputs_on: [0] } });

  it('meldet Klick bis Antwort und Klick bis bestätigt sichtbar - einmal', () => {
    uhr = 1000;
    const klick = uhr;
    uhr = 1180;
    merkeSpur('anlage', 'stab', 'spur-1', { art: 'stop' }, klick);
    uhr = 2000;
    expect(pruefeSpuren('anlage', [nochAn])).toEqual([]);
    uhr = 3400;
    expect(pruefeSpuren('anlage', [aus])).toEqual(['spur-1']);
    expect(gemeldet).toEqual([{ siteId: 'anlage', entityId: 'stab', spur: 'spur-1',
      zeiten: { antwortMs: 180, sichtbarMs: 2400 } }]);
    expect(pruefeSpuren('anlage', [aus])).toEqual([]);
  });

  it('ohne Spur der API misst das Portal nichts, und eine fremde Anlage zählt nicht', () => {
    merkeSpur('anlage', 'stab', undefined, { art: 'stop' }, 0);
    expect(pruefeSpuren('anlage', [aus])).toEqual([]);
    merkeSpur('anlage', 'stab', 'spur-2', { art: 'stop' }, 0);
    expect(pruefeSpuren('andere', [aus])).toEqual([]);
  });

  it('ein neuer Tipp ersetzt die offene Spur desselben Verbrauchers', () => {
    merkeSpur('anlage', 'stab', 'spur-alt', { art: 'start', ausgaenge: [1] }, 0);
    merkeSpur('anlage', 'stab', 'spur-neu', { art: 'stop' }, 10);
    expect(pruefeSpuren('anlage', [aus])).toEqual(['spur-neu']);
  });

  it('eine Spur, die nie bestätigt wird, verfällt', () => {
    merkeSpur('anlage', 'stab', 'spur-3', { art: 'stop' }, 0);
    uhr = SPUR_WARTET_MS + 1;
    expect(pruefeSpuren('anlage', [nochAn])).toEqual([]);
    expect(pruefeSpuren('anlage', [aus])).toEqual([]);
  });
});
