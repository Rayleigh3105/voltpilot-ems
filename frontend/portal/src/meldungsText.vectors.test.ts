/**
 * Kunden-Alarmierung P1: das Portal rendert jede Meldung genau wie Mail und Push - dieselben Fälle prüft
 * `MeldungsTextVektorTest.java` (services/api) gegen `docs/contracts/v2/meldungs-text-vectors.json`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ausgeloest,
  dauer,
  entwarnung,
  mailText,
  zahl,
  zeit,
  type MeldungsNachricht,
  type MeldungsTextEingabe,
} from './meldungsText';

interface Fall {
  name: string;
  jetzt: string;
  jetzt_entwarnung?: string;
  kennzeichen: string;
  eingabe: MeldungsTextEingabe;
  erwartet: {
    ausgeloest: MeldungsNachricht;
    mail: string;
    entwarnung: MeldungsNachricht | null;
    entwarnung_mail: string | null;
  };
}

const V = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/meldungs-text-vectors.json'), 'utf8'),
) as {
  basis_url: string;
  faelle: Fall[];
  zeit: { t: string; jetzt: string; erwartet: string }[];
  dauer: { sekunden: number; erwartet: string }[];
  zahl: { wert: number; einheit: string | null; erwartet: string }[];
};

describe('meldungsText gegen die Vektoren', () => {
  it.each(V.faelle.map((f) => [f.name, f] as const))('%s', (_, f) => {
    const a = ausgeloest(f.eingabe, new Date(f.jetzt));
    expect(a).toEqual(f.erwartet.ausgeloest);
    expect(mailText(a, f.kennzeichen, V.basis_url)).toBe(f.erwartet.mail);
    if (f.jetzt_entwarnung) {
      const e = entwarnung(f.eingabe, new Date(f.jetzt_entwarnung));
      expect(e).toEqual(f.erwartet.entwarnung);
      expect(e && mailText(e, f.kennzeichen, V.basis_url)).toBe(f.erwartet.entwarnung_mail);
    }
  });

  it('ohne Ende keine Entwarnung', () => {
    const f = V.faelle.find((x) => x.eingabe.ende === null)!;
    expect(entwarnung(f.eingabe, new Date(f.jetzt))).toBeNull();
  });

  it('Zeit, Dauer und Zahl wie in den Vektoren', () => {
    for (const z of V.zeit) expect(zeit(new Date(z.t), new Date(z.jetzt)), z.t).toBe(z.erwartet);
    for (const d of V.dauer) expect(dauer(d.sekunden), String(d.sekunden)).toBe(d.erwartet);
    for (const z of V.zahl) expect(zahl(z.wert, z.einheit), String(z.wert)).toBe(z.erwartet);
  });
});
