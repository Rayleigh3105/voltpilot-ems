import { describe, expect, it } from 'vitest';
import { urlBase64AlsBytes } from './push';

describe('urlBase64AlsBytes', () => {
  it('dekodiert einen ungepolsterten, URL-sicheren Base64-Text', () => {
    // "VoltPilot" als Bytes, URL-sicher ohne Füllzeichen kodiert.
    const text = btoa('VoltPilot').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const bytes = urlBase64AlsBytes(text);
    const zurueck = String.fromCharCode(...bytes);
    expect(zurueck).toBe('VoltPilot');
  });

  it('liefert die erwartete Länge für einen 65-Byte-Schlüssel', () => {
    const roh = new Uint8Array(65).fill(7);
    let bin = '';
    roh.forEach((b) => {
      bin += String.fromCharCode(b);
    });
    const text = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(urlBase64AlsBytes(text)).toHaveLength(65);
  });
});
