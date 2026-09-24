import { describe, expect, it } from 'vitest';
import {
  ioAusgangAus,
  ioAusgangOptionen,
  ioAusgangWert,
  ioOhneMeldungHinweis,
} from './ioAusgaenge';
import type { IoModuleOption } from './types';

const modul: IoModuleOption = {
  entityId: 'm-1',
  label: 'I/O-Modul Technikraum',
  outputs: 8,
  used: [{ channel: 3, consumerId: 'c-3', consumerName: 'Heizstab' }],
};

describe('ioAusgangOptionen', () => {
  it('bietet genau die FREIEN Ausgaenge an, in Ausgangs-Reihenfolge', () => {
    const opts = ioAusgangOptionen([modul]);
    expect(opts.map((o) => o.label)).toEqual([
      'I/O-Modul Technikraum · Ausgang DO1',
      'I/O-Modul Technikraum · Ausgang DO2',
      'I/O-Modul Technikraum · Ausgang DO4',
      'I/O-Modul Technikraum · Ausgang DO5',
      'I/O-Modul Technikraum · Ausgang DO6',
      'I/O-Modul Technikraum · Ausgang DO7',
      'I/O-Modul Technikraum · Ausgang DO8',
    ]);
    expect(opts[0].value).toBe('io:m-1:1');
  });

  it('raet nie eine Ausgangszahl, solange das Modul nichts gemeldet hat', () => {
    const stumm = { ...modul, outputs: null, used: [] };
    expect(ioAusgangOptionen([stumm])).toEqual([]);
    expect(ioOhneMeldungHinweis([stumm])).toContain('noch keine Ausgänge gemeldet');
    expect(ioOhneMeldungHinweis([modul])).toBeNull();
  });

  it('zaehlt Erweiterungsmodule mit (die Box meldet den ganzen Stapel)', () => {
    expect(ioAusgangOptionen([{ ...modul, outputs: 24, used: [] }])).toHaveLength(24);
  });

  it('versteht ein aelteres Backend ohne Module', () => {
    expect(ioAusgangOptionen(undefined)).toEqual([]);
    expect(ioOhneMeldungHinweis(undefined)).toBeNull();
  });
});

describe('ioAusgangWert / ioAusgangAus', () => {
  it('liest den Wert verlustfrei zurueck', () => {
    expect(ioAusgangAus(ioAusgangWert('m-1', 12))).toEqual({ ioEntityId: 'm-1', ioChannel: 12 });
  });

  it('haelt eine Quellen-Kennung nicht fuer einen Ausgang', () => {
    expect(ioAusgangAus('edge-src-7')).toBeNull();
    expect(ioAusgangAus('')).toBeNull();
    expect(ioAusgangAus('io:m-1:0')).toBeNull();
  });
});
