import { describe, expect, it } from 'vitest';
import {
  baueKurzbild,
  ruhezeitPresetVon,
  ruhezeitRegelnFuerPreset,
  schwereAusStufe,
  stufeAusSchwere,
  type KurzbildWeg,
} from './einstellungenAbleitung';

describe('stufeAusSchwere / schwereAusStufe', () => {
  it('bildet die zwei Stufen ab - eine alte "hinweis"-Schwere zählt wie "alle"', () => {
    expect(stufeAusSchwere('hinweis')).toBe('alle');
    expect(stufeAusSchwere('warnung')).toBe('alle');
    expect(stufeAusSchwere('dringend')).toBe('nur_dringend');
  });

  it('ist die Umkehrung für die beiden echten Stufen', () => {
    expect(schwereAusStufe('alle')).toBe('warnung');
    expect(schwereAusStufe('nur_dringend')).toBe('dringend');
  });
});

describe('baueKurzbild', () => {
  const wege: KurzbildWeg[] = [
    { label: 'E-Mail', schwere: 'warnung', aktiv: true },
    { label: 'Push', schwere: 'dringend', aktiv: true },
    { label: 'Team-Kanal', schwere: 'warnung', aktiv: false },
  ];

  it('die Hinweis-Zeile hat nie einen Weg - Hinweise verlassen das Portal nicht', () => {
    const k = baueKurzbild(wege, null, true);
    expect(k.zeilen[0]).toEqual({ schwere: 'hinweis', wege: [], wartet: false });
  });

  it('Warnung zeigt nur die ab Warnung aktiven Wege, Dringend zusätzlich die ab Dringend', () => {
    const k = baueKurzbild(wege, null, true);
    expect(k.zeilen[1]).toEqual({ schwere: 'warnung', wege: ['E-Mail'], wartet: false });
    expect(k.zeilen[2]).toEqual({ schwere: 'dringend', wege: ['E-Mail', 'Push'], wartet: false });
  });

  it('ein ausgeschalteter Weg erscheint nirgends', () => {
    const k = baueKurzbild(wege, null, true);
    expect(k.zeilen.flatMap((z) => z.wege)).not.toContain('Team-Kanal');
  });

  it('in der Ruhezeit wartet Warnung immer, Dringend nur ohne "Dringendes trotzdem melden"', () => {
    const bis = new Date('2026-10-20T07:00:00Z');
    const mitDurch = baueKurzbild(wege, bis, true);
    expect(mitDurch.zeilen[1]).toMatchObject({ wartet: true, wege: [] });
    expect(mitDurch.zeilen[2]).toMatchObject({ wartet: false, wege: ['E-Mail', 'Push'] });

    const ohneDurch = baueKurzbild(wege, bis, false);
    expect(ohneDurch.zeilen[2]).toMatchObject({ wartet: true, wege: [] });
  });
});

describe('ruhezeitPresetVon / ruhezeitRegelnFuerPreset', () => {
  it('erkennt "Keine" an leeren Regeln', () => {
    expect(ruhezeitPresetVon({})).toBe('keine');
  });

  it('erkennt "Nachts 22 bis 7 Uhr" ohne Wochenend-Fenster', () => {
    expect(ruhezeitPresetVon({ werktags: { von: '22:00', bis: '07:00' } })).toBe('nachts');
  });

  it('erkennt "Nachts und am Wochenende" mit Wochenende ganz', () => {
    expect(ruhezeitPresetVon({ werktags: { von: '22:00', bis: '07:00' }, wochenende: 'ganz' })).toBe(
      'nachts_wochenende',
    );
  });

  it('erkennt "Außerhalb der Arbeitszeit" (18 bis 7 Uhr, Wochenende ganz)', () => {
    expect(ruhezeitPresetVon({ werktags: { von: '18:00', bis: '07:00' }, wochenende: 'ganz' })).toBe(
      'ausserhalb_arbeitszeit',
    );
  });

  it('eine unbekannte Kombination bleibt ehrlich "Eigene Zeiten"', () => {
    expect(ruhezeitPresetVon({ werktags: { von: '20:00', bis: '06:00' } })).toBe('eigene');
    expect(ruhezeitPresetVon({ wochenende: { von: '10:00', bis: '18:00' } })).toBe('eigene');
  });

  it('"Eigene Zeiten" behält vorherige Fenster statt sie zu leeren', () => {
    const vorher = { werktags: { von: '20:00', bis: '06:00' } };
    expect(ruhezeitRegelnFuerPreset('eigene', vorher)).toEqual({ werktags: vorher.werktags, wochenende: 'ganz' });
  });

  it('"Eigene Zeiten" ohne vorherige Ruhezeit schlägt eine sinnvolle Grundlage vor', () => {
    expect(ruhezeitRegelnFuerPreset('eigene', {})).toEqual({
      werktags: { von: '22:00', bis: '07:00' },
      wochenende: 'ganz',
    });
  });

  it('jede Vorgabe erzeugt wieder genau sich selbst', () => {
    for (const preset of ['keine', 'nachts', 'nachts_wochenende', 'ausserhalb_arbeitszeit'] as const) {
      expect(ruhezeitPresetVon(ruhezeitRegelnFuerPreset(preset, {}))).toBe(preset);
    }
  });
});
