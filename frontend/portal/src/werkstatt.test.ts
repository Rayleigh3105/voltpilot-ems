import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { qrCode } from './qrCode';
import { beschriftung, geraetName, PRUEFUNGEN, PRUEFUNGEN_PFC200, pruefungenFuer, VERSAND_SATZ } from './werkstatt';

describe('Prüfungen der Werkstatt-Regel', () => {
  it('sind dieselben wie im Vektor, den auch die API liest', () => {
    const v = JSON.parse(
      readFileSync(resolve(__dirname, '../../../docs/contracts/werkstatt-pruefungen.json'), 'utf8'),
    ) as { pruefungen: { id: string; text: string }[] };
    expect(PRUEFUNGEN.map((p) => p.id)).toEqual(v.pruefungen.map((p) => p.id));
    expect(PRUEFUNGEN.map((p) => p.text)).toEqual(v.pruefungen.map((p) => p.text));
  });

  it('hat für den PFC200 die Liste des Vektors, ohne SPS, Firmware und Einrichtungs-WLAN', () => {
    const v = JSON.parse(
      readFileSync(resolve(__dirname, '../../../docs/contracts/werkstatt-pruefungen.json'), 'utf8'),
    ) as { geraete: { pfc200: { pruefungen: { id: string; text: string }[] } } };
    expect(PRUEFUNGEN_PFC200.map((p) => p.id)).toEqual(v.geraete.pfc200.pruefungen.map((p) => p.id));
    expect(PRUEFUNGEN_PFC200.map((p) => p.text)).toEqual(v.geraete.pfc200.pruefungen.map((p) => p.text));
    expect(PRUEFUNGEN_PFC200.some((p) => /sps|koppel|firmware|wlan/.test(p.id))).toBe(false);
    expect(pruefungenFuer('pfc200')).toBe(PRUEFUNGEN_PFC200);
    expect(pruefungenFuer('mango')).toBe(PRUEFUNGEN);
    expect(pruefungenFuer(undefined)).toBe(PRUEFUNGEN);
  });
});

describe('Gerät einer Box des Registers', () => {
  it('heißt Mango, PFC200 oder Docker-Box; ein PFC200 ist nie eine Docker-Box', () => {
    expect(geraetName('edge-light')).toBe('Mango');
    expect(geraetName('edge-industrie')).toBe('PFC200');
    expect(geraetName('edge-app')).toBe('Docker-Box');
  });
});

describe('Beschriftung und Versand', () => {
  it('druckt die Referenz groß und trägt den Direktlink', () => {
    expect(beschriftung('edge-wrk7abg')).toEqual({
      klartext: 'EDGE-WRK7ABG',
      link: 'https://portal.voltpilot.de/k/edge-wrk7abg',
    });
  });

  // Dasselbe liest das Gehäuse-Programm (edge-light/gehaeuse/glinet-gl-mt300n-v2, gehaeuse/kennung.py): Was auf
  // die Unterseite gedruckt wird, ist Modul für Modul, was diese Seite zeigt.
  const vektor = JSON.parse(
    readFileSync(resolve(__dirname, '../../../docs/contracts/werkstatt-beschriftung.json'), 'utf8'),
  ) as {
    faelle: { referenz: string; klartext: string; link: string; fassung: number; korrektur: string; maske: number; module: string[] }[];
  };
  it.each(vektor.faelle.map((f) => [f.referenz, f] as const))(
    'trägt auf dem Gehäuse denselben Inhalt wie werkstatt-beschriftung.json: %s',
    (ref, f) => {
      const b = beschriftung(ref);
      expect(b).toEqual({ klartext: f.klartext, link: f.link });
      const q = qrCode(b.link);
      expect({ fassung: q.fassung, korrektur: q.korrektur, maske: q.maske }).toEqual({
        fassung: f.fassung,
        korrektur: f.korrektur,
        maske: f.maske,
      });
      expect(q.module.map((r) => r.map((m) => (m ? '1' : '0')).join(''))).toEqual(f.module);
    },
  );

  it('sagt am Ende, dass keine Box mit Stufe 1 an einen Kunden geht (Entscheid 5c)', () => {
    expect(VERSAND_SATZ).toMatch(/^Nicht versenden\./);
    expect(VERSAND_SATZ).toContain('Stufe 2');
  });
});
