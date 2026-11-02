import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  abweichungHinweis,
  anschlussFehler,
  ausgangsFehler,
  heizstabVerbindung,
  hoechstensKwh,
  nachStromausfallWarnung,
  phasen,
  stufen,
  testZeilen,
  zustandsSatz,
} from './heizstab';

// Dieselben Vektoren wie die Box (Go) und die API (Java): gleiche Regeln, gleiche Sätze.
const vektoren = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/heizstab-stufen-vectors.json'), 'utf8'),
) as { validate: { name: string; config: Record<string, unknown>; error: string }[] };

describe('Ausgangsmenge (Zwilling von Box und API)', () => {
  it.each(vektoren.validate)('$name', (v) => {
    expect(ausgangsFehler(v.config)).toBe(v.error === '' ? null : v.error);
  });

  it('mehrere Ausgänge nur bei Stern mit N', () => {
    expect(anschlussFehler('stern_mit_n', 3)).toBeNull();
    expect(anschlussFehler('unbekannt', 3)).toBeNull();
    expect(anschlussFehler('dreieck', 3)).toMatch(/dreipoliges Schütz/);
    expect(anschlussFehler('ohne_n', 1)).toBeNull();
    expect(anschlussFehler(null, 3)).toMatch(/angeschlossen/);
  });

  it('die Stufen tragen die kW der größten Elemente', () => {
    expect(stufen({ channels: [0, 1, 2], output_kw: [2, 2, 2], stages: [1, 2, 3] })).toEqual([
      { ausgaenge: 1, kw: 2 }, { ausgaenge: 2, kw: 4 }, { ausgaenge: 3, kw: 6 },
    ]);
    expect(stufen({ channels: [0, 1, 2], output_kw: [2, 2, 3], stages: [1, 3] })).toEqual([
      { ausgaenge: 1, kw: 3 }, { ausgaenge: 3, kw: 7 },
    ]);
  });
});

describe('Verbindung des Heizstabs', () => {
  it('ersetzt den einen Kanal durch die Menge und nimmt alle Phasen immer mit', () => {
    const c = heizstabVerbindung({ communication: 'shelly_http', ip: '192.168.178.43', port: 80, channel: 0 }, {
      kanaele: 3, kwJeElement: 2, stufen: [1], rotation: 'daily', anschluss: 'stern_mit_n',
    });
    expect(c).toEqual({
      ip: '192.168.178.43', port: 80, channels: [0, 1, 2], output_kw: [2, 2, 2], stages: [1, 3],
      rotation: 'daily', anschluss: 'stern_mit_n',
    });
    expect(ausgangsFehler(c)).toBeNull();
  });
});

describe('Verbindungstest', () => {
  it('nennt je Ausgang Zustand und „nach Stromausfall“ und warnt, wenn einer nicht aus bleibt', () => {
    const a = [
      { kanal: 0, ein: false, nach_stromausfall: 'off' as const },
      { kanal: 1, ein: true, nach_stromausfall: 'restore_last' as const },
      { kanal: 2, ein: null, nach_stromausfall: null },
    ];
    expect(testZeilen(a)).toEqual([
      { label: 'Ausgang 1 (L1)', wert: 'aus · nach Stromausfall: aus', warn: false },
      { label: 'Ausgang 2 (L2)', wert: 'ein · nach Stromausfall: wie vorher', warn: true },
      { label: 'Ausgang 3 (L3)', wert: 'nicht gelesen · nach Stromausfall: nicht gelesen', warn: false },
    ]);
    expect(nachStromausfallWarnung(a)).toMatch(/Stellen Sie die Ausgänge auf „aus“/);
    expect(nachStromausfallWarnung([{ kanal: 0, nach_stromausfall: 'off' }])).toBeNull();
  });
});

describe('Geräteseite', () => {
  it('zeigt, was BESTÄTIGT läuft - unbekannt ist nie aus', () => {
    expect(zustandsSatz({ commanded: 3, confirmed: 1, confirmed_kw: 2 })).toBe('Heizt mit 1 Phase · 2,0 kW');
    expect(zustandsSatz({ commanded: 0, confirmed: 0, confirmed_kw: 0 })).toBe('Aus');
    expect(zustandsSatz({ commanded: 1, confirmed: null })).toBe('Stufe nicht bestätigt');
    expect(zustandsSatz(null)).toBe('Noch keine Rückmeldung der Box');
    expect(phasen(3, { commanded: 2, confirmed: 2, outputs_on: [0, 2] })).toEqual([
      { label: 'L1', an: true }, { label: 'L2', an: false }, { label: 'L3', an: true },
    ]);
    expect(phasen(3, { commanded: 2, confirmed: null })).toEqual([
      { label: 'L1', an: null }, { label: 'L2', an: null }, { label: 'L3', an: null },
    ]);
  });

  it('eine Abweichung wird erst nach 3 Minuten ein Hinweis (HZ-4 B, keine Sperre)', () => {
    const s = { commanded: 1, confirmed: 2, mismatch_since: '2026-11-02T10:00:00Z' };
    expect(abweichungHinweis(s, new Date('2026-11-02T10:02:59Z'))).toBeNull();
    expect(abweichungHinweis(s, new Date('2026-11-02T10:03:00Z'))).toMatch(/^Seit 11:00 meldet ein Ausgang/);
    expect(abweichungHinweis({ commanded: 1, confirmed: 1 }, new Date())).toBeNull();
  });

  it('Jetzt heizen nennt eine Obergrenze, keine Zusage', () => {
    expect(hoechstensKwh(4, 60)).toBe('Höchstens ≈ 4,0 kWh');
    expect(hoechstensKwh(2, 30)).toBe('Höchstens ≈ 1,0 kWh');
  });
});
