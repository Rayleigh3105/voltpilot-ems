import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  abweichungHinweis,
  anschlussFehler,
  anschlussOffen,
  testKurz,
  ausgangsFehler,
  heizstabVerbindung,
  nachStromausfallWarnung,
  erlaubteStufen,
  handWunsch,
  leistungJePhase,
  nurZusammen,
  phaseTippen,
  phasenAnsicht,
  phasenFaehig,
  phasenZeilen,
  smartZustand,
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
  });

  it('eine Abweichung wird erst nach 3 Minuten ein Hinweis (HZ-4 B, keine Sperre)', () => {
    const s = { commanded: 1, confirmed: 2, mismatch_since: '2026-11-02T10:00:00Z' };
    expect(abweichungHinweis(s, new Date('2026-11-02T10:02:59Z'))).toBeNull();
    expect(abweichungHinweis({ ...s, confirmed: null }, new Date('2026-11-02T10:03:00Z'))).toMatch(/^Seit 11:00 meldet ein Ausgang/);
    expect(abweichungHinweis({ commanded: 1, confirmed: 1 }, new Date())).toBeNull();
  });

  it('eine Abweichung nach OBEN verspricht nie „nie mehr als befohlen“ - sie nennt den klemmenden Ausgang', () => {
    const jetzt = new Date('2026-11-02T10:05:00Z');
    const mehr = abweichungHinweis({ commanded: 1, confirmed: 2, mismatch_since: '2026-11-02T10:00:00Z' }, jetzt)!;
    expect(mehr).toMatch(/^Seit 11:00 heizt der Stab mit mehr als befohlen \(2 Phasen statt 1 Phase\)/);
    expect(mehr).toMatch(/lässt sich nicht ausschalten/);
    expect(mehr).not.toMatch(/nie mit mehr/);
    const weniger = abweichungHinweis({ commanded: 3, confirmed: 2, mismatch_since: '2026-11-02T10:00:00Z' }, jetzt)!;
    expect(weniger).toMatch(/^Seit 11:00 schaltet ein Ausgang nicht ein\. Der Stab heizt mit 2 Phasen statt 3 Phasen weiter/);
  });

  it('der Anschluss ist offen, solange er nicht „Stern mit N“ ist (Zwilling von HeizstabGeraet.anschlussOffen)', () => {
    expect(anschlussOffen({ channels: [0, 1, 2], anschluss: 'stern_mit_n' })).toBe(false);
    expect(anschlussOffen({ channels: [0, 1, 2], anschluss: 'unbekannt' })).toBe(true);
    expect(anschlussOffen({ channels: [0] })).toBe(true);
    expect(anschlussOffen({ channel: 0 })).toBe(false);
    expect(anschlussOffen(null)).toBe(false);
  });

  it('der Test sagt in einer Zeile, ob alle Ausgänge antworten', () => {
    expect(testKurz([{ kanal: 0, ein: false }, { kanal: 1, ein: true }, { kanal: 2, ein: false }], 3))
      .toBe('Die Box erreicht den Shelly und liest alle 3 Ausgänge.');
    expect(testKurz([{ kanal: 0, ein: false }, { kanal: 1, ein: null }], 3)).toBe('Die Box hat 1 von 3 Ausgängen gelesen.');
    expect(testKurz(null, 3)).toBe('Die Box hat den Shelly erreicht, die Ausgänge aber nicht gelesen.');
  });

});

describe('Steuerung wie in Home Assistant (D1-A, D2-A, D3-A)', () => {
  const pro3 = { channels: [0, 1, 2], output_kw: [2, 2, 2], stages: [1, 2, 3], anschluss: 'stern_mit_n' };
  const jetzt = new Date('2026-11-05T12:00:00Z');
  const bis = '2026-11-05T13:47:00Z';

  it('je Phase das BESTÄTIGTE - nach Kanal, nicht nach Position; ohne Rückmeldung unbekannt', () => {
    const z = phasenZeilen(pro3, { commanded: 2, confirmed: 2, outputs_on: [0, 2] }, null);
    expect(z.map((x) => [x.label, x.kanal, x.an, x.wunsch])).toEqual([['L1', 0, true, null], ['L2', 1, false, null], ['L3', 2, true, null]]);
    // Eine Menge aus den Ausgängen 1 und 2: L1 ist Kanal 1.
    const zwei = phasenZeilen({ channels: [1, 2], output_kw: [2, 2] }, { commanded: 1, confirmed: 1, outputs_on: [1] }, null);
    expect(zwei.map((x) => [x.label, x.kanal, x.an])).toEqual([['L1', 1, true], ['L2', 2, false]]);
    const meldung = { commanded: 2, confirmed: null, at: '2026-11-05T10:02:00Z' };
    const still = phasenZeilen(pro3, meldung, null);
    expect(still.every((x) => x.an === null)).toBe(true);
    expect(phasenAnsicht(still[0], meldung)).toEqual({ wort: '?', unter: 'keine Rückmeldung seit 11:02', stellung: 'unbekannt' });
    expect(phasenAnsicht(still[1], meldung).unter).toBeNull();
  });

  it('ein angefragter Wechsel wartet sichtbar, bis der Shelly ihn bestätigt', () => {
    const z = phasenZeilen(pro3, { commanded: 2, confirmed: 1, outputs_on: [0] }, [0, 2]);
    expect(z.map((x) => phasenAnsicht(x, null).stellung)).toEqual(['an', 'aus', 'warte-an']);
    expect(phasenAnsicht(z[2], null).wort).toBe('schaltet ein …');
    const aus = phasenZeilen(pro3, { commanded: 2, confirmed: 2, outputs_on: [0, 1] }, []);
    expect(aus.map((x) => phasenAnsicht(x, null).stellung)).toEqual(['warte-aus', 'warte-aus', 'aus']);
  });

  it('ein Tipp wechselt eine Phase, ausgehend vom Wunsch oder vom Bestätigten', () => {
    const bestaetigt = phasenZeilen(pro3, { commanded: 1, confirmed: 1, outputs_on: [0] }, null);
    expect(phaseTippen(pro3, bestaetigt, 2)).toEqual({ art: 'start', ausgaenge: [0, 2] });
    expect(phaseTippen(pro3, bestaetigt, 0)).toEqual({ art: 'stop' });
    // Läuft ein Handeingriff, zählt der Wunsch, nicht das (noch) Bestätigte.
    const wunsch = phasenZeilen(pro3, { commanded: 2, confirmed: 1, outputs_on: [0] }, [0, 2]);
    expect(phaseTippen(pro3, wunsch, 1)).toEqual({ art: 'start', ausgaenge: [0, 1, 2] });
    // Ohne Rückmeldung beginnt ein Tipp bei nichts.
    expect(phaseTippen(pro3, phasenZeilen(pro3, null, null), 1)).toEqual({ art: 'start', ausgaenge: [1] });
  });

  it('eine Zahl, die keine erlaubte Stufe ist, schickt nichts und sagt warum', () => {
    const einsDrei = { ...pro3, stages: [1, 3] };
    const z = phasenZeilen(einsDrei, { commanded: 1, confirmed: 1, outputs_on: [0] }, null);
    expect(phaseTippen(einsDrei, z, 1)).toEqual({
      art: 'fehler', satz: '2 Phasen zugleich sind bei diesem Heizstab nicht erlaubt (erlaubt: 1, 3).',
    });
    expect(erlaubteStufen({ channels: [0, 1, 2] })).toEqual([3]);
  });

  it('„nur alle zusammen“ ist ein Schalter für den ganzen Stab', () => {
    expect(nurZusammen({ ...pro3, stages: [3] })).toBe(true);
    expect(nurZusammen({ channels: [0, 1, 2], output_kw: [2, 2, 2] })).toBe(true);
    expect(nurZusammen({ channels: [0], output_kw: [2] })).toBe(true);
    expect(nurZusammen(pro3)).toBe(false);
  });

  it('der Wunsch kommt aus einem laufenden Handeingriff: Phasen, „Aus“ = keine, abgelaufen = keiner', () => {
    expect(handWunsch({ kind: 'start', endsAt: bis, targetOutputs: [2, 0] }, jetzt)).toEqual([0, 2]);
    expect(handWunsch({ kind: 'stop', endsAt: bis }, jetzt)).toEqual([]);
    expect(handWunsch({ kind: 'start', endsAt: bis }, jetzt)).toBeNull();
    expect(handWunsch({ kind: 'start', endsAt: '2026-11-05T11:59:00Z', targetOutputs: [0] }, jetzt)).toBeNull();
    expect(handWunsch(null, jetzt)).toBeNull();
  });

  it('Smart: an, ruht (pausiert oder von Hand) oder nicht eingerichtet (D3-A)', () => {
    expect(smartZustand('active', null)).toMatchObject({ titel: 'Smart', an: true, schalter: true, ruht: null });
    expect(smartZustand('paused', null)).toMatchObject({ titel: 'Smart ruht', an: false, schalter: true });
    expect(smartZustand('active', { kind: 'start' })).toMatchObject({ titel: 'Smart ruht', ruht: 'Von Hand geschaltet' });
    expect(smartZustand('not_activated', null)).toMatchObject({ schalter: false });
  });

  it('die Fähigkeit heizstab_phasen entscheidet zwischen Phasen und Stufen; unbekannt bleibt Stufe', () => {
    const v = (capabilities: string[] | null, siteId = 's1') => ({ siteId, capabilities });
    expect(phasenFaehig([v(['heizstab_regler', 'heizstab_phasen'])], 's1')).toBe(true);
    expect(phasenFaehig([v(['heizstab_regler'])], 's1')).toBe(false);
    expect(phasenFaehig([v(['heizstab_phasen'], 's2')], 's1')).toBeNull();
    expect(phasenFaehig(null, 's1')).toBeNull();
  });

  it('die Leistung je Phase in einer Zeile', () => {
    expect(leistungJePhase(phasenZeilen(pro3, null, null))).toBe('2,0\u00a0kW je Phase');
    expect(leistungJePhase(phasenZeilen({ channels: [0, 1], output_kw: [1, 2] }, null, null))).toBe('3,0\u00a0kW zusammen');
  });
});
