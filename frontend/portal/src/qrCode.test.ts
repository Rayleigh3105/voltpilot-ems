import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { qrCode, qrPfad, type Fehlerkorrektur } from './qrCode';

/**
 * Die Matrizen gegen `qrcode` (Python): `scripts/qr-vektoren.py` schreibt `qrCode.vektoren.json`. Je Fall
 * dieselbe Fassung, Stufe und Maske - dann muss jedes Modul gleich sein. Die Wahl der Maske nach
 * Strafpunkten ist zwischen Kodierern nicht immer gleich; jede Maske ergibt einen gültigen Code.
 */
interface Fall {
  text: string;
  korrektur: Fehlerkorrektur;
  fassung: number;
  maske: number;
  module: string[];
}

const vektoren = JSON.parse(readFileSync(resolve(__dirname, 'qrCode.vektoren.json'), 'utf8')) as { faelle: Fall[] };

function alsText(module: boolean[][]): string[] {
  return module.map((r) => r.map((b) => (b ? '1' : '0')).join(''));
}

describe('qrCode', () => {
  it('hat Vektoren über die Fassungen 1 bis 9 (ab 7 mit Fassungsinformation), beide Stufen und alle acht Masken', () => {
    expect(new Set(vektoren.faelle.map((f) => f.fassung))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(new Set(vektoren.faelle.map((f) => f.korrektur))).toEqual(new Set(['L', 'M']));
    expect(new Set(vektoren.faelle.map((f) => f.maske)).size).toBe(8);
  });

  it.each(vektoren.faelle.map((f) => [`${f.text.slice(0, 40)} · ${f.korrektur} · Maske ${f.maske}`, f] as const))(
    'ist Modul für Modul der Code von qrcode: %s',
    (_name, f) => {
      const q = qrCode(f.text, { korrektur: f.korrektur, maske: f.maske });
      expect(q.fassung).toBe(f.fassung);
      expect(q.groesse).toBe(17 + 4 * f.fassung);
      expect(alsText(q.module)).toEqual(f.module);
    },
  );

  it('wählt die kleinste Fassung und eine Maske; der Link einer Box passt in Fassung 3', () => {
    const q = qrCode('https://portal.voltpilot.de/k/edge-wrk7abg');
    expect(q.fassung).toBe(3);
    expect(q.korrektur).toBe('M');
    expect(q.maske).toBeGreaterThanOrEqual(0);
    expect(q.maske).toBeLessThan(8);
    expect(qrCode('A').fassung).toBe(1);
    expect(() => qrCode('x'.repeat(400))).toThrow(/zu lang/);
  });

  it('schreibt jede dunkle Zeilenstrecke als ein Rechteck mit Ruhezone', () => {
    const q = qrCode('A', { maske: 0 });
    const pfad = qrPfad(q, 4);
    // Die erste Zeile beginnt mit dem Suchmuster: sieben dunkle Module ab (4|4).
    expect(pfad.startsWith('M4 4h7v1h-7z')).toBe(true);
    const flaeche = [...pfad.matchAll(/h(\d+)v1/g)].reduce((a, m) => a + Number(m[1]), 0);
    expect(flaeche).toBe(q.module.flat().filter(Boolean).length);
  });
});
