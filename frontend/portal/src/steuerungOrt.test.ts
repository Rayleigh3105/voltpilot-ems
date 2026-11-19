import { describe, expect, it } from 'vitest';
import { IN_DIESEM_GERAET_HOST, adresseText, istInDiesemGeraet } from './steuerungOrt';

/**
 * PFC200-Konzept Stufe 2: eine Steuerung „in diesem Gerät“ ist die Schleifenadresse - ein WAGO PFC200, auf dem
 * VoltPilot läuft, liest sein eigenes SPS-Programm über 127.0.0.1. Anlege-Schritt und Geräteseite nennen sie gleich.
 */
describe('Ort der Steuerung', () => {
  it('erkennt die Schleife und nur sie', () => {
    for (const host of [IN_DIESEM_GERAET_HOST, '127.5.6.7', ' localhost ', '[::1]', '::1']) {
      expect(istInDiesemGeraet(host), host).toBe(true);
    }
    for (const host of ['192.168.4.165', '10.213.0.1', '1270.0.0.1', '127.0.0', '', null, undefined, 'pfc200.local']) {
      expect(istInDiesemGeraet(host), String(host)).toBe(false);
    }
  });

  it('nennt die gespeicherte Adresse für Menschen, ohne eine fremde umzuschreiben', () => {
    expect(adresseText('127.0.0.1:502')).toBe('in diesem Gerät');
    expect(adresseText('127.0.0.1')).toBe('in diesem Gerät');
    expect(adresseText('127.0.0.1:1502')).toBe('in diesem Gerät (Port 1502)');
    expect(adresseText('[::1]:502')).toBe('in diesem Gerät');
    expect(adresseText('192.168.4.165:502')).toBe('192.168.4.165:502');
    expect(adresseText(null)).toBe('');
  });
});
