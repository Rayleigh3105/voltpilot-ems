import { describe, expect, it } from 'vitest';
import {
  SOC_CODE_GEMESSEN,
  SOC_CODE_KENNLINIE,
  SOC_CODE_LADUNGSZAEHLUNG,
  SOC_HERKUNFT_KANAL,
  herkunftAusKanaelen,
  herkunftUeberEntitaeten,
  socHerkunft,
} from './socHerkunft';

describe('socHerkunft', () => {
  it('nennt die drei Herkünfte des Vertrags beim Namen', () => {
    expect(socHerkunft(SOC_CODE_GEMESSEN)?.kurz).toBe('gemessen');
    expect(socHerkunft(SOC_CODE_GEMESSEN)?.berechnet).toBe(false);
    expect(socHerkunft(SOC_CODE_KENNLINIE)?.kurz).toBe('berechnet: Kennlinie');
    expect(socHerkunft(SOC_CODE_KENNLINIE)?.berechnet).toBe(true);
    expect(socHerkunft(SOC_CODE_LADUNGSZAEHLUNG)?.kurz).toBe('berechnet: Ladungszählung');
    expect(socHerkunft(SOC_CODE_LADUNGSZAEHLUNG)?.berechnet).toBe(true);
  });

  /**
   * Der Kern der Ehrlichkeitsregel: was der Vertrag nicht kennt, wird
   * VERWORFEN. Es gibt bewusst keine 0 für „unbekannt" - ein unbekannter
   * Ladestand ist ein abwesender Kanal.
   */
  it('verwirft jeden Code außerhalb des Vokabulars, statt ihn zu raten', () => {
    expect(socHerkunft(0)).toBeNull();
    expect(socHerkunft(4)).toBeNull();
    expect(socHerkunft(-1)).toBeNull();
    expect(socHerkunft(null)).toBeNull();
    expect(socHerkunft(undefined)).toBeNull();
    expect(socHerkunft(Number.NaN)).toBeNull();
  });

  it('liest den Code aus den Fähigkeiten einer Entität', () => {
    expect(
      herkunftAusKanaelen([
        { channel: 'soc_pct', value: 41 },
        { channel: SOC_HERKUNFT_KANAL, value: 2 },
      ])?.kurz,
    ).toBe('berechnet: Kennlinie');
  });

  /**
   * Ein fehlender Kanal und ein Kanal ohne Wert sind DASSELBE Ergebnis:
   * „wir wissen es nicht". Eine Kachel, die hier „gemessen" schriebe, hätte
   * sich das ausgedacht - und fast jede Katalog-Batterie meldet den Kanal nie.
   */
  it('sagt „unbekannt", wenn der Kanal fehlt oder keinen Wert hat', () => {
    expect(herkunftAusKanaelen([{ channel: 'soc_pct', value: 41 }])).toBeNull();
    expect(herkunftAusKanaelen([{ channel: SOC_HERKUNFT_KANAL, value: null }])).toBeNull();
    expect(herkunftAusKanaelen([])).toBeNull();
    expect(herkunftAusKanaelen(null)).toBeNull();
  });

  /**
   * Uneinigkeit rundet NICHT nach oben: ein Speicherstand, der teilweise
   * geschätzt ist, ist als Ganzes geschätzt.
   */
  it('lässt bei mehreren Batterien die BERECHNETE Herkunft gewinnen', () => {
    const gemessen = [{ channel: SOC_HERKUNFT_KANAL, value: 1 }];
    const gerechnet = [{ channel: SOC_HERKUNFT_KANAL, value: 3 }];
    expect(herkunftUeberEntitaeten([gemessen, gerechnet])?.berechnet).toBe(true);
    expect(herkunftUeberEntitaeten([gerechnet, gemessen])?.kurz).toBe(
      'berechnet: Ladungszählung',
    );
    expect(herkunftUeberEntitaeten([gemessen, gemessen])?.kurz).toBe('gemessen');
    expect(herkunftUeberEntitaeten([null, undefined, []])).toBeNull();
  });
});
